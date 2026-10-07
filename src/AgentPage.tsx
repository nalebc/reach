import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, CornerDownLeft, Download, Eye, FileText, Folder,
  Keyboard, Lock, Maximize2, Monitor, MousePointerClick, RotateCw, Search, Terminal, ZoomIn, ZoomOut,
} from "lucide-react";
import { fileBlob, peerFetch, request, type FileEntry, type Peer } from "./api";
import { saveBlob } from "./native";
import { OptionButtons } from "./agent-ui";
import AgentShell from "./AgentShell";
import AgentFileChanges from "./AgentFileChanges";
import "./agent-page.css";

// The page an agent drives by sight when it was invited with a preset. One
// column, nothing hidden behind tabs: the Mac's screen first, then every
// action as a labelled button with its result written next to it, then apps,
// files and commands. The screen updates by itself; the only "refresh" is
// "Reload page", which reloads this browser page.
export type PresetAccess = {
  name: string;
  expiresAt: number;
  roots: { name: string; path: string; index: number }[];
  terminals: { id: string; name: string }[];
  preset: "full" | "apps" | "files" | "readonly";
  presetName?: string;
  screen?: boolean;
  control?: boolean;
  open?: boolean;
  shell?: boolean;
  write?: boolean;
  apps?: { id: string; name?: string; bundleId?: string }[];
  hidden?: { id: string; name?: string }[];
  // Always access: no end time; the same link brings the agent back.
  standing?: boolean;
};
type DesktopApp = { id: string; name: string; bundleId: string; running: boolean; runsCommands?: boolean };
type Front = { app: string; title: string; terminalLike: boolean; secure: boolean; blocked: string; holder: string };
type Action = Record<string, unknown> & { type: string };
type Listing = { items: FileEntry[]; truncated?: boolean };
const SCREEN_MS = 2000;
// The page asks for the display's own pixels (Retina is 2x), so small controls
// stay legible; the zoomed view shows a quarter of the picture at four times.
const SCREEN_WIDTH = 2560;
const ZOOM = 0.25;
type Region = { x0: number; y0: number; w: number; h: number };
const regionAround = (cx: number, cy: number): Region => ({ x0: Math.min(1 - ZOOM, Math.max(0, cx - ZOOM / 2)), y0: Math.min(1 - ZOOM, Math.max(0, cy - ZOOM / 2)), w: ZOOM, h: ZOOM });
const percent = (value: number) => `${Math.round(value * 100)}%`;
const KEYS: { label: string; key: string }[] = [
  { label: "Enter", key: "enter" }, { label: "Tab", key: "tab" }, { label: "Esc", key: "escape" }, { label: "Delete", key: "backspace" },
  { label: "←", key: "left" }, { label: "↑", key: "up" }, { label: "↓", key: "down" }, { label: "→", key: "right" },
];
const MODIFIERS = new Set(["cmd", "shift", "option", "control"]);
const aliases: Record<string, string> = { command: "cmd", meta: "cmd", alt: "option", ctrl: "control", esc: "escape", return: "enter" };
const clock = (value: number | Date) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const ago = (at: Date | null, now: number) => (at ? `${Math.max(0, Math.round((now - at.getTime()) / 1000))} s ago` : "not yet");

