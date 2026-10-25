import { useEffect, useState } from "react";
import { ShieldCheck, SquarePlus, X, Zap } from "lucide-react";
import type { Device, Peer } from "./api";
import { FallbackSetupSheet } from "./FallbackSetup";
import { canSetUpFallback, fallbackSetupNeeded } from "./native-fallback";
import { isNative } from "./native";
import { connectionWay, tailscaleAppLink } from "./connection";
import { isAndroid, isPhone, justInstalled, standalone, useInstallPrompt } from "./home-screen";
import { dismissNudge, finishNudge, nudgeDue, type NudgeName } from "./nudges";
import { HomeScreenSetup } from "./NotifySettings";
import "./phone-prompts.css";

// One suggestion at a time, on Home, just above the bottom bar
// (docs/FIRST_RUN_MATRIX.md, S and N):
// - Signed in from the browser, without the Tailscale app: get the app. The
//   start page this browser came through answers only while a pairing window
//   is open; with the app, the same link works any time, device to device.
// - With the app, without a fallback yet: set one up while the app is on, so
//   Reach keeps working when it's off (src/native-fallback.ts). Its own
//   approval is needed once; it is offered here instead of after access ends.
// - With the app, in a phone's browser tab: add Reach to the Home Screen. The
//   Home Screen copy is this same Tailscale device, so it's approved at once.
// Each comes back from time to time (nudges.ts) and stops for good once done.
// Only for your own devices: guests come and go, agents have their own page.
export default function PhonePrompts({ owner, url, peer, device }: { owner: boolean; url: string; peer?: Peer; device?: Device }) {
  const way = connectionWay(url);
  const install = useInstallPrompt();
  const [shown, setShown] = useState<NudgeName | null>(null);
  const [steps, setSteps] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const offerFallback = !!peer && !!device && canSetUpFallback(peer, device) && fallbackSetupNeeded(peer);
  // Another connection or access: its setup starts over from its own row.
  useEffect(() => setSettingUp(false), [peer?.token, peer?.url, device?.id, device?.access?.kind, device?.access?.scopes.join("\n")]);
  useEffect(() => {
    // Opened from the Home Screen: it's there; never suggested again.
    if (standalone()) finishNudge("home-screen");
  }, []);
  useEffect(() => {
    if (!owner || isNative) return;
    const pick = (): NudgeName | null => {
      if (way === "browser") return nudgeDue("tailscale-app") ? "tailscale-app" : null;
      if (way === "app" && offerFallback && nudgeDue("fallback")) return "fallback";
      if (way === "app" && isPhone() && !standalone() && nudgeDue("home-screen")) return "home-screen";
      return null;
    };
    // Once Home has settled; getting the app is said straight away.
    const timer = setTimeout(() => setShown(pick()), way === "browser" ? 1500 : 4000);
    const appOn = () => {
      finishNudge("tailscale-app");
      setShown((now) => (now === "tailscale-app" ? null : now));
    };
    const added = () => {
      if (!justInstalled()) return;
      finishNudge("home-screen");
      setShown((now) => (now === "home-screen" ? null : now));
    };
    window.addEventListener("reach-tailscale-app-on", appOn);
    window.addEventListener("reach-install-changed", added);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("reach-tailscale-app-on", appOn);
      window.removeEventListener("reach-install-changed", added);
    };
  }, [owner, way, offerFallback]);
  if (settingUp && peer && device)
    return <FallbackSetupSheet peer={peer} device={device} onClose={() => setSettingUp(false)} />;
  if (!shown || (shown === "fallback" && !offerFallback)) return null;
  const later = () => {
    dismissNudge(shown);
    setShown(null);
    setSteps(false);
  };
  if (shown === "tailscale-app")
    return (
      <div className="phone-prompt" role="note" aria-label="Get the Tailscale app">
        <span className="phone-prompt-icon">
          <Zap size={16} aria-hidden="true" />
        </span>
        <span className="phone-prompt-text">Get the Tailscale app to open Reach any time · faster too</span>
        <a className="phone-prompt-go" href={tailscaleAppLink()} target="_blank" rel="noopener noreferrer">
          Get
        </a>
        <button className="phone-prompt-close" aria-label="Not now" onClick={later}>
          <X size={15} />
        </button>
      </div>
    );
  if (shown === "fallback")
    return (
      <div className="phone-prompt" role="note" aria-label="Keep Reach when Tailscale is off">
        <span className="phone-prompt-icon">
          <ShieldCheck size={16} aria-hidden="true" />
        </span>
        <span className="phone-prompt-text">Keep Reach working when Tailscale is off · one-time setup</span>
        <button className="phone-prompt-go" onClick={() => setSettingUp(true)}>
          Set up
        </button>
        <button className="phone-prompt-close" aria-label="Not now" onClick={later}>
          <X size={15} />
        </button>
      </div>
    );
  // The browser's own install prompt where it has one (Android); the steps
  // otherwise (iPhone: Share → Add to Home Screen).
  const add = async () => {
    if (!install) return setSteps(true);
    if ((await install()) === "accepted") {
      finishNudge("home-screen");
      setShown(null);
    }
  };
  return (
    <>
      <div className="phone-prompt" role="note" aria-label="Add Reach to your Home Screen">
        <span className="phone-prompt-icon">
          <SquarePlus size={16} aria-hidden="true" />
        </span>
        <span className="phone-prompt-text">Add Reach to your Home Screen</span>
        <button className="phone-prompt-go" onClick={() => void add()}>
          Add
        </button>
        <button className="phone-prompt-close" aria-label="Not now" onClick={later}>
          <X size={15} />
        </button>
      </div>
      {steps && (
        <div className="phone-prompt-sheet" role="dialog" aria-label="Add to Home Screen">
          <button className="phone-prompt-close" aria-label="Close" onClick={later}>
            <X size={16} />
          </button>
          {isAndroid() ? (
            <section className="ns ns-install">
              <div className="ns-install-head">
                <img className="ns-app-icon" src="/favicon.svg" alt="" />
                <span className="ns-text">
                  <strong>Add Reach to your Home Screen</strong>
                  <small>Opens full screen, like an app.</small>
                </span>
              </div>
              <ol className="ns-steps">
                <li>
                  <span className="ns-step-icon">⋮</span>
                  <span>
                    In the browser's menu, tap <strong>Add to Home screen</strong> or <strong>Install app</strong>
                  </span>
                </li>
                <li>
                  <span className="ns-step-icon">
                    <img src="/favicon.svg" alt="" />
                  </span>
                  <span>
                    Open <strong>Reach</strong> from your Home Screen
                  </span>
                </li>
              </ol>
            </section>
          ) : (
            <HomeScreenSetup why="Opens full screen, like an app." label="Add to Home Screen" steps />
          )}
        </div>
      )}
    </>
  );
}
