import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bell,
  Check,
  ChevronRight,
  Loader2,
  Monitor,
  Settings2,
  Sparkles,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import { AgentLogo, useAgentLogos, type AgentLogos } from "./agent-logos";
import { NotificationSetup, useNotificationSetup } from "./NotifySettings";
import {
  shareNotificationIcons,
  takeNotificationIntent,
} from "./notification-bridge";
import ScreenPopup from "./ScreenPopup";
import "./notifications.css";

export type NotificationItem = {
  id: string;
  revision?: string;
  title: string;
  sender?: string;
  icon?: string;
  source?: string;
  kind?: string;
  detail?: string;
  summary?: string;
  createdAt?: number;
  expiresAt?: number;
  prompt?: { command: string; cwd?: string; reason?: string; message?: string };
  actions?: { id: string; label: string; detail?: string; tone?: string }[];
  target: {
    page: string;
    agent?: string;
    id?: string;
    threadId?: string;
    needs?: string;
    prompt?: string;
  };
};
const Notifications = createContext<{
  count: number;
  setup: boolean;
  open: () => void;
  expanded: boolean;
} | null>(null);
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const state = useContext(Notifications);
  if (!state) return null;
  return (
    <button
      className={`notification-bell ${compact ? "compact" : ""}`}
      aria-label={
        state.count
          ? `Notifications, ${state.count} need your attention`
          : "Notifications"
      }
      aria-haspopup="dialog"
      aria-expanded={state.expanded}
      title="Notifications"
      onClick={state.open}
    >
      <Bell size={20} />
      {state.count > 0 ? (
        <span className="notification-count" aria-hidden="true">
          {state.count > 9 ? "9+" : state.count}
        </span>
      ) : state.setup ? (
        <i className="notification-setup-dot" aria-hidden="true" />
      ) : null}
      {!compact && state.setup && !state.count && (
        <span className="notification-bell-label">Get notified</span>
      )}
    </button>
  );
}
const reviewLabel = (item: NotificationItem) =>
  item.target.page === "apps"
    ? "Open app"
    : item.target.page === "screen"
      ? "Open screen"
      : item.kind === "connection"
        ? "Review access"
        : item.kind === "question"
          ? "Open question"
          : "Open request";
