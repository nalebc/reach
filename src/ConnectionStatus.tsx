import { useContext, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, ShieldAlert, WifiOff } from "lucide-react";
import { ReachScene } from "./ReachIdentity";
import type { OwnerSetup } from "./owner-connection";
import { MotionContext } from "./motion";
import "./connection-status.css";

/** Feedback follows the actual wait; it never implies a completed network step. */
export function useConnectionWait(waiting: boolean, attempt = 0) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [waiting, attempt]);
  return waiting && slow;
}

export default function ConnectionStatus({
  error = "",
  needsApproval = false,
  onRetry,
  onConnect,
  setup,
  diagnostics,
}: {
  error?: string;
  needsApproval?: boolean;
  onRetry: () => void;
  onConnect: () => void;
  setup?: OwnerSetup;
  diagnostics?: ReactNode;
}) {
  const motion = useContext(MotionContext);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const signIn = setup?.state === "signin" && !!setup.url;
  const preparing = setup?.state === "preparing" || (setup?.state === "signin" && !setup.url);
  const setupError = setup?.state === "error";
  const slow = useConnectionWait(!error && !offline && !needsApproval && !signIn, attempt);
  const attention = offline || needsApproval || signIn;
  const title = offline ? "You’re offline" : signIn ? "One quick sign-in" :
    setupError ? "Browser setup needs attention" :
    preparing ? slow ? "Still preparing" : "Preparing secure access" : needsApproval ? "Let’s reconnect" :
    error ? "Your computer is out of reach" : slow ? "Still connecting" : "Opening your workspace";
  const detail = offline ? "Connect this device to the internet. Reach will try again when you’re back online." :
    signIn ? "Sign in once so Reach can connect with your phone’s Tailscale app off. Return here when you’re done." :
    setupError ? "Reach couldn’t finish setting up this browser. We’ll retry automatically, or you can try again now." :
    preparing ? slow ? "This is taking longer than usual. You can try setup again while your computer stays awake with Reach running." :
      "Reach is setting up a secure connection in this browser. Your workspace will open here." :
    needsApproval ? "This browser’s access needs to be approved again on your computer." :
    error || slow ? "Make sure your computer is awake and Reach is running. We’ll keep trying for you." :
    "Connecting securely to your computer. Your workspace will open here.";
  const status = offline ? "Waiting for internet" : signIn ? "Ready to sign in" : needsApproval ? "Approval needed" :
    error ? "Trying again automatically…" : slow ? "Taking longer than usual…" :
    preparing ? "Preparing secure browser access…" : "Checking your saved access…";
  return (
    <section className={`connection-state ${attention ? "needs-attention" : ""}`} aria-label="Computer connection">
      <MotionContext.Provider value={attention ? { ...motion, enabled: false } : motion}>
        <ReachScene mode="loading" className="connection-state-scene" />
      </MotionContext.Provider>
      <div className="connection-state-copy" role="status" aria-live="polite" aria-atomic="true">
        <h1>{title}</h1>
        <p>{detail}</p>
        <div className="connection-state-status">
          {offline ? <WifiOff size={15} aria-hidden="true" /> : needsApproval || signIn ?
            <ShieldAlert size={15} aria-hidden="true" /> : <LoaderCircle className="spin" size={15} aria-hidden="true" />}
          <span>{status}</span>
        </div>
      </div>
      {signIn && !offline && <div className="connection-state-actions">
        <a className="button primary" href={setup.url} target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a>
      </div>}
      {(error || slow || needsApproval) && !offline && !signIn && (
        <div className="connection-state-actions">
          <button className="button primary" onClick={needsApproval ? onConnect : () => {
            setAttempt(n => n + 1);
            onRetry();
          }}>
            {needsApproval ? "Connect again" : preparing || setupError ? "Try setup again" : "Try again"}
          </button>
        </div>
      )}
      {(error || (slow && diagnostics)) && (
        <details className="connection-state-help">
          <summary>Connection details</summary>
          {error && <p>{error}</p>}
          {diagnostics}
        </details>
      )}
    </section>
  );
}
