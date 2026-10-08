import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Circle, Play, Search, X } from "lucide-react";
import { request, type Peer } from "./api";
import { toolErrorMessage } from "./tool-errors";
import ServiceAgentTools from "./ServiceAgentTools";
import DeterministicAgentTools, {
  type ToolCategory,
} from "./DeterministicAgentTools";
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
  query: externalQuery,
  setQuery: setExternalQuery,
  onCount,
  onActivity,
  onScreen,
  searchRevision = 0,
  browserEnabled = true,
  servicesEnabled = false,
}: {
  peer: Peer;
  ended: (error: unknown) => void;
  query?: string;
  setQuery?: (query: string) => void;
  onCount?: (count: number) => void;
  onActivity?: (activity: string) => void;
  onScreen?: () => void;
  searchRevision?: number;
  browserEnabled?: boolean;
  servicesEnabled?: boolean;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const query = externalQuery ?? localQuery,
    setQuery = setExternalQuery ?? setLocalQuery;
  const [category, setCategory] = useState<ToolCategory>("all");
  useEffect(() => {
    setCategory("all");
  }, [searchRevision]);
  const [browserCount, setBrowserCount] = useState(0),
    [browserActivity, setBrowserActivity] = useState("");
  const [serviceCount, setServiceCount] = useState(0);
  const [serviceActivity, setServiceActivity] = useState("");
  // Parent callbacks and equivalent peer objects can change while a replay runs.
  // Only a changed connection must cancel it; current callbacks still receive failures.
  const connection = useMemo(
    () => peer,
    [peer.id, peer.url, peer.token, peer.transport, peer.sessionId],
  );
  const onEnded = useRef(ended);
  onEnded.current = ended;
  const [tools, setTools] = useState<BrowserTool[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
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
    setPollError("");
    return () => {
      mounted.current = false;
      session.dispose();
      bridge.current = null;
    };
  }, [connection]);
  useEffect(() => {
    const controller = new AbortController();
    if (!browserEnabled) return () => controller.abort();
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
        // A recovered read clears only its polling warning. Action outcomes,
        // including uncertain or partial completion, remain until another action.
        setPollError(
          progress.status === "rejected"
            ? toolErrorMessage(progress.reason)
            : catalog.status === "rejected"
              ? toolErrorMessage(catalog.reason)
              : "",
        );
        if (catalog.status === "fulfilled")
          setTools(
            catalog.value.filter((tool) =>
              tool.name.startsWith("reach_saved_"),
            ),
          );
        else {
          setTools([]);
          onEnded.current(catalog.reason);
        }
        if (progress.status === "fulfilled")
          setRecording(progress.value.recording);
        else {
          setRecording(null);
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
  }, [connection, revision, browserEnabled]);
  useEffect(() => {
    onCount?.(tools.length + browserCount + serviceCount);
  }, [tools.length, browserCount, serviceCount, onCount]);
  useEffect(() => {
    onActivity?.(
      serviceActivity ||
        browserActivity ||
        (pending
          ? message || "Running a recorded task…"
          : recording
            ? `Recording “${recording.name}” · ${recording.stepCount} steps`
            : ""),
    );
  }, [
    serviceActivity,
    browserActivity,
    pending,
    message,
    recording,
    onActivity,
  ]);
  const matching = tools.filter((tool) =>
    `${tool.title} ${tool.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const reveal = () => {
    setQuery("");
    setCategory("all");
  };
  const call = async (toolName: string, args: object) => {
    if (busy.current || !bridge.current) return;
    const activeBridge = bridge.current;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("Running…");
    try {
      const result = (await activeBridge.callTool(toolName, args)) as RunResult;
      if (!mounted.current || bridge.current !== activeBridge) return;
      if (result.status === "stopped")
        setError(
          `Stopped after ${result.completedSteps}/${result.totalSteps} steps. ${toolErrorMessage(result.error || "The task stopped.")} Completed actions stay applied. Inspect the screen before continuing.`,
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
        setError(toolErrorMessage(failure));
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
      className="ap-saved-tools atl-library"
      aria-labelledby="ap-saved-tools"
    >
      <div className="aw-page-heading">
        <h1 id="ap-saved-tools">
          Tools <small>{tools.length + browserCount + serviceCount}</small>
        </h1>
      </div>
      <div className="atl-discovery">
        <label className="atl-search">
          <Search size={18} />
          <input
            type="search"
            aria-label="Search tools"
            maxLength={160}
            placeholder="Search tools…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear tool search"
              onClick={() => setQuery("")}
            >
              <X size={16} />
            </button>
          )}
        </label>
        <select
          className="atl-filter"
          aria-label="Filter tools"
          value={category}
          onChange={(event) => setCategory(event.target.value as ToolCategory)}
        >
          <option value="all">All tools</option>
          {servicesEnabled && <option value="services">Services</option>}
          {browserEnabled && (
            <>
              <option value="gmail">Gmail</option>
              <option value="walmart">Walmart</option>
              <option value="custom">Custom</option>
              <option value="recorded">Recorded</option>
            </>
          )}
        </select>
      </div>
      {servicesEnabled && (
        <ServiceAgentTools
          peer={peer}
          ended={ended}
          query={query}
          onCount={setServiceCount}
          onActivity={setServiceActivity}
          hidden={category !== "all" && category !== "services"}
        />
      )}
      {browserEnabled && (
        <div hidden={category === "services"}>
          <DeterministicAgentTools
            peer={peer}
            ended={ended}
            query={query}
            category={category}
            onReveal={reveal}
            onCount={setBrowserCount}
            onActivity={setBrowserActivity}
            blocked={pending || !!recording}
          />
        </div>
      )}
      <details
        className="atl-recorded"
        hidden={
          !browserEnabled || (category !== "all" && category !== "recorded")
        }
        open={recording || category === "recorded" ? true : undefined}
      >
        <summary>
          Recorded tasks{tools.length ? ` (${tools.length})` : ""}
        </summary>
        <div className="ap-saved-list">
          {matching.map((tool) => {
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
                <strong>{tool.title}</strong>
                <button
                  type="button"
                  aria-label={`Run ${tool.title}`}
                  className="ag-primary ag-small"
                  disabled={
                    pending ||
                    !!browserActivity ||
                    !!recording ||
                    inputs.some((input) => !values[tool.name]?.[input]?.trim())
                  }
                  onClick={() => {
                    const args = values[tool.name] || {};
                    setValues((old) => ({ ...old, [tool.name]: {} }));
                    void call(tool.name, args);
                  }}
                >
                  <Play size={14} /> Run
                </button>
              </div>
            );
          })}
          {!matching.length && (
            <p className="ap-quiet">
              {query.trim()
                ? "No recorded tasks match this search."
                : "No recorded tasks yet. Record a verified task to add it to this library."}
            </p>
          )}
        </div>
        <p className="ap-quiet">
          {recording
            ? "Open Screen or Apps and perform the task. Reach records successful actions. Verify the result, then click Save as tool."
            : "Name a task and start recording. Perform it in Screen or Apps, then save after verifying success."}
        </p>
        {recording ? (
          <div className="ap-row ap-saved-recording">
            <Circle size={12} className="atl-recording-dot" />
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
            {onScreen && (
              <button
                type="button"
                className="atl-text-button"
                onClick={onScreen}
              >
                Go to Screen <ArrowRight size={14} />
              </button>
            )}
            {recording.error && (
              <p className="ap-status is-blocked">
                {toolErrorMessage(recording.error)}
              </p>
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
              disabled={pending || !!browserActivity || !name.trim()}
            >
              Record new tool
            </button>
          </form>
        )}
      </details>
      {message && (
        <p className="ap-status" role="status">
          {message}
        </p>
      )}
      {pollError && (
        <p className="ap-status is-blocked" role="alert">
          {pollError}
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
