import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "./page-visible";
import {
  AppWindow,
  ChevronDown,
  Clock3,
  Folder,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { PRESET_WORDS } from "./BrowserInvite";
import AccessEditor, {
  appScopedAccess,
  canEditAccess,
  type EditableAccess,
} from "./AccessEditor";
import { request, type Device, type Peer } from "./api";
import { AgentAdmissionReview, type AgentAdmission } from "./agent-admissions";
import {
  BrowserApprovalReview,
  browserActionWords,
  type BrowserRequest,
} from "./browser-approvals";
import { ErrorLine, Spinner } from "./ui";
import { AgentAvatar, AppStack, appName } from "./agent-ui";
import AgentShortcuts from "./AgentShortcuts";
import { ServiceAccessPanel } from "./service-access";
import ToolBrowserSetup from "./ToolBrowserSetup";
import "./browser-agents.css";
import "./agent-list.css";

export type BrowserAgentSession = EditableAccess & {
  createdAt: string | number;
  folders: string[];
  pendingApprovals: number;
  // Preset sessions: what the agent is doing on the Mac right now.
  preset?: "full" | "apps" | "files" | "readonly";
  using?: { at: number; kind: string; app: string; bundle: string };
  holdsMac?: boolean;
  // Always access: no end time, only the owner ends it.
  standing?: boolean;
  // Its link can be reopened for a new browser (Reopen link).
  relink?: boolean;
  paused?: boolean;
  activity: {
    state: "idle" | "waiting" | "running" | "stopping";
    folder?: string;
    kind?: string;
  };
};
type Props = {
  peer: Peer;
  device: Device;
  invite: () => void;
  toast: (message: string) => void;
};
const sessionCode = (id: string) => id.slice(-8);
const activeSession = (agent: BrowserAgentSession, now: number) =>
  (agent.expiresAt || 0) > now &&
  (!agent.status ||
    ["invited", "pending", "approved", "accepted"].includes(agent.status));
const time = (value: number | string) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const pendingRecord = (record: BrowserRequest, now: number) =>
  record.status === "pending" && record.expiresAt > now;
const statusWords = (status: string) =>
  ({
    executed: "Completed",
    executing: "Running",
    pending: "Needs approval",
    denied: "Denied",
    cancelled: "Cancelled",
    expired: "Expired",
    interrupted: "Interrupted",
    failed: "Failed",
  })[status] || status;

// Replacing the peer also replaces every dialog, request, and captured stop list.
export default function BrowserAgents(props: Props) {
  return (
    <BrowserAgentList
      key={`${props.peer.id}:${props.peer.url}:${props.peer.token}`}
      {...props}
    />
  );
}
function BrowserAgentList({ peer, device, invite, toast }: Props) {
  const [agents, setAgents] = useState<BrowserAgentSession[]>([]);
  const [records, setRecords] = useState<BrowserRequest[]>([]);
  const [admissions, setAdmissions] = useState<AgentAdmission[]>([]);
  const [connectionReview, setConnectionReview] =
    useState<AgentAdmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<BrowserAgentSession | null>(null);
  const [reviewing, setReviewing] = useState<BrowserRequest | null>(null);
  const [stopSnapshot, setStopSnapshot] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [stopping, setStopping] = useState<string[]>([]);
  // Which agents are open (by id), and the search text.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const visible = usePageVisible();
  const alive = useRef(true);
  const mutations = useRef(new Set<AbortController>());
  const mutationPending = useRef(false);
  const stopped = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const controller of mutations.current) controller.abort();
    };
  }, []);
  useEffect(() => {
    // In the background, nothing is asked; back on screen, at once.
    if (!visible) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading || controller.signal.aborted) return;
      reading = true;
      const results = await Promise.allSettled([
        request<{ agents: BrowserAgentSession[]; at: number }>(
          peer,
          "/api/browser/agents",
          { signal: controller.signal },
        ),
        request<BrowserRequest[]>(peer, "/api/agents/browser-requests", {
          signal: controller.signal,
        }),
        request<BrowserRequest[]>(
          peer,
          "/api/agents/browser-terminal-history",
          { signal: controller.signal },
        ),
        request<AgentAdmission[]>(peer, "/api/agents/admissions", {
          signal: controller.signal,
        }),
      ]);
      if (!controller.signal.aborted) {
        const [sessions, requests, history, connections] = results;
        if (
          sessions.status === "fulfilled" &&
          Array.isArray(sessions.value.agents)
        ) {
          setAgents(
            sessions.value.agents.map((agent) =>
              stopped.current.has(agent.id)
                ? { ...agent, status: "revoked" }
                : agent,
            ),
          );
          setError("");
        } else {
          setError(
            sessions.status === "rejected"
              ? sessions.reason.message
              : "Agent sessions could not be loaded.",
          );
          setReviewing(null);
          setEditing(null);
          setConnectionReview(null);
        }
        const nextAdmissions =
          connections.status === "fulfilled" && Array.isArray(connections.value)
            ? connections.value.filter((item) => item.expiresAt > Date.now())
            : [];
        setAdmissions(nextAdmissions);
        setConnectionReview((old) =>
          old
            ? nextAdmissions.find(
                (item) =>
                  item.requestId === old.requestId &&
                  item.clientId === old.clientId,
              ) || null
            : null,
        );
        const items = new Map<string, BrowserRequest>();
        // In-memory approval status is newer than its last durable log entry.
        for (const result of [history, requests])
          if (result.status === "fulfilled" && Array.isArray(result.value))
            for (const item of result.value) items.set(item.id, item);
        const nextRecords = [...items.values()].sort(
          (a, b) => b.createdAt - a.createdAt,
        );
        setRecords(nextRecords);
        setReviewing((old) =>
          old
            ? nextRecords.find(
                (item) => item.id === old.id && item.clientId === old.clientId,
              ) || null
            : null,
        );
        setHistoryError(
          results
            .slice(1)
            .some(
              (result) =>
                result.status === "rejected" || !Array.isArray(result.value),
            )
            ? "Some activity or connection requests could not be loaded. Refresh to try again."
            : "",
        );
        setNow(Date.now());
        setLoading(false);
      }
      reading = false;
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer, revision, visible]);
  const stop = async (clientIds: string[]) => {
    if (mutationPending.current || !clientIds.length) return;
    mutationPending.current = true;
    setStopping(clientIds);
    setActionError("");
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      const result = await request<{ stopped: string[] }>(
        peer,
        "/api/browser/agents/stop",
        {
          method: "POST",
          body: JSON.stringify({ clientIds }),
          signal: controller.signal,
        },
      );
      if (!alive.current || controller.signal.aborted) return;
      if (!Array.isArray(result.stopped))
        throw new Error(
          "Reach did not confirm which sessions stopped. Refresh and try again.",
        );
      for (const id of result.stopped) stopped.current.add(id);
      setAgents((old) =>
        old.map((agent) =>
          stopped.current.has(agent.id)
            ? { ...agent, status: "revoked" }
            : agent,
        ),
      );
      setStopSnapshot(null);
      setReviewing(null);
      setEditing(null);
      setConnectionReview(null);
      setRevision((value) => value + 1);
      toast(
        result.stopped.length === 1
          ? "Agent access stopped"
          : `${result.stopped.length} agent sessions stopped`,
      );
    } catch (failure) {
      if (alive.current && !controller.signal.aborted)
        setActionError((failure as Error).message);
    } finally {
      mutations.current.delete(controller);
      mutationPending.current = false;
      if (alive.current && !controller.signal.aborted) setStopping([]);
    }
  };
  // Pause one agent on the Mac: it keeps looking, its actions wait.
  const pausing = useRef(new Set<string>());
  const pause = async (agent: BrowserAgentSession, paused: boolean) => {
    if (pausing.current.has(agent.id)) return;
    pausing.current.add(agent.id);
    setActionError("");
    try {
      await request(peer, "/api/browser/agents/pause", { method: "POST", body: JSON.stringify({ clientId: agent.id, paused }) });
      setAgents((old) => old.map((item) => (item.id === agent.id ? { ...item, paused } : item)));
      setRevision((value) => value + 1);
      toast(paused ? `${agent.name} paused` : `${agent.name} resumed`);
    } catch (failure) {
      if (alive.current) setActionError((failure as Error).message);
    } finally {
      pausing.current.delete(agent.id);
    }
  };
  const active = agents.filter((agent) => activeSession(agent, now));
  const busy = stopping.length > 0;
  const words = query.trim().toLowerCase();
  const found = (agent: BrowserAgentSession) =>
    !words ||
    agent.name.toLowerCase().includes(words) ||
    agent.id.toLowerCase().includes(words) ||
    (agent.folders || []).some((folder) =>
      folder.toLowerCase().includes(words),
    ) ||
    (agent.policy?.appAccess || []).some((app) =>
      appName(app).toLowerCase().includes(words),
    ) ||
    (agent.policy?.apps || []).some((app) => appName(app).toLowerCase().includes(words)) ||
    (agent.preset ? PRESET_WORDS[agent.preset].title.toLowerCase().includes(words) : false);
  const ended = agents.filter((agent) => !activeSession(agent, now));
  const shownActive = active.filter(found);
  const shownEnded = ended.filter(found);
  const needsYou = (agent: BrowserAgentSession) =>
    activeSession(agent, now) &&
    (agent.status === "pending" ||
      records.some(
        (record) => record.clientId === agent.id && pendingRecord(record, now),
      ));
  const waiting = active.filter(needsYou).length;
  const clock = (value: number) =>
    new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const ends = (value: number) =>
    new Date(value).toDateString() === new Date(now).toDateString()
      ? clock(value)
      : time(value);

  const card = (agent: BrowserAgentSession) => {
    const active = activeSession(agent, now);
    const agentRecords = records.filter((record) => record.clientId === agent.id);
    const pending = active
      ? agentRecords.filter((record) => pendingRecord(record, now))
      : [];
    const admission = active
      ? admissions.find((item) => item.clientId === agent.id)
      : undefined;
    const isStopping =
      stopping.includes(agent.id) || agent.activity?.state === "stopping";
    const status = !active
      ? agent.status === "revoked"
        ? "Stopped"
        : agent.status === "denied"
          ? "Connection denied"
          : "Expired"
      : isStopping
        ? "Stopping"
        : agent.paused
          ? "Paused"
          : agent.holdsMac
            ? `Using ${agent.using?.app || "the Mac"}`
        : agent.status === "pending"
          ? "Awaiting approval"
          : agent.status === "approved"
            ? "Connecting"
            : agent.activity?.state === "waiting"
              ? "Waiting for folder"
              : agent.activity?.state === "running"
                ? "Working"
                : pending.length || agent.pendingApprovals
                  ? "Needs approval"
                  : agent.status === "invited"
                    ? "Not joined yet"
                    : "Ready";
    const tone = !active
      ? "is-ended"
      : agent.status === "pending" || pending.length || agent.pendingApprovals
        ? "is-ask"
        : agent.activity?.state === "running" || agent.status === "accepted" || agent.holdsMac
          ? "is-live"
          : "";
    const presetWords = agent.preset ? PRESET_WORDS[agent.preset] : null;
    const open = opened[agent.id] ?? (active && (needsYou(agent) || agents.length === 1));
    const policy = agent.policy || {};
    const folders = agent.folders || [];
    const apps = policy.appAccess || [];
    return (
      <article
        className={`ba-session ag-agent${open ? " is-open" : ""}${active ? "" : " is-ended"}`}
        key={agent.id}
        data-agent-id={agent.id}
      >
        <button
          type="button"
          className="ag-agent-head"
          aria-expanded={open}
          onClick={() =>
            setOpened((old) => ({ ...old, [agent.id]: !open }))
          }
        >
          <AgentAvatar name={agent.name} size={42} />
          <span className="ag-agent-title">
            <strong>{agent.name}</strong>
            <small title={agent.id}>
              {active
                ? agent.standing ? "Always" : `Ends ${ends(agent.expiresAt || 0)}`
                : `Ended · ${time(agent.expiresAt || 0)}`}
              {" · "}
              {sessionCode(agent.id)}
            </small>
          </span>
          {!!pending.length && (
            <span className="ag-count" aria-label={`${pending.length} waiting`}>
              {pending.length}
            </span>
          )}
          <span className={`ag-pill ${tone}`}>{status}</span>
        </button>

        <div className="ag-agent-body" hidden={!open}>
          {active && agent.status === "pending" && (
            <div className="ag-ask">
              <p>
                <strong>Wants to connect.</strong> Check its code, then approve.
              </p>
              {admission && (
                <button
                  className="ag-primary ag-small"
                  disabled={busy || !!error}
                  onClick={() => setConnectionReview(admission)}
                >
                  Review connection
                </button>
              )}
            </div>
          )}
          {!!pending.length && (
            <div className="ag-ask">
              <p>
                <strong>
                  {pending.length}{" "}
                  {pending.length === 1 ? "request" : "requests"}
                </strong>{" "}
                waiting for you
              </p>
              <ul>
                {pending.map((record) => (
                  <li key={record.id}>
                    <code>{browserActionWords(record.action)}</code>
                    <button
                      className="ag-primary ag-small"
                      disabled={busy || !!error}
                      onClick={() => setReviewing(record)}
                    >
                      Review
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {active &&
            agent.activity?.folder &&
            ["waiting", "running", "stopping"].includes(agent.activity.state) && (
              <p className="ag-working">
                <span className="ag-working-dot" aria-hidden="true" />
                {agent.activity.state === "waiting"
                  ? "Waiting to change"
                  : agent.activity.state === "stopping"
                    ? "Stopping work in"
                    : "Working in"}{" "}
                <span className="ba-path">{agent.activity.folder}</span>
              </p>
            )}

          {active && agent.using?.app && (
            <p className="ag-working" aria-label="Using now">
              <span className="ag-working-dot" aria-hidden="true" />
              {agent.paused ? "Paused · last in" : agent.holdsMac ? "Using" : "Last used"} <strong>{agent.using.app}</strong>
            </p>
          )}

          <ul className="ag-facts" aria-label="Access">
            {presetWords && (
              <li>
                <Sparkles size={18} />
                <div>
                  <strong>{presetWords.title}</strong>
                  <small>{presetWords.detail}</small>
                </div>
              </li>
            )}
            {agent.preset === "apps" && (
              <li>
                <AppWindow size={18} />
                <div>
                  <strong>Uses</strong>
                  <span className="ag-fact-apps">
                    <AppStack peer={peer} apps={policy.apps || []} />
                    {(policy.apps || []).map(appName).join(", ")}
                  </span>
                </div>
              </li>
            )}
            {!!policy.hidden?.length && (
              <li>
                <AppWindow size={18} />
                <div>
                  <strong>Hidden from it</strong>
                  <small>{policy.hidden.map(appName).join(", ")}</small>
                </div>
              </li>
            )}
            <li>
              <Folder size={18} />
              <div>
                <strong>
                  {folders.length ? (agent.preset === "full" || (agent.preset === "files" && policy.write) ? "Reads and changes" : "Reads") : agent.preset === "apps" ? "No folders" : "No folders shared"}
                </strong>
                {folders.map((folder) => (
                  <span className="ba-path" key={folder}>
                    {folder}
                  </span>
                ))}
              </div>
            </li>
            {policy.screen === "apps" && (
              <li>
                <AppWindow size={18} />
                <div>
                  <strong>{apps.length ? "Sees" : "Apps"}</strong>
                  {apps.length ? (
                    <span className="ag-fact-apps">
                      <AppStack peer={peer} apps={apps} />
                      {apps.map(appName).join(", ")}
                    </span>
                  ) : (
                    <small>None yet. It can ask you.</small>
                  )}
                </div>
              </li>
            )}
            {!!policy.terminalIds?.length && (
              <li>
                <SquareTerminal size={18} />
                <div>
                  <strong>Watches</strong>
                  <small>
                    {policy.terminalIds.length}{" "}
                    {policy.terminalIds.length === 1 ? "terminal" : "terminals"}, output only
                  </small>
                </div>
              </li>
            )}
            {policy.restrictedTerminal && (
              <li>
                <ShieldCheck size={18} />
                <div>
                  <strong>Commands</strong>
                  <small>
                    {policy.terminalApproval
                      ? "Reads run directly. Changes wait for you."
                      : "Read-only, inside its folders."}
                  </small>
                </div>
              </li>
            )}
            <li>
              <Clock3 size={18} />
              <div>
                <strong>{active ? "Access ends" : "Invitation expiry"}</strong>
                <small>{agent.standing && active ? "When you end it" : time(agent.expiresAt || 0)}</small>
              </div>
            </li>
          </ul>

          <div className="ag-actions">
            {canEditAccess(agent) && (
              <button
                className="ag-secondary ag-small"
                disabled={busy || !!error}
                onClick={() => setEditing(agent)}
              >
                {appScopedAccess(agent) ? "Manage access" : "Edit access"}
              </button>
            )}
            {active && (agent.preset === "full" || agent.preset === "apps") && (
              <button
                className="ag-secondary ag-small"
                disabled={busy || !!error}
                onClick={() => void pause(agent, !agent.paused)}
              >
                {agent.paused ? "Resume" : "Pause"}
              </button>
            )}
            {active && (
              <button
                className="ag-danger ag-small"
                disabled={busy || !!error}
                onClick={() => void stop([agent.id])}
              >
                {isStopping ? "Stopping…" : "Stop"}
              </button>
            )}
          </div>

          <details className="ag-fold ba-history">
            <summary>
              Activity <span className="ag-fold-count">{agentRecords.length}</span>
              <ChevronDown size={15} />
            </summary>
            {agentRecords.length ? (
              <ol className="ag-log">
                {agentRecords.map((record) => (
                  <li key={record.id} className={`is-${record.status}`}>
                    <div>
                      <strong>{statusWords(record.status)}</strong>
                      <time dateTime={new Date(record.createdAt).toISOString()}>
                        {time(record.createdAt)}
                      </time>
                    </div>
                    <code>{browserActionWords(record.action)}</code>
                    {record.folder && (
                      <small className="ba-path">
                        {record.folder}
                        {record.directory ? ` / ${record.directory}` : ""}
                      </small>
                    )}
                    {record.output && (
                      <details>
                        <summary>Output</summary>
                        <pre>{record.output}</pre>
                      </details>
                    )}
                    {record.error && <p className="ba-log-error">{record.error}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="ag-quiet">No requests or commands recorded for this session.</p>
            )}
            <p className="ag-quiet">
              Recent records are shown. Approvals apply only to this invitation.
            </p>
          </details>
        </div>
      </article>
    );
  };

  return (
    <section className="browser-agents ag-agents" aria-label="Agent sessions">
      <div className="ag-agents-head">
        <div>
          <h2>Agents</h2>
          <p>
            {active.length
              ? `${active.length} active${waiting ? ` · ${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""}`
              : "Invite an agent and choose what it can use."}
          </p>
        </div>
        <button className="ag-primary ag-small" onClick={invite}>
          <Plus size={16} /> Invite agent
        </button>
      </div>

      {agents.length > 0 && (
        <div className="ag-toolbar">
          <label className="ag-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search agents"
              placeholder="Search agents, folders, apps"
              value={query}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button
            className="ag-icon-button"
            onClick={() => setRevision((value) => value + 1)}
            aria-label="Refresh agent sessions"
            disabled={busy}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}
      <ErrorLine error={error} />
      <ErrorLine error={actionError} />
      <ErrorLine error={historyError} />
      <AgentShortcuts peer={peer} toast={toast} />
      <ServiceAccessPanel peer={peer} />
      <ToolBrowserSetup peer={peer} />
      {stopSnapshot && (
        <div
          className="ba-stop-confirm ag-confirm"
          role="group"
          aria-label="Confirm stop all agents"
        >
          <strong>
            Stop {stopSnapshot.length}{" "}
            {stopSnapshot.length === 1 ? "invitation" : "invitations"}?
          </strong>
          <p>
            This ends access and cancels queued work for these sessions. New
            invitations are not included.
          </p>
          <ul>
            {stopSnapshot.map((agent) => (
              <li key={agent.id}>
                <AgentAvatar name={agent.name} size={22} />
                {agent.name} <small>· {sessionCode(agent.id)}</small>
              </li>
            ))}
          </ul>
          <div>
            <button
              className="ag-secondary ag-small"
              disabled={busy}
              onClick={() => setStopSnapshot(null)}
            >
              Cancel
            </button>
            <button
              className="ag-danger ag-small"
              disabled={busy || !!error}
              onClick={() => void stop(stopSnapshot.map((agent) => agent.id))}
            >
              {busy ? "Stopping…" : "Stop these sessions"}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <Spinner label="Loading agent sessions…" />
      ) : !agents.length && !error ? (
        <div className="ag-empty">
          <AgentAvatar name="+" size={56} />
          <h3>No agents yet</h3>
          <p>
            Invite an agent. Pick what it may do, Full control
            to Read only, and approve it when it connects.
          </p>
          <button className="ag-primary" onClick={invite}>
            <Plus size={17} /> Invite an agent
          </button>
        </div>
      ) : null}

      {(shownActive.length > 0 || (!!active.length && !words)) && (
        <div className="ag-group">
          <div className="ag-group-head">
            <p className="ag-label">Active · {active.length}</p>
            <button
              className="ag-link is-danger"
              disabled={!active.length || busy || !!error}
              onClick={() =>
                setStopSnapshot(active.map(({ id, name }) => ({ id, name })))
              }
            >
              Stop all
            </button>
          </div>
          <div className="ba-list ag-list">{shownActive.map(card)}</div>
        </div>
      )}
      {shownEnded.length > 0 && (
        <details className="ag-group ag-ended" open={!!words || !active.length}>
          <summary className="ag-group-head">
            <p className="ag-label">Ended · {ended.length}</p>
            <ChevronDown size={15} />
          </summary>
          <div className="ba-list ag-list">{shownEnded.map(card)}</div>
        </details>
      )}
      {!!words && !shownActive.length && !shownEnded.length && (
        <p className="ag-quiet ag-center">No agent matches “{query.trim()}”.</p>
      )}
      {!!agents.length && (
        <p className="ag-quiet ag-footnote">
          Agents work in your real folders and apps, within their preset.
          Passwords, security prompts and Reach stay closed to every agent.
        </p>
      )}
      {editing && (
        <AccessEditor
          key={editing.id}
          peer={peer}
          device={device}
          client={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {connectionReview && (
        <AgentAdmissionReview
          key={connectionReview.requestId}
          peer={peer}
          admission={{
            ...connectionReview,
            name: `${connectionReview.name} · ${sessionCode(connectionReview.clientId)}`,
          }}
          onClose={() => setConnectionReview(null)}
          onResolved={() => {
            setConnectionReview(null);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {reviewing && (
        <BrowserApprovalReview
          key={reviewing.id}
          peer={peer}
          item={{
            ...reviewing,
            name: `${reviewing.name} · ${sessionCode(reviewing.clientId)}`,
          }}
          onClose={() => setReviewing(null)}
          onResolved={() => {
            setReviewing(null);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
