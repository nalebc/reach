import { useEffect, useState } from "react";
import { ArrowRight, ChevronRight, Loader2 } from "lucide-react";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import {
  agentLabel,
  moveSession,
  resetTime,
  type AgentHealth,
  type AgentName,
  type AgentSession,
} from "./agent-sessions";
import type { Peer } from "./api";
import "./move-chat.css";

// Continuing a chat with the other agent, as if it had been forked in the
// same app (server: agent-sessions/move.mjs): the other agent gets what this
// one knows so far, and this chat stays as it is. Offered where switching
// feels natural: the agent at the top of a chat, the model picker, and the
// moment one agent runs out of usage.
export const otherAgent = (agent: AgentName): AgentName =>
  agent === "codex" ? "claude" : "codex";

// Why the other agent can't take the chat now ("" when it can).
export function moveBlocked(to: AgentName, health: AgentHealth[], word = "Mac") {
  const h = health.find((x) => x.agent === to);
  const name = agentLabel(to);
  if (!h) return "";
  if (!h.installed) return `${name} isn't installed on your ${word}.`;
  if (!h.signedIn) return `${name} is signed out on your ${word}.`;
  if (h.usable === false)
    return `${name} is out of usage${h.resetsAt ? ` until ${resetTime(h.resetsAt, false)}` : ""}.`;
  return "";
}

// The chat to open once moved (the server fills in the rest when it loads).
export const movedChat = (
  from: AgentSession,
  to: { agent: AgentName; id: string },
): AgentSession => ({
  ...from,
  agent: to.agent,
  id: to.id,
  origin: "reach",
  inApp: false,
  status: "idle",
  held: null,
  live: undefined,
  model: null,
  effort: null,
  mode: null,
  prompts: undefined,
  consent: undefined,
  asking: undefined,
  movedTo: undefined,
  movedFrom: { agent: from.agent, id: from.id, title: from.title },
});

// The hint is shown a few times, never again once a chat has moved.
const HINT = "reach.moveHint";
const hintSeen = () => {
  try {
    return Number(localStorage.getItem(HINT) || 0);
  } catch {
    return 99;
  }
};
const noteHint = (value: number) => {
  try {
    localStorage.setItem(HINT, String(value));
  } catch {
    /* only a hint */
  }
};

// "Continue in Codex": one tap says what happens, the next one moves it.
export function MoveOffer({
  peer,
  session,
  health,
  logos,
  word,
  onMoved,
  variant = "row",
}: {
  peer: Peer;
  session: AgentSession;
  health: AgentHealth[];
  logos: AgentLogos;
  word?: string;
  onMoved: (s: AgentSession) => void;
  variant?: "row" | "picker" | "usage";
}) {
  const to = otherAgent(session.agent);
  const name = agentLabel(to);
  const from = agentLabel(session.agent);
  const blocked = moveBlocked(to, health, word);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const go = async () => {
    setBusy(true);
    setProblem("");
    try {
      const moved = await moveSession(peer, session, to);
      noteHint(99);
      onMoved(movedChat(session, moved));
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  const says = blocked
    ? blocked
    : asking
      ? `${name} continues with what ${from} knows so far; this chat stays as it is.`
      : variant === "usage"
        ? `Keep going: ${name} picks up this chat where it is.`
        : `Fork this chat and keep going with ${name}.`;
  return (
    <div className={`move-offer ${variant}`}>
      <button
        className="move-offer-row"
        disabled={!!blocked || busy}
        aria-expanded={asking}
        onClick={() => (asking ? void go() : setAsking(true))}
      >
        <AgentLogo agent={to} name={name} logos={logos} size={24} />
        <span className="move-offer-text">
          <strong>{busy ? `Moving to ${name}…` : `Continue in ${name}`}</strong>
          <small>{says}</small>
        </span>
        {busy ? (
          <Loader2 size={16} className="spin" />
        ) : asking ? (
          <span className="move-offer-go">Continue</span>
        ) : (
          <ArrowRight size={16} />
        )}
      </button>
      {problem && <small className="move-offer-problem">{problem}</small>}
    </div>
  );
}

// A quiet line under the chat's header, the first few times: where to find it.
export function MoveHint({
  session,
  health,
  logos,
  onOpen,
}: {
  session: AgentSession;
  health: AgentHealth[];
  logos: AgentLogos;
  onOpen: () => void;
}) {
  const to = otherAgent(session.agent);
  const [shown] = useState(() => hintSeen() < 3 && !moveBlocked(to, health) && !session.movedFrom);
  useEffect(() => {
    if (shown) noteHint(hintSeen() + 1);
  }, [shown]);
  if (!shown || !health.some((h) => h.agent === to)) return null;
  return (
    <button className="move-hint" onClick={onOpen}>
      <AgentLogo agent={to} name={agentLabel(to)} logos={logos} size={16} />
      <span>
        New: continue this chat in {agentLabel(to)}, as if forked here
      </span>
      <ChevronRight size={14} />
    </button>
  );
}

// At the end of a chat that was continued elsewhere: the way there.
export function ContinuedIn({
  session,
  logos,
  onOpen,
}: {
  session: AgentSession;
  logos: AgentLogos;
  onOpen: (s: AgentSession) => void;
}) {
  if (!session.movedTo?.length) return null;
  return (
    <div className="move-continued">
      {session.movedTo.map((m) => (
        <button key={`${m.agent}:${m.id}`} onClick={() => onOpen(movedChat(session, m))}>
          <AgentLogo agent={m.agent} name={agentLabel(m.agent)} logos={logos} size={18} />
          <span>Continued in {agentLabel(m.agent)}</span>
          <ChevronRight size={14} />
        </button>
      ))}
    </div>
  );
}
