import { useEffect, useId, useRef, useState } from "react";
import {
  AppWindow,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Dices,
  Eye,
  EyeOff,
  Folder,
  Monitor,
  Pencil,
  Plug,
  Share2,
  ShieldCheck,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { shareCancelled } from "./sharing";
import { request, type Device, type Peer } from "./api";
import { guestLinkUrl } from "./start-flow";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import {
  AccessRow,
  AppPicker,
  AppStack,
  Switch,
  type PickerApp,
} from "./agent-ui";
import { Item, Menu, Row, VIA_WORDS, type Via } from "./invite-menu";
import "./browser-workspace.css";
import "./agent-invite.css";

// Inviting any agent: one that opens a web page, or one that runs Reach's
// tools (command line or MCP). One choice: a preset. Everything the agent may do follows from it;
// Full control has no content exclusions; narrower presets keep their limits.
export type Preset = "full" | "apps" | "files" | "readonly";
export const PRESET_WORDS: Record<Preset, { title: string; detail: string }> = {
  full: {
    title: "Full control",
    detail: "Use every app, file and command as you.",
  },
  apps: { title: "Apps", detail: "Work in just the apps you choose." },
  files: { title: "Files", detail: "Read or edit selected folders." },
  readonly: {
    title: "Read only",
    detail: "See your screen and files. No changes.",
  },
};
const PRESET_ICONS = {
  full: Monitor,
  apps: AppWindow,
  files: Folder,
  readonly: Eye,
};
type PresetApp = {
  id: string;
  name: string;
  bundleId: string;
  running: boolean;
  protected: boolean;
  reason?: string;
  runsCommands?: boolean;
};
type Options = {
  terminals: { id: string; name: string }[];
  desktopAvailable?: boolean;
  protectedFilesSupported?: boolean;
  maxFunnelSeconds?: number;
  standingAllowed?: boolean;
  // Always over Tools: this Mac makes invite keys (the agent's own device).
  toolsStandingAllowed?: boolean;
  presetApps?: PresetApp[];
  presetAppsError?: string;
};
type Created = { peer: Peer; clientId: string; invitation: string };
type Issued = {
  preset: Preset;
  apps: string[];
  folders: string[];
  write: boolean;
  hidden: string[];
  everything: boolean;
  always?: boolean;
  // Tools: the agent runs this once on its own computer, then calls Reach's
  // tools (command line or MCP) over the owner's Tailscale network.
  command?: string;
  // The same, for Windows (PowerShell).
  windowsCommand?: string;
  // Hosted: the address of Reach's MCP endpoint, added as a custom connector.
  hosted?: string;
};
// What a tools agent runs, once: Reach for agents from this computer's start
// page, then joining with its link (as Command line invites do). The
// runtime's SHA-256 from this computer is required: a download that isn't
// exactly it never replaces the agent's runtime (security audit M8). A
// computer that names no runtime gets no command (connections audit, Oct 10).
// The link goes in on standard input, never as an argument other processes
// can list (L5).
export const NO_RUNTIME = "Update Reach on that computer to invite agents from it: it doesn't name the runtime agents download, so the download couldn't be checked.";
const pinnedRuntime = (runtime?: string) => {
  if (!runtime || !/^[0-9a-f]{64}$/.test(runtime)) throw Error(NO_RUNTIME);
  return runtime;
};
export const toolsCommand = (start: string, link: string, runtime?: string) => {
  const sha = pinnedRuntime(runtime);
  const join = `printf '%s\\n' '${link}' | node ~/.reach-agent/agent.mjs join`;
  return `curl -fsSL --create-dirs -o ~/.reach-agent/agent.mjs.new ${start}/agent.mjs && node -e 'const [f,h]=process.argv.slice(1);if(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex")!==h)throw Error("This is not the runtime your invitation names. Ask for a new invitation.")' ~/.reach-agent/agent.mjs.new ${sha} && mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs && ${join}`;
};
// The same for Windows, in PowerShell (5.1 and later ship with Windows 10
// and 11): download, check its SHA-256, then the link on standard input.
export const windowsToolsCommand = (start: string, link: string, runtime?: string) => {
  const sha = pinnedRuntime(runtime);
  const check = `if ((Get-FileHash "$d\\agent.mjs.new" -Algorithm SHA256).Hash -ne '${sha}') { throw 'This is not the runtime your invitation names. Ask for a new invitation.' }; `;
  // Windows PowerShell 5.1 may not offer TLS 1.2 on its own.
  return `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $d = "$HOME\\.reach-agent"; New-Item -ItemType Directory -Force $d | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${start}/agent.mjs -OutFile "$d\\agent.mjs.new"; ${check}Move-Item -Force "$d\\agent.mjs.new" "$d\\agent.mjs"; '${link}' | node "$d\\agent.mjs" join`;
};
// The "Always" duration: access until the owner ends it.
const ALWAYS = 0;

const quote = (value: string) =>
  JSON.stringify(
    value.length > 160 ? value.slice(0, 157) + "\u2026" : value,
  ).replace(
    /[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const listWords = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// What the agent reads, short (Oct 10: "invite message is too long"): how to
// connect, what it may do, the few rules. Its tools describe themselves.
// Describes the issued invitation, never later edits.
export const agentInviteMessage = (link: string, issued: Issued) => {
  const folders =
    issued.folders.slice(0, 3).map(quote).join(", ") +
    (issued.folders.length > 3 ? ` and ${issued.folders.length - 3} more` : "");
  const where = issued.everything ? "every folder I share" : folders;
  const hidden = issued.preset !== "full" && issued.hidden.length
    ? ` Hidden from you: ${listWords(issued.hidden.map(quote))}.`
    : "";
  const access = {
    full: "You get full control of my Mac as my user account: all apps, files, browser pages and shell commands.",
    apps: `You get only ${listWords(issued.apps.map(quote))}, on my screen.`,
    files: `You can ${issued.write ? "read and change" : "read"} files in ${where}. No screen, no commands.`,
    readonly: `You can look: my screen and files in ${where}. No clicks, no changes.`,
  }[issued.preset];
  const hands = issued.preset === "apps";
  const tools = !!issued.command || !!issued.hosted;
  const rules =
    (hands
      ? tools
        ? ' Type passwords from your vault with "secret":true, and stay out of password apps, Reach and Tailscale.'
        : " Fill passwords from your vault with Sign in, and stay out of password apps, Reach and Tailscale."
      : "") +
    ` Ask me before paying, sending or deleting anything. Don't share this ${issued.hosted ? "address" : tools ? "command" : "link"}.`;
  if (issued.hosted)
    return `Add this as a custom MCP connector in your settings, then I approve the code it shows:\n\n${issued.hosted}\n\n${access}${hidden}${rules}`;
  if (tools)
    return `Connect to my Mac with Reach. Run this once (Node.js 22 or later), then I approve the code it shows:\n\n${issued.command}\n\nThen add Reach as an MCP server: node ~/.reach-agent/agent.mjs mcp\n\n${access}${hidden}${rules}${issued.windowsCommand ? `\n\nOn Windows, in PowerShell:\n\n${issued.windowsCommand}` : ""}`;
  return `Open this link in your browser, then I approve the code it shows.${issued.always ? " Your access lasts until I end it." : ""} Keep the link: it brings this browser back.\n\n${access}${hidden}${rules}\n\n${link}`;
};

// Every invite gets a fresh, silly name; the dice roll another.
const quirks = [
  "Sneaky",
  "Cosmic",
  "Turbo",
  "Fluffy",
  "Sleepy",
  "Dapper",
  "Wobbly",
  "Jazzy",
  "Spicy",
  "Grumpy",
  "Sparkly",
  "Noble",
  "Bouncy",
  "Mighty",
  "Quantum",
  "Velvet",
  "Zesty",
  "Snazzy",
  "Crispy",
  "Lucky",
];
const critters = [
  "Penguin",
  "Pickle",
  "Noodle",
  "Waffle",
  "Otter",
  "Toaster",
  "Llama",
  "Nugget",
  "Pixel",
  "Walrus",
  "Muffin",
  "Badger",
  "Taco",
  "Narwhal",
  "Biscuit",
  "Gecko",
  "Raccoon",
  "Dumpling",
  "Wombat",
  "Pretzel",
];
export const inviteName = (random = Math.random, not = "") => {
  for (;;) {
    const name = `${quirks[Math.floor(random() * quirks.length)]} ${critters[Math.floor(random() * critters.length)]}`;
    if (name !== not) return name;
  }
};
// Apps worth hiding first under Full control: where codes and mail arrive.
const SUGGESTED_HIDDEN = [
  "com.apple.mobilesms",
  "com.apple.mail",
  "com.apple.facetime",
];

// How the agent connects: Tools and Web page as before; Hosted for an agent
// in a service that takes a connector URL (claude.ai, ChatGPT, Muse, Grok).
type Connect = "tools" | "page" | "hosted";
type Props = {
  peer: Peer;
  device: Device;
  keyPeer: Peer | null;
  onSetup: () => void;
  onCreated: (created: Created, link: string) => void;
  // How it connects at first (Tools unless chosen before).
  initialConnect?: Connect;
  // Command line, offered in Connects where the invitation has it.
  onCommandLine?: () => void;
};
export default function BrowserInvite(props: Props) {
  return (
    <BrowserInviteForm
      key={`${props.peer.id}:${props.peer.url}:${props.peer.token}`}
      {...props}
    />
  );
}
function BrowserInviteForm({ peer, device, keyPeer, onSetup, onCreated, initialConnect = "tools", onCommandLine }: Props) {
  const formId = useId();
  const [name, setName] = useState(() => inviteName());
  const [preset, setPreset] = useState<Preset | null>(null);
  const [minutes, setMinutes] = useState(30);
  // Tools (first, and the default): the agent runs one command in its
  // terminal and calls Reach's tools over Tailscale: the screen as text, an
  // action per call, no pictures to load. Page: a web page with the live
  // screen, for agents with only a browser (slower).
  const [connect, setConnect] = useState<Connect>(initialConnect);
  const [apps, setApps] = useState<string[]>([]);
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [write, setWrite] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [showMessage, setShowMessage] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState("");
  const [made, setMade] = useState<{
    link: string;
    name: string;
    access: string;
    expiresAt: number;
    joinBy: number;
    message: string;
    always: boolean;
    unpublished: boolean;
    // Tools without a one-time Tailscale key: its computer must already be on
    // the owner's tailnet (no invite keys set up here).
    unkeyed?: boolean;
    // Hosted: the link is the connector address.
    hosted?: boolean;
  } | null>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);
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
  useEffect(() => {
    if (made) doneHeading.current?.focus({ preventScroll: true });
  }, [made]);

  const catalog = options?.presetApps || [];
  const pickerApps: PickerApp[] = catalog.map((app) => ({
    id: app.id,
    name: app.name,
    protected: app.protected,
    reason: app.reason,
    ...(app.runsCommands ? { note: "Runs commands as you" } : {}),
  }));
  const hideableApps: PickerApp[] = catalog
    .filter((app) => !app.protected)
    .map((app) => ({ id: app.id, name: app.name }));
  const suggested = hideableApps.filter((app) =>
    SUGGESTED_HIDDEN.includes(
      (
        catalog.find((entry) => entry.id === app.id)?.bundleId || ""
      ).toLowerCase(),
    ),
  );
  const screenPreset =
    preset === "full" || preset === "apps" || preset === "readonly";
  const desktopReady = options?.desktopAvailable !== false;
  const macHost = (device.platform || peer.platform) === "darwin";
  const filesSupported = options?.protectedFilesSupported ?? macHost;
  const missing = !name.trim()
    ? "Name the agent."
    : !preset
      ? "Choose what it may do."
      : preset === "apps" && !apps.length
        ? "Pick at least one app."
        : preset === "files" && !filesSupported
          ? "Browser-agent file access requires macOS."
          : preset === "files" && !folders.length
            ? "Pick at least one folder."
            : screenPreset && options && !desktopReady
              ? macHost
                ? "This Mac can't share its screen with agents yet. Turn on Screen Recording and Accessibility for Reach."
                : "Browser-agent screen access requires macOS."
              : "";
  const chosenApps = catalog.filter((app) => apps.includes(app.id));
  const hiddenApps = catalog.filter((app) => hidden.includes(app.id));
  const choose = (next: Preset) => {
    setPreset(next);
    setError("");
    if (next !== "apps") setApps([]);
    if (next !== "files") setWrite(false);
    if (next === "apps") setFolders([]);
    if (next === "apps" || next === "files") setHidden([]);
    setOpenRow(next === "apps" ? "apps" : next === "files" ? "folders" : null);
  };
  // A choice that needs nothing more makes the invite once it's set.
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!go) return;
    setGo(false);
    void create();
  }, [go]);
  const create = async () => {
    if (busy || missing || !preset) return;
    setBusy(true);
    setError("");
    setCopied(false);
    setShareNote("");
    let created: Created | null = null;
    const controller = new AbortController();
    creation.current = controller;
    const everything =
      preset !== "files" && preset !== "apps" && !folders.length;
    try {
      const result = await request<{
        invitation: string;
        clientId: string;
        expiresAt: number;
        joinBy: number;
        url: string;
        publicName?: "missing";
        runtime?: string;
        privateUrl?: string;
        hosted?: boolean;
      }>(peer, "/api/agents/browser-invitations", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          name: name.trim(),
          // Tools over Tailscale where this Mac makes invite keys; else,
          // like Page, through the public link (from anywhere, no key).
          // Every agent through the public link (Tools as page agents), the
          // Mac's private address inside its link and tried first: an agent
          // on your tailnet uses it at once, any other the public link.
          transport: "funnel",
          preset,
          ...(preset === "full" ? { fullControlVersion: 1 } : {}),
          ...(connect === "hosted" ? { hosted: true } : {}),
          ...(minutes === ALWAYS
            ? { standing: true }
            : { ttlSeconds: minutes * 60 }),
          ...((preset === "files" || preset === "readonly") && folders.length
            ? { folders: folders.map(({ root, path }) => ({ root, path })) }
            : {}),
          ...(preset === "apps" ? { apps: apps.map((id) => ({ id })) } : {}),
          ...(preset === "files" && write ? { write: true } : {}),
          ...(preset === "readonly" && hidden.length
            ? { hidden: hidden.map((id) => ({ id })) }
            : {}),
        }),
      });
      created = {
        peer,
        clientId: result.clientId,
        invitation: result.invitation ?? "",
      };
      if (!alive.current || controller.signal.aborted)
        throw Error("Invitation creation was cancelled.");
      const issuedTo = {
        preset,
        apps: chosenApps.map((app) => app.name),
        folders: folders.map((folder) => folder.full || folder.label),
        write: preset === "files" && write,
        hidden: preset === "full" ? [] : hiddenApps.map((app) => app.name),
        everything,
        always: minutes === ALWAYS,
      };
      if (connect === "hosted") {
        // A hosted agent (claude.ai, ChatGPT, Muse, Grok): the address of
        // Reach's MCP endpoint, added as a custom connector; the owner
        // approves its code like any agent's.
        const address = new URL(result.url);
        if (address.protocol !== "https:" || !/^\/mcp\/[A-Za-z0-9_-]{43}$/.test(address.pathname) || address.search || address.hash || address.username || address.password)
          throw Error("The connector address could not be prepared.");
        setMade({
          link: address.href,
          name: name.trim(),
          access: PRESET_WORDS[preset].title,
          expiresAt: result.expiresAt,
          joinBy: result.joinBy,
          always: minutes === ALWAYS,
          unpublished: result.publicName === "missing",
          hosted: true,
          message: agentInviteMessage(address.href, { ...issuedTo, hosted: address.href }),
        });
        onCreated(created, address.href);
        return;
      }
      if (connect === "tools") {
        // One command that joins through the public link, every request
        // signed by the agent's own key (scripts/agent-funnel.mjs), the
        // private address tried first. Works from any terminal, sandboxes
        // included (Oct 10: Muse couldn't reach Tailscale at all).
        const origin = new URL(result.url).origin;
        const link = guestLinkUrl(origin, {
          key: "",
          hostname: "",
          invites: [{ origin: new URL(peer.url).origin, secret: result.invitation }],
          funnel: true,
        }, "/agent");
        const command = toolsCommand(origin, link, result.runtime);
        const windowsCommand = windowsToolsCommand(origin, link, result.runtime);
        setMade({
          link: command,
          name: name.trim(),
          access: PRESET_WORDS[preset].title,
          expiresAt: result.expiresAt,
          joinBy: result.joinBy,
          always: minutes === ALWAYS,
          unpublished: result.publicName === "missing",
          unkeyed: false,
          message: agentInviteMessage(link, { ...issuedTo, command, windowsCommand }),
        });
        onCreated(created, link);
        return;
      }
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
        access: PRESET_WORDS[preset].title,
        expiresAt: result.expiresAt,
        joinBy: result.joinBy,
        always: minutes === ALWAYS,
        unpublished: result.publicName === "missing",
        message: agentInviteMessage(link, issuedTo),
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
  const toggleRow = (row: string) =>
    setOpenRow((current) => (current === row ? null : row));
  const minutesLabel =
    minutes === ALWAYS
      ? ""
      : minutes === 1440
        ? "24 hours"
        : minutes === 60
          ? "1 hour"
          : `${minutes} minutes`;
  // Before the Mac's options arrive (its app list can take a while), the
  // durations every current Reach allows are offered; an older Mac that
  // allows less says so, and the server refuses what it doesn't allow.
  // A day is offered only once this Mac says it allows one: an older Mac
  // never sees a choice it would refuse.
  const dayAllowed = (options?.maxFunnelSeconds ?? 0) >= 86400;
  // Always: page agents, and tools agents that join with their own invite
  // key (their credential renews itself and a copy is caught).
  // Always, on either route: its key reconnects the agent until the owner
  // ends it (a copy used elsewhere ends it; a week unused ends it).
  const alwaysAllowed = options ? options.standingAllowed === true : true;
  useEffect(() => {
    // Only once the Mac's options are known: a choice made while they load
    // isn't thrown away by the defaults.
    if (!options) return;
    if ((minutes === ALWAYS && !alwaysAllowed) || (minutes === 1440 && !dayAllowed)) setMinutes(60);
  }, [options, alwaysAllowed, dayAllowed]);
  const summary = !preset
    ? ""
    : `${name.trim()} gets ${
        {
          full: "full control of this Mac as your user account",
          apps: chosenApps.length
            ? `${listWords(chosenApps.slice(0, 3).map((app) => app.name))}${chosenApps.length > 3 ? ` and ${chosenApps.length - 3} more` : ""}, nothing else`
            : "the apps you pick",
          files: folders.length
            ? `${folders.length === 1 ? folders[0].label : `${folders.length} folders`}, ${write ? "read and edit" : "read only"}`
            : "the folders you pick",
          readonly: `a look at the screen and files${hidden.length ? `, except ${listWords(hiddenApps.map((app) => app.name))}` : ""}, no touching`,
        }[preset]
      } ${minutes === ALWAYS ? "until you end it" : `for ${minutesLabel}`}.`;
  const at = (value: number) =>
    new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

  // The durations offered, in the Expires menu: a day and Always only where
  // this Mac allows them, each with its one line.
  const durations: { value: number; label: string; description?: string }[] = [
    { value: 15, label: "15 min" },
    { value: 30, label: "30 min" },
    { value: 60, label: "1 hour" },
    ...(dayAllowed
      ? [{ value: 1440, label: "24 hours", description: "A day is long for an agent on your Mac. End or pause it any time." }]
      : []),
    ...(alwaysAllowed
      ? [{
          value: ALWAYS,
          label: "Always",
          description: connect === "page"
            ? "Until you end it. It comes back through the same link, with no new invite."
            : "Until you end it, or a week unused. Its key renews itself; a copy used elsewhere ends the access.",
        }]
      : []),
  ];
  const vias: Via[] = ["tools", "page", "hosted", ...(onCommandLine ? ["cli" as const] : [])];

  return (
    <section
      className="browser-invite ag-invite"
      aria-label="AI browser invitation"
    >
      {/* As ChatGPT would: one question. Tap what it may do and the invite
          is ready (Apps and Folders ask which first). The rest has a good
          default, changed from the small rows below if you care. */}
      <div className="ag-invite-form" hidden={!!made}>
        <p className="ag-ask">What may it do?</p>
        <div
          className="ivt-rows ag-choices"
          role="radiogroup"
          aria-label="Access preset"
        >
          {(["full", "apps", "files", "readonly"] as Preset[]).map((value) => {
            const Icon = PRESET_ICONS[value];
            const disabled =
              !!options &&
              (value === "files" ? !filesSupported : !desktopReady);
            return (
              <button
                type="button"
                key={value}
                role="radio"
                aria-checked={preset === value}
                aria-label={PRESET_WORDS[value].title}
                className={`ivt-row ag-choice${preset === value ? " is-on" : ""}`}
                disabled={disabled || busy}
                onClick={() => {
                  choose(value);
                  // Nothing more to choose: the invite is made at once.
                  if (value === "full" || value === "readonly") setGo(true);
                }}
              >
                <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
                <span className="ag-choice-text">
                  <strong>{PRESET_WORDS[value].title}</strong>
                  <small>{PRESET_WORDS[value].detail}</small>
                </span>
                {busy && preset === value ? (
                  <span className="ag-choice-busy">Creating…</span>
                ) : (
                  <ChevronRight size={17} className="ag-choice-go" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>

        {preset === "apps" && (
          <div className="ag-rows">
            <AccessRow
              icon={<AppWindow />}
              label="Apps it may use"
              value={
                chosenApps.length ? (
                  <AppStack peer={peer} apps={chosenApps} />
                ) : (
                  "Pick apps"
                )
              }
              open={openRow === "apps"}
              onToggle={() => toggleRow("apps")}
              attention={!apps.length}
            >
              <p className="ag-quiet">
                It sees and touches only these. Your browser with its saved
                logins counts as one app.
              </p>
              {!options ? (
                <p className="ag-quiet">Loading apps…</p>
              ) : options.presetAppsError ? (
                <p className="ag-error" role="alert">
                  {options.presetAppsError}
                </p>
              ) : (
                <AppPicker
                  peer={peer}
                  apps={pickerApps}
                  chosen={apps}
                  onChange={setApps}
                  chosenWords="Can use it"
                />
              )}
            </AccessRow>
          </div>
        )}
        {preset === "files" && (
          <div className="ag-rows">
            <AccessRow
              icon={<Folder />}
              label="Folders"
              value={
                folders.length
                  ? folders.length === 1
                    ? folders[0].label
                    : `${folders.length} folders`
                  : "Pick folders"
              }
              open={openRow === "folders"}
              onToggle={() => toggleRow("folders")}
              attention={!folders.length}
            >
              <p className="ag-quiet">
                Your real folders. Home itself and system folders can't be
                chosen.
              </p>
              <FolderBrowser
                peer={peer}
                device={device}
                picked={folders}
                onChange={setFolders}
              />
            </AccessRow>
            <div className="ag-row">
              <div className="ag-row-head ag-row-static">
                <span className="ag-row-icon">
                  <Pencil />
                </span>
                <span className="ag-row-label">Can edit</span>
                <span className="ag-row-value">
                  {write ? "Changes files directly" : "Read only"}
                </span>
                <Switch
                  label="Can edit files"
                  checked={write}
                  onChange={setWrite}
                />
              </div>
            </div>
          </div>
        )}
        {(preset === "apps" || preset === "files") && (
          <div className="ag-send">
            <p
              className={`ag-summary${missing ? " is-missing" : ""}`}
              aria-live="polite"
            >
              {missing || summary}
            </p>
            <button
              className="ag-primary ag-wide"
              disabled={busy || !!missing}
              onClick={() => void create()}
            >
              {busy ? "Creating link…" : "Create invite link"}
            </button>
          </div>
        )}
        {(preset === "full" || preset === "readonly") && missing && (
          <p className="ag-summary is-missing" aria-live="polite">
            {missing}
          </p>
        )}

        {/* The defaults, quiet: change them before tapping, or never. */}
        <div className="ivt-rows ag-defaults">
          <div className="ivt-row ivt-add">
            <Bot size={19} aria-hidden="true" />
            <input
              id={`${formId}-name`}
              className="ivt-name"
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
              onClick={() =>
                setName((current) => inviteName(Math.random, current))
              }
            >
              <Dices size={19} />
            </button>
          </div>
          <Row icon={<Clock3 size={19} />} label="Expires">
            <Menu
              label={durations.find((d) => d.value === minutes)?.label || "1 hour"}
              wide
              className="ivt-role"
            >
              {(close) => (
                <div role="group" aria-label="Access duration">
                  {durations.map((d) => (
                    <Item
                      key={d.value}
                      on={d.value === minutes}
                      label={d.label}
                      description={d.description}
                      onClick={() => {
                        setMinutes(d.value);
                        close();
                      }}
                    />
                  ))}
                </div>
              )}
            </Menu>
          </Row>
          <Row icon={<Plug size={19} />} label="Connects">
            <Menu label={VIA_WORDS[connect].label} wide className="ivt-role">
              {(close) => (
                <div role="group" aria-label="How the agent connects">
                  {vias.map((v) => (
                    <Item
                      key={v}
                      on={v === connect}
                      label={VIA_WORDS[v].label}
                      description={
                        v === "tools" && keyPeer?.id !== peer.id
                          ? "Fastest. One command in any terminal, through your public link."
                          : VIA_WORDS[v].description
                      }
                      onClick={() => {
                        close();
                        if (v === "cli") onCommandLine?.();
                        else setConnect(v);
                      }}
                    />
                  ))}
                  {connect === "tools" && keyPeer?.id !== peer.id && (
                    <button
                      type="button"
                      className="ivt-menu-foot"
                      aria-label="Set up invite links"
                      onClick={() => {
                        close();
                        onSetup();
                      }}
                    >
                      Set up invite links
                      <small>Keeps Tools on your Tailscale network.</small>
                    </button>
                  )}
                </div>
              )}
            </Menu>
          </Row>
          {/* Apps and Folders show only what they name: nothing to hide. */}
          {(preset === null || preset === "readonly") && (
          <div className="ag-rows ag-hide">
            <AccessRow
              icon={<EyeOff />}
              label="Hide apps from it"
              value={
                hiddenApps.length ? (
                  <AppStack peer={peer} apps={hiddenApps} />
                ) : (
                  "None"
                )
              }
              open={openRow === "hidden"}
              onToggle={() => toggleRow("hidden")}
            >
              <p className="ag-quiet">
                Reach filters known password and Reach windows from pictures.
                Add apps where your codes and mail arrive.
              </p>
              {suggested.length > 0 && !hidden.length && (
                <button
                  type="button"
                  className="ag-link"
                  onClick={() => setHidden(suggested.map((app) => app.id))}
                >
                  Hide {listWords(suggested.map((app) => app.name))}
                </button>
              )}
              {!options ? (
                <p className="ag-quiet">Loading apps…</p>
              ) : (
                <AppPicker
                  peer={peer}
                  apps={hideableApps}
                  chosen={hidden}
                  onChange={setHidden}
                  chosenWords="Hidden from it"
                  chipsLabel="Hidden apps"
                />
              )}
            </AccessRow>
          </div>
          )}
        </div>
        <p className="ag-note">
          <ShieldCheck size={14} />
          {preset === "full"
            ? "Full control can access passwords, change security settings, run commands and stop Reach. It runs as you, within macOS permissions. Approve only an agent you trust."
            : "You approve it before it can join. You can pause it or end its access at any time."}
        </p>
        {error && (
          <p className="ag-error" role="alert">
            {error}
          </p>
        )}
        {options && !macHost && !filesSupported && !desktopReady && (
          <p className="ag-quiet ag-center">
            Browser invitations currently require macOS. Your own Files and
            terminals remain available. For an agent, choose Command line
            under Connects.
          </p>
        )}
        {options && !filesSupported && (macHost || desktopReady) && (
          <p className="ag-quiet ag-center">
            Browser-agent file access requires macOS. Your own Files and
            terminals remain available.
          </p>
        )}
        {options && !desktopReady && macHost && (
          <p className="ag-quiet ag-center">
            <Monitor size={12} /> Screen presets need this Mac's Screen
            Recording and Accessibility for Reach.
          </p>
        )}
      </div>

      {made && (
        <section
          className="ag-done"
          aria-label="AI browser invite link"
          aria-live="polite"
        >
          <span className="ag-done-icon">
            <Check size={27} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <h3 ref={doneHeading} tabIndex={-1}>
            Your invite is ready
          </h3>
          <p className="ag-done-for">
            <strong>{made.name}</strong> · {made.access} ·{" "}
            {made.always
              ? "Until you end it"
              : `Join by ${at(made.joinBy)} · ends ${at(made.expiresAt)}`}
          </p>
          <div className="ag-done-actions">
            <button className="ag-primary" onClick={() => void copyMessage()}>
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? "Copied" : "Copy invite"}
            </button>
            <button
              className="ag-secondary"
              onClick={() => void shareMessage()}
            >
              <Share2 size={17} /> Share…
            </button>
          </div>
          {made.unkeyed && (
            <p className="ag-note is-warn" role="status">
              No Tailscale invite key: the agent's computer must already be on
              your Tailscale network.{" "}
              <button type="button" className="ag-link" onClick={onSetup}>
                Set up invite links
              </button>{" "}
              to let any computer join with the command.
            </p>
          )}
          {made.unpublished && (
            <p className="ag-note is-warn" role="status">
              Agents can’t open this link yet: Tailscale hasn’t published its
              address.
            </p>
          )}
          {shareNote && (
            <p className="ag-note is-warn" role="status">
              {shareNote}
            </p>
          )}
          {made.hosted && <code className="ag-done-url">{made.link}</code>}
          <p className="ag-done-next">
            {made.hosted
              ? "Add it to your agent as a custom MCP connector, then approve its code in Home → Needs you."
              : "Paste it in your agent’s chat, then approve its code in Home → Needs you."}
          </p>
          <details
            className="ag-message"
            open={showMessage}
            onToggle={(e) => setShowMessage(e.currentTarget.open)}
          >
            <summary>
              Preview invite message <ChevronDown size={15} />
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
              // A fresh invitation: a new name and no choices carried over.
              setMade(null);
              setName((current) => inviteName(Math.random, current));
              setPreset(null);
              setApps([]);
              setFolders([]);
              setWrite(false);
              setHidden([]);
              setOpenRow(null);
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
