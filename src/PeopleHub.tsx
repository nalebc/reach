import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  Copy,
  History,
  Laptop,
  Link2,
  Plus,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  UserRound,
  Zap,
} from "lucide-react";
import { usePageVisible } from "./page-visible";
import type { ConnectedDevice } from "./useFleetConnections";
import { post, request, type Device, type Peer } from "./api";
import { requestDeadline } from "./request-deadline";
import { workspaceCapabilities } from "./capabilities";
import { groupDevices } from "./device-groups";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import ScreenPopup from "./ScreenPopup";
import BrowserAgents, { activeSession, type BrowserAgentSession } from "./BrowserAgents";
import AgentShortcuts from "./AgentShortcuts";
import { ServiceAccessPanel } from "./service-access";
import ToolBrowserSetup from "./ToolBrowserSetup";
import AgentFaceIdSetting from "./AgentFaceId";
import { ErrorLine } from "./ui";
import AccessEditor, { accessSummary, appScopedAccess, canEditAccess } from "./AccessEditor";
import {
  AGENT_LEVELS,
  InviteSheet,
  Item,
  LEVELS,
  LEVEL_BODY,
  Menu,
  accessLabel,
  hasFolders,
  left,
  levelOf,
  type Created,
  type Guest,
  type Level,
  type MadeLink,
} from "./InviteSheet";
import { guestLinkUrl } from "./start-flow";
import "./settings-list.css";
import "./invite-sheet.css";
import "./people-hub.css";

// Who can use this computer, as one short ChatGPT-style list: agents first,
// then people, then your own devices. "+" invites; a row opens what that one
// may do, when it ends, its link and Remove; an agent's sheet also holds what
// it's doing, its requests, Pause and its activity. Ended agents, saved
// shortcuts and shared services are a row each, only when there are any. Every change is checked by the
// computer as an invitation is (POST /api/guests/:id/access).

type Client = Guest & {
  createdAt?: string;
  deviceGroup?: string;
  tailscale?: { userId: string; nodeId: string };
};
type Start = "person" | "browser";
// What POST /api/guests/:id/link answers: a fresh secret for an
// invitation not used yet (the old link stops working).
type Renewed = {
  invitation: string;
  expiresAt: number;
  joinBy?: number;
  url?: string;
  runtime?: string;
};
const startOf = (p: Peer) => `https://${new URL(p.url).hostname}`;
// Which form a browser agent's public link took (a command for its tools, or
// a page), by its invitation id: no secret, just how to make it again.
const FORMS = "reach.invite-forms";
const forms = (): Record<string, "tools" | "page"> => {
  try {
    return JSON.parse(localStorage.getItem(FORMS) || "{}") || {};
  } catch {
    return {};
  }
};
const rememberForm = (id: string, link: string) => {
  try {
    const path = new URL(link).pathname;
    if (path !== "/agent" && path !== "/agent-browser") return;
    const all = { ...forms(), [id]: path === "/agent" ? "tools" : "page" };
    localStorage.setItem(FORMS, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-100))));
  } catch {}
};
// Not opened or joined yet (or its join window or request has lapsed): a
// new link is all they need.
const unjoined = (g: Guest, now: number) =>
  (g.expiresAt || 0) > now && ["invited", "expired", "denied"].includes(g.status || "");

const isBrowserGrant = (g: Guest) =>
  !!g.policy?.browser || !!g.scopes?.includes("browser:read");
// Invited people and invited command-line agents change level from a menu
// (on every computer the invitation covers); other agents in their editor.
const byLevel = (g: Guest) =>
  g.kind === "guest" || (g.kind === "agent" && !!g.policy?.invite && !isBrowserGrant(g));
// What their access is called, in a word or two.
const levelName = (g: Guest) =>
  byLevel(g)
    ? (g.kind === "agent" ? AGENT_LEVELS : LEVELS).find(
        (l) => l.value === levelOf(g),
      )?.label || accessLabel(g.scopes)
    : isBrowserGrant(g)
      ? "Browser agent"
      : accessSummary(g);
// How long their access lasts, in words: Always has no end date.
const lasts = (g: Guest, now: number) =>
  g.policy?.standing ? "Always" : left(g.expiresAt || 0, now);
