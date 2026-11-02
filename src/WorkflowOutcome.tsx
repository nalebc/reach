import { useEffect, useRef, useState } from "react";
import { post, request, type Peer } from "./api";
import type { Workflow, OutcomeCapabilities } from "./Workflows";
import WorkflowOutcomeEditor, {
  type OutcomeContract,
  type Criterion,
} from "./WorkflowOutcomeEditor";
import FileTextPreview from "./FileTextPreview";
import "./files.css";

type Tuple = {
  contractRevision: number;
  contractDigest: string;
  resultRevision: number | null;
  resultDigest: string | null;
  evidenceRevision: number;
  evidenceDigest: string;
};
type Check = {
  id?: string;
  checkId?: string;
  source?: string;
  status: string;
  exitCode?: number | null;
  complete?: boolean;
  candidateDigest?: string;
  profileDigest?: string;
  logDigest?: string;
};
type Receipt = {
  evidenceDigest: string;
  evidenceVersion: number;
  truncated: boolean;
  historyIncomplete: boolean;
  unknowns: string[];
  provenance: {
    workflowId: string;
    taskId: string;
    attempt: number;
    provider: string;
    turnId?: string;
    contractRevision?: number;
  };
};
type Outcome = Tuple & {
  version: number;
  phase: string;
  planDigest: string;
  contract?: OutcomeContract;
  plan: {
    builder: { agent: string };
    independentChecker: { id: string; profileId: string }[];
    reviewer: { agent: string; scope?: string };
    branches: {
      id: string;
      title: string;
      agent: string;
      model?: string;
      condition: string;
    }[];
    scope: { allowedChangedPaths: string[] };
    limits: {
      wallSeconds: number;
      maxBuildAttempts: number;
      maxTotalCheckRuns: number;
      maxTotalReviewAttempts: number;
    };
  } | null;
  preparation: {
    preparedDigest: string;
    prepared: {
      buildCwd?: string;
      reviewCwd?: string;
      profiles: {
        id: string;
        definitionDigest?: string;
        definition: {
          executable: string;
          args: string[];
          cwd?: string;
          environment?: string[];
          outputBytes?: number;
        };
      }[];
      isolation: string;
    };
  } | null;
  execution: {
    deadlineAt: number | null;
    startedAt?: number | null;
    hold?: string;
    pending?: { kind: string } | null;
    baseline?: Check[];
    counts?: { builds: number; checks: number; reviews: number };
    observations?: {
      criterionId: string;
      resultDigest: string;
      passed: boolean;
      note: string;
      at: number;
    }[];
  } | null;
  taskCompletion?: { completed: number; skipped: number; uncertain: number };
  checks?: Check[];
  review?: {
    status?: string;
    inputDigest?: string;
    receiptDigest?: string;
    report?: {
      status: string;
      findings: { id: string; text: string; blocking: boolean }[];
    };
    chat?: { agent: string; id: string };
  };
  results?: Receipt[];
  historyIncomplete?: boolean;
  truncated?: boolean;
  updatedAt?: number;
  unresolved: { id: string; blocking?: boolean }[];
  acceptance: {
    status: string;
    eligible: boolean;
    decision?: { at: number; tuple: Tuple };
  };
};
const tuple = (o: Outcome): Tuple => ({
  contractRevision: o.contractRevision,
  contractDigest: o.contractDigest,
  resultRevision: o.resultRevision,
  resultDigest: o.resultDigest,
  evidenceRevision: o.evidenceRevision,
  evidenceDigest: o.evidenceDigest,
});
const identity = (o: Outcome) => JSON.stringify(tuple(o));
const words = (s: string) => s.replaceAll("_", " ");
const date = (at?: number | null) =>
  at ? new Date(at).toLocaleString() : "Time unavailable";

