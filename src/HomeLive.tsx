import { useOpenWantedNeed } from "./deep-link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, ChevronRight } from "lucide-react";
import { type AgentRequest, type Device, type Peer, type Session } from "./api";
import type { WorkspaceCapabilities } from "./capabilities";
import type { FleetConnections } from "./useFleetConnections";
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
import { computerWord, pausedIn } from "./pause";
import "./home-live.css";

// Why the live preview shows no fresh picture, as one short pill ("" while
// it's live or simply starting): tapped, it tries again.
export function heroStatus(
  stream: { error: string; cause: string; connecting: boolean; idle?: string },
  word = "Mac",
) {
  const why = stream.error || (stream.connecting ? stream.cause : "");
  if (stream.idle === "locked" || /\blocked\b/i.test(why))
    return `${word} locked`;
  if (stream.idle === "asleep" || /\basleep\b/i.test(why))
    return `${word} asleep`;
  if (!why) return "";
  if (/Screen Recording/i.test(why)) return "Screen Recording off";
  return stream.error ? "Can't show screen" : "Reconnecting";
}

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
  const state = connections[active]?.state || "connecting";
  const online = state === "connected";
  const seen = useRef({ peer: active, connected: false });
  if (seen.current.peer !== active)
    seen.current = { peer: active, connected: false };
  if (online) seen.current.connected = true;
  const connectionStatus = online
    ? "Connected"
    : state === "denied"
      ? "Access needed"
      : state === "disconnected"
        ? "Connection lost"
        : seen.current.connected
          ? "Reconnecting…"
          : "Connecting…";
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
    features.screen &&
    visible &&
    !paused &&
    heroOnScreen &&
    !device.sameComputer;
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
    : agentNeeds({
        peer,
        sessions: [],
        macPrompts,
        logos,
        open: () => {},
        showOnScreen,
      });
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
  const serviceAccess = useServiceAccess(
    peer,
    features.owner && visible,
    connections[active]?.changes,
  );
  const permissionRequests = usePermissionRequests(
    peer,
    features.owner && visible,
  );
  const waitingPeople = useWaitingPeople(
    peer,
    features.owner && visible,
    connections[active]?.changes,
  );
  const bellNeeds = useBellNeeds(peer);
  const needItems: NeedItem[] = [
    ...bellNeeds,
    ...waitingPeople.items,
    ...agentAdmissions.items,
    ...browserApprovals.items,
    ...serviceAccess.items,
    ...permissionRequests.items,
    ...handed,
    ...pending.map((r): NeedItem => ({
      key: `device:${r.id}`,
      icon: <Bell size={22} />,
      title: `${r.name} wants access to ${device.name}`,
      // What it would get, before you tap Allow.
      detail: requestWords(r.scopes),
      actions: [
        { label: "Deny", run: () => decide(r, "deny") },
        { label: "Allow", primary: true, run: () => decide(r, "approve") },
      ],
    })),
    ...agentItems.filter((i) => !i.key.startsWith("mac:")),
    ...waitingChats.map((c): NeedItem => ({
      key: `chat:${c.id}`,
      icon: <Bell size={22} />,
      title: `${c.name} needs your approval`,
      actions: [{ label: "Review", primary: true, run: () => openChat(c.id) }],
    })),
    ...agentItems.filter((i) => i.key.startsWith("mac:")),
  ];
  const needsYou = needItems.length > 0;
  // A notification's request: opened for review the moment it's here.
  useOpenWantedNeed(needItems);
  const live = features.screen && stream.ready;
  // Everyone else on this computer now: other phones, guests, agents.
  const here = (connections[active]?.devices || []).filter((d) => !d.self);
  const controlling = here.find((d) => d.activity === "controlling");
  return (
    <div className="home-live">
      {needsYou && (
        <div className="home-needs">
          <NeedsYouStrip items={needItems} />
        </div>
      )}
      {features.owner && online && here.length > 0 && (
        <button
          className={`home-presence${controlling ? " controlling" : ""}`}
          onClick={() => navigate("invite")}
        >
          <i className="status-dot" aria-hidden="true" />
          <span>
            {controlling
              ? `${controlling.name} is controlling`
              : `${here.length} other ${here.length === 1 ? "device is" : "devices are"} connected`}
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      )}
      <section className="home-hero" ref={hero} aria-label="Computer screen">
        {features.owner && (
          <PauseButton
            peer={peer}
            paused={paused}
            platform={device.platform}
            className="home-pause"
            toast={toast}
          />
        )}
        <button
          className="home-hero-scene"
          aria-label={
            features.screen
              ? `Open ${device.name}'s screen`
              : features.screenSetup
                ? "Set up screen"
                : "Screen unavailable"
          }
          disabled={!features.screen && !features.screenSetup}
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
          <span className="home-screen-open">
            {features.screen
              ? "Open screen"
              : features.screenSetup
                ? "Set up screen"
                : "Screen unavailable"}
            <ChevronRight size={17} aria-hidden="true" />
          </span>
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
          <details className="home-connection">
            <summary aria-label={`Connection details: ${connectionStatus}`}>
              <i className={`status-dot ${online ? "" : "off"}`} />
              {connectionStatus}
              {(paused || (live && !heroPill)) && (
                <span className="home-preview-state">
                  · {paused ? "Paused" : "Live preview"}
                </span>
              )}
            </summary>
            <div className="home-connection-info">
              <p>
                {connectionStatus} · {connection}
              </p>
              {!online && (
                <p>
                  {state === "denied"
                    ? "Restore this device’s access from your computer."
                    : "Reach is trying to connect. Check that your computer is awake and Reach is running."}
                </p>
              )}
              {appLink && (
                <a
                  className="home-app-link"
                  href={appLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Tailscale app · optional, potentially faster
                </a>
              )}
            </div>
          </details>
        </div>
      </section>

      {pinnedTools}

      {browserApprovals.review}
      {agentAdmissions.review}
    </div>
  );
}
