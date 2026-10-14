import { useEffect, useId, useRef, useState } from "react";
import {
  AppWindow,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Dices,
  Eye,
  EyeOff,
  Folder,
  Monitor,
  Pencil,
  Share2,
  ShieldCheck,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { shareCancelled } from "./sharing";
import { request, type Device, type Peer } from "./api";
import { guestLinkUrl } from "./start-flow";
import { computerWord } from "./pause";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import {
  AccessRow,
  AppPicker,
  AppStack,
  Switch,
  type PickerApp,
} from "./agent-ui";
import {
  Choices,
  Item,
  Menu,
  Places,
  Row,
  Section,
} from "./invite-menu";
import { Mascot } from "./Mascot";
import "./browser-workspace.css";
import "./agent-invite.css";

// Inviting any agent: one that opens a web page, or one that runs Reach's
// tools (command line or MCP). One choice: a preset. Everything the agent may do follows from it;
// Full control has no content exclusions; narrower presets keep their limits.
export type Preset = "full" | "apps" | "files" | "readonly";
export const PRESET_WORDS: Record<Preset, { title: string; detail: string }> = {
  full: {
    title: "Full control",
    detail: "Every app, file and command.",
  },
  apps: { title: "Apps", detail: "Only the apps you pick." },
  files: { title: "Files", detail: "Only the folders you pick." },
  readonly: {
    title: "Read only",
    detail: "Looks, never changes.",
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
  desktopReason?: string;
  protectedFilesSupported?: boolean;
  filesUnsupportedReason?: string;
  maxFunnelSeconds?: number;
  standingAllowed?: boolean;
  // Always over Tools: this Mac makes invite keys (the agent's own device).
  toolsStandingAllowed?: boolean;
  presetApps?: PresetApp[];
  presetAppsError?: string;
};
type Created = { peer: Peer; clientId: string; invitation: string };
// What an agent runs, once: Reach for agents from this computer's start
// page, then joining with its link (Command line invites show it; a Tools
// agent's link carries the same steps itself, server/agent-steps.mjs). The
// runtime's SHA-256 from this computer is required: a download that isn't
// exactly it never replaces the agent's runtime (security audit M8). A
// computer that names no runtime gets no command, and no Tools link
// (connections audit, Oct 10). The link goes in on standard input, never as
// an argument other processes can list (L5).
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

const listWords = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// What the agent is first told (Oct 12: "a very small prompt with a link"):
// what to do with the link, and that I approve its code. One shape for every
// kind of agent. What it may do and the rules come when it connects, from
// its access then (server/agent-guide.mjs); a Tools agent's link explains
// itself (server/agent-steps.mjs). `word`: "Mac", "Windows PC" or "computer".
export const agentInviteMessage = (connect: Connect, link: string, word: string) =>
  `${
    {
      tools: `Connect to my ${word} with Reach: open this link and follow its steps, then I approve the code it shows. Keep the link to yourself.`,
      hosted: "Add this as a custom MCP connector, then I approve the code it shows. Keep the address to yourself.",
      page: "Open this link in your browser, then I approve the code it shows. Keep the link: it brings this browser back.",
    }[connect]
  }\n\n${link}`;

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
  // Command line (folders, over Tailscale): offered only on a computer
  // where the presets aren't (one that isn't a Mac).
  onCommandLine?: () => void;
  // Its name so far, kept when the invitation goes to Command line and back.
  initialName?: string;
  onName?: (name: string) => void;
};
export default function BrowserInvite(props: Props) {
  return (
    <BrowserInviteForm
      key={`${props.peer.id}:${props.peer.url}:${props.peer.token}`}
      {...props}
    />
  );
}
function BrowserInviteForm({ peer, device, onCreated, initialConnect = "tools", onCommandLine, initialName, onName }: Props) {
  const formId = useId();
  const [name, setName] = useState(() => initialName || inviteName());
  useEffect(() => onName?.(name), [name]);
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
    clientId: string;
    mascot?: number;
    link: string;
    name: string;
    access: string;
    expiresAt: number;
    joinBy: number;
    message: string;
    always: boolean;
    unpublished: boolean;
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
  // What the invite message calls this computer: never "Mac" off a Mac.
  const word = computerWord(device.platform || peer.platform);
  const filesSupported = options?.protectedFilesSupported ?? macHost;
  const desktopReason = options?.desktopReason || (macHost
    ? "Screen presets need this Mac's Screen Recording and Accessibility for Reach."
    : `Screen access for agents isn't ready on this ${word} yet.`);
  const filesReason = options?.filesUnsupportedReason || (macHost
    ? "Browser-agent file access requires macOS. Your own Files and terminals remain available."
    : `Agent file access isn't ready on this ${word} yet. Your own Files and terminals remain available.`);
  const missing = !name.trim()
    ? "Name the agent."
    : !preset
      ? "Choose what it may do."
      : preset === "apps" && !apps.length
        ? "Pick at least one app."
        : preset === "files" && !filesSupported
          ? filesReason
          : preset === "files" && !folders.length
            ? "Pick at least one folder."
            : screenPreset && options && !desktopReady
              ? desktopReason
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
  const create = async () => {
    if (busy || missing || !preset) return;
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
        publicName?: "missing";
        runtime?: string;
        privateUrl?: string;
        hosted?: boolean;
        mascot?: number;
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
      if (connect === "hosted") {
        // A hosted agent (claude.ai, ChatGPT, Muse, Grok): the address of
        // Reach's MCP endpoint, added as a custom connector; the owner
        // approves its code like any agent's.
        const address = new URL(result.url);
        if (address.protocol !== "https:" || !/^\/mcp\/[A-Za-z0-9_-]{43}$/.test(address.pathname) || address.search || address.hash || address.username || address.password)
          throw Error("The connector address could not be prepared.");
        setMade({
          clientId: result.clientId,
          mascot: result.mascot,
          link: address.href,
          name: name.trim(),
          access: PRESET_WORDS[preset].title,
          expiresAt: result.expiresAt,
          joinBy: result.joinBy,
          always: minutes === ALWAYS,
          unpublished: result.publicName === "missing",
          hosted: true,
          message: agentInviteMessage("hosted", address.href, word),
        });
        onCreated(created, address.href);
        return;
      }
      if (connect === "tools") {
        // A link that explains itself (its steps at /agent): join through
        // the public link, every request signed by the agent's own key
        // (scripts/agent-funnel.mjs), the private address tried first.
        // Works from any terminal, sandboxes included (Oct 10: Muse
        // couldn't reach Tailscale at all). The runtime's SHA-256 rides in
        // its fragment: the steps and join check against it, and a
        // computer that names none gets no link.
        const origin = new URL(result.url).origin;
        const link = guestLinkUrl(origin, {
          key: "",
          hostname: "",
          invites: [{ origin: new URL(peer.url).origin, secret: result.invitation }],
          funnel: true,
          runtime: pinnedRuntime(result.runtime),
        }, "/agent");
        setMade({
          clientId: result.clientId,
          mascot: result.mascot,
          link,
          name: name.trim(),
          access: PRESET_WORDS[preset].title,
          expiresAt: result.expiresAt,
          joinBy: result.joinBy,
          always: minutes === ALWAYS,
          unpublished: result.publicName === "missing",
          message: agentInviteMessage("tools", link, word),
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
        clientId: result.clientId,
        mascot: result.mascot,
        link,
        name: name.trim(),
        access: PRESET_WORDS[preset].title,
        expiresAt: result.expiresAt,
        joinBy: result.joinBy,
        always: minutes === ALWAYS,
        unpublished: result.publicName === "missing",
        message: agentInviteMessage("page", link, word),
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
  const presetChoices = (["full", "apps", "files", "readonly"] as Preset[]).map(
    (value) => ({
      value,
      label: PRESET_WORDS[value].title,
      description: PRESET_WORDS[value].detail,
      icon: PRESET_ICONS[value],
      disabled:
        !!options && (value === "files" ? !filesSupported : !desktopReady),
    }),
  );

  return (
    <section
      className="browser-invite ag-invite"
      aria-label="AI browser invitation"
    >
      {/* As ChatGPT would: where it runs, what it may do (a list with a
          check), its name and how long, then one white pill. Choosing
          never sends anything. */}
      <div className="ag-invite-form" hidden={!!made}>
        <Places
          via={connect}
          onChange={(v) => {
            setConnect(v as Connect);
            setError("");
          }}
        />
        <Section title="What can it do?">
          <Choices
            label="Access preset"
            options={presetChoices}
            value={preset}
            onChange={choose}
            disabled={busy}
          />
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
          {/* Only Read only shows everything else, so only it hides apps. */}
          {preset === "readonly" && (
            <div className="ag-rows">
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
                  Reach filters known password and Reach windows from
                  pictures. Add apps where your codes and mail arrive.
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
        </Section>

        <div className="ivt-rows">
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
        </div>

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
            {busy ? "Creating…" : "Create invite"}
          </button>
        </div>
        {error && (
          <p className="ag-error" role="alert">
            {error}
          </p>
        )}
        <p className="ag-note">
          <ShieldCheck size={14} />
          {preset === "full"
            ? `Full control can access passwords, change security settings, run commands and stop Reach. It runs as you, within ${macHost ? "macOS" : "your account's"} permissions. Approve only an agent you trust.`
            : "You approve it before it can join. Pause it or end its access any time."}
        </p>
        {options && !macHost && !filesSupported && !desktopReady && (
          <>
            <p className="ag-quiet ag-center">
              {desktopReason} {filesReason}
            </p>
            {onCommandLine && (
              <button
                type="button"
                className="ag-secondary ag-wide"
                onClick={onCommandLine}
              >
                Invite with folder access
              </button>
            )}
          </>
        )}
        {options && !filesSupported && (macHost || desktopReady) && (
          <p className="ag-quiet ag-center">
            {filesReason}
          </p>
        )}
        {options && !desktopReady && (macHost || filesSupported) && (
          <p className="ag-quiet ag-center">
            <Monitor size={12} /> {desktopReason}
          </p>
        )}
      </div>

      {made && (
        <section
          className="ag-done"
          aria-label="AI browser invite link"
          aria-live="polite"
        >
          <span className="ag-done-icon mascot-done has-mascot" aria-hidden="true">
            <Mascot id={made.clientId} drawn={made.mascot} />
            <i className="mascot-check"><Check size={12} strokeWidth={3} /></i>
          </span>
          <h3 ref={doneHeading} tabIndex={-1}>
            {made.name} is invited
          </h3>
          <p className="ag-done-for">
            {made.access} ·{" "}
            {made.always
              ? "Until you end it"
              : `Join by ${at(made.joinBy)} · ends ${at(made.expiresAt)}`}
          </p>
          {made.hosted && <code className="ag-done-url">{made.link}</code>}
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
