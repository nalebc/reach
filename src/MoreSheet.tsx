import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  LayoutGrid,
  MessageSquare,
  Plus,
  Settings,
  ShieldCheck,
  UserRoundPlus,
  X,
} from "lucide-react";
import ScreenPopup from "./ScreenPopup";
import { BrandCourier } from "./ReachIdentity";
import { AppIcon, ComputerIcon } from "./AppIcon";
import { AgentLogo, useAgentLogos } from "./agent-logos";
import { platform, type Device, type Peer } from "./api";
import type { FleetConnections } from "./useFleetConnections";
import "./more-sheet.css";

// Everything not in the bottom bar, as Claude and Codex lay out their menus:
// the computer you're on at the top (tap to switch), then the places as a
// clean list of line icons, then Settings. Reach's own touch: the mascot,
// dark glass and a little lime light.
const PLACES: Record<string, { label: string; glyph: ReactNode }> = {
  files: { label: "Files", glyph: <Folder size={21} /> },
  apps: { label: "Apps", glyph: <LayoutGrid size={21} /> },
  chat: { label: "Codex", glyph: <MessageSquare size={21} /> },
  agents: { label: "Agent access", glyph: <ShieldCheck size={21} /> },
  invite: { label: "Invite someone", glyph: <UserRoundPlus size={21} /> },
};

export default function MoreSheet({
  peer,
  device,
  places,
  pending = [],
  current,
  settings,
  peers,
  active,
  connections,
  onNavigate,
  onChoose,
  onAdd,
  onClose,
}: {
  peer: Peer;
  device: Device | null;
  // Pages to offer here (the ones not in the bottom bar), in order.
  places: string[];
  // Places still being checked on the computer: shown, not yet tappable.
  pending?: string[];
  current: string;
  settings: boolean;
  peers: Peer[];
  active: string;
  connections: FleetConnections;
  onNavigate: (page: string) => void;
  onChoose: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  const owner = !device?.access || device.access.scopes.includes("admin");
  const logos = useAgentLogos(owner ? peer : null);
  const online = connections[peer.id]?.state === "connected";
  const host = (() => {
    try {
      return new URL(peer.url).hostname.endsWith(".ts.net")
        ? "Tailscale"
        : "Direct";
    } catch {
      return "";
    }
  })();
  // Rows come in one after another, quickly.
  let order = 0;
  const step = () => ({ "--i": order++ }) as CSSProperties;
  const shown = places.filter((id) => PLACES[id]);
  return (
    <ScreenPopup
      title="More"
      className="workspace-launcher more-sheet"
      onClose={onClose}
    >
      <div className="more-top" data-sheet-grab>
        <span className="more-mascot" aria-hidden="true">
          <BrandCourier active />
        </span>
        <strong>More</strong>
        <button className="glass-button" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="more-computer-wrap" style={step()}>
        <button
          className="more-computer"
          aria-expanded={switching}
          aria-label={`${device?.name || peer.name}, switch computer`}
          onClick={() => setSwitching((v) => !v)}
        >
          <ComputerIcon
            platform={device?.platform || peer.platform}
            size="large"
          />
          <span className="more-computer-text">
            <strong>{device?.name || peer.name}</strong>
            <small>
              <span className={`status-text ${online ? "on" : ""}`}>
                {online ? "Online" : "Offline"}
              </span>
              <span>{platform(device?.platform || peer.platform || "")}</span>
              {host && <span>{host}</span>}
            </small>
          </span>
          <ChevronDown className="more-chevron" size={18} />
        </button>
        {switching && (
          <div
            className="more-computers"
            role="group"
            aria-label="Your computers"
          >
            {peers.map((p) => {
              const here = p.id === active;
              const on = connections[p.id]?.state === "connected";
              return (
                <button
                  key={p.id}
                  className="more-row"
                  aria-pressed={here}
                  onClick={() => (here ? onClose() : onChoose(p.id))}
                >
                  <ComputerIcon
                    platform={p.platform}
                    size="small"
                    online={on}
                  />
                  <span className="more-row-label">{p.name}</span>
                  {here && <Check className="more-check" size={18} />}
                </button>
              );
            })}
            <button className="more-row" onClick={onAdd}>
              <AppIcon size="small">
                <Plus size={20} />
              </AppIcon>
              <span className="more-row-label">Add a computer</span>
            </button>
          </div>
        )}
      </div>

      {shown.length > 0 && (
        <nav className="more-list" aria-label="Go to">
          {shown.map((id) => (
            <button
              key={id}
              className={`more-row ${pending.includes(id) ? "pending" : ""}`}
              style={step()}
              aria-current={current === id ? "page" : undefined}
              aria-disabled={pending.includes(id) || undefined}
              onClick={() => !pending.includes(id) && onNavigate(id)}
            >
              {id === "chat" && logos.codex ? (
                <AppIcon size="small" real>
                  <AgentLogo agent="codex" logos={logos} size={28} />
                </AppIcon>
              ) : (
                <AppIcon size="small">{PLACES[id].glyph}</AppIcon>
              )}
              <span className="more-row-label">{PLACES[id].label}</span>
            </button>
          ))}
        </nav>
      )}

      {settings && (
        <nav className="more-list more-end" aria-label="Settings">
          <button
            className="more-row"
            style={step()}
            aria-current={current === "settings" ? "page" : undefined}
            onClick={() => onNavigate("settings")}
          >
            <AppIcon size="small">
              <Settings size={21} />
            </AppIcon>
            <span className="more-row-label">Settings</span>
          </button>
        </nav>
      )}
    </ScreenPopup>
  );
}
