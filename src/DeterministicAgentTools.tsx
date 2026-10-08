import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileText,
  Mail,
  Package,
  Play,
  Plus,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import {
  createBrowserToolBridge,
  type BrowserTool,
  type BrowserToolBridge,
} from "./browser-tools";
import type { Peer } from "./api";
import "./deterministic-agent-tools.css";

type Field = {
  description?: string;
  maxLength?: number;
  default?: string;
  enum?: string[];
  pattern?: string;
};
type Result = {
  status?: string;
  completedSteps?: number;
  totalSteps?: number;
  error?: string;
  data?: unknown;
};
type Attempt = {
  requestId: string;
  args: Record<string, string>;
  unresolved: boolean;
};
export type ToolCategory = "all" | "gmail" | "walmart" | "custom" | "recorded";
const group = (tool: BrowserTool): ToolCategory =>
  tool.name.startsWith("reach_tool_builtin_gmail_") ||
  tool.name === "reach_tool_builtin_open_gmail"
    ? "gmail"
    : tool.name.startsWith("reach_tool_builtin_walmart_") ||
        tool.name === "reach_tool_builtin_open_walmart"
      ? "walmart"
      : "custom";
const summary = (tool: BrowserTool) => tool.description.split(" Fixed ")[0];
const noop = () => {};
const validHandle = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const statusName: Record<string, string> = {
  completed: "Completed",
  stopped: "Stopped",
  uncertain: "Check the browser",
  needs_owner: "Needs the owner",
  pending: "In progress",
};

