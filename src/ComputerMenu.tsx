import { Check, Plus } from "lucide-react";
import ScreenPopup from "./ScreenPopup";
import { ComputerIcon } from "./AppIcon";
import { connectionName } from "./connection";
import { platform, type Peer } from "./api";
import type { FleetConnections } from "./useFleetConnections";
import type { WaitingComputer } from "./WaitingComputer";
import "./computer-menu.css";

export default function ComputerMenu({
  peers,
  active,
  connections,
  waiting = [],
  onWaiting,
  onChoose,
  onAdd,
  onClose,
}: {
  peers: Peer[];
  active: string;
  connections: FleetConnections;
  waiting?: WaitingComputer[];
  onWaiting: (computer: WaitingComputer) => void;
  onChoose: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <ScreenPopup
      title="Your computers"
      className="reach-sheet computer-menu"
      onClose={onClose}
    >
      <div className="computer-menu-list">
        {peers.map((peer) => (
          <button
            key={peer.id}
            className="computer-menu-row"
            aria-pressed={peer.id === active}
            onClick={() => {
              if (peer.id !== active) onChoose(peer.id);
              onClose();
            }}
          >
            <ComputerIcon
              platform={peer.platform}
              size="small"
              online={connections[peer.id]?.state === "connected"}
            />
            <span className="computer-menu-label">
              <strong>{peer.name}</strong>
              <small>
                {connections[peer.id]?.state === "connected"
                  ? "Online"
                  : "Offline"}{" "}
                · {platform(peer.platform || "")} · {connectionName(peer.url)}
              </small>
            </span>
            {peer.id === active && <Check size={18} aria-hidden="true" />}
          </button>
        ))}
        {waiting.map((computer) => (
          <button
            key={computer.origin}
            className="computer-menu-row computer-menu-waiting"
            onClick={() => onWaiting(computer)}
          >
            <ComputerIcon size="small" />
            <span className="computer-menu-label">
              <strong>{computer.name}</strong>
              <small>{computer.linked ? "Joining" : "Not linked"}</small>
            </span>
          </button>
        ))}
      </div>
      <button className="computer-menu-add" onClick={onAdd}>
        <Plus size={19} aria-hidden="true" />
        Add a computer
      </button>
    </ScreenPopup>
  );
}