type ProviderResult = Receipt & {
  collectedAt: number;
  evidenceFrozen: boolean;
  summary: string;
  changes: {
    files: string;
    diff: string;
    truncated: boolean;
    itemId: string | null;
  }[];
  commands: {
    command: string;
    output: string;
    exitCode: number | null;
    status: string;
    outputCompleteness: string;
  }[];
};
function TaskEvidence({
  peer,
  base,
  receipt,
  title,
  onOpenChat,
  chat,
}: {
  peer: Peer;
  base: string;
  receipt: Receipt;
  title: string;
  chat?: { agent: string; id: string };
  onOpenChat?: (chat: { agent: string; id: string }) => void;
}) {
  const [result, setResult] = useState<ProviderResult | null>(null),
    [problem, setProblem] = useState(""),
    [loading, setLoading] = useState(false);
  const load = async () => {
    if (result || loading) return;
    setLoading(true);
    setProblem("");
    try {
      const r = await request<{
        result: ProviderResult;
        omittedAttempts: number;
      }>(
        peer,
        `${base}/tasks/${encodeURIComponent(receipt.provenance.taskId)}/result?attempt=${receipt.provenance.attempt}`,
      );
      if (r.result.evidenceDigest !== receipt.evidenceDigest)
        throw Error(
          "This attempt receipt changed. Refresh the outcome before inspecting it.",
        );
      setResult(r.result);
      if (r.omittedAttempts)
        setProblem(
          `${r.omittedAttempts} earlier attempt receipts were omitted.`,
        );
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      className="wf-outcome-card"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>
        {title} · attempt {receipt.provenance.attempt} · provider-reported diffs
        and commands
      </summary>
      <p>
        Original task turn only. Provider records do not attest the final
        candidate bytes or exclude concurrent edits.
      </p>
      <p>
        Provider: {receipt.provenance.provider} · turn:{" "}
        {receipt.provenance.turnId || "unavailable"} · contract revision:{" "}
        {receipt.provenance.contractRevision ?? "unavailable"}
      </p>
      <p>
        Receipt: <code>{receipt.evidenceDigest}</code>
      </p>
      {receipt.historyIncomplete && (
        <p className="wf-outcome-warning">Original-turn history incomplete</p>
      )}
      {receipt.truncated && (
        <p className="wf-outcome-warning">
          Stored evidence clipped; omitted content is unavailable in this
          receipt.
        </p>
      )}
      {!!receipt.unknowns.length && (
        <p>
          Provider evidence unknowns: {receipt.unknowns.map(words).join(", ")}
        </p>
      )}
      {result && (
        <>
          <p>
            Collected {date(result.collectedAt)} ·{" "}
            {result.evidenceFrozen
              ? "Frozen receipt"
              : "Receipt still changing"}
          </p>
          {result.summary && (
            <details>
              <summary>Builder or reviewer claims · untrusted</summary>
              <FileTextPreview name="Agent claims" text={result.summary} />
            </details>
          )}
          <h4>Task-attributed diffs</h4>
          {!result.changes.length && (
            <p>
              No recorded changes in this attempt. This does not prove no files
              changed.
            </p>
          )}
          {result.changes.map((change, i) => (
            <div key={i}>
              <p>
                {change.files} · item {change.itemId || "unavailable"}
                {change.truncated ? " · diff clipped" : ""}
              </p>
              <FileTextPreview
                name={`${title} diff ${i + 1}`}
                text={change.diff}
              />
            </div>
          ))}
          <h4>Recorded provider commands</h4>
          {!result.commands.length && (
            <p>No commands recorded. Check execution is unknown.</p>
          )}
          {result.commands.map((command, i) => (
            <details key={i}>
              <summary>
                {command.command} · exit {command.exitCode ?? "unknown"}
              </summary>
              <p>
                {command.status} · output {command.outputCompleteness}
              </p>
              <FileTextPreview
                name={`Command ${i + 1} output`}
                text={command.output}
              />
            </details>
          ))}
        </>
      )}
      {loading && <p role="status">Loading frozen attempt evidence…</p>}
      {problem && (
        <p role="alert" className="wf-outcome-warning">
          {problem}
        </p>
      )}
      {!result && !loading && (
        <button className="wf-pill" onClick={() => void load()}>
          Load attempt evidence
        </button>
      )}
      {chat && onOpenChat && (
        <button className="wf-pill" onClick={() => onOpenChat(chat)}>
          Open task chat
        </button>
      )}
    </details>
  );
}
function checkStatus(check: Check | undefined, outcome: Outcome) {
  const definition = outcome.contract?.checks.find(
    (c) => c.id === (check?.checkId || check?.id),
  );
  if (
    check &&
    ((check.candidateDigest &&
      check.candidateDigest !== outcome.resultDigest) ||
      (definition &&
        check.profileDigest &&
        check.profileDigest !== definition.definitionDigest))
  )
    return "stale";
  if (
    !check ||
    check.candidateDigest !== outcome.resultDigest ||
    !check.profileDigest ||
    check.source !== "independent_runner" ||
    check.complete !== true ||
    !Number.isInteger(check.exitCode) ||
    !check.logDigest
  )
    return check?.status === "stale" ? "stale" : "unknown";
  if (check.status === "passed" && check.exitCode === 0) return "passed";
  if (check.status === "failed" && check.exitCode !== 0) return "failed";
  return "unknown";
}
function Observation({
  criterion,
  outcome,
  disabled,
  onRecord,
}: {
  criterion: Criterion;
  outcome: Outcome;
  disabled: boolean;
  onRecord: (id: string, passed: boolean, note: string) => void;
}) {
  const [note, setNote] = useState(""),
    [passed, setPassed] = useState(true);
  const observation = [...(outcome.execution?.observations || [])]
    .reverse()
    .find(
      (o) =>
        o.criterionId === criterion.id &&
        o.resultDigest === outcome.resultDigest,
    );
  return (
    <div className="wf-outcome-card">
      <p>
        {criterion.text} · {criterion.required ? "Required" : "Optional"} ·
        Owner observation:{" "}
        {observation
          ? observation.passed
            ? "passed"
            : "failed"
          : "not recorded"}
      </p>
      {observation && (
        <p>
          {observation.note} · {date(observation.at)}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onRecord(criterion.id, passed, note);
        }}
      >
        <label>
          {criterion.text} — observation
          <textarea
            required
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label>
          Observation result for {criterion.id}
          <select
            value={passed ? "passed" : "failed"}
            onChange={(e) => setPassed(e.target.value === "passed")}
          >
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button className="wf-pill" disabled={disabled || !note.trim()}>
          Record owner observation
        </button>
      </form>
    </div>
  );
}

// All mutations retain their exact request ID/body after lost responses.
// Text, diffs and logs render through escaped React text and the Files reader.
export default function WorkflowOutcome({
  peer,
  workflow,
  onChanged,
  creating = false,
  refresh,
  onCancel,
  onOpenChat,
  onScreen,
  onApps,
  onFiles,
}: {
  peer: Peer;
  workflow: Workflow;
  onChanged: (w: Workflow) => void;
  creating?: boolean;
  refresh?: number;
  onCancel?: () => void;
  onOpenChat?: (chat: { agent: string; id: string }) => void;
  onScreen?: () => void;
  onApps?: () => void;
  onFiles?: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null),
    [problem, setProblem] = useState(""),
    [busy, setBusy] = useState(""),
    [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false),
    [editing, setEditing] = useState(creating),
    [inspected, setInspected] = useState("");
  const [editVersion, setEditVersion] = useState(0);
  const [capabilities, setCapabilities] = useState<OutcomeCapabilities>({ executionAvailable: false, reason: "Checking outcome availability…" });
  const pending = useRef<Record<string, object>>({}),
    current = useRef<Outcome | null>(null),
    sequence = useRef(0),
    mounted = useRef(true),
    inFlight = useRef(false);
  const base = `/api/sessions/workflows/${encodeURIComponent(workflow.id)}`;
  const storageKey = `reach-outcome-request:${peer.url}:${workflow.id}`;
  const take = (o: Outcome | null) => {
    if (
      !mounted.current ||
      (o && current.current && o.version < current.current.version)
    )
      return;
    current.current = o;
    setOutcome(o);
    setLoaded(true);
    if (o) setInspected((previous) => previous || identity(o));
  };
  const remember = () => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
    } catch {
      /* same-tab memory retains the exact request */
    }
  };
  useEffect(() => {
    mounted.current = true;
    try {
      pending.current = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
    } catch {
      pending.current = {};
    }
    const load = async () => {
      if (inFlight.current) return;
      const mine = ++sequence.current;
      try {
        const r = await request<{ outcome: Outcome | null; capabilities?: OutcomeCapabilities }>(
          peer,
          `${base}/outcome`,
        );
        if (mine === sequence.current) {
          take(r.outcome);
          setCapabilities(r.capabilities || { executionAvailable: false, reason: "Outcome execution is unavailable on this computer." });
        }
      } catch (e) {
        if (mounted.current && mine === sequence.current)
          setProblem((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => {
      mounted.current = false;
      sequence.current++;
      clearInterval(timer);
    };
  }, [peer.url, peer.token, workflow.id, refresh]);
  const act = async (action: string, extra?: object) => {
    if (inFlight.current || (!outcome && action !== "save")) return;
    if (["save", "prepare", "run"].includes(action) && !capabilities.executionAvailable) return;
    inFlight.current = true;
    setBusy(action);
    setProblem("");
    sequence.current++;
    let body = pending.current[action];
    if (!body) {
      const common = {
        requestId: crypto.randomUUID(),
        expectedVersion: outcome?.version || 0,
      };
      body =
        action === "save"
          ? { ...common, ...extra }
          : action === "prepare"
            ? {
                ...common,
                contractRevision: outcome!.contractRevision,
                contractDigest: outcome!.contractDigest,
                planDigest: outcome!.planDigest,
              }
            : action === "run"
              ? {
                  ...common,
                  contractRevision: outcome!.contractRevision,
                  contractDigest: outcome!.contractDigest,
                  planDigest: outcome!.planDigest,
                  preparedDigest: outcome!.preparation?.preparedDigest,
                }
              : action === "cancel"
                ? common
                : {
                    ...common,
                    ...tuple(outcome!),
                    ...(action === "accept"
                      ? { acknowledgedLimitationIds: [] }
                      : action.startsWith("observations:")
                        ? extra
                        : { note }),
                  };
      pending.current[action] = body;
      remember();
    }
    try {
      const r = await post<{ outcome: Outcome; draft?: Workflow | null; draftRemoved?: boolean }>(
        peer,
        action === "save"
          ? `${base}/outcome`
          : `${base}/outcome/${action.split(":")[0]}`,
        body,
      );
      sequence.current++;
      delete pending.current[action];
      remember();
      take(r.outcome);
      if (action === "save") {
        setEditing(false);
        setInspected(identity(r.outcome));
      }
      if (r.draft) onChanged(r.draft);
      else onChanged(await request<Workflow>(peer, base));
      if (r.draftRemoved) setProblem("The recorded changes request was recovered, but its draft was deleted. No replacement draft was created.");
    } catch (e) {
      try {
        const operation = await request<{
          status: string;
          operation?: { draftId?: string };
          draftRemoved?: boolean;
        }>(
          peer,
          `${base}/outcome/operations/${(body as { requestId: string }).requestId}`,
        );
        if (operation.status === "known") {
          const r = await request<{ outcome: Outcome }>(
            peer,
            `${base}/outcome`,
          );
          take(r.outcome);
          const draftId = operation.operation?.draftId;
          onChanged(
            await request<Workflow>(
              peer,
              draftId && !operation.draftRemoved
                ? `/api/sessions/workflows/${encodeURIComponent(draftId)}`
                : base,
            ),
          );
          delete pending.current[action];
          remember();
          if (action === "save") setEditing(false);
          setProblem(
            operation.draftRemoved
              ? "The recorded changes request was recovered, but its draft was deleted. No replacement draft was created."
              : "The recorded request was recovered. Showing the current revision.",
          );
        } else if (
          [400, 403, 409, 429].includes((e as { status: number }).status)
        ) {
          delete pending.current[action];
          remember();
          take(
            (
              await request<{ outcome: Outcome | null }>(
                peer,
                `${base}/outcome`,
              )
            ).outcome,
          );
          setProblem(
            (e as Error).message +
              " Review the current revision before trying again.",
          );
        } else
          setProblem(
            (e as Error).message +
              " The request is unresolved. Retry retains the same request and revision.",
          );
      } catch {
        setProblem(
          (e as Error).message +
            " The exact request was retained for inspection.",
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy("");
    }
  };
  if (!loaded)
    return (
      <p className="wf-meta" role="status">
        {problem || "Loading outcome plan…"}
      </p>
    );
  if (!outcome && !creating)
    return (
      <p className="wf-outcome-warning" role="alert">
        Outcome data is unavailable. Refresh before continuing.
      </p>
    );
  const changed = !!outcome && inspected !== identity(outcome);
  const locked = Object.keys(pending.current).length > 0;
  const editingContract =
    editing &&
    (!outcome || (workflow.state === "draft" && !outcome.execution?.startedAt));
  const checksPassed =
    !!outcome?.contract?.checks.length &&
    outcome.contract.checks.every(
      (c) =>
        checkStatus(
          outcome.checks?.find((v) => (v.checkId || v.id) === c.id),
          outcome,
        ) === "passed",
    );
  const reviewState = outcome?.unresolved.some((u) => u.id === "review_unbound")
    ? "stale or unbound"
    : outcome?.review?.report?.status || outcome?.review?.status || "pending";
  return (
    <section
      className="wf-step wf-outcome"
      aria-label="Outcome plan and owner decisions"
      aria-busy={!!busy}
    >
      <h3>Outcome{outcome ? ` · ${words(outcome.phase)}` : " goal"}</h3>
      {!capabilities.executionAvailable && <p className="wf-outcome-warning" role="status">{capabilities.reason} Existing results remain available to inspect.</p>}
      {creating && !capabilities.executionAvailable && onCancel && <button className="wf-pill" onClick={onCancel}>Cancel editing outcome</button>}
      {editingContract && capabilities.executionAvailable && (
        <WorkflowOutcomeEditor
          key={workflow.id}
          initial={outcome?.contract}
          busy={!!busy}
          locked={locked}
          onSave={(contract) =>
            void act("save", { contract, expectedVersion: editVersion })
          }
          onCancel={() => {
            setEditing(false);
            onCancel?.();
          }}
        />
      )}
      {outcome && (
        <>
          {!editingContract && (
            <>
              {outcome.contract && (
                <div className="wf-outcome-card">
                  <h4>Goal</h4>
                  <p>{outcome.contract.goal}</p>
                </div>
              )}
              {workflow.state === "draft" &&
                !outcome.execution?.startedAt &&
                outcome.contract && (
                  <button
                    className="wf-pill"
                    disabled={!!busy || locked || !capabilities.executionAvailable}
                    onClick={() => {
                      setEditVersion(outcome.version);
                      setEditing(true);
                    }}
                  >
                    Edit goal and success criteria
                  </button>
                )}
            </>
          )}
          {outcome.plan && (
            <details
              className="wf-outcome-card"
              open={workflow.state === "draft"}
            >
              <summary>Execution plan and optional repair branch</summary>
              <p>
                Builder: {outcome.plan.builder.agent}. Independent checker:{" "}
                {outcome.plan.independentChecker
                  .map((c) => c.profileId)
                  .join(", ")}
                . Separate reviewer: {outcome.plan.reviewer.agent}.
              </p>
              <ol>
                {outcome.plan.branches.map((b) => (
                  <li key={b.id}>
                    {b.title} · {b.agent}
                    {b.model ? ` · ${b.model}` : ""}
                    {b.condition !== "initial"
                      ? " · only after a supported failed check"
                      : ""}
                  </li>
                ))}
              </ol>
              <p>
                Allowed changes:{" "}
                {outcome.plan.scope.allowedChangedPaths.join(", ")}. Review
                scope:{" "}
                {outcome.plan.reviewer.scope ||
                  "All criteria and allowed changes"}
                .
              </p>
              <p>
                Deadline:{" "}
                {outcome.execution?.deadlineAt
                  ? date(outcome.execution.deadlineAt)
                  : `${outcome.plan.limits.wallSeconds / 60} minutes from Run`}
                . Maximum: {outcome.plan.limits.maxBuildAttempts} builds,{" "}
                {outcome.plan.limits.maxTotalCheckRuns} checks,{" "}
                {outcome.plan.limits.maxTotalReviewAttempts} reviews.
              </p>
              {outcome.preparation?.prepared.profiles.map((p) => (
                <div key={p.id}>
                  <p>
                    {p.id}:{" "}
                    <code>
                      {JSON.stringify([
                        p.definition.executable,
                        ...p.definition.args,
                      ])}
                    </code>
                  </p>
                  <p>
                    Check folder: {p.definition.cwd || "Unavailable"} ·
                    environment names:{" "}
                    {p.definition.environment?.join(", ") || "none"} · output
                    limit: {p.definition.outputBytes ?? "unavailable"} bytes
                  </p>
                  <code>{p.definitionDigest}</code>
                </div>
              ))}
              {outcome.preparation && (
                <>
                  <p>
                    Build workspace:{" "}
                    {outcome.preparation.prepared.buildCwd || "Unavailable"}.
                    Review workspace:{" "}
                    {outcome.preparation.prepared.reviewCwd || "Unavailable"}.
                  </p>
                  <p>{outcome.preparation.prepared.isolation}</p>
                </>
              )}
            </details>
          )}
          {workflow.state === "draft" &&
            !outcome.execution?.startedAt &&
            outcome.phase === "draft" &&
            !editingContract && (
              <button
                className="wf-primary"
                disabled={!!busy || locked || !outcome.plan || !capabilities.executionAvailable}
                onClick={() =>
                  void act(outcome.preparation ? "run" : "prepare")
                }
              >
                {outcome.preparation
                  ? "Run approved outcome plan"
                  : "Prepare checks and workspaces"}
              </button>
            )}
          <section
            aria-label="Result and evidence"
            className="wf-outcome-result"
          >
            <h4>
              {outcome.resultRevision === null
                ? "Result not captured yet"
                : `Result revision ${outcome.resultRevision}`}
            </h4>
            <dl className="wf-outcome-facts">
              <div>
                <dt>Execution</dt>
                <dd>
                  {workflow.tasks.some((t) =>
                    ["starting", "working", "uncertain"].includes(t.state),
                  )
                    ? "Running or uncertain"
                    : workflow.tasks.length &&
                        workflow.tasks.every((t) =>
                          ["done", "skipped"].includes(t.state),
                        )
                      ? "Finished execution"
                      : "Execution incomplete"}{" "}
                  ·{" "}
                  {outcome.taskCompletion?.completed ??
                    workflow.tasks.filter((t) => t.state === "done")
                      .length}{" "}
                  tasks completed · {outcome.taskCompletion?.skipped ?? 0}{" "}
                  skipped · {outcome.taskCompletion?.uncertain ?? 0} uncertain
                </dd>
              </div>
              <div>
                <dt>Recorded checks</dt>
                <dd>
                  {checksPassed
                    ? "Checks passed"
                    : "Checks have not all passed"}
                </dd>
              </div>
              <div>
                <dt>Independent review</dt>
                <dd>{words(reviewState)} · reviewer judgment</dd>
              </div>
              <div>
                <dt>Owner acceptance</dt>
                <dd>
                  {outcome.acceptance.status === "accepted"
                    ? `Accepted revision ${outcome.acceptance.decision?.tuple.resultRevision ?? outcome.resultRevision}`
                    : words(outcome.acceptance.status)}
                </dd>
              </div>
            </dl>
            {changed && (
              <div className="wf-outcome-warning" role="status">
                <p>
                  The result or evidence changed. Review the current revision
                  before deciding.
                </p>
                <button
                  className="wf-pill"
                  disabled={!!busy || locked}
                  onClick={() => setInspected(identity(outcome))}
                >
                  Review current revision
                </button>
              </div>
            )}
            <details className="wf-outcome-card">
              <summary>Evidence freshness and revision identity</summary>
              <p>
                Contract revision {outcome.contractRevision} · evidence revision{" "}
                {outcome.evidenceRevision} · updated {date(outcome.updatedAt)}
              </p>
              <p>
                Result digest:{" "}
                <code>
                  {outcome.resultDigest || "No sealed candidate available"}
                </code>
              </p>
              <p>
                Contract digest: <code>{outcome.contractDigest}</code>
              </p>
              <p>
                Evidence digest: <code>{outcome.evidenceDigest}</code>
              </p>
              <p>
                {outcome.acceptance.status === "stale"
                  ? "Previous acceptance is stale for this bundle."
                  : "Evidence applies only to its recorded candidate and definition digests. Live files may differ."}
              </p>
              {outcome.acceptance.decision && (
                <p>
                  Previous owner decision: revision{" "}
                  {outcome.acceptance.decision.tuple.resultRevision} ·{" "}
                  {date(outcome.acceptance.decision.at)}
                </p>
              )}
            </details>
            <h4>Success criteria</h4>
            {!outcome.contract && <p>Criteria unavailable.</p>}
            {outcome.contract?.criteria.map((c) =>
              c.method === "owner_observation" ? (
                <Observation
                  key={`${c.id}:${outcome.resultDigest}`}
                  criterion={c}
                  outcome={outcome}
                  disabled={
                    !!busy ||
                    locked ||
                    changed ||
                    outcome.resultRevision === null ||
                    !["ready", "needs_owner"].includes(outcome.phase)
                  }
                  onRecord={(criterionId, passed, observation) =>
                    void act(`observations:${criterionId}`, {
                      criterionId,
                      passed,
                      note: observation,
                    })
                  }
                />
              ) : (
                <p className="wf-outcome-card" key={c.id}>
                  {c.text} · {c.required ? "Required" : "Optional"} ·{" "}
                  {checkStatus(
                    outcome.checks?.find(
                      (v) => (v.checkId || v.id) === c.checkId,
                    ),
                    outcome,
                  )}{" "}
                  · check {c.checkId}
                </p>
              ),
            )}
            <h4>Recorded independent checks</h4>
            {(outcome.checks || []).map((check, i) => (
              <details
                className="wf-outcome-card"
                key={check.checkId || check.id || i}
              >
                <summary>
                  {check.checkId || check.id} · {checkStatus(check, outcome)} ·
                  exit {check.exitCode ?? "unknown"}
                </summary>
                <p>
                  Source: {check.source || "unavailable"} · complete output:{" "}
                  {check.complete === true ? "recorded" : "unknown"}
                </p>
                <p>
                  Candidate: <code>{check.candidateDigest || "unbound"}</code>
                </p>
                <p>
                  Profile definition:{" "}
                  <code>{check.profileDigest || "unbound"}</code>
                </p>
                <p>
                  Log digest: <code>{check.logDigest || "unavailable"}</code>
                </p>
                <p>
                  Full independent log content is not available through the
                  current API. A digest alone is not a log preview.
                </p>
              </details>
            ))}
            {!outcome.checks?.length && (
              <p>No independent check receipts recorded.</p>
            )}
            {!!outcome.execution?.baseline?.length && (
              <details className="wf-outcome-card">
                <summary>Baseline checks · before builder changes</summary>
                {outcome.execution.baseline.map((c, i) => (
                  <p key={i}>
                    {c.checkId || c.id} · {c.status} · exit{" "}
                    {c.exitCode ?? "unknown"}
                  </p>
                ))}
              </details>
            )}
            <h4>Independent findings</h4>
            {outcome.review?.report ? (
              <>
                <p>
                  Separate review · {outcome.review.report.status}. This is an
                  assessment of the recorded input bundle.
                </p>
                {outcome.review.report.findings.map((f) => (
                  <p className="wf-outcome-card" key={f.id}>
                    {f.id} · {f.blocking ? "Blocking" : "Nonblocking"}: {f.text}
                  </p>
                ))}
                {!outcome.review.report.findings.length && (
                  <p>No findings in the recorded review.</p>
                )}
                <p>
                  Reviewed input: <code>{outcome.review.inputDigest}</code> ·
                  receipt: <code>{outcome.review.receiptDigest}</code>
                </p>
              </>
            ) : (
              <p>Independent review evidence is pending or unavailable.</p>
            )}
            {outcome.review?.chat && onOpenChat && (
              <button
                className="wf-pill"
                onClick={() => onOpenChat(outcome.review!.chat!)}
              >
                Open independent review chat
              </button>
            )}
            <h4>Task-attributed diffs and provider evidence</h4>
            {(outcome.results || []).map((r) => {
              const task = workflow.tasks.find(
                (t) => t.id === r.provenance.taskId,
              );
              return (
                <TaskEvidence
                  key={r.evidenceDigest}
                  peer={peer}
                  base={base}
                  receipt={r}
                  title={task?.title || r.provenance.taskId}
                  chat={task?.chat}
                  onOpenChat={onOpenChat}
                />
              );
            })}
            {!outcome.results?.length && (
              <p>No original-turn provider evidence retained.</p>
            )}
            <div
              className="wf-outcome-card"
              aria-label="Unknowns and missing evidence"
            >
              <h4>Unknowns and missing evidence</h4>
              {outcome.execution?.hold && <p>{outcome.execution.hold}</p>}
              {outcome.historyIncomplete && (
                <p>Original-turn history incomplete</p>
              )}
              {outcome.truncated && <p>Stored evidence clipped</p>}
              {outcome.unresolved.length ? (
                <ul>
                  {outcome.unresolved.map((u, i) => (
                    <li key={i}>
                      {words(u.id)}
                      {u.blocking === false
                        ? " · limitation"
                        : " · blocks acceptance"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No unresolved blockers reported by the server.</p>
              )}
              {!!outcome.results?.some((r) => r.unknowns.length) && (
                <p>
                  Provider receipt limitations:{" "}
                  {[...new Set(outcome.results.flatMap((r) => r.unknowns))]
                    .map(words)
                    .join(", ")}
                  . Inspect each attempt for provenance.
                </p>
              )}
              <p>
                Sealed artifact downloads and before/after previews are not
                exposed by the current API.
              </p>
            </div>
            {(onScreen || onApps || onFiles) && (
              <nav
                className="wf-outcome-actions"
                aria-label="Inspect live result"
              >
                {onScreen && (
                  <button className="wf-pill" onClick={onScreen}>
                    Inspect in Screen
                  </button>
                )}
                {onApps && (
                  <button className="wf-pill" onClick={onApps}>
                    Inspect in Apps
                  </button>
                )}
                {onFiles && (
                  <button className="wf-pill" onClick={onFiles}>
                    Browse Files and previews
                  </button>
                )}
                <p>
                  These views show the live computer and current files. They do
                  not prove the sealed result or refresh its checks.
                </p>
              </nav>
            )}
          </section>
          <p>
            Acceptance records your decision on this result revision. Merging,
            deployment and other external actions require separate
            authorization.
          </p>
          {outcome.resultRevision !== null && (
            <>
              <button
                className="wf-primary"
                aria-describedby="outcome-accept-reason"
                disabled={
                  !!busy ||
                  locked ||
                  changed ||
                  !outcome.acceptance.eligible ||
                  outcome.acceptance.status === "accepted"
                }
                onClick={() => void act("accept")}
              >
                Accept result revision {outcome.resultRevision}
              </button>
              <p id="outcome-accept-reason">
                {outcome.acceptance.status === "accepted"
                  ? "Owner acceptance recorded for the revision above."
                  : changed
                    ? "Review the changed evidence before accepting."
                    : !outcome.acceptance.eligible
                      ? "Acceptance unavailable. Inspect the criteria, findings and unresolved evidence above."
                      : "Ready for your review. Checks passing does not accept the result."}
              </p>
              <label>
                Requested changes
                <textarea
                  value={note}
                  maxLength={4000}
                  disabled={!!busy || locked}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <button
                className="wf-pill"
                disabled={
                  !!busy ||
                  locked ||
                  changed ||
                  !["ready", "accepted", "needs_owner"].includes(outcome.phase)
                }
                onClick={() => void act("request-changes")}
              >
                Request changes · create new draft
              </button>
            </>
          )}
          {!["accepted", "cancelled", "changes_requested"].includes(
            outcome.phase,
          ) && (
            <button
              className="wf-pill"
              disabled={!!busy || locked}
              onClick={() => void act("cancel")}
            >
              {outcome.phase === "uncertain" && outcome.execution?.pending ? "Retry stop" : "Cancel outcome"}
            </button>
          )}
        </>
      )}
      {Object.keys(pending.current).map((action) => (
        <button
          key={action}
          className="wf-pill"
          disabled={!!busy}
          onClick={() => void act(action)}
        >
          Retry retained {words(action.split(":")[0])} request
        </button>
      ))}
      {problem && (
        <p className="wf-outcome-warning" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
