import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  Check,
  ChevronDown,
  Copy,
  Dices,
  Folder,
  Lock,
  Share2,
  ShieldCheck,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { shareCancelled } from "./sharing";
import { request, type Device, type Peer } from "./api";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import {
  AgentAvatar,
  AppPicker,
  AppStack,
  Choices,
  Segments,
  Switch,
  SwitchLine,
} from "./agent-ui";
import "./browser-workspace.css";
import "./agent-invite.css";

type Options = {
  terminals: { id: string; name: string }[];
  screenAvailable: boolean;
  appAccessAvailable?: boolean;
  appAccessError?: string;
  apps?: { id: string; name: string; protected: boolean; reason?: string }[];
};
type Created = { peer: Peer; clientId: string; invitation: string };

type InvitePermissions = {
  screen: "off" | "apps";
  apps: { name: string; mode: "view" | "control" }[];
  folders: string[];
  terminalOutputs: number;
  restrictedTerminal: boolean;
  terminalApproval: boolean;
};
const museMessage = (link: string, permissions: InvitePermissions) => {
  const screen =
    permissions.screen === "apps"
      ? `Apps: ${permissions.apps.length ? permissions.apps.map((app) => `${JSON.stringify(app.name)} (view only)`).join(", ") : "none shared yet"}. In Screen, view a shared window. Screen input is unavailable; use scoped terminal commands for approved changes. Other eligible apps are hidden; ask to view them. Reach, Tailscale and host browsers cannot be shared. Grants expire with this invitation.`
      : "Screen: not shared.";
  const folderNames = permissions.folders
    .slice(0, 3)
    .map((folder) =>
      JSON.stringify(folder.length > 160 ? folder.slice(0, 157) + "…" : folder).replace(
        /[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    )
    .join(", ");
  const files = permissions.folders.length
    ? `Files: read/search/download only in ${folderNames}${permissions.folders.length > 3 ? ` and ${permissions.folders.length - 3} more shown in Files` : ""}.`
    : "Files: not shared.";
  const shared = permissions.folders.length
    ? " These are shared original folders; approved changes affect them directly."
    : "";
  const output = permissions.terminalOutputs
    ? `Terminal output: ${permissions.terminalOutputs} selected session${permissions.terminalOutputs === 1 ? "" : "s"}, read-only.`
    : "Terminal output: not shared.";
  const commands = permissions.restrictedTerminal
    ? permissions.terminalApproval
      ? "Commands: reads run directly; file changes and scripts ask for approval once. No network, sudo or helper processes."
      : "Commands: supported read-only commands run directly in shared folders; other commands are blocked."
    : "Commands: not enabled.";
  const boundary = permissions.restrictedTerminal
    ? " Terminal commands cannot access outside these folders, even with approval."
    : "";
  return `Open this temporary Reach link in your VM browser. Keep it open; show the connection code for admission. ${screen} ${files}${shared} ${output} ${commands}${boundary} Use Screen/Files/Terminal (window.reach optional). Never invite anyone, delegate access, or share this link or credentials.\n\n${link}`;
};

// Every invite gets a fresh, silly name; the dice roll another.
const quirks = ["Sneaky", "Cosmic", "Turbo", "Fluffy", "Sleepy", "Dapper", "Wobbly", "Jazzy", "Spicy", "Grumpy", "Sparkly", "Noble", "Bouncy", "Mighty", "Quantum", "Velvet", "Zesty", "Snazzy", "Crispy", "Lucky"];
const critters = ["Penguin", "Pickle", "Noodle", "Waffle", "Otter", "Toaster", "Llama", "Nugget", "Pixel", "Walrus", "Muffin", "Badger", "Taco", "Narwhal", "Biscuit", "Gecko", "Raccoon", "Dumpling", "Wombat", "Pretzel"];
export const inviteName = (random = Math.random, not = "") => {
  for (;;) {
    const name = `${quirks[Math.floor(random() * quirks.length)]} ${critters[Math.floor(random() * critters.length)]}`;
    if (name !== not) return name;
  }
};

type Level = "off" | "watch" | "read" | "approve";

// One thing the agent may use: a switch, and when it's on, its choices
// open right under it.
function Grant({
  icon,
  label,
  switchLabel,
  value,
  on,
  open,
  disabled,
  attention,
  onSwitch,
  onOpen,
  children,
}: {
  icon: ReactNode;
  label: string;
  switchLabel: string;
  value: ReactNode;
  on: boolean;
  open: boolean;
  disabled?: boolean;
  attention?: boolean;
  onSwitch: (on: boolean) => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  const shown = on && open;
  return (
    <div className={`ag-row ag-grant${shown ? " is-open" : ""}${on ? " is-on" : ""}`}>
      <div className="ag-grant-head">
        <button
          type="button"
          className="ag-row-head"
          aria-expanded={shown}
          disabled={disabled}
          onClick={() => (on ? onOpen() : onSwitch(true))}
        >
          <span className="ag-row-icon">{icon}</span>
          <span className="ag-row-label">{label}</span>
          <span className={`ag-row-value${attention ? " is-attention" : ""}`}>
            {on ? value : ""}
          </span>
        </button>
        <Switch label={switchLabel} checked={on} disabled={disabled} onChange={onSwitch} />
      </div>
      {/* Kept in the page while closed, so choices and browsing survive. */}
      <div className="ag-row-body" hidden={!shown}>
        {children}
      </div>
    </div>
  );
}

type Props = {
  peer: Peer;
  device: Device;
  keyPeer: Peer | null;
  onSetup: () => void;
  onCreated: (created: Created, link: string) => void;
};
export default function BrowserInvite(props: Props) {
  return (
    <BrowserInviteForm
      key={`${props.peer.id}:${props.peer.url}:${props.peer.token}`}
      {...props}
    />
  );
}
function BrowserInviteForm({ peer, device, onCreated }: Props) {
  const [name, setName] = useState(() => inviteName());
  const [minutes, setMinutes] = useState(15);
  const [foldersOn, setFoldersOn] = useState(false);
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const [screen, setScreen] = useState<"off" | "apps">("off");
  const [appAccess, setAppAccess] = useState<
    Record<string, "view" | "control">
  >({});
  const [level, setLevel] = useState<Level>("off");
  const [options, setOptions] = useState<Options | null>(null);
  // Which grant is open; one at a time keeps the page short.
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showMessage, setShowMessage] = useState(false);
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
  const alive = useRef(true);
  const creation = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      creation.current?.abort();
    };
  }, []);

  useEffect(() => {
    let live = true;
    request<Options>(peer, "/api/agents/browser-options")
      .then((value) => live && setOptions(value))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [peer.url, peer.token]);

  const restrictedTerminal = level === "read" || level === "approve";
  const terminalApproval = level === "approve";
  const nothing =
    !folders.length && !terminalIds.length && screen === "off" && !restrictedTerminal;
  const missing = !name.trim()
    ? "Name the agent."
    : restrictedTerminal && !folders.length
      ? "Commands need a folder. Choose one under Folders."
      : nothing
        ? "Turn on at least one thing it can use."
        : "";

  const create = async () => {
    if (busy || missing || (!!folders.length && !options)) return;
    setBusy(true);
    setError("");
    setCopied(false);
    setShareNote("");
    let created: Created | null = null;
    const controller = new AbortController();
    creation.current = controller;
    try {
      const result = await request<{
        invitation: string;
        clientId: string;
        expiresAt: number;
        joinBy: number;
        url: string;
      }>(peer, "/api/agents/browser-invitations", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          name: name.trim(),
          transport: "funnel",
          ttlSeconds: minutes * 60,
          folders: folders.map(({ root, path }) => ({ root, path })),
          terminalIds,
          screen,
          ...(screen === "apps"
            ? {
                appAccess: Object.entries(appAccess).map(([id, mode]) => ({
                  id,
                  mode,
                })),
              }
            : {}),
          ...(restrictedTerminal ? { restrictedTerminal: true } : {}),
          ...(terminalApproval
            ? { terminalApproval: true, scriptApproval: true }
            : {}),
        }),
      });
      created = {
        peer,
        clientId: result.clientId,
        invitation: result.invitation,
      };
      if (!alive.current || controller.signal.aborted)
        throw Error("Invitation creation was cancelled.");
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
        message: museMessage(link, {
          screen,
          apps: (options?.apps || [])
            .filter((app) => appAccess[app.id] && !app.protected)
            .map((app) => ({ name: app.name, mode: appAccess[app.id] })),
          folders: folders.map((folder) => folder.full || folder.label),
          terminalOutputs: terminalIds.length,
          restrictedTerminal,
          terminalApproval,
        }),
      });
      onCreated(created, link);
    } catch (e) {
      if (created)
        await request(peer, `/api/clients/${created.clientId}`, {
          method: "DELETE",
        }).catch(() => {});
      if (alive.current && !controller.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (alive.current && !controller.signal.aborted) setBusy(false);
      if (creation.current === controller) creation.current = null;
    }
  };

  const copyMessage = async () => {
    if (!made) return;
    setShareNote("");
    try {
      await navigator.clipboard.writeText(made.message);
      setCopied(true);
    } catch {
      setShowMessage(true);
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

  const eligibleApps = (options?.apps || []).filter((app) => !app.protected);
  const chosenApps = eligibleApps.filter((app) => appAccess[app.id]);
  const appsReady = !!options?.appAccessAvailable;
  const terminalOn = level !== "off" || !!terminalIds.length;
  const toggleRow = (row: string) =>
    setOpenRow((current) => (current === row ? null : row));
  const listWords = (items: string[]) =>
    items.length <= 1
      ? items.join("")
      : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const minutesLabel = minutes === 60 ? "1 hour" : `${minutes} minutes`;
  const summary = `${name.trim()} can ${listWords(
    [
      folders.length
        ? `read ${folders.length === 1 ? folders[0].label : `${folders.length} folders`}`
        : "",
      screen === "apps"
        ? chosenApps.length
          ? `see ${listWords(chosenApps.slice(0, 2).map((app) => app.name))}${chosenApps.length > 2 ? ` and ${chosenApps.length - 2} more` : ""}`
          : "ask to see apps"
        : "",
      terminalIds.length
        ? `watch ${terminalIds.length} ${terminalIds.length === 1 ? "terminal" : "terminals"}`
        : "",
      terminalApproval
        ? "run commands you approve"
        : restrictedTerminal
          ? "run read-only commands"
          : "",
    ].filter(Boolean),
  )} for ${minutesLabel}.`;
  const at = (value: number) =>
    new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const pickFolders = (picked: PickedFolder[]) => {
    setFolders(picked);
    if (picked.length) setFoldersOn(true);
  };
  const pickLevel = (value: Level) => setLevel(value);
  const watch = (id: string, on: boolean) => {
    setTerminalIds((current) =>
      on ? [...current, id] : current.filter((x) => x !== id),
    );
    if (on && level === "off") setLevel("watch");
  };

  return (
    <section className="browser-invite ag-invite" aria-label="AI browser invitation">
      <div className="ag-invite-form" hidden={!!made}>
        <div className="ag-identity">
          <AgentAvatar name={name || "?"} size={44} />
          <input
            id="browser-invite-name"
            className="ag-identity-name"
            aria-label="AI browser name"
            value={name}
            maxLength={80}
            placeholder="Name the agent"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="ag-roll"
            aria-label="New name"
            onClick={() => setName((current) => inviteName(Math.random, current))}
          >
            <Dices size={19} />
          </button>
        </div>

        <div className="ag-rows">
          <Grant
            icon={<Folder />}
            label="Folders"
            switchLabel="Share folders"
            value={
              folders.length
                ? folders.length === 1
                  ? folders[0].label
                  : `${folders.length} folders`
                : "Choose…"
            }
            attention={!folders.length && (foldersOn || restrictedTerminal)}
            on={foldersOn || !!folders.length}
            open={openRow === "folders"}
            onOpen={() => toggleRow("folders")}
            onSwitch={(on) => {
              setFoldersOn(on);
              if (!on) setFolders([]);
              setOpenRow(on ? "folders" : null);
            }}
          >
            <p className="ag-quiet">It reads your real folders. Changes only happen through commands you allow.</p>
            <FolderBrowser
              peer={peer}
              device={device}
              picked={folders}
              onChange={pickFolders}
            />
          </Grant>

          <Grant
            icon={<AppWindow />}
            label="Apps"
            switchLabel="Share apps"
            value={chosenApps.length ? <AppStack peer={peer} apps={chosenApps} /> : "Ask first"}
            disabled={!appsReady}
            on={screen === "apps"}
            open={openRow === "apps"}
            onOpen={() => toggleRow("apps")}
            onSwitch={(on) => {
              setScreen(on ? "apps" : "off");
              if (!on) setAppAccess({});
              setOpenRow(on ? "apps" : null);
            }}
          >
            <p className="ag-quiet">View only. It can ask you for more apps later.</p>
            {screen === "apps" && (
              <AppPicker
                peer={peer}
                apps={options?.apps || []}
                chosen={Object.keys(appAccess)}
                onChange={(ids) =>
                  setAppAccess(
                    Object.fromEntries(
                      ids.map((id) => [id, appAccess[id] || "view"]),
                    ),
                  )
                }
              />
            )}
            <p className="ag-note">
              <ShieldCheck size={14} />
              Reach on this Mac is locked during this invitation.
            </p>
          </Grant>

          <Grant
            icon={<SquareTerminal />}
            label="Terminal"
            switchLabel="Allow terminal"
            value={
              level === "approve"
                ? "Ask me first"
                : level === "read"
                  ? "Read-only"
                  : terminalIds.length
                    ? `Watching ${terminalIds.length}`
                    : "Watch only"
            }
            attention={restrictedTerminal && !folders.length}
            on={terminalOn}
            open={openRow === "terminal"}
            onOpen={() => toggleRow("terminal")}
            onSwitch={(on) => {
              setLevel(on ? (folders.length ? "read" : "watch") : "off");
              if (!on) setTerminalIds([]);
              setOpenRow(on ? "terminal" : null);
            }}
          >
            <Choices
              name="terminal-level"
              label="Terminal"
              value={level === "off" ? "watch" : level}
              onChange={pickLevel}
              options={[
                { value: "watch", title: "Watch only", detail: "It sees what the terminals below print. It runs nothing." },
                { value: "read", title: "Read-only commands", detail: "ls, cat, grep and the like, inside its folders." },
                { value: "approve", title: "Ask me first", detail: "Reads run directly. Changes wait for your OK, once each." },
              ]}
            />
            {restrictedTerminal && !folders.length && (
              <button
                type="button"
                className="ag-note is-warn ag-note-button"
                onClick={() => {
                  setFoldersOn(true);
                  setOpenRow("folders");
                }}
              >
                <Folder size={14} />
                <span>
                  Commands run inside its folders. <u>Choose a folder</u>
                </span>
              </button>
            )}
            {!options ? (
              <p className="ag-quiet">Loading terminals…</p>
            ) : options.terminals.length ? (
              <div className="ag-lines">
                <p className="ag-label">Let it watch</p>
                {options.terminals.map((terminal) => (
                  <SwitchLine
                    key={terminal.id}
                    label={`Watch ${terminal.name}`}
                    icon={<Terminal size={18} />}
                    title={terminal.name}
                    checked={terminalIds.includes(terminal.id)}
                    onChange={(on) => watch(terminal.id, on)}
                  />
                ))}
              </div>
            ) : (
              <p className="ag-quiet">No terminals are open to watch.</p>
            )}
          </Grant>
        </div>

        <Segments
          label="Access duration"
          value={minutes}
          onChange={setMinutes}
          options={[
            { value: 15, label: "15 min" },
            { value: 30, label: "30 min" },
            { value: 60, label: "1 hour" },
          ]}
        />

        <div className="ag-send">
          <button
            className="ag-primary ag-wide"
            disabled={busy || !!missing || (!!folders.length && !options)}
            onClick={() => void create()}
          >
            {busy ? "Creating link…" : "Create invite link"}
          </button>
          <p className={`ag-summary${missing ? " is-missing" : ""}`} aria-live="polite">
            {missing || summary}
          </p>
        </div>
        {error && (
          <p className="ag-error" role="alert">
            {error}
          </p>
        )}
        {!appsReady && options && (
          <p className="ag-quiet ag-center">
            <Lock size={12} />{" "}
            {options.appAccessError || "App sharing is unavailable on this computer."}
          </p>
        )}
      </div>

      {made && (
        <section
          className="ag-done"
          aria-label="AI browser invite link"
          aria-live="polite"
        >
          <AgentAvatar name={made.name} size={56} done />
          <h3>Link ready for {made.name}</h3>
          <p className="ag-quiet">
            Join by {at(made.joinBy)} · ends {at(made.expiresAt)}
          </p>
          <div className="ag-done-actions">
            <button className="ag-primary" onClick={() => void copyMessage()}>
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? "Copied" : "Copy invite"}
            </button>
            <button className="ag-secondary" onClick={() => void shareMessage()}>
              <Share2 size={17} /> Share…
            </button>
          </div>
          {shareNote && (
            <p className="ag-note is-warn" role="status">
              {shareNote}
            </p>
          )}
          <p className="ag-quiet">
            Paste it into {made.name}. When it connects, match the connection
            code in Home → Needs you, then approve.
          </p>
          <details
            className="ag-message"
            open={showMessage}
            onToggle={(e) => setShowMessage(e.currentTarget.open)}
          >
            <summary>
              What {made.name} will read <ChevronDown size={15} />
            </summary>
            <textarea
              className="browser-invite-message"
              aria-label="AI browser invitation message"
              readOnly
              rows={6}
              value={made.message}
              onFocus={(e) => e.target.select()}
            />
          </details>
          <button
            className="ag-link"
            onClick={() => {
              setMade(null);
              setName((current) => inviteName(Math.random, current));
              setCopied(false);
              setShareNote("");
              setShowMessage(false);
            }}
          >
            Invite another agent
          </button>
        </section>
      )}
    </section>
  );
}
