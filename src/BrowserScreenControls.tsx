import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ShieldCheck, X } from "lucide-react";
import { post, request, type Peer } from "./api";
import type { BrowserAction, BrowserRequest } from "./browser-approvals";
import "./BrowserScreenControls.css";

type ScreenAction = Exclude<BrowserAction, { type: "command" | "terminal" | "terminal-change" | "terminal-script" }>;
const terminalStatus = (status: string) => !["pending", "executing"].includes(status);
const keyNames: Record<string, Extract<ScreenAction, { type: "key" }>["key"]> = {
  Enter: "enter", Tab: "tab", Escape: "escape", Backspace: "backspace",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};
const actionLabel = (action: ScreenAction) => {
  if (action.type === "click") return action.button === "right" ? "Right-click" : action.count === 2 ? "Double-click" : "Click";
  if (action.type === "text") return `Type ${JSON.stringify(action.text).replace(/[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
  if (action.type === "key") return action.key === "enter" ? "Enter" : action.key[0].toUpperCase() + action.key.slice(1);
  return `Scroll ${action.direction}`;
};

type BrowserScreenControlsProps = {
  peer: Peer;
  src: string;
  alt: string;
  enabled: boolean;
  onError: (error: unknown) => void;
  onDraftChange?: (active: boolean) => void;
  onExecuted?: () => void;
};
export default function BrowserScreenControls(props: BrowserScreenControlsProps) {
  const { peer, enabled } = props;
  const identity = JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId, enabled]);
  return <BrowserScreenSession key={identity} {...props} />;
}

function BrowserScreenSession({ peer, src, alt, enabled, onError, onDraftChange, onExecuted }: BrowserScreenControlsProps) {
  const [actions, setActions] = useState<ScreenAction[]>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"click" | "double" | "right">("click");
  const [reason, setReason] = useState("");
  const [frozen, setFrozen] = useState("");
  const [record, setRecord] = useState<BrowserRequest | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const image = useRef<HTMLImageElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  const sendPending = useRef(false);
  const identity = JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId, enabled]);
  const mounted = useRef(true);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const callbacks = useRef({ onError, onDraftChange, onExecuted });
  callbacks.current = { onError, onDraftChange, onExecuted };
  const draftNotified = useRef<boolean | null>(null);
  const notifyDraft = (active: boolean) => {
    if (draftNotified.current === active) return;
    draftNotified.current = active;
    callbacks.current.onDraftChange?.(active);
  };
  const waiting = !!record && !terminalStatus(record.status);
  const locked = sending || waiting;
  const draftActive = enabled && (!!actions.length || !!text || locked);
  const draftActions = text ? [...actions, { type: "text", text } as ScreenAction] : actions;
  const shownActions = record && (locked || !actions.length) && record.action.type === "batch"
    ? record.action.actions as ScreenAction[] : draftActions;

  useEffect(() => {
    setActions([]); setText(""); setReason(""); setFrozen("");
    setRecord(null); setSending(false); setStopping(false); setError("");
    sendPending.current = false;
  }, [identity]);
  useEffect(() => {
    notifyDraft(draftActive);
  }, [draftActive]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; notifyDraft(false); };
  }, []);

  const finish = (next: BrowserRequest) => {
    setRecord(next);
    if (terminalStatus(next.status)) {
      setActions([]); setText(""); setFrozen(""); setReason("");
      // Refresh after any completed request: partial execution may have changed the screen.
      callbacks.current.onExecuted?.();
    }
  };
  useEffect(() => {
    if (!enabled || !record || terminalStatus(record.status)) return;
    const controller = new AbortController();
    let reading = false;
    let live = true;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const list = await request<BrowserRequest[]>(peer, "/api/browser/requests", { signal: controller.signal });
        if (!live || currentIdentity.current !== identity) return;
        const next = Array.isArray(list) ? list.find((item) => item.id === record.id) : undefined;
        if (next) finish(next);
        else if (record.status === "pending" && record.expiresAt <= Date.now()) finish({ ...record, status: "expired" });
      } catch (e) { if (live) callbacks.current.onError(e); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void refresh(), 1500);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [identity, record?.id, record?.status]);

  const freeze = () => {
    notifyDraft(true);
    if (!frozen) setFrozen(src);
    if (record && terminalStatus(record.status)) setRecord(null);
  };
  const staged = () => text ? [...actions, { type: "text", text } as ScreenAction] : [...actions];
  const stage = (action: ScreenAction) => {
    if (!enabled || locked || !src) return;
    const next = [...staged(), action];
    if (next.length > 5) { setError("You can request up to 5 actions at once. Remove an action or ask for approval."); return; }
    freeze(); setActions(next); setText(""); setError("");
  };
  const typeText = (value: string) => {
    if (!enabled || locked || !src) return;
    if (value && actions.length >= 5) { setError("This sequence already has 5 actions. Remove one before typing."); return; }
    if (value.length > 2000) { setError("Text is limited to 2,000 characters per action."); return; }
    if (value) freeze();
    else if (!actions.length) setFrozen("");
    setText(value); setError("");
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!enabled || locked || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = keyNames[event.key];
    // Tab keeps its normal navigation behavior; the toolbar stages a remote Tab.
    if (event.key === "Tab") return;
    if (key) { event.preventDefault(); stage({ type: "key", key }); }
    else if (event.key.length === 1) { event.preventDefault(); typeText(text + event.key); textField.current?.focus(); }
  };
  const send = async () => {
    const sequence = staged();
    if (!enabled || locked || !src || sendPending.current || !reason.trim() || !sequence.length || sequence.length > 5) return;
    const sentIdentity = identity;
    sendPending.current = true;
    setSending(true); setError(""); setActions(sequence); setText("");
    try {
      const next = await post<BrowserRequest>(peer, "/api/browser/requests", { type: "batch", actions: sequence, reason: reason.trim() });
      if (mounted.current && currentIdentity.current === sentIdentity) finish(next);
    } catch (e) {
      if (mounted.current && currentIdentity.current === sentIdentity) {
        setError("The request could not be confirmed. It was not automatically retried.");
        callbacks.current.onError(e);
      }
    } finally {
      if (mounted.current && currentIdentity.current === sentIdentity) { sendPending.current = false; setSending(false); }
    }
  };
  const stop = async () => {
    if (!record || !waiting || stopping) return;
    const sentIdentity = identity;
    setStopping(true);
    try {
      const next = await request<BrowserRequest>(peer, `/api/browser/requests/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      if (mounted.current && currentIdentity.current === sentIdentity) finish({ ...record, ...next, status: next.status || "cancelled" });
    } catch (e) { if (mounted.current && currentIdentity.current === sentIdentity) callbacks.current.onError(e); }
    finally { if (mounted.current && currentIdentity.current === sentIdentity) setStopping(false); }
  };

  return <section className="browser-direct-screen" aria-label={enabled ? "Screen controls" : "Shared screen, view only"}>
    <div className={`browser-direct-image${enabled && !locked ? " is-interactive" : ""}`}
      tabIndex={enabled && !locked ? 0 : undefined}
      aria-label={enabled ? "Shared screen. Click to add an action, or focus and type." : undefined}
      onKeyDown={keyboard}
      onClick={(event) => {
        if (!enabled || locked || !image.current) return;
        const bounds = image.current.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return;
        stage({ type: "click", x, y, button: mode === "right" ? "right" : "left", count: mode === "double" ? 2 : 1 });
        event.currentTarget.focus({ preventScroll: true });
      }}>
      {(frozen || src) && <img ref={image} className="browser-screen-image" src={frozen || src} alt={alt} draggable={false} />}
      {enabled && draftActive && shownActions.map((action, index) => action.type === "click" && <span key={index}
        className="browser-direct-marker" style={{ left: `${action.x * 100}%`, top: `${action.y * 100}%` }}
        aria-label={`Click ${index + 1}`}>{index + 1}</span>)}
    </div>
    {enabled && <>
      <div className="browser-direct-toolbar" aria-label="Screen action tools">
        <select aria-label="Click type" value={mode} disabled={locked || !src} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="click">Click</option><option value="double">Double-click</option><option value="right">Right-click</option>
        </select>
        {(["enter", "tab", "escape", "backspace"] as const).map((key) => <button key={key} type="button" className="button secondary small" disabled={locked || !src || staged().length >= 5}
          onClick={() => stage({ type: "key", key })}>{key[0].toUpperCase() + key.slice(1)}</button>)}
        <button type="button" className="button secondary small" aria-label="Add scroll up" disabled={locked || !src || staged().length >= 5} onClick={() => stage({ type: "scroll", direction: "up", amount: 3 })}><ArrowUp size={15} /> Scroll</button>
        <button type="button" className="button secondary small" aria-label="Add scroll down" disabled={locked || !src || staged().length >= 5} onClick={() => stage({ type: "scroll", direction: "down", amount: 3 })}><ArrowDown size={15} /> Scroll</button>
      </div>
      <p className="browser-direct-hint">{draftActive ? "Screen held while you prepare this request. Only the listed actions will run after approval." : "Click the screen and add what you need. Reach asks the owner to approve the sequence once."}</p>
      <label className="browser-direct-type">Type on the selected target
        <textarea ref={textField} aria-label="Text to type" placeholder="Click a field on the screen, then type here" value={text} rows={2} maxLength={2000} disabled={locked || !src} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => typeText(event.target.value)} />
        <small>Included automatically before your next action or when you ask for approval.</small>
      </label>
      {!!shownActions.length && <ol className="browser-direct-actions" aria-label="Screen action sequence">
        {shownActions.map((action, index) => <li key={index}>
          <span>{index + 1}. {actionLabel(action)}</span>
          {record && <small>{record.steps?.[index]?.status || record.status}</small>}
          {!locked && !record && <button type="button" aria-label={`Remove action ${index + 1}`} onClick={() => {
            if (index === actions.length && text) { setText(""); if (!actions.length) setFrozen(""); }
            else { const next = actions.filter((_, i) => i !== index); setActions(next); if (!next.length && !text) setFrozen(""); }
            setError("");
          }}><X size={13} /></button>}
        </li>)}
      </ol>}
      {(!!actions.length || !!text) && !record && <div className="browser-direct-submit">
        <label>What are you doing?<input aria-label="Reason for screen request" maxLength={1000} value={reason} disabled={locked || !src} placeholder="For example, search the project notes" onChange={(event) => setReason(event.target.value)} /></label>
        <button type="button" className="button" disabled={locked || !reason.trim()} onClick={() => void send()}><ShieldCheck size={16} />{sending ? "Sending…" : `Ask approval · ${staged().length}`}</button>
      </div>}
      {record && <div className="browser-direct-result" role="status">
        <span>{record.status === "pending" ? "Waiting for owner approval" : record.status === "executing" ? "Running approved actions" : record.status === "executed" ? "Done" : record.status} · {record.completedCount || 0}/{record.action.type === "batch" ? record.action.actions.length : 1} completed</span>
        {waiting && <button type="button" className="button secondary small" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : record.status === "pending" ? "Cancel request" : "Stop remaining actions"}</button>}
        {record.error && <p className="error">{record.error}</p>}
        {record.status === "cancelled" && <small>Completed actions are not undone.</small>}
      </div>}
      {error && <p role="alert" className="error">{error}</p>}
    </>}
  </section>;
}
