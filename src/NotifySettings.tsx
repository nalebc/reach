import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, Share } from "lucide-react";
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
  const here = sameComputer(peer.url);
  const refresh = useCallback(async () => {
    const version = generation.current;
    const current = pushSupport();
    setSupport(current);
    if (!active || !here || current === "unsupported") {
      setLoading(false);
      return;
    }
    try {
      await request(peer, "/api/push");
      if (version !== generation.current) return;
      setAllowed(true);
      const enabled = current === "ready" && (await pushEnabled(peer));
      if (version === generation.current) setOn(enabled);
      if (enabled) {
        const prefs = await notificationPreferences(peer);
        if (version === generation.current) setPreferences(prefs);
      }
    } catch (e) {
      if (version === generation.current) {
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

export function NotificationSetup({
  state,
}: {
  state: ReturnType<typeof useNotificationSetup>;
}) {
  const { support, on, allowed, loading, busy, note, here, preferences } =
    state;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const paused = on && !!preferences && preferences.pausedUntil > now;
  return (
    <section className="notification-setup" aria-label="Notification setup">
      <div className="notification-setup-heading">
        {on ? <Check size={18} /> : <Bell size={18} />}
        <strong>
          {on
            ? paused
              ? "Notifications are paused"
              : "Notifications on this device"
            : "Get notified when you're needed"}
        </strong>
      </div>
      <p>
        {on
          ? "Questions, approvals and app handoffs can reach you even when Reach is closed."
          : "Let Reach tell you when an agent needs an answer or your computer needs attention."}
      </p>
      {!here ? (
        <p>
          Open this computer's Reach address to enable notifications for it.
        </p>
      ) : loading ? (
        <p role="status">Checking this device…</p>
      ) : support === "home-screen" ? (
        <>
          <ol className="notification-steps">
            <li>
              In Safari, tap <Share size={14} aria-hidden="true" />{" "}
              <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Open <strong>Reach</strong> from its new Home Screen icon.
            </li>
            <li>
              Tap the bell, then <strong>Enable notifications</strong> and{" "}
              <strong>Allow</strong>.
            </li>
          </ol>
          <small>Requires iOS or iPadOS 16.4 or later.</small>
        </>
      ) : support === "denied" ? (
        <p>
          Notifications are blocked. On iPhone, open{" "}
          <strong>Settings → Notifications → Reach</strong> and turn on{" "}
          <strong>Allow Notifications</strong>. On a computer, allow
          notifications in this site's browser settings.
        </p>
      ) : support === "unsupported" ? (
        <p>
          This browser can't receive push notifications. Use an up-to-date
          browser over HTTPS; on iPhone, open Reach from the Home Screen.
        </p>
      ) : allowed ? (
        <div className="notification-setup-actions">
          <button
            className={`button ${on ? "ghost" : "primary"}`}
            disabled={busy}
            onClick={() => void state.toggle()}
          >
            {busy ? "Please wait…" : on ? "Turn off" : "Enable notifications"}
          </button>
          {on && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void state.test()}
            >
              Send test notification
            </button>
          )}
        </div>
      ) : (
        <button className="text-button" onClick={() => void state.refresh()}>
          Check again
        </button>
      )}
      {on &&
        allowed &&
        support === "ready" &&
        (preferences ? (
          <div className="notification-controls">
            <div className="notification-pause">
              {paused ? (
                <>
                  <p>
                    Paused until{" "}
                    {new Date(preferences.pausedUntil).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                    .
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void state.update({ pauseMinutes: 0 })}
                  >
                    Resume notifications
                  </button>
                </>
              ) : (
                <label>
                  Pause notifications
                  <select
                    aria-label="Pause notifications"
                    value=""
                    disabled={busy}
                    onChange={(e) =>
                      void state.update({
                        pauseMinutes: Number(e.target.value),
                      })
                    }
                  >
                    <option value="">Choose duration</option>
                    <option value="60">For 1 hour</option>
                    <option value="480">For 8 hours</option>
                  </select>
                </label>
              )}
            </div>
            <fieldset disabled={busy}>
              <legend>Notify me about</legend>
              {(
                [
                  ["chat", "Agent questions & approvals"],
                  ["computer", "Computer permission prompts"],
                  ["handoffs", "App handoffs"],
                  ["access", "Connection & access requests"],
                ] as const
              ).map(([key, label]) => (
                <label className="notification-preference" key={key}>
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={preferences[key]}
                    onChange={(e) =>
                      void state.update({
                        preferences: { [key]: e.target.checked },
                      })
                    }
                  />
                </label>
              ))}
            </fieldset>
            <small>
              These choices affect alerts on this device only. Pending requests
              still appear in Reach. Test notifications are always sent.
            </small>
          </div>
        ) : (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void state.refresh()}
          >
            Reload notification controls
          </button>
        ))}
      {on && (
        <small>Your computer must stay awake, online and running Reach.</small>
      )}
      {note && (
        <p className="form-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

export function NotifySettings({ peer }: { peer: Peer }) {
  const state = useNotificationSetup(peer);
  if (!state.here || state.support === "unsupported" || !state.allowed)
    return null;
  return (
    <div className="panel settings-panel">
      <NotificationSetup state={state} />
    </div>
  );
}
