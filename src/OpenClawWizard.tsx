import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, CircleAlert, ExternalLink, LoaderCircle, Lock, Search, WifiOff } from "lucide-react";
import { post, request, type Peer } from "./api";
import { clawBase } from "./OpenClawControls";
import { ClawDialog } from "./OpenClawDialog";
import { BrandCourier } from "./ReachIdentity";
import { computerWord } from "./pause";
import "./openclaw.css";
import "./openclaw-wizard.css";

// OpenClaw's guided setup, on a page of its own and one question at a time,
// as the ChatGPT app asks things: the question large, its choices as rows,
// one white pill at the bottom. OpenClaw words each question; Reach lays it
// out (server/openclaw-wizard.mjs scrubs it and keeps option values).

type Step = {
  id: string;
  type: string;
  title: string;
  message: string;
  sensitive: boolean;
  placeholder: string;
  options: { index: number; label: string; hint: string }[];
  // What OpenClaw would start on, by index.
  selected?: number[];
};
type Progress = { title: string; message: string; code: string; link: string };
type State = {
  supported: boolean;
  busy: boolean;
  status: string;
  problem: string;
  // What OpenClaw is doing while no question waits.
  progress?: Progress | null;
  step: Step | null;
};
const ENDED = ["idle", "done", "cancelled", "error"];
// A list this long gets a search field.
const SEARCH_FROM = 9;

