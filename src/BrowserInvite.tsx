import { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  Check,
  ChevronDown,
  Copy,
  Dices,
  Eye,
  EyeOff,
  Folder,
  Lock,
  Monitor,
  Pencil,
  Share2,
  ShieldCheck,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { shareCancelled } from "./sharing";
import { request, type Device, type Peer } from "./api";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import { AccessRow, AgentAvatar, AppPicker, AppStack, Choices, Segments, Switch, type PickerApp } from "./agent-ui";
import "./browser-workspace.css";
import "./agent-invite.css";

// Inviting an agent that works from a browser (Muse, ChatGPT agent, a Grok
// bot). One choice: a preset. Everything the agent may do follows from it;
// what stays protected never changes (server/agent-guard.mjs).
export type Preset = "full" | "apps" | "files" | "readonly";
export const PRESET_WORDS: Record<Preset, { title: string; detail: string }> = {
  full: { title: "Full control", detail: "Your Mac as you use it: screen, mouse, keyboard, files, commands." },
  apps: { title: "Apps", detail: "Only the apps you pick. It sees and touches nothing else." },
  files: { title: "Files", detail: "Folders you pick. Read them, or read and edit them." },
  readonly: { title: "Read only", detail: "Looks at the screen and files. Touches nothing." },
};
type PresetApp = { id: string; name: string; bundleId: string; running: boolean; protected: boolean; reason?: string; runsCommands?: boolean };
type Options = {
  terminals: { id: string; name: string }[];
  desktopAvailable?: boolean;
  protectedFilesSupported?: boolean;
  maxFunnelSeconds?: number;
  standingAllowed?: boolean;
  presetApps?: PresetApp[];
  presetAppsError?: string;
};
type Created = { peer: Peer; clientId: string; invitation: string };
type Issued = { preset: Preset; apps: string[]; folders: string[]; write: boolean; hidden: string[]; everything: boolean; always?: boolean };
// The "Always" duration: access until the owner ends it.
const ALWAYS = 0;

const quote = (value: string) =>
  JSON.stringify(value.length > 160 ? value.slice(0, 157) + "\u2026" : value).replace(
    /[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const listWords = (items: string[]) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// What the agent reads: its preset, what stays closed, how to behave with
// other agents and the owner. Describes the issued invitation, never later edits.
export const museMessage = (link: string, issued: Issued) => {
  const folders = issued.folders.slice(0, 3).map(quote).join(", ") + (issued.folders.length > 3 ? ` and ${issued.folders.length - 3} more` : "");
  const where = issued.everything ? "every folder the owner shares" : `only ${folders}`;
  const hidden = issued.hidden.length ? ` The owner also hid ${listWords(issued.hidden.map(quote))}.` : "";
  const grant = {
    full: `Preset: Full control. You use this Mac as the owner does: its screen (reach_screenshot, reach_act), its apps (reach_open_app), files in ${where} (read and change), and a shell (reach_shell) that runs as the owner.`,
    apps: `Preset: Apps. You see and use only ${listWords(issued.apps.map(quote))}, on the owner's screen (reach_screenshot, reach_act, reach_open_app). Nothing else is visible or clickable.`,
    files: `Preset: Files. You ${issued.write ? "read and change" : "read"} files in ${where}. No screen, no commands.`,
    readonly: `Preset: Read only. You look: screenshots, files in ${where}, shared terminal output. You can't click, type or change anything.`,
  }[issued.preset];
  const protectedWords = issued.preset === "files"
    ? " Reach's own files and the owner's secret files stay closed."
    : issued.preset === "full"
      ? ` Full control is not sandboxed: commands can read sensitive files or change Reach. Do not access password fields and password apps, Reach and Tailscale, or security prompts; ask the owner to sign in.${hidden}`
      : ` Reach filters known protected windows and blocks password fields and password apps, Reach and Tailscale, and security prompts. Ask the owner to sign in. These UI guards do not sandbox commands run through a chosen terminal or IDE.${hidden}`;
  const sharing = ["full", "apps"].includes(issued.preset)
    ? " One agent acts on the Mac at a time: a busy or paused reply means wait and retry. The owner's own hands come first. Take a screenshot before and after you act."
    : "";
  const opening = issued.always
    ? "Open this Reach link in your browser; the owner will match your connection code. Your access lasts until the owner ends it, in this browser: if you close the page, open it again in the same browser and you are back. The link works once; for a different browser, ask the owner to reopen it."
    : "Open this temporary Reach link in your browser and keep it open; the owner will match your connection code.";
  return `${opening} ${grant}${protectedWords}${sharing} Use the Screen, Files and Terminal tabs or the window.reach tools (listTools). Never invite anyone, delegate access, or share this link or your credentials.\n\n${link}`;
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
// Apps worth hiding first under Full control: where codes and mail arrive.
const SUGGESTED_HIDDEN = ["com.apple.mobilesms", "com.apple.mail", "com.apple.facetime"];

type Props = {
  peer: Peer;
  device: Device;
  keyPeer: Peer | null;
  onSetup: () => void;
  onCreated: (created: Created, link: string) => void;
};
export default function BrowserInvite(props: Props) {
  return <BrowserInviteForm key={`${props.peer.id}:${props.peer.url}:${props.peer.token}`} {...props} />;
}
function BrowserInviteForm({ peer, device, onCreated }: Props) {
  const [name, setName] = useState(() => inviteName());
  const [preset, setPreset] = useState<Preset | null>(null);
  const [minutes, setMinutes] = useState(30);
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
  const [made, setMade] = useState<{ link: string; name: string; expiresAt: number; joinBy: number; message: string; always: boolean } | null>(null);
  const alive = useRef(true);
  const creation = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; creation.current?.abort(); };
  }, []);
  useEffect(() => {
    let live = true;
    request<Options>(peer, "/api/agents/browser-options")
      .then((value) => live && setOptions(value))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [peer.url, peer.token]);

  const catalog = options?.presetApps || [];
  const pickerApps: PickerApp[] = catalog.map((app) => ({
    id: app.id, name: app.name, protected: app.protected, reason: app.reason,
    ...(app.runsCommands ? { note: "Runs commands as you" } : {}),
  }));
  const hideableApps: PickerApp[] = catalog.filter((app) => !app.protected).map((app) => ({ id: app.id, name: app.name }));
  const suggested = hideableApps.filter((app) => SUGGESTED_HIDDEN.includes((catalog.find((entry) => entry.id === app.id)?.bundleId || "").toLowerCase()));
  const screenPreset = preset === "full" || preset === "apps" || preset === "readonly";
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
  const create = async () => {
    if (busy || missing || !preset) return;
    setBusy(true); setError(""); setCopied(false); setShareNote("");
    let created: Created | null = null;
    const controller = new AbortController();
    creation.current = controller;
    const everything = preset !== "files" && preset !== "apps" && !folders.length;
    try {
      const result = await request<{ invitation: string; clientId: string; expiresAt: number; joinBy: number; url: string }>(peer, "/api/agents/browser-invitations", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          name: name.trim(), transport: "funnel", preset,
          ...(minutes === ALWAYS ? { standing: true } : { ttlSeconds: minutes * 60 }),
          ...(preset !== "apps" && folders.length ? { folders: folders.map(({ root, path }) => ({ root, path })) } : {}),
          ...(preset === "apps" ? { apps: apps.map((id) => ({ id })) } : {}),
          ...(preset === "files" && write ? { write: true } : {}),
          ...((preset === "full" || preset === "readonly") && hidden.length ? { hidden: hidden.map((id) => ({ id })) } : {}),
        }),
      });
      created = { peer, clientId: result.clientId, invitation: result.invitation };
      if (!alive.current || controller.signal.aborted) throw Error("Invitation creation was cancelled.");
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.pathname !== "/agent-browser" || url.username || url.password || url.search ||
          new URLSearchParams(url.hash.slice(1)).get("invite") !== result.invitation)
        throw Error("The temporary connection link could not be prepared.");
      const link = url.href;
      setMade({
        link, name: name.trim(), expiresAt: result.expiresAt, joinBy: result.joinBy, always: minutes === ALWAYS,
        message: museMessage(link, {
          preset, apps: chosenApps.map((app) => app.name), folders: folders.map((folder) => folder.full || folder.label),
          write: preset === "files" && write, hidden: hiddenApps.map((app) => app.name), everything, always: minutes === ALWAYS,
        }),
      });
      onCreated(created, link);
    } catch (e) {
      if (created) await request(peer, `/api/clients/${created.clientId}`, { method: "DELETE" }).catch(() => {});
      if (alive.current && !controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (alive.current && !controller.signal.aborted) setBusy(false);
      if (creation.current === controller) creation.current = null;
    }
  };
  const copyMessage = async () => {
    if (!made) return;
    setShareNote("");
    try { await navigator.clipboard.writeText(made.message); setCopied(true); }
    catch { setShowMessage(true); setShareNote("Select the message below and copy it."); }
  };
  const shareMessage = async () => {
    if (!made) return;
    setShareNote("");
    try {
      const text = made.message;
      if (isNative) await NativeShare.share({ title: "Connect to Reach", text });
      else if (navigator.share) await navigator.share({ title: "Connect to Reach", text });
      else await copyMessage();
    } catch (e) {
      if (!shareCancelled(e)) setShareNote("Couldn’t open sharing. Copy the prompt and link instead.");
    }
  };
  const toggleRow = (row: string) => setOpenRow((current) => (current === row ? null : row));
  const minutesLabel = minutes === ALWAYS ? "" : minutes === 1440 ? "24 hours" : minutes === 60 ? "1 hour" : `${minutes} minutes`;
  const dayAllowed = (options?.maxFunnelSeconds ?? 3600) >= 86400;
  const alwaysAllowed = options?.standingAllowed === true;
  const summary = !preset ? "" : `${name.trim()} gets ${{
    full: `full control of this Mac${hidden.length ? `, except ${listWords(hiddenApps.map((app) => app.name))}` : ""}`,
    apps: chosenApps.length ? `${listWords(chosenApps.slice(0, 3).map((app) => app.name))}${chosenApps.length > 3 ? ` and ${chosenApps.length - 3} more` : ""}, nothing else` : "the apps you pick",
    files: folders.length ? `${folders.length === 1 ? folders[0].label : `${folders.length} folders`}, ${write ? "read and edit" : "read only"}` : "the folders you pick",
    readonly: `a look at the screen and files${hidden.length ? `, except ${listWords(hiddenApps.map((app) => app.name))}` : ""}, no touching`,
  }[preset]} ${minutes === ALWAYS ? "until you end it" : `for ${minutesLabel}`}.`;
  const at = (value: number) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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
          <button type="button" className="ag-roll" aria-label="New name" onClick={() => setName((current) => inviteName(Math.random, current))}>
            <Dices size={19} />
          </button>
        </div>

        <p className="ag-label">What it may do</p>
        <Choices
          name="agent-preset"
          label="Access preset"
          value={preset ?? ("" as Preset)}
          onChange={choose}
          options={(["full", "apps", "files", "readonly"] as Preset[]).map((value) => ({
            value, title: PRESET_WORDS[value].title, detail: PRESET_WORDS[value].detail,
            disabled: !!options && (value === "files" ? !filesSupported : !desktopReady),
          }))}
        />

        {preset === "apps" && (
          <div className="ag-rows">
            <AccessRow
              icon={<AppWindow />}
              label="Apps it may use"
              value={chosenApps.length ? <AppStack peer={peer} apps={chosenApps} /> : "Pick apps"}
              open={openRow === "apps"}
              onToggle={() => toggleRow("apps")}
              attention={!apps.length}
            >
              <p className="ag-quiet">It sees and touches only these. Your browser with its saved logins counts as one app.</p>
              {!options ? <p className="ag-quiet">Loading apps…</p>
                : options.presetAppsError ? <p className="ag-error" role="alert">{options.presetAppsError}</p>
                  : <AppPicker peer={peer} apps={pickerApps} chosen={apps} onChange={setApps} chosenWords="Can use it" />}
            </AccessRow>
          </div>
        )}
        {preset === "files" && (
          <div className="ag-rows">
            <AccessRow
              icon={<Folder />}
              label="Folders"
              value={folders.length ? (folders.length === 1 ? folders[0].label : `${folders.length} folders`) : "Pick folders"}
              open={openRow === "folders"}
              onToggle={() => toggleRow("folders")}
              attention={!folders.length}
            >
              <p className="ag-quiet">Your real folders. Home itself and system folders can't be chosen.</p>
              <FolderBrowser peer={peer} device={device} picked={folders} onChange={setFolders} />
            </AccessRow>
            <div className="ag-row">
              <div className="ag-row-head ag-row-static">
                <span className="ag-row-icon"><Pencil /></span>
                <span className="ag-row-label">Can edit</span>
                <span className="ag-row-value">{write ? "Changes files directly" : "Read only"}</span>
                <Switch label="Can edit files" checked={write} onChange={setWrite} />
              </div>
            </div>
          </div>
        )}
        {(preset === "full" || preset === "readonly") && (
          <div className="ag-rows">
            <AccessRow
              icon={<Folder />}
              label="Folders"
              value={folders.length ? (folders.length === 1 ? folders[0].label : `${folders.length} folders`) : "Everything you share"}
              open={openRow === "folders"}
              onToggle={() => toggleRow("folders")}
            >
              <p className="ag-quiet">Leave empty for every folder Reach shares, or limit it to a few.</p>
              <FolderBrowser peer={peer} device={device} picked={folders} onChange={setFolders} />
            </AccessRow>
            <AccessRow
              icon={<EyeOff />}
              label="Hide apps from it"
              value={hiddenApps.length ? <AppStack peer={peer} apps={hiddenApps} /> : "None"}
              open={openRow === "hidden"}
              onToggle={() => toggleRow("hidden")}
            >
              <p className="ag-quiet">Reach filters known password and Reach windows from pictures. Add apps where your codes and mail arrive. This does not limit Full control commands.</p>
              {suggested.length > 0 && !hidden.length && (
                <button type="button" className="ag-link" onClick={() => setHidden(suggested.map((app) => app.id))}>
                  Hide {listWords(suggested.map((app) => app.name))}
                </button>
              )}
              {!options ? <p className="ag-quiet">Loading apps…</p>
                : <AppPicker peer={peer} apps={hideableApps} chosen={hidden} onChange={setHidden} chosenWords="Hidden from it" chipsLabel="Hidden apps" />}
            </AccessRow>
          </div>
        )}

        {preset && (
          <p className="ag-note">
            {preset === "full" ? <ShieldCheck size={14} /> : preset === "readonly" ? <Eye size={14} /> : <Lock size={14} />}
            {{
              full: "Only invite an agent you trust with your account. Its commands can read sensitive files or change Reach. Screen protections are guardrails, not a sandbox. Anything already signed in is available. Touching the Mac pauses input.",
              apps: "Only these apps appear on its screen and take its clicks. Reach filters known protected windows and blocks password fields. A selected terminal or IDE can still run commands as you.",
              files: write ? "Changes land in your real folders at once. Reach's own files and your secret files stay closed." : "It reads your real folders. Nothing is copied, nothing changes.",
              readonly: "It watches the screen and reads files. Passwords and Reach stay out of its pictures.",
            }[preset]}
          </p>
        )}

        <Segments label="Access duration" value={minutes} onChange={setMinutes} options={[{ value: 15, label: "15 min" }, { value: 30, label: "30 min" }, { value: 60, label: "1 hour" }, ...(dayAllowed ? [{ value: 1440, label: "24 hours" }] : []), ...(alwaysAllowed ? [{ value: ALWAYS, label: "Always" }] : [])]} />
        {minutes === 1440 && <p className="ag-quiet">A day is long for an agent on your Mac. You can end or pause it any time from Settings → Agents.</p>}
        {minutes === ALWAYS && <p className="ag-quiet">Until you end it in Settings → Agents. {name.trim() || "The agent"} comes back from the same browser with no new invite. The link works once; for a new browser, tap Reopen link in Settings → Agents. The public link stays up while it has access.</p>}

        <div className="ag-send">
          <button className="ag-primary ag-wide" disabled={busy || !!missing || !options} onClick={() => void create()}>
            {busy ? "Creating link…" : "Create invite link"}
          </button>
          <p className={`ag-summary${missing ? " is-missing" : ""}`} aria-live="polite">{missing || summary}</p>
        </div>
        {error && <p className="ag-error" role="alert">{error}</p>}
        {options && !macHost && !filesSupported && !desktopReady && (
          <p className="ag-quiet ag-center">Browser invitations currently require macOS. Your own Files and terminals remain available. For an agent, choose Command line access.</p>
        )}
        {options && !filesSupported && (macHost || desktopReady) && (
          <p className="ag-quiet ag-center">Browser-agent file access requires macOS. Your own Files and terminals remain available.</p>
        )}
        {options && !desktopReady && macHost && (
          <p className="ag-quiet ag-center"><Monitor size={12} /> Screen presets need this Mac's Screen Recording and Accessibility for Reach.</p>
        )}
      </div>

      {made && (
        <section className="ag-done" aria-label="AI browser invite link" aria-live="polite">
          <AgentAvatar name={made.name} size={56} done />
          <h3>Link ready for {made.name}</h3>
          <p className="ag-quiet">{made.always ? "Until you end it in Settings → Agents" : `Join by ${at(made.joinBy)} · ends ${at(made.expiresAt)}`}</p>
          <div className="ag-done-actions">
            <button className="ag-primary" onClick={() => void copyMessage()}>
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? "Copied" : "Copy invite"}
            </button>
            <button className="ag-secondary" onClick={() => void shareMessage()}>
              <Share2 size={17} /> Share…
            </button>
          </div>
          {shareNote && <p className="ag-note is-warn" role="status">{shareNote}</p>}
          <p className="ag-quiet">Paste it into {made.name}. When it connects, match the connection code in Home → Needs you, then approve.</p>
          <details className="ag-message" open={showMessage} onToggle={(e) => setShowMessage(e.currentTarget.open)}>
            <summary>What {made.name} will read <ChevronDown size={15} /></summary>
            <textarea className="browser-invite-message" aria-label="AI browser invitation message" readOnly rows={6} value={made.message} onFocus={(e) => e.target.select()} />
          </details>
          <button
            className="ag-link"
            onClick={() => {
              // A fresh invitation: a new name and no choices carried over.
              setMade(null);
              setName((current) => inviteName(Math.random, current));
              setPreset(null); setApps([]); setFolders([]); setWrite(false); setHidden([]); setOpenRow(null);
              setCopied(false); setShareNote(""); setShowMessage(false);
            }}
          >
            Invite another agent
          </button>
        </section>
      )}
    </section>
  );
}
