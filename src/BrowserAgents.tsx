import { activeSession } from "./access-list";
import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "./page-visible";
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Folder,
  History,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { PRESET_WORDS } from "./BrowserInvite";
import { type EditableAccess } from "./AccessEditor";
import { request, type Device, type Peer } from "./api";
import { requestDeadline } from "./request-deadline";
import { AgentAdmissionReview, type AgentAdmission } from "./agent-admissions";
import {
  BrowserApprovalReview,
  browserActionWords,
  type BrowserRequest,
} from "./browser-approvals";
import { ErrorLine, Spinner } from "./ui";
import SubPage from "./SubPage";
import ConfirmSheet from "./ConfirmSheet";
import { AppStack, appName } from "./agent-ui";
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
// One thing an agent did on the Mac (server/agent-actions.mjs).
type AgentAction = { id: string; at: number; kind: string; text: string; app?: string; ok: boolean; reason?: string };
type Props = {
  peer: Peer;
  device: Device;
  toast: (message: string) => void;
  // One agent's panel, by its invitation id; without it, the Ended page.
  focus?: string;
  // With a focus: that agent's own page under Ended.
  ended?: boolean;
  // Pages under Agents & people: open one ended agent, go back, and say
  // when some were cleared (its Ended count is the hub's).
  onOpen?: (id: string) => void;
  onBack?: () => void;
  onCleared?: () => void;
};
const sessionCode = (id: string) => id.slice(-8);
// Still going (src/access-list.ts: one reading for every list).
export { activeSession };
const time = (value: number | string) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
// The day an agent ended, with its year when not this one.
const endedOn = (at: number, now: number) =>
  new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
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

