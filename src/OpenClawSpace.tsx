import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  Clock,
  GitFork,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { post, type Peer } from "./api";
import {
  ChatAppPicker,
  ChatLibraryHeader,
  ago,
  type ChatAppChoice,
} from "./ChatList";
import { ClawSessionSettings } from "./OpenClawControls";
import { useViewportBox } from "./useViewportBox";
import { type AgentLogos } from "./agent-logos";
import AgentMarkdown from "./AgentMarkdown";
import { NeedsYouStrip, type NeedItem } from "./NeedsYou";
import { MoveOffer } from "./MoveChat";
import type { AgentHealth, AgentSession } from "./agent-sessions";
import { BrandCourier } from "./ReachIdentity";
import { ClawChatCost } from "./OpenClawSpend";
import { ClawAgentsPanel } from "./OpenClawAgents";
import { ClawSkills } from "./OpenClawSkills";
import { ClawOnboard } from "./OpenClawOnboard";
import { ClawRelayAction } from "./OpenClawRelay";
import { channelName, usePolling } from "./openclaw-polling";
import { ClawCustomize, ClawScheduled } from "./OpenClawPages";
import { ClawPageTop } from "./OpenClawRow";
import "./openclaw.css";
import { ChatCompanion } from "./ChatCompanion";

const base = "/api/sessions/openclaw";
type Session = {
  key: string;
  title: string;
  agentId: string;
  channel: string;
  updatedAt: number;
  model: string;
  modelProvider?: string;
  thinkingLevel?: string;
  status: string;
  canStop?: boolean;
  // Reach writes only in chats it made (server/openclaw.mjs writable()).
  writable?: boolean;
};
type Approval = {
  id: string;
  sessionKey?: string;
  command: string;
  cwd: string;
  expiresAt: number;
  canRespond?: boolean;
};
type Overview = {
  connected: boolean;
  sessions: Session[];
  approvals: Approval[];
  error?: string;
  // Installed here, its Gateway just isn't running: a phone may start it.
  canStart?: boolean;
  // What it showed, to wait on its next change (an older Mac has none).
  version?: string;
};
type History = {
  session: Session;
  // sentTo: OpenClaw also posted this reply to that app (e.g. "whatsapp").
  items: { id: string; role: string; text: string; tool: boolean; sentTo?: string }[];
  streaming: string;
  error: string;
  approvals: Approval[];
  mayHaveOlder: boolean;
  version?: string;
  // retrying: a model failed (`retrying` says why); OpenClaw tries its next.
  phase?: "generation" | "delivery" | "retrying";
  retrying?: string;
  delivery?: {
    channel: string;
    status: "pending" | "sent" | "failed" | "suppressed" | "unconfirmed";
  } | null;
};
function approvalItems(
  peer: Peer,
  prompts: Approval[],
  done: () => void,
  onScreen?: () => void,
): NeedItem[] {
  return prompts.map((prompt) => ({
    key: prompt.id,
    icon: <ShieldCheck size={18} />,
    title: "OpenClaw needs permission",
    detail: [prompt.command, prompt.cwd].filter(Boolean).join(" · "),
    note: prompt.canRespond === false ? "Answer this request in OpenClaw on your computer." : undefined,
    screen: onScreen,
    actions: prompt.canRespond === false ? [] : [
      { label: "Allow once", decision: "allow-once" },
      { label: "Always allow", decision: "allow-always" },
      { label: "Deny", decision: "deny" },
    ].map((action) => ({
      label: action.label,
      primary: action.decision === "allow-once",
      completes: true,
      run: async () => {
        await post(peer, `${base}/approval`, {
          id: prompt.id,
          decision: action.decision,
        });
        done();
      },
    })),
  }));
}

