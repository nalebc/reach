import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Link2,
  Search,
  Share2,
  X,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { post, request, type Device, type Peer } from "./api";
import { workspaceCapabilities } from "./capabilities";
import { guestLinkUrl, parseGuestLink } from "./start-flow";
import { tailscaleShareUrl } from "./invitation";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import { InviteLinksSetup } from "./InviteLinksSetup";
import "./invite-sheet.css";

// Invite someone, the way Claude and ChatGPT share: a name, an access level
// with a plain description, Invite. Then a link to copy, and everyone who has
// access listed below. Each computer checks the access on every request.
// Or invite an agent: the same, and one command it runs to join.

type Role = "watch" | "control" | "files" | "work" | "full" | "custom";
type Created = { peer: Peer; clientId: string; invitation: string };
type Guest = {
  id: string;
  name: string;
  kind?: string;
  scopes?: string[];
  expiresAt?: number;
  status?: string;
  policy?: { invite?: boolean };
};
const ROLES: {
  value: Role;
  label: string;
  description: string;
  screen?: true;
}[] = [
  {
    value: "watch",
    label: "Can watch",
    description: "See your screen and the apps you open.",
    screen: true,
  },
  {
    value: "control",
    label: "Can control",
    description: "Use your mouse and keyboard, and watch your apps.",
    screen: true,
  },
  {
    value: "files",
    label: "Can use files",
    description: "Open or edit the folders you choose.",
  },
  {
    value: "work",
    label: "Can work",
    description: "Folders, a terminal and AI sessions.",
  },
  {
    value: "full",
    label: "Full access",
    description: "Everything you can do, except managing access.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Choose exactly what they can use.",
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
      description: "Read the folders you choose.",
    },
    {
      value: "edit",
      label: "Can edit",
      description: "Read and change files in them.",
    },
    {
      value: "run",
      label: "Can run commands",
      description:
        "Edit, and run commands there. Commands run as you, so they can reach beyond those folders.",
    },
  ];
const AGENT_DAYS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "1 week" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
const startOf = (peer: Peer) => `https://${new URL(peer.url).hostname}`;
// What an agent runs, once: Reach for agents from the computer's start page,
// then join with its link.
export const agentCommand = (start: string, link: string) =>
  `curl -fsSL --create-dirs -o ~/.reach-agent/agent.mjs ${start}/agent.mjs && node ~/.reach-agent/agent.mjs join '${link}'`;
