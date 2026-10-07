import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ArrowDown, ArrowUp, CornerDownLeft, Eye, Keyboard, MousePointerClick, RefreshCw } from "lucide-react";
import { peerFetch, request, type Peer } from "./api";
import { OptionButtons } from "./agent-ui";
import "./agent-desktop.css";

// The Mac's screen for a preset agent, driven by sight: a picture that
// refreshes, and plain buttons for every action. Clicking the picture clicks
// the Mac at that spot. Refusals are shown in words (why, and whether to wait).
export type DesktopAccess = {
  expiresAt: number;
  preset: "full" | "apps" | "files" | "readonly";
  presetName?: string;
  control?: boolean;
  open?: boolean;
  apps?: { id: string; name?: string }[];
};
type DesktopApp = { id: string; name: string; bundleId: string; running: boolean; runsCommands?: boolean };
type Front = { app: string; title: string; terminalLike: boolean; secure: boolean; blocked: string; holder: string };
type Action = Record<string, unknown> & { type: string };
const REFRESH_MS = 2000;
const KEYS: { label: string; key: string }[] = [
  { label: "Enter", key: "enter" }, { label: "Tab", key: "tab" }, { label: "Esc", key: "escape" }, { label: "Delete", key: "backspace" },
  { label: "←", key: "left" }, { label: "↑", key: "up" }, { label: "↓", key: "down" }, { label: "→", key: "right" },
];
const MODIFIERS = new Set(["cmd", "shift", "option", "control"]);
const aliases: Record<string, string> = { command: "cmd", meta: "cmd", alt: "option", ctrl: "control", esc: "escape", return: "enter" };