// One muted line under a name: what needs you first, then what they can do
// and for how long.
// A command-line agent's runtime against this computer's (server/agent-runtimes.mjs).
type Runtimed = Guest & { runtime?: "current" | "updating" | "one-time"; runtimeSha256?: string; browserBinding?: string };
// The one command an agent on an older runtime needs, on its own machine:
// from then on it updates by itself. Over the public link, with its key. It
// fetches exactly the runtime this computer names, by its SHA-256, and checks
// it before it replaces anything (connections audit, Oct 10); with no hash
// from the computer, there's no command.
export const runtimeUpdateCommand = (g: Runtimed, peer: Peer) => {
  const sha = typeof g.runtimeSha256 === "string" && /^[0-9a-f]{64}$/.test(g.runtimeSha256) ? g.runtimeSha256 : "";
  if (!sha) return "";
  const key = g.browserTransport === "funnel" && typeof g.browserBinding === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(g.browserBinding)
    ? ` -H 'Reach-Key: ${g.browserBinding}'` : "";
  return `curl -fsSL${key} -o ~/.reach-agent/agent.mjs.new https://${new URL(peer.url).hostname}/agent-runtimes/${sha}.mjs && node -e 'const [f,h]=process.argv.slice(1);if(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex")!==h)throw Error("This is not the runtime the computer named.")' ~/.reach-agent/agent.mjs.new ${sha} && mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs`;
};
// A browser agent's live state, from the Mac's list of agent sessions.
type Live = Pick<BrowserAgentSession, "status" | "pendingApprovals" | "paused" | "holdsMac" | "using" | "activity">;
function sessionWords(s: Live): { text: string; tone?: "attention" } | null {
  if (s.status === "pending") return { text: "Waiting for your approval", tone: "attention" };
  if (s.pendingApprovals)
    return { text: `${s.pendingApprovals} ${s.pendingApprovals === 1 ? "request" : "requests"} waiting`, tone: "attention" };
  if (s.paused) return { text: "Paused" };
  if (s.holdsMac) return { text: `Using ${s.using?.app || "the Mac"}` };
  if (s.activity?.state === "running") return { text: "Working" };
  return null;
}
function statusOf(g: Guest, now: number, live?: Live): { text: string; tone?: "attention" | "off" } {
  const words = live && sessionWords(live);
  if (words) return words;
  const runtime = (g as Runtimed).runtime;
  if (g.kind === "agent" && (!g.status || g.status === "accepted") && runtime === "one-time")
    return { text: "Needs a one-time update", tone: "attention" };
  if (g.kind === "agent" && (!g.status || g.status === "accepted") && runtime === "updating")
    return { text: `${levelName(g)} · Updating` };
  if (g.kind === "agent") {
    if (g.status === "pending") return { text: "Waiting for your approval", tone: "attention" };
    if (g.status === "approved") return { text: "Approved · connecting" };
    if (g.status === "denied") return { text: "Denied", tone: "off" };
    if (g.status === "expired") return { text: "Request expired", tone: "off" };
  }
  // Came in while an agent had the Mac: Let in on Home's Needs you.
  if (g.kind === "guest" && g.status === "waiting") return { text: "Waiting for you to let them in", tone: "attention" };
  if (g.status && g.status !== "accepted")
    return { text: `${g.kind === "agent" ? "Not joined yet" : "Not opened yet"} · ${lasts(g, now)}` };
  return { text: `${levelName(g)} · ${lasts(g, now)}` };
}
// Who's on the computer right now, in a word.
const doing: Record<ConnectedDevice["activity"], string> = {
  connected: "Connected",
  viewing: "Watching the screen",
  controlling: "Controlling the screen",
  terminal: "In a terminal",
};
const initial = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?";
const isPhone = (name: string) => /iphone|android|phone|pixel|galaxy/i.test(name);

function Avatar({ client, large = false }: { client: Client; large?: boolean }) {
  const size = large ? 26 : 18;
  return (
    <span className={`ppl-avatar ${client.kind || "device"}${large ? " large" : ""}`} aria-hidden="true">
      {client.kind === "agent" ? (
        <Sparkles size={size} />
      ) : client.kind === "guest" ? (
        initial(client.name)
      ) : isPhone(client.name) ? (
        <Smartphone size={size} />
      ) : (
        <Laptop size={size} />
      )}
    </span>
  );
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="gs-title">{title}</h2>
      <div className="gs-group">{children}</div>
    </>
  );
}

