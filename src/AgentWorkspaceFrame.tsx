import { useEffect, useRef, type ReactNode } from "react";
import {
  AppWindow,
  ArrowRight,
  ChevronDown,
  Folder,
  Lock,
  Monitor,
  RotateCw,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import "./agent-workspace-frame.css";

export type AgentSection =
  "tools" | "screen" | "apps" | "files" | "commands" | "access";
export type AgentDestination = {
  id: AgentSection;
  label: string;
  detail: string;
  available: boolean;
  count?: number;
};
// What an agent uses: the screen, and the terminal. Everything else waits
// under More.
const PRIMARY: AgentSection[] = ["screen", "commands"];
const icons = {
  tools: Zap,
  screen: Monitor,
  apps: AppWindow,
  files: Folder,
  commands: Terminal,
  access: ShieldCheck,
};

export default function AgentWorkspaceFrame({
  name,
  accessName,
  expiry,
  standing,
  now,
  destinations,
  section,
  navigate,
  activity,
  reload,
  children,
}: {
  name: string;
  accessName: string;
  expiry: number;
  standing?: boolean;
  now: number;
  destinations: AgentDestination[];
  section: AgentSection;
  navigate: (section: AgentSection) => void;
  activity?: string;
  reload?: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const left = Math.max(0, Math.ceil((expiry - now) / 60000));
  const expired = !standing && expiry <= now;
  const secondary = destinations.filter(
    (item) => !PRIMARY.includes(item.id),
  );
  const current = secondary.find((item) => item.id === section);
  const open = (id: AgentSection) => {
    navigate(id);
    if (menu.current) menu.current.open = false;
  };
  const destination = ({ id, label, detail, available }: AgentDestination) => {
    const Icon = icons[id];
    return (
      <button
        key={id}
        type="button"
        id={`agent-nav-${id}`}
        aria-label={label}
        aria-current={section === id ? "page" : undefined}
        aria-controls={`agent-section-${id}`}
        disabled={!available}
        title={available ? detail : `${label}: not shared by the owner`}
        onClick={() => open(id)}
      >
        <Icon size={16} /> <span>{label}</span>
        {!available && <Lock size={12} />}
      </button>
    );
  };
  return (
    <main className="agent-workbench" aria-label="Agent workspace">
      <header className="aw-header">
        <div className="aw-header-inner">
          <div className="aw-device">
            <Monitor size={18} />
            <strong title={name}>{name}</strong>
            <span
              className={`aw-session ${expired ? "is-expired" : ""}`}
              aria-label="Session status"
              title={`${accessName} · ${expired ? "Access ended" : standing ? "Until the owner ends it" : `${left} min left`}`}
            >
              <i /> {expired ? "Ended" : standing ? "Guest" : `${left} min`}
            </span>
          </div>
          <nav aria-label="Workspace navigation" className="aw-nav">
            {destinations
              .filter((item) => PRIMARY.includes(item.id))
              .map(destination)}
            <details
              className="aw-more"
              ref={menu}
              onKeyDown={(event) => {
                if (event.key === "Escape" && menu.current) {
                  menu.current.open = false;
                  menu.current.querySelector<HTMLElement>("summary")?.focus();
                }
              }}
            >
              <summary
                aria-label="More workspace sections"
                className={current ? "is-current" : ""}
              >
                {current?.label || "More"} <ChevronDown size={14} />
              </summary>
              <div className="aw-menu">
                {secondary.map(destination)}
                {reload && (
                  <button
                    type="button"
                    onClick={() => {
                      if (menu.current) menu.current.open = false;
                      reload();
                    }}
                    aria-label="Reload page"
                    title="Reloads this web page. The laptop screen updates automatically."
                  >
                    <RotateCw size={16} /> Reload page
                  </button>
                )}
              </div>
            </details>
          </nav>
        </div>
      </header>
      {activity && section !== "tools" && (
        <div className="aw-activity" role="status">
          <span className="aw-pulse" /> <span>{activity}</span>
          <button type="button" onClick={() => navigate("tools")}>
            View in Tools <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="aw-content">{children}</div>
    </main>
  );
}
