import { useState } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Monitor } from "lucide-react";
import { Modal } from "./ui";
import { type Peer, type Device, request } from "./api";
const Desktop = registerPlugin<{
  open(options: {
    url: string;
    token: string;
    mode: string;
    clipboard: boolean;
    uploadRoot?: number;
  }): Promise<void>;
}>("ReachDesktop");
type Check = {
  id: string;
  ready: boolean | null;
  title: string;
  instruction: string;
};
export default function DesktopMode({
  peer,
  device,
  beforeOpen,
  afterClose,
}: {
  peer: Peer;
  device: Device;
  beforeOpen: () => Promise<void>;
  afterClose: () => void;
}) {
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState("match"),
    [clipboard, setClipboard] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [root, setRoot] = useState<number | undefined>(device.roots[0]?.id),
    [checks, setChecks] = useState<Check[]>([]);
  const native = Capacitor.isPluginAvailable("ReachDesktop");
  async function prepare() {
    setOpen(true);
    setError("");
    try {
      const info = await request<{ checks: Check[] }>(
        peer,
        "/api/screen/prepare",
      );
      setChecks(info.checks);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      await beforeOpen();
      await Desktop.open({
        url: peer.url,
        token: peer.token,
        mode,
        clipboard,
        uploadRoot: root,
      });
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      afterClose();
      setBusy(false);
    }
  }
  const ipad =
    /iPad/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!native || !ipad) return null;
  return (
    <>
      <button className="button secondary small" onClick={() => void prepare()}>
        <Monitor size={16} /> iPad desktop
      </button>
      {open && (
        <Modal
          title="Your Mac, with you"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p>
            Use your iPad keyboard and mouse over your private Tailscale
            connection.
          </p>
          <label className="screen-option">
            Display
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="match">Match iPad</option>
              <option value="mirror">Mirror main display</option>
            </select>
          </label>
          <p className="muted">
            Match iPad creates a temporary HiDPI display. Virtual display
            support is experimental on macOS. If unavailable, connect an HDMI
            dummy plug and use Mirror main display.
          </p>
          <label className="screen-option">
            <span>Sync clipboard · text and images</span>
            <input
              type="checkbox"
              checked={clipboard}
              onChange={(e) => setClipboard(e.target.checked)}
            />
          </label>
          {device.roots.length > 0 && (
            <label className="screen-option">
              Save dropped files to
              <select
                value={root}
                onChange={(e) => setRoot(Number(e.target.value))}
              >
                {device.roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <details>
            <summary>Prepare this Mac as a remote computer</summary>
            {checks.map((c) => (
              <div key={c.id}>
                <h4>
                  {c.ready === true ? "✓ " : ""}
                  {c.title}
                </h4>
                <p>{c.instruction}</p>
              </div>
            ))}
            <p>
              Install Reach’s background service with{" "}
              <code>./reach install</code>. Test from your iPad before leaving.
              A power outage or FileVault restart may still require someone at
              the Mac.
            </p>
          </details>
          {error && <p role="alert">{error}</p>}
          {native ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void connect()}
            >
              {busy ? "Desktop open…" : "Open desktop"}
            </button>
          ) : (
            <p>
              Open this connection in the Reach iPad app for native keyboard and
              pointer lock. The screen below continues to use browser video with
              a compatibility fallback.
            </p>
          )}
          <p className="muted">
            Starts in view-only mode. Tap Control in the desktop toolbar to
            grant input. Audio is planned for phase 2.
          </p>
        </Modal>
      )}
    </>
  );
}