export function ClawWizard({
  peer,
  onClose,
}: {
  peer: Peer;
  onClose: () => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState("");
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await request<State>(peer, `${clawBase}/wizard`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setState(next);
        if (next.busy) timer = setTimeout(load, 1000);
      } catch (e) {
        if (!abort.signal.aborted) {
          setProblem((e as Error).message);
          timer = setTimeout(load, 3000);
        }
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [peer.id, peer.url, peer.token, revision]);
  const send = async (action: string, body = {}) => {
    if (sending) return;
    setSending(true);
    setProblem("");
    try {
      setState(await post<State>(peer, `${clawBase}/wizard/${action}`, body));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSending(false);
      setRevision((n) => n + 1);
    }
  };
  const running = !!state?.supported && !ENDED.includes(state.status);
  const trouble = problem || state?.problem || "";
  let page: ReactNode;
  if (!state)
    page = (
      <Screen>
        <p className="claw-setup-wait" role="status">
          <LoaderCircle size={18} className="spin" /> Loading…
        </p>
        {problem && <Problem text={problem} />}
      </Screen>
    );
  else if (!state.supported)
    page = (
      <Screen foot={problem && <Problem text={problem} />}>
        <Hero icon={<CircleAlert size={28} />} tone="alert" title="Guided setup isn't here yet">
          This OpenClaw version doesn't offer guided setup in Reach. Update OpenClaw to use it.
        </Hero>
      </Screen>
    );
  else if (!running)
    page = (
      <Screen
        foot={
          <>
            {trouble && state.status !== "error" && <Problem text={trouble} />}
            {state.status === "done" ? (
              <button type="button" className="claw-setup-cta" onClick={onClose}>
                Done
              </button>
            ) : (
              <button
                type="button"
                className="claw-setup-cta"
                aria-label={state.status === "idle" ? "Start setup" : "Start setup again"}
                disabled={sending}
                onClick={() => void send("start")}
              >
                {sending && <LoaderCircle size={17} className="spin" />}
                {state.status === "idle" ? "Start" : "Start again"}
              </button>
            )}
          </>
        }
      >
        {state.status === "done" ? (
          <Hero icon={<Check size={30} strokeWidth={2.4} />} tone="done" title="OpenClaw is set up">
            Your answers are saved in OpenClaw.
          </Hero>
        ) : state.status === "cancelled" ? (
          <Hero title="Setup stopped">Anything OpenClaw already saved stays.</Hero>
        ) : state.status === "error" ? (
          <Hero icon={<CircleAlert size={28} />} tone="alert" title="Setup didn't finish">
            {state.problem || "OpenClaw stopped this setup. Earlier changes may already be saved."}
          </Hero>
        ) : (
          <Hero title="Set up OpenClaw">
            Models, messaging apps and skills. OpenClaw asks, you answer here.
          </Hero>
        )}
      </Screen>
    );
  else if (state.busy) page = <Working progress={state.progress || null} problem={problem} />;
  else if (state.step)
    page = (
      <Question
        key={state.step.id}
        step={state.step}
        busy={sending}
        problem={trouble}
        computer={computerWord(peer.platform)}
        answer={(value) => send("answer", { stepId: state.step!.id, value })}
      />
    );
  else
    page = (
      // Interrupted, or a step Reach can't show: what happened, and one way on.
      <Screen
        foot={
          <button type="button" className="claw-setup-cta" disabled={sending} onClick={() => void send("refresh")}>
            {sending && <LoaderCircle size={17} className="spin" />}
            Check again
          </button>
        }
      >
        {state.status === "uncertain" ? (
          <Hero icon={<WifiOff size={28} />} tone="alert" title="Connection lost">
            {trouble || "Your last choice may already be saved."}
          </Hero>
        ) : (
          <Hero icon={<CircleAlert size={28} />} tone="alert" title="Reach can't show this step">
            {trouble || "Stop the setup here and finish it on your computer."}
          </Hero>
        )}
      </Screen>
    );
  return (
    <ClawDialog
      title="OpenClaw setup"
      className="claw-setup"
      onClose={onClose}
      tools={
        running && !state?.busy ? (
          <StopSetup disabled={sending} onStop={() => void send("cancel")} />
        ) : (
          <span className="claw-setup-spacer" aria-hidden="true" />
        )
      }
    >
      {page}
    </ClawDialog>
  );
}

// What scrolls, then what stays at the bottom (the one pill).
function Screen({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <>
      <div className="claw-setup-body">{children}</div>
      {foot && <div className="claw-setup-foot">{foot}</div>}
    </>
  );
}

function Hero({
  icon,
  tone = "",
  title,
  children,
}: {
  icon?: ReactNode;
  tone?: "" | "done" | "alert";
  title: string;
  children?: ReactNode;
}) {
  const heading = useArrival();
  return (
    <div className="claw-setup-hero">
      {icon ? (
        <span className={`claw-setup-icon ${tone}`} aria-hidden="true">
          {icon}
        </span>
      ) : (
        <span className="claw-setup-mascot" aria-hidden="true">
          <BrandCourier />
        </span>
      )}
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
      {children && <p>{children}</p>}
    </div>
  );
}

// A screen's title takes focus when it arrives: read first, without moving
// the page, and the back chevron isn't left ringed.
function useArrival() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return heading;
}

function Problem({ text }: { text: string }) {
  return (
    <p className="claw-setup-problem" role="alert">
      {text}
    </p>
  );
}

// OpenClaw installing or checking something, or waiting on a sign-in by code.
function Working({ progress, problem }: { progress: Progress | null; problem: string }) {
  const heading = useArrival();
  // The code and its page show on their own: not again in OpenClaw's words.
  const words = (progress?.message || "")
    .split("\n")
    .filter((line) => !(progress?.code && line.includes(progress.code)) && !(progress?.link && /^https?:\/\/\S+$/.test(line.trim())))
    .join("\n")
    .trim();
  return (
    <Screen foot={problem && <Problem text={problem} />}>
      <div className="claw-setup-progress" role="status">
        <LoaderCircle size={30} className="spin" aria-hidden="true" />
        <h1 ref={heading} tabIndex={-1}>
          {progress?.title || (progress?.code ? "Sign in" : "One moment")}
        </h1>
        {progress?.code && <code className="claw-setup-code">{progress.code}</code>}
        {progress?.link && (
          <a className="claw-setup-link" href={progress.link} target="_blank" rel="noreferrer">
            Open sign-in page
            <ExternalLink size={16} />
          </a>
        )}
        {words ? <NoteText text={words} /> : <p>OpenClaw is working on it.</p>}
      </div>
    </Screen>
  );
}