type Props = { peer: Peer; access: PresetAccess; onEnd: () => void; reload?: () => void };
export default function AgentPage({ peer, access, onEnd, reload = () => window.location.reload() }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [status, setStatus] = useState<{ text: string; tone: "" | "is-wait" | "is-blocked" | "is-done" }>({ text: "", tone: "" });
  const tell = useCallback((text: string, tone: "" | "is-wait" | "is-blocked" | "is-done" = "") => setStatus({ text, tone }), []);
  const ended = useCallback((e: unknown) => { if ((e as { status?: number })?.status === 401) onEnd(); }, [onEnd]);
  const minutesLeft = Math.max(0, Math.round((access.expiresAt - now) / 60000));
  const abilities = [
    access.screen && access.control && (access.preset === "apps" ? "see and use only the chosen apps" : "see and use the whole screen"),
    access.screen && !access.control && "look at the screen",
    access.open && "open apps",
    access.roots.length > 0 && (access.write ? "read and change files" : "read files"),
    access.shell && "run commands as the owner",
    access.terminals.length > 0 && "read shared terminal output",
  ].filter(Boolean) as string[];

  return (
    <main className="agent-page" aria-label="Agent workspace">
      <header className="ap-head">
        <div className="ap-title">
          <span className="ap-mark"><Monitor size={18} /></span>
          <div>
            <h1>{peer.name}</h1>
            <p>
              <strong>{access.presetName || access.preset}</strong> · {access.standing ? "until the owner ends it" : `ends ${new Date(access.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${minutesLeft} min left`}
            </p>
          </div>
        </div>
        <button type="button" className="ag-secondary ag-small ap-reload" onClick={() => reload()} title="Reloads this web page. The Mac's screen below updates by itself.">
          <RotateCw size={15} /> Reload page
        </button>
      </header>
      <p className="ap-abilities">You may {abilities.join(", ") || "do nothing yet"}. Everything else is closed. The screen below updates by itself; you never need to refresh it. Click the picture to click there on the Mac.</p>
      {status.text && <p className={`ap-status ${status.tone}`} role="status" aria-live="polite">{status.text}</p>}

      {access.screen && <ScreenCard peer={peer} access={access} now={now} tell={tell} ended={ended} />}
      {access.open && <AppsCard peer={peer} access={access} tell={tell} ended={ended} />}
      {access.roots.length > 0 && <FilesCard peer={peer} access={access} tell={tell} ended={ended} />}
      {access.shell && (
        <section className="ap-card" aria-labelledby="ap-commands">
          <h2 id="ap-commands"><Terminal size={16} /> Commands on the Mac</h2>
          <AgentShell peer={peer} roots={access.roots} onError={(e) => { ended(e); tell((e as Error).message, "is-blocked"); }} />
        </section>
      )}
      {access.terminals.length > 0 && <TerminalsCard peer={peer} access={access} ended={ended} />}
      <footer className="ap-foot">
        <Lock size={13} /> Only what is listed above is available. You can't invite anyone, share this link, or reach other folders or apps. {access.standing ? "Access lasts until the owner ends it; if you lose this page, open the same link again." : `Access ends at ${new Date(access.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
      </footer>
    </main>
  );
}

