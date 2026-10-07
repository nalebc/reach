import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, Play, Terminal } from "lucide-react";
import { request, type Peer } from "./api";
import { OptionButtons } from "./agent-ui";
import "./agent-desktop.css";

// The shell for a Full control agent: one command, its folder, its output,
// and the session's history. Refused commands say why, in the owner's words.
type Root = { index: number; name: string; path: string };
type Record_ = { id: string; status: string; action: { type: string; command: string; cwd?: string }; output?: string; error?: string; exitCode?: number | null; createdAt: number; folder?: string; directory?: string };
const words: Record<string, string> = { executed: "Ran", executing: "Running", blocked: "Refused", failed: "Failed", interrupted: "Interrupted", pending: "Waiting" };
type Props = { peer: Peer; roots: Root[]; onError: (error: unknown) => void };
export default function AgentShell({ peer, roots, onError }: Props) {
  const [command, setCommand] = useState("");
  const [root, setRoot] = useState(roots[0]?.index ?? 0);
  const [cwd, setCwd] = useState("");
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<Record_ | null>(null);
  const [history, setHistory] = useState<Record_[]>([]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentRoot = roots.some((item) => item.index === root) ? root : roots[0]?.index ?? 0;
  const loadHistory = async () => {
    try {
      const items = await request<Record_[]>(peer, "/api/browser/shell/history");
      if (mounted.current) setHistory([...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30));
    } catch (e) { onError(e); }
  };
  useEffect(() => { void loadHistory(); }, [peer.url, peer.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    const value = command.trim();
    if (!value || running) return;
    setRunning(true);
    try {
      const result = await request<Record_>(peer, "/api/browser/shell", {
        method: "POST", body: JSON.stringify({ command: value, root: currentRoot, cwd }),
      });
      if (!mounted.current) return;
      setLast(result);
      if (result.status !== "blocked") setCommand("");
      void loadHistory();
    } catch (e) {
      if (mounted.current) onError(e);
    } finally { if (mounted.current) setRunning(false); }
  };
  return (
    <section className="ag-shell" aria-labelledby="agent-shell-title">
      <div className="browser-section-heading ag-ws-section-head">
        <div>
          <h2 id="agent-shell-title">Terminal</h2>
          <p className="browser-policy">Commands run as the owner, from the folder below, up to 60 seconds each. Everything is logged for them.</p>
        </div>
      </div>
      {roots.length > 1 && (
        <OptionButtons label="Shared folder" value={currentRoot} onChange={(index) => { setRoot(Number(index)); setCwd(""); }}
          options={roots.map((folder) => ({ value: folder.index, label: folder.name, icon: <Folder size={16} />, title: folder.path }))} />
      )}
      <form className="ag-shell-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label className="ag-search ag-shell-cwd">
          <Folder size={15} aria-hidden="true" />
          <input aria-label="Working folder" placeholder={`Subfolder of ${roots.find((item) => item.index === currentRoot)?.name || "the shared folder"} (optional)`} value={cwd} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setCwd(event.target.value)} />
        </label>
        <label className="ag-search ag-shell-command">
          <Terminal size={15} aria-hidden="true" />
          <input aria-label="Command" placeholder="ls -la" value={command} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setCommand(event.target.value)} />
        </label>
        <button className="ag-primary ag-small" type="submit" disabled={!command.trim() || running}><Play size={14} /> {running ? "Running…" : "Run"}</button>
      </form>
      {last && (
        <article className={`ag-shell-result is-${last.status}`} aria-label="Last command">
          <p><strong>{words[last.status] || last.status}</strong> <code>{last.action.command}</code>{typeof last.exitCode === "number" && last.exitCode !== 0 ? <small> · exit {last.exitCode}</small> : null}</p>
          {last.error && <p className="ag-shell-refusal" role="alert">{last.error}</p>}
          {last.output !== undefined && <pre className="browser-output" aria-label="Command output">{last.output || "(no output)"}</pre>}
        </article>
      )}
      <details className="ag-fold">
        <summary>History <span className="ag-fold-count">{history.length}</span> <ChevronDown size={15} /></summary>
        {history.length ? (
          <ol className="ag-log">
            {history.map((item) => (
              <li key={item.id} className={`is-${item.status}`}>
                <div><strong>{words[item.status] || item.status}</strong><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString()}</time></div>
                <code>{item.action.command}</code>
                {item.error && <p className="ag-shell-refusal">{item.error}</p>}
                {item.output && <details><summary>Output</summary><pre>{item.output}</pre></details>}
              </li>
            ))}
          </ol>
        ) : <p className="ag-quiet">No commands yet.</p>}
      </details>
    </section>
  );
}
