import { workspaceCapabilities } from "./capabilities";
import { useFleetConnections } from "./useFleetConnections";
import { useEffect, useState } from "react";
import { Clock, Copy, Link2, LogOut } from "lucide-react";
import {
  ArrowUpRight,
  Check,
  FolderOpen,
  Monitor as MonitorIcon,
  PencilLine,
  Share2,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import "./invite.css";
import { Device, Peer, post, request } from "./api";
import { ErrorLine } from "./ui";
import Files from "./Files";
import Screen from "./Screen";
import { tailscaleShareUrl } from "./invitation";

// Invite someone: two calm steps. Reach only works over Tailscale, so the
// message itself must tell the guest how to get onto Tailscale first; an
// unreachable link cannot explain anything.
const DURATIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "1 day" },
];
export function GuestInvite({
  peer,
  device,
  onCreated,
}: {
  peer: Peer;
  device: Device;
  onCreated: () => void;
}) {
  const features = workspaceCapabilities(device);
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(1440);
  const [files, setFiles] = useState(device.roots.length > 0);
  const [write, setWrite] = useState(false);
  const [screen, setScreen] = useState(false);
  // Never preselect: the first shared folder is often the whole home folder.
  const [roots, setRoots] = useState<number[]>([]);
  const [invite, setInvite] = useState<{
    link: string;
    expiresAt: number;
    clientId: string;
    guest: string;
  } | null>(null);
  const [share, setShare] = useState("");
  const [onTailnet, setOnTailnet] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!invite) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invite]);
  const resetInvite = () => {
    setInvite(null);
    setShare("");
    setSent("");
    setName("");
    setOnTailnet(false);
    setError("");
  };
  const shareLink = tailscaleShareUrl(share);
  const tailscaleIp = device.network?.ips?.find((ip) => ip.startsWith("100."));
  const shareTarget = tailscaleIp
    ? `https://login.tailscale.com/admin/machines/${tailscaleIp}`
    : "https://login.tailscale.com/admin/machines";
  const ends = invite
    ? new Date(invite.expiresAt).toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const message = invite
    ? [
        `Hi ${invite.guest}! Here’s access to ${device.name} until ${ends}.`,
        "",
        ...(onTailnet
          ? [`With Tailscale on, open: ${invite.link}`]
          : [
              "1. Install Tailscale: https://tailscale.com/download",
              `2. Accept my share and sign in: ${shareLink}`,
              `3. With Tailscale on, open: ${invite.link}`,
            ]),
      ].join("\n")
    : "";
  const expired = !!invite && invite.expiresAt <= now;
  const ready = !!invite && !expired && !busy && (onTailnet || !!shareLink);
  const send = async () => {
    if (!ready || invite.expiresAt <= Date.now()) return;
    setError("");
    try {
      if (isNative) await NativeShare.share({ text: message });
      else if (navigator.share) await navigator.share({ text: message });
      else {
        await navigator.clipboard.writeText(message);
        setSent("Message copied");
        return;
      }
      setSent("Share sheet closed. You can copy the message if needed.");
    } catch (e) {
      // Closing the share sheet is not an error.
      if (!/cancel|abort/i.test((e as Error).message || (e as Error).name))
        setError("Couldn’t open sharing. Copy the message instead.");
    }
  };
  const copy = async () => {
    if (!ready || invite.expiresAt <= Date.now()) return;
    try {
      await navigator.clipboard.writeText(message);
      setSent("Message copied");
    } catch {
      setError("Select the message below and copy it.");
    }
  };
  if (invite)
    return (
      <section className="invite-flow" aria-live="polite">
        <div className="invite-done">
          <span className="invite-done-icon">
            <Check size={20} />
          </span>
          <div>
            <strong>
              {expired
                ? `Invite expired for ${invite.guest}`
                : `Invite ready for ${invite.guest}`}
            </strong>
            <small>
              <Clock size={13} /> Ends {ends}
            </small>
          </div>
        </div>
        <ol className="invite-steps">
          <li className={onTailnet || shareLink ? "done" : ""}>
            <h3>Share your computer on Tailscale</h3>
            <p>
              Reach is private: {invite.guest}’s phone reaches your computer
              only through Tailscale.
            </p>
            {!onTailnet && (
              <>
                <a
                  className="button secondary"
                  href={shareTarget}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Tailscale sharing <ArrowUpRight size={15} />
                </a>
                <label className="invite-paste">
                  Paste the share link Tailscale gives you
                  <input
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="https://login.tailscale.com/…"
                    value={share}
                    onChange={(e) => setShare(e.target.value)}
                  />
                </label>
                {share && !shareLink && (
                  <small className="invite-hint">
                    Use the device invitation link from Share → Copy link on
                    Tailscale’s page for this computer.
                  </small>
                )}
              </>
            )}
            <label className="invite-skip">
              <input
                type="checkbox"
                checked={onTailnet}
                onChange={(e) => setOnTailnet(e.target.checked)}
              />
              {invite.guest} can already reach this computer through Tailscale
            </label>
          </li>
          <li className={sent ? "done" : ""}>
            <h3>Send the invite</h3>
            <p>One message with everything {invite.guest} needs.</p>
            <div className="invite-actions">
              <button
                className="button primary"
                disabled={!ready}
                onClick={send}
              >
                <Share2 size={16} /> Send invite
              </button>
              <button
                className="button secondary"
                disabled={!ready}
                onClick={copy}
              >
                <Copy size={16} /> Copy
              </button>
            </div>
            {ready && <pre className="invite-message">{message}</pre>}
            {sent && <small className="invite-hint">{sent}</small>}
          </li>
        </ol>
        {expired && (
          <p className="invite-hint">
            Create a new invite to share access again.
          </p>
        )}
        <p className="invite-hint">
          Cancelling ends Reach access. To also remove the Tailscale connection,
          unshare this computer in Tailscale.
        </p>
        <ErrorLine error={error} />
        <div className="invite-footer">
          <button
            className="button ghost"
            disabled={busy}
            onClick={resetInvite}
          >
            Invite someone else
          </button>
          <button
            className="button ghost danger"
            disabled={busy}
            onClick={async () => {
              if (
                !confirm(
                  `Cancel ${invite.guest}’s invite? Their link and any active Reach access stop working.`,
                )
              )
                return;
              setBusy(true);
              setError("");
              try {
                await request(peer, `/api/clients/${invite.clientId}`, {
                  method: "DELETE",
                });
                resetInvite();
                onCreated();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Cancelling…" : "Cancel invite"}
          </button>
        </div>
      </section>
    );
  const chosen = device.roots.filter((r) => roots.includes(r.id));
  const access = [
    {
      id: "files",
      on: files,
      icon: FolderOpen,
      title: "See files",
      detail: "Browse and download",
      toggle: () => {
        setFiles(!files);
        if (files) setWrite(false);
      },
      available: device.roots.length > 0,
    },
    {
      id: "edit",
      on: write,
      icon: PencilLine,
      title: "Edit files",
      detail: "Upload and change",
      toggle: () => {
        setWrite(!write);
        if (!write) setFiles(true);
      },
      available: device.roots.length > 0,
    },
    {
      id: "screen",
      on: screen,
      icon: MonitorIcon,
      title: "Watch screen",
      detail: "View only",
      toggle: () => setScreen(!screen),
      available: features.screen,
    },
  ].filter((a) => a.available);
  // File access needs a deliberately chosen folder; something must be shared.
  const usable =
    (!files || roots.length > 0) && (files || (screen && features.screen));
  const homeFolder = (folder: string) =>
    /^\/(Users|home)\/[^/]+\/?$|^[A-Za-z]:\\Users\\[^\\]+\\?$/.test(folder);
  return (
    <form
      className="invite-flow"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        setBusy(true);
        try {
          const grant = await post(peer, "/api/guests", {
            name: name.trim(),
            ttlSeconds: minutes * 60,
            roots: files ? roots : [],
            write: files && write,
            screen: screen && features.screen,
          });
          const url = new URL(grant.url);
          url.hash = new URLSearchParams({
            invite: grant.invitation,
          }).toString();
          setInvite({
            link: url.toString(),
            expiresAt: grant.expiresAt,
            clientId: grant.clientId,
            guest: name.trim(),
          });
          onCreated();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="invite-name">
        Who is it for?
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoComplete="off"
        />
      </label>
      <fieldset className="invite-section">
        <legend>What can they do?</legend>
        <div className="invite-access">
          {access.map((a) => (
            <button
              type="button"
              key={a.id}
              className={`invite-card ${a.on ? "on" : ""}`}
              aria-pressed={a.on}
              onClick={a.toggle}
            >
              <a.icon size={20} />
              <strong>{a.title}</strong>
              <small>{a.detail}</small>
            </button>
          ))}
        </div>
        {files && device.roots.length > 0 && (
          <div className="invite-folders" role="group" aria-label="Folders to share">
            <span className="invite-folders-title">
              Which folders? They’ll see everything inside.
            </span>
            {device.roots.map((root) => (
              <label className="check-label" key={root.id}>
                <input
                  type="checkbox"
                  checked={roots.includes(root.id)}
                  onChange={(e) =>
                    setRoots(
                      e.target.checked
                        ? [...roots, root.id]
                        : roots.filter((id) => id !== root.id),
                    )
                  }
                />
                <span>
                  <strong>{root.name}</strong>
                  <small>{root.path}</small>
                </span>
              </label>
            ))}
            {chosen.some((r) => homeFolder(r.path)) && (
              <small className="invite-warning">
                This shares your entire home folder: documents, downloads and
                more. Choose a narrower folder if you can.
              </small>
            )}
          </div>
        )}
      </fieldset>
      <fieldset className="invite-section">
        <legend>For how long?</legend>
        <div className="invite-segments" role="radiogroup">
          {DURATIONS.map((d) => (
            <button
              type="button"
              role="radio"
              aria-checked={minutes === d.minutes}
              key={d.minutes}
              className={minutes === d.minutes ? "on" : ""}
              onClick={() => setMinutes(d.minutes)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </fieldset>
      <ErrorLine error={error} />
      <button
        className="button primary invite-create"
        disabled={busy || !name.trim() || !usable}
      >
        <UserPlus size={17} />
        {busy ? "Creating…" : "Create invite"}
      </button>
      <p className="invite-fine">
        <ShieldCheck size={14} /> They can’t run commands, control your screen
        or invite others. Access ends automatically.
      </p>
    </form>
  );
}

type GuestSession = { peer: Peer; expiresAt: number };
// Read once before React mounts; remove the invitation from browser history.
const invitation =
  typeof window === "undefined"
    ? ""
    : new URLSearchParams(window.location.hash.slice(1)).get("invite") || "";
if (invitation && window.location.pathname === "/guest")
  window.history.replaceState(null, "", "/guest");
const storageKey = "reach.guest-session";
function savedSession(): GuestSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    return value?.expiresAt > Date.now() &&
      value?.peer?.url === location.origin &&
      typeof value?.peer?.token === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export default function GuestAccess() {
  const [session, setSession] = useState<GuestSession | null>(() =>
    invitation ? null : savedSession(),
  );
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [page, setPage] = useState("files");
  useFleetConnections(session ? [session.peer] : []);
  const [notice, setNotice] = useState("");
  const end = () => {
    sessionStorage.removeItem(storageKey);
    setSession(null);
    setDevice(null);
    setEnded(true);
    setError("");
  };
  useEffect(() => {
    if (!session) return;
    let active = true;
    const check = async () => {
      if (Date.now() >= session.expiresAt) {
        if (active) end();
        return;
      }
      try {
        const value = await request<Device>(session.peer, "/api/device");
        if (active) {
          setDevice(value);
          setError("");
        }
      } catch (e) {
        if (active) {
          if ((e as Error & { status?: number }).status === 401) {
            end();
            return;
          }
          setDevice(null);
          setError((e as Error).message);
        }
      }
    };
    void check();
    const poll = setInterval(check, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const deadline = setTimeout(
      end,
      Math.max(0, session.expiresAt - Date.now()),
    );
    const visible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(poll);
      clearInterval(clock);
      clearTimeout(deadline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [session]);
  const remaining = session
    ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000))
    : 0;
  return (
    <main className="guest-workspace">
      <header className="guest-header">
        <strong>REACH · Guest access</strong>
        {session && (
          <>
            <span role="timer">
              <Clock size={16} />
              {remaining >= 3600
                ? `${Math.floor(remaining / 3600)} h ${Math.floor((remaining % 3600) / 60)} min left`
                : remaining >= 60
                  ? `${Math.ceil(remaining / 60)} min left`
                  : `${remaining} s left`}
            </span>
            <button
              className="button secondary small"
              onClick={async () => {
                try {
                  await request(session.peer, "/api/device/access", {
                    method: "DELETE",
                  });
                  end();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={16} />
              Leave
            </button>
          </>
        )}
      </header>
      <ErrorLine error={error} />
      {!session ? (
        <section className="panel settings-panel">
          <h1>
            {ended ? "Access ended" : "A temporary window into their laptop"}
          </h1>
          <p>
            {ended
              ? "You’re disconnected. Ask the owner for a new invitation to reconnect."
              : "Connect to use the folders and screen the owner chose to share. Access ends at the owner’s deadline, even if you reconnect."}
          </p>
          {!ended && invitation && (
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const response = await fetch("/api/guest/redeem", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ invitation }),
                    redirect: "error",
                  });
                  const result = await response.json();
                  if (!response.ok) throw Error(result.error);
                  const value = {
                    peer: {
                      ...result.device,
                      url: location.origin,
                      token: result.token,
                    },
                    expiresAt: result.expiresAt,
                  };
                  sessionStorage.setItem(storageKey, JSON.stringify(value));
                  setSession(value);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Connecting…" : "Accept invitation"}
            </button>
          )}
          {!ended && !invitation && (
            <p>
              Open the private link the laptop owner sent you. Connect to
              Tailscale first.
            </p>
          )}
        </section>
      ) : (
        device && (
          <>
            <nav className="guest-tabs" aria-label="Shared access">
              {device.capabilities.files && (
                <button
                  className={`button ${page === "files" ? "primary" : "secondary"}`}
                  onClick={() => setPage("files")}
                >
                  Files
                </button>
              )}
              {workspaceCapabilities(device).screen && (
                <button
                  className={`button ${page === "screen" ? "primary" : "secondary"}`}
                  onClick={() => setPage("screen")}
                >
                  Screen
                </button>
              )}
            </nav>
            {(page === "files" || !workspaceCapabilities(device).screen) &&
            device.capabilities.files ? (
              <Files
                peer={session.peer}
                device={device}
                peers={[]}
                onSession={() => {}}
                toast={setNotice}
              />
            ) : workspaceCapabilities(device).screen ? (
              <Screen
                peer={session.peer}
                device={device}
                toast={setNotice}
                onChanged={() => {}}
              />
            ) : (
              <p>
                No shared features are available right now. Ask the computer
                owner to check your access.
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
          </>
        )
      )}
    </main>
  );
}
