import { useState } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  Folder,
  MessageCircle,
  Pin,
  SquareTerminal,
  UsersRound,
} from "lucide-react";
import { pageAccessible, type WorkspaceCapabilities } from "./capabilities";
import "./tools-page.css";

const tools = [
  {
    id: "files",
    label: "Files",
    description: "Browse, open, and move your files.",
    icon: Folder,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Continue a session or start a new one.",
    icon: SquareTerminal,
  },
  {
    id: "sessions",
    label: "Chat",
    description: "Talk to your agents and follow their work.",
    icon: MessageCircle,
  },
];
const PIN_KEY = "reach.pinnedTools";

// Preferences stay on this client. Access is checked again on every render,
// including when the selected computer or its invitation changes.
export function usePinnedTools() {
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
      return Array.isArray(saved)
        ? tools.filter((t) => saved.includes(t.id)).map((t) => t.id)
        : [];
    } catch {
      return [];
    }
  });
  const toggle = (id: string) => {
    if (!tools.some((t) => t.id === id)) return;
    setPinned((old) => {
      const next = old.includes(id)
        ? old.filter((p) => p !== id)
        : [...old, id];
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        /* Keep it for this visit. */
      }
      return next;
    });
  };
  return { pinned, toggle };
}

type Props = {
  features: WorkspaceCapabilities;
  pinned: string[];
  onNavigate: (id: string) => void;
};

export function PinnedTools({ features, pinned, onNavigate }: Props) {
  const shown = tools.filter(
    (t) => pinned.includes(t.id) && pageAccessible(t.id, features),
  );
  if (!shown.length) return null;
  return (
    <section className="home-pinned" aria-label="Pinned tools">
      <h2>Pinned</h2>
      <div>
        {shown.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => onNavigate(id)}>
            <Icon size={19} aria-hidden="true" />
            <span>{label}</span>
            <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

export default function ToolsPage({
  features,
  pinned,
  onNavigate,
  onTogglePin,
  waiting = 0,
}: Props & {
  onTogglePin: (id: string) => void;
  waiting?: number;
}) {
  const [feedback, setFeedback] = useState("");
  const shown = tools.filter((t) => pageAccessible(t.id, features));
  return (
    <section className="tools-page" aria-labelledby="tools-title">
      <header>
        <h1 id="tools-title">Tools</h1>
        <p>Your computer, ready for what you need.</p>
      </header>
      {shown.length ? (
        <>
          <div className="tools-list">
            {shown.map(({ id, label, description, icon: Icon }) => (
              <div className="tool-row" key={id}>
                <button
                  className="tool-open"
                  aria-label={label}
                  onClick={() => onNavigate(id)}
                >
                  <span className="tool-icon">
                    <Icon size={23} aria-hidden="true" />
                  </span>
                  <span className="tool-copy">
                    <strong>{label}</strong>
                    <small>
                      {id === "sessions" && waiting
                        ? `${waiting} ${waiting === 1 ? "conversation needs" : "conversations need"} you`
                        : description}
                    </small>
                  </span>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
                <button
                  className="tool-pin"
                  aria-label={`${pinned.includes(id) ? "Unpin" : "Pin"} ${label}${pinned.includes(id) ? " from" : " to"} Home`}
                  aria-pressed={pinned.includes(id)}
                  onClick={() => {
                    onTogglePin(id);
                    setFeedback(
                      `${label} ${pinned.includes(id) ? "removed from" : "pinned to"} Home`,
                    );
                  }}
                >
                  <Pin size={18} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          <p className="tools-pin-hint">Pin the tools you use most to Home.</p>
          <p className="tools-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
        </>
      ) : (
        <p className="tools-empty">
          No additional tools are available with your access to this computer.
        </p>
      )}
      {features.invite && (
        <div className="tools-manage">
          <h2>Access</h2>
          <button
            className="tool-open"
            onClick={() => onNavigate("invite")}
            aria-label="Agents & people"
          >
            <span className="tool-icon">
              <UsersRound size={22} aria-hidden="true" />
            </span>
            <span className="tool-copy">
              <strong>Agents & people</strong>
              <small>Manage who can use this computer.</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
