import { useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import {
  answerPrompt,
  openMacSetting,
  pressMacButton,
  sendMacPassword,
  type AgentSession,
  type MacPrompt,
  type SessionPrompt,
} from "./agent-sessions";
import { CLAUDE_DECISIONS, DECISIONS } from "./decision-words";
import MacPromptCard from "./MacPrompts";
import "./needs-you.css";

// One thing that needs you: what asks, what it asks, and its answers when
// the phone can give them (a tap each); otherwise where to answer it.
export type NeedItem = {
  key: string;
  icon: ReactNode;
  title: string;
  detail?: string;
  // Instead of answers: where it is answered ("Answer it on your Mac").
  note?: string;
  // An action may return words to show on its card after (what to do next).
  actions?: { label: string; primary?: boolean; completes?: boolean; run: () => unknown }[];
  // Shown under the strip when its card is tapped (the Mac's own dialog).
  more?: ReactNode;
  // A password to send instead of buttons (the Mac's password dialog).
  password?: { placeholder: string; submit: (value: string) => Promise<unknown> };
  screen?: () => void;
};

// The Mac's password, sent once to its password dialog; the field empties
// at once (nothing of it stays on the phone).
type PasswordState = "idle" | "busy" | "sent" | "error";
export function MacPasswordField({ placeholder, submit, onState }: { placeholder: string; submit: (value: string) => Promise<unknown>; onState?: (state: PasswordState) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState("");
  const pending = useRef(false);
  return (
    <form
      className="mac-password"
      onClick={(e) => e.stopPropagation()}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value || pending.current || sent) return;
        const secret = value;
        pending.current = true;
        setValue("");
        setBusy(true);
        setProblem("");
        onState?.("busy");
        try {
          await submit(secret);
          setSent(true);
          onState?.("sent");
        } catch (error) {
          setProblem((error as Error).message);
          onState?.("error");
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      <input
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        disabled={busy || sent}
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="primary" disabled={!value || busy || sent}>
        {busy ? <><Loader2 size={14} className="spin" /> Authenticating…</> : sent ? "Sent to Mac" : "Authenticate on Mac"}
      </button>
      <small className="mac-password-help">Sent only to this Mac's authentication dialog. Not saved by Reach.</small>
      {problem && <small className="problem" role="alert">{problem}</small>}
      {sent && <small className="said" role="status">Authentication submitted. Waiting for the request to clear.</small>}
    </form>
  );
}

// Everything that needs you, one card at a time in a strip the height of
// one: swipe sideways for the next; dots say how many and which one this is.
export function NeedsYouStrip({ items, label = "Needs you" }: { items: NeedItem[]; label?: string }) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const [passwordStates, setPasswordStates] = useState<Record<string, PasswordState>>({});
  const pending = useRef(new Set<string>());
  const [opened, setOpened] = useState<string | null>(null);
  const track = useRef<HTMLDivElement>(null);
  if (!items.length) return null;
  const at = Math.min(index, items.length - 1);
  const act = async (item: NeedItem, action: NonNullable<NeedItem["actions"]>[number]) => {
    if (pending.current.has(item.key) || completed[item.key]) return;
    pending.current.add(item.key);
    setBusy(item.key);
    setProblems((list) => ({ ...list, [item.key]: "" }));
    try {
      const words = await action.run();
      if (typeof words === "string") setSaid((list) => ({ ...list, [item.key]: words }));
      if (action.completes) setCompleted((list) => ({ ...list, [item.key]: true }));
    } catch (e) {
      setProblems((list) => ({ ...list, [item.key]: (e as Error).message }));
    } finally {
      pending.current.delete(item.key);
      setBusy(null);
    }
  };
  const go = (n: number) => track.current?.scrollTo({ left: n * track.current.clientWidth, behavior: "smooth" });
  const more = items.find((i) => i.key === opened)?.more;
  return (
    <section className="needs-you" aria-label={label}>
      <div
        className="needs-track"
        ref={track}
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
      >
        {items.map((item) => (
          <article
            key={item.key}
            className={`need-card ${item.more ? "openable" : ""} ${item.screen ? "has-screen" : ""}`}
            aria-label={item.title}
            onClick={item.more ? () => setOpened((o) => (o === item.key ? null : item.key)) : undefined}
          >
            <span className="need-icon">{item.icon}</span>
            <div className="need-text">
              <strong>{item.title}</strong>
              {item.detail && <small>{item.detail}</small>}
              {(problems[item.key] || said[item.key]) && (
                <small role={problems[item.key] ? "alert" : "status"} className={problems[item.key] ? "problem" : "said"}>
                  {problems[item.key] || said[item.key]}
                </small>
              )}
            </div>
            {item.password ? (
              <div className="need-actions">
                <MacPasswordField placeholder={item.password.placeholder} submit={item.password.submit}
                  onState={(state) => setPasswordStates((list) => ({ ...list, [item.key]: state }))} />
              </div>
            ) : item.actions?.length ? (
              <div className="need-actions">
                {item.actions.map((a) => (
                  <button
                    key={a.label}
                    className={a.primary ? "primary" : ""}
                    disabled={busy === item.key || completed[item.key]}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(item, a);
                    }}
                  >
                    {busy === item.key && a.primary ? <><Loader2 size={14} className="spin" /> Sending…</> : a.label}
                  </button>
                ))}
              </div>
            ) : item.note ? (
              <em className="need-note">{item.note}</em>
            ) : null}
            {item.screen && (
              <div className="need-screen">
                <small>{problems[item.key] || passwordStates[item.key] === "error"
                  ? "Couldn't complete this in Reach. Try the live screen. If macOS blocks remote control, approve on the Mac itself."
                  : !item.actions?.length && !item.password ? "This dialog needs your attention on the live screen." : "You can also respond on the live screen."}</small>
                <button disabled={busy === item.key || passwordStates[item.key] === "busy"}
                  className={problems[item.key] || passwordStates[item.key] === "error" || (!item.actions?.length && !item.password) ? "primary" : ""} onClick={(e) => {
                  e.stopPropagation();
                  item.screen?.();
                }}>Open live screen</button>
              </div>
            )}
          </article>
        ))}
      </div>
      {items.length > 1 && (
        <div className="need-dots" role="tablist" aria-label={`${at + 1} of ${items.length}`}>
          {items.map((item, i) => (
            <button key={item.key} role="tab" aria-selected={i === at} aria-label={item.title} className={i === at ? "on" : ""} onClick={() => go(i)} />
          ))}
        </div>
      )}
      {more && <div className="need-more">{more}</div>}
    </section>
  );
}

