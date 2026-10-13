import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import ChatSheet from "./ChatSheet";
import { post, request, type Peer } from "./api";
import { clawBase } from "./OpenClawControls";

type Step = {
  id: string;
  type: string;
  title: string;
  message: string;
  sensitive: boolean;
  placeholder: string;
  options: { index: number; label: string; hint: string }[];
};
type State = {
  supported: boolean;
  busy: boolean;
  status: string;
  problem: string;
  step: Step | null;
};

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
  return (
    <ChatSheet title="Guided OpenClaw setup" onClose={onClose}>
      <div className="claw-settings">
        {!state && <p role="status">Loading setup…</p>}
        {state && !state.supported && (
          <p>This OpenClaw version doesn't offer guided setup in Reach.</p>
        )}
        {state?.supported && (
          <>
            {["idle", "done", "cancelled", "error"].includes(state.status) && (
              <>
                {state.status === "done" && (
                  <p role="status">Setup completed.</p>
                )}
                {state.status === "cancelled" && (
                  <p role="status">
                    Setup cancelled. Changes already saved by OpenClaw remain.
                  </p>
                )}
                <p>
                  OpenClaw will guide you through its full setup, including
                  models, messaging apps, and skills. Choose each answer here.
                  Changes may be saved as you go.
                </p>
                <button
                  type="button"
                  className="claw-primary"
                  disabled={sending}
                  onClick={() => void send("start")}
                >
                  Start guided setup
                </button>
              </>
            )}
            {state.busy && (
              <p role="status">
                <LoaderCircle size={14} className="spin" /> OpenClaw is working… You
                can close this panel and return later.
              </p>
            )}
            {state.step && !state.busy && (
              <Question
                key={state.step.id}
                step={state.step}
                busy={sending}
                answer={(value) =>
                  send("answer", { stepId: state.step!.id, value })
                }
              />
            )}
            {(state.problem || problem) && (
              <p className="claw-error" role="alert">
                {problem || state.problem}
              </p>
            )}
            {!["idle", "done", "cancelled", "error"].includes(state.status) && (
              <div className="claw-settings-actions">
                <button
                  type="button"
                  className="claw-secondary"
                  disabled={sending || state.busy}
                  onClick={() => void send("refresh")}
                >
                  Check setup status
                </button>
                <button
                  type="button"
                  className="claw-secondary"
                  disabled={sending || state.busy}
                  onClick={() => void send("cancel")}
                >
                  Cancel setup
                </button>
              </div>
            )}
          </>
        )}
        {!state?.supported && problem && (
          <p className="claw-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </ChatSheet>
  );
}

function Question({
  step,
  busy,
  answer,
}: {
  step: Step;
  busy: boolean;
  answer: (value: unknown) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  return (
    <div
      role="group"
      aria-label={step.title || step.message || "Setup question"}
    >
      {step.title && <h3>{step.title}</h3>}
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {step.message}
      </p>
      {step.type === "select" && (
        <div className="claw-settings-actions">
          {step.options.map((option) => (
            <button
              key={option.index}
              className="claw-secondary"
              disabled={busy}
              onClick={() => void answer(option.index)}
            >
              {option.label}
              {option.hint && <small> — {option.hint}</small>}
            </button>
          ))}
        </div>
      )}
      {step.type === "multiselect" && (
        <>
          {step.options.map((option) => (
            <label key={option.index} className="claw-check">
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.includes(option.index)}
                onChange={(e) =>
                  setSelected((values) =>
                    e.target.checked
                      ? [...values, option.index]
                      : values.filter((v) => v !== option.index),
                  )
                }
              />
              {option.label}
              {option.hint && ` — ${option.hint}`}
            </label>
          ))}
          <button
            className="claw-primary"
            disabled={busy}
            onClick={() => void answer(selected)}
          >
            Continue
          </button>
        </>
      )}
      {step.type === "confirm" && (
        <div className="claw-settings-actions">
          <button
            className="claw-secondary"
            disabled={busy}
            onClick={() => void answer(false)}
          >
            No
          </button>
          <button
            className="claw-primary"
            disabled={busy}
            onClick={() => void answer(true)}
          >
            Yes
          </button>
        </div>
      )}
      {step.type === "text" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) {
              void answer(text);
              setText("");
            }
          }}
        >
          <input
            aria-label={step.message || "Your answer"}
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
          <button className="claw-primary" disabled={busy}>
            Continue
          </button>
        </form>
      )}
      {step.type === "note" && (
        <button
          className="claw-primary"
          disabled={busy}
          onClick={() => void answer(null)}
        >
          Continue
        </button>
      )}
    </div>
  );
}
