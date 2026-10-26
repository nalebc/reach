import { useEffect, useState } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import type { Device, Peer } from "./api";
import { watchOwnerEnrollment, type OwnerSetup } from "./owner-connection";
import type { StartConfig } from "./start-flow";
import type { TailnetNode } from "./tailnet-transport";
import "./owner-connection.css";

export default function OwnerConnection({ peer, device, visible, reconnect = false, onActive, beginBrowser }: {
  peer: Peer; device: Device | null; visible: boolean; reconnect?: boolean;
  onActive?: (active: boolean) => void;
  beginBrowser?: (config: StartConfig, node: TailnetNode) => void;
}) {
  const [setup, setSetup] = useState<OwnerSetup>({ state: "ready" });
  useEffect(() => {
    if ((!reconnect && device?.ownerConnection !== 1) || (device && (device.access?.kind !== "device" || !device.access.scopes.includes("admin"))) ||
        peer.transport === "funnel" || !location.hostname.endsWith(".ts.net") ||
        new URL(peer.url).hostname !== location.hostname) return;
    const stop = watchOwnerEnrollment(peer, state => { setSetup(state); onActive?.(state.state !== "ready"); }, { resumeOnly: !device, beginBrowser });
    return () => { stop(); onActive?.(false); };
  }, [peer.id, peer.url, peer.token, peer.transport, device?.ownerConnection, reconnect]);
  // Enrollment keeps running while the owner works in Chat, Screen or Files.
  // Its reminder belongs to Home/Settings, after the page's primary content.
  if (!visible || (!reconnect && device?.ownerConnection !== 1) || setup.state === "ready") return null;
  return <details className="owner-connection-setup" open={reconnect || undefined}>
    <summary>
      <Link2 size={20} aria-hidden="true" />
      <span>
        <strong>{setup.state === "error" ? "Connection setup needs attention" : reconnect ? "Connect securely in this browser" : "Finish connection setup"}</strong>
        <small>Use Reach without the Tailscale app</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div className="owner-connection-details">
      <p>{reconnect ? "Reach can connect through this browser with the phone’s Tailscale app off. Sign in once to authorize this browser." :
        "This one-time setup lets the same Reach link work when the phone’s Tailscale app is off."}</p>
      <p role="status">{setup.state === "signin" ? (setup.url ? "Sign in to Tailscale in this browser to continue." : "Preparing browser sign-in…") :
        setup.state === "error" ? setup.message : "Preparing this browser’s connection…"}</p>
      {setup.url && <a className="button primary" href={setup.url} target="_blank" rel="noopener noreferrer">Continue setup</a>}
    </div>
  </details>;
}