const keyOf = (d: unknown) => (typeof d === "string" ? d : Object.keys(d as object)[0]);
const negative = (key: string) => /^(decline|deny|cancel|abort)/.test(key);
const positive = (key: string) => /^(accept|approved|allow)$/.test(key);

// What the agents and the Mac ask, as strip cards: answerable ones first,
// then chats to open, then the Mac's own dialogs.
export function agentNeeds({
  peer,
  sessions,
  macPrompts = [],
  logos,
  open,
  answered,
  showOnScreen,
}: {
  peer: Peer;
  sessions: AgentSession[];
  macPrompts?: MacPrompt[];
  logos: AgentLogos;
  open: (s: AgentSession) => void;
  // Called after an answer goes through (to refresh the list).
  answered?: () => void;
  // Opens the live screen on a Mac dialog, to answer it there.
  showOnScreen?: (p: MacPrompt) => void;
}): NeedItem[] {
  const answerable: NeedItem[] = [];
  const toOpen: NeedItem[] = [];
  const name = (s: AgentSession) => (s.agent === "codex" ? "Codex" : "Claude Code");
  const icon = (s: AgentSession) => <AgentLogo agent={s.agent} logos={logos} size={24} />;
  const send = (s: AgentSession, id: string, answer: object) => async () => {
    await answerPrompt(peer, s, id, answer);
    answered?.();
  };
  for (const s of sessions) {
    let listed = false;
    if (s.consent?.id) {
      listed = true;
      const [deny = "Deny", allow = "Allow for this session"] = s.consent.options || [];
      answerable.push({
        key: `${s.agent}:${s.id}:${s.consent.id}`,
        icon: icon(s),
        title: s.consent.title,
        detail: s.title,
        actions: [
          { label: deny, run: send(s, s.consent.id, { decision: "deny" }) },
          { label: allow, primary: true, run: send(s, s.consent.id, { decision: "allow" }) },
        ],
      });
    }
    for (const p of s.prompts || []) {
      listed = true;
      const keys = (p.decisions || []).map(keyOf);
      const no = keys.find(negative);
      const yes = keys.find(positive);
      const words = p.kind === "tool" ? CLAUDE_DECISIONS : DECISIONS;
      if (p.kind !== "question" && p.kind !== "dialog" && no && yes)
        answerable.push({
          key: `${s.agent}:${s.id}:${p.id}`,
          icon: icon(s),
          title: p.title,
          detail: [s.title, p.command].filter(Boolean).join(" · "),
          actions: [
            { label: words[no] || no, run: send(s, p.id, { decision: no }) },
            { label: words[yes] || yes, primary: true, run: send(s, p.id, { decision: yes }) },
          ],
        });
      else
        toOpen.push({ key: `${s.agent}:${s.id}:${p.id}`, icon: icon(s), title: p.title, detail: s.title, actions: [{ label: "Open", primary: true, run: () => open(s) }] });
    }
    if (!listed && s.status === "waiting")
      toOpen.push({
        key: `${s.agent}:${s.id}`,
        icon: icon(s),
        title: s.title,
        detail: `${name(s)} is waiting for you`,
        actions: [{ label: "Open", primary: true, run: () => open(s) }],
      });
  }
  // Keep a live-screen route visible even if the native answer fails or the
  // watcher cannot locate the dialog. Protected prompts may still need a
  // person at the Mac; opening the screen does not grant OS permissions.
  const mac: NeedItem[] = macPrompts.map((p) => {
    const setting = p.setting
      ? async () => {
          const r = await openMacSetting(peer, p.id);
          return `Opened on your Mac: switch on ${r.app ? `“${r.app}”` : "it"} in ${r.opened}.`;
        }
      : null;
    const onScreen = showOnScreen ? () => showOnScreen(p) : undefined;
    const others = (
      <div className="need-ways">
        {setting && (
          <button onClick={() => void setting().catch(() => {})}>Open setting on Mac</button>
        )}
      </div>
    );
    const more = (
      <>
        <MacPromptCard prompt={p} logos={logos} compact={false} />
        {setting && others}
      </>
    );
    const base = {
      key: `mac:${p.id}`,
      icon: <AgentLogo agent="macos" name="macOS" logos={logos} size={24} />,
      title: p.lines?.[0] || p.title,
      detail: peer.name,
      screen: onScreen,
      more,
    };
    if (p.kind === "password")
      return { ...base, title: "Your Mac needs authentication", password: { placeholder: "Your Mac's password", submit: async (value: string) => {
        await sendMacPassword(peer, p.id, value);
        answered?.();
      } } };
    if (p.buttons?.length)
      return {
        ...base,
        actions: p.buttons.map((b) => ({ label: b, primary: b === p.default, completes: true, run: async () => {
          await pressMacButton(peer, p.id, b);
          answered?.();
          return "Response sent to your Mac. Refreshing the request…";
        } })),
      };
    // macOS showed no buttons to read: the other ways in, or at the Mac.
    const ways: NonNullable<NeedItem["actions"]> = [];
    if (setting) ways.push({ label: "Open setting on Mac", run: setting });
    if (ways.length === 1 && !onScreen) ways[0].primary = true;
    return { ...base, ...(ways.length ? { actions: ways } : !onScreen ? { note: "Answer on your Mac" } : {}) };
  });
  return [...answerable, ...toOpen, ...mac];
}

// The prompts a chat page shows itself are left to it.
export type { SessionPrompt };
