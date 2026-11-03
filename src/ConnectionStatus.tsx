import { useContext, useEffect, useState, type ReactNode } from "react";
import { ShieldAlert, WifiOff } from "lucide-react";
import reachMascot from "./assets/reach-mascot.svg";
import { connectionLoading } from "./connection-loading";
import "./connection-loading.css";
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
  onSetupRetry = onRetry,
  setup,
  diagnostics,
}: {
  error?: string;
  needsApproval?: boolean;
  onRetry: () => void;
  onConnect: () => void;
  onSetupRetry?: () => void;
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
  const setupError = setup?.state === "error";
  const ownerActive = !!setup && setup.state !== "ready";
  const failure = setupError ? setup.message || "Secure access couldn’t finish." : ownerActive ? "" : error;
  const approval = needsApproval && !ownerActive;
  const slow = useConnectionWait(!failure && !offline && !approval && !signIn, attempt);
  const loading = connectionLoading(slow);
  const attention = offline || approval || signIn;
  const title = offline ? "You’re offline" : signIn ? "One quick sign-in" :
    approval ? "Let’s reconnect" : failure ? "Your computer is out of reach" : loading.title;
  const detail = offline ? "Connect this device to the internet. Reach will try again when you’re back online." :
    signIn ? "Sign in once so Reach can connect with your phone’s Tailscale app off. Return here when you’re done." :
    approval ? "This browser’s access needs to be approved again on your computer." :
    failure ? "Make sure your computer is awake and Reach is running. We’ll keep trying for you." : loading.detail;
  const status = offline ? "Waiting for internet" : signIn ? "Ready to sign in" : approval ? "Approval needed" :
    failure ? "Trying again automatically…" : loading.status;
  return (
    <section className={`connection-state ${attention ? "needs-attention" : ""}`} aria-label="Computer connection"
      data-busy={!attention} data-paused={!motion.enabled || motion.reduced || motion.hidden}>
      <div className="connection-loading-mark" aria-hidden="true">
        <img src={reachMascot} alt="" width="84" height="84" />
      </div>
      <div className="connection-state-copy" role="status" aria-live="polite" aria-atomic="true">
        <h1>{title}</h1>
        <p>{detail}</p>
        <div className="connection-state-status">
          {offline ? <WifiOff size={15} aria-hidden="true" /> : approval || signIn ?
            <ShieldAlert size={15} aria-hidden="true" /> : <span className="connection-loading-dot" aria-hidden="true" />}
          <span>{status}</span>
        </div>
      </div>
      {signIn && !offline && <div className="connection-state-actions">
        <a className="button primary" href={setup.url} target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a>
      </div>}
      {(failure || slow || approval) && !offline && !signIn && (
        <div className="connection-state-actions">
          <button className="button primary" onClick={approval ? onConnect : () => {
            setAttempt(n => n + 1);
            (ownerActive ? onSetupRetry : onRetry)();
          }}>
            {approval ? "Connect again" : "Try again"}
          </button>
        </div>
      )}
      {(failure || (slow && diagnostics)) && (
        <details className="connection-state-help">
          <summary>Connection details</summary>
          {failure && <p>{failure}</p>}
          {diagnostics}
        </details>
      )}
    </section>
  );
}
