import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import {
  checkForUpdates,
  getUpdateState,
  subscribeUpdates,
} from "./build-reload";

const messages = {
  checking: "Checking…",
  current: "Up to date",
  offline: "Offline",
  waiting: "Ready, installs when idle",
  reloading: "Installing…",
};

// One row in Settings' list: the state as its value; tap to check now.
// Interface updates install on their own when Reach is idle.
export default function InterfaceUpdates() {
  const state = useSyncExternalStore(subscribeUpdates, getUpdateState);
  return (
    <button
      className="gs-row interface-updates"
      disabled={state === "checking" || state === "reloading" || state === "waiting"}
      onClick={() => checkForUpdates()}
    >
      <RefreshCw size={21} className={state === "checking" ? "spin" : ""} />
      <span className="gs-label">Reach updates</span>
      <span className="gs-value" role="status" aria-live="polite">
        {messages[state]}
      </span>
    </button>
  );
}
