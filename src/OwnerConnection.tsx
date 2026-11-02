import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Link2, LoaderCircle } from "lucide-react";
import type { Device, Peer } from "./api";
import { watchOwnerEnrollment, type OwnerSetup } from "./owner-connection";
import type { StartConfig } from "./start-flow";
import type { TailnetNode } from "./tailnet-transport";
import ConnectionStatus, { useConnectionWait } from "./ConnectionStatus";
import "./owner-connection.css";

export default function OwnerConnection({ peer, device, visible, reconnect = false, onActive, beginBrowser, diagnostics }: {
  peer: Peer; device: Device | null; visible: boolean; reconnect?: boolean;
  onActive?: (active: boolean) => void;
  beginBrowser?: (config: StartConfig, node: TailnetNode) => void;
  diagnostics?: ReactNode;
}) {
  const [setup, setSetup] = useState<OwnerSetup>({ state: "ready" });
  const [attempt, setAttempt] = useState(0);
  const preparing = setup.state === "preparing" || (setup.state === "signin" && !setup.url);
  const slow = useConnectionWait(preparing, attempt);
  const retry = () => setAttempt(n => n + 1);
  useEffect(() => {
    if ((!reconnect && device?.ownerConnection !== 1) || (device && (device.access?.kind !== "device" || !device.access.scopes.includes("admin"))) ||
        peer.transport === "funnel" || !location.hostname.endsWith(".ts.net") ||
        new URL(peer.url).hostname !== location.hostname) return;
    const stop = watchOwnerEnrollment(peer, state => { setSetup(state); onActive?.(state.state !== "ready"); }, { resumeOnly: !device, beginBrowser });
    return () => { stop(); onActive?.(false); };
  }, [peer.id, peer.url, peer.token, peer.transport, device?.ownerConnection, reconnect, attempt]);
  // Enrollment keeps running while the owner works in Chat, Screen or Files.
  // Its reminder belongs to Home/Settings, after the page's primary content.
  if (!visible || (!reconnect && device?.ownerConnection !== 1) || setup.state === "ready") return null;
  if (reconnect) return <ConnectionStatus
    setup={setup}
    error={setup.state === "error" ? setup.message || "Browser setup couldn’t finish." : ""}
    onRetry={retry}
    onConnect={retry}
    diagnostics={diagnostics}
  />;
  return <details className="owner-connection-setup">
    <summary>
      {preparing ? <LoaderCircle className="spin" size={20} aria-hidden="true" /> : <Link2 size={20} aria-hidden="true" />}
      <span role="status" aria-live="polite" aria-atomic="true">
        <strong>{setup.state === "error" ? "Connection setup needs attention" : preparing ? "Preparing browser access…" : "Sign in to finish setup"}</strong>
        <small>{slow ? "Taking longer than usual. Tap for options." : "Works with the Tailscale app off"}</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div className="owner-connection-details">
      <p>{setup.state === "error" ? "Browser setup couldn’t finish. You can keep using Reach while it tries again." :
        preparing ? "Reach is setting up secure access for this browser. You can keep working while it finishes." :
        "Sign in once so this Reach link also works with your phone’s Tailscale app off."}</p>
      <p role="status" aria-live="polite">{setup.state === "error" ? `${setup.message || "Setup couldn’t finish."} Reach will retry automatically.` :
        slow ? "Still preparing. You can try setup again if it’s taking too long." :
        preparing ? "Preparing secure browser access…" : "Ready to sign in. Return here when you’re done."}</p>
      {setup.url && <a className="button primary" href={setup.url} target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a>}
      {(setup.state === "error" || slow) && <button className="button secondary" onClick={retry}>Try setup again</button>}
    </div>
  </details>;
}
