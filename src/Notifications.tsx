import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CircleArrowUp,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Monitor,
  RotateCw,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import { AgentLogo, useAgentLogos, type AgentLogos } from "./agent-logos";
import { NotificationSetup, useNotificationSetup } from "./NotifySettings";
import {
  shareNotificationIcons,
  takeNotificationIntent,
} from "./notification-bridge";
import { holdPage } from "./page-hold";
import type { NeedItem } from "./NeedsYou";
import "./notifications.css";

const settingsSeen = new WeakSet<HTMLDetailsElement>();

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
  peer: Peer;
  apps: Record<string, number>;
  count: number;
  setup: boolean;
  open: (bell?: HTMLElement) => void;
  expanded: boolean;
  items: NotificationItem[];
  act: (item: NotificationItem, action: string) => Promise<void>;
} | null>(null);
// Use the existing inbox scan for background apps, including OpenClaw.
// A chat view for a different computer must never inherit these badges.
export function useAppNotifications(peer: Peer): Record<string, number> {
  const state = useContext(Notifications);
  return state?.peer.id === peer.id &&
    state.peer.url === peer.url && state.peer.token === peer.token
    ? state.apps
    : {};
}
// Requests only the bell knew about (an agent asking to restart Reach), as
// cards in Home's "Needs you", answered right there: a notification's link
// (needs=restart:…) lands on the card itself, not on Home with the bell to find.
export function useBellNeeds(peer: Peer): NeedItem[] {
  const state = useContext(Notifications);
  if (
    !state ||
    state.peer.id !== peer.id ||
    state.peer.url !== peer.url ||
    state.peer.token !== peer.token
  )
    return [];
  return state.items
    .filter((item) => item.source === "restart" || item.source === "update")
    .map((item) => ({
      key: item.id,
      icon: item.source === "update" ? <CircleArrowUp size={22} /> : <RotateCw size={22} />,
      title: item.title,
      detail: [item.sender, item.summary].filter(Boolean).join(" · "),
      actions: (item.actions || []).map((action) => ({
        label: action.label,
        primary: action.tone === "primary",
        completes: true,
        run: () => state.act(item, action.id),
      })),
    }));
}
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
      onClick={(e) => state.open(e.currentTarget)}
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
          : item.source === "restart" && item.target.page === "sessions"
            ? "Open chat"
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
      // The same names as everywhere else in Reach.
      codex: "Codex",
      claude: "Claude Code",
      gemini: "Gemini CLI",
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
                <LoaderCircle size={14} className="spin" /> Sending…
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
// The bell's panel. On a phone it's a page of its own that slides in, with a
// back arrow; on a computer it drops down from the bell. A sheet rising from
// the bottom felt detached from the bell that opened it.
function NotificationPanel({
  anchor,
  onClose,
  children,
}: {
  anchor: DOMRect | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const focus = document.activeElement as HTMLElement | null;
    const letGo = holdPage();
    element?.showModal();
    element?.focus({ preventScroll: true });
    return () => {
      element?.close();
      letGo();
      focus?.focus?.({ preventScroll: true });
    };
  }, []);
  // Under the bell, its right edge lined up with the bell's.
  const place = anchor
    ? ({
        "--bell-top": `${Math.round(anchor.bottom + 6)}px`,
        "--bell-right": `${Math.max(12, Math.round(window.innerWidth - anchor.right))}px`,
      } as CSSProperties)
    : undefined;
  return (
    <dialog
      ref={dialog}
      className="notification-center"
      style={place}
      tabIndex={-1}
      aria-label="Notifications"
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="notification-center-body">
        <header>
          <button
            className="icon-button"
            aria-label="Close notifications"
            onClick={onClose}
          >
            <ChevronLeft size={24} className="notification-back" />
            <X size={18} className="notification-close" />
          </button>
          <h2>Notifications</h2>
        </header>
        {children}
      </div>
    </dialog>
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
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const handlingIntent = useRef(new Set<string>());
  // Decisions can finish after the user switches computers or credentials.
  // Their result belongs only to the context that sent them.
  const requestContext = useMemo(() => ({ active: true }), [peer.url, peer.token, enabled]);
  const currentContext = useRef(requestContext);
  currentContext.current = requestContext;
  const isCurrent = () => enabled && requestContext.active && currentContext.current === requestContext;
  useEffect(() => {
    requestContext.active = true;
    return () => { requestContext.active = false; };
  }, [requestContext]);
  // A list already in flight (or the server's cached list) can still contain
  // a request we just answered. Keep that exact revision dismissed.
  const answered = useRef(new Set<string>());
  const rememberAnswer = (id: string, revision: string) => {
    answered.current.add(`${id}:${revision}`);
    if (answered.current.size > 200) answered.current.delete(answered.current.values().next().value!);
    setItems((items) => items.filter((item) => item.id !== id || item.revision !== revision));
  };
  useEffect(() => {
    shareNotificationIcons(logos);
  }, [logos]);
  useEffect(() => {
    setOpen(false);
    answered.current.clear();
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
          setItems((result.items || []).filter((item) => !answered.current.has(`${item.id}:${item.revision}`)));
          setError(
            result.unavailable?.some((s) => s !== "openclaw")
              ? "Some apps couldn't be checked. Showing requests we can confirm."
              : "",
          );
        }
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (!controller.signal.aborted) {
          if (status === 401 || status === 403) refused.current = true;
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
    // `changes` brings news at once (the chats waiting on you included):
    // the timer is only a slow fallback.
    const timer = setInterval(() => void refresh(), 30000);
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
      setAnchor(null);
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
      if (!action || !isCurrent()) return;
      setNotice("Sending your decision…");
      try {
        await post(
          peer,
          `/api/notifications/${encodeURIComponent(action.id)}/actions`,
          { revision: action.revision, action: action.action },
        );
        if (!isCurrent()) return;
        setNotice("Request denied");
        rememberAnswer(action.id, action.revision);
        setRevision((value) => value + 1);
      } catch (e) {
        if (!isCurrent()) return;
        setNotice((e as Error).message);
        if ((e as { status?: number }).status === 409) latest.current();
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
    if (!isCurrent()) return;
    if (!item.revision)
      throw Error("Refresh Reach before answering this request.");
    try {
      await post(
        peer,
        `/api/notifications/${encodeURIComponent(item.id)}/actions`,
        { revision: item.revision, action },
      );
    } catch (e) {
      if (!isCurrent()) return;
      // Answered elsewhere or changed since: look again now, so the card
      // shows what's true (or goes) instead of waiting for the next check.
      if ((e as { status?: number }).status === 409) latest.current();
      throw e;
    }
    if (!isCurrent()) return;
    rememberAnswer(item.id, item.revision);
    setNotice(
      item.source === "update" && action === "update"
        ? "Updating Reach. It restarts when it's installed"
        : item.source === "restart" && action !== "deny"
        ? action === "after"
          ? "Reach restarts when the chats finish"
          : "Reach is restarting"
        : action === "deny" && item.source === "update"
        ? "Not now"
        : action === "deny"
        ? "Request denied"
        : action === "approve"
          ? "Allowed once"
          : "Answer sent",
    );
    setRevision((value) => value + 1);
  };
  const apps: Record<string, number> = {};
  for (const item of items) {
    const app = item.target.agent || (item.source === "handoff" ? item.icon : item.source);
    if (app && ["codex", "claude", "gemini", "openclaw"].includes(app))
      apps[app] = (apps[app] || 0) + 1;
  }
  return (
    <Notifications.Provider
      value={
        enabled
          ? {
              peer,
              apps,
              count: items.length,
              setup:
                !setup.loading && !setup.on && setup.support !== "unsupported",
              expanded: open,
              items,
              act,
              open: (bell) => {
                setAnchor(bell?.getBoundingClientRect() || null);
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
        <NotificationPanel anchor={anchor} onClose={() => setOpen(false)}>
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
            // Opened once on first render; after that it's the user's.
            ref={(el) => {
              if (el && !settingsSeen.has(el)) {
                settingsSeen.add(el);
                el.open = !setup.on && !items.length;
              }
            }}
          >
            <summary>
              <Settings2 size={16} />
              Notification settings
              <ChevronRight size={15} />
            </summary>
            <NotificationSetup state={setup} />
          </details>
        </NotificationPanel>
      )}
    </Notifications.Provider>
  );
}
