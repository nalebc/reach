import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Info, Loader2, Plus, SearchCheck, Workflow, X } from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import ChatSheet from "./ChatSheet";
import {
  agentLabel,
  cancelRelay,
  projectName,
  startRelay,
  type AgentHealth,
  type AgentSession,
  type Relay,
  type RelayStep,
} from "./agent-sessions";
import "./relays.css";
import { CONTINUE_PRIORITY, checkContinuePriority, continueUnavailable } from "../server/agent-sessions/auto-continue.mjs";

// Working across agents (docs/ACROSS_AGENTS.md): a second opinion on a reply,
// and relays (what one agent did goes on to another when it finishes). The
// Mac does the work (server/agent-sessions/relays.mjs); the phone sets it
// up, shows where it stands, and cancels what still waits.

type ChatRef = { agent: string; id: string; title?: string };
// What the Mac answers when one is set up: the relay, and the chat it went
// to when it started at once.
export type RelayStarted = { relay: Relay; opened?: { agent: string; id: string } };

// The agents that can take a step now: installed, signed in, with usage.
// OpenClaw takes relays, reviews and workflow tasks, never a team (teams:
// docs/ACROSS_AGENTS.md).
export const relayAgents = (health: AgentHealth[], { openclaw = true } = {}) =>
  ["codex", "claude", ...(openclaw ? ["openclaw"] : [])].filter((a) =>
    health.some((h) => h.agent === a && h.installed && (a === "openclaw" ? h.connected === true : h.signedIn && h.usable !== false)),
  );
// The other agent first (the point of a second opinion), then the same one.
const othersFirst = (agent: string, agents: string[]) => [...agents.filter((a) => a !== agent), ...agents.filter((a) => a === agent)];

// What a step does, in a few words ("Claude Code reviews it"). "back" goes
// to the chat before the one it follows: there already, or still to come
// (the agent of the step that makes it).
export function stepWords(step: RelayStep, chain: Relay["chain"] = [], n = 0, steps: RelayStep[] = []) {
  const who = agentLabel(step.agent || step.to?.agent || chain[n]?.agent || "");
  if (step.kind === "build") return `${who} builds it`;
  if (step.kind === "review") return `${who} reviews it`;
  if (step.kind === "send") return `to “${step.to?.title || "a chat"}”`;
  if (step.kind === "post") return "posted back to the chat that asked";
  const before = chain[n - 1]?.agent || (n >= 2 ? steps[n - 2]?.agent || steps[n - 2]?.to?.agent : chain[0]?.agent);
  return `the review goes back to ${before ? agentLabel(before) : "the builder"}`;
}

// Where a relay stands, seen from one of its chats.
export function relayLine(relay: Relay, here: ChatRef) {
  if (relay.trigger === "usage") {
    const target = agentLabel(relay.steps[relay.next]?.agent || relay.steps[0]?.agent || "");
    if (relay.state === "waiting") return relay.priority
      ? `Auto-continue: ${relay.priority.map(agentLabel).join(" → ")}. Unavailable providers are skipped (24 hours).`
      : `Auto-continue in ${target} if usage runs out (24 hours).`;
    if (relay.state === "sending") return `Continuing in ${target}…`;
    if (relay.state === "done") return `Auto-continued in ${agentLabel(relay.chain.at(-1)?.agent || relay.steps[0]?.agent || "")}.`;
    return relay.problem || "Auto-continue stopped.";
  }
  const at = relay.chain.at(-1)!;
  const waitingHere = at.agent === here.agent && at.id === here.id;
  const rest = relay.steps.slice(relay.next).map((s, i) => stepWords(s, relay.chain, relay.next + i, relay.steps));
  const then = rest.length ? rest.join(", then ") : "";
  if (relay.state === "waiting")
    return waitingHere
      ? relay.next === 0
        ? `When ${agentLabel(at.agent)} finishes: ${then}`
        : `When this is done: ${then}`
      : relay.sent.at(-1)?.queued
        ? `In line for ${agentLabel(at.agent)} in “${at.title || "a chat"}”: it goes in when that chat is free${then ? `. Then ${then}` : ""}`
        : `${agentLabel(at.agent)} is on it in “${at.title || "a new chat"}”${then ? `. Then ${then}` : ""}`;
  if (relay.state === "sending") return `Handing off to ${agentLabel(relay.steps[relay.next]?.agent || relay.steps[relay.next]?.to?.agent || "")}…`;
  if (relay.state === "done") return `Handed off: ${relay.steps.map((s, i) => stepWords(s, relay.chain, i, relay.steps)).join(", then ")}`;
  return relay.problem || "This handoff stopped.";
}