function Conversation({
  peer,
  session,
  onBack,
  deviceRequests,
  onReviewDevice,
  logos,
  health = [],
  onOpenChat,
  onScreen,
  apps,
  onAppChange,
}: {
  peer: Peer;
  session: Session;
  onBack: () => void;
  deviceRequests: number;
  onReviewDevice: () => void;
  logos: AgentLogos;
  // Continuing this chat in another app (MoveChat.tsx).
  health?: AgentHealth[];
  onOpenChat?: (s: AgentSession) => void;
  onScreen?: () => void;
  apps: ChatAppChoice[];
  onAppChange: (app: string) => void;
}) {
  const surface = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width: 720px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 720px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useViewportBox(surface, narrow);
  const [moving, setMoving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const threadActions = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type !== "keydown" && threadActions.current?.contains(event.target as Node)) return;
      if (threadActions.current) threadActions.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  // Deleting is for good (in OpenClaw too): the first tap asks, a second deletes.
  const [deleting, setDeleting] = useState<"" | "ask" | "busy">("");
  useEffect(() => {
    if (deleting !== "ask") return;
    const timer = setTimeout(() => setDeleting(""), 4000);
    return () => clearTimeout(timer);
  }, [deleting]);
  const [refresh, setRefresh] = useState(0);
  const [limit, setLimit] = useState(200);
  const { data, error } = usePolling<History>(
    peer,
    `${base}/history?${new URLSearchParams({ key: session.key, limit: String(limit) })}`,
    1800,
    refresh,
    `${base}/changes?${new URLSearchParams({ key: session.key })}`,
  );
  const draftKey = `reach.openclaw.draft:${peer.id}:${session.key}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const sending = useRef(false);
  const attempt = useRef<{ text: string; id: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const current = data?.session || session;
  const working = current.status === "running";
  const unsettled =
    working || current.status === "unknown" || current.status === "waiting";
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, text]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [data?.items.at(-1)?.id, data?.streaming]);
  const reload = () => setRefresh((v) => v + 1);
  const send = async () => {
    if (!text.trim() || sending.current || unsettled || error) return;
    sending.current = true;
    setBusy(true);
    setProblem("");
    const message = text;
    // A failed/uncertain response can be retried without starting a second run.
    if (!attempt.current || attempt.current.text !== message)
      attempt.current = { text: message, id: crypto.randomUUID() };
    try {
      // Replies stay in Reach: Reach never asks OpenClaw to post to WhatsApp
      // etc. (the server refuses it too).
      await post(peer, `${base}/send`, {
        key: session.key,
        text: message,
        requestId: attempt.current.id,
      });
      setText((value) => (value === message ? "" : value));
      attempt.current = null;
      follow.current = true;
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setProblem("");
    try {
      await post(peer, `${base}/stop`, { key: session.key });
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const closeMenu = () => {
    if (threadActions.current) threadActions.current.open = false;
  };
  // The message box grows with what's typed, as ChatGPT's does.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const model = current.model ? current.model.split("/").pop() : "";
  const stopButton = (
    <button type="button" className="claw-send" aria-label="Stop OpenClaw" disabled={busy} onClick={() => void stop()}>
      <Square size={13} fill="currentColor" />
    </button>
  );
  return (
    <section ref={surface} className="claw-conversation claw-app" aria-label="OpenClaw conversation">
      <header className="claw-thread-head">
        <button className="claw-round" aria-label="Back to OpenClaw sessions" onClick={onBack}>
          <ChevronLeft size={22} />
        </button>
        <button
          className="claw-thread-title"
          aria-label="Choose an app, OpenClaw selected"
          aria-expanded={appMenuOpen}
          onClick={() => setAppMenuOpen(!appMenuOpen)}
        >
          <h1>{current.title}</h1>
          <span>
            {[current.channel && current.channel !== "webchat" ? channelName(current.channel) : "", model]
              .filter(Boolean)
              .join(" · ") || "OpenClaw"}
            <ChevronDown size={13} />
          </span>
        </button>
        <details className="claw-thread-actions" ref={threadActions}>
          <summary className="claw-round" aria-label="OpenClaw conversation actions">
            <MoreHorizontal size={20} />
          </summary>
          <div className="claw-thread-menu">
            {current.writable === true && (
              <button
                className="claw-menu-item"
                aria-label="OpenClaw chat settings"
                aria-expanded={settingsOpen}
                onClick={() => {
                  closeMenu();
                  setSettingsOpen(!settingsOpen);
                }}
              >
                <Settings2 size={18} />
                Chat settings
              </button>
            )}
            <button
              className="claw-menu-item"
              aria-label="Refresh OpenClaw conversation"
              onClick={() => {
                closeMenu();
                reload();
              }}
            >
              <RefreshCw size={17} />
              Refresh
            </button>
            {onOpenChat && (
              <button
                className="claw-menu-item"
                aria-label="Continue in another app"
                aria-expanded={moving}
                onClick={() => {
                  closeMenu();
                  setMoving(!moving);
                }}
              >
                <GitFork size={18} />
                Continue in another app
              </button>
            )}
            {!!deviceRequests && (
              <button
                className="claw-menu-item"
                aria-label={`Review ${deviceRequests} device requests`}
                onClick={() => {
                  closeMenu();
                  onReviewDevice();
                }}
              >
                <ShieldCheck size={18} />
                Device requests
              </button>
            )}
            {current.writable === true && (
              <button
                className={`claw-menu-item danger${deleting ? " claw-delete-ask" : ""}`}
                aria-label={deleting ? "Tap again to delete this chat" : "Delete chat"}
                disabled={deleting === "busy"}
                onClick={async () => {
                  if (!deleting) return setDeleting("ask");
                  setDeleting("busy");
                  setProblem("");
                  try {
                    await post(peer, `${base}/remove`, { key: session.key });
                    onBack();
                  } catch (e) {
                    setProblem((e as Error).message);
                    setDeleting("");
                  }
                }}
              >
                {deleting === "busy" ? <Loader2 size={17} className="spin" /> : <Trash2 size={17} />}
                {deleting ? "Tap again to delete" : "Delete chat"}
              </button>
            )}
            <div className="claw-menu-cost">
              <ClawChatCost peer={peer} sessionKey={current.key} refresh={current.updatedAt} />
            </div>
          </div>
        </details>
      </header>
      {appMenuOpen && (
        <div className="claw-app-switch">
          <ChatAppPicker health={health} apps={apps} logos={logos} value="openclaw" onChange={onAppChange} />
        </div>
      )}
      {settingsOpen && current.writable === true && (
        <ClawSessionSettings
          peer={peer}
          session={current}
          disabled={unsettled}
          onSaved={reload}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {moving && onOpenChat && (
        <div className="claw-move">
          <MoveOffer
            peer={peer}
            session={{ agent: "openclaw", id: current.key, title: current.title }}
            health={health}
            logos={logos}
            onMoved={onOpenChat}
          />
        </div>
      )}
      <div
        className="claw-transcript"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {!data && !error && (
          <p className="claw-note" role="status">
            <Loader2 size={13} className="spin" />
            Loading…
          </p>
        )}
        {data?.mayHaveOlder &&
          (limit < 1000 ? (
            <button
              className="claw-text-button"
              onClick={() => {
                follow.current = false;
                setLimit(1000);
              }}
            >
              Load older messages
            </button>
          ) : (
            <p className="claw-note">Showing the latest 1,000 messages.</p>
          ))}
        {data?.items.map((item) =>
          item.tool ? (
            <details className="claw-tool" key={item.id}>
              <summary>Tool output</summary>
              <pre>{item.text}</pre>
            </details>
          ) : (
            <article
              className={`claw-message ${item.role === "user" ? "from-user" : "from-agent"}`}
              key={item.id}
            >
              {item.role !== "user" && item.role !== "assistant" && <small>System</small>}
              <AgentMarkdown text={item.text} />
              {item.sentTo && <small className="claw-sent">Sent to {channelName(item.sentTo)}</small>}
              {item.role === "assistant" && (
                <ClawRelayAction
                  peer={peer}
                  sessionKey={current.key}
                  title={current.title}
                  item={item.id}
                  health={health}
                  logos={logos}
                  onOpenChat={onOpenChat}
                />
              )}
            </article>
          ),
        )}
        {data && !data.items.length && !data.streaming && <p className="claw-note claw-quiet">No messages yet.</p>}
        {data?.streaming && (
          <article className="claw-message from-agent">
            <AgentMarkdown text={data.streaming} />
          </article>
        )}
        {working && !error && (
          <p className="claw-note claw-working" role="status">
            <span className="claw-working-dot" aria-hidden="true" />
            {data?.phase === "retrying"
              ? `That model didn’t answer (${data.retrying}). OpenClaw is trying another…`
              : data?.phase === "delivery"
                ? "OpenClaw is finishing delivery…"
                : "OpenClaw is working…"}
          </p>
        )}
        {data?.delivery && data.delivery.status !== "pending" && (
          <p className="claw-note" role="status">
            {data.delivery.status === "sent"
              ? `Sent to ${channelName(data.delivery.channel)}.`
              : data.delivery.status === "failed"
                ? `Delivery to ${channelName(data.delivery.channel)} failed. Check OpenClaw before retrying.`
                : data.delivery.status === "suppressed"
                  ? "OpenClaw chose not to send an external reply."
                  : `${channelName(data.delivery.channel)} delivery is unconfirmed. Check that conversation before retrying.`}
          </p>
        )}
      </div>
      {!!data?.approvals.length && (
        <NeedsYouStrip items={approvalItems(peer, data.approvals, reload, onScreen)} />
      )}
      {(error || problem || data?.error) && (
        <p className="claw-error" role="alert">
          {error || problem || data?.error}
        </p>
      )}
      {/* A WhatsApp group's, a Discord channel's or a cron job's chat: shown,
          never written to from here (a message would run the agent inside
          that group's context). */}
      {current.writable !== true ? (
        <div className="claw-readonly" role="note">
          <Lock size={15} aria-hidden="true" />
          <p>
            Read only. Reach doesn’t write in this{" "}
            {current.channel && current.channel !== "webchat" ? `${channelName(current.channel)} ` : ""}chat.
          </p>
          {unsettled && current.canStop !== false && stopButton}
        </div>
      ) : (
        <form
          className="claw-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={field}
            aria-label="Message OpenClaw"
            placeholder="Ask OpenClaw"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          {unsettled && current.canStop !== false ? (
            stopButton
          ) : (
            <button
              className={`claw-send${text.trim() ? " ready" : ""}`}
              aria-label="Send to OpenClaw"
              disabled={!text.trim() || busy || unsettled || !!error || !data}
            >
              {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            </button>
          )}
        </form>
      )}
      {current.writable === true && unsettled && current.canStop === false && (
        <small className="claw-delivery-note">To stop this reply, use OpenClaw on your computer.</small>
      )}
    </section>
  );
}

export default function OpenClawSpace({
  peer,
  apps,
  logos,
  onAppChange,
  appPending,
  deviceRequests = 0,
  onReviewDevice,
  onDiscover,
  openKey,
  onOpened,
  health,
  onOpenChat,
  onScreen,
  onNew,
}: {
  peer: Peer;
  apps: ChatAppChoice[];
  logos: AgentLogos;
  onAppChange: (app: string) => void;
  appPending: Record<string, number>;
  deviceRequests?: number;
  onReviewDevice: () => void;
  onDiscover?: () => void;
  // A chat moved here from another app: opened as soon as it's listed.
  openKey?: string | null;
  onOpened?: () => void;
  // Continuing an OpenClaw chat in another app (MoveChat.tsx).
  health?: AgentHealth[];
  onOpenChat?: (s: AgentSession) => void;
  onScreen?: () => void;
  // A new OpenClaw chat of Reach's own (EverythingChat NewClawChat).
  onNew?: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const { data, error } = usePolling<Overview>(peer, `${base}/overview`, 5000, refresh, `${base}/changes`);
  const [opened, setOpened] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState("");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);
  // The chats, or one of the pages the ChatGPT app keeps in its side menu.
  const [page, setPage] = useState<"home" | "scheduled" | "customize" | "agents" | "skills">("home");
  const sessions = data?.sessions || [];
  const words = query.trim().toLowerCase();
  const found = sessions.filter((s) =>
    `${s.title} ${s.agentId} ${s.channel} ${channelName(s.channel)} ${s.model}`.toLowerCase().includes(words),
  );
  const agents = [...new Set(found.map((s) => s.agentId))];
  const pending = {
    ...appPending,
    openclaw: Math.max(appPending.openclaw || 0, data?.approvals.length || 0),
  };
  useEffect(() => {
    const moved = openKey && sessions.find((s) => s.key === openKey);
    if (!moved) return;
    setOpened(moved);
    onOpened?.();
  }, [openKey, sessions, onOpened]);
  const reload = () => setRefresh((n) => n + 1);
  if (opened)
    return (
      <Conversation
        key={opened.key}
        peer={peer}
        session={opened}
        onBack={() => {
          setOpened(null);
          reload();
        }}
        deviceRequests={deviceRequests}
        onReviewDevice={onReviewDevice}
        logos={logos}
        health={health}
        onOpenChat={onOpenChat}
        onScreen={onScreen}
        apps={apps}
        onAppChange={onAppChange}
      />
    );
  const home = () => setPage("home");
  return (
    <div className="chat-workspace">
      <div className={`chat-library claw-library claw-app ${searchOpen && page === "home" ? "search-open" : ""}`}>
        {page === "scheduled" ? (
          <ClawScheduled peer={peer} refresh={refresh} onBack={home} />
        ) : page === "customize" ? (
          <ClawCustomize
            peer={peer}
            refresh={refresh}
            onBack={home}
            onOpen={setPage}
            deviceRequests={deviceRequests}
            onReviewDevice={onReviewDevice}
            onChanged={reload}
          />
        ) : page === "agents" || page === "skills" ? (
          <section className="claw-page">
            <ClawPageTop
              title={page === "agents" ? "Agents" : "Skills"}
              onBack={() => setPage("customize")}
              backLabel="Back to Customize"
            />
            {page === "agents" ? (
              <ClawAgentsPanel peer={peer} query="" refresh={refresh} />
            ) : (
              <ClawSkills peer={peer} query="" refresh={refresh} />
            )}
          </section>
        ) : (
          <>
            <ChatLibraryHeader
              health={health}
              peer={peer}
              apps={apps}
              logos={logos}
              value="openclaw"
              pending={pending}
              onChange={onAppChange}
              onNew={onNew}
              onRefresh={() => {
                reload();
                onDiscover?.();
              }}
              searchOpen={searchOpen}
              onSearch={() => {
                if (searchOpen) setQuery("");
                setSearchOpen(!searchOpen);
              }}
            />
            <div className="chat-library-tools">
              <ChatAppPicker health={health} apps={apps} logos={logos} value="openclaw" onChange={onAppChange} pending={pending} />
              <label className="chat-list-search">
                <Search size={16} />
                <input
                  ref={searchField}
                  type="search"
                  aria-label="Search OpenClaw sessions"
                  placeholder="Search chats"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button aria-label="Clear search" onClick={() => setQuery("")}>
                    <X size={15} />
                  </button>
                )}
              </label>
            </div>
            {(error || data?.error) && (
              <div className="claw-connection-error" role="alert">
                <p className="claw-error">{error || data?.error}</p>
                <button className="claw-button" onClick={reload}>Retry connection</button>
              </div>
            )}
            {data?.canStart && !error && (
              <button
                className="claw-pill strong claw-start"
                disabled={starting}
                onClick={async () => {
                  setStarting(true);
                  setStartProblem("");
                  try {
                    await post(peer, `${base}/gateway/start`, {});
                    reload();
                  } catch (e) {
                    setStartProblem((e as Error).message);
                  } finally {
                    setStarting(false);
                  }
                }}
              >
                {starting ? <Loader2 size={14} className="spin" /> : null}
                {starting ? "Starting OpenClaw…" : `Start OpenClaw on ${peer.name}`}
              </button>
            )}
            {data && !data.connected && !data.canStart && <ClawOnboard peer={peer} onDone={reload} />}
            {startProblem && (
              <p className="claw-error" role="alert">
                {startProblem}
              </p>
            )}
            {!data && !error && (
              <p className="claw-note" role="status">
                <Loader2 size={14} className="spin" />
                Finding OpenClaw on {peer.name}…
              </p>
            )}
            {data?.connected && !words && <ChatCompanion title="Your OpenClaw workspace">Chats, schedules and connected apps.</ChatCompanion>}
            {data && !words && (
              <nav className="claw-nav" aria-label="OpenClaw">
                <button type="button" className="claw-nav-item" disabled={!data.connected} onClick={() => setPage("scheduled")}>
                  <Clock size={21} />
                  Scheduled
                </button>
                <button type="button" className="claw-nav-item" onClick={() => setPage("customize")}>
                  <SlidersHorizontal size={21} />
                  Customize
                  {!!deviceRequests && (
                    <span className="claw-nav-count" aria-label={`${deviceRequests} device requests`}>
                      {deviceRequests}
                    </span>
                  )}
                </button>
              </nav>
            )}
            {data?.connected &&
              (found.length ? (
                agents.map((agent) => (
                  <section className="claw-chats" key={agent} aria-label={agent === "main" ? "Main agent" : agent}>
                    <h2 className="claw-label">{agents.length > 1 ? (agent === "main" ? "Main" : agent) : words ? "Search results" : "Chats"}</h2>
                    {found
                      .filter((s) => s.agentId === agent)
                      .map((s) => (
                        <button className={`claw-chat ${s.status}`} key={s.key} onClick={() => setOpened(s)}>
                          <span className="claw-chat-text">
                            <strong>{s.title}</strong>
                            {s.writable !== true && <small>{channelName(s.channel)}</small>}
                          </span>
                          <span className="claw-chat-tail">
                            {s.status === "running" ? (
                              <Loader2 size={15} className="spin" aria-label="Working" />
                            ) : s.status === "waiting" ? (
                              <span className="claw-chat-dot" aria-label="Needs you" />
                            ) : null}
                            <time
                              dateTime={s.updatedAt ? new Date(s.updatedAt).toISOString() : undefined}
                              title={s.updatedAt ? `Updated ${new Date(s.updatedAt).toLocaleString()}` : undefined}
                            >
                              {s.updatedAt ? ago(s.updatedAt) : ""}
                            </time>
                          </span>
                        </button>
                      ))}
                  </section>
                ))
              ) : sessions.length ? (
                <p className="claw-note claw-quiet">No chats match “{query.trim()}”.</p>
              ) : (
                <div className="claw-empty-state">
                  <span className="claw-empty-icon" aria-hidden="true">
                    <MessageSquare size={18} />
                  </span>
                  <strong>Start your first chat</strong>
                  <p>Your OpenClaw chats from Reach, WhatsApp and the rest show here.</p>
                  {onNew && (
                    <button type="button" className="claw-pill strong" onClick={onNew}>
                      Start a chat
                    </button>
                  )}
                </div>
              ))}
            {onNew && (
              <button className="chat-quick-new" aria-label="New OpenClaw chat" onClick={onNew}>
                <span className="chat-compose-mascot" aria-hidden="true">
                  <BrandCourier active />
                </span>
                <span className="chat-quick-label">Ask OpenClaw anything</span>
                <span className="chat-quick-arrow">
                  <ArrowUp size={18} />
                </span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
