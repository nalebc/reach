import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Briefcase,
  Check,
  Copy,
  Dices,
  Eye,
  Folder,
  KeyRound,
  MousePointer2,
  Pencil,
  Search,
  Share2,
  Clock3,
  Monitor,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { post, request, type Device, type Peer } from "./api";
import { workspaceCapabilities } from "./capabilities";
import { guestLinkUrl, parseGuestLink } from "./start-flow";
import { computerWord } from "./pause";
import { tailscaleShareUrl } from "./invitation";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import { InviteLinksSetup } from "./InviteLinksSetup";
import BrowserInvite, { NO_RUNTIME, agentInviteMessage, inviteName } from "./BrowserInvite";
import {
  Choices,
  Item,
  Menu,
  Places,
  Row,
  Section,
  type Choice,
} from "./invite-menu";
import type { EditableAccess } from "./AccessEditor";
import "./invite-sheet.css";

// Inviting a person, or an agent over Command line (BrowserInvite has the
// other ways an agent connects), as one short form: what they may do as a
// list with icons, then their name and how long, then one white pill; the
// link replaces the form. Permissions are checked on every request.

type Role = "watch" | "control" | "files" | "work" | "full" | "custom";
export type Created = { peer: Peer; clientId: string; invitation: string };
export type Guest = EditableAccess & { group?: string };
// A link made here, by invitation (a computer never keeps them).
export type MadeLink = { link: string; keyed: boolean; created: Created[]; runtime?: string };
const ROLES: {
  value: Role;
  label: string;
  description: string;
  screen?: true;
}[] = [
  {
    value: "watch",
    label: "Can watch",
    description: "See your screen and apps.",
    screen: true,
  },
  {
    value: "control",
    label: "Can control",
    description: "Use your mouse and keyboard.",
    screen: true,
  },
  {
    value: "files",
    label: "Can use files",
    description: "Only the folders you pick.",
  },
  {
    value: "work",
    label: "Can work",
    description: "Folders, a terminal and AI.",
  },
  {
    value: "full",
    label: "Full access",
    description: "Every window, private data and system dialogs. Only invite someone you trust with your computer.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Pick exactly what.",
  },
];
const DURATIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "1 day" },
];
// An agent: what it may do in the folders you choose, for how long.
type AgentRole = "read" | "edit" | "run";
const AGENT_ROLES: { value: AgentRole; label: string; description: string }[] =
  [
    {
      value: "read",
      label: "Can read",
      description: "Only reads the folders.",
    },
    {
      value: "edit",
      label: "Can edit",
      description: "Reads and changes files.",
    },
    {
      value: "run",
      label: "Can run commands",
      description:
        "Commands run as you, so they can reach beyond those folders.",
    },
  ];
// Their icons in the invitation's lists.
const ROLE_ICONS: Record<Role, Choice<Role>["icon"]> = {
  watch: Eye,
  control: MousePointer2,
  files: Folder,
  work: Briefcase,
  full: KeyRound,
  custom: SlidersHorizontal,
};
const AGENT_ROLE_ICONS: Record<AgentRole, Choice<AgentRole>["icon"]> = {
  read: Eye,
  edit: Pencil,
  run: SquareTerminal,
};
const AGENT_DAYS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "1 week" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
// Changing what someone may use later, from their row: no new link. The
// computer checks it as it checks an invitation (POST /api/guests/:id/access).
export type Level =
  "watch" | "control" | "open" | "edit" | "work" | "full" | "read" | "run";
export const LEVELS: {
  value: Level;
  label: string;
  description: string;
  screen?: true;
  folders?: true;
}[] = [
  { ...ROLES[0], value: "watch" },
  { ...ROLES[1], value: "control" },
  {
    value: "open",
    label: "Can open files",
    description: "Open the folders you chose.",
    folders: true,
  },
  {
    value: "edit",
    label: "Can edit files",
    description: "Open and change the folders you chose.",
    folders: true,
  },
  { ...ROLES[3], value: "work", folders: true },
  { ...ROLES[4], value: "full" },
];
export const AGENT_LEVELS: typeof LEVELS = AGENT_ROLES.map((r) => ({
  ...r,
  folders: true,
}));
// What their access is now, as one of those (or none: chosen piece by piece).
export function levelOf(g: Pick<Guest, "kind" | "scopes">): Level | "" {
  const s = new Set(g.scopes || []);
  if (g.kind === "agent")
    return s.has("exec") ? "run" : s.has("files:write") ? "edit" : "read";
  if (s.has("admin")) return "full";
  const files = s.has("files:read"),
    extras = s.has("terminal") || s.has("codex");
  if (s.has("screen") && !files && !extras)
    return s.has("screen:control") ? "control" : "watch";
  if (s.has("screen")) return "";
  if (files && s.has("files:write") && s.has("terminal") && s.has("codex"))
    return "work";
  if (files && !extras) return s.has("files:write") ? "edit" : "open";
  return "";
}
// What to ask the computer for: their folders are kept where they have some.
export const LEVEL_BODY: Record<Level, Record<string, unknown>> = {
  watch: { screen: "view", apps: "all" },
  control: { screen: "control", apps: "all" },
  open: { folders: "keep", write: false },
  edit: { folders: "keep", write: true },
  work: { folders: "keep", write: true, terminal: true, agents: true },
  full: { full: true, fullControlVersion: 1 },
  read: { folders: "keep", write: false },
  run: { folders: "keep", write: true, exec: true },
};
// Folders they have now, to keep (full access had "everything": not a choice).
export const hasFolders = (g: Guest) =>
  g.kind === "agent"
    ? (g.policy?.roots?.length || 0) > 0
    : !(g.scopes || []).includes("admin") && (g.guestRoots?.length || 0) > 0;
