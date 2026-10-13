import { useEffect, useRef, useState } from "react";
import { CircleCheck, Plug } from "lucide-react";
import { request, type Peer } from "./api";
import type { ServiceConnector } from "../server/browser-tools.mjs";
import "./service-tools.css";

type Result = {
  status: string;
  action: string;
  data: {
    browser?: string;
    summary?: string;
    coverage?: string;
    more?: boolean;
    items?: {
      label: string;
      detail?: string;
      handle: string;
      expiresAt: number;
    }[];
  };
};
type Intent = {
  connectorId: string;
  action: string;
  values: Record<string, string>;
  requestId: string;
};
const noop = () => {};

export default function ServiceAgentTools({
  peer,
  query = "",
  hidden = false,
  accessOnly = false,
  onCount = noop,
  onActivity = noop,
  ended = noop,
}: {
  peer: Peer;
  query?: string;
  hidden?: boolean;
  accessOnly?: boolean;
  onCount?: (count: number) => void;
  onActivity?: (activity: string) => void;
  ended?: (error: unknown) => void;
}) {
  const [connectors, setConnectors] = useState<ServiceConnector[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [result, setResult] = useState<Record<string, Result>>({});
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [waiting, setWaiting] = useState("");
  const [loaded, setLoaded] = useState(false);
  const session = useRef<AbortController | null>(null);
  const intent = useRef<Intent | null>(null),
    running = useRef(false);
  const callbacks = useRef({ ended, onCount });
  callbacks.current = { ended, onCount };
  useEffect(() => {
    onActivity(
      busy
        ? "Reading from your browser…"
        : waiting
          ? "Waiting for service approval"
          : "",
    );
  }, [busy, waiting, onActivity]);
  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    intent.current = null;
    running.current = false;
    setConnectors([]);
    setValues({});
    setResult({});
    setError("");
    setLoadError("");
    setBusy("");
    setWaiting("");
    setLoaded(false);
    let reading = false;
    const refresh = async () => {
      if (reading || running.current) return;
      reading = true;
      try {
        const response = await request<{ connectors: ServiceConnector[] }>(
          peer,
          "/api/browser/services",
          { signal: controller.signal },
        );
        if (controller.signal.aborted || running.current) return;
        const list = response.connectors || [];
        setConnectors(list);
        setLoaded(true);
        setLoadError("");
        callbacks.current.onCount(
          list.reduce((sum, item) => sum + item.actions.length, 0),
        );
        // A completed result is removed when the grant ends or is revoked.
        setResult((old) =>
          Object.fromEntries(
            Object.entries(old).filter(([id]) =>
              list.some((c) => c.id === id && c.access?.status === "approved"),
            ),
          ),
        );
        const next = intent.current;
        if (next) {
          const status = list.find((c) => c.id === next.connectorId)?.access
            ?.status;
          if (status === "approved") {
            intent.current = null;
            setWaiting("");
            await execute(next, controller);
          } else if (status !== "pending") {
            intent.current = null;
            setWaiting("");
            setError("Service access was not approved or has ended.");
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult({});
          setLoadError((error as Error).message);
          callbacks.current.ended(error);
        }
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.id, peer.url, peer.token, peer.transport, peer.sessionId]);

  async function execute(input: Intent, controller: AbortController) {
    if (
      running.current ||
      controller.signal.aborted ||
      session.current !== controller
    )
      return;
    running.current = true;
    setBusy(input.connectorId);
    setError("");
    try {
      const response = await request<Result>(
        peer,
        "/api/browser/services/run",
        {
          method: "POST",
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted && session.current === controller)
        setResult((old) => ({ ...old, [input.connectorId]: response }));
    } catch (error) {
      if (!controller.signal.aborted && session.current === controller) {
        setError((error as Error).message);
        callbacks.current.ended(error);
      }
    } finally {
      if (session.current === controller) {
        running.current = false;
        setBusy("");
      }
    }
  }
  async function run(
    connector: ServiceConnector,
    action: ServiceConnector["actions"][number],
    supplied?: Record<string, string>,
  ) {
    const controller = session.current;
    if (
      !controller ||
      running.current ||
      intent.current ||
      controller.signal.aborted
    )
      return;
    const input: Intent = {
      connectorId: connector.id,
      action: action.id,
      values: supplied ||
        values[`${connector.id}:${action.id}`] || { ...action.example },
      requestId: crypto.randomUUID(),
    };
    setResult((old) => {
      const next = { ...old };
      delete next[connector.id];
      return next;
    });
    if (
      connector.access?.status === "approved" &&
      connector.access.expiresAt > Date.now()
    )
      return execute(input, controller);
    running.current = true;
    setBusy(connector.id);
    setError("");
    try {
      const access = await request<NonNullable<ServiceConnector["access"]>>(
        peer,
        "/api/browser/services/request",
        {
          method: "POST",
          body: JSON.stringify({
            connectorId: connector.id,
            reason: `${action.title} in my signed-in browser session.`,
          }),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted && session.current === controller) {
        setConnectors((old) =>
          old.map((c) => (c.id === connector.id ? { ...c, access } : c)),
        );
        intent.current = input;
        setWaiting(connector.id);
      }
    } catch (error) {
      if (!controller.signal.aborted && session.current === controller) {
        setError((error as Error).message);
        callbacks.current.ended(error);
      }
    } finally {
      if (session.current === controller) {
        running.current = false;
        setBusy("");
      }
    }
  }
  return (
    <section
      className="service-tools"
      aria-label={
        accessOnly ? "Services shared with this agent" : "Service tools"
      }
      hidden={hidden}
    >
      <h2>
        <Plug size={18} /> {accessOnly ? "Service permissions" : "Services"}
      </h2>
      <p>
        {accessOnly
          ? "Services use your allowed browser and need owner approval for this session."
          : "Use accounts already signed in on the Mac. Choose that browser, then run a task."}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}
      {!loaded && !loadError && <p role="status">Loading services…</p>}
      {loaded && !connectors.length && (
        <p>No services are available on this computer.</p>
      )}
      {connectors
        .filter((c) =>
          `${c.name} ${c.description} ${c.actions.map((a) => a.title).join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()),
        )
        .map((connector) => (
          <article className="service-card" key={connector.id}>
            <div className="service-heading">
              <strong>{connector.name}</strong>
              {connector.transport === "browser" && (
                <span className="service-badge">Signed-in browser</span>
              )}
            </div>
            <p>{connector.description}</p>
            <small>
              {connector.unavailable ||
                (connector.access?.status === "approved"
                  ? `Read-only access · Until ${new Date(connector.access.expiresAt).toLocaleString()}`
                  : connector.access?.status === "pending"
                    ? "Waiting for owner approval"
                    : "Owner approval needed")}
            </small>
            {!accessOnly &&
              connector.actions
                .filter((action) => !action.fromResult)
                .map((action) => (
                  <form
                    key={action.id}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(connector, action);
                    }}
                  >
                    {Object.entries(action.inputSchema.properties).map(
                      ([key, field]) => (
                        <label key={key}>
                          {field.description || key}
                          {field.enum ? (
                            <select
                              value={
                                values[`${connector.id}:${action.id}`]?.[key] ??
                                action.example[key] ??
                                field.enum[0]
                              }
                              disabled={
                                !!busy || !!waiting || !!connector.unavailable
                              }
                              onChange={(event) =>
                                setValues((old) => ({
                                  ...old,
                                  [`${connector.id}:${action.id}`]: {
                                    ...action.example,
                                    ...old[`${connector.id}:${action.id}`],
                                    [key]: event.target.value,
                                  },
                                }))
                              }
                            >
                              {field.enum.map((value) => (
                                <option key={value} value={value}>
                                  {connector.id === "gmail" && key === "account"
                                    ? value === "0"
                                      ? "First signed-in account"
                                      : `Signed-in account ${Number(value) + 1}`
                                    : value}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              value={
                                values[`${connector.id}:${action.id}`]?.[key] ??
                                action.example[key] ??
                                ""
                              }
                              required={action.inputSchema.required?.includes(
                                key,
                              )}
                              maxLength={field.maxLength}
                              pattern={field.pattern}
                              disabled={
                                !!busy || !!waiting || !!connector.unavailable
                              }
                              onChange={(event) =>
                                setValues((old) => ({
                                  ...old,
                                  [`${connector.id}:${action.id}`]: {
                                    ...action.example,
                                    ...old[`${connector.id}:${action.id}`],
                                    [key]: event.target.value,
                                  },
                                }))
                              }
                            />
                          )}
                        </label>
                      ),
                    )}
                    <button
                      className="primary"
                      disabled={!!busy || !!waiting || !!connector.unavailable}
                    >
                      {busy === connector.id ? "Working…" : action.title}
                    </button>
                  </form>
                ))}
            {waiting === connector.id && (
              <div role="status" className="service-wait">
                <p>
                  Waiting for the owner on Home → Needs you. This task will run
                  automatically after approval.
                </p>
                <button
                  onClick={() => {
                    intent.current = null;
                    setWaiting("");
                  }}
                >
                  Stop waiting
                </button>
              </div>
            )}
            {result[connector.id] && (
              <div className="service-result" role="status">
                <strong>
                  <CircleCheck size={16} /> Completed
                </strong>
                {result[connector.id].data.summary && (
                  <p className="service-summary">
                    {result[connector.id].data.summary}
                  </p>
                )}
                {result[connector.id].data.coverage === "visible_page" && (
                  <p>
                    Results from the visible page in{" "}
                    {result[connector.id].data.browser}.{" "}
                    {result[connector.id].data.more
                      ? "More results may be available on the site."
                      : "Other pages have not been searched."}
                  </p>
                )}
                {result[connector.id].data.items?.length === 0 && (
                  <p>No matching results on this page.</p>
                )}
                {result[connector.id].data.items?.map((item) => (
                  <div className="service-item" key={item.handle}>
                    <strong>{item.label}</strong>
                    {item.detail && <p>{item.detail}</p>}
                    {connector.actions
                      .filter(
                        (action) =>
                          action.fromResult === result[connector.id].action,
                      )
                      .map((action) => (
                        <button
                          key={action.id}
                          disabled={
                            !!busy ||
                            !!waiting ||
                            item.expiresAt <= Date.now() ||
                            !!connector.unavailable
                          }
                          onClick={() =>
                            void run(connector, action, {
                              browser: result[connector.id].data.browser || "",
                              order: item.handle,
                            })
                          }
                        >
                          {action.title}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
    </section>
  );
}