export function NotificationCard({
  item,
  logos,
  onOpen,
  onAction,
}: {
  item: NotificationItem;
  logos: AgentLogos;
  onOpen: () => void;
  onAction: (action: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const sending = useRef(false);
  const icon = item.icon || item.target.agent || "agent";
  const sender =
    item.sender ||
    {
      codex: "Codex",
      claude: "Claude",
      gemini: "Gemini",
      openclaw: "OpenClaw",
    }[icon] ||
    "Agent";
  const act = async (action: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(action);
    setError("");
    try {
      await onAction(action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      sending.current = false;
    }
  };
  return (
    <article
      className={`notification-card ${item.kind || "request"}`}
      aria-label={`${sender}: ${item.title}`}
    >
      <button className="notification-row" onClick={onOpen} disabled={!!busy}>
        <span className={`notification-avatar ${icon}`}>
          {icon === "agent" ? (
            <Sparkles size={23} />
          ) : icon === "mac" ? (
            <Monitor size={23} />
          ) : (
            <AgentLogo agent={icon} logos={logos} size={32} name={sender} />
          )}
        </span>
        <span className="notification-heading">
          <span className="notification-sender">
            {sender}
            <span className="notification-kind">
              {item.kind === "connection"
                ? "Connection"
                : item.kind === "question"
                  ? "Question"
                  : item.kind === "handoff"
                    ? "Handoff"
                    : "Needs you"}
            </span>
          </span>
          <strong>{item.title}</strong>
          {item.detail && <small>{item.detail}</small>}
        </span>
        <ChevronRight size={16} />
      </button>
      {item.summary && <p className="notification-summary">{item.summary}</p>}
      {item.prompt && (
        <div className="notification-command">
          <pre>{item.prompt.command}</pre>
          {item.prompt.cwd && <small>In {item.prompt.cwd}</small>}
          {item.prompt.message && <p>{item.prompt.message}</p>}
          {item.prompt.reason && item.prompt.reason !== item.summary && (
            <p>{item.prompt.reason}</p>
          )}
        </div>
      )}
      <div className="notification-actions">
        {item.actions?.map((action) => (
          <button
            key={action.id}
            className={action.tone || ""}
            disabled={!!busy}
            onClick={() => void act(action.id)}
          >
            {busy === action.id ? (
              <>
                <Loader2 size={14} className="spin" /> Sending…
              </>
            ) : (
              <>
                {action.label}
                {action.detail && <small>{action.detail}</small>}
              </>
            )}
          </button>
        ))}
        <button
          className={
            item.actions?.some(
              (action) => action.tone === "primary" || action.tone === "answer",
            )
              ? "notification-open"
              : "primary"
          }
          disabled={!!busy}
          onClick={onOpen}
        >
          {reviewLabel(item)}
          <ChevronRight size={14} />
        </button>
      </div>
      {error && (
        <p className="notification-action-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
export function NotificationCenter({
  peer,
  enabled,
  changes,
  children,
  onOpen,
}: {
  peer: Peer;
  enabled: boolean;
  changes?: string;
  children: ReactNode;
  onOpen: (item: NotificationItem) => void;
}) {
  const setup = useNotificationSetup(peer, enabled);
  const logos = useAgentLogos(enabled ? peer : null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const handlingIntent = useRef(new Set<string>());
  useEffect(() => {
    shareNotificationIcons(logos);
  }, [logos]);
  useEffect(() => {
    setOpen(false);
    setItems([]);
    setError("");
    setLoading(true);
    setNotice("");
  }, [peer.url, peer.token, enabled]);
  const refused = useRef(false);
  const latest = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    refused.current = false;
    let pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending || document.hidden || refused.current) return;
      pending = true;
      try {
        const result = await request<{
          items: NotificationItem[];
          unavailable: string[];
        }>(peer, "/api/notifications", { signal: controller.signal });
        if (!controller.signal.aborted) {
          setItems(result.items || []);
          setError(
            result.unavailable?.some((s) => s !== "openclaw")
              ? "Some apps couldn't be checked. Showing requests we can confirm."
              : "",
          );
        }
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 403) refused.current = true;
        if (!controller.signal.aborted) {
          setItems([]);
          setError(
            refused.current
              ? "This device can't see this computer's requests."
              : "Couldn't check for requests. Reconnect to your computer and try again.",
          );
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    latest.current = () => void refresh();
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const visible = () => void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [peer.url, peer.token, enabled, revision]);
  useEffect(() => {
    if (changes) latest.current();
  }, [changes]);
  useEffect(() => {
    if (!enabled) return;
    const show = () => {
      setOpen(true);
      setRevision((v) => v + 1);
    };
    const intent = async (id: string) => {
      if (
        handlingIntent.current.has(id) ||
        new URL(peer.url).origin !== location.origin
      )
        return;
      handlingIntent.current.add(id);
      const action = await takeNotificationIntent(id).catch(() => null);
      if (!action) return;
      setNotice("Sending your decision…");
      try {
        await post(
          peer,
          `/api/notifications/${encodeURIComponent(action.id)}/actions`,
          { revision: action.revision, action: action.action },
        );
        setNotice("Request denied");
        setItems((items) => items.filter((item) => item.id !== action.id));
        setRevision((value) => value + 1);
      } catch (e) {
        setNotice((e as Error).message);
      }
    };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "reach-notifications") show();
      if (
        event.data?.type === "reach-notification-action" &&
        typeof event.data.intent === "string"
      )
        void intent(event.data.intent);
    };
    navigator.serviceWorker?.addEventListener("message", message);
    const url = new URL(location.href);
    if (url.searchParams.get("notifications") === "1") {
      show();
      url.searchParams.delete("notifications");
      history.replaceState(history.state, "", url);
    }
    const pendingIntent = url.searchParams.get("notificationIntent");
    if (pendingIntent && new URL(peer.url).origin === location.origin) {
      url.searchParams.delete("notificationIntent");
      history.replaceState(history.state, "", url);
      void intent(pendingIntent);
    }
    return () =>
      navigator.serviceWorker?.removeEventListener("message", message);
  }, [enabled, peer.url, peer.token]);
  const act = async (item: NotificationItem, action: string) => {
    if (!item.revision)
      throw Error("Refresh Reach before answering this request.");
    await post(
      peer,
      `/api/notifications/${encodeURIComponent(item.id)}/actions`,
      { revision: item.revision, action },
    );
    setItems((items) => items.filter((value) => value.id !== item.id));
    setNotice(
      action === "deny"
        ? "Request denied"
        : action === "approve"
          ? "Allowed once"
          : "Answer sent",
    );
    setRevision((value) => value + 1);
  };
  return (
    <Notifications.Provider
      value={
        enabled
          ? {
              count: items.length,
              setup:
                !setup.loading && !setup.on && setup.support !== "unsupported",
              expanded: open,
              open: () => {
                setOpen(true);
                setRevision((v) => v + 1);
              },
            }
          : null
      }
    >
      {children}
      {notice && (
        <div className="notification-feedback" role="status">
          {notice}
          <button
            onClick={() => setNotice("")}
            aria-label="Dismiss notification status"
          >
            ×
          </button>
        </div>
      )}
      {open && enabled && (
        <ScreenPopup
          title="Notifications"
          className="notification-center"
          onClose={() => setOpen(false)}
        >
          <div className="notification-inbox-head">
            <span>{peer.name}</span>
            <span>
              {items.length ? `${items.length} to review` : "Up to date"}
            </span>
          </div>
          <div
            className="notification-list"
            aria-label="Needs your attention"
            aria-live="polite"
          >
            {loading ? (
              <p className="notification-empty" role="status">
                Checking for requests…
              </p>
            ) : !items.length && !error ? (
              <div className="notification-empty">
                <Check size={22} />
                <strong>You're all caught up</strong>
                <span>New questions and requests will appear here.</span>
              </div>
            ) : (
              items.map((item) => (
                <NotificationCard
                  key={`${item.id}:${item.revision || ""}`}
                  item={item}
                  logos={logos}
                  onOpen={() => {
                    setOpen(false);
                    onOpen(item);
                  }}
                  onAction={(action) => act(item, action)}
                />
              ))
            )}
            {error && (
              <p className="form-note" role="status">
                {error}{" "}
                <button
                  className="text-button"
                  onClick={() => setRevision((v) => v + 1)}
                >
                  Try again
                </button>
              </p>
            )}
          </div>
          <details
            className="notification-preferences"
            open={!setup.on && !items.length}
          >
            <summary>
              <Settings2 size={16} />
              Notification settings
              <ChevronRight size={15} />
            </summary>
            <NotificationSetup state={setup} />
          </details>
        </ScreenPopup>
      )}
    </Notifications.Provider>
  );
}