type Props = { peer: Peer; access: DesktopAccess; visible: boolean; onError: (error: unknown) => void };
export default function AgentDesktop({ peer, access, visible, onError }: Props) {
  const [imageUrl, setImageUrl] = useState("");
  const [imageAt, setImageAt] = useState<Date | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"click" | "double" | "right">("click");
  const [text, setText] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"" | "is-wait" | "is-blocked">("");
  const [front, setFront] = useState<Front | null>(null);
  const [apps, setApps] = useState<DesktopApp[] | null>(null);
  // Why the last screenshot failed, shown where the picture would be: an
  // agent reading this page needs the reason, not a blank frame.
  const [screenError, setScreenError] = useState("");
  const objectUrl = useRef("");
  const inFlight = useRef<AbortController | null>(null);
  const acting = useRef(false);
  const mounted = useRef(true);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ visible, control: !!access.control });
  live.current = { visible, control: !!access.control };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current || !mounted.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    setBusy(true);
    try {
      const response = await peerFetch(peer, "/api/browser/desktop/screen?maxWidth=1440", { cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(Error(body.error || "The screen could not be read."), { status: response.status });
      }
      const blob = await response.blob();
      if (controller.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      setImageUrl(url);
      setImageAt(new Date());
      setScreenError("");
      try { setHiddenCount(Number(JSON.parse(response.headers.get("X-Reach-Screen") || "{}").hidden) || 0); } catch { setHiddenCount(0); }
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) {
        setScreenError((e as Error).message || "The screen could not be read.");
        if ((e as { status?: number }).status === 401) onError(e);
      }
    } finally {
      clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
      if (mounted.current) setBusy(false);
    }
  }, [peer, onError]);

  // Refreshes while the page is open, even when the agent's browser reports
  // the tab as hidden (an automated browser often does), just more slowly.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (!acting.current) await refresh();
      if (alive) timer = setTimeout(() => void loop(), visible ? REFRESH_MS : REFRESH_MS * 3);
    };
    void loop();
    return () => { alive = false; clearTimeout(timer); inFlight.current?.abort(); };
  }, [visible, refresh]);

  useEffect(() => {
    if (!access.open) return;
    let alive = true;
    request<{ apps: DesktopApp[] }>(peer, "/api/browser/desktop/apps")
      .then((value) => alive && setApps(value.apps))
      .catch((e) => alive && onError(e));
    return () => { alive = false; };
  }, [peer, access.open, access.preset, onError]);

  const tell = (message: string, kind: "" | "is-wait" | "is-blocked" = "") => { setStatus(message); setTone(kind); };
  const explain = (error: { status?: number; message: string; body?: { kind?: string; holder?: string; retryInMs?: number } }) => {
    const kind = error.body?.kind;
    if (kind === "busy") return tell(`${error.body?.holder || "Another agent"} is using the Mac. Try again in ${Math.ceil((error.body?.retryInMs || 2000) / 1000)} s.`, "is-wait");
    if (kind === "paused" || kind === "retry") return tell(`${error.message} Wait, then try again.`, "is-wait");
    tell(error.message, "is-blocked");
  };
  const post = async (route: string, body: unknown) => {
    const response = await peerFetch(peer, route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(value.error || "The Mac couldn't do that."), { status: response.status, body: value });
    return value as { app?: string };
  };
  const act = async (action: Action, words: string) => {
    if (acting.current || !access.control) return;
    acting.current = true;
    inFlight.current?.abort();
    tell(`${words}…`);
    try {
      const result = await post("/api/browser/desktop/input", { action });
      if (!mounted.current) return;
      tell(result.app ? `${words} in ${result.app}.` : `${words}.`);
    } catch (e) {
      if (!mounted.current) return;
      if ((e as { status?: number }).status === 401) return onError(e);
      explain(e as { status?: number; message: string });
    } finally {
      acting.current = false;
      setTimeout(() => void refresh(), 350);
    }
  };
  const clickAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!access.control || !imageUrl) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const place = `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`;
    void act(
      { type: "click", x, y, button: mode === "right" ? "right" : "left", count: mode === "double" ? 2 : 1 },
      mode === "right" ? `Right-clicked at ${place}` : mode === "double" ? `Double-clicked at ${place}` : `Clicked at ${place}`,
    );
  };
  const typeText = async (enter: boolean) => {
    const value = text;
    if (!value) return;
    await act({ type: "type", text: value }, `Typed ${JSON.stringify(value.length > 40 ? value.slice(0, 37) + "…" : value)}`);
    if (enter && mounted.current && tone !== "is-blocked") await act({ type: "key", key: "enter" }, "Pressed Enter");
    if (mounted.current) setText("");
  };
  const pressShortcut = async () => {
    const parts = shortcut.toLowerCase().split(/[+\s-]+/).filter(Boolean).map((part) => aliases[part] || part);
    const key = parts.find((part) => !MODIFIERS.has(part));
    const modifiers = parts.filter((part) => MODIFIERS.has(part));
    if (!key) return tell("Name a key, like cmd+l or shift+tab.", "is-blocked");
    await act({ type: "key", key, modifiers }, `Pressed ${shortcut}`);
  };
  const lookFront = async () => {
    try {
      const value = await request<Front>(peer, "/api/browser/desktop/front");
      if (mounted.current) setFront(value);
    } catch (e) { onError(e); }
  };
  const openApp = async (id: string) => {
    if (acting.current) return;
    const app = apps?.find((item) => item.id === id);
    acting.current = true;
    tell(`Opening ${app?.name || "the app"}…`);
    try {
      const result = await post("/api/browser/desktop/open", { app: id });
      if (mounted.current) tell(`${result.app || app?.name || "The app"} is in front.`);
    } catch (e) {
      if (!mounted.current) return;
      if ((e as { status?: number }).status === 401) return onError(e);
      explain(e as { status?: number; message: string });
    } finally {
      acting.current = false;
      setTimeout(() => void refresh(), 900);
    }
  };
  const canAct = !!access.control && !!imageUrl;

  return (
    <section className="browser-screen ag-desk" aria-labelledby="agent-desktop-title">
      <div className="browser-section-heading ag-ws-section-head">
        <div>
          <h2 id="agent-desktop-title">Screen</h2>
          <p className="browser-policy">
            {access.control
              ? access.preset === "apps" ? "Only the chosen apps appear and take your clicks." : "The Mac as its owner sees it. Click the picture to click there."
              : "Look only. Nothing here clicks or types."}
            {hiddenCount ? ` ${hiddenCount} protected ${hiddenCount === 1 ? "window is" : "windows are"} left out.` : ""}
          </p>
        </div>
        <div className="browser-screen-toolbar">
          <span className="browser-screen-status" aria-live="off">{imageAt ? `Updated ${imageAt.toLocaleTimeString()}` : busy ? "Reading the screen…" : "Waiting for the screen"}</span>
          <button className="ag-secondary ag-small" disabled={busy} aria-label="Refresh screen" onClick={() => void refresh()}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>
      {access.control && (
        <OptionButtons
          label="Click mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "click", label: "Click", icon: <MousePointerClick size={16} /> },
            { value: "double", label: "Double-click" },
            { value: "right", label: "Right-click" },
          ]}
        />
      )}
      <div
        ref={frameRef}
        className={`ag-desk-frame${canAct ? " can-act" : ""}`}
        role={canAct ? "button" : undefined}
        aria-label={canAct ? "Mac screen. Click to click there." : "Mac screen"}
        tabIndex={canAct ? 0 : -1}
        onClick={clickAt}
      >
        {imageUrl ? <img src={imageUrl} alt={`Screen of ${peer.name}`} draggable={false} />
          : <div className="browser-screen-placeholder" role="status"><Eye size={32} /><span>{screenError ? `The screen could not be read: ${screenError}` : busy ? "Reading the screen…" : "Waiting for a screen image…"}</span></div>}
      </div>
      {imageUrl && screenError && <p className="ag-desk-status is-blocked" role="alert">The last refresh failed: {screenError}</p>}
      {status && <p className={`ag-desk-status ${tone}`} role="status" aria-live="polite">{status}</p>}
      {access.control && (
        <div className="ag-desk-controls">
          <form className="ag-desk-type" onSubmit={(event) => { event.preventDefault(); void typeText(false); }}>
            <label className="ag-search">
              <Keyboard size={16} aria-hidden="true" />
              <input aria-label="Text to type" placeholder="Text to type into the focused field" value={text} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setText(event.target.value)} />
            </label>
            <button className="ag-primary ag-small" type="submit" disabled={!text || !canAct}>Type</button>
            <button className="ag-secondary ag-small" type="button" disabled={!text || !canAct} onClick={() => void typeText(true)}>
              <CornerDownLeft size={14} /> Type + Enter
            </button>
          </form>
          <div className="ag-desk-keys" role="group" aria-label="Keys">
            {KEYS.map((item) => (
              <button key={item.key} type="button" className="ag-secondary ag-small" disabled={!canAct} onClick={() => void act({ type: "key", key: item.key }, `Pressed ${item.label}`)}>{item.label}</button>
            ))}
            <form className="ag-desk-shortcut" onSubmit={(event) => { event.preventDefault(); void pressShortcut(); }}>
              <input aria-label="Shortcut" placeholder="cmd+l" value={shortcut} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setShortcut(event.target.value)} />
              <button className="ag-secondary ag-small" type="submit" disabled={!shortcut || !canAct}>Press</button>
            </form>
            <button type="button" className="ag-secondary ag-small" disabled={!canAct} onClick={() => void act({ type: "scroll", x: 0.5, y: 0.5, dy: -600 }, "Scrolled up")}><ArrowUp size={15} /> Scroll up</button>
            <button type="button" className="ag-secondary ag-small" disabled={!canAct} onClick={() => void act({ type: "scroll", x: 0.5, y: 0.5, dy: 600 }, "Scrolled down")}><ArrowDown size={15} /> Scroll down</button>
            <button type="button" className="ag-secondary ag-small" onClick={() => void lookFront()}><Eye size={15} /> What’s in front?</button>
          </div>
          {front && (
            <p className="ag-desk-front" aria-label="In front">
              In front: <strong>{front.app || "nothing"}</strong>{front.title ? ` · ${front.title}` : ""}
              {front.terminalLike ? " · a terminal (typed text is checked as commands)" : ""}
              {front.secure ? " · a password field (closed to you)" : ""}
              {front.blocked ? ` · ${front.blocked}` : ""}
              {front.holder ? ` · ${front.holder} is using the Mac` : ""}
            </p>
          )}
        </div>
      )}
      {access.open && (
        <div className="ag-desk-apps">
          <p className="ag-label"><AppWindow size={14} /> Open an app</p>
          {apps === null ? <p className="ag-quiet">Loading apps…</p> : apps.length ? (
            <OptionButtons
              label="Apps you may use"
              value=""
              onChange={(id) => void openApp(String(id))}
              options={apps.slice(0, 60).map((app) => ({ value: app.id, label: app.name, detail: app.running ? "Running" : "Not running", title: app.id }))}
            />
          ) : <p className="ag-quiet">No apps to open.</p>}
        </div>
      )}
    </section>
  );
}
