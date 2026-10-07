import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { request, type Peer } from "./api";
import type { BrowserRequest } from "./browser-approvals";
import { OptionButtons } from "./agent-ui";
import "./BrowserTerminal.css";

type TerminalAction = { type: "terminal" | "terminal-change" | "terminal-script"; command: string; root: number; cwd?: string };
type TerminalRecord = Omit<BrowserRequest, "action"> & { action: TerminalAction };
type Root = { name: string; path: string; index: number };
type Props = { peer: Peer; roots: Root[]; terminalApproval?: boolean; scriptApproval?: boolean; onError: (error: unknown) => void };
const active = (record: TerminalRecord) => ["pending", "executing"].includes(record.status);
const plain = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const commandRecord = (value: BrowserRequest) =>
  !!value && !!value.action && ["terminal", "terminal-change", "terminal-script"].includes(value.action.type);
const statusLabel = (record: TerminalRecord) => ({ pending: "Waiting for owner approval", executing: "Running…", executed: "Done", denied: "Denied", cancelled: "Cancelled", expired: "Expired", revoked: "Access revoked", failed: "Failed", blocked: "Blocked" })[record.status] || record.status;

export default function BrowserTerminal(props: Props) {
  const { peer } = props;
  const identity = JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId, props.terminalApproval, props.scriptApproval, props.roots]);
  return <BrowserTerminalSession key={identity} {...props} />;
}

