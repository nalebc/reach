import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  GitFork,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { request, post, type Peer } from "./api";
import { ChatAppPicker, ago, type ChatAppChoice } from "./ChatList";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import AgentMarkdown from "./AgentMarkdown";
import { NeedsYouStrip, type NeedItem } from "./NeedsYou";
import { MoveOffer } from "./MoveChat";
import type { AgentHealth, AgentSession } from "./agent-sessions";
import "./openclaw.css";

const base = "/api/sessions/openclaw";
type Session = {
  key: string;
  title: string;
  agentId: string;
  channel: string;
  updatedAt: number;
  model: string;
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
const channelName = (channel: string) =>
  ({
    whatsapp: "WhatsApp",
    discord: "Discord",
    telegram: "Telegram",
    webchat: "Direct",
    slack: "Slack",
    signal: "Signal",
    imessage: "iMessage",
  })[channel] || channel;

// One request at a time; stop both requests and polling when this view closes.
// With `watch`, the Mac says when what it answered changed (a request that
// waits): read again then. A Mac that doesn't is asked every `interval`.
function usePolling<T extends { version?: string }>(
  peer: Peer,
  route: string,
  interval: number,
  refresh: number,
  watch?: string,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    let watching = !!watch;
    const poll = async () => {
      let next = interval;
      try {
        if (!document.hidden) {
          const result = await request<T>(peer, route, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          });
          if (active) {
            setData(result);
            setError("");
          }
          if (watch && watching && typeof result?.version === "string") {
            const asked = Date.now();
            try {
              await request(peer, `${watch}${watch.includes("?") ? "&" : "?"}after=${encodeURIComponent(result.version)}`, {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
              });
            } catch (e) {
              // An older Mac without it: asked every `interval`.
              if ((e as { status?: number }).status !== 404) throw e;
              watching = false;
            }
            // Read again at once, never in a tight loop.
            if (watching) next = Math.max(0, 250 - (Date.now() - asked));
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(poll, next);
      }
    };
    void poll();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [peer.id, peer.url, peer.token, route, interval, refresh]);
  return { data, error };
}

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
}) {
  const [moving, setMoving] = useState(false);
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
  return (
    <section className="claw-conversation" aria-label="OpenClaw conversation">
      <header className="claw-thread-head">
        <button
          className="claw-icon"
          aria-label="Back to OpenClaw sessions"
          onClick={onBack}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <h1>{current.title}</h1>
          <span>
            {channelName(current.channel)} · {current.agentId}
            {current.model ? ` · ${current.model}` : ""}
          </span>
        </div>
        <button
          className="claw-icon"
          aria-label="Refresh OpenClaw conversation"
          onClick={reload}
        >
          <RefreshCw size={16} />
        </button>
        {!!deviceRequests && (
          <button
            className="claw-icon"
            aria-label={`Review ${deviceRequests} device requests`}
            onClick={onReviewDevice}
          >
            <ShieldCheck size={18} />
          </button>
        )}
        {current.writable === true && (
          <button
            className={`claw-icon${deleting ? " claw-delete-ask" : ""}`}
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
            {deleting === "busy" ? <Loader2 size={16} className="spin" /> : <Trash2 size={17} />}
          </button>
        )}
        {onOpenChat && (
          <button
            className="claw-icon"
            aria-label="Continue in another app"
            aria-expanded={moving}
            onClick={() => setMoving(!moving)}
          >
            <GitFork size={18} />
          </button>
        )}
      </header>
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
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {!data && !error && (
          <p className="claw-note" role="status">
            Loading conversation…
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
            <p className="claw-note">
              Showing the latest 1,000 messages. Older history is available in
              OpenClaw.
            </p>
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
              <small>
                {item.role === "user"
                  ? "You"
                  : item.role === "assistant"
                    ? "OpenClaw"
                    : "System"}
                {item.sentTo ? ` · sent to ${channelName(item.sentTo)}` : ""}
              </small>
              <AgentMarkdown text={item.text} />
            </article>
          ),
        )}
        {data && !data.items.length && !data.streaming && (
          <p className="claw-note">No messages in this session yet.</p>
        )}
        {data?.streaming && (
          <article className="claw-message from-agent">
            <small>OpenClaw</small>
            <AgentMarkdown text={data.streaming} />
          </article>
        )}
        {working && !error && (
          <p className="claw-note" role="status">
            <Loader2 size={13} className="spin" />
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
              ? `OpenClaw reports the reply was sent to ${channelName(data.delivery.channel)}.`
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
        <div className="claw-composer claw-readonly" role="note">
          <p>
            This chat belongs to {current.title || "another app"}. Reach shows it but
            doesn’t write in it, so nothing reaches{" "}
            {current.channel && current.channel !== "webchat" ? channelName(current.channel) : "it"} from
            here.
          </p>
          {unsettled && current.canStop !== false && (
            <button
              type="button"
              className="claw-icon"
              aria-label="Stop OpenClaw"
              disabled={busy}
              onClick={async () => {
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
              }}
            >
              <Square size={16} />
            </button>
          )}
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
          aria-label="Message OpenClaw"
          placeholder="Continue this conversation…"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <div className="claw-compose-tools">
          <span className="claw-note">Reply in Reach</span>
          {unsettled && current.canStop !== false ? (
            <button
              type="button"
              className="claw-icon"
              aria-label="Stop OpenClaw"
              disabled={busy}
              onClick={async () => {
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
              }}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className={`as-send ${text.trim() ? "ready" : ""}`}
              aria-label="Send to OpenClaw"
              disabled={!text.trim() || busy || unsettled || !!error || !data}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          )}
        </div>
        <small className="claw-delivery-note">
          Continue in Reach and OpenClaw. No reply is forwarded to another app.
        </small>
        {unsettled && current.canStop === false && (
          <small className="claw-delivery-note">
            To stop this channel reply, use OpenClaw on your computer. This
            Gateway does not expose a stop control for it.
          </small>
        )}
      </form>
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
  const { data, error } = usePolling<Overview>(
    peer,
    `${base}/overview`,
    5000,
    refresh,
    `${base}/changes`,
  );
  const [opened, setOpened] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState("");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState("");
  const sessions = data?.sessions || [];
  const found = sessions.filter(
    (s) =>
      (!channel || s.channel === channel) &&
      `${s.title} ${s.agentId} ${s.channel}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const agents = [...new Set(found.map((s) => s.agentId))];
  useEffect(() => {
    const moved = openKey && sessions.find((s) => s.key === openKey);
    if (!moved) return;
    setOpened(moved);
    onOpened?.();
  }, [openKey, sessions, onOpened]);
  if (opened)
    return (
      <Conversation
        key={opened.key}
        peer={peer}
        session={opened}
        onBack={() => {
          setOpened(null);
          setRefresh((n) => n + 1);
        }}
        deviceRequests={deviceRequests}
        onReviewDevice={onReviewDevice}
        logos={logos}
        health={health}
        onOpenChat={onOpenChat}
        onScreen={onScreen}
      />
    );
  return (
    <div className="chat-workspace">
      <div className="chat-library claw-library">
        <header className="chat-list-top">
          <div className="chat-list-heading">
            <h1>Chats</h1>
            <span className="chat-list-device">{peer.name}</span>
          </div>
          <button
            className="claw-icon"
            aria-label="Refresh OpenClaw sessions"
            onClick={() => {
              setRefresh((n) => n + 1);
              onDiscover?.();
            }}
          >
            <RefreshCw size={16} />
          </button>
          {onNew && (
            <button className="chat-create" aria-label="New chat" onClick={onNew}>
              <Plus size={16} />
              <span>New chat</span>
            </button>
          )}
        </header>
        <div className="chat-library-tools">
          <ChatAppPicker
            apps={apps}
            logos={logos}
            value="openclaw"
            onChange={onAppChange}
            pending={{ ...appPending, openclaw: data?.approvals.length || 0 }}
          />
          <label className="chat-list-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="Search OpenClaw sessions"
              placeholder="Search sessions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="claw-library-meta">
          <span>
            {data?.connected
              ? `${sessions.length} sessions · Synced from OpenClaw`
              : "Local OpenClaw"}
          </span>
          {!!deviceRequests && (
            <button className="chat-review-link" onClick={onReviewDevice}>
              <ShieldCheck size={13} />
              {deviceRequests} device{" "}
              {deviceRequests === 1 ? "request" : "requests"}
            </button>
          )}
        </div>
        {(error || data?.error) && (
          <p className="claw-error" role="alert">
            {error || data?.error}
          </p>
        )}
        {data?.canStart && !error && (
          <button
            className="chat-create claw-start"
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              setStartProblem("");
              try {
                await post(peer, `${base}/gateway/start`, {});
                setRefresh((n) => n + 1);
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
        {startProblem && (
          <p className="claw-error" role="alert">
            {startProblem}
          </p>
        )}
        {!data && !error && (
          <p className="claw-note" role="status">
            Finding OpenClaw sessions on {peer.name}…
          </p>
        )}
        {data?.connected && (
          <>
            <div
              className="claw-channels"
              role="group"
              aria-label="Filter by channel"
            >
              {["", ...new Set(sessions.map((s) => s.channel))].map((c) => (
                <button
                  key={c}
                  aria-pressed={channel === c}
                  onClick={() => setChannel(c)}
                >
                  {c ? channelName(c) : "All channels"}
                </button>
              ))}
            </div>
            {!found.length && (
              <p className="claw-note">
                {sessions.length
                  ? "No sessions match these filters."
                  : "No sessions yet. Conversations you start with OpenClaw will appear here automatically."}
              </p>
            )}
            {agents.map((agent) => (
              <section className="chat-group" key={agent}>
                <div className="chat-group-heading">
                  <h2>
                    {agent}
                    <span>
                      {found.filter((s) => s.agentId === agent).length}
                    </span>
                  </h2>
                </div>
                <div className="chat-entries">
                  {found
                    .filter((s) => s.agentId === agent)
                    .map((s) => (
                      <button
                        className="chat-card"
                        key={s.key}
                        onClick={() => setOpened(s)}
                      >
                        <span className="chat-entry-logo">
                          <AgentLogo
                            agent="openclaw"
                            name="OpenClaw"
                            logos={logos}
                            size={20}
                          />
                        </span>
                        <span className="chat-entry-copy">
                          <strong>{s.title}</strong>
                          <span className="chat-entry-context">
                            {channelName(s.channel)}
                            {s.status === "waiting"
                              ? " · Needs you"
                              : s.status === "running"
                                ? " · Working"
                                : ""}
                          </span>
                        </span>
                        <span className="chat-entry-tail">
                          <time className="chat-card-time">
                            {s.updatedAt ? ago(s.updatedAt) : ""}
                          </time>
                          <ChevronRight size={15} />
                        </span>
                      </button>
                    ))}
                </div>
              </section>
            ))}
            <p className="claw-footnote">
              Sessions from every agent on this computer’s current OpenClaw
              Gateway.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
