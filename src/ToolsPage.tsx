import { useState } from "react";
import {
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Check,
  Plus,
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
        ? [
            ...new Set(
              saved.filter(
                (id): id is string =>
                  typeof id === "string" && tools.some((t) => t.id === id),
              ),
            ),
          ]
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
  const move = (id: string, other: string) => {
    setPinned((old) => {
      const from = old.indexOf(id),
        to = old.indexOf(other);
      if (from < 0 || to < 0 || from === to) return old;
      const next = [...old];
      [next[from], next[to]] = [next[to], next[from]];
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        /* This visit still keeps the order. */
      }
      return next;
    });
  };
  return { pinned, toggle, move };
}

type Props = {
  features: WorkspaceCapabilities;
  pinned: string[];
  onNavigate: (id: string) => void;
};

export function PinnedTools({
  features,
  pinned,
  onNavigate,
  onTogglePin,
  onMove,
}: Props & {
  onTogglePin?: (id: string) => void;
  onMove?: (id: string, other: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const available = tools.filter((t) => pageAccessible(t.id, features));
  const shown = pinned.flatMap((id) => available.filter((t) => t.id === id));
  if (!available.length || (!shown.length && !onTogglePin)) return null;
  const choices = [
    ...shown,
    ...available.filter((t) => !pinned.includes(t.id)),
  ];
  return (
    <section className="home-pinned" aria-label="Shortcuts">
      <header>
        <h2>Shortcuts</h2>
        {onTogglePin && (
          <button
            className="shortcuts-edit"
            aria-label={editing ? "Done editing shortcuts" : "Edit shortcuts"}
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Done" : "Edit"}
          </button>
        )}
      </header>
      {editing ? (
        <div className="shortcut-editor">
          {choices.map(({ id, label, icon: Icon }) => {
            const selected = pinned.includes(id),
              index = shown.findIndex((t) => t.id === id);
            const move = (delta: number) => {
              onMove?.(id, shown[index + delta].id);
              setFeedback(`${label} moved ${delta < 0 ? "earlier" : "later"}`);
            };
            return (
              <div className="shortcut-edit-row" key={id}>
                <button
                  className="shortcut-choice"
                  aria-pressed={selected}
                  aria-label={`${selected ? "Remove" : "Add"} ${label} ${selected ? "from" : "to"} Shortcuts`}
                  onClick={() => {
                    onTogglePin?.(id);
                    setFeedback(
                      `${label} ${selected ? "removed from" : "added to"} Shortcuts`,
                    );
                  }}
                >
                  <Icon size={20} aria-hidden="true" />
                  <span>{label}</span>
                  {selected ? (
                    <Check size={18} aria-hidden="true" />
                  ) : (
                    <Plus size={18} aria-hidden="true" />
                  )}
                </button>
                {selected && onMove && (
                  <div className="shortcut-order">
                    <button
                      aria-label={`Move ${label} earlier`}
                      disabled={index === 0}
                      onClick={() => move(-1)}
                    >
                      <ArrowLeft size={17} aria-hidden="true" />
                    </button>
                    <button
                      aria-label={`Move ${label} later`}
                      disabled={index === shown.length - 1}
                      onClick={() => move(1)}
                    >
                      <ArrowRight size={17} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : shown.length ? (
        <div className="shortcut-grid">
          {shown.map(({ id, label, description, icon: Icon }) => (
            <button
              key={id}
              className="shortcut-open"
              onClick={() => onNavigate(id)}
            >
              <Icon size={22} aria-hidden="true" />
              <span>{label}</span>
              <small>{description}</small>
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <button className="shortcuts-add" onClick={() => setEditing(true)}>
          <Plus size={19} aria-hidden="true" />
          Choose your shortcuts
        </button>
      )}
      <p className="shortcuts-feedback" role="status">
        {feedback}
      </p>
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
          <header className="tools-manage-heading">
            <h2>Access</h2>
            <button
              className="tools-invite"
              onClick={() => onNavigate("invite:new")}
            >
              <Plus size={16} aria-hidden="true" />
              Invite
            </button>
          </header>
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
