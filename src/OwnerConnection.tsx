import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import type { Device, Peer } from "./api";
import { watchOwnerEnrollment, type OwnerSetup } from "./owner-connection";
import type { StartConfig } from "./start-flow";
import type { TailnetNode } from "./tailnet-transport";
import ConnectionStatus, { useConnectionWait } from "./ConnectionStatus";
import "./owner-connection.css";

type BrowserApproval = (config: StartConfig, node: TailnetNode) => void;
const ready: OwnerSetup = { state: "ready" };

// One subscription belongs to the workspace, independent of its current page.
// Preparing a standby path must not make a working connection look busy.
export function useOwnerConnection(peer: Peer | undefined, device: Device | null, {
  reconnect = false, beginBrowser,
}: { reconnect?: boolean; beginBrowser?: BrowserApproval } = {}) {
  const key = peer ? `${peer.id}:${peer.url}:${peer.token}` : "";
  const [reported, setReported] = useState({ key: "", setup: ready });
  const [attempt, setAttempt] = useState(0);
  const begin = useRef(beginBrowser);
  begin.current = beginBrowser;
  const canBegin = !!beginBrowser;
  const admin = device?.access?.kind === "device" && device.access.scopes.includes("admin");
  const connected = !!device;
  let eligible = false;
  try {
    eligible = !!peer && (reconnect || device?.ownerConnection === 1) && (!device || !!admin) &&
      peer.transport !== "funnel" && location.hostname.endsWith(".ts.net") &&
      new URL(peer.url).hostname === location.hostname;
  } catch { /* A malformed saved address cannot start owner enrollment. */ }
  useEffect(() => {
    setReported({ key, setup: ready });
    if (!eligible || !peer) return;
    let current = true;
    const stop = watchOwnerEnrollment(peer, setup => {
      if (current) setReported({ key, setup });
    }, { resumeOnly: !device, beginBrowser: canBegin ? (config, node) => { if (current) begin.current?.(config, node); } : undefined });
    return () => { current = false; stop(); };
  }, [key, eligible, connected, canBegin, attempt]);
  return { setup: eligible && reported.key === key ? reported.setup : ready, retry: () => setAttempt(n => n + 1) };
}

// Actionable standby setup belongs in Settings, outside the connection wait.
export function OwnerSetupNotice({ setup, onRetry }: { setup: OwnerSetup; onRetry: () => void }) {
  const waiting = setup.state === "preparing" || (setup.state === "signin" && !setup.url);
  const [attempt, setAttempt] = useState(0);
  const slow = useConnectionWait(waiting, attempt);
  if (setup.state === "ready" || (waiting && !slow)) return null;
  return <details className="owner-connection-setup">
    <summary>
      <Link2 size={20} aria-hidden="true" />
      <span>
        <strong>Browser access</strong>
        <small>{setup.state === "error" || slow ? "Needs attention" : "Sign-in required"}</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div className="owner-connection-details">
      <p>Reach is connected. Finish browser access to keep using this link with your phone’s Tailscale app off.</p>
      {slow && <p>Browser access is taking longer than usual. You can retry setup and keep working.</p>}
      {setup.state === "error" && <p role="status">{setup.message || "Browser access couldn’t finish."} Reach will retry automatically.</p>}
      {setup.url && <a className="button primary" href={setup.url} target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a>}
      {(setup.state === "error" || slow) && <button className="button secondary" onClick={() => {
        setAttempt(n => n + 1);
        onRetry();
      }}>Try setup again</button>}
    </div>
  </details>;
}

export default function OwnerConnection({ peer, device, visible, reconnect = false, onActive, beginBrowser, diagnostics }: {
  peer: Peer; device: Device | null; visible: boolean; reconnect?: boolean;
  onActive?: (active: boolean) => void; beginBrowser?: BrowserApproval; diagnostics?: ReactNode;
}) {
  const { setup, retry } = useOwnerConnection(peer, device, { reconnect, beginBrowser });
  useEffect(() => {
    onActive?.(setup.state !== "ready");
    return () => onActive?.(false);
  }, [setup.state, onActive]);
  if (!visible || (!reconnect && device?.ownerConnection !== 1) || setup.state === "ready") return null;
  return reconnect ? <ConnectionStatus setup={setup} onRetry={retry} onConnect={retry} diagnostics={diagnostics} /> :
    <OwnerSetupNotice setup={setup} onRetry={retry} />;
}
