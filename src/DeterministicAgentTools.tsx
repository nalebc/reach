import { useEffect, useRef, useState } from "react";
import { createBrowserToolBridge, type BrowserTool, type BrowserToolBridge } from "./browser-tools";
import type { Peer } from "./api";
import "./deterministic-agent-tools.css";

type Field = { description?: string; maxLength?: number; default?: string; enum?: string[] };
type Result = { status?: string; completedSteps?: number; totalSteps?: number; error?: string; data?: unknown };
type Attempt = { requestId: string; args: Record<string, string>; unresolved: boolean };

/** The visual interface calls exactly the same named tools as MCP. */
export default function DeterministicAgentTools({ peer, ended }: { peer: Peer; ended: (error: unknown) => void }) {
  const [tools, setTools] = useState<BrowserTool[]>([]), [revision, setRevision] = useState(0);
  const [browser, setBrowser] = useState(""), [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState("");
  const [editor, setEditor] = useState(false), [definition, setDefinition] = useState(""), [reference, setReference] = useState("");
  const bridge = useRef<BrowserToolBridge | null>(null), busy = useRef(false), mounted = useRef(true);
  const attempts = useRef(new Map<string, Attempt>());
  useEffect(() => {
    mounted.current = true;
    const session = createBrowserToolBridge(peer, ended); bridge.current = session.bridge;
    return () => { mounted.current = false; session.dispose(); bridge.current = null; attempts.current.clear(); };
  }, [peer, ended]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (busy.current) return;
      try {
        const all = await bridge.current?.listTools();
        if (active && all) setTools(all.filter(tool => !!(tool.inputSchema.properties as Record<string, unknown>)?.browser && tool.name.startsWith("reach_tool_")));
      } catch (error) { if (active) { setTools([]); ended(error); } }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [peer, ended, revision]);
  const fields = (tool: BrowserTool) => tool.inputSchema.properties as Record<string, Field>;
  const browsers = tools[0] ? fields(tools[0]).browser.enum || [] : [];
  const selectedBrowser = browsers.includes(browser) ? browser : browsers[0] || "Chrome";
  const action = async (work: () => Promise<unknown>) => {
    if (busy.current || !bridge.current) return;
    busy.current = true; setPending(true); setError(""); setMessage("Running…"); setResult(null);
    try { await work(); }
    catch (error) { if (mounted.current) { setMessage(""); setError((error as Error).message); ended(error); } }
    finally { busy.current = false; if (mounted.current) { setPending(false); setRevision(value => value + 1); } }
  };
  const execute = (tool: BrowserTool) => action(async () => {
    let attempt = attempts.current.get(tool.name);
    if (!attempt?.unresolved) {
      const args = Object.fromEntries(Object.entries(fields(tool)).filter(([key]) => !["browser", "requestId"].includes(key)).flatMap(([key, field]) => {
        const value = values[tool.name]?.[key] ?? field.default ?? field.enum?.[0];
        return value === undefined || value === "" ? [] : [[key, value]];
      }));
      attempt = { requestId: crypto.randomUUID(), args: { ...args, browser: selectedBrowser }, unresolved: true };
      attempts.current.set(tool.name, attempt);
    }
    setMessage(`Running ${tool.title} · ${attempt.requestId}`);
    const response = await bridge.current!.callTool(tool.name, { ...attempt.args, requestId: attempt.requestId }) as Result;
    if (!mounted.current) return;
    // A lost response always retains its ID and original arguments for recovery.
    attempt.unresolved = response.status !== "completed";
    setResult(response);
    setMessage(`${response.status || "stopped"} · ${response.completedSteps || 0}/${response.totalSteps || 0} steps · ${attempt.requestId}`);
    if (response.status !== "completed") setError(`${response.error || "This run is still in progress."} Inspect the browser before starting another run. The same request ID will not repeat completed effects.`);
  });
  const openEditor = () => action(async () => {
    const protocol = await bridge.current!.callTool("reach_tool_protocol") as { example: unknown };
    const catalog = await bridge.current!.callTool("reach_tools");
    if (!mounted.current) return;
    setReference(JSON.stringify({ protocol, catalog }, null, 2));
    setDefinition(JSON.stringify(protocol.example, null, 2)); setEditor(true); setMessage("");
  });
  if (!tools.length) return null;
  return <div className="ap-deterministic-tools">
    <p>Deterministic browser tools</p>
    <p className="ap-quiet">Pick a named tool before repeating browser steps. Missing, ambiguous or changed targets stop the run. Chrome and Safari need Allow JavaScript from Apple Events enabled, and macOS Automation access for Reach’s Terminal.</p>
    {browsers.length > 1 && <label className="ap-tool-browser">Browser <select aria-label="Tool browser" value={selectedBrowser} disabled={pending} onChange={event => setBrowser(event.target.value)}>{browsers.map(value => <option key={value}>{value}</option>)}</select></label>}
    {tools.map(tool => <div className="ap-saved-tool" key={tool.name}>
      <p className="ap-quiet">{tool.description}</p>
      {Object.entries(fields(tool)).filter(([key]) => !["browser", "requestId"].includes(key)).map(([key, field]) => <label key={key}>
        <span>{field.description || key}</span>
        {field.enum ? <select aria-label={`${tool.title}: ${key}`} disabled={pending} value={values[tool.name]?.[key] ?? field.default ?? field.enum[0]} onChange={event => setValues(previous => ({ ...previous, [tool.name]: { ...previous[tool.name], [key]: event.target.value } }))}>{field.enum.map(value => <option key={value}>{value}</option>)}</select>
          : <input aria-label={`${tool.title}: ${key}`} disabled={pending} value={values[tool.name]?.[key] ?? field.default ?? ""} maxLength={field.maxLength || 2000} onChange={event => setValues(previous => ({ ...previous, [tool.name]: { ...previous[tool.name], [key]: event.target.value } }))} />}
      </label>)}
      <button className="ag-secondary" disabled={pending} onClick={() => void execute(tool)}>{tool.title}</button>
      {attempts.current.get(tool.name)?.unresolved && <button className="ag-secondary ag-small" disabled={pending} onClick={() => { attempts.current.delete(tool.name); setMessage("A new run will use a new request ID. Check the browser before executing it."); setRevision(value => value + 1); }}>Start another run</button>}
    </div>)}
    <button className="ag-secondary" disabled={pending} onClick={() => void openEditor()}>Create deterministic tool</button>
    {editor && <form onSubmit={event => { event.preventDefault(); void action(async () => {
      await bridge.current!.callTool("reach_define_tool", { definition: JSON.parse(definition) });
      if (mounted.current) { setEditor(false); setMessage("Saved. The new named tool is now in the list."); }
    }); }}>
      <p className="ap-quiet">Use reach.tool.v1, the same format as the built-in tools. Declare inputs, allowed HTTPS sites, fixed steps and a final result check. This saves the definition; its button executes it.</p>
      <details><summary>Protocol and built-in definitions</summary><pre>{reference}</pre></details>
      <textarea aria-label="Tool definition JSON" value={definition} maxLength={24000} rows={14} disabled={pending} onChange={event => setDefinition(event.target.value)} />
      <button className="ag-primary ag-small" disabled={pending}>Save deterministic tool</button>
      <button type="button" className="ag-secondary ag-small" disabled={pending} onClick={() => setEditor(false)}>Close editor</button>
    </form>}
    {message && <p className="ap-status" role="status">{message}</p>}
    {error && <p className="ap-status is-blocked" role="alert">{error}</p>}
    {result?.data !== undefined && <pre className="ap-tool-result" aria-label="Tool result">{JSON.stringify(result.data, null, 2)}</pre>}
  </div>;
}