/** The visual library calls the same named tools and protocol as MCP. */
export default function DeterministicAgentTools({
  peer,
  ended,
  query = "",
  category = "all",
  onReveal = noop,
  onCount = noop,
  onActivity = noop,
  blocked = false,
}: {
  peer: Peer;
  ended: (error: unknown) => void;
  query?: string;
  category?: ToolCategory;
  blocked?: boolean;
  onReveal?: () => void;
  onCount?: (count: number) => void;
  onActivity?: (activity: string) => void;
}) {
  const connection = useMemo(
    () => peer,
    [peer.id, peer.url, peer.token, peer.transport, peer.sessionId],
  );
  const onEnded = useRef(ended);
  onEnded.current = ended;
  const [tools, setTools] = useState<BrowserTool[]>([]),
    [revision, setRevision] = useState(0);
  const [browser, setBrowser] = useState(""),
    [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState(false),
    [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null),
    [resultTool, setResultTool] = useState(""),
    [error, setError] = useState("");
  const [editor, setEditor] = useState(false),
    [definition, setDefinition] = useState(""),
    [reference, setReference] = useState("");
  const [inspection, setInspection] = useState<unknown>(null);
  const bridge = useRef<BrowserToolBridge | null>(null),
    busy = useRef(false),
    mounted = useRef(true);
  const runner = useRef<HTMLElement | null>(null);
  const attempts = useRef(new Map<string, Attempt>());
  useEffect(() => {
    mounted.current = true;
    const session = createBrowserToolBridge(connection, (failure) => {
      if (bridge.current === session.bridge) onEnded.current(failure);
    });
    bridge.current = session.bridge;
    attempts.current.clear();
    busy.current = false;
    setPending(false);
    setTools([]);
    setValues({});
    setResult(null);
    setResultTool("");
    setSelected("");
    setMessage("");
    setError("");
    setLoadError("");
    setLoaded(false);
    setEditor(false);
    setDefinition("");
    setReference("");
    setInspection(null);
    return () => {
      mounted.current = false;
      session.dispose();
      bridge.current = null;
      attempts.current.clear();
    };
  }, [connection]);
  useEffect(() => {
    onCount(tools.length);
  }, [tools.length, onCount]);
  useEffect(() => {
    onActivity(pending ? message || "Running a browser tool…" : "");
  }, [pending, message, onActivity]);
  useEffect(() => {
    let active = true,
      reading = false;
    const refresh = async () => {
      if (busy.current || reading) return;
      reading = true;
      try {
        const all = await bridge.current?.listTools();
        if (active && all) {
          setTools(
            all.filter(
              (tool) =>
                !!(tool.inputSchema.properties as Record<string, unknown>)
                  ?.browser && tool.name.startsWith("reach_tool_"),
            ),
          );
          setLoaded(true);
          setLoadError("");
        }
      } catch (error) {
        if (active) {
          setTools([]);
          setLoaded(true);
          setLoadError((error as Error).message);
          onEnded.current(error);
        }
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection, revision]);
  const locked = pending || blocked;
  const fields = (tool: BrowserTool) =>
    tool.inputSchema.properties as Record<string, Field>;
  const browsers = tools[0] ? fields(tools[0]).browser.enum || [] : [];
  const selectedBrowser = browsers.includes(browser)
    ? browser
    : browsers[0] || "Chrome";
  const matching = tools.filter(
    (tool) =>
      (category === "all" || group(tool) === category) &&
      `${tool.title} ${tool.description} ${tool.name}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const selectedTool = tools.find((tool) => tool.name === selected);
  const action = async (
    work: (
      activeBridge: BrowserToolBridge,
      active: () => boolean,
    ) => Promise<unknown>,
  ) => {
    if (busy.current || blocked || !bridge.current) return;
    const activeBridge = bridge.current,
      active = () => mounted.current && bridge.current === activeBridge;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await work(activeBridge, active);
    } catch (error) {
      if (active()) {
        setMessage("");
        setError((error as Error).message);
        onEnded.current(error);
      }
    } finally {
      if (active()) {
        busy.current = false;
        setPending(false);
        setRevision((value) => value + 1);
      }
    }
  };
  const focusRunner = () =>
    setTimeout(() => {
      runner.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      runner.current
        ?.querySelector<HTMLInputElement>("input,textarea,select")
        ?.focus();
    }, 0);
  const inspect = (tool: BrowserTool) => {
    setSelected(tool.name);
    setInspection(null);
    focusRunner();
  };
  const execute = (tool: BrowserTool) => {
    if (busy.current || blocked) return;
    setSelected(tool.name);
    setInspection(null);
    const missing = ((tool.inputSchema.required || []) as string[]).filter(
      (key) =>
        !["browser", "requestId"].includes(key) &&
        !(
          values[tool.name]?.[key] ??
          fields(tool)[key].default ??
          fields(tool)[key].enum?.[0]
        )?.trim(),
    );
    if (missing.length && !attempts.current.get(tool.name)?.unresolved) {
      setError(
        `Add ${missing.map((key) => fields(tool)[key].description || key).join(", ")} to run ${tool.title}.`,
      );
      focusRunner();
      return;
    }
    return action(async (activeBridge, active) => {
      let attempt = attempts.current.get(tool.name);
      if (!attempt?.unresolved) {
        const args = Object.fromEntries(
          Object.entries(fields(tool))
            .filter(([key]) => !["browser", "requestId"].includes(key))
            .flatMap(([key, field]) => {
              const value =
                values[tool.name]?.[key] ?? field.default ?? field.enum?.[0];
              return value === undefined || value === "" ? [] : [[key, value]];
            }),
        );
        attempt = {
          requestId: crypto.randomUUID(),
          args: { ...args, browser: selectedBrowser },
          unresolved: true,
        };
        attempts.current.set(tool.name, attempt);
      }
      setMessage(`Running ${tool.title}`);
      setResult(null);
      setResultTool(tool.name);
      const response = (await activeBridge.callTool(tool.name, {
        ...attempt.args,
        requestId: attempt.requestId,
      })) as Result;
      if (!active()) return;
      attempt.unresolved = response.status !== "completed";
      setResult(response);
      setMessage(
        `${response.status || "stopped"} · ${response.completedSteps || 0}/${response.totalSteps || 0} steps · ${attempt.requestId}`,
      );
      if (response.status !== "completed")
        setError(
          `${response.error || "This run is still in progress."} Inspect the browser before starting another run. The same request ID will not repeat completed effects.`,
        );
    });
  };
  const openEditor = () =>
    action(async (activeBridge, active) => {
      setMessage("Loading the creation protocol…");
      const protocol = (await activeBridge.callTool("reach_tool_protocol")) as {
        example: unknown;
      };
      const catalog = await activeBridge.callTool("reach_tools");
      if (!active()) return;
      setReference(JSON.stringify({ protocol, catalog }, null, 2));
      setDefinition(JSON.stringify(protocol.example, null, 2));
      setEditor(true);
      setMessage("");
    });
  const useResult = (
    suffix: string,
    field: string,
    item: Record<string, unknown>,
  ) => {
    if (!validHandle(item.handle) || Number(item.expiresAt) <= Date.now()) {
      setError(
        "This result has expired. Run the source tool again to get a fresh result.",
      );
      return;
    }
    const name = `reach_tool_${suffix}`,
      next = tools.find((tool) => tool.name === name);
    if (!next) return;
    const source = attempts.current.get(resultTool);
    if (source) setBrowser(source.args.browser);
    setValues((old) => ({
      ...old,
      [name]: { ...old[name], [field]: item.handle as string },
    }));
    onReveal();
    inspect(next);
    setError("");
  };
  const resultActions = (key: string) =>
    resultTool === "reach_tool_builtin_gmail_find" && key === "messages"
      ? [
          {
            suffix: "builtin_gmail_open",
            field: "message",
            label: "Open this message",
          },
        ]
      : resultTool === "reach_tool_builtin_gmail_open" && key === "attachments"
        ? [
            {
              suffix: "builtin_gmail_attachment",
              field: "attachment",
              label: "Get this attachment",
            },
          ]
        : resultTool === "reach_tool_builtin_walmart_find" && key === "orders"
          ? [
              {
                suffix: "builtin_walmart_receipt",
                field: "order",
                label: "Get receipt",
              },
              {
                suffix: "builtin_walmart_track",
                field: "order",
                label: "Track this order",
              },
            ]
          : key === "file" &&
              [
                "reach_tool_builtin_gmail_attachment",
                "reach_tool_builtin_walmart_receipt",
              ].includes(resultTool)
            ? [
                {
                  suffix: "builtin_gmail_draft",
                  field: "file",
                  label: "Use in a Gmail draft",
                },
              ]
            : [];
  const resultData =
    result?.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : {};
  const feedback = (
    <>
      {message && (
        <p className="ap-status atl-operation" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="ap-status is-blocked" role="alert">
          {error}
        </p>
      )}
    </>
  );
  const resultsView = result && (
    <section className="atl-results" aria-label="Tool results">
      <div className="atl-result-heading">
        {result.status === "completed" ? (
          <CheckCircle2 size={18} />
        ) : (
          <ShieldCheck size={18} />
        )}
        <h2>{statusName[result.status || ""] || "Tool result"}</h2>
        <span>
          {result.completedSteps || 0} / {result.totalSteps || 0} steps
        </span>
      </div>
      <p className="atl-description">
        {tools.find((tool) => tool.name === resultTool)?.title}
      </p>
      {Object.entries(resultData).map(([key, value]) => {
        const object =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : null;
        const items =
          object && Array.isArray(object.items)
            ? (object.items as Record<string, unknown>[])
            : object && validHandle(object.handle)
              ? [object]
              : [];
        return (
          <div key={key} className="atl-result-group">
            <h3>{key.replaceAll("_", " ")}</h3>
            {object?.coverage === "visible_page" && (
              <p className="atl-description">
                Results from the visible page
                {object.more ? ". More items exist; narrow the search." : "."}
              </p>
            )}
            {items.length ? (
              items.map((item, index) => (
                <article
                  className="atl-result-item"
                  key={`${item.handle || index}`}
                >
                  <FileText size={17} />
                  <div>
                    {Object.entries(item)
                      .filter(
                        ([field]) =>
                          !["handle", "expiresAt", "mime", "bytes"].includes(
                            field,
                          ),
                      )
                      .map(([field, text]) => (
                        <p key={field}>
                          <span>{field}</span>
                          <strong>{String(text)}</strong>
                        </p>
                      ))}
                    <small>
                      {Number(item.expiresAt) > Date.now()
                        ? `Available until ${new Date(Number(item.expiresAt)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                        : "Result expired"}
                    </small>
                    <code>{String(item.handle)}</code>
                  </div>
                  <div className="atl-result-actions">
                    {resultActions(key)
                      .filter((item) =>
                        tools.some(
                          (tool) => tool.name === `reach_tool_${item.suffix}`,
                        ),
                      )
                      .map((next) => (
                        <button
                          type="button"
                          key={next.suffix}
                          disabled={
                            locked || Number(item.expiresAt) <= Date.now()
                          }
                          onClick={() =>
                            useResult(next.suffix, next.field, item)
                          }
                        >
                          {next.label}
                          <ArrowRight size={14} />
                        </button>
                      ))}
                  </div>
                </article>
              ))
            ) : object && Array.isArray(object.items) ? (
              <p className="atl-description">No results on this page.</p>
            ) : (
              <p className="atl-result-text">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </p>
            )}
          </div>
        );
      })}
      {result.data !== undefined && (
        <details className="atl-raw">
          <summary>Raw result for agent tools</summary>
          <pre aria-label="Tool result">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
  const showLibrary = category !== "recorded" && !editor;
  return (
    <div className="ap-deterministic-tools">
      <div className="atl-browser-bar">
        <div>
          <ShieldCheck size={15} />
          <span>Fixed steps · checked results</span>
        </div>
        {browsers.length > 0 && (
          <label>
            Run in{" "}
            <select
              aria-label="Tool browser"
              value={selectedBrowser}
              disabled={locked}
              onChange={(event) => setBrowser(event.target.value)}
            >
              {browsers.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="atl-text-button"
          disabled={locked}
          onClick={() => void openEditor()}
        >
          <Plus size={15} /> Create deterministic tool
        </button>
      </div>
      {(!selectedTool || editor || category === "recorded") && feedback}
      {!editor && (!selectedTool || category === "recorded") && resultsView}
      {editor && (
        <section
          className="atl-editor"
          aria-label="Create a deterministic tool"
        >
          <div className="aw-section-heading">
            <h2>
              <Code2 size={18} /> Create a deterministic tool
            </h2>
            <button
              type="button"
              aria-label="Close editor"
              disabled={locked}
              onClick={() => setEditor(false)}
            >
              <X size={18} />
            </button>
          </div>
          <p>
            Use <code>reach.tool.v1</code>, the same format as the built-in
            tools. Declare inputs, allowed HTTPS sites, fixed steps, and a final
            result check.
          </p>
          <div className="atl-editor-grid">
            <div>
              <h3>1. Inspect the protocol</h3>
              <p>
                Use a built-in definition as the starting point. Saving creates
                a named tool; execution stays a separate action.
              </p>
              <details>
                <summary>Protocol and built-in definitions</summary>
                <pre>{reference}</pre>
              </details>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async (activeBridge, active) => {
                  const input = JSON.parse(definition);
                  setMessage("Saving the tool definition…");
                  await activeBridge.callTool("reach_define_tool", {
                    definition: input,
                  });
                  if (active()) {
                    setEditor(false);
                    setResult(null);
                    onReveal();
                    setSelected(`reach_tool_${input.id}`);
                    setMessage("Saved. The new named tool is now in the list.");
                  }
                });
              }}
            >
              <label>
                <span>2. Write the definition</span>
                <textarea
                  aria-label="Tool definition JSON"
                  value={definition}
                  maxLength={24000}
                  rows={15}
                  disabled={locked}
                  onChange={(event) => setDefinition(event.target.value)}
                />
              </label>
              <button className="atl-primary" disabled={locked}>
                <Plus size={15} /> Save deterministic tool
              </button>
            </form>
          </div>
        </section>
      )}
      {showLibrary && (
        <div className={`atl-workspace ${selectedTool ? "has-selection" : ""}`}>
          <div className="atl-list">
            <p className="atl-count" role="status">
              {!loaded
                ? "Loading browser tools…"
                : `${matching.length} ${matching.length === 1 ? "tool" : "tools"}${query.trim() ? ` matching “${query.trim()}”` : " available"}`}
            </p>
            {loadError && (
              <p className="ap-status is-blocked" role="alert">
                {loadError}
              </p>
            )}
            <div className="atl-grid">
              {matching.map((tool) => {
                const family = group(tool),
                  Icon =
                    family === "gmail"
                      ? Mail
                      : family === "walmart"
                        ? Package
                        : Zap;
                const required = (
                  (tool.inputSchema.required || []) as string[]
                ).filter((key) => !["browser", "requestId"].includes(key));
                return (
                  <article
                    className={`atl-card ${selected === tool.name ? "is-selected" : ""}`}
                    key={tool.name}
                  >
                    <div className="atl-card-top">
                      <span className={`atl-service ${family}`}>
                        <Icon size={20} />
                      </span>
                      <span className="atl-family">
                        {family === "gmail"
                          ? "Gmail"
                          : family === "walmart"
                            ? "Walmart"
                            : "Custom tool"}
                      </span>
                      <span className="atl-tag">Deterministic</span>
                    </div>
                    <h3>{tool.title}</h3>
                    <p>{summary(tool)}</p>
                    <div className="atl-card-bottom">
                      <button
                        type="button"
                        className="atl-inspect"
                        aria-label={`Inspect ${tool.title}`}
                        onClick={() => inspect(tool)}
                      >
                        <span>
                          {required.length
                            ? `${required.length} input${required.length === 1 ? "" : "s"}`
                            : "Ready to run"}
                        </span>
                        <ChevronRight size={14} />
                      </button>
                      <button
                        type="button"
                        className="atl-run"
                        disabled={locked}
                        onClick={() => void execute(tool)}
                      >
                        <Play size={12} />
                        <span>{tool.title}</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            {loaded && !matching.length && !loadError && (
              <div className="aw-empty">
                <Zap size={22} />
                <h3>
                  {tools.length
                    ? "No matching browser tools"
                    : "No browser tools available"}
                </h3>
                <p>
                  {tools.length
                    ? "Try another task name, or create a tool using the shared protocol."
                    : "Browser tools need access to Chrome or Safari. Check Access for the apps shared with this session."}
                </p>
              </div>
            )}
          </div>
          {selectedTool && (
            <aside
              className="atl-runner"
              ref={runner}
              aria-label={`Run ${selectedTool.title}`}
            >
              <div className="atl-runner-heading">
                <p className="aw-eyebrow">TOOL DETAILS</p>
                <button
                  type="button"
                  aria-label="Close tool details"
                  onClick={() => setSelected("")}
                >
                  <X size={16} />
                </button>
              </div>
              <h2>{selectedTool.title}</h2>
              <p className="atl-description">{summary(selectedTool)}</p>
              {feedback}
              {resultTool === selectedTool.name && resultsView}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void execute(selectedTool);
                }}
              >
                {Object.entries(fields(selectedTool))
                  .filter(([key]) => !["browser", "requestId"].includes(key))
                  .map(([key, field]) => (
                    <label key={key}>
                      <span>
                        {field.description || key}
                        {(
                          (selectedTool.inputSchema.required || []) as string[]
                        ).includes(key) && <small>Required</small>}
                      </span>
                      {field.enum ? (
                        <select
                          aria-label={`${selectedTool.title}: ${key}`}
                          disabled={locked}
                          value={
                            values[selectedTool.name]?.[key] ??
                            field.default ??
                            field.enum[0]
                          }
                          onChange={(event) =>
                            setValues((old) => ({
                              ...old,
                              [selectedTool.name]: {
                                ...old[selectedTool.name],
                                [key]: event.target.value,
                              },
                            }))
                          }
                        >
                          {field.enum.map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                        </select>
                      ) : !field.pattern && (field.maxLength || 2000) > 1000 ? (
                        <textarea
                          aria-label={`${selectedTool.title}: ${key}`}
                          disabled={locked}
                          rows={3}
                          value={
                            values[selectedTool.name]?.[key] ??
                            field.default ??
                            ""
                          }
                          maxLength={field.maxLength || 2000}
                          onChange={(event) =>
                            setValues((old) => ({
                              ...old,
                              [selectedTool.name]: {
                                ...old[selectedTool.name],
                                [key]: event.target.value,
                              },
                            }))
                          }
                        />
                      ) : (
                        <input
                          aria-label={`${selectedTool.title}: ${key}`}
                          disabled={locked}
                          autoComplete="off"
                          placeholder={
                            field.pattern
                              ? "Choose a result below, or paste its handle"
                              : "Enter a value"
                          }
                          value={
                            values[selectedTool.name]?.[key] ??
                            field.default ??
                            ""
                          }
                          maxLength={field.maxLength || 2000}
                          onChange={(event) =>
                            setValues((old) => ({
                              ...old,
                              [selectedTool.name]: {
                                ...old[selectedTool.name],
                                [key]: event.target.value,
                              },
                            }))
                          }
                        />
                      )}
                    </label>
                  ))}
                {!Object.entries(fields(selectedTool)).some(
                  ([key]) => !["browser", "requestId"].includes(key),
                ) && (
                  <p className="atl-description">This tool needs no inputs.</p>
                )}
                <button className="atl-primary" disabled={locked}>
                  <Play size={14} />
                  {pending
                    ? "Running…"
                    : attempts.current.get(selectedTool.name)?.unresolved
                      ? "Recover this run"
                      : "Run tool"}
                </button>
              </form>
              <p className="atl-browser-note">
                Uses your existing{" "}
                {attempts.current.get(selectedTool.name)?.unresolved
                  ? attempts.current.get(selectedTool.name)?.args.browser
                  : selectedBrowser}{" "}
                session. Missing or changed targets stop the run.
              </p>
              <button
                type="button"
                className="atl-text-button"
                disabled={locked}
                onClick={() =>
                  void action(async (activeBridge, active) => {
                    const catalog = (await activeBridge.callTool(
                      "reach_tools",
                    )) as { tools: { id: string }[] };
                    if (active())
                      setInspection(
                        catalog.tools.find(
                          (tool) =>
                            `reach_tool_${tool.id}` === selectedTool.name,
                        ),
                      );
                  })
                }
              >
                <Code2 size={14} /> View definition
              </button>
              {inspection !== null && (
                <pre className="atl-definition">
                  {JSON.stringify(inspection, null, 2)}
                </pre>
              )}
              {attempts.current.get(selectedTool.name)?.unresolved && (
                <div className="atl-recovery">
                  <p>
                    A previous run has an unresolved result. Keep its request ID
                    to recover it.
                  </p>
                  <button
                    type="button"
                    className="atl-text-button"
                    disabled={locked}
                    onClick={() =>
                      void action(async (activeBridge, active) => {
                        const attempt = attempts.current.get(selectedTool.name);
                        if (!attempt) return;
                        const response = (await activeBridge.callTool(
                          "reach_tool_operation",
                          { requestId: attempt.requestId },
                        )) as Result;
                        if (active()) {
                          attempt.unresolved = response.status !== "completed";
                          setResult(response);
                          setResultTool(selectedTool.name);
                          setMessage(
                            `${response.status} · ${response.completedSteps || 0}/${response.totalSteps || 0} steps · ${attempt.requestId}`,
                          );
                        }
                      })
                    }
                  >
                    Check run status
                  </button>
                  <button
                    type="button"
                    className="atl-text-button"
                    disabled={locked}
                    onClick={() => {
                      attempts.current.delete(selectedTool.name);
                      setMessage(
                        "A new run will use a new request ID. Check the browser before executing it.",
                      );
                      setRevision((value) => value + 1);
                    }}
                  >
                    Start another run
                  </button>
                </div>
              )}
              {resultTool !== selectedTool.name && resultsView}
            </aside>
          )}
        </div>
      )}
      <details className="atl-setup">
        <summary>Browser setup and execution rules</summary>
        <p>
          Chrome and Safari need Allow JavaScript from Apple Events enabled,
          plus macOS Automation access for Reach's Terminal. These tools use the
          owner's actual browser and signed-in session. Passwords, verification
          challenges, and blocked pages need the owner.
        </p>
        <p>
          New operations use a unique request ID. Recover an interrupted run
          with its existing ID to avoid repeating effects. Results expire and
          belong to this browser and invitation.
        </p>
      </details>
    </div>
  );
}
