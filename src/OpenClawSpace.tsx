import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  GitFork,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
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
  canDeliver?: boolean;
};
type Approval = {
  id: string;
  sessionKey?: string;
  command: string;
  cwd: string;
  expiresAt: number;
};
type Overview = {
  connected: boolean;
  sessions: Session[];
  approvals: Approval[];
  error?: string;
};
type History = {
  session: Session;
  items: { id: string; role: string; text: string; tool: boolean }[];
  streaming: string;
  error: string;
  approvals: Approval[];
  mayHaveOlder: boolean;
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
function usePolling<T>(
  peer: Peer,
  route: string,
  interval: number,
  refresh: number,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        if (!document.hidden) {
          const result = await request<T>(peer, route, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          });
          if (active) {
            setData(result);
            setError("");
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(poll, interval);
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
): NeedItem[] {
  return prompts.map((prompt) => ({
    key: prompt.id,
    icon: <ShieldCheck size={18} />,
    title: "OpenClaw needs permission",
    detail: [prompt.command, prompt.cwd].filter(Boolean).join(" · "),
    actions: [
      { label: "Deny", decision: "deny" },
      { label: "Allow once", decision: "allow-once" },
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
}) {
  const [moving, setMoving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [limit, setLimit] = useState(200);
  const { data, error } = usePolling<History>(
    peer,
    `${base}/history?${new URLSearchParams({ key: session.key, limit: String(limit) })}`,
    1800,
    refresh,
  );
  const draftKey = `reach.openclaw.draft:${peer.id}:${session.key}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  const [deliver, setDeliver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const sending = useRef(false);
  const attempt = useRef<{ text: string; deliver: boolean; id: string } | null>(
    null,
  );
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const current = data?.session || session;
  const working = current.status === "running";
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
    if (!text.trim() || sending.current || working || error) return;
    sending.current = true;
    setBusy(true);
    setProblem("");
    const message = text;
    // A failed/uncertain response can be retried without starting a second run.
    if (
      !attempt.current ||
      attempt.current.text !== message ||
      attempt.current.deliver !== deliver
    )
      attempt.current = { text: message, deliver, id: crypto.randomUUID() };
    try {
      await post(peer, `${base}/send`, {
        key: session.key,
        text: message,
        deliver,
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
        {!!deviceRequests && (
          <button
            className="claw-icon"
            aria-label={`Review ${deviceRequests} device requests`}
            onClick={onReviewDevice}
          >
            <ShieldCheck size={18} />
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
        {working && (
          <p className="claw-note" role="status">
            <Loader2 size={13} className="spin" /> OpenClaw is working…
          </p>
        )}
      </div>
      {!!data?.approvals.length && (
        <NeedsYouStrip items={approvalItems(peer, data.approvals, reload)} />
      )}
      {(error || problem || data?.error) && (
        <p className="claw-error" role="alert">
          {error || problem || data?.error}
        </p>
      )}
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
          {current.canDeliver ? (
            <label className="claw-destination">
              <select
                aria-label="Reply destination"
                value={deliver ? "channel" : "reach"}
                disabled={busy}
                onChange={(e) => setDeliver(e.target.value === "channel")}
              >
                <option value="reach">Reply in Reach</option>
                <option value="channel">
                  Reply via {channelName(current.channel)}
                </option>
              </select>
            </label>
          ) : (
            <span className="claw-note">Reply in Reach</span>
          )}
          {working ? (
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
              className="as-send"
              aria-label="Send to OpenClaw"
              disabled={!text.trim() || busy || !!error || !data}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          )}
        </div>
        {deliver && (
          <small className="claw-delivery-note">
            OpenClaw’s reply will also be sent to this session’s{" "}
            {channelName(current.channel)} conversation.
          </small>
        )}
      </form>
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
}) {
  const [refresh, setRefresh] = useState(0);
  const { data, error } = usePolling<Overview>(
    peer,
    `${base}/overview`,
    5000,
    refresh,
  );
  const [opened, setOpened] = useState<Session | null>(null);
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
            onClick={() => { setRefresh((n) => n + 1); onDiscover?.(); }}
          >
            <RefreshCw size={16} />
          </button>
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
