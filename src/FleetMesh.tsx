import DeviceAccessBadge from "./DeviceAccessBadge";
import { useContext, useState, useEffect } from "react";
import { Monitor, Smartphone, Tablet, Plus, ChevronRight } from "lucide-react";
import type { Peer } from "./api";
import type { FleetConnections, ConnectedDevice } from "./useFleetConnections";
import { MotionContext } from "./motion";
import DeviceSignal from "./DeviceSignal";

const activityLabel = {
  connected: "Connected",
  viewing: "Viewing screen",
  controlling: "Controlling screen",
  terminal: "Using terminal",
};
const DeviceIcon = ({ kind }: { kind: ConnectedDevice["kind"] }) =>
  kind === "phone" ? (
    <Smartphone size={19} />
  ) : kind === "tablet" ? (
    <Tablet size={19} />
  ) : (
    <Monitor size={19} />
  );
export function ComputerSwitcher({
  peers,
  active,
  connections,
  choose,
  pair,
  waiting = [],
  onWaiting,
}: {
  peers: Peer[];
  active: string;
  connections: FleetConnections;
  choose: (id: string) => void;
  pair: () => void;
  // Your other Reach computers that aren't linked yet.
  waiting?: { origin: string; name: string }[];
  onWaiting?: (computer: { origin: string; name: string }) => void;
}) {
  return (
    <nav className="fleet-switcher" aria-label="Your computers">
      {peers.map((p) => (
        <button
          key={p.id}
          aria-pressed={active === p.id}
          onClick={() => choose(p.id)}
          title={p.name}
        >
          <i
            className={`status-dot ${connections[p.id]?.state === "connected" ? "" : "off"}`}
          />
          <span>{p.name}</span>
        </button>
      ))}
      {waiting.map((c) => (
        <button
          key={c.origin}
          className="fleet-waiting"
          onClick={() => onWaiting?.(c)}
          title={`${c.name}: not linked yet`}
        >
          <i className="status-dot off" />
          <span>{c.name}</span>
        </button>
      ))}
      <button className="fleet-add" aria-label="Add a computer" title="Add a computer" onClick={pair}>
        <Plus size={17} />
      </button>
    </nav>
  );
}
export default function FleetMesh({
  peers,
  active,
  connections,
  choose,
}: {
  peers: Peer[];
  active: string;
  connections: FleetConnections;
  choose: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => setNow(Date.now()), [connections]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const motion = useContext(MotionContext);
  const connected = peers.filter(
    (p) => connections[p.id]?.state === "connected",
  ).length;
  const single =
    peers.length === 1 ||
    (connected === 1 &&
      connections[active]?.state === "connected" &&
      !peers.some((p) => connections[p.id]?.state === "connecting"));
  const visible = single
    ? peers.filter((p) => p.id === active)
    : peers.length > 4
      ? peers.filter((p) => p.id === active || peers.indexOf(p) < 3)
      : peers;
  const singleDevices = connections[active]?.devices || [];
  const others = new Map<
    string,
    {
      device: ConnectedDevice;
      computers: {
        id: string;
        name: string;
        activity: ConnectedDevice["activity"];
        access: ConnectedDevice["access"];
      }[];
    }
  >();
  for (const p of peers)
    for (const d of connections[p.id]?.devices || []) {
      if (d.self) continue;
      // Tailnet node identities deduplicate across hosts. Legacy credentials are host-local.
      const id = d.id.startsWith("node:") ? d.id : `${p.id}:${d.id}`;
      const existing = others.get(id);
      if (existing) {
        if (!existing.computers.some((c) => c.id === p.id))
          existing.computers.push({
            id: p.id,
            name: p.name,
            activity: d.activity,
            access: d.access,
          });
      } else
        others.set(id, {
          device: d,
          computers: [
            { id: p.id, name: p.name, activity: d.activity, access: d.access },
          ],
        });
    }
  const phones = [...others.values()].filter(
    (v) => v.device.kind === "phone",
  ).length;
  const self = peers
    .flatMap((p) => connections[p.id]?.devices || [])
    .find((d) => d.self);
  const phoneCount = phones + (self?.kind === "phone" ? 1 : 0);
  return (
    <section
      className={`fleet-mesh ${single ? "single-computer-mesh" : ""} ${motion.enabled && !motion.hidden && !motion.reduced ? "is-playing" : ""}`}
      aria-label="Live device connections"
    >
      <header>
        <div>
          <span className="overline">
            {single ? "YOUR COMPUTER" : "YOUR CONNECTIONS"}
          </span>
          <h2>
            {peers.length === 1
              ? connected
                ? "Connected to you"
                : "Waiting for connection"
              : `${connected} of ${peers.length} computers connected`}
          </h2>
        </div>
        <span className="fleet-live">
          <i className={`status-dot ${connected ? "" : "off"}`} />{" "}
          {connected ? "Live" : "Waiting"}
        </span>
      </header>
      <div
        className="fleet-computers"
        style={{
          gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
        }}
      >
        {visible.map((p) => {
          const link = connections[p.id];
          const isConnected = link?.state === "connected";
          const count = link?.devices.length || 0;
          return (
            <div
              className={`fleet-branch ${isConnected ? "is-connected" : ""} ${p.id === active ? "is-selected" : ""}`}
              key={p.id}
            >
              <button
                className="fleet-computer"
                aria-pressed={p.id === active}
                onClick={() => choose(p.id)}
              >
                <DeviceSignal companion={single} />
                <strong>{p.name}</strong>
                <small>
                  {isConnected
                    ? `${count} device${count === 1 ? "" : "s"} connected`
                    : link?.state === "denied"
                      ? "Approval required"
                      : link?.state === "connecting"
                        ? "Connecting…"
                        : "Not connected"}
                </small>
              </button>
              <div className="fleet-wire" aria-hidden="true">
                <i />
              </div>
            </div>
          );
        })}
      </div>
      {single ? (
        singleDevices.length ? (
          <div
            className="single-peer-devices"
            style={{
              gridTemplateColumns: `repeat(${Math.min(singleDevices.length, 3)}, minmax(0, 1fr))`,
            }}
          >
            {singleDevices.map((d) => (
              <div className="single-peer" key={d.id}>
                <span className="single-peer-icon">
                  <DeviceIcon kind={d.kind} />
                </span>
                <strong>{d.self ? "This device" : d.name}</strong>
                <small>{d.self ? d.name : activityLabel[d.activity]}</small>
                <DeviceAccessBadge access={d.access} now={now} />
              </div>
            ))}
          </div>
        ) : (
          <p className="fleet-waiting">Waiting for live device connections.</p>
        )
      ) : (
        <div className="fleet-self">
          <span>
            <DeviceIcon kind={self?.kind || "computer"} />
          </span>
          <div>
            <strong>This device</strong>
            <DeviceAccessBadge
              access={connections[active]?.devices.find((d) => d.self)?.access}
              now={now}
            />
            <small>
              {connected
                ? `Connected to ${connected} computer${connected === 1 ? "" : "s"}`
                : "Waiting for a connection"}
            </small>
          </div>
        </div>
      )}
      {peers.length > 4 && (
        <button className="fleet-expand" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? "Show fewer computers"
            : `Show all ${peers.length} computers`}
          <ChevronRight size={14} />
        </button>
      )}
      {expanded && peers.length > 4 && (
        <div className="fleet-directory">
          <input
            aria-label="Find a computer"
            placeholder="Find a computer…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {peers
            .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
            .map((p) => (
              <button
                key={p.id}
                aria-pressed={p.id === active}
                onClick={() => choose(p.id)}
              >
                <Monitor size={17} />
                <span>
                  {p.name}
                  <small>
                    {connections[p.id]?.state === "connected"
                      ? `${connections[p.id].devices.length} device${connections[p.id].devices.length === 1 ? "" : "s"} connected`
                      : "Not connected"}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          {!peers.some((p) =>
            p.name.toLowerCase().includes(query.toLowerCase()),
          ) && <p>No computers match.</p>}
        </div>
      )}
      <details className="fleet-details">
        <summary>
          {phoneCount} phone{phoneCount === 1 ? "" : "s"} connected{" "}
          <span>Connection details</span>
        </summary>
        <div className="fleet-connection-detail">
          <span>
            {phoneCount} phone{phoneCount === 1 ? "" : "s"} connected
          </span>
          <span>{peers.find((p) => p.id === active)?.name} selected</span>
        </div>
        {!single && others.size > 0 && (
          <div className="fleet-other-devices">
            {[...others.entries()].map(([id, { device, computers }]) => (
              <div key={id}>
                <DeviceIcon kind={device.kind} />
                <span>
                  <strong>{device.name}</strong>
                  {computers.map((c) => (
                    <small key={c.id}>
                      {c.name} · {activityLabel[c.activity] || "Connected"}
                      <DeviceAccessBadge access={c.access} now={now} />
                    </small>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="fleet-access-legend">
          <span className="paired">Paired · regular access</span>
          <span className="invited">Invited · temporary</span>
        </div>
        <p className="fleet-note">
          Live Reach connections. Saved pairings and other tailnet devices
          aren’t counted.
        </p>
      </details>
    </section>
  );
}
