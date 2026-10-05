import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { request, type Peer } from "./api";
import { AppIcon } from "./AppIcon";
import { sameComputer } from "./passkeys";
import {
  disablePush,
  enablePush,
  pushEnabled,
  pushSupport,
  type PushSupport,
} from "./push";

// Settings: notifications on this phone when something needs you (an agent
// hands you an app, asks a question, or asks for access). Only from the
// computer this page comes from; on iPhone, only from the Home Screen.
export function NotifySettings({ peer }: { peer: Peer }) {
  const [support] = useState<PushSupport>(() => pushSupport());
  const [on, setOn] = useState(false);
  // Only your own devices may: guests and others see nothing here.
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const here = sameComputer(peer.url);
  useEffect(() => {
    if (support === "unsupported" || !here) return;
    let live = true;
    request(peer, "/api/push")
      .then(() => {
        if (!live) return;
        setAllowed(true);
        if (support === "ready")
          return pushEnabled(peer).then((value) => live && setOn(value));
      })
      .catch(() => live && setAllowed(false));
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, support, here]);
  if (!here || support === "unsupported" || !allowed) return null;
  const toggle = async () => {
    setBusy(true);
    setNote("");
    try {
      if (on) await disablePush(peer);
      else await enablePush(peer);
      setOn(!on);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel settings-panel" aria-label="Notifications">
      <div className="switch-row">
        <AppIcon tone="screen" size="small">
          <Bell size={17} strokeWidth={2} />
        </AppIcon>
        <div>
          <strong>Notifications</strong>
          <small>
            {support === "home-screen"
              ? "Add Reach to your Home Screen to get them."
              : support === "denied"
                ? "Turned off for Reach in this phone's settings."
                : "When an agent needs you, and Reach isn't open."}
          </small>
        </div>
        {support === "ready" && (
          <button
            role="switch"
            aria-checked={on}
            aria-label="Notifications"
            className={`switch ${on ? "on" : ""}`}
            disabled={busy}
            onClick={() => void toggle()}
          >
            <span />
          </button>
        )}
      </div>
      {note && <p className="form-note">{note}</p>}
    </section>
  );
}
