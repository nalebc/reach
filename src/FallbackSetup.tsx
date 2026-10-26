import { useEffect, useRef, useState } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";
import type { Device, Peer } from "./api";
import ScreenPopup from "./ScreenPopup";
import { canSetUpFallback, createFallbackSetup, fallbackSetupNeeded, type FallbackSetupState } from "./native-fallback";

export function FallbackNotice({ peer, device }: { peer: Peer; device: Device }) {
  return canSetUpFallback(peer, device) && fallbackSetupNeeded(peer)
    ? <p className="panel" role="status">Turn Tailscale back on, then set up fallback in Settings to keep using Reach when it’s off.</p> : null;
}

// The one-time setup itself, opened from Settings or from Home's suggestion
// (PhonePrompts.tsx). Its owner closes it when the connection changes.
export function FallbackSetupSheet({ peer, device, onClose, onState }: {
  peer: Peer; device: Device; onClose: () => void; onState?: (state: FallbackSetupState) => void;
}) {
  const [state, setState] = useState<FallbackSetupState>({ phase: "idle" });
  const current = useRef({ peer, device });
  current.current = { peer, device };
  const report = useRef(onState);
  report.current = onState;
  const setup = useRef<ReturnType<typeof createFallbackSetup> | null>(null);
  const close = () => { setup.current?.stop(); onClose(); };
  useEffect(() => {
    const run = createFallbackSetup({ current: () => current.current, changed: next => { setState(next); report.current?.(next); } });
    setup.current = run;
    void run.start();
    return () => { run.stop(); setup.current = null; };
  }, []);
  return <ScreenPopup title="Fallback connection" className="gs-sheet" onClose={close}>
    <p>Keep using Reach when the Tailscale app is off, including after reopening it. Leave Tailscale on while you finish this one-time setup.</p>
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
      {state.cold === "preparing" && <p role="status">Saving Reach on this phone so it can reopen later…</p>}
      {state.cold === "ready" && <p>You can close and reopen Reach with Tailscale off.</p>}
      {state.cold === "unavailable" && <p role="status">Keep Reach open for now. Its connection is approved, but saving it for reopening did not finish. Open setup again to retry; your approval is kept.</p>}
      <button className="button" onClick={close}>Done</button>
    </>}
    {state.phase === "request-unknown" && <>
      <p role="alert">Your request may have reached the computer. Check Reach there before requesting another approval.</p>
      <button className="button secondary" onClick={() => setup.current?.requestAgain()}>Request approval again</button>
    </>}
    {state.phase === "error" && <p className="error-line" role="alert">{state.message}</p>}
    {state.phase !== "ready" && <button className="button secondary" onClick={close}>Close setup</button>}
  </ScreenPopup>;
}

export default function FallbackSetup({ peer, device }: { peer: Peer; device: Device }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FallbackSetupState>({ phase: "idle" });
  useEffect(() => { setOpen(false); setState({ phase: "idle" }); }, [peer.token, peer.url, device.id, device.access?.kind, device.access?.scopes.join("\n")]);
  if (!canSetUpFallback(peer, device)) return null;
  return <>
    <button className="gs-row" onClick={() => setOpen(true)}>
      <ShieldCheck size={21} />
      {/* A noun and a short status, like the Connection row above it: what
          it is, then where it stands. The sheet does the setting up. */}
      <span className="gs-label">Fallback</span>
      <span className="gs-value">{fallbackSetupNeeded(peer) ? "Set up" : state.phase === "ready" ? state.cold === "ready" ? "Ready" : "Keep open" : "Check"}</span>
      <ChevronRight className="gs-chevron" size={18} />
    </button>
    {open && <FallbackSetupSheet peer={peer} device={device} onClose={() => setOpen(false)} onState={setState} />}
  </>;
}