// The Mac's screen and every action on it.
function ScreenCard({ peer, access, now, tell, ended }: { peer: Peer; access: PresetAccess; now: number; tell: (text: string, tone?: "" | "is-wait" | "is-blocked" | "is-done") => void; ended: (e: unknown) => void }) {
  const [imageUrl, setImageUrl] = useState("");
  const [imageAt, setImageAt] = useState<Date | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [screenError, setScreenError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"click" | "double" | "right">("click");
  const [text, setText] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [xPercent, setXPercent] = useState("");
  const [yPercent, setYPercent] = useState("");
  const [front, setFront] = useState<Front | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [zooming, setZooming] = useState(false);
  const [zoom, setZoom] = useState<Region | null>(null);
  const [lastClick, setLastClick] = useState<{ x: number; y: number; at: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const objectUrl = useRef("");
  const inFlight = useRef<AbortController | null>(null);
  const acting = useRef(false);
  const mounted = useRef(true);
  const frameRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; inFlight.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); };
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current || !mounted.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    setBusy(true);
    try {
      const response = await peerFetch(peer, `/api/browser/desktop/screen?maxWidth=${SCREEN_WIDTH}`, { cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(Error(body.error || "The screen could not be read."), { status: response.status });
      }
      const blob = await response.blob();
      if (controller.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      setImageUrl(url); setImageAt(new Date()); setScreenError("");
      try {
        const meta = JSON.parse(response.headers.get("X-Reach-Screen") || "{}");
        setHiddenCount(Number(meta.hidden) || 0);
        if (Number(meta.width) > 0 && Number(meta.height) > 0) setImageSize({ w: Number(meta.width), h: Number(meta.height) });
      } catch { setHiddenCount(0); }
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) { setScreenError((e as Error).message || "The screen could not be read."); ended(e); }
    } finally {
      clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
      if (mounted.current) setBusy(false);
    }
  }, [peer, ended]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (!acting.current) await refresh();
      if (alive) timer = setTimeout(() => void loop(), document.hidden ? SCREEN_MS * 3 : SCREEN_MS);
    };
    void loop();
    return () => { alive = false; clearTimeout(timer); inFlight.current?.abort(); };
  }, [refresh]);

  const post = async (route: string, body: unknown) => {
    const response = await peerFetch(peer, route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(value.error || "The Mac couldn't do that."), { status: response.status, body: value });
    return value as { app?: string };
  };
  const explain = (error: { status?: number; message: string; body?: { kind?: string; holder?: string; retryInMs?: number } }) => {
    const kind = error.body?.kind;
    if (kind === "busy") return tell(`Not done: ${error.body?.holder || "another agent"} is using the Mac. Try again in ${Math.ceil((error.body?.retryInMs || 2000) / 1000)} s.`, "is-wait");
    if (kind === "paused" || kind === "retry") return tell(`Not done: ${error.message} Wait, then try again.`, "is-wait");
    tell(`Not done: ${error.message}`, "is-blocked");
  };
  const act = async (action: Action, words: string) => {
    if (acting.current || !access.control) return;
    acting.current = true;
    inFlight.current?.abort();
    tell(`${words}…`);
    try {
      const result = await post("/api/browser/desktop/input", { action });
      if (!mounted.current) return;
      tell(`Done: ${words}${result.app ? ` in ${result.app}` : ""}. The screen below is updating.`, "is-done");
    } catch (e) {
      if (!mounted.current) return;
      ended(e);
      explain(e as { status?: number; message: string });
    } finally {
      acting.current = false;
      setTimeout(() => void refresh(), 350);
    }
  };
  // The zoomed view: a quarter of the picture drawn four times larger, from
  // the full-resolution image, so an agent can aim at small controls. Clicks
  // inside it map back to the exact spot on the Mac.
  useEffect(() => {
    const canvas = canvasRef.current, image = imageRef.current;
    if (!canvas || !image || !zoom) return;
    const context = canvas.getContext?.("2d");
    if (!context) return;
    const width = image.naturalWidth || imageSize?.w || 0, height = image.naturalHeight || imageSize?.h || 0;
    if (!width || !height) return;
    canvas.width = Math.round(width * zoom.w);
    canvas.height = Math.round(height * zoom.h);
    try { context.drawImage(image, zoom.x0 * width, zoom.y0 * height, zoom.w * width, zoom.h * height, 0, 0, canvas.width, canvas.height); } catch { /* not yet decodable */ }
  }, [zoom, imageUrl, imageSize]);
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void cardRef.current?.requestFullscreen?.();
  };
  const pan = (dx: number, dy: number) => setZoom((current) => current ? regionAround(current.x0 + current.w / 2 + dx, current.y0 + current.h / 2 + dy) : current);
  const clickFraction = (x: number, y: number) => {
    const place = `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`;
    setLastClick({ x, y, at: Date.now() });
    void act(
      { type: "click", x, y, button: mode === "right" ? "right" : "left", count: mode === "double" ? 2 : 1 },
      mode === "right" ? `right-clicked at ${place}` : mode === "double" ? `double-clicked at ${place}` : `clicked at ${place}`,
    );
  };
  const fractionIn = (element: HTMLElement | null, event: React.MouseEvent) => {
    const rect = element?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };
  const clickAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!imageUrl) return;
    const spot = fractionIn(frameRef.current, event);
    if (!spot) return;
    // In zoom mode a click on the picture chooses where to look closer.
    if (zooming) { setZoom(regionAround(spot.x, spot.y)); tell(`Zoomed in around ${percent(spot.x)}, ${percent(spot.y)}. Click inside the zoomed view to click there on the Mac.`); return; }
    if (!access.control) return;
    clickFraction(spot.x, spot.y);
  };
  const clickZoomed = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!access.control || !zoom) return;
    const spot = fractionIn(canvasRef.current, event);
    if (!spot) return;
    clickFraction(zoom.x0 + spot.x * zoom.w, zoom.y0 + spot.y * zoom.h);
  };
  const clickTyped = () => {
    const x = Number(xPercent), y = Number(yPercent);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return tell("Not done: give X and Y as percentages from 0 to 100.", "is-blocked");
    clickFraction(x / 100, y / 100);
  };
  const typeText = async (enter: boolean) => {
    const value = text;
    if (!value) return;
    await act({ type: "type", text: value }, `typed ${JSON.stringify(value.length > 40 ? value.slice(0, 37) + "…" : value)}`);
    if (enter && mounted.current) await act({ type: "key", key: "enter" }, "pressed Enter");
    if (mounted.current) setText("");
  };
  const pressShortcut = async () => {
    const parts = shortcut.toLowerCase().split(/[+\s-]+/).filter(Boolean).map((part) => aliases[part] || part);
    const key = parts.find((part) => !MODIFIERS.has(part));
    const modifiers = parts.filter((part) => MODIFIERS.has(part));
    if (!key) return tell("Not done: name a key, like cmd+l or shift+tab.", "is-blocked");
    await act({ type: "key", key, modifiers }, `pressed ${shortcut}`);
  };
  const lookFront = async () => {
    try { const value = await request<Front>(peer, "/api/browser/desktop/front"); if (mounted.current) setFront(value); }
    catch (e) { ended(e); tell(`Not done: ${(e as Error).message}`, "is-blocked"); }
  };
  const canAct = !!access.control && !!imageUrl;
  const canAim = canAct || (!!imageUrl && zooming);
  const marker = lastClick && now - lastClick.at < 3000 ? lastClick : null;
  return (
    <section ref={cardRef} className={`ap-card ap-screen${fullscreen ? " is-fullscreen" : ""}`} aria-labelledby="ap-screen-title">
      <div className="ap-card-head">
        <h2 id="ap-screen-title"><Eye size={16} /> The Mac's screen</h2>
        <p className="ap-live" aria-live="off">
          <span className={`ap-dot${busy ? " is-busy" : ""}`} aria-hidden="true" />
          {imageAt ? `Live · updated ${ago(imageAt, now)} (${clock(imageAt)})` : busy ? "Reading the screen…" : "Waiting for the first picture…"}
          {imageSize ? ` · ${imageSize.w}×${imageSize.h} px` : ""}
          {hiddenCount ? ` · ${hiddenCount} protected ${hiddenCount === 1 ? "window" : "windows"} left out` : ""}
        </p>
        <div className="ap-inline">
          <button type="button" className="ag-secondary ag-small" aria-pressed={zooming} disabled={!imageUrl} onClick={() => { setZooming((value) => !value); if (zooming) setZoom(null); else tell("Zoom mode: click the picture where you want to look closer."); }} title="Look at a quarter of the screen four times larger, and click precisely inside it.">
            {zooming ? <ZoomOut size={15} /> : <ZoomIn size={15} />} {zooming ? "Zoom out" : "Zoom in"}
          </button>
          <button type="button" className="ag-secondary ag-small" onClick={toggleFullscreen} title="Show this screen as large as the browser allows."><Maximize2 size={15} /> {fullscreen ? "Exit full screen" : "Full screen"}</button>
          <button type="button" className="ag-secondary ag-small" disabled={busy} onClick={() => void refresh()} title="The picture already updates every two seconds and after each action.">Take a screenshot now</button>
        </div>
      </div>
      <div
        ref={frameRef}
        className={`ap-frame${canAim ? " can-act" : ""}`}
        role={canAim ? "button" : undefined}
        aria-label={zooming ? "Mac screen. Click where to zoom in." : canAct ? "Mac screen. Click to click there." : "Mac screen"}
        tabIndex={canAim ? 0 : -1}
        onClick={clickAt}
      >
        {imageUrl ? <img ref={imageRef} src={imageUrl} alt={`Screen of ${peer.name}`} draggable={false} />
          : <div className="ap-placeholder" role="status"><Eye size={32} /><span>{screenError ? `The screen could not be read: ${screenError}` : busy ? "Reading the screen…" : "Waiting for the first picture…"}</span></div>}
        {marker && <span className="ap-mark-ring" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }} aria-hidden="true" />}
        {zoom && imageUrl && <span className="ap-zoom-box" style={{ left: `${zoom.x0 * 100}%`, top: `${zoom.y0 * 100}%`, width: `${zoom.w * 100}%`, height: `${zoom.h * 100}%` }} aria-hidden="true" />}
      </div>
      {zooming && !zoom && imageUrl && <p className="ap-quiet">Zoom mode: click the picture where you want to look closer.</p>}
      {zoom && imageUrl && (
        <div className="ap-zoom" aria-label="Zoomed view">
          <div className="ap-row">
            <span className="ap-row-label"><ZoomIn size={15} /> Zoomed view</span>
            <span className="ap-quiet">X {percent(zoom.x0)}–{percent(zoom.x0 + zoom.w)}, Y {percent(zoom.y0)}–{percent(zoom.y0 + zoom.h)} · 4×{access.control ? " · click inside it to click there on the Mac" : ""}</span>
            <span className="ap-inline" role="group" aria-label="Move the zoomed view">
              <button type="button" className="ag-secondary ag-small" aria-label="Move zoom left" onClick={() => pan(-0.1, 0)}><ArrowLeft size={14} /></button>
              <button type="button" className="ag-secondary ag-small" aria-label="Move zoom up" onClick={() => pan(0, -0.1)}><ArrowUp size={14} /></button>
              <button type="button" className="ag-secondary ag-small" aria-label="Move zoom down" onClick={() => pan(0, 0.1)}><ArrowDown size={14} /></button>
              <button type="button" className="ag-secondary ag-small" aria-label="Move zoom right" onClick={() => pan(0.1, 0)}><ArrowRight size={14} /></button>
            </span>
          </div>
          <div className="ap-zoom-frame">
            <canvas
              ref={canvasRef}
              className={access.control ? "can-act" : ""}
              role={access.control ? "button" : undefined}
              aria-label={access.control ? "Zoomed view. Click to click there." : "Zoomed view"}
              tabIndex={access.control ? 0 : -1}
              onClick={clickZoomed}
            />
            {marker && marker.x >= zoom.x0 && marker.x <= zoom.x0 + zoom.w && marker.y >= zoom.y0 && marker.y <= zoom.y0 + zoom.h && (
              <span className="ap-mark-ring" style={{ left: `${((marker.x - zoom.x0) / zoom.w) * 100}%`, top: `${((marker.y - zoom.y0) / zoom.h) * 100}%` }} aria-hidden="true" />
            )}
          </div>
        </div>
      )}
      {imageUrl && screenError && <p className="ap-status is-blocked" role="alert">The last screenshot failed: {screenError}</p>}
      {access.control ? (
        <div className="ap-controls">
          <div className="ap-row">
            <span className="ap-row-label"><MousePointerClick size={15} /> Click the picture, or</span>
            <OptionButtons label="Click mode" value={mode} onChange={setMode} options={[{ value: "click", label: "Click" }, { value: "double", label: "Double-click" }, { value: "right", label: "Right-click" }]} />
            <form className="ap-inline" onSubmit={(event) => { event.preventDefault(); clickTyped(); }} aria-label="Click at a position">
              <label>X <input aria-label="X percent" inputMode="numeric" placeholder="50" value={xPercent} onChange={(event) => setXPercent(event.target.value)} /> %</label>
              <label>Y <input aria-label="Y percent" inputMode="numeric" placeholder="50" value={yPercent} onChange={(event) => setYPercent(event.target.value)} /> %</label>
              <button className="ag-secondary ag-small" type="submit" disabled={!canAct}>Click there</button>
            </form>
          </div>
          <form className="ap-row ap-type" onSubmit={(event) => { event.preventDefault(); void typeText(false); }}>
            <span className="ap-row-label"><Keyboard size={15} /> Type on the Mac</span>
            <input aria-label="Text to type" placeholder="Text for the focused field" value={text} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setText(event.target.value)} />
            <button className="ag-primary ag-small" type="submit" disabled={!text || !canAct}>Type</button>
            <button className="ag-secondary ag-small" type="button" disabled={!text || !canAct} onClick={() => void typeText(true)}><CornerDownLeft size={14} /> Type + Enter</button>
          </form>
          <div className="ap-row" role="group" aria-label="Keys">
            <span className="ap-row-label">Press a key</span>
            {KEYS.map((item) => (
              <button key={item.key} type="button" className="ag-secondary ag-small" disabled={!canAct} onClick={() => void act({ type: "key", key: item.key }, `pressed ${item.label}`)}>{item.label}</button>
            ))}
            <form className="ap-inline" onSubmit={(event) => { event.preventDefault(); void pressShortcut(); }}>
              <input aria-label="Shortcut" placeholder="cmd+l" value={shortcut} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setShortcut(event.target.value)} />
              <button className="ag-secondary ag-small" type="submit" disabled={!shortcut || !canAct}>Press</button>
            </form>
          </div>
          <div className="ap-row">
            <span className="ap-row-label">Scroll</span>
            <button type="button" className="ag-secondary ag-small" disabled={!canAct} onClick={() => void act({ type: "scroll", x: 0.5, y: 0.5, dy: -600 }, "scrolled up")}><ArrowUp size={15} /> Scroll up</button>
            <button type="button" className="ag-secondary ag-small" disabled={!canAct} onClick={() => void act({ type: "scroll", x: 0.5, y: 0.5, dy: 600 }, "scrolled down")}><ArrowDown size={15} /> Scroll down</button>
            <button type="button" className="ag-secondary ag-small" onClick={() => void lookFront()}><Eye size={15} /> Check what's in front</button>
            {front && (
              <span className="ap-front" aria-label="In front">
                In front: <strong>{front.app || "nothing"}</strong>{front.title ? ` · ${front.title}` : ""}
                {front.terminalLike ? " · a terminal: typed text is checked as commands" : ""}
                {front.secure ? " · a password field, closed to you" : ""}
                {front.blocked ? ` · ${front.blocked}` : ""}
                {front.holder ? ` · ${front.holder} is using the Mac` : ""}
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="ap-quiet">Look only. Nothing on this page clicks or types on the Mac.</p>
      )}
    </section>
  );
}

