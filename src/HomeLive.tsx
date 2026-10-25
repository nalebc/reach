import { useOpenWantedNeed } from "./deep-link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  Bot,
  ChevronRight,
  Monitor,
  Plus,
  Smartphone,
  Tablet,
} from "lucide-react";
import {
  request,
  type AgentRequest,
  type Device,
  type Peer,
  type Session,
} from "./api";
import type { WorkspaceCapabilities } from "./capabilities";
import type { ConnectedDevice, FleetConnections } from "./useFleetConnections";
import { ReachScene } from "./ReachIdentity";
import type { AgentSession, MacPrompt } from "./agent-sessions";
import { NeedsYouStrip, agentNeeds, type NeedItem } from "./NeedsYou";
import { handoffNeeds, requestOpenThread, useHandoffs } from "./handoffs";
import { useBrowserApprovals } from "./browser-approvals";
import { useAgentAdmissions } from "./agent-admissions";
import { useServiceAccess } from "./service-access";
import { usePermissionRequests } from "./permission-requests";
import { useWaitingPeople } from "./waiting-people";
import { useBellNeeds } from "./Notifications";
import { requestWords } from "./scope-words";
import { useAgentLogos } from "./agent-logos";
import { useRemoteScreen } from "./useRemoteScreen";
import { PauseButton } from "./PauseControl";
import { accessOf, hasAccessNow, listedAccess, statusIn, type AccessSession } from "./access-list";
import { Mascot } from "./Mascot";
import { computerWord, pausedIn } from "./pause";
import "./home-live.css";

// Why the live preview shows no fresh picture, as one short pill ("" while
// it's live or simply starting): tapped, it tries again.
export function heroStatus(
  stream: { error: string; cause: string; connecting: boolean; idle?: string },
  word = "Mac",
) {
  const why = stream.error || (stream.connecting ? stream.cause : "");
  if (stream.idle === "locked" || /\blocked\b/i.test(why)) return `${word} locked`;
  if (stream.idle === "asleep" || /\basleep\b/i.test(why)) return `${word} asleep`;
  if (!why) return "";
  if (/Screen Recording/i.test(why)) return "Screen Recording off";
  return stream.error ? "Can't show screen" : "Reconnecting";
}

const isAgent = (d: ConnectedDevice) => !!d.access?.some((a) => a.kind === "agent");
const DeviceGlyph = ({ device, size = 15 }: { device: ConnectedDevice; size?: number }) =>
  isAgent(device) ? (
    <Bot size={size} />
  ) : device.kind === "phone" ? (
    <Smartphone size={size} />
  ) : device.kind === "tablet" ? (
    <Tablet size={size} />
  ) : (
    <Monitor size={size} />
  );

function usePageVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

// Whether an element is in view. Off screen for graceMs (scrolled past), it
// counts as gone; back in view, at once. A quick scroll keeps it.
export function useOnScreen(ref: { current: Element | null }, graceMs = 5000) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry?.isIntersecting) setOn(true);
      else timer = setTimeout(() => setOn(false), graceMs);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, graceMs]);
  return on;
}

