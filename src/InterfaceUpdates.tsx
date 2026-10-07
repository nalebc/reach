import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { checkForUpdates, getUpdateState, subscribeUpdates } from "./build-reload";

const messages = {
  checking: "Checking for updates…",
  current: "Up to date",
  offline: "Couldn’t check. Reach will try again when connected.",
  waiting: "Update ready. Finish typing or close the live stream to install it.",
  reloading: "Installing the update…",
};

export default function InterfaceUpdates() {
  const state = useSyncExternalStore(subscribeUpdates, getUpdateState);
  return (
    <section className="panel settings-panel interface-updates">
      <h2>Reach updates</h2>
      <p>Interface updates install automatically when Reach is idle. Keep using the same Home Screen icon.</p>
      <p role="status" aria-live="polite">{messages[state]}</p>
      <button className="button secondary" disabled={state === "checking" || state === "reloading"} onClick={() => checkForUpdates()}>
        <RefreshCw size={16} /> Check for updates
      </button>
    </section>
  );
}
