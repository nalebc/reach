import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Loader2, RefreshCw } from "lucide-react";
import { post, request, type Peer } from "./api";
import {
  checkForUpdates,
  getUpdateState,
  holdReload,
  subscribeUpdates,
} from "./build-reload";
import "./interface-updates.css";

const messages = {
  checking: "Checking…",
  current: "Up to date",
  offline: "Offline",
  waiting: "Ready, installs when idle",
  reloading: "Installing…",
};

// Reach itself on the computer (server/reach-updates.mjs): a newer version
// to install, being installed, or one that needs the owner.
export type MacUpdate = {
  version: string | null;
  state:
    | "source" | "unpublished" | "offline" | "checking" | "current"
    | "available" | "manual" | "installing" | "restarting" | "installed" | "failed";
  to?: string;
  command?: string;
  error?: string;
};
const PENDING = ["available", "manual", "installing", "restarting", "installed", "failed"];

// One row in Settings' list. For the owner it also carries Reach's own
// version on the computer: "Update to 0.2.0", then one tap more installs it
// and Reach starts again (phones and agents follow by themselves).
// Otherwise it's the phone interface's state; tap to check now. Interface
// updates install on their own when Reach is idle.
export default function InterfaceUpdates({ peer, owner = false }: { peer?: Peer; owner?: boolean }) {
  const state = useSyncExternalStore(subscribeUpdates, getUpdateState);
  const [mac, setMac] = useState<MacUpdate | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (fresh = false) => {
    if (!peer || !owner) return;
    try {
      setMac(await request<MacUpdate>(peer, `/api/reach/update${fresh ? "?fresh=1" : ""}`));
    } catch {
      /* an older computer, or offline: the interface row still works */
    }
  }, [peer, owner]);
  useEffect(() => { void load(); }, [load]);
  // While it installs, look every few seconds; once Reach is back the page
  // reloads onto the new version by itself.
  const working = mac?.state === "installing" || mac?.state === "restarting";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [working, load]);
  // npm puts the new interface on disk before the new server runs: this page
  // stays on the one it has until Reach is back.
  const waitingForRestart = working || mac?.state === "installed";
  useEffect(() => (waitingForRestart ? holdReload() : undefined), [waitingForRestart]);
  const act = async (action: "install" | "retry", version?: string) => {
    if (!peer) return;
    setError("");
    try {
      setMac(await post<MacUpdate>(peer, "/api/reach/update", { action, version }));
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pending = !!mac && PENDING.includes(mac.state);
  const value = !pending
    ? messages[state]
    : mac.state === "available"
      ? `Update to ${mac.to}`
      : mac.state === "manual"
        ? `${mac.to} available`
        : mac.state === "installing"
          ? `Installing ${mac.to}…`
          : mac.state === "restarting"
            ? "Restarting…"
            : mac.state === "installed"
              ? "Restart to finish"
              : "Couldn't update";
  const disabled = pending
    ? working
    : state === "checking" || state === "reloading" || state === "waiting";
  const Icon = working ? Loader2 : pending ? ArrowUpCircle : RefreshCw;
  return (
    <>
      <button
        className={`gs-row interface-updates ${pending ? "mac-update" : ""}`}
        disabled={disabled}
        aria-expanded={pending ? open : undefined}
        onClick={() => {
          if (pending) return setOpen((was) => !was);
          checkForUpdates();
          void load(true);
        }}
      >
        <Icon size={21} className={working || (!pending && state === "checking") ? "spin" : ""} />
        <span className="gs-label">Reach updates</span>
        <span className={`gs-value ${mac?.state === "available" ? "update-ready" : ""}`} role="status" aria-live="polite">
          {value}
        </span>
      </button>
      {pending && open && mac.state === "available" && (
        <div className="gs-row gs-wrap update-detail">
          <span className="gs-label">
            <small>Installs {mac.to} and starts Reach again. Its terminals and live screens end; agents pick it up by themselves.</small>
          </span>
          <button className="gs-text-button update-go" onClick={() => void act("install", mac.to)}>
            Update
          </button>
        </div>
      )}
      {pending && open && mac.state === "manual" && (
        <div className="gs-row gs-wrap update-detail">
          <span className="gs-label">
            <small>Reach can't install it into its own folder. On your computer, run:</small>
            <code className="update-command">{mac.command}</code>
          </span>
        </div>
      )}
      {pending && open && (mac.state === "failed" || mac.state === "installed") && (
        <div className="gs-row gs-wrap update-detail">
          <span className="gs-label">
            <small>{mac.error || "The update didn't finish."}</small>
          </span>
          {mac.state === "failed" && (
            <button className="gs-text-button update-go" onClick={() => void act("retry")}>
              Try again
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="gs-row gs-wrap update-detail">
          <span className="gs-label"><small className="gs-danger">{error}</small></span>
        </div>
      )}
    </>
  );
}