export default function HomeLive({
  features,
  pinnedTools,
  device,
  peer,
  active,
  connections,
  connection,
  appLink,
  chats,
  pending,
  decide,
  navigate,
  openChat,
  agentSessions = [],
  macPrompts = [],
  openAgentSession,
  showOnScreen,
  refreshSessions,
  toast,
}: {
  features: WorkspaceCapabilities;
  pinnedTools?: ReactNode;
  device: Device;
  peer: Peer;
  active: string;
  connections: FleetConnections;
  connection: string;
  // Signed in from the browser: the Tailscale app, one tap away.
  appLink?: string;
  chats: Session[];
  pending: AgentRequest[];
  decide: (request: AgentRequest, decision: "approve" | "deny") => void;
  navigate: (page: string) => void;
  openChat: (id: string) => void;
  // Codex and Claude Code sessions anywhere on the Mac (the Chat feed).
  agentSessions?: AgentSession[];
  // What macOS itself is asking right now (answered at the Mac).
  macPrompts?: MacPrompt[];
  openAgentSession?: (session: AgentSession) => void;
  // Opens the live screen on a Mac dialog, to answer it there.
  showOnScreen?: (prompt: MacPrompt) => void;
  refreshSessions: () => void;
  toast: (message: string) => void;
}) {
  const visible = usePageVisible();
  const logos = useAgentLogos(openAgentSession ? peer : null);
  const online = connections[active]?.state === "connected";
  // Paused on the computer: its screen isn't watched, not even here.
  const paused = pausedIn(connections[active]?.changes, device);
  // Live screen inside the laptop: the same stream as Screen, at preview size,
  // while the laptop is in view (scrolled past for a few seconds, the Mac
  // stops capturing and encoding it).
  const hero = useRef<HTMLElement>(null);
  const heroOnScreen = useOnScreen(hero);
  // Tapping the preview's status pill connects again.
  const [heroRetry, setHeroRetry] = useState(0);
  // On the computer itself the preview would only show itself (Screen says
  // so and streams if asked).
  const watching =
    features.screen && visible && !paused && heroOnScreen && !device.sameComputer;
  const stream = useRemoteScreen(
    peer,
    features.screen,
    watching,
    "primary",
    "preview",
    heroRetry,
    false,
  );
  const heroPill = watching
    ? heroStatus(stream, computerWord(device.platform))
    : "";
  const waitingChats = features.codex
    ? chats.filter((c) => c.status === "waiting")
    : [];
  const agentItems = openAgentSession
    ? agentNeeds({
        peer,
        sessions: agentSessions.filter((s) => !s.archived),
        macPrompts,
        logos,
        open: openAgentSession,
        answered: refreshSessions,
        showOnScreen,
      })
    : agentNeeds({ peer, sessions: [], macPrompts, logos, open: () => {}, showOnScreen });
  // Apps agents handed you (Tag in): first, an agent waits on each.
  const [handoffs, setHandoffs] = useHandoffs(
    peer,
    true,
    connections[active]?.changes,
  );
  const handed = handoffNeeds({
    peer,
    handoffs,
    logos,
    open: (h) => {
      requestOpenThread(peer.computerId || peer.id, h.threadId);
      navigate("apps");
    },
    ended: (h) => setHandoffs((list) => list.filter((x) => x.id !== h.id)),
  });
  const browserApprovals = useBrowserApprovals(
    peer,
    features.owner && visible,
    connections[active]?.changes,
  );
  const agentAdmissions = useAgentAdmissions(
    peer,
    features.owner && visible,
    connections[active]?.changes,
  );
  const serviceAccess = useServiceAccess(peer, features.owner && visible, connections[active]?.changes);
  const permissionRequests = usePermissionRequests(peer, features.owner && visible);
  const waitingPeople = useWaitingPeople(peer, features.owner && visible, connections[active]?.changes);
  const bellNeeds = useBellNeeds(peer);
  const needItems: NeedItem[] = [
    ...bellNeeds,
    ...waitingPeople.items,
    ...agentAdmissions.items,
    ...browserApprovals.items,
    ...serviceAccess.items,
    ...permissionRequests.items,
    ...handed,
    ...pending.map(
      (r): NeedItem => ({
        key: `device:${r.id}`,
        icon: <Bell size={22} />,
        title: `${r.name} wants access to ${device.name}`,
        // What it would get, before you tap Allow.
        detail: requestWords(r.scopes),
        actions: [
          { label: "Deny", run: () => decide(r, "deny") },
          { label: "Allow", primary: true, run: () => decide(r, "approve") },
        ],
      }),
    ),
    ...agentItems.filter((i) => !i.key.startsWith("mac:")),
    ...waitingChats.map(
      (c): NeedItem => ({
        key: `chat:${c.id}`,
        icon: <Bell size={22} />,
        title: `${c.name} needs your approval`,
        actions: [{ label: "Review", primary: true, run: () => openChat(c.id) }],
      }),
    ),
    ...agentItems.filter((i) => i.key.startsWith("mac:")),
  ];
  const needsYou = needItems.length > 0;
  // A notification's request: opened for review the moment it's here.
  useOpenWantedNeed(needItems);
  const live = features.screen && stream.ready;
  // Everyone else on this computer now: other phones, guests, agents.
  const here = (connections[active]?.devices || []).filter((d) => !d.self);
  const controlling = here.find((d) => d.activity === "controlling");
  // Who may use it (people and agents you invited), for the Access card:
  // read when Home opens, when someone connects or leaves, and when a new
  // request comes in. Never on a timer.
  const [access, setAccess] = useState<
    { id: string; name: string; kind?: string; status?: string; expiresAt?: number; mascot?: number }[]
  >([]);
  const hereKey = here.map((d) => d.id).join(",");
  const requestsKey = (() => {
    try {
      return JSON.parse(connections[active]?.changes || "{}")?.requests ?? "";
    } catch {
      return "";
    }
  })();
  // Browser agents as the Mac lists them: one that idle-ended or was
  // stopped keeps its end date, and only this list says it ended.
  const [sessions, setSessions] = useState<AccessSession[]>([]);
  useEffect(() => {
    if (!features.owner || !visible) return;
    let live = true;
    void Promise.allSettled([
      request<{ clients?: { id: string; name: string; kind?: string; status?: string; expiresAt?: number; mascot?: number }[] }>(peer, "/api/clients"),
      request<{ agents?: AccessSession[] }>(peer, "/api/browser/agents"),
    ]).then(([clients, agents]) => {
      if (!live) return;
      if (clients.status === "fulfilled") setAccess(Array.isArray(clients.value?.clients) ? clients.value.clients : []);
      if (agents.status === "fulfilled" && Array.isArray(agents.value?.agents)) setSessions(agents.value.agents);
    });
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, features.owner, visible, hereKey, requestsKey]);
  // The same people and agents Agents & people lists (src/access-list.ts),
  // in the computer's order; of them, only who joined has access now.
  const listed = listedAccess(access, sessions, Date.now());
  const invited = access.filter((c) => listed.agents.includes(c) || listed.people.includes(c));
  const withAccess = invited.filter((c) => hasAccessNow(c, sessions)).length;
  const waiting = listed.agents.filter((c) => statusIn(c, sessions) === "pending").length;
  // Not opened (or joined) yet: listed, no access until they do.
  const unopened = invited.filter((c) => {
    const status = statusIn(c, sessions);
    return status === "invited" || (c.kind === "guest" && status === "expired");
  }).length;
  // Faces: who's here first, then who else may come in.
  const faces = [
    ...here.map((d) => {
      const who = accessOf(d.access, access, d.name);
      return { id: d.id, here: true, agent: isAgent(d), face: !!who, glyph: who ? <Mascot id={who.id} drawn={who.mascot} /> : <DeviceGlyph device={d} size={13} /> };
    }),
    ...invited
      .filter((c) => !here.some((d) => d.id === c.id || d.name === c.name))
      .map((c) => ({
        id: c.id,
        here: false,
        agent: c.kind === "agent",
        face: true,
        glyph: <Mascot id={c.id} drawn={c.mascot} />,
      })),
  ].slice(0, 4);
  const accessTitle = controlling
    ? `${controlling.name} is controlling`
    : here.length
      ? `${here.length} here now`
      : withAccess
        ? `${withAccess} with access`
        : invited.length
          ? `${invited.length} invited`
          : "Only you";
  const accessNote = waiting
    ? `${waiting} waiting for you`
    : unopened && (controlling || here.length || withAccess)
      ? `${unopened} not opened yet`
      : "Agents & people";
  return (
    <div className="home-live">
      <section className="home-hero" ref={hero}>
        <button
          className="home-hero-scene"
          aria-label={
            features.screen ? `Open ${device.name}'s screen` : "Set up screen"
          }
          onClick={() => navigate(features.screen ? "screen" : "settings")}
        >
          {features.screen && (
            <canvas
              ref={stream.canvas}
              className={`home-peek ${live ? "is-live" : ""} ${live && heroPill ? "is-held" : ""}`}
              aria-hidden="true"
            />
          )}
          <ReachScene
            mode="computer"
            companion
            liveScreen={live}
            className="home-scene"
          />
          {features.screen && <span className="home-screen-open">Open screen <ChevronRight size={15} /></span>}
        </button>
        {heroPill && (
          // The last picture stays, dimmed; this says why. Tap: try again.
          <button
            className="home-hero-status"
            title={stream.error || stream.cause || heroPill}
            aria-label={`${heroPill}. Try again`}
            onClick={() => setHeroRetry((n) => n + 1)}
          >
            {heroPill}
          </button>
        )}
        <div className="home-hero-text">
          <h1>{device.name}</h1>
          <p>
            <i className={`status-dot ${online ? "" : "off"}`} />
            {online ? "Online" : "Connecting…"} · {connection}
            {appLink && (
              <>
                {" · "}
                <a className="home-app-link" href={appLink} target="_blank" rel="noopener noreferrer">
                  faster with the app
                </a>
              </>
            )}
            {live && !heroPill ? " · live" : paused ? " · paused" : ""}
          </p>
        </div>
        {features.owner && (
          <PauseButton
            peer={peer}
            paused={paused}
            platform={device.platform}
            className="home-pause"
            toast={toast}
          />
        )}
      </section>

      {features.owner && (
        // Who can use this computer, one tap from Home: the card opens
        // Agents & people (what each may do, Remove); Invite opens the
        // invitation at once.
        <section className={`home-access${controlling ? " controlling" : ""}`} aria-label="Access">
          <button className="home-access-who" onClick={() => navigate("invite")}>
            <span className="home-access-faces" aria-hidden="true">
              {faces.length ? (
                faces.map((f) => (
                  <i key={f.id} className={`${f.here ? "here" : ""}${f.agent ? " agent" : ""}${f.face ? " has-mascot" : ""}`}>
                    {f.glyph}
                  </i>
                ))
              ) : (
                <i className="you">You</i>
              )}
            </span>
            <span className="home-access-text">
              <strong>{accessTitle}</strong>
              <small className={waiting ? "waiting" : undefined}>{accessNote}</small>
            </span>
            <ChevronRight className="home-access-go" size={17} />
          </button>
          <button
            className="home-access-add"
            aria-label="Invite an agent or someone"
            onClick={() => navigate("invite:new")}
          >
            <Plus size={17} /> Invite
          </button>
        </section>
      )}

      {needsYou && (
        // Everything that needs you, one card at a time (swipe for the next):
        // devices asking in, what the agents ask (answered right here when
        // the phone can), chats to review, then what the Mac itself asks.
        <div className="home-needs">
          <NeedsYouStrip items={needItems} />
        </div>
      )}

      {pinnedTools}

      {browserApprovals.review}
      {agentAdmissions.review}

    </div>
  );
}
