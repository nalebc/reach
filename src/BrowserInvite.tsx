import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Folder,
  Monitor,
  Share2,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { shareCancelled } from "./sharing";
import { post, request, type Device, type Peer } from "./api";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import "./browser-workspace.css";

type Options = {
  terminals: { id: string; name: string }[];
  screenAvailable: boolean;
};
type Created = { peer: Peer; clientId: string; invitation: string };

type InvitePermissions = {
  screen: "off" | "view" | "scroll" | "ask";
  folders: string[];
  terminalOutputs: number;
  restrictedTerminal: boolean;
  terminalApproval: boolean;
};
const museMessage = (link: string, permissions: InvitePermissions) => {
  const screen = {
    off: "Screen: not shared.",
    view: "Screen: view only; no input.",
    scroll: "Screen: view and scroll directly; clicks/typing unavailable.",
    ask: "Screen: view and request clicks, typing, keys or scrolling; owner approval covers up to five exact actions.",
  }[permissions.screen];
  const folderNames = permissions.folders.slice(0, 3).map((folder) => JSON.stringify(folder.length > 160 ? folder.slice(0, 157) + "…" : folder).replace(/[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)).join(", ");
  const files = permissions.folders.length
    ? `Files: read/search/download only in ${folderNames}${permissions.folders.length > 3 ? ` and ${permissions.folders.length - 3} more shown in Files` : ""}.`
    : "Files: not shared.";
  const output = permissions.terminalOutputs
    ? `Terminal output: ${permissions.terminalOutputs} selected session${permissions.terminalOutputs === 1 ? "" : "s"}, read-only.`
    : "Terminal output: not shared.";
  const commands = permissions.restrictedTerminal
    ? permissions.terminalApproval
      ? "Commands: reads run directly; file changes and scripts ask for approval once. No network, sudo or helper processes."
      : "Commands: supported read-only commands run directly in shared folders; other commands are blocked."
    : "Commands: not enabled.";
  const boundary = permissions.restrictedTerminal ? " Terminal commands cannot access outside these folders, even with approval." : "";
  return `Open this temporary Reach link in your VM browser. Keep it open; show the connection code for admission. ${screen} ${files} ${output} ${commands}${boundary} Use Screen/Files/Terminal (window.reach optional). Never invite anyone, delegate access, or share this link or credentials.\n\n${link}`;
};

export default function BrowserInvite({
  peer,
  device,
  onCreated,
}: {
  peer: Peer;
  device: Device;
  keyPeer: Peer | null;
  onSetup: () => void;
  onCreated: (created: Created, link: string) => void;
}) {
  const [name, setName] = useState("Assistant");
  const [minutes, setMinutes] = useState(15);
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const [screen, setScreen] = useState<"off" | "view" | "scroll" | "ask">(
    "off",
  );
  const [restrictedTerminal, setRestrictedTerminal] = useState(false);
  const [terminalApproval, setTerminalApproval] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState("");
  const [made, setMade] = useState<{
    link: string;
    name: string;
    expiresAt: number;
    joinBy: number;
    message: string;
  } | null>(null);

  useEffect(() => {
    let live = true;
    request<Options>(peer, "/api/agents/browser-options")
      .then((value) => live && setOptions(value))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [peer.url, peer.token]);

  const create = async () => {
    if (
      busy ||
      !name.trim() ||
      (!folders.length &&
        !terminalIds.length &&
        screen === "off" &&
        !restrictedTerminal) ||
      (restrictedTerminal && !folders.length)
    )
      return;
    setBusy(true);
    setError("");
    setCopied(false);
    setShareNote("");
    let created: Created | null = null;
    try {
      const result = await post<{
        invitation: string;
        clientId: string;
        expiresAt: number;
        joinBy: number;
        url: string;
      }>(peer, "/api/agents/browser-invitations", {
        name: name.trim(),
        transport: "funnel",
        ttlSeconds: minutes * 60,
        folders: folders.map(({ root, path }) => ({ root, path })),
        terminalIds,
        screen,
        ...(restrictedTerminal ? { restrictedTerminal: true } : {}),
        ...(terminalApproval ? { terminalApproval: true, scriptApproval: true } : {}),
      });
      created = {
        peer,
        clientId: result.clientId,
        invitation: result.invitation,
      };
      const url = new URL(result.url);
      if (
        url.protocol !== "https:" ||
        url.pathname !== "/agent-browser" ||
        url.username ||
        url.password ||
        url.search ||
        new URLSearchParams(url.hash.slice(1)).get("invite") !==
          result.invitation
      )
        throw Error("The temporary connection link could not be prepared.");
      const link = url.href;
      setMade({
        link,
        name: name.trim(),
        expiresAt: result.expiresAt,
        joinBy: result.joinBy,
        // Describe this issued invitation, not later unsaved form edits.
        message: museMessage(link, { screen, folders: folders.map((folder) => folder.full || folder.label), terminalOutputs: terminalIds.length, restrictedTerminal, terminalApproval }),
      });
      onCreated(created, link);
    } catch (e) {
      if (created)
        await request(peer, `/api/clients/${created.clientId}`, {
          method: "DELETE",
        }).catch(() => {});
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyMessage = async () => {
    if (!made) return;
    setShareNote("");
    try {
      await navigator.clipboard.writeText(made.message);
      setCopied(true);
    } catch {
      setShareNote("Select the message below and copy it.");
    }
  };
  const shareMessage = async () => {
    if (!made) return;
    setShareNote("");
    try {
      const text = made.message;
      if (isNative)
        await NativeShare.share({ title: "Connect to Reach", text });
      else if (navigator.share)
        await navigator.share({ title: "Connect to Reach", text });
      else await copyMessage();
    } catch (e) {
      if (!shareCancelled(e))
        setShareNote(
          "Couldn’t open sharing. Copy the prompt and link instead.",
        );
    }
  };

  return (
    <section className="browser-invite" aria-label="AI browser invitation">
      <div className="ivt-add">
        <label className="ivt-field-label" htmlFor="browser-invite-name">
          Agent name
        </label>
        <input
          id="browser-invite-name"
          className="ivt-name"
          aria-label="AI browser name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="ivt-browser-settings">
        <span className="ivt-field-label">What can it access?</span>
        <div className="ivt-permissions">
          <details className="ivt-disclosure">
            <summary>
              <Folder size={17} />
              <span>Files</span>
              <small>
                {folders.length ? `${folders.length} selected` : "None"}
              </small>
              <ChevronDown size={15} />
            </summary>
            <div className="ivt-disclosure-body">
              <p className="ivt-quiet">
                Read and download only.
              </p>
              <FolderBrowser
                peer={peer}
                device={device}
                picked={folders}
                onChange={setFolders}
              />
            </div>
          </details>
          <details className="ivt-disclosure">
            <summary>
              <Terminal size={17} />
              <span>Terminal output</span>
              <small>
                {terminalIds.length ? `${terminalIds.length} selected` : "None"}
              </small>
              <ChevronDown size={15} />
            </summary>
            <div className="ivt-disclosure-body">
              <p className="ivt-quiet">
                View output only.
              </p>
              {!options ? (
                <p className="ivt-quiet">Loading terminals…</p>
              ) : !options.terminals.length ? (
                <p className="ivt-quiet">
                  No open terminals.
                </p>
              ) : (
                options.terminals.map((terminal) => (
                  <label className="ivt-toggle" key={terminal.id}>
                    <span>
                      {terminal.name}
                      <small>
                        {terminal.id.startsWith("reach:")
                          ? "Reach terminal"
                          : "iTerm2 session"}{" "}
                        · output only
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={terminalIds.includes(terminal.id)}
                      onChange={(e) =>
                        setTerminalIds((current) =>
                          e.target.checked
                            ? [...current, terminal.id]
                            : current.filter((id) => id !== terminal.id),
                        )
                      }
                    />
                  </label>
                ))
              )}
            </div>
          </details>
          {options?.screenAvailable && (
            <details className="ivt-disclosure">
              <summary>
                <Monitor size={17} />
                <span>Screen</span>
                <small>
                  {
                    {
                      off: "None",
                      view: "View only",
                      scroll: "View & scroll",
                      ask: "With approval",
                    }[screen]
                  }
                </small>
                <ChevronDown size={15} />
              </summary>
              <div className="ivt-disclosure-body">
                <select
                  className="ivt-field"
                  aria-label="Screen permission"
                  value={screen}
                  onChange={(e) => setScreen(e.target.value as typeof screen)}
                >
                  <option value="off">No screen access</option>
                  <option value="view">View only</option>
                  <option value="scroll">View and scroll</option>
                  <option value="ask">Control with approval</option>
                </select>
                <p className="ivt-quiet">
                  {screen === "off"
                    ? "Your screen stays private."
                    : screen === "view"
                      ? "Share your full display, view only."
                      : screen === "ask"
                        ? "Approve actions in any app, including Terminal."
                        : "Share your full display with scrolling."}
                </p>
              </div>
            </details>
          )}
          <details className="ivt-disclosure">
            <summary>
              <ShieldCheck size={17} />
              <span>Terminal commands</span>
              <small>{terminalApproval ? "With approval" : restrictedTerminal ? "Read-only" : "Off"}</small>
              <ChevronDown size={15} />
            </summary>
            <div className="ivt-disclosure-body">
              <label className="ivt-toggle">
                <span>
                  Run read-only commands
                  <small>Supported commands run in shared folders without asking.</small>
                </span>
                <input
                  type="checkbox"
                  checked={restrictedTerminal}
                  onChange={(e) => {
                    setRestrictedTerminal(e.target.checked);
                    if (!e.target.checked) setTerminalApproval(false);
                  }}
                />
              </label>
              <label className="ivt-toggle">
                <span>Commands with approval<small>File changes and scripts run only after you approve the exact command.</small></span>
                <input type="checkbox" checked={terminalApproval} onChange={(e) => {
                  setTerminalApproval(e.target.checked);
                  if (e.target.checked) setRestrictedTerminal(true);
                }} />
              </label>
              <p className="ivt-quiet">{terminalApproval ? "Approve each command once. Scripts stay inside the shared folder; no network, sudo or helper processes." : "No sudo, deletion or file changes through command tools."}</p>
            </div>
          </details>
        </div>
      </div>
      <label className="ivt-connection">
        Expires in
        <select
          className="ivt-field"
          aria-label="Access duration"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          <option value={15}>15 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
        </select>
      </label>
      <div className="ivt-send">
        {((restrictedTerminal && !folders.length) ||
          (!folders.length && !terminalIds.length && screen === "off" && !restrictedTerminal)) && (
          <p className="ivt-summary muted">
            {restrictedTerminal ? "Choose a folder under Files." : "Choose what to share."}
          </p>
        )}
        <button
          className="ivt-primary ivt-submit"
          disabled={
            busy ||
            !name.trim() ||
            (restrictedTerminal && !folders.length) ||
            (!folders.length &&
              !terminalIds.length &&
              screen === "off" &&
              !restrictedTerminal)
          }
          onClick={() => void create()}
        >
          {busy ? "Creating link…" : "Create invite link"}
          <ArrowUpRight size={17} />
        </button>
        <span className="ivt-reassurance">
          <ShieldCheck size={13} /> You approve access. End it anytime.
        </span>
      </div>
      {error && (
        <p className="ivt-error" role="alert">
          {error}
        </p>
      )}
      {made && (
        <section
          className="ivt-link"
          aria-label="AI browser invite link"
          aria-live="polite"
        >
          <strong>{made.name}’s browser invite</strong>
          <p className="ivt-quiet">
            Paste into {made.name}. Join by{" "}
            {new Date(made.joinBy).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
             · Ends at{" "}
            {new Date(made.expiresAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            .
          </p>
          <textarea
            className="browser-invite-message"
            aria-label="AI browser invitation message"
            readOnly
            rows={3}
            value={made.message}
            onFocus={(e) => e.target.select()}
          />
          <div className="ivt-link-row">
            <button
              className="ivt-primary small"
              onClick={() => void copyMessage()}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
              {copied ? "Copied" : "Copy prompt + link"}
            </button>
            <button
              className="ivt-secondary small"
              onClick={() => void shareMessage()}
            >
              <Share2 size={15} /> Share…
            </button>
          </div>
          {shareNote && (
            <p className="ivt-quiet" role="status">
              {shareNote}
            </p>
          )}
          <small className="ivt-quiet">
            Match the connection code in Home → Needs you to approve.
          </small>
        </section>
      )}
    </section>
  );
}
