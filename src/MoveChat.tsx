import { useEffect, useState } from "react";
import { GitFork, ChevronLeft, ChevronRight, LoaderCircle, MessageSquare, Ellipsis } from "lucide-react";
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
import { anchorOf, ChatPopover, type Anchor } from "./ChatPopover";
import "./move-chat.css";

// Continuing a chat in another app, as if it had been forked in the same app
// and carried on with another agent (server: agent-sessions/move.mjs): the
// other agent gets what this one knows so far, and this chat stays as it is.
// Offered in the chat's ⋯ menu (and an OpenClaw chat's header), and for a
// whole folder at once next to its name on the Chats list.

// What a chat needs to be moved: which app and chat it is.
export type MoveSource = { agent: string; id: string; title?: string; cwd?: string; through?: string };

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
  // Older than Reach works with (OpenClaw's Gateway too).
  if (h.tooOld) return `Update ${name} to ${h.tooOld.to} or newer to move chats there.`;
  if (h.needs?.includes("git")) return `${name} needs Git for Windows on your ${word}.`;
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

// Same-app forks belong in the same picker as cross-app continuations.
export function forkChoices(agent: string, health: AgentHealth[], word = "Mac") {
  const choices = moveChoices(agent, health, word);
  if (APPS.includes(agent)) choices.push({ to: agent, name: agentLabel(agent), blocked: moveBlocked(agent, health, word) });
  return choices;
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

// A single entry in the chat menu, then the destination picker. The second
// tap confirms the destination after explaining what its fork preserves.
export function MoveItems({
  peer,
  session,
  health,
  logos,
  word,
  open,
  onOpen,
  onBack,
  onMoved,
}: {
  peer: Peer;
  session: MoveSource;
  health: AgentHealth[];
  logos: AgentLogos;
  word?: string;
  open: boolean;
  onOpen: () => void;
  onBack: () => void;
  onMoved: (s: AgentSession) => void;
}) {
  const choices = forkChoices(session.agent, health, word);
  const [asking, setAsking] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // Back out and in again: no app is left one tap from moving the chat.
  useEffect(() => {
    if (!open) (setAsking(""), setProblem(""));
  }, [open]);
  useEffect(() => { setAsking(""); setProblem(""); }, [session.id, session.agent, session.through]);
  if (!choices.length) return null;
  const go = async (to: string) => {
    setBusy(true);
    setProblem("");
    try {
      const moved = await moveSession(peer, session, to, { fork: true, through: session.through });
      onMoved(movedChat(session, moved));
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button role="menuitem" className="move-item move-continue" onClick={onOpen}>
        <GitFork size={18} />
        <span className="move-item-text">
          <span>Fork chat…</span>
        </span>
        <ChevronRight size={16} />
      </button>
    );
  return (
    <>
      <button role="menuitem" className="move-item move-section-back" disabled={busy} onClick={onBack}>
        <ChevronLeft size={16} />
        <span className="move-item-text">
          <span>Fork chat</span>
        </span>
      </button>
      <p className="fork-explanation">{session.through ? "Continue from the selected message." : "Continue from the latest message."} The original chat stays here.</p>
      {choices.map(({ to, name, blocked }) => {
        const here = asking === to;
        if (blocked)
          return (
            <button key={to} role="menuitem" className="move-item blocked" disabled aria-disabled="true">
              <AgentLogo agent={to} name={name} logos={logos} size={20} />
              <span className="move-item-text">
                <span>{name}</span>
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
            onClick={() => (here ? void go(to) : (setAsking(to), setProblem("")))}
          >
            <AgentLogo agent={to} name={name} logos={logos} size={20} />
            <span className="move-item-text">
              <span>{name}</span>
              {here && <small>{problem || (to === session.agent && to !== "openclaw" ? "Keeps the native chat context and settings" : "Copies the conversation and tool output; uses this app’s model, tools and permissions")}</small>}
            </span>
            {busy && here ? (
              <LoaderCircle size={16} className="spin" />
            ) : here ? (
              <span className="move-item-go">Fork</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

// Chats a section already sent to an app ("claude:id>codex"), so moving the
// section again (or a double tap) doesn't make the same chat twice. The list
// doesn't say where chats went (only a chat's own page does).
const SENT = "reach.sectionMoved";
const sentKeys = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SENT) || "[]");
  } catch {
    return [];
  }
};
const noteSent = (key: string) => {
  try {
    localStorage.setItem(SENT, JSON.stringify([...sentKeys(), key].slice(-500)));
  } catch {
    /* the server still has each move */
  }
};
const sentKey = (s: MoveSource, to: string) => `${s.agent}:${s.id}>${to}`;
// The chats of a section that an app hasn't had yet.
export const sectionToMove = (chats: AgentSession[], to: string) => {
  const sent = new Set(sentKeys());
  return chats.filter((s) => !s.movedTo?.some((m) => m.agent === to) && !sent.has(sentKey(s, to)));
};

// From the ⋯ next to a folder's name on the Chats list, said plainly either
// way: "Move project reach to Codex" (every chat in it, one after the
// other) or "Move one chat…" (pick it, then the app). The same move as one
// chat's ⋯: every chat here stays as it is. One tap says what goes, the next
// one moves it; then that app's list (a project) or the new chat (one) shows.
export function MoveSection({
  peer,
  name,
  chats,
  health,
  logos,
  word,
  onMoved,
  onOpen,
}: {
  peer: Peer;
  name: string;
  chats: AgentSession[];
  health: AgentHealth[];
  logos: AgentLogos;
  word?: string;
  onMoved: (to: string) => void;
  onOpen: (s: AgentSession) => void;
}) {
  const [open, setOpen] = useState<Anchor | null>(null);
  // "": the whole project; "pick": choosing a chat; else that chat's id.
  const [step, setStep] = useState("");
  const [asking, setAsking] = useState("");
  const [done, setDone] = useState(-1);
  const [problem, setProblem] = useState("");
  const agent = chats[0]?.agent || "";
  const choices = moveChoices(agent, health, word);
  if (!chats.length || !choices.length) return null;
  const busy = done >= 0;
  const one = chats.find((s) => s.id === step);
  const go = (next: string) => {
    setStep(next);
    setAsking("");
    setProblem("");
  };
  const moveProject = async (to: string) => {
    const list = sectionToMove(chats, to);
    setProblem("");
    let failed = 0;
    for (const [i, s] of list.entries()) {
      setDone(i);
      try {
        await moveSession(peer, s, to);
        noteSent(sentKey(s, to));
      } catch {
        failed++;
      }
    }
    setDone(-1);
    if (failed) {
      setProblem(`${failed} of ${list.length} didn't move. Try again to move just ${failed === 1 ? "that one" : "those"}.`);
      return;
    }
    setOpen(null);
    go("");
    onMoved(to);
  };
  const moveOne = async (s: AgentSession, to: string) => {
    setProblem("");
    setDone(0);
    try {
      const moved = await moveSession(peer, s, to);
      noteSent(sentKey(s, to));
      setDone(-1);
      setOpen(null);
      go("");
      onOpen(movedChat(s, moved));
    } catch (e) {
      setDone(-1);
      setProblem((e as Error).message);
    }
  };
  const chatsWord = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;
  const title = (s: AgentSession) => s.title?.trim() || "New chat";
  // One row per app: what goes there, greyed with why when it can't.
  const appRow = (to: string, app: string, blocked: string, what: string, left: number, note: string, move: () => void) => {
    const here = asking === to;
    const why = blocked || (left ? "" : `Already in ${app}.`);
    if (why)
      return (
        <button key={to} role="menuitem" className="move-item blocked" disabled aria-disabled="true">
          <AgentLogo agent={to} name={app} logos={logos} size={20} />
          <span className="move-item-text">
            <span>Move {what} to {app}</span>
            <small>{why}</small>
          </span>
        </button>
      );
    return (
      <button
        key={to}
        role="menuitem"
        className={`move-item ${here ? "asking" : ""}`}
        disabled={busy}
        onClick={() => (here ? move() : (setAsking(to), setProblem("")))}
      >
        <AgentLogo agent={to} name={app} logos={logos} size={20} />
        <span className="move-item-text">
          <span>{busy && here ? (left > 1 ? `Moving ${done + 1} of ${left}…` : "Moving…") : `Move ${what} to ${app}`}</span>
          <small>{here && problem ? problem : note}</small>
        </span>
        {busy && here ? <LoaderCircle size={16} className="spin" /> : here ? <span className="move-item-go">Move</span> : null}
      </button>
    );
  };
  return (
    <>
      <button
        className="move-section-open"
        aria-label={`Move project ${name} or one of its chats to another app`}
        aria-expanded={!!open}
        disabled={busy}
        onClick={(e) => {
          setOpen(open ? null : anchorOf(e.currentTarget));
          go("");
        }}
      >
        <Ellipsis size={16} />
      </button>
      {open && (
        // Stays while chats move, so the count shows.
        <ChatPopover anchor={open} label={`Move from ${name}`} onClose={() => !busy && setOpen(null)}>
          {step === "" ? (
            <>
              {choices.map(({ to, name: app, blocked }) => {
                const left = blocked ? 0 : sectionToMove(chats, to).length;
                return appRow(
                  to,
                  app,
                  blocked,
                  `project ${name}`,
                  left,
                  asking === to
                    ? `${chatsWord(left)} pick up where they are in ${app}; ${name} keeps its chats here`
                    : `The whole folder: ${chatsWord(left)}`,
                  () => void moveProject(to),
                );
              })}
              <button role="menuitem" className="move-item" disabled={busy} onClick={() => go("pick")}>
                <MessageSquare size={18} />
                <span className="move-item-text">
                  <span>Move one chat…</span>
                  <small>Pick a chat from {name}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            </>
          ) : step === "pick" || !one ? (
            <>
              <button role="menuitem" className="move-item move-section-back" onClick={() => go("")}>
                <ChevronLeft size={16} />
                <span className="move-item-text">
                  <span>Which chat?</span>
                </span>
              </button>
              {chats.map((s) => (
                <button key={s.id} role="menuitem" className="move-item" onClick={() => go(s.id)}>
                  <span className="move-item-text">
                    <span>{title(s)}</span>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </>
          ) : (
            <>
              <button role="menuitem" className="move-item move-section-back" disabled={busy} onClick={() => go("pick")}>
                <ChevronLeft size={16} />
                <span className="move-item-text">
                  <span>{title(one)}</span>
                </span>
              </button>
              {choices.map(({ to, name: app, blocked }) =>
                appRow(to, app, blocked, "this chat", 1, asking === to ? `gets what ${agentLabel(agent)} knows so far` : "Picks up from here; this chat stays", () => void moveOne(one, to)),
              )}
            </>
          )}
        </ChatPopover>
      )}
    </>
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
          <span>{m.fork ? "Forked in" : "Continued in"} {agentLabel(m.agent)}</span>
          <ChevronRight size={14} />
        </button>
      ))}
    </div>
  );
}
