import {
  ArrowUpRight,
  UserRoundPlus,
  Plus,
  Monitor,
  Folder,
  Terminal,
  ShieldCheck,
  ChevronRight,
  MessageSquare,
  Settings,
} from "lucide-react";
import type { WorkspaceCapabilities } from "./capabilities";
import type { Device, Peer, Session, Activity } from "./api";
import { platform } from "./api";
import { AgentAvatar } from "./WorkspaceAtmosphere";
import FleetMesh from "./FleetMesh";
import type { FleetConnections } from "./useFleetConnections";
import ShortcutShelf from "./ShortcutShelf";

const stateLabel = (status: string) =>
  ({
    running: "Working",
    starting: "Starting",
    waiting: "Needs your approval",
    idle: "Ready to continue",
    error: "Needs attention",
    interrupted: "Interrupted",
    exited: "Finished",
  })[status] || status;

export default function WorkspaceHome({
  features,
  device,
  peer,
  onShortcuts,
  connection,
  peers,
  active,
  connections,
  terminals,
  chats,
  activities,
  navigate,
  choose,
  pair,
  session,
  openChat,
  openTerminal,
}: {
  features: WorkspaceCapabilities;
  device: Device;
  peer: Peer;
  onShortcuts: () => void;
  connection: string;
  peers: Peer[];
  active: string;
  connections: FleetConnections;
  terminals: Session[];
  chats: Session[];
  activities: Activity[];
  navigate: (page: string) => void;
  choose: (id: string) => void;
  pair: () => void;
  session: (kind: string) => void;
  openChat: (id: string) => void;
  openTerminal: (id: string) => void;
}) {
  const owner = features.owner;
  const toolCount = [features.files, features.terminal, features.codex].filter(
    Boolean,
  ).length;
  const recent = [
    ...(features.codex ? chats.map((s) => ({ ...s, kind: "chat" })) : []),
    ...(features.terminal
      ? terminals
          .filter((s) => s.status !== "exited")
          .map((s) => ({ ...s, kind: "terminal" }))
      : []),
  ]
    .sort(
      (a, b) =>
        Number(b.status === "waiting") - Number(a.status === "waiting") ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
    .slice(0, 3);
  return (
    <div className="reach-home">
      <header className="reach-home-heading">
        <div>
          <span className="overline">YOUR PLACE, ANYWHERE</span>
          <h1>
            Back in your world<span className="mint-stop">.</span>
          </h1>
        </div>
        {owner ? (
          <button
            className="button secondary home-invite"
            onClick={() => navigate("invite")}
          >
            <UserRoundPlus size={17} />
            Invite
          </button>
        ) : (
          <button
            className="icon-button add-computer"
            aria-label="Add a computer"
            onClick={pair}
          >
            <Plus size={20} />
          </button>
        )}
      </header>
      <FleetMesh
        peers={peers}
        active={active}
        connections={connections}
        choose={choose}
      />
      <section
        className="workspace-constellation fleet-workspace"
        aria-label={device.name}
      >
        <div className="computer-card-top">
          <span className="connection-pill">
            <i className="status-dot" />
            Connected
          </span>
          <span className="computer-transport">
            <ShieldCheck size={13} />
            {connection}
          </span>
        </div>
        <div className="computer-name">
          <span className="overline">{platform(device.platform)}</span>
          <h2>{device.name}</h2>
        </div>
        <div className="constellation-center">
          {(features.screen || features.screenSetup) && (
            <button
              className="button primary open-computer"
              onClick={() => navigate(features.screen ? "screen" : "settings")}
            >
              <Monitor size={17} />
              {features.screen ? "Open screen" : "Set up screen"}
              <ArrowUpRight size={16} />
            </button>
          )}
        </div>
        <div
          className="workspace-tools"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, toolCount)}, minmax(0, 1fr))`,
          }}
        >
          {features.files && (
            <button aria-label="Files" onClick={() => navigate("files")}>
              <span className="tool-symbol files-symbol">
                <Folder size={22} />
              </span>
              <strong>Files</strong>
              <small>Browse & share</small>
            </button>
          )}
          {features.terminal && (
            <button aria-label="Terminals" onClick={() => navigate("terminal")}>
              <span className="tool-symbol terminal-symbol">
                <Terminal size={22} />
              </span>
              <strong>Terminals</strong>
              <small>Continue working</small>
            </button>
          )}
          {features.codex && (
            <button aria-label="Codex" onClick={() => navigate("chat")}>
              <span className="tool-symbol chat-symbol">
                <MessageSquare size={22} />
              </span>
              <strong>Codex</strong>
              <small>Your conversations</small>
            </button>
          )}
        </div>
      </section>
      {features.shortcuts && (
        <ShortcutShelf peer={peer} onManage={onShortcuts} />
      )}
      {(features.terminal || features.codex) && (
        <section className="continue-section">
          <header>
            <h2>Continue your work</h2>
            {features.codex && (
              <button
                className="icon-button"
                aria-label="New conversation"
                onClick={() => session("chat")}
              >
                <Plus size={18} />
              </button>
            )}
          </header>
          {recent.length ? (
            recent.map((item) => (
              <button
                className="continue-row"
                key={`${item.kind}-${item.id}`}
                onClick={() =>
                  item.kind === "chat"
                    ? openChat(item.id)
                    : openTerminal(item.id)
                }
              >
                {item.kind === "chat" ? (
                  <AgentAvatar
                    working={["running", "starting"].includes(item.status)}
                    waiting={item.status === "waiting"}
                  />
                ) : (
                  <span className="continue-terminal">
                    <Terminal size={19} />
                  </span>
                )}
                <span>
                  <strong>{item.name}</strong>
                  <small
                    className={
                      item.status === "waiting" ? "attention-label" : ""
                    }
                  >
                    {item.kind === "terminal" ? "Terminal · " : "Codex · "}
                    {stateLabel(item.status)}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          ) : (
            <div className="workspace-quiet">
              <Terminal size={21} />
              <p>
                No Reach sessions yet.
                <small>
                  Your conversations and Reach terminals will appear here.
                </small>
              </p>
            </div>
          )}
        </section>
      )}
      <details className="workspace-details">
        <summary>
          <span>Computer details & activity</span>
          <ChevronRight size={16} />
        </summary>
        <div className="workspace-details-content">
          <p>
            {platform(device.platform)} · {device.arch}
          </p>
          {features.settings && (
            <button
              className="button secondary small"
              onClick={() => navigate("settings")}
            >
              <Settings size={15} />
              Manage computer
            </button>
          )}
        </div>
        {activities.slice(0, 4).map((a) => (
          <div className="workspace-activity-row" key={a.id}>
            <span>{a.title}</span>
            <time>
              {new Date(a.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        ))}
      </details>
    </div>
  );
}
