import { useEffect, useId, useRef, useState } from "react";
import { Bot, Clock3, Folder, Plus, RefreshCw, Square } from "lucide-react";
import AccessEditor, {
  accessSummary,
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
import ScreenPopup from "./ScreenPopup";
import "./browser-agents.css";

export type BrowserAgentSession = EditableAccess & {
  createdAt: string | number;
  folders: string[];
  pendingApprovals: number;
  activity: {
    state: "idle" | "waiting" | "running" | "stopping";
    folder?: string;
    kind?: string;
  };
  workspace?: AgentWorkspace;
};
type AgentWorkspace = {
  id: string;
  status: string;
  sources: string[];
  roots: string[];
  lastApply?: WorkspaceApply & { interrupted?: boolean };
};
type WorkspaceReview = {
  id: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  changes: {
    root: number;
    path: string;
    type: "added" | "changed" | "deleted";
    beforeHash: string | null;
    afterHash: string | null;
    beforeText: string | null;
    afterText: string | null;
    binary: boolean;
    previewTruncated?: boolean;
    conflict?: string;
  }[];
  summary: {
    added: number;
    changed: number;
    deleted: number;
    bytes: number;
    skipped: number;
    conflicts: number;
  };
};
type WorkspaceApply = {
  workspaceId: string;
  reviewId: string;
  applied: { root: number; path: string; type: string }[];
  partial: boolean;
  failed?: { root: number; path: string; message: string };
};
type Props = {
  peer: Peer;
  device: Device;
  invite: () => void;
  toast: (message: string) => void;
};
const sessionCode = (id: string) => id.slice(-8);
const reviewText = (value: string) =>
  value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
// Treat missing or inconsistent conflict data as an incomplete review. The
// button and its handler both use this check; a malformed reply cannot grant
// permission to apply a set whose source files have not been confirmed.
const reviewConflicts = (review: WorkspaceReview) => {
  const files = review.changes.flatMap((change, index) =>
    Object.hasOwn(change, "conflict") ? [index] : [],
  );
  const malformed =
    !Number.isSafeInteger(review.summary?.conflicts) ||
    review.summary.conflicts < 0 ||
    review.summary.conflicts !== files.length ||
    files.some(
      (index) =>
        typeof review.changes[index].conflict !== "string" ||
        !review.changes[index].conflict?.trim(),
    );
  return { files, malformed, blocked: malformed || files.length > 0 };
};
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
  const conflictNoticeId = useId();
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
  const [workspaceConfirm, setWorkspaceConfirm] = useState<{
    agent: BrowserAgentSession;
    action: "review" | "discard";
  } | null>(null);
  const [workspaceReview, setWorkspaceReview] = useState<{
    agent: BrowserAgentSession;
    review: WorkspaceReview;
    usable: boolean;
    result?: WorkspaceApply;
  } | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const alive = useRef(true);
  const mutations = useRef(new Set<AbortController>());
  const mutationPending = useRef(false);
  const stopped = useRef(new Set<string>());
  const discarded = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const controller of mutations.current) controller.abort();
    };
  }, []);
  useEffect(() => {
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
            sessions.value.agents
              .filter(
                (agent) =>
                  !agent.workspace ||
                  !discarded.current.has(agent.workspace.id),
              )
              .map((agent) =>
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
          setWorkspaceReview(null);
          setWorkspaceConfirm(null);
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
  }, [peer, revision]);
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
  const workspaceAction = async (
    agent: BrowserAgentSession,
    action: "review" | "discard",
    confirmed = false,
  ) => {
    const workspace = agent.workspace;
    if (!workspace || mutationPending.current || error) return;
    if (
      !confirmed &&
      (action === "discard" || activeSession(agent, Date.now()))
    ) {
      setWorkspaceConfirm({ agent, action });
      setWorkspaceError("");
      return;
    }
    mutationPending.current = true;
    setWorkspaceBusy(workspace.id);
    setWorkspaceError("");
    setActionError("");
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      const result = await request<WorkspaceReview>(
        peer,
        `/api/agents/workspaces/${encodeURIComponent(workspace.id)}${action === "review" ? "/review" : ""}`,
        {
          method: action === "review" ? "POST" : "DELETE",
          signal: controller.signal,
          ...(action === "review" ? { body: "{}" } : {}),
        },
      );
      if (!alive.current || controller.signal.aborted) return;
      stopped.current.add(agent.id);
      setAgents((old) =>
        old.map((item) =>
          item.id === agent.id ? { ...item, status: "revoked" } : item,
        ),
      );
      setWorkspaceConfirm(null);
      if (action === "review") {
        if (
          !result ||
          result.workspaceId !== workspace.id ||
          typeof result.id !== "string" ||
          !result.id ||
          !Array.isArray(result.changes) ||
          result.changes.some(
            (change) =>
              !change ||
              typeof change !== "object" ||
              !Number.isSafeInteger(change.root) ||
              change.root < 0 ||
              typeof change.path !== "string" ||
              !["added", "changed", "deleted"].includes(change.type),
          ) ||
          !Number.isFinite(result.expiresAt) ||
          result.expiresAt <= Date.now()
        )
          throw Error(
            "Reach did not return a valid review. Nothing was applied. Review the changes again.",
          );
        setWorkspaceReview({
          agent: { ...agent, status: "revoked" },
          review: result,
          usable: true,
        });
      } else {
        discarded.current.add(workspace.id);
        setAgents((old) =>
          old.filter((item) => item.workspace?.id !== workspace.id),
        );
        setWorkspaceReview(null);
        toast("Private copy discarded");
      }
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) {
        setWorkspaceError((failure as Error).message);
        if (!workspaceReview) setActionError((failure as Error).message);
      }
    } finally {
      mutations.current.delete(controller);
      mutationPending.current = false;
      if (alive.current && !controller.signal.aborted) {
        setWorkspaceBusy("");
        setRevision((value) => value + 1);
      }
    }
  };
  const applyWorkspace = async () => {
    const current = workspaceReview;
    if (
      !current?.usable ||
      mutationPending.current ||
      error ||
      reviewConflicts(current.review).blocked ||
      !current.review.changes.length
    )
      return;
    if (current.review.expiresAt <= Date.now()) {
      setWorkspaceReview({ ...current, usable: false });
      setWorkspaceError("This review expired. Review the changes again.");
      return;
    }
    const workspace = current.agent.workspace!;
    mutationPending.current = true;
    setWorkspaceBusy(workspace.id);
    setWorkspaceError("");
    // A network failure may arrive after the host applied files. Never retry an
    // uncertain write automatically or keep a potentially consumed token enabled.
    setWorkspaceReview({ ...current, usable: false });
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      const result = await request<WorkspaceApply>(
        peer,
        `/api/agents/workspaces/${encodeURIComponent(workspace.id)}/apply`,
        {
          method: "POST",
          body: JSON.stringify({ reviewId: current.review.id }),
          signal: controller.signal,
        },
      );
      if (!alive.current || controller.signal.aborted) return;
      if (
        result?.workspaceId !== workspace.id ||
        result.reviewId !== current.review.id ||
        !Array.isArray(result.applied) ||
        typeof result.partial !== "boolean"
      )
        throw Error(
          "Reach did not confirm the result. Refresh the session before reviewing again.",
        );
      setWorkspaceReview({ ...current, usable: false, result });
      setAgents((old) =>
        old.map((agent) =>
          agent.workspace?.id === workspace.id
            ? {
                ...agent,
                workspace: {
                  ...agent.workspace,
                  status: result.partial ? "partial" : "applied",
                  lastApply: result,
                },
              }
            : agent,
        ),
      );
      if (!result.partial) toast("Reviewed changes applied");
    } catch (failure) {
      if (alive.current && !controller.signal.aborted)
        setWorkspaceError((failure as Error).message);
    } finally {
      mutations.current.delete(controller);
      mutationPending.current = false;
      if (alive.current && !controller.signal.aborted) {
        setWorkspaceBusy("");
        setRevision((value) => value + 1);
      }
    }
  };
  const active = agents.filter((agent) => activeSession(agent, now));
  const busy = stopping.length > 0 || !!workspaceBusy;
  const conflicts = workspaceReview
    ? reviewConflicts(workspaceReview.review)
    : null;
  return (
    <section className="browser-agents" aria-label="Agent sessions">
      <div className="ba-heading">
        <div>
          <h2>Agents</h2>
          <p>Each invitation has its own access and approvals.</p>
        </div>
        <button className="button primary small" onClick={invite}>
          <Plus size={16} /> Invite agent
        </button>
      </div>
      <div className="ba-toolbar">
        <span>
          {active.length} active{" "}
          {active.length === 1 ? "invitation" : "invitations"}
        </span>
        <div>
          <button
            className="button ghost small"
            onClick={() => setRevision((value) => value + 1)}
            aria-label="Refresh agent sessions"
            disabled={busy}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="button ghost small danger"
            disabled={!active.length || busy || !!error}
            onClick={() =>
              setStopSnapshot(active.map(({ id, name }) => ({ id, name })))
            }
          >
            <Square size={13} /> Stop all
          </button>
        </div>
      </div>
      <ErrorLine error={error} />
      <ErrorLine error={actionError} />
      <ErrorLine error={historyError} />
      {workspaceConfirm && (
        <div
          className="ba-stop-confirm"
          role="group"
          aria-label={
            workspaceConfirm.action === "review"
              ? "Confirm stop and review"
              : "Confirm discard private copy"
          }
        >
          <strong>
            {workspaceConfirm.action === "review"
              ? `Stop ${workspaceConfirm.agent.name} and review changes?`
              : `Discard ${workspaceConfirm.agent.name}’s private copy?`}
          </strong>
          <p>
            {workspaceConfirm.action === "review"
              ? "This ends this invitation and waits for its commands to stop. Your original folders stay unchanged until you apply the reviewed changes."
              : "This ends access and permanently removes this private copy, unapplied changes, and its retained backups. It does not change your original folders."}
          </p>
          <div>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => setWorkspaceConfirm(null)}
            >
              Cancel
            </button>
            <button
              className={`button secondary small${workspaceConfirm.action === "discard" ? " danger" : ""}`}
              disabled={busy || !!error}
              onClick={() =>
                void workspaceAction(
                  workspaceConfirm.agent,
                  workspaceConfirm.action,
                  true,
                )
              }
            >
              {busy
                ? "Please wait…"
                : workspaceConfirm.action === "review"
                  ? "Stop and review"
                  : "Discard private copy"}
            </button>
          </div>
        </div>
      )}
      {stopSnapshot && (
        <div
          className="ba-stop-confirm"
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
                {agent.name} <small>· {sessionCode(agent.id)}</small>
              </li>
            ))}
          </ul>
          <div>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => setStopSnapshot(null)}
            >
              Cancel
            </button>
            <button
              className="button secondary small danger"
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
        <div className="ba-empty">
          <Bot size={28} />
          <h3>No agent invitations</h3>
          <p>
            Invite Muse or another agent to work with the access you choose.
          </p>
        </div>
      ) : null}
      <div className="ba-list">
        {agents.map((agent) => {
          const active = activeSession(agent, now);
          const agentRecords = records.filter(
            (record) => record.clientId === agent.id,
          );
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
          return (
            <article
              className="ba-session"
              key={agent.id}
              data-agent-id={agent.id}
            >
              <div className="ba-session-heading">
                <span className="ba-avatar">
                  <Bot size={20} />
                </span>
                <div className="ba-identity">
                  <h3>{agent.name}</h3>
                  <small title={agent.id}>
                    Session {sessionCode(agent.id)} · {time(agent.createdAt)}
                  </small>
                </div>
                <span className={`ba-status${active ? " is-active" : ""}`}>
                  {status}
                </span>
              </div>
              {active && agent.status === "pending" && (
                <div className="ba-connection">
                  <p>Waiting for your connection approval.</p>
                  {admission && (
                    <button
                      className="button secondary small"
                      disabled={busy || !!error}
                      onClick={() => setConnectionReview(admission)}
                    >
                      Review connection
                    </button>
                  )}
                </div>
              )}
              <p className="ba-permissions">{accessSummary(agent)}</p>
              {agent.workspace && (
                <p className="ba-workspace-note">
                  <strong>Private copy</strong>
                  <span>
                    {agent.workspace.status === "applied"
                      ? "Reviewed changes applied. The copy and backups are kept until you discard them."
                      : agent.workspace.status === "partial"
                        ? "Some changes were applied. The copy and backups are kept for recovery."
                        : "Original folders stay unchanged until you review and apply changes."}
                  </span>
                </p>
              )}
              {agent.workspace?.lastApply && (
                <details className="ba-apply-history">
                  <summary>
                    Applied changes · {agent.workspace.lastApply.applied.length}
                  </summary>
                  {!!agent.workspace.lastApply.applied.length && (
                    <ul>
                      {agent.workspace.lastApply.applied.map((change) => (
                        <li
                          key={`${change.root}:${change.path}`}
                          className="ba-path"
                        >
                          {reviewText(change.path)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {agent.workspace.lastApply.failed && (
                    <p className="ba-log-error">
                      {reviewText(agent.workspace.lastApply.failed.path)}:{" "}
                      {agent.workspace.lastApply.failed.message}
                    </p>
                  )}
                  {agent.workspace.lastApply.interrupted && (
                    <p className="ba-log-error">
                      Applying was interrupted. Check the originals before
                      discarding the retained copy and backups.
                    </p>
                  )}
                </details>
              )}
              <div className="ba-meta">
                <Clock3 size={14} />
                <span>
                  {active ? "Access ends" : "Invitation expiry"}{" "}
                  {time(agent.expiresAt || 0)}
                </span>
              </div>
              {(agent.workspace?.sources || agent.folders)?.length ? (
                <div className="ba-meta">
                  <Folder size={14} />
                  <div>
                    {agent.workspace && <small>Original folders</small>}
                    {(agent.workspace?.sources || agent.folders).map(
                      (folder) => (
                        <div className="ba-path" key={folder}>
                          {folder}
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ) : (
                <p className="ba-no-folders">No folders shared</p>
              )}
              {active &&
                agent.activity?.folder &&
                ["waiting", "running", "stopping"].includes(
                  agent.activity.state,
                ) && (
                  <p className="ba-work">
                    {agent.activity.state === "waiting"
                      ? "Waiting to change"
                      : agent.activity.state === "stopping"
                        ? "Stopping work in"
                        : "Working in"}{" "}
                    <span className="ba-path">{agent.activity.folder}</span>
                  </p>
                )}
              {!!pending.length && (
                <div className="ba-pending">
                  <strong>
                    {pending.length}{" "}
                    {pending.length === 1 ? "request" : "requests"} for this
                    session
                  </strong>
                  {pending.map((record) => (
                    <div className="ba-request" key={record.id}>
                      <span>{browserActionWords(record.action)}</span>
                      <button
                        className="button secondary small"
                        disabled={busy || !!error}
                        onClick={() => setReviewing(record)}
                      >
                        Review
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="ba-session-actions">
                {!agent.workspace && canEditAccess(agent) && (
                  <button
                    className="button secondary small"
                    disabled={busy || !!error}
                    onClick={() => setEditing(agent)}
                  >
                    {appScopedAccess(agent) ? "Manage access" : "Edit access"}
                  </button>
                )}
                {agent.workspace &&
                  !["applied", "partial", "discarded"].includes(
                    agent.workspace.status,
                  ) && (
                    <button
                      className="button secondary small"
                      disabled={busy || !!error}
                      onClick={() => void workspaceAction(agent, "review")}
                    >
                      {workspaceBusy === agent.workspace.id
                        ? "Preparing review…"
                        : active
                          ? "Stop & review changes"
                          : "Review changes"}
                    </button>
                  )}
                {agent.workspace && agent.workspace.status !== "discarded" && (
                  <button
                    className="button ghost small danger"
                    disabled={busy || !!error}
                    onClick={() => void workspaceAction(agent, "discard")}
                  >
                    Discard copy
                  </button>
                )}
                {active && (
                  <button
                    className="button ghost small danger"
                    disabled={busy || !!error}
                    onClick={() => void stop([agent.id])}
                  >
                    {isStopping ? "Stopping…" : "Stop"}
                  </button>
                )}
              </div>
              <details className="ba-history">
                <summary>
                  Activity &amp; command log <span>{agentRecords.length}</span>
                </summary>
                {agentRecords.length ? (
                  <ol>
                    {agentRecords.map((record) => (
                      <li key={record.id}>
                        <div>
                          <strong>{statusWords(record.status)}</strong>
                          <time
                            dateTime={new Date(record.createdAt).toISOString()}
                          >
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
                        {record.error && (
                          <p className="ba-log-error">{record.error}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No requests or commands recorded for this session.</p>
                )}
                <p className="ba-log-note">
                  Recent records are shown. Approvals apply only to this
                  invitation.
                </p>
              </details>
            </article>
          );
        })}
      </div>
      {!!agents.length && (
        <p className="ba-footnote">
          Private copies belong to one invitation. Shared folders expose
          approved changes to other agents with access. Selected app windows
          remain view-only.
        </p>
      )}
      {workspaceReview && (
        <ScreenPopup
          title={`${workspaceReview.agent.name}: review changes`}
          className="ba-workspace-review"
          onClose={() => {
            if (!busy) {
              setWorkspaceReview(null);
              setWorkspaceError("");
            }
          }}
        >
          <div className="ba-review-intro">
            <p>
              Agent access has ended. Apply this reviewed set to your original
              folders. Unrelated file edits do not block applying these changes.
            </p>
            <p>
              Empty-folder changes are not applied. Added and changed files use
              owner-only permissions; executable permissions are not kept.
            </p>
            <span>
              {workspaceReview.review.changes.length}{" "}
              {workspaceReview.review.changes.length === 1 ? "file" : "files"}{" "}
              changed · Review expires {time(workspaceReview.review.expiresAt)}
            </span>
          </div>
          <ErrorLine error={workspaceError} />
          {conflicts?.blocked && !workspaceReview.result && (
            <div
              className="ba-review-conflicts"
              role="alert"
              id={conflictNoticeId}
            >
              <strong>
                {conflicts.malformed
                  ? "Review details are incomplete"
                  : `${conflicts.files.length} ${conflicts.files.length === 1 ? "file needs" : "files need"} resolution`}
              </strong>
              <p>
                {conflicts.malformed
                  ? "Reach could not confirm every conflict. Review again before applying."
                  : "Original files changed since this copy was created. Resolve the marked files, then review again. Nothing can be applied while a conflict remains."}
              </p>
            </div>
          )}
          {workspaceReview.result && (
            <p
              className={`ba-review-result${workspaceReview.result.partial ? " is-partial" : ""}`}
              role="status"
            >
              {workspaceReview.result.partial
                ? `${workspaceReview.result.applied.length} file changes applied before an error. ${workspaceReview.result.failed?.message || "Some changes could not be applied."} Some parent folders may also have been created. The private copy and backups are retained.`
                : `${workspaceReview.result.applied.length} reviewed file ${workspaceReview.result.applied.length === 1 ? "change" : "changes"} applied. The private copy and backups are retained until you discard them.`}
            </p>
          )}
          {!workspaceReview.review.changes.length ? (
            <p className="ba-review-empty">No file changes to apply.</p>
          ) : (
            <div className="ba-review-files" aria-label="Reviewed file changes">
              {workspaceReview.review.changes.map((change, index) => (
                <details
                  key={`${workspaceReview.review.id}:${change.root}:${change.path}`}
                  open={index === (conflicts?.files[0] ?? 0)}
                  className={
                    Object.hasOwn(change, "conflict")
                      ? "has-conflict"
                      : undefined
                  }
                >
                  <summary
                    aria-describedby={
                      Object.hasOwn(change, "conflict")
                        ? `${conflictNoticeId}-${index}`
                        : undefined
                    }
                  >
                    <span
                      className={`ba-change-type ${Object.hasOwn(change, "conflict") ? "is-conflict" : `is-${change.type}`}`}
                    >
                      {Object.hasOwn(change, "conflict")
                        ? "Conflict"
                        : change.type === "deleted"
                          ? "Deleted"
                          : change.type === "added"
                            ? "Added"
                            : "Changed"}
                    </span>
                    <span className="ba-path">{reviewText(change.path)}</span>
                  </summary>
                  {Object.hasOwn(change, "conflict") && (
                    <p
                      className="ba-file-conflict"
                      id={`${conflictNoticeId}-${index}`}
                    >
                      {typeof change.conflict === "string" &&
                      change.conflict.trim()
                        ? reviewText(change.conflict)
                        : "Conflict details are unavailable. Review again before applying."}
                    </p>
                  )}
                  <p className="ba-review-destination ba-path">
                    Original:{" "}
                    {reviewText(
                      `${workspaceReview.agent.workspace?.sources[change.root]}/${change.path}`,
                    )}
                  </p>
                  {change.binary || change.previewTruncated ? (
                    <p className="ba-review-unavailable">
                      {change.binary
                        ? "Binary file. A text preview is unavailable."
                        : "This file is too large for a complete text preview."}
                    </p>
                  ) : (
                    <div className="ba-review-diff">
                      <section>
                        <h4>Before</h4>
                        <pre>
                          {typeof change.beforeText === "string"
                            ? reviewText(change.beforeText)
                            : change.type === "added"
                              ? "File did not exist"
                              : "Preview unavailable"}
                        </pre>
                      </section>
                      <section>
                        <h4>After</h4>
                        <pre>
                          {typeof change.afterText === "string"
                            ? reviewText(change.afterText)
                            : change.type === "deleted"
                              ? "File deleted"
                              : "Preview unavailable"}
                        </pre>
                      </section>
                    </div>
                  )}
                </details>
              ))}
            </div>
          )}
          {!!workspaceReview.review.summary?.skipped && (
            <p className="ba-review-unavailable">
              {workspaceReview.review.summary.skipped} items were excluded from
              this review.
            </p>
          )}
          <div className="ba-review-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setWorkspaceReview(null);
                setWorkspaceError("");
              }}
            >
              Close
            </button>
            {!workspaceReview.result &&
              (!workspaceReview.usable ||
                conflicts?.blocked ||
                workspaceReview.review.expiresAt <= now) && (
                <button
                  className="button secondary"
                  disabled={busy || !!error}
                  onClick={() =>
                    void workspaceAction(workspaceReview.agent, "review", true)
                  }
                >
                  Review again
                </button>
              )}
            {!workspaceReview.result && (
              <button
                className="button primary"
                disabled={
                  busy ||
                  !!error ||
                  !workspaceReview.usable ||
                  !!conflicts?.blocked ||
                  !workspaceReview.review.changes.length ||
                  workspaceReview.review.expiresAt <= now
                }
                aria-describedby={
                  conflicts?.blocked ? conflictNoticeId : undefined
                }
                onClick={() => void applyWorkspace()}
              >
                {workspaceBusy ? "Applying…" : "Apply reviewed changes"}
              </button>
            )}
          </div>
        </ScreenPopup>
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