const list = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const left = (until: number, now: number) => {
  const s = Math.max(0, Math.round((until - now) / 1000));
  return s >= 3600
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

// A small menu anchored to its button: options with a one-line description
// and a check, like the access pickers in Claude and ChatGPT.
function Menu({
  label,
  children,
  wide = false,
  className = "",
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className={`ivt-menu ${className}`} ref={box}>
      <button
        type="button"
        className="ivt-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className={`ivt-menu-list ${wide ? "wide" : ""}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
function Item({
  on,
  label,
  description,
  onClick,
}: {
  on: boolean;
  label: ReactNode;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      className="ivt-item"
      onClick={onClick}
    >
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      {on && <Check size={16} />}
    </button>
  );
}
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
}: {
  peer: Peer;
  device: Device;
  peers?: Peer[];
}) {
  const [kind, setKind] = useState<"person" | "agent">("person");
  const [name, setName] = useState("");
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
  // Set up, but the tailnet policy lets every device reach everything.
  const [openPolicy, setOpenPolicy] = useState(false);
  const [guests, setGuests] = useState<Guest[]>([]);
  // Links made here, by invitation (a computer never keeps them).
  const [links, setLinks] = useState<
    Record<string, { link: string; keyed: boolean; created: Created[] }>
  >({});
  const [made, setMade] = useState<{
    clientId: string;
    guest: string;
    expiresAt: number;
    summary: string;
    // An agent's: it must join by then.
    joinBy?: number;
  } | null>(null);
  const [share, setShare] = useState("");
  const [onTailnet, setOnTailnet] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now);
  // A new link scrolls into view once (not on every clock tick).
  const linkCard = useRef<HTMLElement>(null);

  const loadGuests = () =>
    request<{ clients: Guest[] }>(peer, "/api/clients")
      .then((r) =>
        setGuests(
          (r.clients || []).filter(
            (c) =>
              (c.kind === "guest" ||
                (c.kind === "agent" && c.policy?.invite)) &&
              (c.expiresAt || 0) > Date.now(),
          ),
        ),
      )
      .catch(() => {});
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const p of [peer, ...peers.filter((x) => x.id !== peer.id)]) {
        try {
          const r = await request<{ configured: boolean; policy: unknown }>(
            p,
            "/api/guests/keys",
          );
          if (live && p.id === peer.id) setPolicy(r.policy);
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
    void loadGuests();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(loadGuests, 10000);
    return () => {
      clearInterval(clock);
      clearInterval(refresh);
    };
  }, [peer.url, peer.token]);
  useEffect(() => {
    for (const p of peers)
      if (computers.includes(p.id) && !devices[p.id])
        request<Device>(p, "/api/device")
          .then((d) => setDevices((old) => ({ ...old, [p.id]: d })))
          .catch(() => {});
  }, [computers.join(","), peers.map((p) => p.id).join(",")]);
  useEffect(() => {
    if (apps !== "pick" || appList.length) return;
    request<{ id: string; name: string }[]>(peer, "/api/apps")
      .then((r) => setAppList(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, [apps]);

  const chosen = peers.filter((p) => computers.includes(p.id));
  const screenOk =
    workspaceCapabilities(device).screen ||
    chosen.some(
      (p) => devices[p.id] && workspaceCapabilities(devices[p.id]).screen,
    );
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
      ? { full: true }
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
  const agentPeer = chosen[0] || peer;
  const agentFolders = folders[agentPeer.id] || [];
  const agentDuration = AGENT_DAYS.find((d) => d.days === agentDays)!.label;
  const agentSummary = `${who || "The agent"} can ${
    { read: "read", edit: "read and edit", run: "edit and run commands in" }[
      agentRole
    ]
  } ${agentFolders.length ? list(agentFolders.map((f) => f.label)) : "the folders you choose"} on ${agentPeer.name} for ${agentDuration}.`;
  const agentMissing = !who
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
    try {
      // Each chosen computer makes its own invitation…
      for (const p of chosen) {
        const g = await post(p, "/api/guests", {
          name: who,
          ttlSeconds: minutes * 60,
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
      });
      setName("");
      setShare("");
      setOnTailnet(false);
      void loadGuests();
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
      }>(p, "/api/agents/invitations", {
        name: who,
        ttlSeconds: agentDays * 86400,
        folders: agentFolders.map(({ root, path }) => ({ root, path })),
        write: agentRole !== "read",
        exec: agentRole === "run",
      });
      created = { peer: p, clientId: g.clientId, invitation: g.invitation };
      // Its key only needs to last until it joins. It comes from the agent's
      // own computer when that one is set up, so ending its access there
      // also removes its device from the tailnet.
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
          key = await post(keyPeer, "/api/guests/key", keyFor([]));
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
        [g.clientId]: { link, keyed: !!key, created: [created!] },
      }));
      setMade({
        clientId: g.clientId,
        guest: who,
        expiresAt: g.expiresAt,
        joinBy: g.joinBy,
        summary: agentSummary,
      });
      setName("");
      void loadGuests();
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
  const end = async (g: Guest) => {
    if (!confirm(`End ${g.name}’s access now?`)) return;
    const ours = links[g.id]?.created;
    if (ours) await cancel(ours);
    else
      await request(peer, `/api/clients/${g.id}`, { method: "DELETE" }).catch(
        () => {},
      );
    if (made?.clientId === g.id) setMade(null);
    void loadGuests();
  };

  return (
    <div className="ivt">
      <div
        className="ivt-segment ivt-kind"
        role="radiogroup"
        aria-label="Invite"
      >
        {(["person", "agent"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => {
              setKind(k);
              setError("");
              // An agent joins one computer.
              if (k === "agent") setComputers([agentPeer.id]);
            }}
          >
            {k === "person" ? "Person" : "Agent"}
          </button>
        ))}
      </div>
      {openPolicy && (
        <p className="ivt-warn" role="status">
          Invite links are ready. Your Tailscale policy lets every device reach
          everything, so invited people and agents could reach more than Reach.
          To limit them, change that rule’s “*” to “autogroup:member” (your
          other tagged devices and people you shared devices with would then
          need their own rules).
        </p>
      )}
      {keyed === false && (
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
                    invites: parseGuestLink(new URL(pending.link).hash).invites,
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
      <div className="ivt-add">
        <input
          className="ivt-name"
          aria-label="Name"
          placeholder={agent ? "Name the agent" : "Who are you inviting?"}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && void (agent ? inviteAgent() : invite())
          }
        />
        {agent ? (
          <Menu
            label={AGENT_ROLES.find((r) => r.value === agentRole)!.label}
            wide
            className="ivt-role"
          >
            {(close) =>
              AGENT_ROLES.map((r) => (
                <Item
                  key={r.value}
                  on={r.value === agentRole}
                  label={r.label}
                  description={r.description}
                  onClick={() => {
                    setAgentRole(r.value);
                    close();
                  }}
                />
              ))
            }
          </Menu>
        ) : (
          <Menu label={current.label} wide className="ivt-role">
            {(close) =>
              roles.map((r) => (
                <Item
                  key={r.value}
                  on={r.value === current.value}
                  label={r.label}
                  description={r.description}
                  onClick={() => {
                    setRole(r.value);
                    close();
                  }}
                />
              ))
            }
          </Menu>
        )}
        <button
          className="ivt-primary"
          disabled={!!(agent ? agentMissing : missing) || busy}
          onClick={() => void (agent ? inviteAgent() : invite())}
        >
          {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
      <div className="ivt-meta">
        {peers.length > 1 && (
          <>
            <span>On</span>
            <Menu
              label={
                agent
                  ? agentPeer.name
                  : chosen.length
                    ? list(chosen.map((p) => p.name))
                    : "No computer"
              }
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
          </>
        )}
        <span>For</span>
        {agent ? (
          <Menu label={agentDuration}>
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
        ) : (
          <Menu label={duration}>
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
        )}
      </div>

      {made && madeLink && made.joinBy && (
        <section
          className="ivt-link"
          aria-live="polite"
          ref={linkCard}
          aria-label="Agent invitation"
        >
          <div className="ivt-link-head">
            <Bot size={16} />
            <strong>{made.guest} is invited</strong>
            <button
              className="ivt-icon"
              aria-label="Close"
              onClick={() => setMade(null)}
            >
              <X size={16} />
            </button>
          </div>
          <small className="ivt-quiet">
            Give this to your agent. It joins once, within 15 minutes.
          </small>
          {(() => {
            const command = agentCommand(
              new URL(madeLink.link).origin,
              madeLink.link,
            );
            const text = `Join my computer with Reach, then add the MCP server it prints:\n${command}`;
            return (
              <div className="ivt-link-row">
                <input
                  className="ivt-link-field"
                  aria-label="Command for the agent"
                  readOnly
                  value={command}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="ivt-primary small"
                  onClick={() => void copy(text, "Copied")}
                >
                  <Copy size={15} /> Copy
                </button>
                <button
                  className="ivt-icon"
                  aria-label="Share"
                  onClick={() => void send(text)}
                >
                  <Share2 size={16} />
                </button>
              </div>
            );
          })()}
          <small className="ivt-quiet">
            {note ||
              `Needs Node 18 or later${madeLink.keyed ? ", nothing else" : ""}. ${made.summary}`}
          </small>
          {!madeLink.keyed && (
            <div className="ivt-tailscale">
              <p>
                Without invite links, its machine needs Tailscale on your
                tailnet.
              </p>
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
            </div>
          )}
        </section>
      )}
      {made && madeLink && !made.joinBy && (
        <section className="ivt-link" aria-live="polite" ref={linkCard}>
          <div className="ivt-link-head">
            <Link2 size={16} />
            <strong>{made.guest}’s invite link</strong>
            <button
              className="ivt-icon"
              aria-label="Close"
              onClick={() => setMade(null)}
            >
              <X size={16} />
            </button>
          </div>
          {!madeLink.keyed && !onTailnet && (
            <div className="ivt-tailscale">
              <p>{made.guest} would need Tailscale for this link.</p>
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
              <details className="ivt-fallback">
                <summary>They already use Tailscale</summary>
                <p>
                  Share this computer with them in Tailscale, then paste that
                  share link here.
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
              <div className="ivt-link-row">
                <input
                  className="ivt-link-field"
                  readOnly
                  value={madeLink.link}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="ivt-primary small"
                  onClick={() => void copy(message(made, madeLink))}
                >
                  <Copy size={15} /> Copy
                </button>
                <button
                  className="ivt-icon"
                  aria-label="Share"
                  onClick={() => void send(message(made, madeLink))}
                >
                  <Share2 size={16} />
                </button>
              </div>
              <small className="ivt-quiet">
                {note ||
                  `Anyone with this link joins as ${made.guest} until ${new Date(made.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.${madeLink.keyed ? " Nothing to install." : ""}`}
              </small>
            </>
          )}
        </section>
      )}

      {!agent && current.value === "custom" && (
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

      {(agent || usesFiles) && (
        <div className="ivt-panel" aria-label="Folders">
          {!agent && chosen.length > 1 && (
            <div className="ivt-segment" role="tablist" aria-label="Computer">
              {chosen.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={
                    (chosen.find((x) => x.id === browsing) || chosen[0]).id ===
                    p.id
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
      )}

      <p
        className={`ivt-summary ${(agent ? agentMissing : missing) ? "muted" : ""}`}
      >
        {agent ? agentSummary : summary}
      </p>
      {error && <p className="ivt-error">{error}</p>}

      <section className="ivt-people" aria-label="People with access">
        <h3>People with access</h3>
        <div className="ivt-person owner">
          <span className="ivt-avatar">You</span>
          <span className="ivt-who">
            <strong>You</strong>
            <small>{list(peers.map((p) => p.name))}</small>
          </span>
          <span className="ivt-role-text">Owner</span>
        </div>
        {guests.map((g) => (
          <div className="ivt-person" key={g.id}>
            <span className="ivt-avatar" aria-hidden>
              {g.kind === "agent" ? (
                <Bot size={15} />
              ) : (
                g.name.slice(0, 1).toUpperCase()
              )}
            </span>
            <span className="ivt-who">
              <strong>{g.name}</strong>
              <small>{accessLabel(g.scopes)}</small>
              <small>
                {g.kind === "agent" && g.status === "expired"
                  ? "Didn’t join in time"
                  : `${g.status === "accepted" ? "Joined" : g.kind === "agent" ? "Not joined yet" : "Not opened yet"} · ${left(g.expiresAt || 0, now)}`}
              </small>
            </span>
            {links[g.id] && (
              <button
                className="ivt-icon"
                aria-label={`Copy ${g.name}’s link`}
                onClick={() => void copy(links[g.id].link)}
              >
                <Copy size={15} />
              </button>
            )}
            <button
              className="ivt-icon"
              aria-label={`End ${g.name}’s access`}
              onClick={() => void end(g)}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
