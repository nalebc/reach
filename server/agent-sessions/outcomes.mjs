// Foundation for docs/OUTCOMES.md. Contracts and original-turn evidence are
// durable; execution, candidate sealing and independent verification follow
// in the coordinator. Until then an attachment cannot dispatch or be accepted.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, fail, isPlainRecord } from "../core.mjs";
import { canonical, evidenceHash, jsonBytes, restoreResult } from "./result-evidence.mjs";
import { outcomePlan, readiness, validateCoordination, tupleKeys, exactTuple } from "./outcome-policy.mjs";

export const OUTCOME_LIMITS = Object.freeze({ outcomes: 50, contracts: 100, results: 40, operations: 200, bytes: 4 * 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const REQUEST = /^[A-Za-z0-9_-]{8,80}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const validId = (value) => typeof value === "string" && ID.test(value);
const validRequest = (value) => typeof value === "string" && REQUEST.test(value);
const KINDS = ["source_snapshot", "diff", "check_log", "review_report", "before_png", "after_png"];
const clone = (v) => structuredClone(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
function shape(value, fields, label) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) throw fail(400, `Unsupported ${label} fields.`);
}
function text(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw fail(400, `Invalid ${label}.`);
  return value.trim();
}
function list(value, max, label) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw fail(400, `Invalid ${label}.`);
  return value;
}
const relative = (value) => typeof value === "string" && value.length > 0 && value.length <= 240 &&
  !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");

// Strict owner-authored contract only. Profile definitions must still be
// resolved and pinned by a supported runner before any executable approval.
export function outcomeContract(value) {
  shape(value, ["goal", "criteria", "allowedArtifacts", "checks", "review", "limits", "repair"], "outcome contract");
  const goal = text(value.goal, 2000, "goal");
  const criteria = list(value.criteria, 20, "criteria").map((c) => {
    shape(c, ["id", "text", "required", "method", "checkId"], "criterion");
    if (!validId(c.id) || typeof c.required !== "boolean" || !["check", "owner_observation"].includes(c.method) ||
        (c.method === "check" ? !validId(c.checkId) : c.checkId !== undefined)) throw fail(400, "Invalid criterion binding.");
    return { id: c.id, text: text(c.text, 2000, "criterion text"), required: c.required, method: c.method, ...(c.method === "check" ? { checkId: c.checkId } : {}) };
  });
  if (new Set(criteria.map((c) => c.id)).size !== criteria.length || !criteria.some((c) => c.required && c.method === "check")) throw fail(400, "Use unique criteria and at least one required automated criterion.");
  const artifacts = value.allowedArtifacts;
  shape(artifacts, ["allowedChangedPaths", "requiredKinds", "optionalKinds", "maxFiles", "maxBytes"], "allowed artifact");
  const paths = list(artifacts.allowedChangedPaths, 100, "changed paths");
  const required = list(artifacts.requiredKinds, KINDS.length, "required artifact kinds");
  const optional = artifacts.optionalKinds ?? [];
  if (paths.some((p) => !relative(p)) || new Set(paths).size !== paths.length || !Array.isArray(optional) ||
      [...required, ...optional].some((k) => !KINDS.includes(k)) || new Set([...required, ...optional]).size !== required.length + optional.length ||
      !required.some((k) => ["source_snapshot", "diff"].includes(k)) ||
      !integer(artifacts.maxFiles, 1, 1000) || !integer(artifacts.maxBytes, 1, 100 * 1024 * 1024)) throw fail(400, "Invalid artifact bounds or relative changed paths.");
  const checks = list(value.checks, 10, "checks").map((c) => {
    shape(c, ["id", "profileId", "definitionDigest", "timeoutSeconds"], "check");
    if (!validId(c.id) || !validId(c.profileId) || !DIGEST.test(c.definitionDigest) || !integer(c.timeoutSeconds, 1, 300)) throw fail(400, "Use pinned check profiles with finite timeouts.");
    return { id: c.id, profileId: c.profileId, definitionDigest: c.definitionDigest, timeoutSeconds: c.timeoutSeconds };
  });
  if (new Set(checks.map((c) => c.id)).size !== checks.length || criteria.some((c) => c.method === "check" && !checks.some((check) => check.id === c.checkId))) throw fail(400, "Each automated criterion needs a declared check.");
  const review = value.review;
  shape(review, ["required", "agent", "separateChat", "model", "effort", "scope"], "review");
  if (review.required !== true || review.separateChat !== true || !["codex", "claude"].includes(review.agent) ||
      (review.model !== undefined && (typeof review.model !== "string" || !/^[A-Za-z0-9][\w.:/[\]-]{0,79}$/.test(review.model))) ||
      (review.effort !== undefined && (typeof review.effort !== "string" || !/^[a-z][a-z0-9_-]{0,23}$/.test(review.effort)))) throw fail(400, "Use a separate local review chat.");
  const limits = value.limits;
  shape(limits, ["wallSeconds", "buildSeconds", "reviewSeconds", "maxBuildAttempts", "maxTotalCheckRuns", "maxTotalReviewAttempts"], "limit");
  const repair = value.repair;
  shape(repair, ["preapproved", "maxCycles"], "repair");
  if (typeof repair.preapproved !== "boolean" || repair.maxCycles !== (repair.preapproved ? 1 : 0) ||
      !integer(limits.wallSeconds, 60, 3600) || !integer(limits.buildSeconds, 1, 900) || !integer(limits.reviewSeconds, 1, 300) ||
      limits.maxBuildAttempts !== (repair.preapproved ? 2 : 1) ||
      !integer(limits.maxTotalCheckRuns, 1, checks.length * (1 + limits.maxBuildAttempts)) ||
      !integer(limits.maxTotalReviewAttempts, 1, limits.maxBuildAttempts) ||
      Math.max(limits.buildSeconds, limits.reviewSeconds, ...checks.map((c) => c.timeoutSeconds)) > limits.wallSeconds) throw fail(400, "Invalid time, attempt or repair limits.");
  return { goal, criteria, allowedArtifacts: { allowedChangedPaths: [...paths], requiredKinds: [...required],
    optionalKinds: [...optional], maxFiles: artifacts.maxFiles, maxBytes: artifacts.maxBytes }, checks,
    review: { required: true, agent: review.agent, separateChat: true,
      ...(review.model ? { model: review.model } : {}), ...(review.effort ? { effort: review.effort } : {}),
      ...(review.scope !== undefined ? { scope: text(review.scope, 4000, "review scope") } : {}) },
    limits: { ...limits }, repair: { ...repair } };
}