function AppsCard({ peer, access, tell, ended }: { peer: Peer; access: PresetAccess; tell: (text: string, tone?: "" | "is-wait" | "is-blocked" | "is-done") => void; ended: (e: unknown) => void }) {
  const [apps, setApps] = useState<DesktopApp[] | null>(null);
  const busy = useRef(false);
  const load = useCallback(() => request<{ apps: DesktopApp[] }>(peer, "/api/browser/desktop/apps").then((value) => setApps(value.apps)).catch((e) => { ended(e); tell(`Not done: ${(e as Error).message}`, "is-blocked"); }), [peer, ended, tell]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, [load]);
  const open = async (id: string) => {
    if (busy.current) return;
    const app = apps?.find((item) => item.id === id);
    busy.current = true;
    tell(`Opening ${app?.name || "the app"}…`);
    try {
      const response = await peerFetch(peer, "/api/browser/desktop/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: id }) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(Error(value.error || "The app couldn't be opened."), { status: response.status, body: value });
      tell(`Done: ${value.app || app?.name || "the app"} is in front. The screen above is updating.`, "is-done");
      setTimeout(() => void load(), 1500);
    } catch (e) {
      ended(e);
      const kind = (e as { body?: { kind?: string; holder?: string } }).body?.kind;
      tell(kind === "busy" ? `Not done: ${(e as { body?: { holder?: string } }).body?.holder || "another agent"} is using the Mac. Try again in a moment.` : `Not done: ${(e as Error).message}`, kind === "busy" || kind === "paused" ? "is-wait" : "is-blocked");
    } finally { busy.current = false; }
  };
  return (
    <section className="ap-card" aria-labelledby="ap-apps-title">
      <div className="ap-card-head"><h2 id="ap-apps-title"><AppWindow size={16} /> Open an app on the Mac</h2><p className="ap-live">{access.preset === "apps" ? "Only these apps." : "Password apps and Reach are never listed."}</p></div>
      {apps === null ? <p className="ap-quiet">Loading apps…</p> : apps.length ? (
        <OptionButtons label="Apps you may use" value="" onChange={(id) => void open(String(id))} options={apps.slice(0, 80).map((app) => ({ value: app.id, label: app.name, detail: app.running ? "Running · click to bring it in front" : "Not running · click to open", title: app.id }))} />
      ) : <p className="ap-quiet">No apps to open.</p>}
    </section>
  );
}

function FilesCard({ peer, access, tell, ended }: { peer: Peer; access: PresetAccess; tell: (text: string, tone?: "" | "is-wait" | "is-blocked" | "is-done") => void; ended: (e: unknown) => void }) {
  const [root, setRoot] = useState(access.roots[0]?.index ?? 0);
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing>({ items: [] });
  const [listBusy, setListBusy] = useState(false);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [downloading, setDownloading] = useState("");
  const currentRoot = access.roots.some((item) => item.index === root) ? root : access.roots[0]?.index ?? 0;
  const rootName = access.roots.find((item) => item.index === currentRoot)?.name || "Shared folder";
  useEffect(() => {
    const controller = new AbortController();
    setListBusy(true);
    const params = new URLSearchParams({ root: String(currentRoot), ...(search ? { q: search } : { path: dir }) });
    request<Listing>(peer, `${search ? "/api/browser/files/search" : "/api/files"}?${params}`, { signal: controller.signal })
      .then((value) => !controller.signal.aborted && setListing(value))
      .catch((e) => { if (!controller.signal.aborted) { ended(e); tell(`Not done: ${(e as Error).message}`, "is-blocked"); } })
      .finally(() => !controller.signal.aborted && setListBusy(false));
    return () => controller.abort();
  }, [peer, currentRoot, dir, search, revision, ended, tell]);
  const read = async (entry: FileEntry) => {
    if (entry.type === "directory") { setDir(entry.path); setQuery(""); setSearch(""); setFile(null); return; }
    try {
      const value = await request<{ text: string }>(peer, `/api/files/text?${new URLSearchParams({ root: String(currentRoot), path: entry.path })}`);
      setFile({ path: entry.path, text: value.text });
      tell(`Done: read ${entry.path}.`, "is-done");
    } catch (e) { ended(e); tell(`Not done: ${(e as Error).message}`, "is-blocked"); }
  };
  const download = async (entry: FileEntry) => {
    if (downloading) return;
    setDownloading(entry.path);
    try { const blob = await fileBlob(peer, entry.path, currentRoot, { maxBytes: 256 * 1024 * 1024 }); await saveBlob(blob, entry.name); }
    catch (e) { ended(e); tell(`Not done: ${(e as Error).message}`, "is-blocked"); }
    finally { setDownloading(""); }
  };
  const crumbs = dir ? dir.split("/").filter(Boolean) : [];
  return (
    <section className="ap-card" aria-labelledby="ap-files-title">
      <div className="ap-card-head">
        <h2 id="ap-files-title"><Folder size={16} /> Files on the Mac</h2>
        <p className="ap-live">{access.write ? "Read, download and change files. Changes are immediate." : "Read and download only."}</p>
      </div>
      {access.roots.length > 1 && (
        <OptionButtons label="Shared folder" value={currentRoot} onChange={(index) => { setRoot(Number(index)); setDir(""); setQuery(""); setSearch(""); setFile(null); }}
          options={access.roots.map((folder) => ({ value: folder.index, label: folder.name, icon: <Folder size={16} />, title: folder.path }))} />
      )}
      <form className="ap-row" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); setRevision((value) => value + 1); }}>
        <label className="ag-search"><Search size={15} aria-hidden="true" /><input aria-label="Find a file" placeholder={`Find a file in ${rootName}…`} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="ag-secondary ag-small" type="submit">Find</button>
      </form>
      <nav className="ap-crumbs" aria-label="Folder path">
        {search ? <span>Results for “{search}” in {rootName}</span> : (
          <>
            <button type="button" onClick={() => { setDir(""); setFile(null); }} aria-current={!dir ? "location" : undefined}>{rootName}</button>
            {crumbs.map((part, index) => (
              <span key={index} className="ap-crumb"><ChevronRight size={13} aria-hidden="true" /><button type="button" aria-current={index === crumbs.length - 1 ? "location" : undefined} onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>{part}</button></span>
            ))}
          </>
        )}
        {(dir || search) && (
          <button className="ag-secondary ag-small" type="button" onClick={() => { setSearch(""); setQuery(""); setDir(search ? dir : dir.split("/").slice(0, -1).join("/")); }}><ChevronLeft size={14} /> {search ? "Back to the folder" : "Up one folder"}</button>
        )}
      </nav>
      {access.write && (
        <AgentFileChanges peer={peer} root={currentRoot} dir={dir} file={file} onChanged={(opened) => { setRevision((value) => value + 1); if (opened !== undefined) setFile(opened); }} onError={(e) => { ended(e); tell(`Not done: ${(e as Error).message}`, "is-blocked"); }} />
      )}
      <div className="ap-files">
        {listBusy ? <p className="ap-quiet" role="status">Loading files…</p> : listing.items.length ? (
          <ul className="ap-file-list">
            {listing.items.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => void read(entry)} aria-label={`${entry.type === "directory" ? "Open folder" : "Read file"} ${entry.path}`} aria-current={file?.path === entry.path ? true : undefined}>
                  {entry.type === "directory" ? <Folder size={16} /> : <FileText size={16} />}
                  <span><strong>{entry.name}</strong>{search && <small>{entry.path}</small>}</span>
                  <em aria-hidden="true">{entry.type === "directory" ? "Open" : "Read"}</em>
                </button>
                {entry.type === "file" && <button type="button" className="ap-download" aria-label={`Download file ${entry.path}`} disabled={!!downloading} onClick={() => void download(entry)}><Download size={14} /> {downloading === entry.path ? "Downloading…" : "Download"}</button>}
              </li>
            ))}
          </ul>
        ) : <p className="ap-quiet">{search ? "No files match that name." : "This folder is empty."}</p>}
        {listing.truncated && <p className="ap-quiet">More files exist. Narrow the search or open a folder.</p>}
        {file && <article className="ap-file" aria-label={`Contents of ${file.path}`}><h3><FileText size={14} /> {file.path}</h3><pre>{file.text}</pre></article>}
      </div>
    </section>
  );
}

