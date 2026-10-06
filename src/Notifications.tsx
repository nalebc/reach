import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  Bell,
  Check,
  ChevronRight,
  MessageSquare,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import { request, type Peer } from "./api";
import { NotificationSetup, useNotificationSetup } from "./NotifySettings";
import ScreenPopup from "./ScreenPopup";
import "./notifications.css";

export type NotificationItem = {
  id: string;
  title: string;
  detail?: string;
  target: { page: string; agent?: string; id?: string; threadId?: string; needs?: string };
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

export function NotificationCenter({
  peer,
  enabled,
  children,
  onOpen,
}: {
  peer: Peer;
  enabled: boolean;
  children: ReactNode;
  onOpen: (item: NotificationItem) => void;
}) {
  const setup = useNotificationSetup(peer, enabled);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setOpen(false);
    setItems([]);
    setError("");
    setLoading(true);
  }, [peer.url, peer.token, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending || document.hidden) return;
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
      } catch {
        if (!controller.signal.aborted) {
          setItems([]);
          setError(
            "Couldn't check for requests. Reconnect to your computer and try again.",
          );
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
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
    if (!enabled) return;
    const show = () => {
      setOpen(true);
      setRevision((v) => v + 1);
    };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "reach-notifications") show();
    };
    navigator.serviceWorker?.addEventListener("message", message);
    const url = new URL(location.href);
    if (url.searchParams.get("notifications") === "1") {
      show();
      url.searchParams.delete("notifications");
      history.replaceState(history.state, "", url);
    }
    return () =>
      navigator.serviceWorker?.removeEventListener("message", message);
  }, [enabled, peer.url]);
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
      {open && enabled && (
        <ScreenPopup
          title="Notifications"
          className="notification-center"
          onClose={() => setOpen(false)}
        >
          <p className="notification-computer">{peer.name}</p>
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
              items.map((item) => {
                const Icon =
                  item.target.page === "sessions"
                    ? MessageSquare
                    : item.target.page === "screen"
                      ? Monitor
                      : ShieldCheck;
                return (
                  <button
                    className="notification-row"
                    key={item.id}
                    onClick={() => {
                      setOpen(false);
                      onOpen(item);
                    }}
                  >
                    <Icon size={20} />
                    <span>
                      <strong>{item.title}</strong>
                      {item.detail && <small>{item.detail}</small>}
                    </span>
                    <ChevronRight size={17} />
                  </button>
                );
              })
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
          <NotificationSetup state={setup} />
        </ScreenPopup>
      )}
    </Notifications.Provider>
  );
}
