import { useEffect, useRef, useState } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";
import type { Device, Peer } from "./api";
import ScreenPopup from "./ScreenPopup";
import { canSetUpFallback, createFallbackSetup, fallbackSetupNeeded, type FallbackSetupState } from "./native-fallback";

export function FallbackNotice({ peer, device }: { peer: Peer; device: Device }) {
  return canSetUpFallback(peer, device) && fallbackSetupNeeded(peer)
    ? <p className="panel" role="status">Turn Tailscale back on, then set up fallback in Settings to keep using Reach when it’s off.</p> : null;
}

export default function FallbackSetup({ peer, device }: { peer: Peer; device: Device }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FallbackSetupState>({ phase: "idle" });
  const current = useRef({ peer, device });
  current.current = { peer, device };
  const setup = useRef<ReturnType<typeof createFallbackSetup> | null>(null);
  const close = () => { setup.current?.stop(); setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const run = createFallbackSetup({ current: () => current.current, changed: setState });
    setup.current = run;
    void run.start();
    return () => { run.stop(); setup.current = null; };
  }, [open]);
  useEffect(() => { setup.current?.stop(); setOpen(false); setState({ phase: "idle" }); }, [peer.token, peer.url, device.id, device.access?.kind, device.access?.scopes.join("\n")]);
  if (!canSetUpFallback(peer, device)) return null;
  return <>
    <button className="gs-row" onClick={() => setOpen(true)}>
      <ShieldCheck size={21} />
      <span className="gs-label">Set up fallback</span>
      <span className="gs-value">{fallbackSetupNeeded(peer) ? "Setup needed" : state.phase === "ready" ? "Ready" : "Check"}</span>
      <ChevronRight className="gs-chevron" size={18} />
    </button>
    {open && <ScreenPopup title="Fallback connection" className="gs-sheet" onClose={close}>
      <p>Keep this Reach session working when the Tailscale app is off. Leave it on while you finish this one-time setup.</p>
      {["idle", "connecting"].includes(state.phase) && <p role="status">Preparing your fallback connection…</p>}
      {state.phase === "checking" && <p role="status">Checking your connection…</p>}
      {state.phase === "sign-in" && <>
        <p>Sign in with the Tailscale account this computer uses, then return here.</p>
        {state.signIn ? <a className="button" href={state.signIn} target="_blank" rel="noopener noreferrer">Sign in with Tailscale</a> : <p role="status">Preparing sign-in…</p>}
      </>}
      {state.phase === "network-approval" && <p>Finish approving this browser in Tailscale, then return here.</p>}
      {state.phase === "approval" && <>
        <p>Approve this connection in Reach on your computer using this code:</p>
        <p className="approval-code" aria-label="Fallback approval code">{state.code}</p>
        <p>Your existing connection stays open while you approve the fallback.</p>
      </>}
      {state.phase === "ready" && <>
        <p role="status">Fallback is ready.</p>
        <p>Reach will use it when the Tailscale app is off and return automatically when the app is available.</p>
        <button className="button" onClick={close}>Done</button>
      </>}
      {state.phase === "request-unknown" && <>
        <p role="alert">Your request may have reached the computer. Check Reach there before requesting another approval.</p>
        <button className="button secondary" onClick={() => setup.current?.requestAgain()}>Request approval again</button>
      </>}
      {state.phase === "error" && <p className="error-line" role="alert">{state.message}</p>}
      {state.phase !== "ready" && <button className="button secondary" onClick={close}>Close setup</button>}
    </ScreenPopup>}
  </>;
}
