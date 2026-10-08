import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Zap } from "lucide-react";
import { request, type Peer } from "./api";
import {
  createBrowserToolBridge,
  type BrowserTool,
  type BrowserToolBridge,
} from "./browser-tools";

type Recording = { name: string; stepCount: number; error: string };
type RunResult = {
  status?: string;
  completedSteps?: number;
  totalSteps?: number;
  error?: string;
  enabled?: boolean;
};
export default function SavedAgentTools({
  peer,
  ended,
}: {
  peer: Peer;
  ended: (error: unknown) => void;
}) {
  // Parent callbacks and equivalent peer objects can change while a replay runs.
  // Only a changed connection must cancel it; current callbacks still receive failures.
  const connection = useMemo(() => peer, [peer.id, peer.url, peer.token, peer.transport, peer.sessionId]);
  const onEnded = useRef(ended);
  onEnded.current = ended;
  const [tools, setTools] = useState<BrowserTool[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [values, setValues] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [revision, setRevision] = useState(0);
  const bridge = useRef<BrowserToolBridge | null>(null);
  const mounted = useRef(true),
    busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const session = createBrowserToolBridge(connection, (failure) => {
      if (bridge.current === session.bridge) onEnded.current(failure);
    });
    bridge.current = session.bridge;
    busy.current = false;
    setPending(false);
    setTools([]);
    setRecording(null);
    setValues({});
    setMessage("");
    setError("");
    return () => {
      mounted.current = false;
      session.dispose();
      bridge.current = null;
    };
  }, [connection]);
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading || !bridge.current) return;
      reading = true;
      const results = await Promise.allSettled([
        bridge.current.listTools(),
        request<{ recording: Recording | null }>(
          connection,
          "/api/browser/shortcuts",
          { signal: controller.signal },
        ),
      ]);
      if (!controller.signal.aborted && mounted.current) {
        const [catalog, progress] = results;
        if (catalog.status === "fulfilled")
          setTools(
            catalog.value.filter((tool) =>
              tool.name.startsWith("reach_saved_"),
            ),
          );
        else {
          setTools([]);
          setError(catalog.reason.message);
          onEnded.current(catalog.reason);
        }
        if (progress.status === "fulfilled")
          setRecording(progress.value.recording);
        else {
          setRecording(null);
          setError(progress.reason.message);
          onEnded.current(progress.reason);
        }
      }
      reading = false;
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [connection, revision]);
  const call = async (toolName: string, args: object) => {
    if (busy.current || !bridge.current) return;
    const activeBridge = bridge.current;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("Running…");
    try {
      const result = (await activeBridge.callTool(
        toolName,
        args,
      )) as RunResult;
      if (!mounted.current || bridge.current !== activeBridge) return;
      if (result.status === "stopped")
        setError(
          `Stopped after ${result.completedSteps}/${result.totalSteps} steps. ${result.error} Completed actions stay applied. Inspect the screen before continuing.`,
        );
      setMessage(
        result.status === "completed"
          ? `Executed ${result.completedSteps} step${result.completedSteps === 1 ? "" : "s"}. Check the screen to verify the task succeeded.`
          : result.status === "stopped"
            ? ""
            : toolName === "reach_save_shortcut"
              ? result.enabled === false
                ? "Saved. The owner has disabled this task, so it remains unavailable until they enable it."
                : "Saved. The task is now a tool in the list."
              : toolName === "reach_record_shortcut"
                ? "Recording your app actions. Save after verifying success."
                : "Recording discarded.",
      );
      setRevision((value) => value + 1);
    } catch (failure) {
      if (mounted.current && bridge.current === activeBridge) {
        setMessage("");
        setError((failure as Error).message);
        onEnded.current(failure);
      }
    } finally {
      if (mounted.current && bridge.current === activeBridge) {
        busy.current = false;
        setPending(false);
      }
    }
  };
  return (
    <section
      className="ap-card ap-saved-tools"
      aria-labelledby="ap-saved-tools"
    >
      <h2 id="ap-saved-tools">
        <Zap size={16} /> Saved tools
      </h2>
      <p className="ap-quiet">
        Check this list before starting a laptop task. Pick a matching saved
        task and click it to execute its steps. If you use Reach MCP, these
        tasks also appear in its tool list; use reach_shortcuts to search or
        inspect them.
      </p>
      <div className="ap-saved-list">
        {tools.map((tool) => {
          const inputs = (tool.inputSchema.required || []) as string[];
          return (
            <div className="ap-saved-tool" key={tool.name}>
              {inputs.map((input) => (
                <label key={input}>
                  {tool.title} · {input}
                  <input
                    aria-label={`${tool.title} ${input}`}
                    autoComplete="off"
                    maxLength={2000}
                    placeholder="Text for this run only"
                    value={values[tool.name]?.[input] || ""}
                    onChange={(event) =>
                      setValues((old) => ({
                        ...old,
                        [tool.name]: {
                          ...old[tool.name],
                          [input]: event.target.value,
                        },
                      }))
                    }
                  />
                </label>
              ))}
              <button
                type="button"
                className="ag-primary ag-small"
                disabled={
                  pending ||
                  !!recording ||
                  inputs.some((input) => !values[tool.name]?.[input]?.trim())
                }
                onClick={() => {
                  const args = values[tool.name] || {};
                  setValues((old) => ({ ...old, [tool.name]: {} }));
                  void call(tool.name, args);
                }}
              >
                <Play size={14} /> {tool.title}
              </button>
            </div>
          );
        })}
        {!tools.length && (
          <p className="ap-quiet">
            No saved tools for your current app access. Record a reusable task
            below to add one.
          </p>
        )}
      </div>
      <p className="ap-quiet">
        {recording
          ? "Use the screen and app controls below as usual. Reach records successful actions. Verify the result, then click Save as tool."
          : "To add a tool, enter a task name and click Record new tool. Perform the task using the screen and app controls below, then click Save as tool once it succeeds."}
      </p>
      {recording ? (
        <div className="ap-row ap-saved-recording">
          <span>
            Recording “{recording.name}” · {recording.stepCount} steps
          </span>
          <button
            className="ag-primary ag-small"
            disabled={pending || !recording.stepCount || !!recording.error}
            onClick={() => void call("reach_save_shortcut", {})}
          >
            Save as tool
          </button>
          <button
            className="ag-secondary ag-small"
            disabled={pending}
            onClick={() => void call("reach_discard_shortcut", {})}
          >
            Discard recording
          </button>
          {recording.error && (
            <p className="ap-status is-blocked">{recording.error}</p>
          )}
        </div>
      ) : (
        <form
          className="ap-row ap-saved-record"
          onSubmit={(event) => {
            event.preventDefault();
            void call("reach_record_shortcut", { name });
          }}
        >
          <input
            aria-label="New saved tool name"
            placeholder="Task name, e.g. Open Gmail"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="ag-secondary ag-small"
            disabled={pending || !name.trim()}
          >
            Record new tool
          </button>
        </form>
      )}
      {message && (
        <p className="ap-status" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="ap-status is-blocked" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
