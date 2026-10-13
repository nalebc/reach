import { useEffect, useRef, useState } from "react";
import { Trash, Zap } from "lucide-react";
import { request, type Peer } from "./api";
import { usePageVisible } from "./page-visible";
import { SwitchLine } from "./agent-ui";
import { ErrorLine } from "./ui";
import "./agent-shortcuts.css";

type Step = {
  type: "open" | "website" | "input" | "action";
  app?: string;
  url?: string;
  input?: string;
  action?: {
    type: string;
    key?: string;
    modifiers?: string[];
    x?: number;
    y?: number;
  };
  context?: { bundle: string; fingerprint?: string; title?: string };
};
type Shortcut = { id: string; name: string; enabled: boolean; steps: Step[] };
// The Mac's own Shortcuts (the Shortcuts app): which ones agents may run.
type MacShortcut = { name: string; allowed: boolean };
type Running = { runId: string; name: string; completedSteps: number; totalSteps: number; cancelled?: boolean };
const appName = (value?: string) =>
  value
    ?.split("/")
    .at(-1)
    ?.replace(/\.app$/, "") || "app";
function stepWords(step: Step) {
  if (step.type === "open") return `Open ${appName(step.app)}`;
  if (step.type === "website")
    return step.input ? `Open website from ${step.input} in ${appName(step.app)}` : `Open ${step.url} in ${appName(step.app)}`;
  if (step.type === "input")
    return `Type ${step.input} (supplied by the agent when run)`;
  const action = step.action!;
  if (action.type === "key")
    return `Press ${[...(action.modifiers || []), action.key].join(" + ")}`;
  return `${action.type[0].toUpperCase() + action.type.slice(1)} at ${Math.round((action.x || 0) * 100)}%, ${Math.round((action.y || 0) * 100)}%`;
}

