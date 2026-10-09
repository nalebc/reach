import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, BellOff, Moon, Share, SquarePlus } from "lucide-react";
import { request, type Peer } from "./api";
import { sameComputer } from "./passkeys";
import {
  disablePush,
  enablePush,
  pushEnabled,
  pushSupport,
  testPush,
  notificationPreferences,
  type NotificationPreferences,
} from "./push";
import "./notifications.css";

// Reach on the Home Screen. Chrome, Edge and Android offer a real install
// prompt, but only once, at page load: it's kept from start-up (this module
// loads with the app) for the tap. iPhone has no such prompt.
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
let installPrompt: InstallPrompt | null = null;
const installChanged = () =>
  window.dispatchEvent(new Event("reach-install-changed"));
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e as InstallPrompt;
    installChanged();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installChanged();
  });
}
function useInstallPrompt() {
  const [ready, setReady] = useState(() => !!installPrompt);
  useEffect(() => {
    const changed = () => setReady(!!installPrompt);
    window.addEventListener("reach-install-changed", changed);
    return () => window.removeEventListener("reach-install-changed", changed);
  }, []);
  const install = async () => {
    const prompt = installPrompt;
    if (!prompt) return;
    installPrompt = null;
    await prompt.prompt();
    await prompt.userChoice.catch(() => null);
    installChanged();
  };
  return ready ? install : null;
}

