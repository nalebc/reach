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

// Continuing a chat in another app, as if it had been forked in the same app
// and carried on with another agent (server: agent-sessions/move.mjs): the
// other agent gets what this one knows so far, and this chat stays as it is.
// Offered in one place: the chat's ⋯ menu (and an OpenClaw chat's header).

// What a chat needs to be moved: which app and chat it is.
export type MoveSource = { agent: string; id: string; title?: string; cwd?: string };

// The apps Reach chats with, in the order offered.
const APPS = ["codex", "claude", "openclaw"];
// Every other app here that can take the chat.
export const moveTargets = (agent: string, health: AgentHealth[]) =>
  APPS.filter((a) => a !== agent && health.some((h) => h.agent === a && h.installed && h.supported !== false));

// Why an app can't take the chat now ("" when it can).
export function moveBlocked(to: string, health: AgentHealth[], word = "Mac") {
  const h = health.find((x) => x.agent === to);
  const name = agentLabel(to);
  if (!h) return "";
  if (!h.installed) return `${name} isn't installed on your ${word}.`;
  // OpenClaw's own Gateway answers for it when the chat moves, if it can
  // take one (older Gateways can't add the history).
  if (to === "openclaw")
    return h.canTakeMoves === false ? `Update OpenClaw on your ${word} to move chats there.` : "";
  if (!h.signedIn) return `${name} is signed out on your ${word}.`;
  if (h.usable === false)
    return `${name} is out of usage${h.resetsAt ? ` until ${resetTime(h.resetsAt, false)}` : ""}.`;
  return "";
}

// Every other app found on the Mac, in the same order each time: the ones a
// chat can continue in first (Codex, Claude Code, OpenClaw), then the rest by
// name. One that can't take it now says why (it was left out, so OpenClaw on
// an older Gateway and the apps Reach only reads seemed undetected).
export function moveChoices(agent: string, health: AgentHealth[], word = "Mac") {
  const rank = (a: string) => (APPS.includes(a) ? APPS.indexOf(a) : APPS.length);
  return health
    .filter((h) => h.installed && h.agent !== agent)
    .map((h) => {
      const name = h.name || agentLabel(h.agent);
      const blocked = !APPS.includes(h.agent) || h.supported === false
        ? h.agent === "gemini"
          ? `Reach only reads ${name} chats.`
          : `Reach can't continue chats in ${name} yet.`
        : moveBlocked(h.agent, health, word);
      return { to: h.agent, name, blocked };
    })
    .sort((a, b) => rank(a.to) - rank(b.to) || a.name.localeCompare(b.name));
}

// The chat to open once moved (the server fills in the rest when it loads).
export const movedChat = (from: MoveSource, to: { agent: string; id: string }): AgentSession =>
  ({
    agent: to.agent as AgentName,
    id: to.id,
    title: from.title || "",
    cwd: from.cwd || "",
    branch: "",
    origin: "reach",
    inApp: false,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    status: "idle",
    preview: "",
    archived: false,
    held: null,
    movedFrom: { agent: from.agent, id: from.id, title: from.title },
  }) as AgentSession;

// The hint is shown twice at most, never again once tapped or a chat has moved.
const HINT = "reach.moveHint";
const HINT_TIMES = 2;
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
function MoveRow({
  peer,
  session,
  to,
  health,
  logos,
  word,
  onMoved,
  usage,
}: {
  peer: Peer;
  session: MoveSource;
  to: string;
  health: AgentHealth[];
  logos: AgentLogos;
  word?: string;
  onMoved: (s: AgentSession) => void;
  usage: boolean;
}) {
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
      : usage
        ? `Keep going: ${name} picks up this chat where it is.`
        : `Fork this chat and keep going with ${name}.`;
  return (
    <>
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
    </>
  );
}

