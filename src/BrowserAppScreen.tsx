import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Lock, Monitor, RefreshCw } from "lucide-react";
import { peerFetch, request, type Peer } from "./api";
import type { BrowserRequest } from "./browser-approvals";
import AppLogo from "./AppLogo";
import { OptionButtons } from "./agent-ui";

type SharedApp = { id: string; name: string; mode: "hidden" | "view" | "control"; protected: boolean; reason?: string };
type AppWindow = { id: string; title: string; width: number; height: number };
type Input = { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: "enter" | "backspace" | "tab" | "escape" | "left" | "right" | "up" | "down" }
  | { type: "scroll"; direction: "up" | "down"; amount: number };
const words = { hidden: "Hidden", view: "View only", control: "View & control" };
const keys: Record<string, Extract<Input, { type: "key" }>["key"]> = {
  Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

export default function BrowserAppScreen({ peer, expiresAt, onError }: {
  peer: Peer; expiresAt: number; onError: (error: unknown) => void;
}) {
  const [catalog, setCatalog] = useState<{ apps: SharedApp[]; requests: BrowserRequest[] } | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [expired, setExpired] = useState(expiresAt <= Date.now());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const requesting = useRef<AbortController | null>(null);
  const failure = useRef(onError);
  failure.current = onError;
  useEffect(() => {
    // Clamped: a longer delay overflows and fires at once (Always access ends years out).
    const timer = setTimeout(() => setExpired(true), Math.min(2147483647, Math.max(0, expiresAt - Date.now())));
    return () => { clearTimeout(timer); requesting.current?.abort(); };
  }, [expiresAt]);
  useEffect(() => {
    if (expired) { setCatalog(null); requesting.current?.abort(); return; }
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await request<{ apps: SharedApp[]; requests: BrowserRequest[] }>(peer, "/api/browser/apps", { signal: controller.signal });
        if (!controller.signal.aborted) { setCatalog({ ...value, apps: value.apps.map(app => app.mode === "control" ? { ...app, mode: "view" } : app) }); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) {
          setCatalog(null); setError((e as Error).message); failure.current(e);
        }
      } finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [peer.url, peer.token, expired, revision]);
  const app = catalog?.apps.find((entry) => entry.id === selected)
    || catalog?.apps.find((entry) => entry.mode !== "hidden" && !entry.protected)
    || catalog?.apps[0];
  const latestRequest = catalog?.requests.filter((item) => item.action.type === "app-access" && item.action.appId === app?.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const pending = catalog?.requests.find((item) => item.action.type === "app-access" && item.action.appId === app?.id && item.status === "pending" && item.expiresAt > Date.now());
  const ask = async (mode: "view" | "control") => {
    if (!app || app.protected || requesting.current || expired || pending) return;
    const controller = new AbortController();
    requesting.current = controller;
    setBusy(true); setError(""); setNote("");
    try {
      const item = await request<BrowserRequest>(peer, "/api/browser/apps/requests", {
        method: "POST", signal: controller.signal, body: JSON.stringify({ appId: app.id, mode }),
      });
      if (!controller.signal.aborted) {
        setCatalog((current) => current ? { ...current, requests: [item, ...current.requests.filter((old) => old.id !== item.id)] } : current);
        setNote("Request sent. The owner can allow access for this session.");
      }
    } catch (e) {
      if (!controller.signal.aborted) { setError((e as Error).message); failure.current(e); }
    } finally {
      if (requesting.current === controller) requesting.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <section className="browser-app-screen" aria-label="Shared apps">
    <div className="browser-section-heading">
      <div><h2>Screen</h2><p className="browser-policy">Choose an app, then a window. View only: you can’t click or type in these windows.</p></div>
      <button className="ag-secondary ag-small" disabled={expired} onClick={() => setRevision((n) => n + 1)}><RefreshCw size={15} /> Refresh apps</button>
    </div>
    {expired ? <p className="browser-empty" role="status">This invitation has expired.</p> : <>
      {catalog && !!catalog.apps.length && <div className="browser-app-picker ag-ws-apps">
        <p className="ag-label">Apps on this computer</p>
        <OptionButtons label="Shared app" value={app?.id || ""} onChange={(id) => { setSelected(id); setNote(""); }}
          options={catalog.apps.map((entry) => ({
            value: entry.id,
            label: entry.name,
            detail: entry.protected ? "Private" : entry.mode === "hidden" ? "Ask to view" : words[entry.mode],
            icon: entry.protected ? <Lock size={16} /> : <AppLogo peer={peer} name={entry.name} />,
          }))} />
      </div>}
      {app && !app.protected && app.mode !== "hidden" ? <BrowserAppWindows
        key={JSON.stringify([app.id, app.mode, peer.url, peer.token])} app={app} peer={peer} onError={onError} />
        : <div className="browser-app-placeholder" role="status"><Lock size={28} />
          <strong>{app ? `${app.name} is ${app.protected ? "protected" : "hidden"}` : catalog ? "No apps available" : "Loading apps…"}</strong>
          <span>{app?.protected ? app.reason || "This app cannot be shared with an agent." : app ? "Ask the owner to share this app." : "Apps must be open on the computer to appear here."}</span>
        </div>}
      {app && !app.protected && app.mode !== "control" && <div className="browser-app-request">
        {pending ? <p role="status">Waiting for the owner to allow {pending.action.type === "app-access" && pending.action.mode === "control" ? "control" : "viewing"} of {app.name}.</p> : <>
          {app.mode === "hidden" && <button className="ag-primary ag-small" disabled={busy} onClick={() => void ask("view")}>Ask to view</button>}
        </>}
      </div>}
      {latestRequest && !pending && app?.mode !== "control" && ["denied", "expired", "cancelled", "revoked"].includes(latestRequest.status)
        ? <p className="browser-policy" role="status">{latestRequest.status === "denied" ? `The owner denied access to ${app?.name}.` : `The access request ${latestRequest.status}.`}</p>
        : note && <p className="browser-policy" role="status">{note}</p>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function BrowserAppWindows({ app, peer, onError }: { app: SharedApp; peer: Peer; onError: (error: unknown) => void }) {
  const [windows, setWindows] = useState<AppWindow[] | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const failure = useRef(onError); failure.current = onError;
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await request<{ windows: AppWindow[] }>(peer, `/api/browser/apps/windows?${new URLSearchParams({ appId: app.id })}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setWindows(result.windows); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) { setWindows(null); setError((e as Error).message); failure.current(e); }
      } finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [peer.url, peer.token, app.id, app.mode]);
  const current = windows?.find((entry) => entry.id === selected) || windows?.[0];
  return <>
    {!!windows?.length && <div className="browser-app-window-picker ag-ws-windows">
      <p className="ag-label">{app.name} windows</p>
      <OptionButtons label="Shared app window" value={current?.id || ""} onChange={setSelected}
        options={windows.map((entry) => ({ value: entry.id, label: entry.title || app.name }))} />
    </div>}
    {current ? <BrowserWindowSurface key={JSON.stringify([current.id, current.width, current.height])} target={current} peer={peer} control={false} appName={app.name} onError={onError} />
      : <div className="browser-app-placeholder" role="status"><Monitor size={28} /><span>{windows ? "No shareable windows are open. Open a window on the computer to continue." : error || "Loading shared windows…"}</span></div>}
  </>;
}

function BrowserWindowSurface({ target, peer, control, appName, onError }: {
  target: AppWindow; peer: Peer; control: boolean; appName: string; onError: (error: unknown) => void;
}) {
  const [image, setImage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const capture = useRef<AbortController | null>(null);
  const input = useRef<AbortController | null>(null);
  const object = useRef("");
  const mounted = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);
  const epoch = useRef(0);
  const lastWheel = useRef(0);
  const failure = useRef(onError); failure.current = onError;
  const clearImage = useCallback(() => {
    if (object.current) URL.revokeObjectURL(object.current);
    object.current = "";
    if (mounted.current) { setImage(""); setLoaded(false); }
  }, []);
  const refresh = useCallback(async () => {
    if (!mounted.current || capture.current) return;
    const controller = new AbortController(); capture.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await peerFetch(peer, `/api/browser/apps/screen?${new URLSearchParams({ target: target.id })}`, {
        signal: controller.signal, cache: "no-store", redirect: "error",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(Error(body.error || "This window is no longer available."), { status: response.status });
      }
      const blob = await response.blob();
      if (controller.signal.aborted || !mounted.current) return;
      if (!blob.type.startsWith("image/")) throw Error("The shared window could not be displayed.");
      const next = URL.createObjectURL(blob);
      if (object.current) URL.revokeObjectURL(object.current);
      object.current = next; setImage(next);
    } catch (e) {
      if (mounted.current) {
        clearImage();
        setError(controller.signal.aborted ? "Window refresh timed out. Retrying…" : (e as Error).message);
        if (!controller.signal.aborted) failure.current(e);
      }
    } finally {
      clearTimeout(timeout);
      if (capture.current === controller) capture.current = null;
    }
  }, [peer.url, peer.token, target.id, clearImage]);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      await refresh();
      if (mounted.current) timer = setTimeout(() => void read(), 1000);
    };
    void read();
    return () => {
      mounted.current = false; epoch.current++; clearTimeout(timer);
      capture.current?.abort(); input.current?.abort(); clearImage();
    };
  }, [refresh, clearImage]);
  const send = (action: Input) => {
    if (!control || !loaded || !image || !mounted.current) return;
    if (queued.current >= 32) { setError("Input is catching up. Wait a moment before continuing."); return; }
    const generation = epoch.current;
    queued.current++;
    setBusy(true);
    queue.current = queue.current.then(async () => {
      if (!mounted.current || epoch.current !== generation) return;
      const controller = new AbortController(); input.current = controller;
      try {
        await request(peer, "/api/browser/apps/input", { method: "POST", signal: controller.signal, body: JSON.stringify({ target: target.id, action }) });
        if (mounted.current && !controller.signal.aborted) { setError(""); await refresh(); }
      } catch (e) {
        epoch.current++;
        if (mounted.current && !controller.signal.aborted) {
          clearImage(); setError((e as Error).message); failure.current(e);
        }
      } finally { if (input.current === controller) input.current = null; }
    }).finally(() => {
      queued.current--;
      if (mounted.current && !queued.current) setBusy(false);
    });
  };
  return <>
    <div className={`browser-app-surface${control ? " can-control" : ""}`} role="group" aria-label={`${appName} window${control ? " controls" : " view"}`}
      tabIndex={control ? 0 : -1}
      onKeyDown={(event) => {
        if (!control) return;
        if (event.metaKey || event.ctrlKey || event.altKey) {
          // Keep local copy/paste available. Never send global shortcuts to the host.
          if (!(event.key.toLowerCase() === "v" && (event.metaKey || event.ctrlKey))) event.preventDefault();
          return;
        }
        event.preventDefault();
        if (keys[event.key]) send({ type: "key", key: keys[event.key] });
        else if (event.key.length === 1) send({ type: "text", text: event.key });
      }}
      onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData("text/plain"); if (text) send({ type: "text", text }); }}
      onWheel={(event) => {
        if (!control || !event.deltaY) return;
        event.preventDefault();
        if (Date.now() - lastWheel.current < 200) return;
        lastWheel.current = Date.now();
        send({ type: "scroll", direction: event.deltaY < 0 ? "up" : "down", amount: Math.min(5, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 100))) });
      }}>
      {image ? <img src={image} alt={`Shared window of ${appName}`} draggable={false}
        onLoad={() => setLoaded(true)} onError={() => { clearImage(); setError("The shared window could not be displayed."); }}
        onClick={(event) => {
          if (!control) return;
          event.currentTarget.parentElement?.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          const natural = event.currentTarget.naturalWidth / event.currentTarget.naturalHeight;
          if (!rect.width || !rect.height || !Number.isFinite(natural)) return;
          const width = Math.min(rect.width, rect.height * natural);
          const height = width / natural;
          const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
          const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) send({ type: "click", x, y });
        }} /> : <div className="browser-app-placeholder" role="status"><Monitor size={28} /><span>{error || "Opening shared window…"}</span></div>}
    </div>
    <div className="browser-screen-footer">
      <p className="browser-policy">{control ? busy ? "Sending input…" : "Click the window, then type. Only this app receives input." : "View only. App control requires an isolated environment."}</p>
      <div className="browser-screen-actions">
        {control && <><button className="button secondary small" disabled={!loaded} onClick={() => send({ type: "scroll", direction: "up", amount: 3 })}><ArrowUp size={15} /> Scroll up</button>
          <button className="button secondary small" disabled={!loaded} onClick={() => send({ type: "scroll", direction: "down", amount: 3 })}><ArrowDown size={15} /> Scroll down</button></>}
        <button className="ag-secondary ag-small" onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
      </div>
    </div>
    {error && image && <p className="error" role="alert">{error}</p>}
  </>;
}
