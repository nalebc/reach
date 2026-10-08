import { useRef, type ReactNode } from "react";
import {
  AppWindow,
  ArrowRight,
  Command,
  Folder,
  Home,
  Lock,
  Monitor,
  RotateCw,
  Search,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import "./agent-workspace-frame.css";

export type AgentSection =
  "home" | "tools" | "screen" | "apps" | "files" | "commands" | "access";
export type AgentDestination = {
  id: AgentSection;
  label: string;
  detail: string;
  available: boolean;
  count?: number;
};
const icons = {
  home: Home,
  tools: Zap,
  screen: Monitor,
  apps: AppWindow,
  files: Folder,
  commands: Terminal,
  access: ShieldCheck,
};
export const sectionTitles: Record<AgentSection, string> = {
  home: "Workspace",
  tools: "Tool library",
  screen: "Live screen",
  apps: "Apps",
  files: "Files",
  commands: "Commands",
  access: "Access",
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
  const buttons = useRef<
    Partial<Record<AgentSection, HTMLButtonElement | null>>
  >({});
  const left = Math.max(0, Math.ceil((expiry - now) / 60000));
  const expired = !standing && expiry <= now;
  const move = (key: string, current: AgentSection) => {
    const enabled = destinations.filter((item) => item.available);
    const index = enabled.findIndex((item) => item.id === current);
    const next =
      key === "Home"
        ? enabled[0]
        : key === "End"
          ? enabled.at(-1)
          : enabled[
              (index +
                (key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1) +
                enabled.length) %
                enabled.length
            ];
    if (next) buttons.current[next.id]?.focus();
  };
  return (
    <main className="agent-workbench" aria-label="Agent workspace">
      <aside className="aw-rail">
        <div className="aw-brand">
          <span>
            <Command size={21} />
          </span>
          <strong>Reach</strong>
          <small>Agent workspace</small>
        </div>
        <div className="aw-device">
          <Monitor size={18} />
          <div>
            <strong>{name}</strong>
            <span>{accessName}</span>
          </div>
        </div>
        <nav aria-label="Workspace navigation" className="aw-nav">
          {destinations.map(({ id, label, detail, available, count }) => {
            const Icon = icons[id];
            return (
              <button
                key={id}
                ref={(button) => {
                  buttons.current[id] = button;
                }}
                type="button"
                aria-current={section === id ? "page" : undefined}
                aria-controls={`agent-section-${id}`}
                disabled={!available}
                title={available ? detail : `${label}: not shared by the owner`}
                onClick={() => navigate(id)}
                onKeyDown={(event) => {
                  if (
                    [
                      "ArrowUp",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "Home",
                      "End",
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    move(event.key, id);
                  }
                }}
              >
                <Icon size={18} />
                <span>{label}</span>
                {available && count !== undefined ? (
                  <small>{count}</small>
                ) : !available ? (
                  <Lock size={13} />
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="aw-rail-note">
          <ShieldCheck size={16} />
          <p>
            The owner sets your access.
            <br />
            Every action checks it again.
          </p>
        </div>
      </aside>
      <div className="aw-main">
        <header className="aw-topbar">
          <div className="aw-breadcrumb">
            {name}
            <span>/</span>
            <strong>{sectionTitles[section]}</strong>
          </div>
          <div className="aw-session" aria-label="Session status">
            <span className={`aw-connected ${expired ? "is-expired" : ""}`}>
              <i />
              {expired ? "Access ended" : "Connected"}
            </span>
            <span>
              {standing ? "Until the owner ends it" : `${left} min left`}
            </span>
            {reload && (
              <button
                type="button"
                onClick={reload}
                aria-label="Reload page"
                title="Reloads this web page. The laptop screen updates automatically."
              >
                <RotateCw size={15} />
              </button>
            )}
          </div>
        </header>
        {activity && (
          <div className="aw-activity" role="status">
            <span className="aw-pulse" />
            <span>{activity}</span>
            <button type="button" onClick={() => navigate("tools")}>
              View in Tools <ArrowRight size={14} />
            </button>
          </div>
        )}
        <div className="aw-content">{children}</div>
      </div>
    </main>
  );
}

export function AgentWorkspaceHome({
  name,
  destinations,
  tools,
  query,
  setQuery,
  findTools,
  navigate,
}: {
  name: string;
  destinations: AgentDestination[];
  tools: boolean;
  query: string;
  setQuery: (value: string) => void;
  findTools: (query: string) => void;
  navigate: (section: AgentSection) => void;
}) {
  return (
    <section
      id="agent-section-home"
      className="aw-home"
      aria-labelledby="aw-home-title"
    >
      <div className="aw-page-heading">
        <p className="aw-eyebrow">YOUR CONNECTED WORKSPACE</p>
        <h1 id="aw-home-title">Ready to work on {name}.</h1>
        <p>
          Choose a tool for a repeat task, or open the resources shared with
          you.
        </p>
      </div>
      {tools && (
        <div className="aw-start">
          <div className="aw-start-icon">
            <Zap size={25} />
          </div>
          <div>
            <p className="aw-eyebrow">START HERE</p>
            <h2>Find a tool. Skip the repeated steps.</h2>
            <p>
              Named tools run a fixed sequence and check the result. Browse the
              library before driving the screen.
            </p>
            <form
              className="aw-home-search"
              onSubmit={(event) => {
                event.preventDefault();
                findTools(query);
              }}
            >
              <Search size={19} />
              <input
                aria-label="Find a tool from workspace"
                placeholder="Search a task, app, or tool name…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="submit">
                Find tools <ArrowRight size={17} />
              </button>
            </form>
            <div className="aw-suggestions">
              <span>Try</span>
              {["Gmail", "Walmart", "attachment", "draft"].map((value) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => findTools(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="aw-section-heading">
        <h2>Your resources</h2>
        <button type="button" onClick={() => navigate("access")}>
          View access <ArrowRight size={14} />
        </button>
      </div>
      <div className="aw-resource-grid">
        {destinations
          .filter(
            (item) => item.available && !["home", "access"].includes(item.id),
          )
          .map((item) => {
            const Icon = icons[item.id];
            return (
              <button
                type="button"
                className="aw-resource"
                key={item.id}
                onClick={() => navigate(item.id)}
              >
                <span className="aw-resource-icon">
                  <Icon size={21} />
                </span>
                <strong>
                  {item.label}
                  {item.count !== undefined && <small>{item.count}</small>}
                </strong>
                <p>{item.detail}</p>
                <span className="aw-resource-open">
                  Open {item.label.toLowerCase()} <ArrowRight size={16} />
                </span>
              </button>
            );
          })}
      </div>
      {!destinations.some(
        (item) => item.available && !["home", "access"].includes(item.id),
      ) && (
        <div className="aw-empty">
          <Lock size={24} />
          <h2>No resources shared yet</h2>
          <p>
            Open Access to see the current invitation. The owner can change what
            is available.
          </p>
        </div>
      )}
      <div className="aw-route-guide">
        <span>
          01 <strong>Check the tools</strong>
        </span>
        <ArrowRight size={15} />
        <span>
          02 <strong>Provide the inputs</strong>
        </span>
        <ArrowRight size={15} />
        <span>
          03 <strong>Inspect the result</strong>
        </span>
      </div>
    </section>
  );
}
