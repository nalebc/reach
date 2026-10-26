import { useEffect, useState } from "react";
import type { Device, Peer } from "./api";
import { watchOwnerEnrollment, type OwnerSetup } from "./owner-connection";
import "./owner-connection.css";

export default function OwnerConnection({ peer, device }: { peer: Peer; device: Device }) {
  const [setup, setSetup] = useState<OwnerSetup>({ state: "ready" });
  useEffect(() => {
    if (device.ownerConnection !== 1 || peer.transport === "funnel" || !location.hostname.endsWith(".ts.net") ||
        new URL(peer.url).hostname !== location.hostname) return;
    return watchOwnerEnrollment(peer, setSetup);
  }, [peer.id, peer.url, peer.token, device.ownerConnection]);
  if (setup.state === "ready") return null;
  return <section className="owner-connection-setup" role="status" aria-label="Finish owner connection setup">
    <strong>{setup.state === "error" ? "Browser connection setup needs attention" : "Preparing access with or without the phone app"}</strong>
    <p>{setup.state === "signin" ? "Sign in once in this browser to finish setup. Then this same link reconnects automatically when the phone's Tailscale app is off." :
      setup.state === "error" ? setup.message : "Keeping your current connection while preparing this browser's private connection…"}</p>
    {setup.url && <a className="button primary" href={setup.url} target="_blank" rel="noopener noreferrer">Finish browser sign-in</a>}
  </section>;
}