export default function AgentShortcuts({
  peer,
  toast,
  bare = false,
}: {
  peer: Peer;
  toast: (message: string) => void;
  // In its own sheet: the list itself, no fold around it.
  bare?: boolean;
}) {
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [macShortcuts, setMacShortcuts] = useState<MacShortcut[] | null>(null);
  const [macError, setMacError] = useState("");
  const [running, setRunning] = useState<Running | null>(null);
  const [stopRequested, setStopRequested] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const visible = usePageVisible();
  const alive = useRef(true),
    busy = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const controller of controllers.current) controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await request<{ shortcuts: Shortcut[]; running?: Running | null }>(
          peer,
          "/api/agents/shortcuts",
          { signal: controller.signal },
        );
        if (!Array.isArray(next.shortcuts))
          throw Error("Saved shortcuts could not be loaded.");
        if (!controller.signal.aborted) {
          setShortcuts(next.shortcuts);
          setRunning(next.running || null);
          setError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      } finally {
        reading = false;
      }
      try {
        const mac = await request<{ shortcuts: MacShortcut[] }>(peer, "/api/agents/mac-shortcuts", { signal: controller.signal });
        if (!controller.signal.aborted && Array.isArray(mac.shortcuts)) { setMacShortcuts(mac.shortcuts); setMacError(""); }
      } catch (failure) {
        // A Mac without Shortcuts, or an older Reach: the section stays out.
        if (!controller.signal.aborted) { setMacShortcuts((old) => old ?? []); setMacError((failure as Error).message); }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.url, peer.token, revision, visible]);
  const mutate = async (item: Shortcut, method: "PATCH" | "DELETE") => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      await request(peer, `/api/agents/shortcuts/${item.id}`, {
        method,
        body: JSON.stringify(
          method === "PATCH" ? { enabled: !item.enabled } : {},
        ),
        signal: controller.signal,
      });
      if (!alive.current || controller.signal.aborted) return;
      setShortcuts((old) =>
        method === "DELETE"
          ? old.filter((entry) => entry.id !== item.id)
          : old.map((entry) =>
              entry.id === item.id
                ? { ...entry, enabled: !entry.enabled }
                : entry,
            ),
      );
      toast(
        method === "DELETE"
          ? "Shortcut deleted"
          : item.enabled
            ? "Shortcut disabled"
            : "Shortcut enabled",
      );
      setRevision((value) => value + 1);
    } catch (failure) {
      if (alive.current && !controller.signal.aborted)
        setError((failure as Error).message);
    } finally {
      clearTimeout(timeout);
      controllers.current.delete(controller);
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  const stop = async () => {
    if (!running || running.cancelled || stopRequested === running.runId || busy.current) return;
    const runId = running.runId;
    busy.current = true;
    setPending(true);
    setError("");
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      await request(peer, "/api/agents/shortcuts/cancel", {
        method: "POST", body: JSON.stringify({ runId }), signal: controller.signal,
      });
      if (!alive.current || controller.signal.aborted) return;
      setStopRequested(runId);
      setRunning((current) => current?.runId === runId ? { ...current, cancelled: true } : current);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) setError((failure as Error).message);
    } finally {
      clearTimeout(timeout);
      controllers.current.delete(controller);
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  const allowMac = async (item: MacShortcut, allowed: boolean) => {
    setMacShortcuts((old) => (old || []).map((entry) => (entry.name === item.name ? { ...entry, allowed } : entry)));
    try {
      await request(peer, "/api/agents/mac-shortcuts", { method: "POST", body: JSON.stringify({ name: item.name, allowed }) });
      if (alive.current) { setMacError(""); toast(allowed ? `Agents may run “${item.name}”` : `“${item.name}” is yours again`); }
    } catch (failure) {
      if (!alive.current) return;
      setMacShortcuts((old) => (old || []).map((entry) => (entry.name === item.name ? { ...entry, allowed: !allowed } : entry)));
      setMacError((failure as Error).message);
    }
  };
  const stopping = !!running && (running.cancelled || stopRequested === running.runId);
  const list = (
    <div className="as-body">
      <p className="ag-quiet">
        Agents save successful tasks here and reuse them in one call. Every
        replay stays within the agent’s current access.
      </p>
      <ErrorLine error={error} />
      {running && (
        <div className="as-card as-card-body" aria-live="polite">
          <strong>{running.name} · {running.completedSteps}/{running.totalSteps} steps</strong>
          <p className="ag-quiet">
            {stopping ? "Stop requested. Waiting for the current action to finish; no further steps will start."
              : "This shortcut is running. Stopping prevents further steps; completed actions stay applied."}
          </p>
          <button className="ag-secondary ag-small" disabled={pending || stopping} onClick={() => void stop()}>
            {stopping ? "Stopping…" : "Stop shortcut"}
          </button>
        </div>
      )}
      {shortcuts.map((item) => (
        <details className="as-card" key={item.id}>
          <summary>
            <strong>{item.name}</strong>
            <span>
              {item.steps.length} {item.steps.length === 1 ? "step" : "steps"} ·{" "}
              {item.enabled ? "Available to agents" : "Disabled"}
            </span>
          </summary>
          <div className="as-card-body">
            <ol className="ag-steps">
              {item.steps.map((step, index) => (
                <li key={index}>
                  {stepWords(step)}
                  {step.context?.fingerprint && (
                    <small>Recorded window and focus fingerprint</small>
                  )}
                </li>
              ))}
            </ol>
            <div className="as-actions">
              <button
                className="ag-secondary ag-small"
                disabled={pending}
                onClick={() => void mutate(item, "PATCH")}
              >
                {item.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="ag-secondary ag-small"
                disabled={pending}
                aria-label={`Delete ${item.name}`}
                onClick={() => void mutate(item, "DELETE")}
              >
                <Trash size={14} /> Delete
              </button>
            </div>
          </div>
        </details>
      ))}
      {!shortcuts.length && (
        <p className="ag-quiet">
          The agent records and saves tasks itself.
        </p>
      )}
      <p className="ag-quiet">
        Passwords are never saved; you sign in when asked.
      </p>
      {macShortcuts && (macShortcuts.length > 0 || macError) && (
        <>
          <p className="ag-quiet as-mac-title">
            <strong>Your Mac’s shortcuts.</strong> An agent runs one you switch on in a single step, with its text in and out.
            Asking for one that’s off tells you here.
          </p>
          <ErrorLine error={macError} />
          <div className="as-mac-list">
            {macShortcuts.map((item) => (
              <SwitchLine
                key={item.name}
                title={item.name}
                detail={item.allowed ? "Agents may run it" : undefined}
                checked={item.allowed}
                label={`Agents may run ${item.name}`}
                onChange={(on) => void allowMac(item, on)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
  if (bare) return list;
  return (
    <details className="as-shortcuts">
      <summary>
        <Zap size={17} />
        <strong>Agent shortcuts</strong>
        <span>{shortcuts.length || "No saved tasks yet"}</span>
      </summary>
      {list}
    </details>
  );
}