export function outcomeInput(body) {
  shape(body, ["requestId", "expectedVersion", "contract"], "outcome request");
  if (typeof body.requestId !== "string" || !REQUEST.test(body.requestId) || !integer(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER)) throw fail(400, "Use a requestId and nonnegative expectedVersion.");
  return { requestId: body.requestId, expectedVersion: body.expectedVersion, contract: outcomeContract(body.contract) };
}
export const workflowPlanDigest = (w) => evidenceHash({ cwd: w.cwd, tasks: w.tasks.map(({ id, title, task, agent, kind, together, model, effort }) =>
  ({ id, title, task, agent, kind, together: !!together, model: model || "", effort: effort || "" })) });
export const newOutcomeRef = () => ({ schemaVersion: 1, id: randomUUID(), capability: "outcomes-v1" });
const resultDigest = (results, coordination) => {
  const receipts = results.map((r) => ({ taskId: r.provenance.taskId, attempt: r.provenance.attempt, digest: r.evidenceDigest }));
  return evidenceHash(coordination ? { receipts, bundles: coordination.bundles, baseline: coordination.baseline, observations: coordination.observations } : receipts);
};
export const outcomeTuple = (r) => ({ contractRevision: r.contractRevision, contractDigest: r.contracts.at(-1).digest,
  resultRevision: r.coordination?.bundles.length || null, resultDigest: r.coordination?.bundles.at(-1)?.candidate.digest || null, evidenceRevision: r.evidenceRevision, evidenceDigest: r.evidenceDigest });