function TerminalsCard({ peer, access, ended }: { peer: Peer; access: PresetAccess; ended: (e: unknown) => void }) {
  const [terminal, setTerminal] = useState(access.terminals[0]?.id ?? "");
  const [output, setOutput] = useState("");
  const current = access.terminals.some((item) => item.id === terminal) ? terminal : access.terminals[0]?.id ?? "";
  useEffect(() => {
    if (!current) return;
    let alive = true;
    const load = () => request<{ output: string }>(peer, `/api/browser/terminals/${encodeURIComponent(current)}`).then((value) => alive && setOutput(value.output)).catch((e) => alive && ended(e));
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [peer, current, ended]);
  return (
    <section className="ap-card" aria-labelledby="ap-terminals-title">
      <div className="ap-card-head"><h2 id="ap-terminals-title"><Terminal size={16} /> Shared terminal output</h2><p className="ap-live">Output only, updated every few seconds.</p></div>
      {access.terminals.length > 1 && <OptionButtons label="Shared terminal" value={current} onChange={setTerminal} options={access.terminals.map((item) => ({ value: item.id, label: item.name, icon: <Terminal size={15} /> }))} />}
      <pre className="browser-output" aria-label="Terminal transcript">{output || "No output yet."}</pre>
    </section>
  );
}

