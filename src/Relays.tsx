import { useMemo, useState } from "react";
import { Check, Info, Loader2, Plus, SearchCheck, Workflow, X } from "lucide-react";
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
  ["codex", "claude", ...(openclaw ? ["openclaw"] : [])].filter((a) => health.some((h) => h.agent === a && h.installed && h.signedIn && h.usable !== false));
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
  const before = chain[n - 1]?.agent || (n >= 2 ? steps[n - 2]?.agent || steps[n - 2]?.to?.agent : chain[0]?.agent);
  return `the review goes back to ${before ? agentLabel(before) : "the builder"}`;
}

// Where a relay stands, seen from one of its chats.
export function relayLine(relay: Relay, here: ChatRef) {
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
  if (relay.state === "sending") return `Relaying to ${agentLabel(relay.steps[relay.next]?.agent || relay.steps[relay.next]?.to?.agent || "")}…`;
  if (relay.state === "done") return `Relayed: ${relay.steps.map((s, i) => stepWords(s, relay.chain, i, relay.steps)).join(", then ")}`;
  return relay.problem || "This relay stopped.";
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
    <div className="relay-strip" role="group" aria-label="Relays">
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
            {elsewhere && r.state !== "stopped" && (
              <button className="relay-row-action" onClick={() => onOpen(at)}>
                Open
              </button>
            )}
            {r.state === "waiting" && (
              <button className="relay-row-action" disabled={busy === r.id} aria-label="Cancel relay" onClick={() => void cancel(r)}>
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
  health,
  logos,
  onClose,
  onStarted,
}: {
  peer: Peer;
  session: AgentSession;
  item?: string;
  health: AgentHealth[];
  logos: AgentLogos;
  onClose: () => void;
  onStarted: (started: RelayStarted) => void;
}) {
  const agents = othersFirst(session.agent, relayAgents(health));
  const [reviewer, setReviewer] = useState(agents[0] || "");
  const canReturn = session.agent === "codex" || session.agent === "claude";
  const [back, setBack] = useState(canReturn);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const from = agentLabel(session.agent);
  const ask = async () => {
    setBusy(true);
    setProblem("");
    try {
      const steps: RelayStep[] = [{ kind: "review", agent: reviewer }, ...(back ? [{ kind: "back" as const }] : [])];
      onStarted(await startRelay(peer, { from: { agent: session.agent, id: session.id }, steps, now: true, ...(item ? { item } : {}) }));
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
    <ChatSheet title="Second opinion" className="relay-sheet reach-native" onClose={onClose}>
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
            {reviewer === session.agent ? `A new ${from} chat` : agentLabel(reviewer)} reads what {from} was asked, its reply and the files it
            changed. It reads only, and asks you before anything more.
          </p>
          {agents.length > 1 && <p className="relay-hint">Tap the reviewer to switch.</p>}
          {canReturn && (
            <label className="relay-switch">
              <input type="checkbox" role="switch" checked={back} disabled={busy} onChange={(e) => setBack(e.target.checked)} />
              <span>Send the review back here</span>
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
const VERB: Record<RelayStep["kind"], string> = { build: "builds", review: "reviews", back: "fixes", send: "gets it" };
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
// The relay in one sentence.
export function relaySentence(steps: RelayStep[], from: string, to?: AgentSession | null) {
  const name = (a: string) => agentLabel(a);
  return (
    steps
      .map((s, i) => {
        const who = name(stepAgent(steps, i, from));
        if (s.kind === "build") return i === 0 ? `${who} builds what ${name(from)} wrote, in a new chat here` : `${who} builds it`;
        if (s.kind === "review") return i === 0 ? `${who} reviews it, changing nothing` : `then ${who} reviews the work`;
        if (s.kind === "back") return i === 1 ? `and the review comes back here` : `then ${who} fixes what the review found`;
        return `it goes into “${to?.title || "the chat you pick"}”`;
      })
      .join(", ") + "."
  );
}

// "Relay": what happens when this chat's agent finishes (or, when it already
// has, to its reply now). The route shows it; one sentence says it.
export function RelaySheet({
  peer,
  session,
  working,
  hasReply,
  sessions,
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
  health: AgentHealth[];
  logos: AgentLogos;
  onClose: () => void;
  onStarted: (started: RelayStarted) => void;
}) {
  const agents = relayAgents(health);
  const from = session.agent;
  const first = othersFirst(from, agents)[0];
  const [steps, setSteps] = useState<RelayStep[]>(first ? [{ kind: "build", agent: first }] : []);
  const [picked, setPicked] = useState(-1);
  const [to, setTo] = useState<AgentSession | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [when, setWhen] = useState<"now" | "next">(working || !hasReply ? "next" : "now");
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
    if (!step) setPicked(-1);
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
      onStarted(await startRelay(peer, { from: { agent: from, id: session.id }, steps: out, now: when === "now" }));
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  const nodes: RouteNode[] = [
    { key: "from", agent: from, label: working ? "now" : "this chat", dim: true },
    ...steps.map((s, i) => ({
      key: `${i}:${s.kind}`,
      agent: s.kind === "send" ? to?.agent || from : stepAgent(steps, i, from),
      label: VERB[s.kind],
      ...(s.kind === "send" && !to ? { icon: "chat" as const } : {}),
    })),
  ];
  const step = picked > 0 ? steps[picked - 1] : null;
  return (
    <ChatSheet title="Relay" className="relay-sheet reach-native" onClose={onClose}>
      <p className="relay-when-line">{working ? `When ${agentLabel(from)} finishes` : hasReply ? `${agentLabel(from)}’s reply` : `When ${agentLabel(from)} next replies`}</p>
      {agents.length ? (
        <>
          <Route
            nodes={nodes}
            logos={logos}
            selected={picked}
            onSelect={(i) => setPicked(picked === i ? -1 : i)}
            {...(suggestion ? { add: { label: `Add: ${agentLabel(stepAgent([...steps, suggestion], steps.length, from))} ${VERB[suggestion.kind]}`, onAdd: () => setSteps([...steps, suggestion]) } } : {})}
          />
          {step && (
            // The picked tile: who does it and what, or gone.
            <div className="relay-edit" role="group" aria-label="Change this step">
              {step.kind !== "back" &&
                step.kind !== "send" &&
                agents.map((a) => (
                  <button key={a} aria-pressed={step.agent === a} onClick={() => change(picked - 1, { ...step, agent: a })}>
                    <AgentLogo agent={a} logos={logos} size={16} /> {agentLabel(a)}
                  </button>
                ))}
              {(picked === 1 ? ["build", "review", "send"] : steps[picked - 2]?.kind === "review" ? ["back", "build", "review"] : ["build", "review"]).map((kind) => (
                <button
                  key={kind}
                  aria-pressed={step.kind === kind}
                  onClick={() =>
                    change(
                      picked - 1,
                      kind === "back" || kind === "send" ? { kind: kind as RelayStep["kind"] } : { kind: kind as RelayStep["kind"], agent: step.agent || first },
                    )
                  }
                >
                  {kind === "send" ? "to a chat…" : VERB[kind as RelayStep["kind"]]}
                </button>
              ))}
              <button className="relay-remove" onClick={() => change(picked - 1, null)}>
                Remove
              </button>
            </div>
          )}
          {sending && (
            <div className="relay-chats" role="listbox" aria-label="Chats">
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
                    <small>{projectName(s.cwd)}</small>
                  </button>
                ))
              ) : (
                <p className="relay-say">No other Codex or Claude Code chats yet.</p>
              )}
            </div>
          )}
          {steps.length > 0 && <p className="relay-say">{relaySentence(steps, from, to)}</p>}
          <div className="relay-extras">
            {note === null ? (
              <button onClick={() => setNote("")}>
                <Plus size={13} /> Note
              </button>
            ) : (
              <input
                className="relay-instructions"
                aria-label="Note for the next agent"
                placeholder={sending ? "A note with it" : `What ${agentLabel(stepAgent(steps, 0, from))} should build`}
                value={note}
                maxLength={2000}
                disabled={busy}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </div>
          {!working && hasReply && (
            <div className="relay-when" role="radiogroup" aria-label="When">
              <button role="radio" aria-checked={when === "now"} disabled={busy} onClick={() => setWhen("now")}>
                Its reply now
              </button>
              <button role="radio" aria-checked={when === "next"} disabled={busy} onClick={() => setWhen("next")}>
                After its next reply
              </button>
            </div>
          )}
          <Rules />
          {problem && <p className="relay-problem" role="alert">{problem}</p>}
          <button className="relay-go" disabled={!ready || busy} onClick={() => void go()}>
            {busy ? <Loader2 size={16} className="spin" /> : when === "now" && !working && hasReply ? "Relay now" : "Start relay"}
          </button>
        </>
      ) : (
        <p className="relay-say">Sign in to Codex or Claude Code on your computer to relay this chat.</p>
      )}
    </ChatSheet>
  );
}

// The button by a reply that asks for a second opinion.
export function SecondOpinionButton({ onClick, labelled = false }: { onClick: () => void; labelled?: boolean }) {
  return labelled ? (
    <button className="relay-opinion" aria-label="Second opinion" onClick={onClick}>
      <SearchCheck size={17} /> <span>Second opinion</span>
    </button>
  ) : (
    <button className="as-icon" aria-label="Second opinion" onClick={onClick}>
      <SearchCheck size={15} />
    </button>
  );
}
