import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { request, type Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, projectName, type AgentName, type AgentSession } from "./agent-sessions";

// "@" in the composer: the chat folder's files, as both apps offer them.
// Picking one puts it in the message (what the agent reads it as). Above
// them, chats from any agent on the computer: picking one sends its latest
// exchange with the message (server: agent-sessions/chat-context.mjs).
export default function MentionMenu({
  peer,
  session,
  query,
  onPick,
  chats = [],
  logos = {},
  onPickChat,
}: {
  peer: Peer;
  session: { agent: AgentName; id: string };
  query: string;
  onPick: (path: string) => void;
  chats?: AgentSession[];
  logos?: AgentLogos;
  onPickChat?: (chat: AgentSession) => void;
}) {
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      request<{ files: { path: string; name: string }[] }>(
        peer,
        `/api/sessions/${session.agent}/${encodeURIComponent(session.id)}/files?q=${encodeURIComponent(query)}`,
      )
        .then((r) => live && setFiles((r.files || []).slice(0, 8)))
        .catch(() => live && setFiles([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, session.agent, session.id, peer.url, peer.token]);
  const q = query.trim().toLowerCase();
  // Other chats whose name (or folder) has the words, newest first; a few
  // recent ones for a bare "@".
  const found = onPickChat
    ? chats
        .filter(
          (s) =>
            !s.archived &&
            ["codex", "claude", "gemini"].includes(s.agent) &&
            !(s.agent === session.agent && s.id === session.id) &&
            (!q || [s.title, projectName(s.cwd)].some((t) => t?.toLowerCase().includes(q))),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, q ? 5 : 3)
    : [];
  if (!files.length && !found.length) return null;
  return (
    <ul className="as-mentions" role="listbox" aria-label="Chats and files">
      {found.map((s) => (
        <li key={`${s.agent}:${s.id}`}>
          <button
            role="option"
            aria-selected={false}
            className="as-mention-chat"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPickChat?.(s)}
          >
            <AgentLogo agent={s.agent} logos={logos} size={14} />
            <span className="as-mention-name">{s.title || "Untitled"}</span>
            <small>
              {agentLabel(s.agent)} · {projectName(s.cwd)}
            </small>
          </button>
        </li>
      ))}
      {files.map((f) => (
        <li key={f.path}>
          <button
            role="option"
            aria-selected={false}
            // Keep the keyboard up: the tap mustn't take focus from the box.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(f.path)}
          >
            <FileText size={14} aria-hidden="true" />
            <span className="as-mention-name">{f.name}</span>
            <small>{f.path}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}