// Tapped once, it asks; tapped again within 4 s, it stops OpenClaw's setup.
function StopSetup({ disabled, onStop }: { disabled: boolean; onStop: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <button
      type="button"
      className={`claw-setup-stop${asking ? " asking" : ""}`}
      disabled={disabled}
      aria-label={asking ? "Tap again to stop setup" : "Stop setup"}
      onClick={() => {
        if (!asking) return setAsking(true);
        setAsking(false);
        onStop();
      }}
    >
      {asking ? "Stop setup?" : "Stop"}
    </button>
  );
}

function Question({
  step,
  busy,
  problem,
  computer,
  answer,
}: {
  step: Step;
  busy: boolean;
  problem: string;
  computer: string;
  answer: (value: unknown) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<number[]>(() =>
    (step.selected || []).filter((i) => step.options.some((o) => o.index === i)),
  );
  const [query, setQuery] = useState("");
  // Each new question is read from its top.
  const heading = useArrival();
  // A note: its title large, its words below. A question: the question
  // large, any lines after it below.
  const note = step.type === "note";
  const [first = "", ...more] = step.message.split("\n");
  const title = note ? step.title : first.trim() || step.title;
  const body = note ? step.message : more.join("\n").trim();
  const eyebrow = !note && step.title && step.title !== title ? step.title : "";
  const words = query.trim().toLowerCase();
  const shown = words
    ? step.options.filter((o) => `${o.label} ${o.hint}`.toLowerCase().includes(words))
    : step.options;
  const multi = step.type === "multiselect";
  const formId = `claw-setup-${step.id}`;
  const submitText = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void answer(text);
    setText("");
  };
  const cta = (label: string, run: () => void, disabled = false) => (
    <button type="button" className="claw-setup-cta" disabled={busy || disabled} onClick={run}>
      {busy && <LoaderCircle size={17} className="spin" />}
      {label}
    </button>
  );
  return (
    <Screen
      foot={
        <>
          {problem && <Problem text={problem} />}
          {step.type === "confirm" ? (
            <>
              {cta("Yes", () => void answer(true))}
              <button type="button" className="claw-setup-cta quiet" disabled={busy} onClick={() => void answer(false)}>
                No
              </button>
            </>
          ) : step.type === "text" ? (
            <button type="submit" form={formId} className="claw-setup-cta" disabled={busy}>
              {busy && <LoaderCircle size={17} className="spin" />}
              Continue
            </button>
          ) : step.type === "select" ? (
            cta("Continue", () => void answer(selected[0]), selected.length !== 1)
          ) : multi ? (
            cta("Continue", () => void answer(selected))
          ) : (
            cta("Continue", () => void answer(null))
          )}
        </>
      }
    >
      <div className="claw-setup-ask" role="group" aria-label={title || "Setup question"}>
        {eyebrow && <p className="claw-setup-eyebrow">{eyebrow}</p>}
        {title && (
          <h1 ref={heading} tabIndex={-1} className={title.length > 60 ? "long" : ""}>
            {title}
          </h1>
        )}
        {body && <NoteText text={body} lead={!note} />}
        {(step.type === "select" || multi) && (
          <>
            {step.options.length >= SEARCH_FROM && (
              <label className="claw-setup-search">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search the choices"
                  placeholder="Search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
            <div
              className="claw-setup-options"
              role={multi ? "group" : "radiogroup"}
              aria-label={title || "Choices"}
            >
              {shown.map((option) => {
                const on = selected.includes(option.index);
                return (
                  <label key={option.index} className={`claw-setup-option${on ? " on" : ""}`}>
                    <input
                      type={multi ? "checkbox" : "radio"}
                      name={formId}
                      checked={on}
                      disabled={busy}
                      onChange={(e) =>
                        setSelected((values) =>
                          !multi
                            ? [option.index]
                            : e.target.checked
                              ? [...values, option.index]
                              : values.filter((v) => v !== option.index),
                        )
                      }
                    />
                    <span className="claw-setup-option-text">
                      <span>{option.label || `Choice ${option.index + 1}`}</span>
                      {option.hint && <small>{option.hint}</small>}
                    </span>
                    <span className={multi ? "claw-setup-box" : "claw-setup-tick"} aria-hidden="true">
                      <Check size={multi ? 14 : 20} strokeWidth={multi ? 3 : 2.4} />
                    </span>
                  </label>
                );
              })}
              {!shown.length && <p className="claw-setup-none">No choice matches “{query.trim()}”.</p>}
            </div>
          </>
        )}
        {step.type === "text" && (
          <form id={formId} onSubmit={submitText}>
            <input
              className="claw-setup-field"
              aria-label={title || "Your answer"}
              type={step.sensitive ? "password" : "text"}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={step.placeholder}
              value={text}
              disabled={busy}
              maxLength={16384}
              onChange={(e) => setText(e.target.value)}
            />
            {step.sensitive && (
              <p className="claw-setup-quiet">
                <Lock size={13} aria-hidden="true" />
                Only OpenClaw on your {computer} keeps it.
              </p>
            )}
          </form>
        )}
      </div>
    </Screen>
  );
}

// OpenClaw's plain text, laid out: blank lines part paragraphs, "- " lines
// are a list, a short line over a list or commands is its heading, and
// commands are code. Sentences on lines of their own read as one paragraph;
// lines that aren't sentences ("Gateway port: 18789") stay lines.
const COMMAND = /^(\$ |openclaw |npx |npm |pnpm |brew |curl |git )/;
const kind = (line: string) =>
  /^[-•*]\s+/.test(line) ? "item" : COMMAND.test(line) ? "command" : "text";
function NoteText({ text, lead = false }: { text: string; lead?: boolean }) {
  const blocks = text
    .split(/\n[ \t]*\n/)
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length);
  return (
    <div className={`claw-setup-note${lead ? " lead" : ""}`}>
      {blocks.map((lines, i) => (
        <NoteBlock key={i} lines={lines} />
      ))}
    </div>
  );
}

function NoteBlock({ lines }: { lines: string[] }) {
  const titled =
    lines.length > 1 &&
    kind(lines[0]) === "text" &&
    lines[0].length <= 48 &&
    !/[.!?,;]$/.test(lines[0]) &&
    lines.slice(1).every((line) => kind(line) !== "text");
  const rest = titled ? lines.slice(1) : lines;
  const runs: { kind: string; lines: string[] }[] = [];
  for (const line of rest) {
    const k = kind(line);
    if (runs.at(-1)?.kind === k) runs.at(-1)!.lines.push(line);
    else runs.push({ kind: k, lines: [line] });
  }
  return (
    <section>
      {titled && <h3>{lines[0].replace(/:$/, "")}</h3>}
      {runs.map((run, i) =>
        run.kind === "item" ? (
          <ul key={i}>
            {run.lines.map((line, j) => (
              <li key={j}>
                <Inline text={line.replace(/^[-•*]\s+/, "")} />
              </li>
            ))}
          </ul>
        ) : run.kind === "command" ? (
          <div key={i} className="claw-setup-commands">
            {run.lines.map((line, j) => (
              <code key={j}>{line.replace(/^\$ /, "")}</code>
            ))}
          </div>
        ) : run.lines.every((line) => /[.!?)]$/.test(line)) ? (
          <p key={i}>
            <Inline text={run.lines.join(" ")} />
          </p>
        ) : (
          run.lines.map((line, j) => (
            <p key={`${i}-${j}`}>
              <Inline text={line} />
            </p>
          ))
        ),
      )}
    </section>
  );
}

// `code` spans and https links; everything else as written.
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`|https:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)])/g).map((part, i) =>
        /^`[^`]+`$/.test(part) ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : /^https:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part.replace(/^https:\/\//, "")}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
