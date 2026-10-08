import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { request, type Peer } from "./api";
import type { AgentName } from "./agent-sessions";

// "@" in the composer: the chat folder's files, as both apps offer them.
// Picking one puts it in the message (what the agent reads it as).
export default function MentionMenu({
  peer,
  session,
  query,
  onPick,
}: {
  peer: Peer;
  session: { agent: AgentName; id: string };
  query: string;
  onPick: (path: string) => void;
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
  if (!files.length) return null;
  return (
    <ul className="as-mentions" role="listbox" aria-label="Files">
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