// One row per app that can take the chat (none: nothing shown).
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
  session: MoveSource;
  health: AgentHealth[];
  logos: AgentLogos;
  word?: string;
  onMoved: (s: AgentSession) => void;
  variant?: "row" | "picker" | "usage";
}) {
  const targets = moveTargets(session.agent, health);
  if (!targets.length) return null;
  return (
    <div className={`move-offer ${variant}`}>
      {targets.map((to) => (
        <MoveRow
          key={to}
          peer={peer}
          session={session}
          to={to}
          health={health}
          logos={logos}
          word={word}
          onMoved={onMoved}
          usage={variant === "usage"}
        />
      ))}
    </div>
  );
}

// In the chat's ⋯ menu: one row per app found on the Mac, with its logo
// (moveChoices). One tap says what happens, the next one moves it; an app
// that can't take the chat shows, greyed, with why.
export function MoveItems({
  peer,
  session,
  health,
  logos,
  word,
  onMoved,
}: {
  peer: Peer;
  session: MoveSource;
  health: AgentHealth[];
  logos: AgentLogos;
  word?: string;
  onMoved: (s: AgentSession) => void;
}) {
  const choices = moveChoices(session.agent, health, word);
  const [asking, setAsking] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  if (!choices.length) return null;
  const from = agentLabel(session.agent);
  const go = async (to: string) => {
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
  return (
    <>
      {choices.map(({ to, name, blocked }) => {
        const here = asking === to;
        if (blocked)
          return (
            <button key={to} role="menuitem" className="move-item blocked" disabled aria-disabled="true">
              <AgentLogo agent={to} name={name} logos={logos} size={20} />
              <span className="move-item-text">
                <span>Continue in {name}</span>
                <small>{blocked}</small>
              </span>
            </button>
          );
        return (
          <button
            key={to}
            role="menuitem"
            className={`move-item ${here ? "asking" : ""}`}
            disabled={busy}
            onClick={() => (here ? void go(to) : setAsking(to))}
          >
            <AgentLogo agent={to} name={name} logos={logos} size={20} />
            <span className="move-item-text">
              <span>{here ? name : `Continue in ${name}`}</span>
              <small>
                {here && problem
                  ? problem
                  : here
                    ? `gets what ${from} knows so far`
                    : "Picks up from here; this chat stays"}
              </small>
            </span>
            {busy && here ? (
              <Loader2 size={16} className="spin" />
            ) : here ? (
              <span className="move-item-go">Continue</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

// A quiet line under the chat's header, twice at most; a tap opens ⋯.
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
  const targets = moveTargets(session.agent, health).filter((t) => !moveBlocked(t, health));
  const [shown] = useState(() => hintSeen() < HINT_TIMES && !session.movedFrom);
  const show = shown && targets.length > 0;
  useEffect(() => {
    if (show) noteHint(hintSeen() + 1);
  }, [show]);
  if (!show) return null;
  const to = targets[0];
  const where = targets.length === 1 ? agentLabel(to) : "another app";
  return (
    <button
      className="move-hint"
      onClick={() => {
        noteHint(99);
        onOpen();
      }}
    >
      <AgentLogo agent={to} name={agentLabel(to)} logos={logos} size={16} />
      <span>New: continue this chat in {where}</span>
      <ChevronRight size={14} />
    </button>
  );
}

// Where a chat was continued elsewhere: the way there (`moves`: the ones
// that go at this point of the chat; all of them by default).
export function ContinuedIn({
  session,
  moves = session.movedTo,
  logos,
  onOpen,
}: {
  session: AgentSession;
  moves?: AgentSession["movedTo"];
  logos: AgentLogos;
  onOpen: (s: AgentSession) => void;
}) {
  if (!moves?.length) return null;
  return (
    <div className="move-continued">
      {moves.map((m) => (
        <button key={`${m.agent}:${m.id}`} onClick={() => onOpen(movedChat(session, m))}>
          <AgentLogo agent={m.agent} name={agentLabel(m.agent)} logos={logos} size={18} />
          <span>Continued in {agentLabel(m.agent)}</span>
          <ChevronRight size={14} />
        </button>
      ))}
    </div>
  );
}
