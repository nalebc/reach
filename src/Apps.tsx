import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Loader2, Monitor, Search, X } from "lucide-react";
import { post, request, type Device, type Peer } from "./api";
import { Empty, ErrorLine, PageTitle } from "./ui";
import AppLogo from "./AppLogo";
import {
  forgetSnapshot,
  openThread,
  quitThread,
  returnThread,
  snapshotOf,
  useAppThreads,
  type AppThread,
} from "./app-threads";
import { pausedIn } from "./pause";
import "./apps.css";

// Loaded when an app is first opened on the phone; the grid stays light.
const AppThreadView = lazy(() => import("./AppThread"));

type App = { id: string; name: string };

// The app list and recent launches are remembered per computer, so the grid
// is on screen immediately and only refreshed in the background.
const stored = <T,>(key: string, fallback: T): T => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const isApps = (value: unknown): value is App[] =>
  Array.isArray(value) &&
  value.every((a) => typeof a?.id === "string" && typeof a?.name === "string");

export default function Apps({
  peer,
  device,
  toast,
  screen,
  changes,
}: {
  peer: Peer;
  device: Device;
  toast: (s: string) => void;
  screen?: () => void;
  // The computer's change fingerprints: app threads refresh when theirs moves.
  changes?: string;
}) {
  const computer = peer.computerId || peer.id;
  const listKey = `reach.apps.${computer}`,
    recentKey = `reach.apps.recent.${computer}`;
  const [apps, setApps] = useState<App[]>(() => {
      const cached = stored<unknown>(listKey, []);
      return isApps(cached) ? cached : [];
    }),
    [recent, setRecent] = useState<string[]>(() =>
      stored<string[]>(recentKey, []).filter((id) => typeof id === "string"),
    ),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(!apps.length),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<App[]>(peer, "/api/apps")
      .then((list) => {
        if (!active || !isApps(list)) return;
        setApps(list);
        store(listKey, list);
        setError("");
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [peer.url, peer.token, listKey]);
  // On a Mac with screen viewing on, apps open on the phone, each in its own
  // hidden, phone-shaped display. Elsewhere they open on the computer.
  const onPhone = !!screen && device.platform === "darwin";
  // Paused on the Mac: apps wait there and come back on Resume.
  const paused = pausedIn(changes, device);
  const owner =
    !device.access ||
    (device.access.scopes.includes("admin") && device.access.kind !== "guest");
  const {
    threads,
    refresh: refreshThreads,
    upsert,
    remove,
  } = useAppThreads(peer, onPhone, changes);
  const [openId, setOpenId] = useState<string | null>(null);
  // Swiping a card up quits its app, like the iPhone's app switcher.
  const [lift, setLift] = useState<{ id: string; dy: number } | null>(null);
  const [confirmQuit, setConfirmQuit] = useState<{
    id: string;
    others: number;
  } | null>(null);
  const swipe = useRef<{ id: string; y: number; moved: boolean } | null>(null);
  const current = threads.find((t) => t.id === openId);
  const remember = (app: App) => {
    const next = [app.id, ...recent.filter((id) => id !== app.id)].slice(0, 8);
    setRecent(next);
    store(recentKey, next);
  };
  const launch = async (app: App) => {
    if (busy) return;
    setBusy(app.id);
    try {
      const thread = await openThread(peer, app.id);
      upsert(thread);
      setOpenId(thread.id);
      remember(app);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const resume = async (thread: AppThread) => {
    if (thread.state === "running" || thread.held || paused)
      return setOpenId(thread.id);
    const app = apps.find((a) => a.id === thread.appId) || {
      id: thread.appId,
      name: thread.name,
    };
    await launch(app);
  };
  const quitted = (thread: AppThread) => {
    setOpenId((id) => (id === thread.id ? null : id));
    remove(thread.id);
    forgetSnapshot(thread.id);
    toast(`${thread.name} quit`);
  };
  const quitApp = async (thread: AppThread, confirm = false) => {
    try {
      const result = await quitThread(peer, thread.id, confirm);
      if ("confirm" in result) {
        setConfirmQuit({ id: thread.id, others: result.others });
        return;
      }
      setConfirmQuit(null);
      if (result.waiting)
        toast(
          `${thread.name} is asking something before it quits. Open it to answer.`,
        );
      else quitted(thread);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const card = (t: AppThread) => ({
    onPointerDown: (e: React.PointerEvent) => {
      swipe.current = { id: t.id, y: e.clientY, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = swipe.current;
      if (!s || s.id !== t.id) return;
      const dy = Math.min(0, e.clientY - s.y);
      if (dy < -8) s.moved = true;
      if (s.moved) setLift({ id: t.id, dy });
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = swipe.current;
      if (!s || s.id !== t.id) return;
      setLift(null);
      if (e.clientY - s.y < -70) void quitApp(t);
    },
    onPointerCancel: () => {
      swipe.current = null;
      setLift(null);
    },
    onClick: () => {
      const s = swipe.current;
      swipe.current = null;
      if (!s?.moved) void resume(t);
    },
  });
  const giveBack = async (thread: AppThread) => {
    setOpenId(null);
    try {
      await returnThread(peer, thread.id);
      remove(thread.id);
      forgetSnapshot(thread.id);
      toast(`${thread.name} is back on ${device.name}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  // Touch and hold an app: open it on the computer only.
  const held = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    fired: boolean;
  }>({
    fired: false,
  });
  const press = (app: App) =>
    onPhone
      ? {
          onPointerDown: () => {
            held.current.fired = false;
            clearTimeout(held.current.timer);
            held.current.timer = setTimeout(() => {
              held.current.fired = true;
              void open(app);
            }, 550);
          },
          onPointerUp: () => clearTimeout(held.current.timer),
          onPointerLeave: () => clearTimeout(held.current.timer),
          onPointerCancel: () => clearTimeout(held.current.timer),
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        }
      : {};
  const tap = (app: App) => {
    if (held.current.fired) {
      held.current.fired = false;
      return;
    }
    void (onPhone ? launch(app) : open(app));
  };
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? apps
            .filter((a) => a.name.toLowerCase().includes(needle))
            // Names that start with the search come first.
            .sort(
              (a, b) =>
                +!a.name.toLowerCase().startsWith(needle) -
                +!b.name.toLowerCase().startsWith(needle),
            )
        : apps,
    [apps, needle],
  );
  const recentApps = needle
    ? []
    : recent
        .map((id) => apps.find((a) => a.id === id))
        .filter((a): a is App => !!a)
        .slice(0, 4);
  const open = async (app: App) => {
    if (busy) return;
    setBusy(app.id);
    try {
      await post(peer, "/api/apps/launch", { id: app.id });
      remember(app);
      toast(`${app.name} is open on ${device.name}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const tile = (app: App) => (
    <button
      key={app.id}
      className="app-tile"
      aria-busy={busy === app.id}
      disabled={!!busy && busy !== app.id}
      onClick={() => tap(app)}
      {...press(app)}
      title={
        onPhone
          ? `Open ${app.name} on your phone. Touch and hold to open it on ${device.name}.`
          : `Open ${app.name} on ${device.name}`
      }
    >
      <span className="app-tile-logo">
        <AppLogo peer={peer} appId={app.id} name={app.name} />
        {busy === app.id && (
          <span className="app-tile-busy">
            <Loader2 className="spin" size={22} />
          </span>
        )}
      </span>
      <span className="app-tile-name">{app.name}</span>
    </button>
  );
  return (
    <div className="apps-page">
      <PageTitle eyebrow={device.name} title="Apps">
        {screen && (
          <button className="button secondary" onClick={screen}>
            <Monitor size={17} />
            View screen
          </button>
        )}
      </PageTitle>
      <form
        className="apps-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (shown[0]) tap(shown[0]);
        }}
      >
        <Search size={18} />
        <input
          type="search"
          aria-label="Find an app"
          placeholder={`Search ${apps.length || ""} apps`.replace("  ", " ")}
          value={query}
          enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <X size={16} />
          </button>
        )}
      </form>
      <ErrorLine error={apps.length ? "" : error} />
      {loading ? (
        <div className="launcher-grid" aria-label="Loading apps">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className="app-tile skeleton">
              <span className="app-tile-logo" />
              <span className="app-tile-name" />
            </span>
          ))}
        </div>
      ) : (
        <>
          {onPhone && threads.length > 0 && !needle && (
            <section className="apps-section" aria-label="On your phone">
              <h2>On your phone</h2>
              <div className="apps-running">
                {threads.map((t) => {
                  const shot = snapshotOf(t.id);
                  return (
                    <div key={t.id} className="apps-running-item">
                      <button
                        className="apps-running-card"
                        aria-busy={t.state === "starting" || busy === t.appId}
                        title={`Open ${t.name}. Swipe up to quit it.`}
                        style={
                          lift?.id === t.id
                            ? {
                                transform: `translateY(${lift.dy}px)`,
                                opacity: Math.max(0.3, 1 + lift.dy / 200),
                              }
                            : undefined
                        }
                        {...card(t)}
                      >
                        <span className="apps-running-shot">
                          {shot ? (
                            <img src={shot} alt="" />
                          ) : (
                            <AppLogo
                              peer={peer}
                              appId={t.appId}
                              name={t.name}
                              size={44}
                            />
                          )}
                        </span>
                        <span className="apps-running-name">
                          <AppLogo
                            peer={peer}
                            appId={t.appId}
                            name={t.name}
                            size={16}
                          />
                          <span>{t.name}</span>
                        </span>
                        <span className="apps-running-state">
                          {t.state === "running"
                            ? "Open"
                            : t.state === "starting" || (t.held && !paused)
                              ? "Opening…"
                              : t.held || paused
                                ? "Paused"
                                : "Tap to reopen"}
                        </span>
                      </button>
                      {confirmQuit?.id === t.id && (
                        <span
                          className="apps-running-confirm"
                          role="alertdialog"
                        >
                          <span>
                            Also closes {confirmQuit.others} Mac{" "}
                            {confirmQuit.others === 1 ? "window" : "windows"}.
                          </span>
                          <button
                            className="button primary small"
                            onClick={() => void quitApp(t, true)}
                          >
                            Quit
                          </button>
                          <button
                            className="button secondary small"
                            onClick={() => setConfirmQuit(null)}
                          >
                            Keep
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {recentApps.length > 0 && (
            <section className="apps-section" aria-label="Recently opened">
              <h2>Recent</h2>
              <div className="launcher-grid">{recentApps.map(tile)}</div>
            </section>
          )}
          {shown.length > 0 && (
            <section className="apps-section" aria-label="All apps">
              {!needle && recentApps.length > 0 && <h2>All apps</h2>}
              <div className="launcher-grid">{shown.map(tile)}</div>
            </section>
          )}
          {!shown.length && (
            <Empty
              icon={needle ? Search : AppWindow}
              title={needle ? "No matching apps" : "No applications found"}
            >
              {needle
                ? "Try a different name."
                : "App launching is available on Mac and Windows."}
            </Empty>
          )}
        </>
      )}
      {current && (
        <Suspense fallback={null}>
          <AppThreadView
            peer={peer}
            thread={current}
            threads={threads}
            onLeave={() => {
              setOpenId(null);
              void refreshThreads();
            }}
            onSwitch={(t) => setOpenId(t.id)}
            onReturn={(t) => void giveBack(t)}
            onQuit={quitted}
            onReopen={(t) => void resume({ ...t, state: "paused" })}
            onUpdate={upsert}
            onStale={() => void refreshThreads()}
            paused={paused}
            owner={owner}
            toast={toast}
          />
        </Suspense>
      )}
    </div>
  );
}