export default function PeopleHub({
  peer,
  device,
  peers = [peer],
  start = null,
  here = [],
  toast = () => {},
}: {
  peer: Peer;
  device: Device;
  peers?: Peer[];
  // Open the invitation at once (from Home's invite button); a new `at`
  // opens it again.
  start?: { kind: Start; at: number } | null;
  // Everyone else on this computer now (its live connection), and what
  // they're doing.
  here?: ConnectedDevice[];
  toast?: (message: string) => void;
}) {
  const [clients, setClients] = useState<Client[]>([]);
  const [current, setCurrent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadErrors, setLoadErrors] = useState({ clients: "", sessions: "" });
  const activeLoad = useRef<AbortController | null>(null);
  const ending = useRef(false);
  const [now, setNow] = useState(Date.now);
  const [inviting, setInviting] = useState<Start | null>(start?.kind || null);
  // Browser agents as the Mac lists them: live state, and the ended ones.
  const [sessions, setSessions] = useState<BrowserAgentSession[]>([]);
  // Saved shortcuts and shared services, counted; a sheet for each.
  const [extras, setExtras] = useState({ shortcuts: 0, services: 0 });
  const [extrasAt, setExtrasAt] = useState(0);
  const [panel, setPanel] = useState<"" | "ended" | "shortcuts" | "services">("");
  const [openId, setOpenId] = useState("");
  const [editing, setEditing] = useState<Guest | null>(null);
  // Links made here, by invitation (a computer never keeps them).
  const [links, setLinks] = useState<Record<string, MadeLink>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState("");
  // Changing someone's access: the folders to choose first, where they have
  // none to keep (on each computer their invitation covers).
  const [picking, setPicking] = useState<{
    guest: Guest;
    level: Level;
    all: { peer: Peer; guest: Guest }[];
    need: string[];
  } | null>(null);
  const [picked, setPicked] = useState<Record<string, PickedFolder[]>>({});
  const [devices, setDevices] = useState<Record<string, Device>>({ [peer.id]: device });

  useEffect(() => {
    if (start) setInviting(start.kind);
  }, [start?.at]);
  const load = async (force = false) => {
    // Polls never overlap. A change to access supersedes an older snapshot.
    if (activeLoad.current && !force) return;
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    const deadline = requestDeadline(controller.signal);
    const [access, live] = await Promise.allSettled([
      request<{ clients: Client[]; current?: string }>(peer, "/api/clients", { signal: deadline.signal }),
      request<{ agents: BrowserAgentSession[] }>(peer, "/api/browser/agents", { signal: deadline.signal }),
    ]);
    deadline.dispose();
    if (controller.signal.aborted || activeLoad.current !== controller) return;
    activeLoad.current = null;
    const errors = { clients: "", sessions: "" };
    if (access.status === "fulfilled" && Array.isArray(access.value?.clients)) {
      setClients(access.value.clients);
      setCurrent(access.value.current || "");
    } else errors.clients = access.status === "rejected" ? access.reason.message : "The access list could not be loaded.";
    if (live.status === "fulfilled" && Array.isArray(live.value?.agents)) setSessions(live.value.agents);
    else errors.sessions = live.status === "rejected" ? live.reason.message : "Agent sessions could not be loaded.";
    setLoadErrors(errors);
    setNow(Date.now());
    setLoaded(true);
  };
  const visible = usePageVisible();
  useEffect(() => {
    // In the background, nothing is asked; back on screen, at once.
    if (!visible) return;
    void load();
    const refresh = setInterval(() => void load(), 5000);
    return () => {
      clearInterval(refresh);
      activeLoad.current?.abort();
      activeLoad.current = null;
    };
  }, [peer.url, peer.token, visible]);
  // Counted on arrival, back on screen and when a sheet closes; their own
  // sheets keep them current while open.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void Promise.allSettled([
      request<{ shortcuts: unknown[] }>(peer, "/api/agents/shortcuts", { signal: controller.signal }),
      request<{ access: { status: string; expiresAt: number }[] }>(peer, "/api/agents/services", { signal: controller.signal }),
    ]).then(([shortcuts, services]) => {
      if (controller.signal.aborted) return;
      setExtras({
        shortcuts: shortcuts.status === "fulfilled" && Array.isArray(shortcuts.value?.shortcuts) ? shortcuts.value.shortcuts.length : 0,
        services:
          services.status === "fulfilled" && Array.isArray(services.value?.access)
            ? services.value.access.filter((e) => e.expiresAt > Date.now() && ["pending", "approved"].includes(e.status)).length
            : 0,
      });
    });
    return () => controller.abort();
  }, [peer.url, peer.token, visible, extrasAt]);
  useEffect(() => {
    for (const p of peers)
      if (picking?.need.includes(p.id) && !devices[p.id])
        request<Device>(p, "/api/device")
          .then((d) => setDevices((old) => ({ ...old, [p.id]: d })))
          .catch(() => {});
  }, [picking?.need.join(",")]);

  const session = (c: Client) => sessions.find((s) => s.id === c.id);
  // Live: not past its end, and not stopped (or idle-ended, as the Mac says).
  const live = (c: Client) => {
    const s = session(c);
    return s ? activeSession(s, now) : (c.expiresAt || 0) > now && c.status !== "revoked";
  };
  const asks = (c: Client) => statusOf(c, now, session(c)).tone === "attention";
  // What needs you first.
  const agents = clients
    .filter((c) => c.kind === "agent" && live(c))
    .sort((a, b) => Number(asks(b)) - Number(asks(a)));
  const people = clients.filter((c) => c.kind === "guest" && live(c));
  const own = groupDevices(clients.filter((c) => c.kind !== "guest" && c.kind !== "agent"));
  const ended = sessions.filter((s) => !activeSession(s, now)).length;
  const opened = [...agents, ...people].find((c) => c.id === openId);
  const openedDevice = own.find((c) => c.id === openId);

  // Their invitation on this computer, and on your other computers it covers.
  const sameInvitation = async (g: Guest, unavailable?: string[]) => {
    const all = [{ peer, guest: g }];
    if (g.group)
      for (const p of peers) {
        if (p.id === peer.id) continue;
        try {
          const r = await request<{ clients: Guest[] }>(p, "/api/clients");
          if (!Array.isArray(r?.clients)) throw Error("The access list could not be loaded.");
          const twin = r.clients.find(
            (c) => c.group === g.group && (c.expiresAt || 0) > Date.now() && c.status !== "revoked",
          );
          if (twin) all.push({ peer: p, guest: twin });
        } catch (failure) {
          const message = `${p.name}: ${(failure as Error).message}`;
          if (unavailable) unavailable.push(message);
          else throw Error(message);
        }
      }
    return all;
  };
  // Computer by computer: one that says no is named (the ones before it
  // stay changed).
  const applyLevel = async (
    g: Guest,
    level: Level,
    all: { peer: Peer; guest: Guest }[],
    folders: Record<string, PickedFolder[]> = {},
  ) => {
    for (const x of all)
      try {
        await post(x.peer, `/api/guests/${x.guest.id}/access`, {
          ...LEVEL_BODY[level],
          ...(folders[x.peer.id]
            ? {
                folders: folders[x.peer.id].map(({ root, path }) => ({
                  root,
                  path,
                })),
              }
            : {}),
        });
      } catch (e) {
        throw Error(
          all.length > 1
            ? `${x.peer.name}: ${(e as Error).message}`
            : (e as Error).message,
        );
      }
    const label = (g.kind === "agent" ? AGENT_LEVELS : LEVELS).find(
      (l) => l.value === level,
    )!.label;
    setChanged(`${g.name}: ${label.toLowerCase()} now. No new link needed.`);
  };
  const changeLevel = async (g: Guest, level: Level) => {
    if (busy || !byLevel(g)) return;
    setBusy(true);
    setError("");
    setChanged("");
    try {
      const all = await sameInvitation(g);
      const levels = g.kind === "agent" ? AGENT_LEVELS : LEVELS;
      const need = levels.find((l) => l.value === level)?.folders
        ? all.filter((x) => !hasFolders(x.guest)).map((x) => x.peer.id)
        : [];
      if (need.length) {
        setPicked({});
        setPicking({ guest: g, level, all, need });
        return;
      }
      await applyLevel(g, level, all);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void load(true);
    }
  };
  const savePicked = async () => {
    if (!picking || busy) return;
    setBusy(true);
    setError("");
    try {
      await applyLevel(picking.guest, picking.level, picking.all, picked);
      setPicking(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void load(true);
    }
  };
  const end = async (g: Guest) => {
    if (busy || ending.current || !confirm(`End ${g.name}’s access now?`)) return;
    ending.current = true;
    setBusy(true);
    setError("");
    setChanged("");
    const failures: string[] = [];
    try {
      const targets = links[g.id]?.created || (await sameInvitation(g, failures)).map((x) => ({ peer: x.peer, clientId: x.guest.id }));
      // Revoke every reachable copy even if another computer is unavailable.
      for (const target of targets) {
        try {
          await request(target.peer, `/api/clients/${encodeURIComponent(target.clientId)}`, { method: "DELETE" });
        } catch (failure) {
          failures.push(`${target.peer.name}: ${(failure as Error).message}`);
        }
      }
      if (failures.length) setError(`Access may still be active on ${failures.join("; ")}`);
      else setOpenId("");
    } finally {
      ending.current = false;
      setBusy(false);
      void load(true);
    }
  };
  // One of your devices: every browser on it.
  const revoke = async (c: (typeof own)[number]) => {
    if (!confirm(`Remove ${c.name}’s access?`)) return;
    try {
      for (const id of c.ids)
        await request(peer, `/api/clients/${id}`, { method: "DELETE" });
      setOpenId("");
      void load(true);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  // The computer that makes invite keys (one-time Tailscale keys), if any.
  const findKeyPeer = async () => {
    for (const p of [peer, ...peers.filter((x) => x.id !== peer.id)])
      try {
        if ((await request<{ configured: boolean }>(p, "/api/guests/keys")).configured) return p;
      } catch {}
    return null;
  };
  // A new link for someone who hasn't used theirs, made as the first one was.
  const renew = async (g: Guest) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const renewOn = (p: Peer, id: string) => post<Renewed>(p, `/api/guests/${id}/link`, {});
      const secs = (until: number) => Math.max(60, Math.round((until - Date.now()) / 1000));
      const keyPeer = await findKeyPeer();
      let made: MadeLink;
      if (g.kind === "guest") {
        // Every computer the invitation covers gets its new secret together.
        const created: Created[] = [];
        for (const x of await sameInvitation(g)) {
          const r = await renewOn(x.peer, x.guest.id);
          created.push({ peer: x.peer, clientId: x.guest.id, invitation: r.invitation });
        }
        const key = keyPeer
          ? await post<{ key: string; hostname: string }>(keyPeer, "/api/guests/key", {
              ttlSeconds: secs(g.expiresAt || 0),
              clientIds: created.filter((c) => c.peer.id === keyPeer.id).map((c) => c.clientId),
            })
          : null;
        made = {
          link: guestLinkUrl(startOf(peer), {
            key: key?.key || "",
            hostname: key?.hostname || "",
            invites: created.map((c) => ({ origin: new URL(c.peer.url).origin, secret: c.invitation })),
          }),
          keyed: !!key,
          created,
        };
      } else {
        const r = await renewOn(peer, g.id);
        const created: Created[] = [{ peer, clientId: g.id, invitation: r.invitation }];
        if (r.url && new URL(r.url).pathname === "/mcp")
          // A hosted agent: its connector address, the same as before.
          made = { link: r.url, keyed: true, created };
        else if (g.browserTransport === "funnel" && r.url) {
          // Through the public link: its page, or the command its tools join with.
          const origin = new URL(r.url).origin;
          made = {
            link:
              forms()[g.id] === "tools"
                ? guestLinkUrl(origin, {
                    key: "",
                    hostname: "",
                    invites: [{ origin: new URL(peer.url).origin, secret: r.invitation }],
                    funnel: true,
                  }, "/agent")
                : r.url,
            keyed: true,
            created,
            runtime: r.runtime,
          };
        } else {
          // Over Tailscale: a one-time key for its computer, lasting until it joins.
          const key = keyPeer
            ? await post<{ key: string; hostname: string }>(peer, "/api/guests/key", {
                ...(g.policy?.standing ? {} : { ttlSeconds: secs(g.expiresAt || 0) }),
                keySeconds: secs(r.joinBy || g.expiresAt || 0),
                clientIds: [g.id],
              }).catch((e) => {
                if (keyPeer.id === peer.id) throw e;
                return null;
              })
            : null;
          made = {
            link: guestLinkUrl(startOf(peer), {
              key: key?.key || "",
              hostname: key?.hostname || "",
              invites: [{ origin: new URL(peer.url).origin, secret: r.invitation }],
            }, "/agent"),
            keyed: !!key,
            created,
            runtime: r.runtime,
          };
        }
      }
      setLinks((old) => ({ ...old, [g.id]: made }));
      setChanged("New link ready. The old one no longer works.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void load(true);
    }
  };
  const copy = async (text: string, what = "link") => {
    try {
      await navigator.clipboard.writeText(text);
      toast(what === "link" ? "Link copied" : "Command copied");
    } catch {
      toast(`Couldn’t copy the ${what}.`);
    }
  };
  const open = (id: string) => {
    setOpenId(id);
    setChanged("");
    setError("");
  };
  const row = (c: Client, self = false) => {
    // Your devices often share a name ("My iPhone"): when each was paired
    // tells them apart, with the time when two were paired the same day.
    const day = (d: Client) => (d.createdAt ? new Date(d.createdAt).toDateString() : "");
    const twin = own.some((d) => d.id !== c.id && d.name === c.name && day(d) === day(c));
    const paired = c.createdAt
      ? `Paired ${new Date(c.createdAt).toLocaleString([], { month: "short", day: "numeric", ...(twin ? { hour: "numeric", minute: "2-digit" } : {}) })}`
      : "Paired";
    const status = c.kind === "guest" || c.kind === "agent" ? statusOf(c, now, session(c)) : { text: self ? "This device" : paired };
    return (
      <button key={c.id} className="gs-row ppl-row" aria-label={`${c.name}, ${status.text}`} onClick={() => open(c.id)}>
        <Avatar client={c} />
        <span className="gs-label">
          <strong>{c.name}</strong>
          <small className={status.tone ? `ppl-${status.tone}` : undefined}>{status.text}</small>
        </span>
        <ChevronRight className="gs-chevron" size={18} />
      </button>
    );
  };

  function extraRow(id: typeof panel, icon: ReactNode, label: string, count: number) {
    return (
      <button className="gs-row" onClick={() => setPanel(id)}>
        <span className="ppl-avatar plain" aria-hidden="true">
          {icon}
        </span>
        <span className="gs-label">{label}</span>
        <span className="gs-value">{count}</span>
        <ChevronRight className="gs-chevron" size={18} />
      </button>
    );
  }
  function invitationSheet() {
    const who = inviting || "browser";
    const title = who === "person" ? "Invite someone" : "Invite an agent";
    return (
      <ScreenPopup
        title={title}
        className="ppl-invite"
        onClose={() => setInviting(null)}
        // Who is in the title, as ChatGPT's model picker: the way in
        // already chose, and the other one is a tap away.
        heading={
          <Menu label={title} wide className="ppl-who">
            {(close) => (
              <>
                <Item
                  icon={<Sparkles size={19} />}
                  on={who === "browser"}
                  label="An agent"
                  description="Claude, Codex or any AI."
                  onClick={() => {
                    close();
                    setInviting("browser");
                  }}
                />
                <Item
                  icon={<UserRound size={19} />}
                  on={who === "person"}
                  label="A person"
                  description="Someone you trust, on their phone or computer."
                  onClick={() => {
                    close();
                    setInviting("person");
                  }}
                />
              </>
            )}
          </Menu>
        }
      >
        <InviteSheet
          key={who}
          peer={peer}
          device={device}
          peers={peers}
          initialKind={who}
          onCreated={(id, made) => {
            rememberForm(id, made.link);
            setLinks((old) => ({ ...old, [id]: made }));
            void load(true);
          }}
        />
      </ScreenPopup>
    );
  }

  return (
    <div className="settings-workspace gs ppl">
      <header className="ppl-head">
        <div>
          <h1>Agents &amp; people</h1>
          <p>Who can use {device.name}</p>
        </div>
        <button className="ppl-add" aria-label="Invite" onClick={() => setInviting("browser")}>
          <Plus size={22} />
        </button>
      </header>

      <ErrorLine error={[...new Set(Object.values(loadErrors))].filter(Boolean).join(" ")} />
      {!opened && <ErrorLine error={error} />}

      {here.length > 0 && (
        <Group title="Here now">
          {here.map((d) => {
            const agent = !!d.access?.some((a) => a.kind === "agent");
            const guest = !!d.access?.some((a) => a.kind === "invited");
            return (
              <div key={d.id} className={`gs-row ppl-here${d.activity === "controlling" ? " controlling" : ""}`}>
                <span className={`ppl-avatar ${agent ? "agent" : guest ? "guest" : "device"}`} aria-hidden="true">
                  {agent ? <Sparkles size={18} /> : guest ? initial(d.name) : d.kind === "phone" ? <Smartphone size={18} /> : <Laptop size={18} />}
                  <i className="ppl-live" />
                </span>
                <span className="gs-label">
                  <strong>{d.name}</strong>
                  <small>
                    {doing[d.activity]}
                    {agent ? " · Agent" : guest ? " · Guest" : ""}
                  </small>
                </span>
              </div>
            );
          })}
        </Group>
      )}

      {/* One way to invite on this screen: the + above. Empty lists say
          so in a line, without another button. */}
      <Group title="Agents">
        {agents.map((c) => row(c))}
        {loaded && !loadErrors.clients && !agents.length && <div className="gs-row gs-note ppl-empty">No agents yet</div>}
        {extras.shortcuts > 0 && extraRow("shortcuts", <Zap size={19} />, "Shortcuts", extras.shortcuts)}
        {extras.services > 0 && extraRow("services", <ShieldCheck size={19} />, "Services", extras.services)}
        {ended > 0 && extraRow("ended", <History size={19} />, "Ended", ended)}
      </Group>
      <AgentFaceIdSetting peer={peer} />
      <ToolBrowserSetup peer={peer} toast={toast} />

      {people.length > 0 && <Group title="People">{people.map((c) => row(c))}</Group>}

      {(own.length > 0 || !loaded) && (
        <Group title="Your devices">
          {own.map((c) => row(c, c.ids.includes(current)))}
          {!loaded && <div className="gs-row gs-note">…</div>}
        </Group>
      )}

      {opened && (
        <ScreenPopup title={opened.name} className="gs-sheet ppl-sheet" onClose={() => setOpenId("")}>
          <div className="ppl-hero">
            <Avatar client={opened} large />
            <small className={statusOf(opened, now, session(opened)).tone ? `ppl-${statusOf(opened, now, session(opened)).tone}` : undefined}>
              {opened.kind === "agent" ? "Agent" : "Guest"} · {statusOf(opened, now, session(opened)).text}
            </small>
          </div>
          {changed && (
            <p className="ppl-note" role="status">
              {changed}
            </p>
          )}
          {error && (
            <p className="ivt-error ppl-error" role="alert">
              {error}
            </p>
          )}
          <div className="gs-group">
            {/* Their access: changed here, no new link. */}
            {!byLevel(opened) ? (
              canEditAccess(opened) ? (
                <button className="gs-row" onClick={() => setEditing(opened)}>
                  <span className="gs-label">{appScopedAccess(opened) ? "Manage app requests" : "Edit access"}</span>
                  <ChevronRight className="gs-chevron" size={18} />
                </button>
              ) : (
                <div className="gs-row">
                  <span className="gs-label">Access</span>
                  <span className="gs-value">{levelName(opened)}</span>
                </div>
              )
            ) : (
              <div className="gs-row ppl-access-row">
                <span className="gs-label">Access</span>
                <Menu label={levelName(opened)} wide className="ivt-access">
                  {(close) =>
                    (opened.kind === "agent" ? AGENT_LEVELS : LEVELS)
                      .filter((l) => !l.screen || workspaceCapabilities(device).screen)
                      .map((l) => (
                        <Item
                          key={l.value}
                          on={levelOf(opened) === l.value}
                          label={l.label}
                          description={l.description}
                          onClick={() => {
                            close();
                            if (levelOf(opened) !== l.value) void changeLevel(opened, l.value);
                          }}
                        />
                      ))
                  }
                </Menu>
              </div>
            )}
            <div className="gs-row">
              <span className="gs-label">Ends</span>
              <span className="gs-value">
                {opened.policy?.standing ? "After a week unused" : left(opened.expiresAt || 0, now)}
              </span>
            </div>
            {(opened as Runtimed).runtime === "one-time" && runtimeUpdateCommand(opened, peer) && (
              // An older runtime has no updater: this once, on its machine.
              <button
                className="gs-row gs-wrap"
                aria-label={`Copy the update command for ${opened.name}`}
                onClick={() => void copy(runtimeUpdateCommand(opened, peer), "command")}
              >
                <Copy size={20} />
                <span className="gs-label">
                  Copy update command
                  <small>Run it once on the agent’s machine</small>
                </span>
              </button>
            )}
          </div>
          {session(opened) && <BrowserAgents peer={peer} device={device} toast={toast} focus={opened.id} />}
          <div className="gs-group gs-end">
            {links[opened.id] ? (
              <button className="gs-row" aria-label={`Copy ${opened.name}’s link`} onClick={() => void copy(links[opened.id].link)}>
                <Copy size={20} />
                <span className="gs-label">Copy invite link</span>
              </button>
            ) : (
              unjoined(opened, now) && (
                // A computer never keeps a link: once the page that made it
                // closes, a new one replaces it.
                <button
                  className="gs-row"
                  aria-label={`New invite link for ${opened.name}`}
                  disabled={busy}
                  onClick={() => void renew(opened)}
                >
                  <Link2 size={20} />
                  <span className="gs-label">
                    New invite link
                    <small>The old link stops working</small>
                  </span>
                </button>
              )
            )}
            <button className="gs-row gs-danger" aria-label={`End ${opened.name}’s access`} disabled={busy} onClick={() => void end(opened)}>
              <Trash2 size={20} />
              <span className="gs-label">Remove access</span>
            </button>
          </div>
        </ScreenPopup>
      )}

      {openedDevice && (
        <ScreenPopup title={openedDevice.name} className="gs-sheet ppl-sheet" onClose={() => setOpenId("")}>
          <div className="ppl-hero">
            <Avatar client={openedDevice} large />
            <small>{openedDevice.ids.includes(current) ? "This device" : "Paired"}</small>
          </div>
          <div className="gs-group">
            {openedDevice.createdAt && (
              <div className="gs-row">
                <span className="gs-label">Added</span>
                <span className="gs-value">{new Date(openedDevice.createdAt).toLocaleDateString()}</span>
              </div>
            )}
            {!!openedDevice.expiresAt && (
              <div className="gs-row">
                <span className="gs-label">{openedDevice.expiresAt <= now ? "Expired" : "Sign-in expires"}</span>
                <span className="gs-value">{new Date(openedDevice.expiresAt).toLocaleString()}</span>
              </div>
            )}
          </div>
          {/* This phone itself: Settings → Forget this computer. */}
          {!openedDevice.ids.includes(current) && (
            <div className="gs-group gs-end">
              <button className="gs-row gs-danger" aria-label={`Revoke ${openedDevice.name}`} onClick={() => void revoke(openedDevice)}>
                <Trash2 size={20} />
                <span className="gs-label">Remove access</span>
              </button>
            </div>
          )}
        </ScreenPopup>
      )}

      {picking && (
        <ScreenPopup title={`Folders for ${picking.guest.name}`} className="ppl-folders" onClose={() => setPicking(null)}>
          <div className="ivt">
            <div className="ivt-panel">
              <p className="ivt-quiet">
                Choose the folders {picking.guest.name} may use
                {picking.need.length > 1 ? " on each computer" : ""}.
              </p>
              {picking.need.map((id) => {
                const p = peers.find((x) => x.id === id);
                return (
                  p && (
                    <div key={id}>
                      {picking.need.length > 1 && <strong>{p.name}</strong>}
                      <FolderBrowser
                        peer={p}
                        device={devices[p.id]}
                        picked={picked[p.id] || []}
                        onChange={(next) => setPicked((old) => ({ ...old, [p.id]: next }))}
                      />
                    </div>
                  )
                );
              })}
              <div className="ivt-pick-actions">
                <button type="button" className="ivt-secondary" onClick={() => setPicking(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="ivt-primary small"
                  disabled={busy || picking.need.some((id) => !(picked[id] || []).length)}
                  onClick={() => void savePicked()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </ScreenPopup>
      )}

      {panel && (
        <ScreenPopup
          title={panel === "ended" ? "Ended" : panel === "shortcuts" ? "Shortcuts" : "Services"}
          className="gs-sheet ppl-sheet"
          onClose={() => {
            setPanel("");
            setExtrasAt(Date.now());
          }}
        >
          {panel === "ended" ? (
            <BrowserAgents peer={peer} device={device} toast={toast} />
          ) : panel === "shortcuts" ? (
            <AgentShortcuts peer={peer} toast={toast} bare />
          ) : (
            <ServiceAccessPanel peer={peer} bare />
          )}
        </ScreenPopup>
      )}

      {inviting && invitationSheet()}
      {editing && (
        <AccessEditor
          key={editing.id}
          peer={peer}
          device={device}
          client={editing}
          onClose={() => setEditing(null)}
          onSaved={(removed) => {
            setEditing(null);
            if (removed) setOpenId("");
            setChanged(removed ? "" : "Access updated.");
            void load(true);
          }}
        />
      )}
    </div>
  );
}