// The relays a chat is part of: waiting or sending, and the ones that ended
// in the last hour (one that stopped says why).
export const relaysOf = (relays: Relay[], here: ChatRef, now = Date.now()) =>
  relays.filter(
    (r) =>
      // A helper's report to its team's lead shows with the team (Teams.tsx).
      !r.steps.some((s) => (s.kind as string) === "report") &&
      r.chain.some((c) => c.agent === here.agent && c.id === here.id) &&
      (["waiting", "sending"].includes(r.state) || now - r.updatedAt < 60 * 60 * 1000),
  );

// Above the message box: each relay this chat is part of, with the way to
// the chat it's in now, and Cancel while it waits.
export function RelayStrip({
  peer,
  relays,
  here,
  logos,
  onOpen,
  onChanged,
}: {
  peer: Peer;
  relays: Relay[];
  here: ChatRef;
  logos: AgentLogos;
  onOpen: (chat: ChatRef) => void;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [gone, setGone] = useState<string[]>([]);
  const mine = relaysOf(relays, here).filter((r) => !gone.includes(r.id));
  if (!mine.length) return null;
  const cancel = async (r: Relay) => {
    setBusy(r.id);
    setProblem("");
    try {
      await cancelRelay(peer, r.id);
      setGone((g) => [...g, r.id]);
      onChanged?.();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="relay-strip" role="group" aria-label="Handoffs">
      {mine.map((r) => {
        const at = r.chain.at(-1)!;
        const elsewhere = !(at.agent === here.agent && at.id === here.id);
        const nextAgent = r.steps[r.next]?.agent || r.steps[r.next]?.to?.agent || at.agent;
        return (
          <div key={r.id} className={`relay-row ${r.state}`}>
            {r.state === "stopped" || r.state === "uncertain" ? (
              <X size={16} />
            ) : (
              <span className="relay-mini-route" aria-hidden="true">
                <AgentLogo agent={r.chain[0].agent} logos={logos} size={16} />
                <i className={r.state === "sending" ? "moving" : ""} />
                {r.state === "done" ? <Check size={14} /> : <AgentLogo agent={elsewhere ? at.agent : nextAgent} logos={logos} size={16} />}
              </span>
            )}
            <span className="relay-row-text">{relayLine(r, here)}</span>
            {elsewhere && (r.state !== "stopped" || r.trigger === "usage") && (
              <button className="relay-row-action" onClick={() => onOpen(at)}>
                Open
              </button>
            )}
            {r.state === "waiting" && (
              <button className="relay-row-action" disabled={busy === r.id} aria-label="Cancel handoff" onClick={() => void cancel(r)}>
                {busy === r.id ? <Loader2 size={14} className="spin" /> : "Cancel"}
              </button>
            )}
          </div>
        );
      })}
      {problem && <small className="relay-problem">{problem}</small>}
    </div>
  );
}

// The way a relay goes, drawn as Reach draws the way between devices: each
// agent a tile, joined by the courier's dashed line. The chat it starts from
// first (dimmed), then one tile per step with what it does under it. A tile
// can be picked (to change it); the last place offers the next step.
export type RouteNode = { key: string; agent: string; label: string; dim?: boolean; icon?: "chat" };
export function Route({
  nodes,
  logos,
  selected = -1,
  onSelect,
  add,
}: {
  nodes: RouteNode[];
  logos: AgentLogos;
  selected?: number;
  onSelect?: (index: number) => void;
  add?: { label: string; onAdd: () => void; caption?: string };
}) {
  return (
    <div className="relay-route" role="group" aria-label="Route">
      {nodes.map((n, i) => (
        <div key={n.key} className="relay-route-part">
          {i > 0 && <span className="relay-route-line on" aria-hidden="true" />}
          <button
            className={`relay-node ${n.dim ? "dim" : ""} ${selected === i ? "picked" : ""}`}
            aria-label={`${agentLabel(n.agent)} ${n.label}`}
            aria-pressed={onSelect && !n.dim ? selected === i : undefined}
            disabled={!onSelect || n.dim}
            onClick={() => onSelect?.(i)}
          >
            <span className="relay-node-tile">
              {n.icon === "chat" ? <Workflow size={20} /> : <AgentLogo agent={n.agent} logos={logos} size={26} />}
            </span>
            <span className="relay-node-label">{n.label}</span>
          </button>
        </div>
      ))}
      {add && (
        <div className="relay-route-part">
          <span className="relay-route-line" aria-hidden="true" />
          <button className="relay-node add" aria-label={add.label} onClick={add.onAdd}>
            <span className="relay-node-tile">
              <Plus size={18} />
            </span>
            <span className="relay-node-label">{add.caption || "then…"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// The rules, one short line; the whole of them a tap away.
function Rules() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relay-rules">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        <Info size={14} /> Safe defaults · each step sends once
      </button>
      {open && (
        <p>
          Builders start in each app’s middle setting, never Full access or Bypass. Reviewers read, and ask you before anything more. A
          step sends only after the chat really finished, and stops if your phone loses access.
        </p>
      )}
    </div>
  );
}

// "Second opinion" on a reply: another agent reviews that turn in a new chat
// that reads, and asks you before anything more; its review can come back.
export function SecondOpinionSheet({
  peer,
  session,
  item,
  cwd,
  postTo,
  health,
  logos,
  onClose,
  onStarted,
}: {
  peer: Peer;
  session: AgentSession;
  item?: string;
  // The folder to work in, for a chat that has none (OpenClaw's).
  cwd?: string;
  // An OpenClaw chat with a person on WhatsApp or Telegram: the app's name,
  // offered as a switch to post the answer back there.
  postTo?: string;
  health: AgentHealth[];
  logos: AgentLogos;
  onClose: () => void;
  onStarted: (started: RelayStarted) => void;
}) {
  const agents = othersFirst(session.agent, relayAgents(health));
  const [reviewer, setReviewer] = useState(agents[0] || "");
  const canReturn = session.agent === "codex" || session.agent === "claude";
  const [back, setBack] = useState(canReturn);
  // Off until chosen, each time (the owner's choice per relay, Oct 8).
  const [postBack, setPostBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const from = agentLabel(session.agent);
  const ask = async () => {
    setBusy(true);
    setProblem("");
    try {
      const steps: RelayStep[] = [{ kind: "review", agent: reviewer }, ...(back ? [{ kind: "back" as const }] : [])];
      onStarted(
        await startRelay(peer, {
          from: { agent: session.agent, id: session.id },
          steps,
          now: true,
          ...(item ? { item } : {}),
          ...(cwd ? { cwd } : {}),
          ...(postTo && postBack ? { postBack: true } : {}),
        }),
      );
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  const nodes: RouteNode[] = [
    { key: "from", agent: session.agent, label: "replied", dim: true },
    ...(reviewer ? [{ key: "review", agent: reviewer, label: "reviews" }] : []),
    ...(reviewer && back ? [{ key: "back", agent: session.agent, label: "gets it back" }] : []),
  ];
  return (
    <ChatSheet title="Review reply" className="relay-sheet reach-native" onClose={onClose}>
      {agents.length ? (
        <>
          <Route
            nodes={nodes}
            logos={logos}
            selected={1}
            // The reviewer's tile switches reviewer.
            onSelect={(i) => i === 1 && agents.length > 1 && setReviewer(agents[(agents.indexOf(reviewer) + 1) % agents.length])}
          />
          <p className="relay-say">
            {reviewer === session.agent ? `A new ${from} chat` : agentLabel(reviewer)} checks {from}’s reply and changed files for mistakes. The reviewer asks before making changes.
          </p>
          {agents.length > 1 && <p className="relay-hint">Tap the reviewer to switch.</p>}
          {canReturn && (
            <label className="relay-switch">
              <input type="checkbox" role="switch" checked={back} disabled={busy} onChange={(e) => setBack(e.target.checked)} />
              <span>Send the review back here</span>
            </label>
          )}
          {postTo && (
            <label className="relay-switch">
              <input type="checkbox" role="switch" checked={postBack} disabled={busy} onChange={(e) => setPostBack(e.target.checked)} />
              <span>Post the answer on {postTo}</span>
            </label>
          )}
          {problem && <p className="relay-problem" role="alert">{problem}</p>}
          <button className="relay-go" disabled={busy || !reviewer} onClick={() => void ask()}>
            {busy ? <Loader2 size={16} className="spin" /> : `Ask ${reviewer === session.agent ? `a new ${agentLabel(reviewer)} chat` : agentLabel(reviewer)}`}
          </button>
        </>
      ) : (
        <p className="relay-say">Sign in to Codex or Claude Code on your computer to ask for a review.</p>
      )}
    </ChatSheet>
  );
}

// What each kind of step does, as its tile says it.
// The step that naturally comes next: a review of what was built, then the fixes.
function nextStep(steps: RelayStep[], from: string, agents: string[]): RelayStep | null {
  const last = steps.at(-1);
  if (!last || steps.length >= 3) return null;
  if (last.kind === "build") return { kind: "review", agent: othersFirst(last.agent || from, agents)[0] };
  if (last.kind === "review") return { kind: "back" };
  return null;
}
// Who does a step: its own agent, or for "back", the one whose work was reviewed.
const stepAgent = (steps: RelayStep[], i: number, from: string): string => {
  const step = steps[i];
  if (step.kind !== "back") return step.agent || step.to?.agent || from;
  return i >= 2 ? stepAgent(steps, i - 2, from) : from;
};
// Hand off a reply now or when it finishes, with optional follow-up steps.
export function RelaySheet({
  peer,
  session,
  working,
  hasReply,
  sessions,
  cwd,
  item,
  postTo,
  health,
  logos,
  onClose,
  onStarted,
}: {
  peer: Peer;
  session: AgentSession;
  working: boolean;
  hasReply: boolean;
  sessions: AgentSession[];
  cwd?: string;
  // From one reply further up: it goes on now, from that reply.
  item?: string;
  // As SecondOpinionSheet's: the app the last answer can be posted on.
  postTo?: string;
  health: AgentHealth[];
  logos: AgentLogos;
  onClose: () => void;
  onStarted: (started: RelayStarted) => void;
}) {
  const [postBack, setPostBack] = useState(false);
  const agents = relayAgents(health);
  const from = session.agent;
  const first = othersFirst(from, agents)[0];
  const [steps, setSteps] = useState<RelayStep[]>(first ? [{ kind: "build", agent: first }] : []);
  const [to, setTo] = useState<AgentSession | null>(null);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState<"now" | "next">(item ? "now" : working || !hasReply ? "next" : "now");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // Chats a reply can go to: Codex and Claude Code chats, newest first.
  const chats = useMemo(
    () =>
      sessions
        .filter((s) => (s.agent === "codex" || s.agent === "claude") && !s.archived && !(s.agent === from && s.id === session.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30),
    [sessions, from, session.id],
  );
  const suggestion = nextStep(steps, from, agents);
  const change = (i: number, step: RelayStep | null) => {
    setSteps((list) => (step ? list.map((s, n) => (n === i ? step : s)) : list.slice(0, i)));
  };
  const sending = steps[0]?.kind === "send";
  const ready = steps.length > 0 && (!sending || !!to);
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setProblem("");
    const words = note?.trim() || "";
    const out = steps.map((s, i) =>
      i === 0 && s.kind === "send"
        ? { kind: "send" as const, to: { agent: to!.agent, id: to!.id }, ...(words ? { instructions: words } : {}) }
        : i === 0 && s.kind === "build" && words
          ? { ...s, instructions: words }
          : s,
    );
    try {
      onStarted(await startRelay(peer, { from: { agent: from, id: session.id }, steps: out, now: !!item || when === "now", ...(item ? { item } : {}), ...(cwd ? { cwd } : {}), ...(postTo && postBack ? { postBack: true } : {}) }));
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <ChatSheet title="Hand off" className="relay-sheet reach-native" onClose={onClose}>
      <p className="relay-hint">Share this reply and its context with another agent.</p>
      <p className="relay-when-line">{item ? "Uses the selected reply" : working ? `When ${agentLabel(from)} finishes` : hasReply ? `${agentLabel(from)}’s reply` : `When ${agentLabel(from)} next replies`}</p>
      {agents.length ? (
        <>
          <label className="handoff-field">
            <span>Where should the work go?</span>
            <select aria-label="Where should the work go?" value={sending ? "existing" : "new"} disabled={busy}
              onChange={(e) => setSteps([e.target.value === "existing" ? { kind: "send" } : { kind: "build", agent: first }])}>
              <option value="new">Start a new chat</option>
              <option value="existing">Use an existing chat</option>
            </select>
          </label>
          {!sending && (
            <>
              <label className="handoff-field">
                <span>Agent</span>
                <select aria-label="Agent for the new chat" value={steps[0]?.agent || first} disabled={busy}
                  onChange={(e) => setSteps([{ ...steps[0], agent: e.target.value }])}>
                  {agents.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}
                </select>
              </label>
              <label className="handoff-field">
                <span>What should it do?</span>
                <select aria-label="What should it do?" value={steps[0]?.kind || "build"} disabled={busy}
                  onChange={(e) => setSteps([{ kind: e.target.value as "build" | "review", agent: steps[0]?.agent || first }])}>
                  <option value="build">Continue the work</option>
                  <option value="review">Review for mistakes</option>
                </select>
              </label>
              <p className="handoff-help">{steps[0]?.kind === "review"
                ? "Checks the reply and changed files. Asks before making changes."
                : "Starts a new chat with this work and can edit files to carry it out."}</p>
            </>
          )}
          {sending && <p className="handoff-help">Choose a conversation below. The reply is sent as a new message in that chat. Add instructions below if you want the agent to do something specific. If it’s busy, the message waits.</p>}
          {sending && (
            <div className="relay-chats" role="listbox" aria-label="Choose an existing chat">
              {chats.length ? (
                chats.map((s) => (
                  <button
                    key={`${s.agent}:${s.id}`}
                    role="option"
                    aria-selected={to?.agent === s.agent && to?.id === s.id}
                    className="relay-chat"
                    disabled={busy}
                    onClick={() => setTo(s)}
                  >
                    <AgentLogo agent={s.agent} logos={logos} size={18} />
                    <span>{s.title || "Untitled"}</span>
                    <small>{agentLabel(s.agent)} · {projectName(s.cwd)}</small>
                  </button>
                ))
              ) : (
                <p className="relay-say">No other Codex or Claude Code chats yet.</p>
              )}
            </div>
          )}
          {(sending || steps[0]?.kind === "build") && (
            <label className="handoff-field">
              <span>Instructions <small>(optional)</small></span>
              <input className="relay-instructions" aria-label="Instructions for the next agent"
                placeholder="e.g. Implement this plan and run the tests"
                value={note} maxLength={2000} disabled={busy} onChange={(e) => setNote(e.target.value)} />
            </label>
          )}
          {!sending && (
            <details className="handoff-followups">
              <summary>After that… <span>{steps.length > 1 ? `${steps.length - 1} added` : "optional"}</span></summary>
              {steps.slice(1).map((step, offset) => {
                const i = offset + 1;
                return <div className="handoff-followup" key={i}>
                  {step.kind === "back" ? (
                    <p>Send the review back to {agentLabel(stepAgent(steps, i, from))} to address the findings.</p>
                  ) : (
                    <label className="handoff-field">
                      <span>Review the finished work with</span>
                      <select aria-label="Review the finished work with" value={step.agent} disabled={busy}
                        onChange={(e) => change(i, { ...step, agent: e.target.value })}>
                        {agents.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}
                      </select>
                    </label>
                  )}
                  <button type="button" disabled={busy} onClick={() => change(i, null)} aria-label={`Remove follow-up ${i}`}>Remove</button>
                </div>;
              })}
              {suggestion && <button type="button" className="handoff-add" disabled={busy} onClick={() => setSteps([...steps, suggestion])}>
                <Plus size={15} /> {suggestion.kind === "review" ? "Add a review of the finished work" : "Send the review back for fixes"}
              </button>}
            </details>
          )}
          {!working && hasReply && !item && (
            <div className="relay-when" role="radiogroup" aria-label="When">
              <button role="radio" aria-checked={when === "now"} disabled={busy} onClick={() => setWhen("now")}>
                Now — latest reply
              </button>
              <button role="radio" aria-checked={when === "next"} disabled={busy} onClick={() => setWhen("next")}>
                After the next reply
              </button>
            </div>
          )}
          <Rules />
          {postTo && (
            <label className="relay-switch">
              <input type="checkbox" role="switch" checked={postBack} disabled={busy} onChange={(e) => setPostBack(e.target.checked)} />
              <span>Post the last answer on {postTo}</span>
            </label>
          )}
          {problem && <p className="relay-problem" role="alert">{problem}</p>}
          <button className="relay-go" disabled={!ready || busy} onClick={() => void go()}>
            {busy ? <Loader2 size={16} className="spin" /> : item || (when === "now" && !working && hasReply) ? "Hand off now" : "Hand off after reply"}
          </button>
        </>
      ) : (
        <p className="relay-say">Sign in to Codex or Claude Code on your computer to hand off this chat.</p>
      )}
    </ChatSheet>
  );
}

// The button by a reply that asks for a second opinion.
export function SecondOpinionButton({ onClick, labelled = false }: { onClick: () => void; labelled?: boolean }) {
  return labelled ? (
    <button className="relay-opinion" aria-label="Review reply" onClick={onClick}>
      <SearchCheck size={17} /> <span>Review reply</span>
    </button>
  ) : (
    <button className="as-icon" aria-label="Review reply" onClick={onClick}>
      <SearchCheck size={15} />
    </button>
  );
}

// Uses the same persisted, cancellable watch as a relay, with a usage-only trigger.
export function AutoContinueSheet({ peer, session, health, onClose, onStarted }: {
  peer: Peer; session: AgentSession; health: AgentHealth[];
  onClose: () => void; onStarted: (started: RelayStarted) => void;
}) {
  const storageKey = `reach-continue-priority:${peer.id}`;
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = checkContinuePriority(JSON.parse(localStorage.getItem(storageKey) || "null"));
      return [...saved, ...CONTINUE_PRIORITY.filter((a) => !saved.includes(a))];
    } catch { return [...CONTINUE_PRIORITY]; }
  });
  const [included, setIncluded] = useState<string[]>(() => {
    try {
      const saved = checkContinuePriority(JSON.parse(localStorage.getItem(storageKey) || "null"));
      return saved.includes(session.agent) ? saved : [...saved, session.agent];
    } catch { return [...CONTINUE_PRIORITY]; }
  });
  const priority = order.filter((a) => included.includes(a));
  const ready = priority.some((a) => a !== session.agent && !continueUnavailable(a, health));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const reorder = (index: number, offset: number) => setOrder((previous) => {
    const next = [...previous];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    return next;
  });
  const enable = async () => {
    setBusy(true);
    setProblem("");
    try {
      const started = await startRelay(peer, {
        from: { agent: session.agent, id: session.id }, priority, trigger: "usage",
      });
      try { localStorage.setItem(storageKey, JSON.stringify(priority)); } catch { /* private browser */ }
      onStarted(started);
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return <ChatSheet title="Auto-continue" className="relay-sheet reach-native" onClose={onClose}>
    <p className="relay-say">When usage runs out, continue with the first available provider in this order. If that provider runs out too, move to the next unused provider with the conversation history.</p>
    <ol className="continue-priority" aria-label="Provider priority">
      {order.map((agent, index) => {
        const unavailable = continueUnavailable(agent, health);
        const current = agent === session.agent;
        return <li key={agent}>
          <label>
            <input type="checkbox" checked={included.includes(agent)} disabled={busy || current}
              aria-label={`Use ${agentLabel(agent)}`}
              onChange={(e) => setIncluded((list) => e.target.checked ? [...list, agent] : list.filter((a) => a !== agent))} />
            <span><strong>{agentLabel(agent)}</strong><small>{current ? "Current provider" : unavailable ? `${unavailable} · skipped` : "Available"}</small></span>
          </label>
          <button aria-label={`Move ${agentLabel(agent)} up`} disabled={busy || index === 0} onClick={() => reorder(index, -1)}><ArrowUp size={16} /></button>
          <button aria-label={`Move ${agentLabel(agent)} down`} disabled={busy || index === order.length - 1} onClick={() => reorder(index, 1)}><ArrowDown size={16} /></button>
        </li>;
      })}
    </ol>
    <p className="relay-say">Watches for 24 hours, uses each provider once, and skips providers that are unavailable. Each provider uses its own permissions and usage. OpenClaw uses its own tools and may not have access to this project. Cancel above the message box. Your order is remembered on this device.</p>
    {!ready && <p className="relay-problem">Select another available provider. Sign in or reconnect on this computer if needed.</p>}
    {problem && <p className="relay-problem" role="alert">{problem}</p>}
    <button className="relay-go" disabled={!ready || busy} onClick={() => void enable()}>
      {busy ? <Loader2 size={16} className="spin" /> : "Enable auto-continue"}
    </button>
  </ChatSheet>;
}
