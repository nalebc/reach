import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Bot,
  CalendarClock,
  MessageSquare,
  MoreHorizontal,
  Settings2,
  Radio,
  X,
  GitFork,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { request, post, type Peer } from "./api";
import {
  ChatAppPicker,
  ChatLibraryHeader,
  ago,
  type ChatAppChoice,
} from "./ChatList";
import { ClawSessionSettings } from "./OpenClawControls";
import { AddChannelForm, OpenSetup, ScheduleForm, WhatsAppLink } from "./OpenClawSetup";
import { useViewportBox } from "./useViewportBox";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import AgentMarkdown from "./AgentMarkdown";
import { NeedsYouStrip, type NeedItem } from "./NeedsYou";
import { MoveOffer } from "./MoveChat";
import type { AgentHealth, AgentSession } from "./agent-sessions";
import { BrandCourier } from "./ReachIdentity";
import { ClawChatCost, ClawSpendPill } from "./OpenClawSpend";
import { ClawHealthPill } from "./OpenClawHealth";
import { ClawScheduleMore } from "./OpenClawScheduleMore";
import { ClawAgentsPanel } from "./OpenClawAgents";
import { ClawSkills } from "./OpenClawSkills";
import { ClawOnboard } from "./OpenClawOnboard";
import "./openclaw.css";

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
  return (
    <section
      ref={surface}
      className="claw-conversation"
      aria-label="OpenClaw conversation"
    >
      <header className="claw-thread-head">
        <button
          className="claw-icon"
          aria-label="Back to OpenClaw sessions"
          onClick={onBack}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <button
            className="claw-thread-title"
            aria-label="Choose an app, OpenClaw selected"
            aria-expanded={appMenuOpen}
            onClick={() => setAppMenuOpen(!appMenuOpen)}
          >
            <div>
              <h1>{current.title}</h1>
              <span>
                {channelName(current.channel)} · {current.agentId}
                {current.model ? ` · ${current.model}` : ""}
              </span>
            </div>
            <ChevronDown size={15} />
          </button>
          <ClawChatCost peer={peer} sessionKey={current.key} refresh={current.updatedAt} />
        </div>
        {current.writable === true && (
          <button
            className="claw-icon"
            aria-label="OpenClaw chat settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings2 size={18} />
          </button>
        )}
        <details className="claw-thread-actions" ref={threadActions}>
          <summary className="claw-icon" aria-label="OpenClaw conversation actions"><MoreHorizontal size={20} /></summary>
          <div className="claw-thread-menu">
        <button
          className="claw-icon"
          aria-label="Refresh OpenClaw conversation"
          onClick={() => { if (threadActions.current) threadActions.current.open = false; reload(); }}
        >
          <RefreshCw size={16} />
          Refresh chat
        </button>
        {!!deviceRequests && (
          <button
            className="claw-icon"
            aria-label={`Review ${deviceRequests} device requests`}
            onClick={() => { if (threadActions.current) threadActions.current.open = false; onReviewDevice(); }}
          >
            <ShieldCheck size={18} />
            Review device requests
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
            {deleting ? "Tap again to delete" : "Delete chat"}
          </button>
        )}
        {onOpenChat && (
          <button
            className="claw-icon"
            aria-label="Continue in another app"
            aria-expanded={moving}
            onClick={() => { if (threadActions.current) threadActions.current.open = false; setMoving(!moving); }}
          >
            <GitFork size={18} />
            Continue in another app
          </button>
        )}
          </div>
        </details>
      </header>
      {appMenuOpen && (
        <div className="claw-app-switch">
          <ChatAppPicker
            apps={apps}
            logos={logos}
            value="openclaw"
            onChange={onAppChange}
          />
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

type ScheduledJob = {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: string;
  nextRunAt: number;
  lastRunAt: number;
  status: string;
  error: string;
  delivery: string;
};
type ChannelAccount = {
  channel: string;
  accountId: string;
  name: string;
  status: string;
  error: string;
};
const scheduleTime = (ms: number) =>
  new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function ClawWorkspacePanel({
  peer,
  view,
  query,
  refresh,
}: {
  peer: Peer;
  view: "automations" | "channels";
  query: string;
  refresh: number;
}) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [query]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState("");
  const [linking, setLinking] = useState<"" | "link" | "relink">("");
  const [addingChannel, setAddingChannel] = useState(false);
  const [ran, setRan] = useState("");
  useEffect(() => {
    if (!removing) return;
    const timer = setTimeout(() => setRemoving(""), 4000);
    return () => clearTimeout(timer);
  }, [removing]);
  const act = async (id: string, path: string, body: object) => {
    if (busy) return false;
    setBusy(id);
    setProblem("");
    try {
      await post(peer, `${base}/${path}`, body);
      setRevision((n) => n + 1);
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  };
  const { data, error } = usePolling<{
    jobs?: ScheduledJob[];
    channels?: ChannelAccount[];
    canEdit?: boolean;
    canAdd?: boolean;
    canRun?: boolean;
    canRemove?: boolean;
    canLinkWhatsApp?: boolean;
    hasMore?: boolean;
    nextOffset?: number;
    version?: string;
  }>(
    peer,
    `${base}/${view}${view === "automations" ? `?${new URLSearchParams({ offset: String(offset), query })}` : ""}`,
    10000,
    refresh + revision,
  );
  const matches = (value: string) =>
    value.toLowerCase().includes(query.trim().toLowerCase());
  const channels = (data?.channels || []).filter((c) =>
    matches(`${c.channel} ${c.name} ${c.status}`),
  );
  const jobs = data?.jobs || [];
  const whatsapp = (data?.channels || []).find((c) => c.channel === "whatsapp");
  const refreshChannels = async () => {
    if (busy) return;
    setBusy("refresh");
    setProblem("");
    try {
      await request(peer, `${base}/channels?refresh=1`);
      setRevision((n) => n + 1);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section
      className="claw-panel"
      aria-label={
        view === "automations"
          ? "OpenClaw schedules"
          : "OpenClaw channel health"
      }
    >
      <div className="claw-panel-heading">
        <h2>
          {view === "automations" ? "Scheduled jobs" : "Connected channels"}
        </h2>
        <p>
          {view === "automations"
            ? "Upcoming runs of your OpenClaw schedules. Add, run, pause or delete them here."
            : "Connection status for the messaging apps in your Gateway."}
        </p>
        <div className="claw-panel-actions">
          {view === "automations" && data?.canAdd && !adding && jobs.length > 0 && (
            <button className="claw-secondary" onClick={() => setAdding(true)}>
              New schedule
            </button>
          )}
          {view === "channels" && (
            <button
              className="claw-secondary"
              aria-label="Refresh channel status"
              disabled={!!busy}
              onClick={() => void refreshChannels()}
            >
              {busy === "refresh" ? <Loader2 size={14} className="spin" /> : null}
              Refresh
            </button>
          )}
        </div>
      </div>
      {view === "automations" && adding && (
        <ScheduleForm
          peer={peer}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {view === "channels" && linking && (
        <WhatsAppLink
          peer={peer}
          relink={linking === "relink"}
          onCancel={() => setLinking("")}
          onDone={() => setRevision((n) => n + 1)}
        />
      )}
      {(error || problem) && (
        <p className="claw-error" role="alert">
          {error || problem}
        </p>
      )}
      {!data && !error && (
        <p className="claw-note" role="status">
          <Loader2 size={14} className="spin" />
          Loading {view === "automations" ? "schedules" : "channels"}…
        </p>
      )}
      {data && (view === "automations" ? !jobs.length : !channels.length) && (
        query ? (
          <p className="claw-empty">No matches. Try another search.</p>
        ) : view === "automations" ? (
          !adding && (
            <div className="claw-missing">
              <p>No schedules yet. Have OpenClaw do something at set times: a morning briefing, a weekly report.</p>
              {data.canAdd && (
                <button className="claw-primary" onClick={() => setAdding(true)}>
                  Add a schedule
                </button>
              )}
            </div>
          )
        ) : (
          <div className="claw-missing">
            <p>No messaging apps connected yet. Connect one so OpenClaw can answer you there.</p>
          </div>
        )
      )}
      {view === "channels" && data && !query && !linking && (
        <div className="claw-missing">
          {data.canLinkWhatsApp && (!whatsapp || whatsapp.status === "unconfigured") && (
            <>
              <p>WhatsApp isn't linked. Link it with a QR from OpenClaw.</p>
              <button className="claw-primary" onClick={() => setLinking("link")}>
                Connect WhatsApp
              </button>
            </>
          )}
          {addingChannel ? (
            <AddChannelForm
              peer={peer}
              onCancel={() => setAddingChannel(false)}
              onAdded={() => {
                setAddingChannel(false);
                setRevision((n) => n + 1);
              }}
            />
          ) : (
            <>
              <p className="claw-note">Add Telegram, Discord or Slack with its bot token.</p>
              <button className="claw-secondary" onClick={() => setAddingChannel(true)}>
                Add a messaging app
              </button>
              <p className="claw-note">Signal, Matrix, iMessage and others are set up in OpenClaw's own setup.</p>
              <OpenSetup peer={peer} section="channels">
                Other apps
              </OpenSetup>
            </>
          )}
        </div>
      )}
      {view === "channels"
        ? channels.map((c) => (
            <article
              className="claw-detail-card"
              key={`${c.channel}:${c.accountId}`}
            >
              <div className="claw-card-top">
                <strong>{channelName(c.channel)}</strong>
                <span className={`claw-badge ${c.status}`}>
                  <span className={`claw-status-dot ${c.status}`} />
                  {c.status[0].toUpperCase() + c.status.slice(1)}
                </span>
              </div>
              <p>{c.name}</p>
              {c.error && <p className="claw-error">{c.error}</p>}
              {c.channel === "whatsapp" && data?.canLinkWhatsApp && ["disconnected", "unknown"].includes(c.status) && !linking && (
                <button className="claw-secondary" onClick={() => setLinking("relink")}>
                  Link again with a new QR
                </button>
              )}
            </article>
          ))
        : jobs.map((job) => (
            <article className="claw-detail-card" key={job.id}>
              <div className="claw-card-top">
                <strong>{job.name}</strong>
                <span
                  className={`claw-badge ${job.status === "error" ? "error" : job.enabled ? "connected" : "disabled"}`}
                >
                  {job.status === "running"
                    ? "Running"
                    : job.enabled
                      ? "Enabled"
                      : "Paused"}
                </span>
              </div>
              <p>
                {job.agentId} · {job.schedule}
              </p>
              <dl className="claw-job-facts">
                {job.enabled && !!job.nextRunAt && (
                  <>
                    <dt>Next run</dt>
                    <dd>{scheduleTime(job.nextRunAt)}</dd>
                  </>
                )}
                {!!job.lastRunAt && (
                  <>
                    <dt>Last run</dt>
                    <dd>
                      {scheduleTime(job.lastRunAt)} ·{" "}
                      {job.status === "ok" ? "Completed" : job.status}
                    </dd>
                  </>
                )}
                <dt>Delivery</dt>
                <dd>{channelName(job.delivery)}</dd>
              </dl>
              {/* A failure in the last day shows in ClawScheduleMore instead. */}
              {job.error &&
                !(job.status === "error" && Date.now() - job.lastRunAt < 86400000) && (
                  <p className="claw-error">{job.error}</p>
                )}
              <ClawScheduleMore
                peer={peer}
                job={job}
                canEdit={!!data?.canEdit}
                onChanged={() => setRevision((n) => n + 1)}
              />
              {data?.canEdit && (
                <button
                  className="claw-secondary"
                  aria-label={`${job.enabled ? "Pause" : "Resume"} ${job.name}`}
                  disabled={!!busy}
                  onClick={async () => {
                    if (busy) return;
                    setBusy(job.id);
                    setProblem("");
                    try {
                      await post(peer, `${base}/automations`, {
                        id: job.id,
                        enabled: !job.enabled,
                      });
                      setRevision((n) => n + 1);
                    } catch (e) {
                      setProblem((e as Error).message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  {busy === job.id ? (
                    <Loader2 size={14} className="spin" />
                  ) : null}
                  {job.enabled ? "Pause schedule" : "Resume schedule"}
                </button>
              )}
              <div className="claw-job-actions">
                {data?.canRun && (
                  <button
                    className="claw-secondary"
                    aria-label={`Run ${job.name} now`}
                    disabled={!!busy || job.status === "running"}
                    onClick={async () => {
                      if (await act(`run:${job.id}`, "automations/run", { id: job.id })) setRan(job.id);
                    }}
                  >
                    {busy === `run:${job.id}` ? <Loader2 size={14} className="spin" /> : null}
                    {ran === job.id ? "Started" : "Run now"}
                  </button>
                )}
                {data?.canRemove && (
                  <button
                    className={`claw-secondary${removing === job.id ? " claw-delete-ask" : ""}`}
                    aria-label={removing === job.id ? `Tap again to delete ${job.name}` : `Delete ${job.name}`}
                    disabled={!!busy}
                    onClick={async () => {
                      if (removing !== job.id) return setRemoving(job.id);
                      setRemoving("");
                      await act(`remove:${job.id}`, "automations/remove", { id: job.id });
                    }}
                  >
                    {busy === `remove:${job.id}` ? <Loader2 size={14} className="spin" /> : null}
                    {removing === job.id ? "Tap again to delete" : "Delete"}
                  </button>
                )}
              </div>
            </article>
          ))}
      {view === "automations" && (offset > 0 || data?.hasMore) && (
        <div className="claw-settings-actions">
          <button
            className="claw-secondary"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <button
            className="claw-secondary"
            disabled={!data?.hasMore}
            onClick={() => setOffset(data?.nextOffset || offset + 50)}
          >
            Next schedules
          </button>
        </div>
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
  const [searchOpen, setSearchOpen] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);
  const [view, setView] = useState<"chats" | "agents" | "automations" | "channels">(
    "chats",
  );
  const [channel, setChannel] = useState("");
  const sessions = data?.sessions || [];
  const found = sessions.filter(
    (s) =>
      (!channel || s.channel === channel) &&
      `${s.title} ${s.agentId} ${s.channel} ${s.model}`
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
        apps={apps}
        onAppChange={onAppChange}
      />
    );
  return (
    <div className="chat-workspace">
      <div
        className={`chat-library claw-library ${searchOpen ? "search-open" : ""}`}
      >
        <ChatLibraryHeader
          peer={peer}
          apps={apps}
          logos={logos}
          value="openclaw"
          pending={{ ...appPending, openclaw: Math.max(appPending.openclaw || 0, data?.approvals.length || 0) }}
          onChange={onAppChange}
          onNew={onNew}
          onRefresh={() => {
            setRefresh((n) => n + 1);
            onDiscover?.();
          }}
          searchOpen={searchOpen}
          onSearch={() => {
            if (searchOpen) setQuery("");
            setSearchOpen(!searchOpen);
          }}
        />
        <div className="chat-library-tools">
          <ChatAppPicker
            apps={apps}
            logos={logos}
            value="openclaw"
            onChange={onAppChange}
            pending={{ ...appPending, openclaw: Math.max(appPending.openclaw || 0, data?.approvals.length || 0) }}
          />
          <label className="chat-list-search">
            <Search size={16} />
            <input
              ref={searchField}
              type="search"
              aria-label="Search OpenClaw sessions"
              placeholder={
                view === "chats"
                  ? "Search chats"
                  : view === "agents"
                    ? "Search agents and skills"
                    : view === "automations"
                    ? "Search schedules"
                    : "Search channels"
              }
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
        <div className="claw-tabs" role="group" aria-label="OpenClaw workspace">
          {(
            [
              ["chats", MessageSquare, "Chats"],
              ["agents", Bot, "Agents"],
              ["automations", CalendarClock, "Schedules"],
              ["channels", Radio, "Channels"],
            ] as const
          ).map(([value, Icon, label]) => (
            <button
              key={value}
              aria-pressed={view === value}
                onClick={() => { setView(value); setQuery(""); setSearchOpen(false); }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        <div className="claw-library-meta">
          <span className="claw-sync-status">
            <span
              className={`claw-status-dot ${data?.connected ? "connected" : ""}`}
            />
            {!data ? "Connecting to Gateway…" : data.connected
              ? `${sessions.length} chats · Gateway connected`
              : "Gateway offline"}
          </span>
          {/* Installed, even stopped: Restart and Doctor matter most then. */}
          {(data?.connected || data?.canStart) && (
            <ClawHealthPill peer={peer} refresh={refresh} onChanged={() => setRefresh((n) => n + 1)} />
          )}
          {data?.connected && <ClawSpendPill peer={peer} refresh={refresh} />}
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
        {data && !data.connected && !data.canStart && (
          <ClawOnboard peer={peer} onDone={() => setRefresh((n) => n + 1)} />
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
        {data?.connected && view === "agents" && (
          <>
            <ClawAgentsPanel peer={peer} query={query} refresh={refresh} />
            <ClawSkills peer={peer} query={query} refresh={refresh} />
          </>
        )}
        {data?.connected && view !== "chats" && view !== "agents" && (
          <ClawWorkspacePanel
            key={view}
            peer={peer}
            view={view}
            query={query}
            refresh={refresh}
          />
        )}
        {data?.connected && view === "chats" && (
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
              sessions.length ? (
                <p className="claw-note">No sessions match these filters.</p>
              ) : (
                <div className="chat-list-empty">
                  <span className="chat-welcome-mascot" aria-hidden="true"><BrandCourier active /></span>
                  <strong>Room for your next idea</strong>
                  <p>Start an OpenClaw chat. Your conversations will appear here automatically.</p>
                </div>
              )
            )}
            {agents.map((agent) => (
              <section className="chat-group chat-project-group" key={agent}>
                <div className="chat-group-heading">
                  <h2>
                    <Bot size={18} />
                    {agent === "main" ? "Main agent" : agent}
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
                        className={`chat-card ${s.status}`}
                        key={s.key}
                        onClick={() => setOpened(s)}
                      >
                        <span className="chat-entry-logo" title="OpenClaw">
                          <AgentLogo
                            agent="openclaw"
                            name="OpenClaw"
                            logos={logos}
                            size={18}
                          />
                        </span>
                        <span className="chat-entry-copy">
                          <strong>{s.title}</strong>
                          <span className="chat-card-preview claw-chat-context">
                            {channelName(s.channel)}
                            {s.writable ? " · Reach chat" : " · Read only"}
                          </span>
                        </span>
                        <span className="chat-entry-tail">
                          {s.status === "running" ? (
                            <Loader2
                              size={16}
                              className="chat-row-status spin"
                              aria-label="Working"
                            />
                          ) : s.status === "waiting" ? (
                            <span
                              className="chat-row-status waiting"
                              aria-label="Needs you"
                            >
                              <span className="chat-state-dot" />
                            </span>
                          ) : null}
                          <time
                            className="chat-card-time"
                            dateTime={s.updatedAt ? new Date(s.updatedAt).toISOString() : undefined}
                            title={s.updatedAt ? `Updated ${new Date(s.updatedAt).toLocaleString()}` : undefined}
                          >
                            {s.updatedAt ? ago(s.updatedAt) : ""}
                          </time>
                        </span>
                      </button>
                    ))}
                </div>
              </section>
            ))}
          </>
        )}
        {onNew && view === "chats" && (
          <button
            className="chat-quick-new"
            aria-label="New OpenClaw chat"
            onClick={onNew}
          >
            <span className="chat-compose-mascot" aria-hidden="true"><BrandCourier active /></span>
            <span className="chat-quick-label">Ask OpenClaw anything</span>
            <span className="chat-quick-arrow">
              <ArrowUp size={18} />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
