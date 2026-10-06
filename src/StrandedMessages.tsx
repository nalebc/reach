import { useEffect, useState } from "react";
import { CornerUpRight, X } from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import {
  agentLabel,
  cancelQueuedMessage,
  readStranded,
  sendStranded,
  type AgentSession,
  type StrandedMessage,
} from "./agent-sessions";
import "./stranded-messages.css";

// Messages sent from the phone whose chat was deleted before they went in:
// they never go anywhere by themselves. Each says so, and goes to another
// chat (picked inline from the recent ones) or is deleted.
export default function StrandedMessages({
  peer,
  sessions,
  logos,
  onChanged,
}: {
  peer: Peer;
  sessions: AgentSession[] | null;
  logos: AgentLogos;
  onChanged?: () => void;
}) {
  const [messages, setMessages] = useState<StrandedMessage[]>([]);
  const [picking, setPicking] = useState("");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  // Read again whenever the chat list changes (a chat deleted, a message sent).
  useEffect(() => {
    let alive = true;
    readStranded(peer)
      .then((r) => alive && setMessages(r.messages || []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [peer, sessions]);
  if (!messages.length) return null;
  const recent = (sessions || [])
    .filter((s) => !s.archived && s.agent !== "gemini")
    .slice(0, 6);
  const act = async (m: StrandedMessage, work: () => Promise<unknown>) => {
    setBusy(m.id);
    setProblem("");
    try {
      await work();
      setMessages((list) => list.filter((x) => x.id !== m.id));
      setPicking("");
      onChanged?.();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="stranded" aria-label="Messages whose chat was deleted">
      {messages.map((m) => (
        <div key={m.id} className="stranded-item">
          <div className="stranded-row">
            <div className="stranded-text">
              <strong>{m.text || (m.images === 1 ? "A picture" : `${m.images} pictures`)}</strong>
              <small>From your phone · its chat was deleted</small>
            </div>
            <button
              className="stranded-send"
              aria-expanded={picking === m.id}
              disabled={busy === m.id}
              onClick={() => setPicking(picking === m.id ? "" : m.id)}
            >
              <CornerUpRight size={16} aria-hidden="true" /> Send to…
            </button>
            <button
              className="stranded-delete"
              aria-label="Delete this message"
              disabled={busy === m.id}
              onClick={() => act(m, () => cancelQueuedMessage(peer, { agent: "claude", id: m.session }, m.id))}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
          {picking === m.id && (
            <div className="stranded-pick" role="list" aria-label="Send to a chat">
              {recent.length ? (
                recent.map((s) => (
                  <button
                    key={`${s.agent}:${s.id}`}
                    role="listitem"
                    disabled={busy === m.id}
                    onClick={() => act(m, () => sendStranded(peer, m.id, { agent: s.agent, id: s.id }))}
                  >
                    <AgentLogo agent={s.agent} logos={logos} size={20} />
                    <span className="stranded-pick-title">{s.title || "Untitled"}</span>
                    <small>{agentLabel(s.agent)}</small>
                  </button>
                ))
              ) : (
                <p>No other chats yet.</p>
              )}
            </div>
          )}
        </div>
      ))}
      {problem && (
        <p className="stranded-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