export function useNotificationSetup(peer: Peer, active = true) {
  const [support, setSupport] = useState(pushSupport);
  const [preferences, setPreferences] =
    useState<NotificationPreferences | null>(null);
  const [on, setOn] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);
  // Each read, and each change this device made: a read only counts if
  // nothing newer began or changed while it was on its way.
  const reads = useRef(0);
  const here = sameComputer(peer.url);
  const refresh = useCallback(async () => {
    const version = generation.current;
    const read = ++reads.current;
    const latest = () => version === generation.current && read === reads.current;
    const current = pushSupport();
    setSupport(current);
    if (!active || !here || current === "unsupported") {
      setLoading(false);
      return;
    }
    try {
      await request(peer, "/api/push");
      if (!latest()) return;
      setAllowed(true);
      const enabled = current === "ready" && (await pushEnabled(peer));
      if (!latest()) return;
      setOn(enabled);
      if (enabled) {
        const prefs = await notificationPreferences(peer);
        if (latest()) setPreferences(prefs);
      }
    } catch (e) {
      if (latest()) {
        if ([401, 403].includes((e as { status?: number }).status || 0))
          setAllowed(false);
        else
          setNote(
            "Couldn't check notifications. Reconnect to your computer and try again.",
          );
      }
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [peer.url, peer.token, here, active]);
  useEffect(() => {
    generation.current++;
    setOn(false);
    setPreferences(null);
    setAllowed(false);
    setLoading(true);
    setNote("");
    setBusy(false);
    pending.current = false;
    void refresh();
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("reach-push-changed", visible);
    return () => {
      generation.current++;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("reach-push-changed", visible);
    };
  }, [refresh]);
  const act = async (test = false) => {
    if (pending.current) return;
    const version = generation.current;
    pending.current = true;
    setBusy(true);
    setNote("");
    try {
      // Keep requestPermission in the tap's call stack; Safari requires it.
      if (test) await testPush(peer);
      else if (on) await disablePush(peer);
      else await enablePush(peer);
      if (version !== generation.current) return;
      if (test)
        setNote(
          "Test sent. Check Notification Center on this device. Focus settings may silence the banner.",
        );
      else {
        reads.current++;
        setOn(!on);
        window.dispatchEvent(new Event("reach-push-changed"));
      }
    } catch (e) {
      if (version === generation.current) {
        setSupport(pushSupport());
        setNote((e as Error).message);
      }
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const update = async (
    change: Parameters<typeof notificationPreferences>[1],
  ) => {
    if (pending.current) return;
    const version = generation.current;
    pending.current = true;
    setBusy(true);
    setNote("");
    try {
      const prefs = await notificationPreferences(peer, change);
      if (version !== generation.current) return;
      reads.current++;
      setPreferences(prefs);
      setNote("Saved for this device.");
      window.dispatchEvent(new Event("reach-push-changed"));
    } catch (e) {
      if (version === generation.current) setNote((e as Error).message);
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    preferences,
    update,
    support,
    on,
    allowed,
    loading,
    busy,
    note,
    here,
    toggle: () => act(),
    test: () => act(true),
    refresh,
  };
}

// The Home Screen's address: this page, without one-time query bits.
const homeUrl = () => location.origin + location.pathname;
// What each switch is about, in people's words.
const CATEGORIES = [
  ["done", "Chats finished"],
  ["openclaw", "OpenClaw background work"],
  ["chat", "Agent questions & approvals"],
  ["computer", "Mac permission prompts"],
  ["handoffs", "Apps handed to you"],
  ["access", "Access requests"],
] as const;

// iPhone sends notifications only to Home Screen apps. A web page can't add
// itself there: the nearest is the Share sheet, one tap from "Add to Home
// Screen", so the button opens it; the two steps show once it's open.
function HomeScreenSetup() {
  const canShare = typeof navigator.share === "function";
  const [asked, setAsked] = useState(!canShare);
  const share = async () => {
    setAsked(true);
    try {
      await navigator.share({ title: "Reach", url: homeUrl() });
    } catch {
      /* closed without choosing: the steps stay */
    }
  };
  return (
    <section className="ns ns-install" aria-label="Notification setup">
      <div className="ns-install-head">
        <img className="ns-app-icon" src="/favicon.svg" alt="" />
        <span className="ns-text">
          <strong>Add Reach to your Home Screen</strong>
          <small>iPhone sends notifications only to Home Screen apps.</small>
        </span>
      </div>
      {canShare && (
        <button className="ns-primary" onClick={() => void share()}>
          <Share size={17} aria-hidden="true" /> Add to Home Screen
        </button>
      )}
      {asked && (
        <ol className="ns-steps">
          <li>
            <span className="ns-step-icon">
              <SquarePlus size={15} aria-hidden="true" />
            </span>
            <span>
              {canShare ? "In the sheet, tap " : "In Safari, tap Share, then "}
              <strong>Add to Home Screen</strong>
            </span>
          </li>
          <li>
            <span className="ns-step-icon">
              <img src="/favicon.svg" alt="" />
            </span>
            <span>
              Open <strong>Reach</strong> from your Home Screen and sign in
              there once
            </span>
          </li>
        </ol>
      )}
    </section>
  );
}

// Notifications for this device: one switch, then (once on) pause and what
// to be told about, as a calm settings list. Nothing to read unless needed.
export function NotificationSetup({
  state,
}: {
  state: ReturnType<typeof useNotificationSetup>;
}) {
  const { support, on, allowed, loading, busy, note, here, preferences } =
    state;
  const install = useInstallPrompt();
  const [now, setNow] = useState(Date.now);
  // One wake-up when a pause ends, not a ticking clock.
  const pausedUntil = preferences?.pausedUntil || 0;
  useEffect(() => {
    setNow(Date.now());
    const left = pausedUntil - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [pausedUntil]);
  const paused = on && !!preferences && preferences.pausedUntil > now;
  const until = preferences
    ? new Date(preferences.pausedUntil).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const line = (text: ReactNode, role?: "status") => (
    <section className="ns" aria-label="Notification setup">
      <p className="ns-line" role={role}>
        {text}
      </p>
      {note && (
        <p className="ns-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
  if (!here)
    return line("Open this computer's own Reach address to get its notifications here.");
  if (loading) return line("Checking this device…", "status");
  if (support === "home-screen") return <HomeScreenSetup />;
  if (support === "denied")
    return line(
      <>
        <BellOff size={15} aria-hidden="true" />
        <span>
          Notifications are blocked. Allow them in{" "}
          <strong>Settings → Notifications → Reach</strong>.
        </span>
      </>,
    );
  if (support === "unsupported")
    return line("This browser can't receive notifications. On iPhone, open Reach from the Home Screen.");
  if (!allowed)
    return (
      <section className="ns" aria-label="Notification setup">
        <button className="ns-link" onClick={() => void state.refresh()}>
          Check again
        </button>
      </section>
    );
  return (
    <section className="ns" aria-label="Notification setup">
      <div className="ns-group">
        <label className="ns-row">
          <span className="ns-icon">
            {paused ? <BellOff size={18} /> : <Bell size={18} />}
          </span>
          <span className="ns-text">
            <strong>Notifications</strong>
            <small>
              {!on
                ? "A ping when an agent or your Mac needs you"
                : paused
                  ? `Paused until ${until}`
                  : "On for this device"}
            </small>
          </span>
          {/* In the tap's call stack: Safari asks for permission only then. */}
          <input
            type="checkbox"
            role="switch"
            aria-label="Notifications"
            checked={on}
            disabled={busy}
            onChange={() => void state.toggle()}
          />
        </label>
        {on && preferences && (
          <div className="ns-row">
            <span className="ns-icon">
              <Moon size={18} />
            </span>
            <span className="ns-text">
              <strong>Pause</strong>
            </span>
            {paused ? (
              <button
                className="ns-chip"
                disabled={busy}
                onClick={() => void state.update({ pauseMinutes: 0 })}
              >
                Resume
              </button>
            ) : (
              <>
                <button
                  className="ns-chip"
                  disabled={busy}
                  onClick={() => void state.update({ pauseMinutes: 60 })}
                >
                  1 hour
                </button>
                <button
                  className="ns-chip"
                  disabled={busy}
                  onClick={() => void state.update({ pauseMinutes: 480 })}
                >
                  8 hours
                </button>
              </>
            )}
          </div>
        )}
        {install && (
          <div className="ns-row">
            <span className="ns-icon">
              <SquarePlus size={18} />
            </span>
            <span className="ns-text">
              <strong>Add to Home Screen</strong>
              <small>Open Reach like an app</small>
            </span>
            <button className="ns-chip" onClick={() => void install()}>
              Add
            </button>
          </div>
        )}
      </div>
      {on &&
        (preferences ? (
          <div className="ns-group" role="group" aria-label="Notify me about">
            {CATEGORIES.map(([key, label]) => (
              <label className="ns-row" key={key}>
                <span className="ns-text">
                  <strong>{label}</strong>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={preferences[key] !== false}
                  disabled={busy}
                  onChange={(e) =>
                    void state.update({
                      preferences: { [key]: e.target.checked },
                    })
                  }
                />
              </label>
            ))}
          </div>
        ) : (
          <button
            className="ns-link"
            disabled={busy}
            onClick={() => void state.refresh()}
          >
            Reload notification controls
          </button>
        ))}
      {on && (
        <button
          className="ns-link"
          disabled={busy}
          onClick={() => void state.test()}
        >
          Send a test notification
        </button>
      )}
      {note && (
        <p className="ns-note" role="status">
          {note}
        </p>
      )}
      {on && (
        <small className="ns-foot">
          For this device only. Your Mac needs to be awake and running Reach.
        </small>
      )}
    </section>
  );
}