const startOf = (peer: Peer) => `https://${new URL(peer.url).hostname}`;
// An agent's link, carrying the SHA-256 of the runtime its computer named
// (r=): the steps at the link check the download against it, and so does
// join (Oct 12: "a very small prompt with a link"). A computer that names no
// runtime gets no link: "" (connections audit, Oct 10).
export const pinnedAgentLink = (link: string, runtime?: string) => {
  if (!runtime || !/^[0-9a-f]{64}$/.test(runtime)) return "";
  const url = new URL(link);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set("r", runtime);
  url.hash = params.toString();
  return url.href;
};
export const list = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
export const left = (until: number, now: number) => {
  const s = Math.max(0, Math.round((until - now) / 1000));
  return s >= 2 * 86400
    ? `${Math.floor(s / 86400)} days left`
    : s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min left`
    : s >= 60
      ? `${Math.ceil(s / 60)} min left`
      : s > 0
        ? `${s} s left`
        : "Ended";
};
// What a person's access is called, from what the computer granted.
export function accessLabel(scopes: string[] = []) {
  if (scopes.includes("admin")) return "Full access";
  const parts = [
    scopes.includes("screen:control")
      ? "Controls screen"
      : scopes.includes("screen")
        ? "Watches screen"
        : "",
    scopes.includes("apps:open") ? "Watches apps" : "",
    scopes.includes("files:write")
      ? "Edits files"
      : scopes.includes("files:read")
        ? "Opens files"
        : "",
    scopes.includes("exec") ? "Runs commands" : "",
    scopes.includes("terminal") ? "Terminal" : "",
    scopes.includes("codex") ? "AI sessions" : "",
  ].filter(Boolean);
  return parts.join(" · ") || "No access";
}

// The pickers live in invite-menu.tsx (shared with BrowserInvite).
export { Menu, Item };
function Toggle({
  on,
  label,
  detail,
  onChange,
}: {
  on: boolean;
  label: string;
  detail?: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="ivt-toggle">
      <span>
        {label}
        {detail && <small>{detail}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function InviteSheet({
  peer,
  device,
  peers = [peer],
  initialKind = "person",
  onCreated,
}: {
  peer: Peer;
  device: Device;
  peers?: Peer[];
  // An agent's Command line form ("agent") opens directly only where agent
  // presets aren't offered; elsewhere it's reached from BrowserInvite.
  initialKind?: "person" | "browser" | "agent";
  // Each link made (or given its key later), for the list of who has access.
  onCreated?: (clientId: string, made: MadeLink) => void;
}) {
  const [kind, setKind] = useState<"person" | "agent" | "browser">(initialKind);
  // How an agent connects, kept when it goes to Command line and back.
  const [via, setVia] = useState<"tools" | "page" | "hosted">("tools");
  const [name, setName] = useState("");
  // An agent's name: a fresh silly one, kept between the ways it connects.
  const [agentName, setAgentName] = useState(() => inviteName());
  const [role, setRole] = useState<Role>("watch");
  const [agentRole, setAgentRole] = useState<AgentRole>("edit");
  const [agentDays, setAgentDays] = useState(7);
  const [minutes, setMinutes] = useState(240);
  const [computers, setComputers] = useState<string[]>([peer.id]);
  // Custom access.
  const [screen, setScreen] = useState<"off" | "view" | "control">("view");
  const [apps, setApps] = useState<"off" | "all" | "pick">("off");
  const [appIds, setAppIds] = useState<string[]>([]);
  const [files, setFiles] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [agents, setAgents] = useState(false);
  const [write, setWrite] = useState(false);
  // Folders are chosen per computer, starting with none: the first one is
  // often the whole home folder.
  const [folders, setFolders] = useState<Record<string, PickedFolder[]>>({});
  const [browsing, setBrowsing] = useState(peer.id);
  const [appList, setAppList] = useState<{ id: string; name: string }[]>([]);
  const [appQuery, setAppQuery] = useState("");
  const [devices, setDevices] = useState<Record<string, Device>>({
    [peer.id]: device,
  });
  const [keyed, setKeyed] = useState<boolean | null>(null);
  // The computer holding the invite-link credential: this one, or any of
  // your linked computers (set up once for all of them).
  const [keyPeer, setKeyPeer] = useState<Peer | null>(null);
  const [policy, setPolicy] = useState<unknown>(null);
  // The one-time setup: a slim line until you open it.
  const [setupOpen, setSetupOpen] = useState(false);
  // Why this computer can't make invite keys at all (a Windows Reach): said
  // instead of a setup that can't work there.
  const [noKeys, setNoKeys] = useState("");
  // Set up, but the tailnet policy lets every device reach everything.
  const [openPolicy, setOpenPolicy] = useState(false);
  // Links made here, by invitation (a computer never keeps them).
  const [links, setLinks] = useState<Record<string, MadeLink>>({});
  const told = useRef<Record<string, MadeLink>>({});
  useEffect(() => {
    for (const id of Object.keys(links))
      if (links[id] !== told.current[id]) onCreated?.(id, links[id]);
    told.current = links;
  }, [links]);
  const [made, setMade] = useState<{
    clientId: string;
    guest: string;
    expiresAt: number;
    summary: string;
    // What they may do and for how long, in a few words.
    access: string;
    // An agent's: it must join by then.
    joinBy?: number;
  } | null>(null);
  const [share, setShare] = useState("");
  const [onTailnet, setOnTailnet] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // A new link scrolls into view once.
  const linkCard = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const p of [peer, ...peers.filter((x) => x.id !== peer.id)]) {
        try {
          const r = await request<{
            configured: boolean;
            available?: boolean;
            why?: string;
            policy: unknown;
          }>(p, "/api/guests/keys");
          if (live && p.id === peer.id) {
            setPolicy(r.policy);
            setNoKeys(r.available === false ? r.why || "Invite links aren’t available on this computer." : "");
          }
          if (r.configured) {
            if (live) {
              setKeyPeer(p);
              setKeyed(true);
            }
            return;
          }
        } catch {}
      }
      if (live) setKeyed(false);
    })();
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, peers.map((p) => p.id).join(",")]);
  useEffect(() => {
    for (const p of peers)
      if (
computers.includes(p.id) && !devices[p.id]
      )
        request<Device>(p, "/api/device")
          .then((d) => setDevices((old) => ({ ...old, [p.id]: d })))
          .catch(() => {});
  }, [
    computers.join(","),
    peers.map((p) => p.id).join(","),
  ]);
  useEffect(() => {
    if (apps !== "pick" || appList.length) return;
    request<{ id: string; name: string }[]>(peer, "/api/apps")
      .then((r) => setAppList(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, [apps]);

  const chosen = peers.filter((p) => computers.includes(p.id));
  // Somewhere they could watch: Windows refuses invited people its screen
  // for now (server/capabilities.mjs guestScreen).
  const watchable = (d?: Device | null) => !!d && workspaceCapabilities(d).screen && d.capabilities.guestScreen !== false;
  const screenOk = watchable(device) || chosen.some((p) => watchable(devices[p.id]));
  const roles = ROLES.filter((r) => screenOk || !r.screen);
  const current = roles.find((r) => r.value === role) || roles[0];
  // What the chosen access grants.
  const grant =
    current.value === "full"
      ? { full: true as const }
      : current.value === "watch"
        ? { screen: "view" as const, apps: "all" as const }
        : current.value === "control"
          ? { screen: "control" as const, apps: "all" as const }
          : current.value === "files"
            ? { files: true }
            : current.value === "work"
              ? { files: true, terminal: true, agents: true }
              : {
                  ...(screen !== "off" && screenOk ? { screen } : {}),
                  ...(apps === "all" && screenOk
                    ? { apps: "all" as const }
                    : {}),
                  ...(apps === "pick" && screenOk ? { apps: appIds } : {}),
                  ...(files ? { files: true } : {}),
                  ...(terminal ? { terminal: true } : {}),
                  ...(agents ? { agents: true } : {}),
                };
  const usesFiles = "files" in grant && !!grant.files;
  const canEdit = current.value === "work" || write;
  const body = (p: Peer) =>
    "full" in grant
      ? { full: true, fullControlVersion: 1 }
      : {
          roots: [],
          folders: usesFiles
            ? (folders[p.id] || []).map(({ root, path }) => ({ root, path }))
            : [],
          write: usesFiles && canEdit,
          screen: "screen" in grant && grant.screen ? grant.screen : false,
          ...("apps" in grant && grant.apps ? { apps: grant.apps } : {}),
          terminal: "terminal" in grant && !!grant.terminal,
          agents: "agents" in grant && !!grant.agents,
        };
  const folderNames = chosen.flatMap((p) =>
    (folders[p.id] || []).map((f) => f.label),
  );
  const doing =
    "full" in grant
      ? ["use everything you can, except managing access"]
      : [
          ...("screen" in grant && grant.screen === "view"
            ? ["watch your screen"]
            : []),
          ...("screen" in grant && grant.screen === "control"
            ? ["control your screen"]
            : []),
          ...("apps" in grant && grant.apps ? ["watch the apps you open"] : []),
          ...(usesFiles
            ? [
                `${canEdit ? "edit" : "open"} ${folderNames.length ? list(folderNames) : "the folders you choose"}`,
              ]
            : []),
          ...("terminal" in grant && grant.terminal ? ["use a terminal"] : []),
          ...("agents" in grant && grant.agents ? ["use AI sessions"] : []),
        ];
  const duration = DURATIONS.find((d) => d.minutes === minutes)!.label;
  const who = name.trim();
  const summary = `${who || "They"} can ${list(doing) || "do nothing yet"}${chosen.length ? ` on ${list(chosen.map((p) => p.name))}` : ""} for ${duration}.`;
  const missing = !who
    ? "Add their name."
    : !chosen.length
      ? "Choose a computer."
      : !doing.length
        ? "Choose what they can use."
        : usesFiles && chosen.some((p) => !(folders[p.id] || []).length)
          ? `Choose a folder${chosen.length > 1 ? " on each computer" : ""}.`
          : "apps" in grant && Array.isArray(grant.apps) && !grant.apps.length
            ? "Choose at least one app."
            : "";

  // An agent: one computer, at least one folder.
  const agent = kind === "agent";
  const agentWho = agentName.trim();
  const agentPeer = chosen[0] || peer;
  const agentFolders = folders[agentPeer.id] || [];
  const agentDuration = AGENT_DAYS.find((d) => d.days === agentDays)!.label;
  const agentSummary = `${agentWho || "The agent"} can ${
    { read: "read", edit: "read and edit", run: "edit and run commands in" }[
      agentRole
    ]
  } ${agentFolders.length ? list(agentFolders.map((f) => f.label)) : "the folders you choose"} on ${agentPeer.name} for ${agentDuration}.`;
  const agentMissing = !agentWho
    ? "Name the agent."
    : !agentFolders.length
      ? "Choose a folder."
      : "";

  const cancel = (created: Created[]) =>
    Promise.allSettled(
      created.map((c) =>
        request(c.peer, `/api/clients/${c.clientId}`, { method: "DELETE" }),
      ),
    );
  const invite = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError("");
    setNote("");
    const created: Created[] = [];
    // One id for this invitation on every computer it covers, so changing
    // their access later changes it everywhere.
    const group = crypto.randomUUID();
    try {
      // Each chosen computer makes its own invitation…
      for (const p of chosen) {
        const g = await post(p, "/api/guests", {
          name: who,
          ttlSeconds: minutes * 60,
          group,
          ...body(p),
        });
        created.push({
          peer: p,
          clientId: g.clientId,
          invitation: g.invitation,
        });
      }
      // …and the computer holding the invite-link credential makes the one
      // key, whichever computers the invitation covers.
      const key: { key: string; hostname: string } | null = keyPeer
        ? await post(keyPeer, "/api/guests/key", {
            ttlSeconds: minutes * 60,
            clientIds: created
              .filter((c) => c.peer.id === keyPeer.id)
              .map((c) => c.clientId),
          })
        : null;
      const link = guestLinkUrl(startOf(peer), {
        key: key?.key || "",
        hostname: key?.hostname || "",
        invites: created.map((c) => ({
          origin: new URL(c.peer.url).origin,
          secret: c.invitation,
        })),
      });
      const first = created[0].clientId;
      setLinks((old) => ({ ...old, [first]: { link, keyed: !!key, created } }));
      setMade({
        clientId: first,
        guest: who,
        expiresAt: Date.now() + minutes * 60000,
        summary,
        access: `${current.label} · ${duration}`,
      });
      setName("");
      setShare("");
      setOnTailnet(false);
    } catch (e) {
      // All or nothing: undo the invitations already made.
      await cancel(created);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inviteAgent = async () => {
    if (agentMissing || busy) return;
    setBusy(true);
    setError("");
    setNote("");
    const p = agentPeer;
    let created: Created | null = null;
    try {
      const g = await post<{
        invitation: string;
        clientId: string;
        expiresAt: number;
        joinBy: number;
        runtime?: string;
      }>(p, "/api/agents/invitations", {
        name: agentWho,
        ttlSeconds: agentDays * 86400,
        folders: agentFolders.map(({ root, path }) => ({ root, path })),
        write: agentRole !== "read",
        exec: agentRole === "run",
      });
      created = { peer: p, clientId: g.clientId, invitation: g.invitation };
      // Its key only needs to last until it joins. It comes from the agent's
      // own computer, so ending its access there also removes its device
      // from the tailnet. Not set up there: no key (shared as for anyone not
      // on your tailnet), never one from another computer, which couldn't
      // tell when this access ends.
      const keyFor = (ids: string[]) => ({
        ttlSeconds: agentDays * 86400,
        keySeconds: Math.max(60, Math.round((g.joinBy - Date.now()) / 1000)),
        clientIds: ids,
      });
      let key: { key: string; hostname: string } | null = null;
      if (keyPeer)
        try {
          key = await post(p, "/api/guests/key", keyFor([g.clientId]));
        } catch (e) {
          if (keyPeer.id === p.id) throw e;
        }
      const link = guestLinkUrl(
        startOf(p),
        {
          key: key?.key || "",
          hostname: key?.hostname || "",
          invites: [{ origin: new URL(p.url).origin, secret: g.invitation }],
        },
        "/agent",
      );
      setLinks((old) => ({
        ...old,
        [g.clientId]: { link, keyed: !!key, created: [created!], runtime: g.runtime },
      }));
      setMade({
        clientId: g.clientId,
        guest: agentWho,
        expiresAt: g.expiresAt,
        joinBy: g.joinBy,
        summary: agentSummary,
        access: `${AGENT_ROLES.find((r) => r.value === agentRole)!.label} · ${agentDuration}`,
      });
    } catch (e) {
      if (created) await cancel([created]);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    linkCard.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [made?.clientId]);
  const madeLink = made ? links[made.clientId] : null;
  const shareLink = tailscaleShareUrl(share);
  const ready = !!madeLink && (madeLink.keyed || onTailnet || !!shareLink);
  const message = (
    m: NonNullable<typeof made>,
    l: NonNullable<typeof madeLink>,
  ) =>
    l.keyed || onTailnet
      ? `${m.summary.replace(/^.+? can/, "You can")}\n${l.link}`
      : [
          m.summary.replace(/^.+? can/, "You can"),
          "1. Install Tailscale: https://tailscale.com/download",
          `2. Accept my share: ${shareLink}`,
          `3. Open: ${l.link}`,
        ].join("\n");
  const copy = async (text: string, done = "Link copied") => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(done);
    } catch {
      setNote("Select the link and copy it.");
    }
  };
  const send = async (text: string) => {
    try {
      if (isNative) await NativeShare.share({ text });
      else if (navigator.share) await navigator.share({ text });
      else await copy(text);
    } catch (e) {
      if (!/cancel|abort/i.test((e as Error).message || (e as Error).name))
        setNote("Couldn’t open sharing. Copy the link instead.");
    }
  };
  // A fresh invitation after the last one: back to the form.
  const another = () => {
    setMade(null);
    setNote("");
    setError("");
    if (agent) setAgentName((current) => inviteName(Math.random, current));
  };
  const at = (value: number) =>
    new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  // Where it runs and what it may do: the agent's form, before Command line's.
  const toBrowser = (v: "tools" | "page" | "hosted") => {
    setVia(v);
    setKind("browser");
    setError("");
  };
  const computerRow = peers.length > 1 && (
    <Row icon={<Monitor size={19} />} label="Computer">
      <Menu
        label={
          agent
            ? agentPeer.name
            : chosen.length
              ? list(chosen.map((p) => p.name))
              : "No computer"
        }
        className="ivt-role"
      >
        {(close) =>
          peers.map((p) => (
            <Item
              key={p.id}
              on={computers.includes(p.id)}
              label={p.name}
              onClick={() => {
                if (agent) {
                  setComputers([p.id]);
                  close();
                } else
                  setComputers(
                    computers.includes(p.id)
                      ? computers.filter((id) => id !== p.id)
                      : [...computers, p.id],
                  );
              }}
            />
          ))
        }
      </Menu>
    </Row>
  );
  const folderPicker = (
    <div className="ivt-panel" aria-label="Folders">
      {!agent && chosen.length > 1 && (
        <div className="ivt-segment" role="tablist" aria-label="Computer">
          {chosen.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={
                (chosen.find((x) => x.id === browsing) || chosen[0]).id === p.id
              }
              onClick={() => setBrowsing(p.id)}
            >
              {p.name}
              {(folders[p.id] || []).length > 0 &&
                ` · ${(folders[p.id] || []).length}`}
            </button>
          ))}
        </div>
      )}
      {(() => {
        const p = agent
          ? agentPeer
          : chosen.find((x) => x.id === browsing) || chosen[0];
        return (
          p && (
            <FolderBrowser
              key={p.id}
              peer={p}
              device={devices[p.id]}
              picked={folders[p.id] || []}
              onChange={(next) => setFolders({ ...folders, [p.id]: next })}
            />
          )
        );
      })()}
      {!agent && current.value !== "work" && (
        <Toggle
          on={write}
          label="Can edit"
          detail="Upload and change files"
          onChange={setWrite}
        />
      )}
    </div>
  );
  const setupLink = (
    <button
      type="button"
      className="ivt-primary small"
      onClick={() => {
        setSetupOpen(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }}
    >
      Set up invite links
    </button>
  );
  return (
    <div className={`ivt${kind !== "person" ? " ivt-agent" : ""}`}>
      <div className="ivt-composer">
        {openPolicy && (
          <p className="ivt-warn" role="status">
            Invite links are ready. Your Tailscale policy lets every device
            reach everything, so invited people and agents could reach more than
            Reach. To limit them, change that rule’s “*” to “autogroup:member”
            (your other tagged devices and people you shared devices with would
            then need their own rules).
          </p>
        )}
        {/* People and Command line agents need it to join from outside your
            tailnet; Tools and Web page agents don't (the public link), so
            for them it shows only when asked for. */}
        {keyed === false && noKeys && (kind !== "browser" || setupOpen) && (
          <p className="ivt-quiet ivt-no-keys">{noKeys}</p>
        )}
        {keyed === false && !noKeys && ((kind !== "browser" && !made) || setupOpen) && (
          <InviteLinksSetup
            peer={peer}
            policy={policy}
            open={setupOpen}
            onOpen={() => setSetupOpen(true)}
            onClose={() => setSetupOpen(false)}
            onDone={async (result) => {
              setKeyPeer(peer);
              setKeyed(true);
              setSetupOpen(false);
              setOpenPolicy(!!result.allowAll);
              // A link made before setup gets its key now: they just open it.
              const pending = made && links[made.clientId];
              if (made && pending && !pending.keyed)
                try {
                  const secondsTo = (t: number) =>
                    Math.round((t - Date.now()) / 1000);
                  // An agent must still join in time; its key lasts until then.
                  if (made.joinBy && secondsTo(made.joinBy) < 60)
                    throw Error(
                      `${made.guest} didn’t join in time. Invite the agent again.`,
                    );
                  const key: { key: string; hostname: string } = await post(
                    peer,
                    "/api/guests/key",
                    {
                      ttlSeconds: Math.min(
                        made.joinBy ? 90 * 86400 : 86400,
                        Math.max(60, secondsTo(made.expiresAt)),
                      ),
                      ...(made.joinBy
                        ? { keySeconds: secondsTo(made.joinBy) }
                        : {}),
                      clientIds: pending.created
                        .filter((c) => c.peer.id === peer.id)
                        .map((c) => c.clientId),
                    },
                  );
                  const link = guestLinkUrl(
                    new URL(pending.link).origin,
                    {
                      key: key.key,
                      hostname: key.hostname,
                      invites: parseGuestLink(new URL(pending.link).hash)
                        .invites,
                    },
                    made.joinBy ? "/agent" : "/guest",
                  );
                  setLinks((old) => ({
                    ...old,
                    [made.clientId]: { ...pending, link, keyed: true },
                  }));
                } catch (e) {
                  setError((e as Error).message);
                }
            }}
          />
        )}
        {kind === "browser" ? (
          <BrowserInvite
            peer={peer}
            device={device}
            keyPeer={keyPeer}
            onSetup={() => setSetupOpen(true)}
            initialConnect={via}
            initialName={agentName}
            onName={setAgentName}
            onCommandLine={() => {
              setKind("agent");
              setComputers([agentPeer.id]);
              setError("");
            }}
            onCreated={(created, link) => {
              setLinks((old) => ({
                ...old,
                [created.clientId]: { link, keyed: true, created: [created] },
              }));
            }}
          />
        ) : (
          <>
            <div className="inv-form" hidden={!!made}>
              {agent ? (
                <>
                  <Places via="cli" onChange={(v) => v !== "cli" && toBrowser(v)} />
                  <Section title="What can it do?">
                    <Choices
                      label="Agent access"
                      options={AGENT_ROLES.map((r) => ({
                        ...r,
                        icon: AGENT_ROLE_ICONS[r.value],
                      }))}
                      value={agentRole}
                      onChange={setAgentRole}
                    />
                  </Section>
                  <Section title="In these folders">
                    {computerRow && <div className="ivt-rows">{computerRow}</div>}
                    {folderPicker}
                  </Section>
                  <div className="ivt-rows">
                    <div className="ivt-row ivt-add">
                      <Bot size={19} aria-hidden="true" />
                      <input
                        id="invite-name"
                        className="ivt-name"
                        aria-label="Name"
                        placeholder="Name the agent"
                        maxLength={80}
                        value={agentName}
                        onChange={(e) => setAgentName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void inviteAgent()}
                      />
                      <button
                        type="button"
                        className="ag-roll"
                        aria-label="New name"
                        onClick={() =>
                          setAgentName((current) => inviteName(Math.random, current))
                        }
                      >
                        <Dices size={19} />
                      </button>
                    </div>
                    <Row icon={<Clock3 size={19} />} label="Expires">
                      <Menu label={agentDuration} className="ivt-role">
                        {(close) =>
                          AGENT_DAYS.map((d) => (
                            <Item
                              key={d.days}
                              on={d.days === agentDays}
                              label={d.label}
                              onClick={() => {
                                setAgentDays(d.days);
                                close();
                              }}
                            />
                          ))
                        }
                      </Menu>
                    </Row>
                  </div>
                </>
              ) : (
                <>
                  <div className="ivt-rows">
                    <div className="ivt-row ivt-add">
                      <UserRound size={19} aria-hidden="true" />
                      <input
                        id="invite-name"
                        className="ivt-name"
                        aria-label="Name"
                        placeholder="Their name"
                        maxLength={80}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void invite()}
                      />
                    </div>
                    {computerRow}
                  </div>
                  <Section title="What can they do?">
                    <Choices
                      label="Access"
                      options={roles.map((r) => ({
                        ...r,
                        icon: ROLE_ICONS[r.value],
                      }))}
                      value={current.value}
                      onChange={setRole}
                    />
                    {current.value === "custom" && (
                      <div className="ivt-panel" aria-label="Custom access">
                        {screenOk && (
                          <>
                            <Toggle
                              on={screen !== "off"}
                              label="Screen"
                              detail="See what’s on your screen"
                              onChange={(on) => setScreen(on ? "view" : "off")}
                            />
                            {screen !== "off" && (
                              <Toggle
                                on={screen === "control"}
                                label="Control the screen"
                                detail="Use your mouse and keyboard. You can take it back any time."
                                onChange={(on) => setScreen(on ? "control" : "view")}
                              />
                            )}
                            <Toggle
                              on={apps !== "off"}
                              label="Apps"
                              detail="Watch the apps you open on your phone"
                              onChange={(on) => setApps(on ? "all" : "off")}
                            />
                            {apps !== "off" && (
                              <div
                                className="ivt-segment"
                                role="radiogroup"
                                aria-label="Which apps"
                              >
                                {(["all", "pick"] as const).map((v) => (
                                  <button
                                    key={v}
                                    type="button"
                                    role="radio"
                                    aria-checked={apps === v}
                                    onClick={() => setApps(v)}
                                  >
                                    {v === "all" ? "Any app" : "Only some"}
                                  </button>
                                ))}
                              </div>
                            )}
                            {apps === "pick" && (
                              <div className="ivt-picks">
                                <label className="ivt-search">
                                  <Search size={15} />
                                  <input
                                    placeholder="Search apps"
                                    value={appQuery}
                                    onChange={(e) => setAppQuery(e.target.value)}
                                  />
                                </label>
                                {appList
                                  .filter((a) =>
                                    a.name
                                      .toLowerCase()
                                      .includes(appQuery.trim().toLowerCase()),
                                  )
                                  .slice(0, 40)
                                  .map((a) => (
                                    <Item
                                      key={a.id}
                                      on={appIds.includes(a.id)}
                                      label={a.name}
                                      onClick={() =>
                                        setAppIds(
                                          appIds.includes(a.id)
                                            ? appIds.filter((id) => id !== a.id)
                                            : [...appIds, a.id],
                                        )
                                      }
                                    />
                                  ))}
                              </div>
                            )}
                          </>
                        )}
                        <Toggle
                          on={files}
                          label="Folders"
                          detail="Open the folders you choose"
                          onChange={setFiles}
                        />
                        <Toggle
                          on={terminal}
                          label="Terminal"
                          detail="Their own terminals, not yours"
                          onChange={setTerminal}
                        />
                        <Toggle
                          on={agents}
                          label="AI sessions"
                          detail="Start Codex sessions on your computer"
                          onChange={setAgents}
                        />
                      </div>
                    )}
                    {usesFiles && folderPicker}
                  </Section>
                  <div className="ivt-rows">
                    <Row icon={<Clock3 size={19} />} label="Expires">
                      <Menu label={duration} className="ivt-role">
                        {(close) =>
                          DURATIONS.map((d) => (
                            <Item
                              key={d.minutes}
                              on={d.minutes === minutes}
                              label={d.label}
                              onClick={() => {
                                setMinutes(d.minutes);
                                close();
                              }}
                            />
                          ))
                        }
                      </Menu>
                    </Row>
                  </div>
                </>
              )}
              <div className="ivt-send">
                <p
                  className={`ivt-summary ${(agent ? agentMissing : missing) ? "muted" : ""}`}
                  aria-live="polite"
                >
                  {agent ? agentSummary : summary}
                </p>
                <button
                  className="ivt-primary ivt-submit"
                  disabled={!!(agent ? agentMissing : missing) || busy}
                  onClick={() => void (agent ? inviteAgent() : invite())}
                >
                  {busy ? "Creating…" : agent ? "Create invite" : "Create invite link"}
                </button>
              </div>
              {error && (
                <p className="ivt-error" role="alert">
                  {error}
                </p>
              )}
            </div>

            {/* Made: the link (or the agent's command) in place of the form,
                as the agent invitation's "ready" screen. */}
            {made && madeLink && made.joinBy && (
              <section
                className="ivt-link inv-done"
                aria-live="polite"
                ref={linkCard}
                aria-label="Agent invitation"
              >
                <span className="inv-done-icon" aria-hidden="true">
                  <Check size={26} strokeWidth={1.8} />
                </span>
                <h3>{made.guest} is invited</h3>
                <p className="inv-done-for">{made.access}</p>
                {(() => {
                  const link = pinnedAgentLink(madeLink.link, madeLink.runtime);
                  // The same line and link as an invite from Agents (BrowserInvite).
                  const text = agentInviteMessage("tools", link, computerWord(peer.platform));
                  if (!link) return <p className="ivt-quiet">{NO_RUNTIME}</p>;
                  return (
                    <>
                      <input
                        className="ivt-link-field"
                        aria-label="Link for the agent"
                        readOnly
                        value={link}
                        onFocus={(e) => e.target.select()}
                      />
                      <div className="inv-done-actions">
                        <button
                          className="ivt-primary"
                          onClick={() => void copy(text, "Copied")}
                        >
                          <Copy size={16} /> Copy
                        </button>
                        <button
                          className="ivt-secondary"
                          onClick={() => void send(text)}
                        >
                          <Share2 size={16} /> Share…
                        </button>
                      </div>
                    </>
                  );
                })()}
                <p className="ivt-quiet">
                  {note ||
                    `It opens the link and follows its steps within 15 minutes. Needs Node.js 22 or later${madeLink.keyed ? ", nothing else" : ""}. Then approve its code in Home → Needs you.`}
                </p>
                {!madeLink.keyed && (
                  <div className="ivt-tailscale">
                    <p>
                      Without invite links, its machine needs Tailscale on your
                      tailnet.
                    </p>
                    {setupLink}
                  </div>
                )}
                <button type="button" className="inv-again" onClick={another}>
                  Invite another agent
                </button>
              </section>
            )}
            {made && madeLink && !made.joinBy && (
              <section
                className="ivt-link inv-done"
                aria-live="polite"
                ref={linkCard}
                aria-label="Invite link"
              >
                <span className="inv-done-icon" aria-hidden="true">
                  <Check size={26} strokeWidth={1.8} />
                </span>
                <h3>{made.guest} is invited</h3>
                <p className="inv-done-for">{made.access}</p>
                {!madeLink.keyed && !onTailnet && (
                  <div className="ivt-tailscale">
                    <p>{made.guest} would need Tailscale for this link.</p>
                    {!noKeys && setupLink}
                    {/* No invite keys here: Tailscale sharing is the way. */}
                    <details className="ivt-fallback" open={!!noKeys || undefined}>
                      <summary>They already use Tailscale</summary>
                      <p>
                        Share this computer with them in Tailscale, then paste
                        that share link here.
                      </p>
                      <a
                        className="ivt-secondary"
                        href={`https://login.tailscale.com/admin/machines/${device.network?.ips?.find((ip) => ip.startsWith("100.")) || ""}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Tailscale sharing
                      </a>
                      <input
                        inputMode="url"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="Paste Tailscale’s share link"
                        aria-label="Tailscale’s share link"
                        value={share}
                        onChange={(e) => setShare(e.target.value)}
                      />
                      <Toggle
                        on={onTailnet}
                        label="They’re already on my Tailscale"
                        onChange={setOnTailnet}
                      />
                    </details>
                  </div>
                )}
                {ready && (
                  <>
                    <input
                      className="ivt-link-field"
                      aria-label="Invitation link"
                      readOnly
                      value={madeLink.link}
                      onFocus={(e) => e.target.select()}
                    />
                    <div className="inv-done-actions">
                      <button
                        className="ivt-primary"
                        onClick={() => void copy(message(made, madeLink))}
                      >
                        <Copy size={16} /> Copy link
                      </button>
                      <button
                        className="ivt-secondary"
                        onClick={() => void send(message(made, madeLink))}
                      >
                        <Share2 size={16} /> Share…
                      </button>
                    </div>
                    <p className="ivt-quiet">
                      {note ||
                        `Anyone with this link joins as ${made.guest} until ${at(made.expiresAt)}.${madeLink.keyed ? " Nothing to install." : ""}`}
                    </p>
                  </>
                )}
                <button type="button" className="inv-again" onClick={another}>
                  Invite someone else
                </button>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