export function outcomeAcceptance(r, workflow = { tasks: [] }) {
  const latest = r.decisions.at(-1);
  if (!latest) return { status: "not_accepted", eligible: readiness(r, workflow).length === 0 };
  return { status: canonical(latest.tuple) === canonical(outcomeTuple(r)) ? latest.status : "stale", eligible: latest.status !== "accepted" && readiness(r, workflow).length === 0, decision: clone(latest) };
}
function removable(record, workflow) {
  const x = record?.coordination;
  if (x?.pending || workflow.tasks.some(t => ['starting', 'working', 'uncertain'].includes(t.state))) return false;
  if (workflow.state === 'draft') return !record || !record.results.length && !record.decisions.length && (!x || x.phase === 'prepared' && x.startedAt === null);
  if (!x) return record?.phase === 'cancelled' && !record.results.length && !record.decisions.length;
  const settled = ['ready', 'accepted', 'needs_owner', 'cancelled', 'changes_requested'];
  return !!x && settled.includes(record.phase) && settled.includes(x.phase);
}

export function createOutcomes({ directory = null, now = Date.now, write = atomicJson } = {}) {
  const memory = new Map(), cache = new Map(), removed = new Map();
  const refOK = (ref) => isPlainRecord(ref) && Object.keys(ref).every((key) => ["schemaVersion", "id", "capability"].includes(key)) &&
    ref.schemaVersion === 1 && typeof ref.id === "string" && UUID.test(ref.id) && ref.capability === "outcomes-v1";
  const filename = (ref) => path.join(directory, `${ref.id}.json`);
  const removalFile = (workflowId) => path.join(directory, 'deleted', `${evidenceHash(workflowId).slice(7)}.json`);
  const unavailable = () => fail(503, "Outcome data is missing, unreadable or unsupported. This workflow is blocked; its history was retained.");
  function removal(workflowId, ref = null) {
    try {
      let marker = removed.get(workflowId);
      if (directory) {
        let stat;
        try { stat = fs.lstatSync(removalFile(workflowId)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
        marker = JSON.parse(fs.readFileSync(removalFile(workflowId), 'utf8'));
      }
      if (!marker) return null;
      if (marker.schemaVersion !== 1 || marker.workflowId !== workflowId || !UUID.test(marker.id) ||
          ref && marker.id !== ref.id || !['archive', 'delete'].includes(marker.disposition) ||
          !integer(marker.version, 0, Number.MAX_SAFE_INTEGER) || !Number.isFinite(marker.deletedAt) ||
          !Array.isArray(marker.operations) || marker.operations.length > OUTCOME_LIMITS.operations ||
          marker.operations.some(op => !validRequest(op.requestId) || !DIGEST.test(op.bodyHash))) throw Error();
      return marker;
    } catch { throw unavailable(); }
  }
  function markRemoved(ref, workflow, record, disposition) {
    const marker = { schemaVersion: 1, id: ref.id, workflowId: workflow.id, version: record?.version || 0, deletedAt: now(), disposition,
      operations: (record?.operations || []).map(({ requestId, bodyHash }) => ({ requestId, bodyHash })) };
    try { if (directory) write(removalFile(workflow.id), marker); }
    catch { throw fail(507, 'The outcome deletion could not be saved. Its history was retained.'); }
    removed.set(workflow.id, marker);
    return marker;
  }
  function finishRemoval(ref, marker) {
    try {
      if (directory && fs.existsSync(filename(ref))) {
        if (marker.disposition === 'archive') {
          const archive = path.join(directory, 'archived');
          fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
          fs.renameSync(filename(ref), path.join(archive, `${ref.id}.json`));
        } else fs.unlinkSync(filename(ref));
      }
      memory.delete(ref.id); cache.delete(ref.id);
    } catch { throw fail(507, 'The outcome deletion is recorded, but its stored history could not be removed. Retry Remove.'); }
  }
  function validate(r, ref, workflowId) {
    shape(r, ["schemaVersion", "id", "workflowId", "version", "createdAt", "updatedAt", "contractRevision", "contracts", "planDigest", "phase", "results", "evidenceRevision", "evidenceDigest", "decisions", "operations", "coordination", "coordinationDigest"], "stored outcome");
    if (r.schemaVersion !== 1 || r.id !== ref.id || r.workflowId !== workflowId || !integer(r.version, 1, Number.MAX_SAFE_INTEGER) ||
        !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt) || !["draft","needs_owner","cancelled","running","ready","accepted","uncertain","cancelling","changes_requested"].includes(r.phase) || !DIGEST.test(r.planDigest) ||
        !Array.isArray(r.contracts) || !r.contracts.length || r.contracts.length > OUTCOME_LIMITS.contracts || r.contractRevision !== r.contracts.length ||
        !Array.isArray(r.results) || r.results.length > OUTCOME_LIMITS.results || !Array.isArray(r.decisions) || r.decisions.length > OUTCOME_LIMITS.operations ||
        !integer(r.evidenceRevision, 0, Number.MAX_SAFE_INTEGER) || r.evidenceRevision < r.results.length ||
        !Array.isArray(r.operations) || !r.operations.length || r.operations.length > OUTCOME_LIMITS.operations) throw Error();
    for (const [i, c] of r.contracts.entries()) {
      shape(c, ["revision", "digest", "contract", "createdAt"], "stored contract");
      if (c.revision !== i + 1 || !Number.isFinite(c.createdAt) || canonical(c.contract) !== canonical(outcomeContract(c.contract)) || c.digest !== evidenceHash(c.contract)) throw Error();
    }
    const attempts = new Set();
    for (const item of r.results) {
      restoreResult(item);
      const binding = item.provenance, key = `${binding.taskId}:${binding.attempt}`;
      if (!item.evidenceFrozen || binding.workflowId !== workflowId || !binding.taskId || !binding.attempt || attempts.has(key) ||
          binding.contractRevision !== null && !r.contracts[binding.contractRevision - 1]) throw Error();
      attempts.add(key);
    }
    if (r.coordination) {
      validateCoordination(r.coordination, r.contracts.at(-1).contract);
      if (r.coordinationDigest !== evidenceHash(r.coordination)) throw Error();
    } else if (r.coordinationDigest !== undefined) throw Error();
    if (r.evidenceDigest !== resultDigest(r.results, r.coordination)) throw Error();
    for (const d of r.decisions) if (!['accepted', 'changes_requested', 'rejected'].includes(d.status) || !d.actor || !d.requestId || !d.tuple || !Number.isFinite(d.at)) throw Error();
    const requests = new Set();
    for (const op of r.operations) {
      shape(op, ["requestId", "bodyHash", "kind", "version", "contractRevision", "contractDigest", "at", "actor", "tuple", "draftId"], "stored operation");
      if (!validRequest(op.requestId) || requests.has(op.requestId) || !DIGEST.test(op.bodyHash) || !["contract","cancel","prepare","run","accept","request_changes","reject","observation"].includes(op.kind) ||
          !integer(op.version, 1, r.version) || !integer(op.contractRevision, 1, r.contractRevision) || op.contractDigest !== r.contracts[op.contractRevision - 1].digest || !Number.isFinite(op.at)) throw Error();
      requests.add(op.requestId);
    }
    return r;
  }
  function read(ref, workflowId, { absent = false, copy = true } = {}) {
    if (!refOK(ref)) throw unavailable();
    if (removal(workflowId, ref)) throw fail(410, 'This outcome was explicitly removed. It cannot be restarted.');
    try {
      let r;
      if (!directory) r = memory.get(ref.id);
      else {
        const stat = fs.lstatSync(filename(ref), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(OUTCOME_LIMITS.bytes)) throw Error();
        const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, hit = cache.get(ref.id);
        if (hit?.stamp === stamp && hit.workflowId === workflowId) return copy ? clone(hit.record) : hit.record;
        r = JSON.parse(fs.readFileSync(filename(ref), "utf8"));
        validate(r, ref, workflowId);
        cache.set(ref.id, { stamp, workflowId, record: clone(r) });
      }
      if (r === undefined && absent) return null;
      const record = validate(r, ref, workflowId);
      return copy ? clone(record) : record;
    } catch (error) {
      if (absent && error.code === "ENOENT") return null;
      throw unavailable();
    }
  }
  function save(ref, record) {
    const emergency = ['cancelled', 'cancelling', 'uncertain', 'needs_owner'].includes(record.phase);
    if (jsonBytes(record) > OUTCOME_LIMITS.bytes - (emergency ? 0 : 8192)) throw fail(429, "Outcome storage is full. Its history has been retained.");
    try {
      if (directory) {
        if (!fs.existsSync(filename(ref)) && fs.existsSync(directory) && fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length >= OUTCOME_LIMITS.outcomes) throw fail(429, "Outcome history is full.");
        write(filename(ref), record);
      } else if (!memory.has(ref.id) && memory.size >= OUTCOME_LIMITS.outcomes) throw fail(429, "Outcome history is full.");
      memory.set(ref.id, clone(record));
      cache.delete(ref.id);
    } catch (error) {
      if (error.status === 429) throw error;
      throw fail(507, "The outcome could not be saved. Retry with the same requestId after checking storage.");
    }
  }
  function view(r, workflow) {
    const tuple = outcomeTuple(r), contract = r.contracts.at(-1).contract;
    return { schemaVersion: 1, id: r.id, version: r.version, phase: r.phase, ...tuple, contract: clone(contract),
      contracts: r.contracts.map(({ revision, digest, createdAt }) => ({ revision, digest, createdAt })), planDigest: r.planDigest,
      decisions: clone(r.decisions),
      taskCompletion: { completed: workflow.tasks.filter((t) => t.state === "done").length,
        skipped: workflow.tasks.filter((t) => t.state === "skipped").length, uncertain: workflow.tasks.filter((t) => t.state === "uncertain").length },
      plan: r.coordination?.plan || (() => { try { return outcomePlan(workflow, contract); } catch { return null; } })(),
      preparation: r.coordination ? { prepared: clone(r.coordination.prepared), preparedDigest: r.coordination.preparedDigest } : null,
      execution: r.coordination ? clone(r.coordination) : null,
      checks: contract.checks.map((c) => r.coordination?.bundles.at(-1)?.checks.find(v => v.checkId === c.id) || { id: c.id, status: "unknown" }),
      review: r.coordination?.bundles.at(-1)?.review || { status: "pending" },
      results: r.results.map((item) => ({ source: 'provider_reported', evidenceVersion: item.evidenceVersion, evidenceDigest: item.evidenceDigest, provenance: clone(item.provenance),
        truncated: item.truncated, historyIncomplete: item.historyIncomplete, unknowns: [...item.unknowns] })),
      historyIncomplete: r.results.some((item) => item.historyIncomplete), truncated: r.results.some((item) => item.truncated),
      unresolved: readiness(r, workflow),
      acceptance: outcomeAcceptance(r, workflow), capabilities: { run: r.coordination?.phase === "prepared", accept: readiness(r, workflow).length === 0, remove: removable(r, workflow),
        candidateCapture: !!r.coordination, independentChecks: !!r.coordination },
      createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  return {
    raw(ref, workflow) { return read(ref, workflow.id); },
    pendingTask(ref, workflow) { return read(ref, workflow.id, { copy: false }).coordination?.pending?.taskId || null; },
    isRemoved(workflowId) { return !!removal(workflowId); },
    // Internal serialized transitions only; no HTTP receipt submission API.
    change(ref, workflow, mutate) {
      const r = read(ref, workflow.id), previous = r.evidenceDigest;
      mutate(r);
      if (r.coordination) { validateCoordination(r.coordination, r.contracts.at(-1).contract); r.coordinationDigest = evidenceHash(r.coordination); }
      r.evidenceDigest = resultDigest(r.results, r.coordination);
      if (r.evidenceDigest !== previous) r.evidenceRevision++;
      r.version++; r.updatedAt = now();
      save(ref, r);
      return view(r, workflow);
    },
    command(ref, workflow, kind, body, actor, mutate) {
      if (!body || !validRequest(body.requestId) || !integer(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER) || typeof actor !== 'string' || !actor) throw fail(400, 'Use a requestId and expectedVersion.');
      const r = read(ref, workflow.id), bodyHash = evidenceHash({ kind, body });
      const prior = r.operations.find(op => op.requestId === body.requestId);
      if (prior) {
        if (prior.bodyHash !== bodyHash) throw fail(409, 'This requestId belongs to a different outcome operation.');
        return { outcome: view(r, workflow), operation: clone(prior) };
      }
      if (r.version !== body.expectedVersion) throw fail(409, 'The outcome changed. Refresh before deciding.');
      if (r.operations.length >= OUTCOME_LIMITS.operations - (kind === 'cancel' ? 0 : 1)) throw fail(429, 'Outcome operation history is full.');
      const extra = mutate(r) || {};
      const previous = r.evidenceDigest;
      if (r.coordination) { validateCoordination(r.coordination, r.contracts.at(-1).contract); r.coordinationDigest = evidenceHash(r.coordination); }
      r.evidenceDigest = resultDigest(r.results, r.coordination);
      if (r.evidenceDigest !== previous) r.evidenceRevision++;
      r.version++; r.updatedAt = now();
      const op = { requestId: body.requestId, bodyHash, kind, version: r.version, contractRevision: r.contractRevision,
        contractDigest: r.contracts.at(-1).digest, at: now(), actor, ...extra };
      r.operations.push(op); save(ref, r);
      return { outcome: view(r, workflow), operation: clone(op) };
    },
    archiveDraft(ref, workflow, { pending = false } = {}) {
      const previous = removal(workflow.id, ref);
      if (previous) { finishRemoval(ref, previous); return; }
      const r = read(ref, workflow.id, { absent: pending });
      if (workflow.state !== 'draft' || !removable(r, workflow)) throw fail(409, 'Active or decided outcome history must be retained.');
      finishRemoval(ref, markRemoved(ref, workflow, r, 'archive'));
    },
    remove(ref, workflow, { pending = false } = {}) {
      const previous = removal(workflow.id, ref);
      if (previous) { finishRemoval(ref, previous); return; }
      if (workflow.state === 'draft') return this.archiveDraft(ref, workflow, { pending });
      const r = read(ref, workflow.id);
      if (!removable(r, workflow))
        throw fail(409, 'Stop and reconcile active or uncertain work before removing its outcome history.');
      // Write the tombstone first. A crash between stores must not permit a
      // repeated Run or Request changes to recreate the deleted workflow.
      finishRemoval(ref, markRemoved(ref, workflow, r, 'delete'));
    },
    get(ref, workflow) { return view(read(ref, workflow.id), workflow); },
    summary(ref, workflow) {
      try {
        const r = read(ref, workflow.id, { copy: false }), x = r.coordination;
        return { ...ref, version: r.version, phase: r.phase, contractRevision: r.contractRevision, removable: removable(r, workflow),
          waitingForVerification: !!x && ['baseline', 'capture', 'checks'].includes(x.phase) && !!x.hold && !x.pending,
          acceptance: outcomeAcceptance(r, workflow) };
      }
      catch {
        let deleted = false;
        try { deleted = refOK(ref) && !!removal(workflow.id, ref); } catch { /* unsupported markers remain blocked */ }
        return { id: typeof ref?.id === "string" && UUID.test(ref.id) ? ref.id : null,
          schemaVersion: Number.isSafeInteger(ref?.schemaVersion) ? ref.schemaVersion : null, phase: "unavailable", removable: deleted,
          acceptance: { status: "not_accepted", eligible: false } };
      }
    },
    put(ref, workflow, input, { create = false, actor = workflow.owner || "owner" } = {}) {
      // Synchronous compare/write transitions serialize competing phones in
      // this process. Nothing dispatches between the CAS and atomic write.
      const body = outcomeInput(input), bodyHash = evidenceHash(body);
      // Only a just-created in-process attachment may create an absent
      // ledger. Losing an existing file must never reset versions/history.
      let r = read(ref, workflow.id, { absent: create });
      const prior = r?.operations.find((op) => op.requestId === body.requestId);
      if (prior) {
        if (prior.bodyHash !== bodyHash) throw fail(409, "This requestId belongs to a different outcome operation.");
        return { outcome: view(r, workflow), operation: clone(prior) };
      }
      if (body.expectedVersion !== (r?.version || 0)) throw fail(409, "The outcome changed. Refresh before saving.");
      if (!r && workflow.state !== "draft") throw fail(409, "Attach outcomes only to a draft workflow.");
      if (r && workflow.state !== "draft") throw fail(409, "Request changes to create a reviewable new draft.");
      if (r?.coordination?.startedAt) throw fail(409, 'Request changes to create a reviewable new draft; running contracts are immutable.');
      if (r?.coordination) { delete r.coordination; delete r.coordinationDigest; r.evidenceRevision++; r.evidenceDigest = resultDigest(r.results); }
      if (r && (r.contracts.length >= OUTCOME_LIMITS.contracts || r.operations.length >= OUTCOME_LIMITS.operations)) throw fail(429, "Outcome revision history is full.");
      const at = now(), revision = (r?.contractRevision || 0) + 1;
      const c = { revision, digest: evidenceHash(body.contract), contract: body.contract, createdAt: at };
      r = r || { schemaVersion: 1, id: ref.id, workflowId: workflow.id, version: 0, createdAt: at, phase: "draft", contracts: [], results: [], evidenceRevision: 0,
        evidenceDigest: resultDigest([]), decisions: [], operations: [] };
      r.contracts.push(c);
      Object.assign(r, { version: r.version + 1, contractRevision: revision, updatedAt: at, planDigest: workflowPlanDigest(workflow) });
      const op = { requestId: body.requestId, bodyHash, kind: "contract", version: r.version, contractRevision: revision, contractDigest: c.digest, at, actor };
      r.operations.push(op);
      save(ref, r);
      return { outcome: view(r, workflow), operation: clone(op) };
    },
    appendResult(ref, workflow, result) {
      const r = read(ref, workflow.id), item = restoreResult(result), b = item.provenance;
      if (!item.evidenceFrozen || b.workflowId !== workflow.id || !workflow.tasks.some((t) => t.id === b.taskId) || !b.attempt ||
          b.contractRevision !== null && !r.contracts[b.contractRevision - 1]) throw fail(409, "This evidence is not bound to an outcome task attempt.");
      const existing = r.results.find((old) => old.provenance.taskId === b.taskId && old.provenance.attempt === b.attempt);
      if (existing) {
        if (canonical(existing) !== canonical(item)) throw fail(409, "Completed attempt evidence is immutable.");
        return view(r, workflow);
      }
      if (r.results.length >= OUTCOME_LIMITS.results) throw fail(429, "Outcome evidence history is full.");
      r.results.push(item);
      r.evidenceRevision++;
      r.evidenceDigest = resultDigest(r.results, r.coordination);
      r.version++;
      r.updatedAt = now();
      save(ref, r);
      return view(r, workflow);
    },
    operation(ref, workflow, requestId) {
      if (!validRequest(requestId)) throw fail(400, "Invalid outcome requestId.");
      const r = read(ref, workflow.id), op = r.operations.find((item) => item.requestId === requestId);
      return op ? { status: "known", operation: clone(op), currentVersion: r.version } : { status: "unknown", requestId };
    },
    assertDispatch(ref, workflow) {
      read(ref, workflow.id);
      throw fail(503, "Outcome execution is unavailable until candidate capture and independent verification are configured. No task was started.");
    },
    accept(ref, workflow, body, actor = workflow.owner || "owner") {
      shape(body, ['requestId', 'expectedVersion', ...tupleKeys, 'acknowledgedLimitationIds'], 'acceptance');
      return this.command(ref, workflow, 'accept', body, actor, r => {
        if (!exactTuple(body, outcomeTuple(r))) throw fail(409, 'This result revision changed. Refresh before acceptance.');
        if (!Array.isArray(body.acknowledgedLimitationIds) || body.acknowledgedLimitationIds.length) throw fail(400, 'Unsupported limitation acknowledgements.');
        if (readiness(r, workflow).length) throw fail(409, 'This outcome is not eligible for acceptance. Inspect the unresolved evidence.');
        const tuple = outcomeTuple(r);
        r.decisions.push({ status: 'accepted', tuple, actor, at: now(), requestId: body.requestId });
        r.phase = 'accepted'; r.coordination.phase = 'accepted';
        return { tuple };
      });
    },
  };
}