// Replacing the computer or agent also replaces its activity and open reviews.
export default function BrowserAgents(props: Props) {
  return (
    <BrowserAgentList
      key={`${props.peer.id}:${props.peer.url}:${props.peer.token}:${props.focus || ""}`}
      {...props}
    />
  );
}
function BrowserAgentList({ peer, toast, focus, ended: pastPage, onOpen, onBack, onCleared }: Props) {
  const [agents, setAgents] = useState<BrowserAgentSession[]>([]);
  const [records, setRecords] = useState<BrowserRequest[]>([]);
  const [currentRequests, setCurrentRequests] = useState<BrowserRequest[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [admissions, setAdmissions] = useState<AgentAdmission[]>([]);
  const [connectionReview, setConnectionReview] =
    useState<AgentAdmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  const [reviewing, setReviewing] = useState<BrowserRequest | null>(null);
  const visible = usePageVisible();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
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
      const deadline = requestDeadline(controller.signal);
      const results = await Promise.allSettled([
        request<{ agents: BrowserAgentSession[]; at: number }>(
          peer,
          "/api/browser/agents",
          { signal: deadline.signal },
        ),
        request<BrowserRequest[]>(peer, "/api/agents/browser-requests", {
          signal: deadline.signal,
        }),
        request<BrowserRequest[]>(
          peer,
          "/api/agents/browser-terminal-history",
          { signal: deadline.signal },
        ),
        request<AgentAdmission[]>(peer, "/api/agents/admissions", {
          signal: deadline.signal,
        }),
        // What this one agent did, newest first; an older Reach has no log.
        focus
          ? request<{ actions: AgentAction[] }>(peer, `/api/agents/actions?${new URLSearchParams({ clientId: focus, limit: "200" })}`, { signal: deadline.signal }).catch((failure) => {
              if (failure?.status === 404) return { actions: [] as AgentAction[] };
              throw failure;
            })
          : Promise.resolve({ actions: [] as AgentAction[] }),
      ]);
      deadline.dispose();
      if (!controller.signal.aborted) {
        const [sessions, requests, history, connections, did] = results;
        if (did.status === "fulfilled" && Array.isArray(did.value?.actions)) setActions(did.value.actions);
        if (
          sessions.status === "fulfilled" &&
          Array.isArray(sessions.value?.agents)
        ) {
          setAgents(sessions.value.agents);
          setError("");
        } else {
          setError(
            sessions.status === "rejected"
              ? sessions.reason.message
              : "Agent sessions could not be loaded.",
          );
          setReviewing(null);
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
        // Durable history may still say pending after the live request ended.
        // Only a successful read of the live queue can offer or retain a review.
        const nextRequests = requests.status === "fulfilled" && Array.isArray(requests.value)
          ? requests.value : [];
        setCurrentRequests(nextRequests);
        setReviewing((old) =>
          old
            ? nextRequests.find(
                (item) => item.id === old.id && item.clientId === old.clientId,
              ) || null
            : null,
        );
        setHistoryError(
          // Requests, history and admissions are arrays; the action log is
          // an object containing an actions array, even when it is empty.
          [requests, history, connections].some(
            (result) =>
              result.status === "rejected" || !Array.isArray(result.value),
          ) || did.status === "rejected" || !Array.isArray(did.value?.actions)
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
  const busy = pausing.current.size > 0;
  const ended = agents
    .filter((agent) => !activeSession(agent, now))
    .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  // What one agent may use and what it's doing.
  const body = (agent: BrowserAgentSession) => {
    const active = activeSession(agent, now);
    const agentRecords = records.filter((record) => record.clientId === agent.id);
    const pending = active
      ? currentRequests.filter((record) => record.clientId === agent.id && pendingRecord(record, now))
      : [];
    const admission = active
      ? admissions.find((item) => item.clientId === agent.id)
      : undefined;
    const presetWords = agent.preset ? PRESET_WORDS[agent.preset] : null;
    const policy = agent.policy || {};
    const folders = agent.folders || [];
    const apps = policy.appAccess || [];
    return (
      <>
          {agent.needsInvitation && (
            <p className="ag-quiet">This older Full control grant has ended. Create a new invitation to approve unrestricted access.</p>
          )}
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
            {agent.preset !== "full" && !!policy.hidden?.length && (
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
          </ul>

          {active && (agent.preset === "full" || agent.preset === "apps") && (
            <div className="ag-actions">
              <button
                className="ag-secondary ag-small"
                disabled={busy || !!error}
                onClick={() => void pause(agent, !agent.paused)}
              >
                {agent.paused ? "Resume" : "Pause"}
              </button>
            </div>
          )}

          {pastPage ? (
            <>
              <h2 className="gs-title">Activity</h2>
            {actions.length > 0 && (
              <ol className="ag-log ba-did" aria-label="What it did">
                {actions.map((item) => (
                  <li key={item.id} className={item.ok ? "" : "is-refused"}>
                    <div>
                      <strong>{item.text}</strong>
                      <time dateTime={new Date(item.at).toISOString()}>{time(item.at)}</time>
                    </div>
                    {item.app && <small>{item.app}</small>}
                    {!item.ok && <p className="ba-log-error">{item.reason ? `Refused: ${item.reason}` : "Refused"}</p>}
                  </li>
                ))}
              </ol>
            )}
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
            ) : !actions.length ? (
              <p className="ag-quiet">
                {pastPage
                  ? "No activity recorded."
                  : "Nothing yet. Every click, key, menu, file and command it does on this Mac will be listed here."}
              </p>
            ) : null}
            </>
          ) : (
          <details className="ag-fold ba-history">
            <summary>
              Activity <span className="ag-fold-count">{actions.length + agentRecords.length}</span>
              <ChevronDown size={15} />
            </summary>
            {actions.length > 0 && (
              <ol className="ag-log ba-did" aria-label="What it did">
                {actions.map((item) => (
                  <li key={item.id} className={item.ok ? "" : "is-refused"}>
                    <div>
                      <strong>{item.text}</strong>
                      <time dateTime={new Date(item.at).toISOString()}>{time(item.at)}</time>
                    </div>
                    {item.app && <small>{item.app}</small>}
                    {!item.ok && <p className="ba-log-error">{item.reason ? `Refused: ${item.reason}` : "Refused"}</p>}
                  </li>
                ))}
              </ol>
            )}
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
            ) : !actions.length ? (
              <p className="ag-quiet">
                {pastPage
                  ? "No activity recorded."
                  : "Nothing yet. Every click, key, menu, file and command it does on this Mac will be listed here."}
              </p>
            ) : null}
            <p className="ag-quiet">
              {actions.length ? "Its last 200 actions, kept across restarts. " : "Recent records are shown. "}Approvals apply only to this invitation.
            </p>
          </details>
          )}
      </>
    );
  };
  // Clear ended agents (the Mac forgets only ones it reads as ended;
  // nothing live is touched). Asked first in Reach's own sheet.
  const [asking, setAsking] = useState<BrowserAgentSession[] | null>(null);
  const [clearing, setClearing] = useState(false);
  const clear = async (list: BrowserAgentSession[]) => {
    setAsking(null);
    if (clearing || !list.length) return;
    setClearing(true);
    setActionError("");
    try {
      const ids = list.map((agent) => agent.id);
      const cleared: string[] = [], kept: string[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const answer = await request<{ cleared?: string[]; kept?: string[] }>(peer, "/api/browser/agents/clear", {
          method: "POST",
          body: JSON.stringify({ clientIds: ids.slice(i, i + 500) }),
        });
        cleared.push(...(Array.isArray(answer?.cleared) ? answer.cleared : []));
        kept.push(...(Array.isArray(answer?.kept) ? answer.kept : []));
      }
      if (!alive.current) return;
      // Only what the Mac says it cleared leaves the list.
      setAgents((old) => old.filter((agent) => !cleared.includes(agent.id)));
      setRevision((value) => value + 1);
      onCleared?.();
      if (kept.length)
        toast(kept.length === 1 ? "1 wasn’t cleared. It’s active again." : `${kept.length} weren’t cleared. They’re active again.`);
      else if (cleared.length)
        toast(list.length === 1 ? `${list[0].name} cleared` : `Cleared ${cleared.length} ${cleared.length === 1 ? "agent" : "agents"}`);
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      if (alive.current)
        setActionError(status === 404 ? "Restart Reach on the Mac to clear ended agents." : (failure as Error).message);
    } finally {
      if (alive.current) setClearing(false);
    }
  };
  const statusLine = (agent: BrowserAgentSession) => {
    const status =
      agent.status === "revoked"
        ? "Stopped"
        : agent.status === "denied"
          ? "Connection denied"
          : "Expired";
    // When it ended; one still dated ahead was stopped early (no date).
    const at = agent.expiresAt || 0;
    return at && at <= now ? `${status} · ${endedOn(at, now)}` : status;
  };
  const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() || "?";
  // An ended agent: a row that opens its own page.
  const row = (agent: BrowserAgentSession) => (
    <button
      type="button"
      className="gs-row ag-ended-row"
      key={agent.id}
      data-agent-id={agent.id}
      onClick={() => onOpen?.(agent.id)}
    >
      <span className="ppl-avatar ag-ended-avatar" aria-hidden="true">
        {initialOf(agent.name)}
      </span>
      <span className="gs-label">
        <strong>{agent.name}</strong>
        <small title={agent.id}>{statusLine(agent)}</small>
      </span>
      <ChevronRight className="gs-chevron" size={18} />
    </button>
  );
  const asked = asking && (
    <ConfirmSheet
      title={asking.length === 1 ? `Clear ${asking[0].name}?` : `Clear ${asking.length} ended agents?`}
      detail={asking.length === 1 ? "Its activity goes too." : "Their activity goes too."}
      confirm={asking.length === 1 ? "Clear" : "Clear all"}
      onConfirm={() => void clear(asking)}
      onCancel={() => setAsking(null)}
    />
  );

  // One agent, inside its sheet on Agents & people: what needs you, what it's
  // doing, what it may use, Pause, and its activity. Edit access, when it
  // ends, its link and Remove are the sheet's own rows.
  const focused = focus ? agents.find((agent) => agent.id === focus) : undefined;
  // Cleared (here or elsewhere), or never there: back to Ended, never a
  // blank page.
  const gone = !!focus && pastPage && !loading && !error && !focused;
  useEffect(() => {
    if (gone) onBack?.();
  }, [gone]);
  const errors = (
    <>
      <ErrorLine error={error} />
      <ErrorLine error={actionError} />
      <ErrorLine error={historyError} />
    </>
  );
  const reviews = (
    <>
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
    </>
  );
  // The Ended page: one list, Clear all across from Back.
  if (!focus)
    return (
      <SubPage
        title="Ended"
        backLabel="Back to Agents & people"
        onBack={() => onBack?.()}
        action={
          !loading && ended.length > 0 && (
            <button type="button" className="sub-page-action is-danger" disabled={clearing} onClick={() => setAsking(ended)}>
              {clearing ? "Clearing…" : "Clear all"}
            </button>
          )
        }
      >
        <section className="browser-agents ag-agents ag-embedded" aria-label="Ended agents">
          {errors}
          {loading ? (
            <Spinner label="Loading…" />
          ) : ended.length ? (
            <div className="gs-group ag-ended-list">{ended.map(row)}</div>
          ) : (
            <div className="ag-ended-empty">
              <History size={26} />
              <p>No ended agents</p>
              <small>Agents show up here when their access ends.</small>
            </div>
          )}
        </section>
        {asked}
      </SubPage>
    );
  // One ended agent's page: who it was, what it could use, what it did, Clear.
  if (pastPage)
    return (
      <SubPage backLabel="Back to Ended" onBack={() => onBack?.()}>
        <section className="browser-agents ag-agents ag-embedded" aria-label="Ended agent">
          {errors}
          {loading ? (
            <Spinner label="Loading…" />
          ) : (
            focused && (
              <>
                <div className="ppl-hero">
                  <span className="ppl-avatar large ag-ended-avatar" aria-hidden="true">
                    {initialOf(focused.name)}
                  </span>
                  <h1 tabIndex={-1}>{focused.name}</h1>
                  <small>{statusLine(focused)}</small>
                </div>
                <h2 className="gs-title">Access</h2>
                {body(focused)}
                <div className="gs-group gs-end">
                  <button type="button" className="gs-row gs-danger" disabled={clearing} onClick={() => setAsking([focused])}>
                    <Trash2 size={21} />
                    <span className="gs-label">{clearing ? "Clearing…" : "Clear"}</span>
                  </button>
                </div>
              </>
            )
          )}
        </section>
        {asked}
      </SubPage>
    );
  // One live agent, inside its sheet on Agents & people.
  return (
    <section className="browser-agents ag-agents ag-embedded" aria-label="Agent session">
      {errors}
      {loading ? <Spinner label="Loading…" /> : focused && body(focused)}
      {reviews}
    </section>
  );
}