function BrowserTerminalSession({ peer, roots, terminalApproval = false, scriptApproval = false, onError }: Props) {
  const [selectedRoot, setRoot] = useState(roots[0]?.index ?? 0);
  const root = roots.find((item) => item.index === selectedRoot) || roots[0];
  const [records, setRecords] = useState<TerminalRecord[]>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [reading, setReading] = useState(true);
  const [stopping, setStopping] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDraft = useRef("");
  const mounted = useRef(true);
  const submitting = useRef(false);
  const callbacks = useRef({ onError });
  callbacks.current = { onError };
  const operations = useRef(new Set<AbortController>());
  const transcript = useRef<HTMLDivElement>(null);
  const pending = records.some(active);
  const busy = sending || pending || reading;
  const history = records.map((item) => item.action.command).reverse();
  const latestDirectory = records.filter((item) => item.action.root === root?.index && item.status === "executed" && item.directory !== undefined)
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))[0];
  const cwd = latestDirectory?.directory || "";
  const folder = root ? `${root.path.replace(/\/$/, "")}${cwd ? `/${cwd}` : ""}` : "No shared folder";

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const operation of operations.current) operation.abort(); operations.current.clear(); };
  }, []);
  const merge = (incoming: TerminalRecord[]) => {
    setRecords((previous) => {
      const next = new Map(previous.map((item) => [item.id, item]));
      for (const item of incoming) {
        const old = next.get(item.id);
        // A history response taken before submission/cancellation completed must
        // not turn a finished command back into runnable pending work.
        if (old && !active(old) && active(item)) continue;
        next.set(item.id, item);
      }
      return [...next.values()].sort((a, b) => a.createdAt - b.createdAt);
    });
  };
  useEffect(() => {
    const controller = new AbortController();
    operations.current.add(controller);
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const list = await request<BrowserRequest[]>(peer, "/api/browser/terminal/history", { signal: controller.signal });
        if (mounted.current && !controller.signal.aborted) merge(Array.isArray(list) ? list.filter(commandRecord) as TerminalRecord[] : []);
      } catch (e) {
        if (mounted.current && !controller.signal.aborted) callbacks.current.onError(e);
      } finally {
        loading = false;
        if (mounted.current && !controller.signal.aborted) setReading(false);
      }
    };
    void refresh();
    const timer = pending ? setInterval(() => void refresh(), 1200) : undefined;
    return () => { controller.abort(); operations.current.delete(controller); clearInterval(timer); };
  }, [peer.id, peer.url, peer.token, peer.transport, peer.sessionId, pending, revision]);
  useEffect(() => { transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight, behavior: "smooth" }); }, [records]);

  const send = async () => {
    if (!root || busy || submitting.current || !command.trim()) return;
    const exact = command;
    submitting.current = true; setSending(true); setError(""); setHistoryIndex(-1);
    const controller = new AbortController(); operations.current.add(controller);
    try {
      const item = await request<BrowserRequest>(peer, "/api/browser/terminal", { method: "POST", body: JSON.stringify({ command: exact, root: root.index, cwd }), signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      if (!commandRecord(item)) throw new Error("The server returned an invalid terminal result.");
      merge([item as TerminalRecord]); setCommand(""); historyDraft.current = "";
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) {
        setError("The result could not be confirmed. Your command was not automatically retried.");
        callbacks.current.onError(e);
      }
    } finally {
      operations.current.delete(controller);
      if (mounted.current && !controller.signal.aborted) { submitting.current = false; setSending(false); }
    }
  };
  const cancel = async (item: TerminalRecord) => {
    if (stopping || !active(item)) return;
    const controller = new AbortController(); operations.current.add(controller); setStopping(item.id);
    try {
      const result = await request<BrowserRequest>(peer, `/api/browser/requests/${encodeURIComponent(item.id)}`, { method: "DELETE", signal: controller.signal });
      if (mounted.current && !controller.signal.aborted) merge([{ ...item, ...result, action: item.action, status: result.status || "cancelled" }]);
    } catch (e) { if (mounted.current && !controller.signal.aborted) callbacks.current.onError(e); }
    finally { operations.current.delete(controller); if (mounted.current && !controller.signal.aborted) setStopping(""); }
  };

  return <section className="browser-command-terminal" aria-label="Session terminal">
    <header className="browser-command-header">
      <div>
        {roots.length > 1 && <OptionButtons label="Terminal shared folder" value={root?.index ?? 0} disabled={busy} onChange={setRoot}
          options={roots.map((item) => ({ value: item.index, label: item.name, title: item.path }))} />}
        <span className="browser-command-cwd" aria-label="Terminal working folder">{plain(folder)}</span>
      </div>
      <button type="button" className="icon-button" aria-label="Refresh terminal history" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /></button>
    </header>
    <div ref={transcript} className="browser-command-transcript" role="log" aria-label="Command transcript" aria-live="polite">
      {!records.length && <p className="browser-command-welcome">{reading ? "Loading command history…" : "Ready. Try pwd, ls, or cat file."}</p>}
      {records.map((item) => <article className="browser-command-entry" key={item.id}>
        <div className="browser-command-line"><span aria-hidden="true">$</span><code>{plain(item.action.command)}</code></div>
        <div className="browser-command-state"><small>{statusLabel(item)}{item.approval === "session" ? " · Approved for this session" : ""}</small><small>{plain(item.folder || `${roots.find((folder) => folder.index === item.action.root)?.path || "Shared folder"}${item.action.cwd ? `/${item.action.cwd}` : ""}`)}</small>
          {active(item) && <button type="button" disabled={!!stopping} onClick={() => void cancel(item)}>{stopping === item.id ? "Stopping…" : item.status === "pending" ? "Cancel request" : "Stop command"}</button>}
        </div>
        {item.output !== undefined && <pre aria-label="Command output">{plain(item.output) || "(No output)"}</pre>}
        {item.error && <pre className="error" aria-label="Command error">{plain(item.error)}</pre>}
        {item.status === "cancelled" && <small className="browser-command-note">Any completed changes are not undone.</small>}
      </article>)}
      {sending && <p className="browser-command-state" role="status">Submitting command…</p>}
    </div>
    <form className="browser-command-prompt" aria-label="Terminal command prompt" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <span aria-hidden="true">$</span>
      <input aria-label="Terminal command" type="text" value={command} readOnly={busy} disabled={!root} aria-disabled={busy || !root} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" maxLength={4000}
        placeholder={busy ? "Waiting for this command to finish…" : "Enter a command"}
        onChange={(event) => { setCommand(event.target.value); setHistoryIndex(-1); }}
        onKeyDown={(event) => {
          if (busy || !["ArrowUp", "ArrowDown"].includes(event.key) || !history.length) return;
          event.preventDefault();
          if (event.key === "ArrowUp") {
            if (historyIndex === -1) historyDraft.current = command;
            const next = Math.min(historyIndex + 1, history.length - 1); setHistoryIndex(next); setCommand(history[next]);
          } else {
            const next = Math.max(-1, historyIndex - 1); setHistoryIndex(next); setCommand(next < 0 ? historyDraft.current : history[next]);
          }
        }} />
    </form>
    <div className="ag-ws-quick" role="group" aria-label="Example commands">
      <span>Try</span>
      {["pwd", "ls", "cd ..", "cat README.md", "head -n 20 README.md", "grep \"TODO\" README.md"].map((example) => <button key={example} type="button" disabled={busy || !root}
        aria-label={`Put ${example} in the prompt`} onClick={() => { setCommand(example); setHistoryIndex(-1); }}><code>{example}</code></button>)}
    </div>
    <p className="browser-command-policy">Read commands: pwd, cd, ls, cat, head, tail, wc, grep. Paths are relative to the working folder; no flags except head/tail -n and wc -l/-w/-c. {scriptApproval ? "Reads run immediately. Other commands ask for approval once. Scripts stay inside this folder." : terminalApproval ? "Read-only commands run immediately. Supported file changes need owner approval. Commands stay inside shared folders." : "Read-only commands run in your shared folders. Other commands are blocked."} All commands are logged.</p>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
