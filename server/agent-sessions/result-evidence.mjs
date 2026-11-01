// Bounded provider records from one proven original turn. These are neither
// independent checks nor a manifest of the current working directory.
import { createHash } from "node:crypto";

export const RESULT_BYTES = 48 * 1024;
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  return Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
}
export const evidenceHash = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
export const requestHash = (text) => evidenceHash(String(text));

// The JSON encoding, including escaped control characters, must fit too.
export function clipResultText(value, room) {
  const text = typeof value === "string" ? value : "";
  if (jsonBytes(text) <= room) return { text, truncated: false };
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(text.slice(0, mid)) <= room - 16) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo) + "\n…", truncated: true };
}

const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 160 ? value : null;
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const statusOf = (item) => ["completed", "failed", "inProgress", "running", "declined"].includes(item.status) ? item.status : "unknown";
const clippedByProvider = (item) => item.truncated === true || item.outputTruncated === true || item.diffTruncated === true ||
  /\n… \(\d+ characters omitted\) …\n/.test(String(item.detail || ""));
const BINDINGS = ["provider", "chatId", "turnId", "workflowId", "taskId", "attempt", "contractRevision", "resultRevision", "artifactRevision"];
function provenance(binding) {
  return Object.fromEntries(BINDINGS.map((key) => [key,
    ["attempt", "contractRevision", "resultRevision", "artifactRevision"].includes(key) ? positive(binding[key]) : id(binding[key])]));
}

// Callers supply only bindings established by Reach, never ones parsed from
// assistant prose. Provider records do not establish criterion/candidate IDs.
export function recordedTurnResult(items = [], { historyIncomplete = false, binding = {}, gaps = [] } = {}) {
  const result = {
    schemaVersion: 1, summary: "", summarySource: "agent_claim", commands: [], changes: [], progress: [],
    progressSource: "agent_claim", judgments: [], provenance: provenance(binding),
    criterionIds: [], truncated: false, historyIncomplete: historyIncomplete === true, unknowns: [],
  };
  const unknowns = new Set(gaps.filter((gap) => GAP_KINDS.has(gap)));
  const text = (value, room) => {
    const piece = clipResultText(value, room);
    result.truncated ||= piece.truncated;
    return piece.text;
  };
  const said = items.filter((i) => i?.role === "assistant" && i.kind === "text" && !i.questions?.length);
  const finalMessage = said.at(-1), summary = clipResultText(finalMessage?.text || "", 9000);
  result.summary = summary.text;
  if (summary.truncated || finalMessage && clippedByProvider(finalMessage)) {
    result.truncated = true;
    unknowns.add("summary_clipped");
  }
  const commands = items.filter((i) => i?.role === "tool" && i.kind === "command");
  const changes = items.filter((i) => i?.role === "tool" && i.kind === "file-change");
  const progress = items.filter((i) => i?.role === "assistant" && i.kind === "text");
  result.commands = commands.slice(0, 20).map((i) => {
    const command = text(i.text, 1000), output = text(i.detail, 3000);
    const truncated = clippedByProvider(i) || command !== (i.text || "") || output !== (i.detail || "");
    const exitCode = Number.isSafeInteger(i.exitCode) ? i.exitCode : null;
    const signal = id(i.signal);
    if (exitCode === null && signal === null) unknowns.add("exit_unavailable");
    if (!i.id) unknowns.add("provider_item_id_unavailable");
    if (truncated) result.truncated = true;
    if (i.outputTruncated !== false && !truncated) unknowns.add("output_completeness_unknown");
    return { source: "provider_command", itemId: id(i.id), turnId: id(i.turnId) || result.provenance.turnId,
      command, status: statusOf(i), exitCode, signal, output, truncated,
      outputCompleteness: truncated ? "clipped" : i.outputTruncated === false ? "complete" : "unknown" };
  });
  result.changes = changes.slice(-20).map((i) => {
    const files = text(i.text, 1600), diff = text(i.detail, 4000);
    const truncated = clippedByProvider(i) || files !== (i.text || "") || diff !== (i.detail || "");
    if (truncated) result.truncated = true;
    if (!i.id) unknowns.add("provider_item_id_unavailable");
    // A tool's recorded diff cannot attest final bytes or exclude other writers.
    unknowns.add("concurrent_edits_unknown");
    return { source: "provider_change", itemId: id(i.id), turnId: id(i.turnId) || result.provenance.turnId,
      files, status: statusOf(i), diff, truncated, artifactRevision: null };
  });
  result.progress = progress.slice(-8).map((i) => text(i.text, 700));
  result.truncated ||= commands.length > 20 || changes.length > 20 || progress.length > 8;
  if (historyIncomplete) unknowns.add("history_incomplete");
  if (!items.length) unknowns.add("no_recorded_items");
  if (!result.provenance.turnId) unknowns.add("provider_turn_id_unavailable");
  if (!["codex", "claude"].includes(binding.provider)) unknowns.add("unsupported_provider");
  unknowns.add("criterion_binding_unavailable");
  unknowns.add("artifact_binding_unavailable");
  const finish = () => { result.unknowns = [...unknowns].sort(); };
  finish();
  // Leave space for the version/digest envelope added when persisted.
  while (jsonBytes(result) > RESULT_BYTES - 512) {
    result.truncated = true;
    if (result.progress.length) result.progress.shift();
    else if (result.commands.length > 1) result.commands.pop();
    else if (result.changes.length) result.changes.shift();
    else if (result.commands.length) result.commands.shift();
    else break;
  }
  if (result.truncated) unknowns.add("stored_content_clipped");
  finish();
  return result;
}

const GAP_KINDS = new Set([
  "history_incomplete", "no_recorded_items", "original_turn_unavailable", "collection_failed", "pagination_limit",
  "history_changed", "provider_history_incomplete", "provider_turn_id_unavailable", "provider_item_id_unavailable",
  "exit_unavailable", "output_completeness_unknown", "stored_content_clipped", "summary_clipped", "unsupported_provider",
  "concurrent_edits_unknown", "criterion_binding_unavailable", "artifact_binding_unavailable", "legacy_result", "execution_disposition_unknown",
]);
const STAMP = ["evidenceVersion", "evidenceDigest", "evidenceFrozen", "collectedAt"];
const unstamped = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !STAMP.includes(key)));
export const resultContentHash = (result) => evidenceHash(unstamped(result));
export function stampResult(result, { version = 1, frozen = true, at = Date.now() } = {}) {
  const body = unstamped(result);
  const envelope = { ...body, evidenceVersion: version, evidenceFrozen: frozen, collectedAt: at };
  return { ...envelope, evidenceDigest: evidenceHash(envelope) };
}
export function resultWithGaps(result, gaps = []) {
  const body = unstamped(result);
  return { ...body, historyIncomplete: true, unknowns: [...new Set([...body.unknowns, ...gaps.filter((gap) => GAP_KINDS.has(gap)), "history_incomplete"])].sort() };
}

// Allowlisted reconstruction protects both old stored results and the new
// envelope. Old receipts have no trustworthy provider IDs or exit status.
export function restoreResult(stored, { binding = {}, frozen = true } = {}) {
  if (!stored || typeof stored.summary !== "string" || ![stored.commands, stored.changes, stored.progress].every(Array.isArray) || jsonBytes(stored) > RESULT_BYTES)
    throw Error("Invalid result evidence.");
  if (stored.schemaVersion !== undefined && stored.schemaVersion !== 1) throw Error("Unsupported result evidence.");
  if (stored.schemaVersion === 1) {
    if (typeof stored.evidenceFrozen !== "boolean" || !positive(stored.evidenceVersion) || !Number.isFinite(stored.collectedAt) ||
        stored.evidenceDigest !== evidenceHash(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "evidenceDigest")))) throw Error("Invalid result digest.");
    // All text and bindings are revalidated; unrecognized object keys never
    // enter an owner/agent response, even with a recomputed local digest.
    const rebuilt = recordedTurnResult([], { binding: stored.provenance || {} });
    const fields = Object.keys(rebuilt);
    if (Object.keys(stored).some((key) => ![...fields, ...STAMP].includes(key)) ||
        canonical(stored.provenance) !== canonical(provenance(stored.provenance || {})) ||
        jsonBytes(stored.summary) > 9000 || stored.summarySource !== "agent_claim" || stored.progressSource !== "agent_claim" ||
        !Array.isArray(stored.judgments) || stored.judgments.length || !Array.isArray(stored.criterionIds) || stored.criterionIds.length ||
        typeof stored.truncated !== "boolean" || typeof stored.historyIncomplete !== "boolean" ||
        !Array.isArray(stored.unknowns) || stored.unknowns.some((gap) => !GAP_KINDS.has(gap)) ||
        stored.commands.length > 20 || stored.changes.length > 20 || stored.progress.length > 8 ||
        stored.progress.some((line) => typeof line !== "string" || jsonBytes(line) > 700)) throw Error("Invalid result fields.");
    for (const [list, source, keys] of [
      [stored.commands, "provider_command", ["source", "itemId", "turnId", "command", "status", "exitCode", "signal", "output", "truncated", "outputCompleteness"]],
      [stored.changes, "provider_change", ["source", "itemId", "turnId", "files", "status", "diff", "truncated", "artifactRevision"]],
    ]) for (const item of list) {
      if (!item || Object.keys(item).some((key) => !keys.includes(key)) || item.source !== source ||
          item.itemId !== id(item.itemId) || item.turnId !== id(item.turnId) || statusOf(item) !== item.status || typeof item.truncated !== "boolean") throw Error("Invalid provider record.");
      if (source === "provider_command" ?
        typeof item.command !== "string" || jsonBytes(item.command) > 1000 || typeof item.output !== "string" || jsonBytes(item.output) > 3000 ||
          (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) || item.signal !== id(item.signal) || !["complete", "clipped", "unknown"].includes(item.outputCompleteness) :
        typeof item.files !== "string" || jsonBytes(item.files) > 1600 || typeof item.diff !== "string" || jsonBytes(item.diff) > 4000 || item.artifactRevision !== null) throw Error("Invalid provider content.");
    }
    return structuredClone(stored);
  }
  const result = recordedTurnResult([
    ...stored.progress.map((text) => ({ role: "assistant", kind: "text", text })),
    { role: "assistant", kind: "text", text: stored.summary },
    ...stored.commands.map((i) => ({ role: "tool", kind: "command", text: i?.command, status: i?.status, detail: i?.output })),
    ...stored.changes.map((i) => ({ role: "tool", kind: "file-change", text: i?.files, status: i?.status, detail: i?.diff })),
  ], { binding, historyIncomplete: true, gaps: ["legacy_result"] });
  result.truncated ||= stored.truncated === true;
  return stampResult(result, { frozen, at: 0 });
}

// Fresh task threads only: establish the first user by reaching the oldest
// page. A later user quoting the opening marker is never a replacement.
export async function readOriginalTurn({ read, agent, chatId, requestDigest, requestPrefix, turnId = null, replyId = null,
  authorize = () => {}, maxPages = 32, maxOutput = 4096 }) {
  let before = null, page, items = [], oldest = false;
  const seen = new Set(), seenItems = new Set(), gaps = new Set();
  if (agent === 'codex' && !turnId) gaps.add('provider_turn_id_unavailable');
  try {
    for (let n = 0; n < maxPages; n++) {
      authorize();
      page = await read(agent, chatId, { limit: 200, maxOutput, ...(before === null ? {} : { before, cursor: before }) });
      authorize();
      if (!Array.isArray(page?.items)) throw Error();
      if (!Object.hasOwn(page, 'before') || page.before !== null && (typeof page.before !== 'string' || !page.before)) {
        gaps.add('provider_history_incomplete');
        break;
      }
      if (page.historyIncomplete || page.truncated) gaps.add("provider_history_incomplete");
      for (const item of page.items) if (id(item?.id)) {
        if (seenItems.has(item.id)) gaps.add("history_changed");
        seenItems.add(item.id);
      }
      items = [...page.items, ...items];
      if (items.length > 6400) { gaps.add("pagination_limit"); break; }
      if (!page.before) { oldest = true; break; }
      if (typeof page.before !== "string") { gaps.add("history_changed"); break; }
      if (seen.has(page.before)) { gaps.add("history_changed"); break; }
      seen.add(page.before);
      before = page.before;
    }
  } catch { gaps.add("collection_failed"); }
  if (!oldest) gaps.add("pagination_limit");
  const anchor = items.findIndex((i) => i?.role === "user");
  const start = items[anchor];
  const matches = start && (requestDigest ? requestHash(start.text || "") === requestDigest :
    typeof requestPrefix === "string" && String(start.text || "").startsWith(requestPrefix));
  if (!oldest || !matches || (turnId && start.turnId && turnId !== start.turnId))
    return { items: !oldest && agent === 'codex' && turnId ? items.filter(i => i?.turnId === turnId && ['tool', 'assistant'].includes(i?.role)) : [],
      found: false, incomplete: true, gaps: [...gaps, "original_turn_unavailable"], session: page?.session, turnId };
  const originalId = turnId || id(start.turnId);
  let end = items.findIndex((i, at) => at > anchor && i?.role === "user" && !i.queued && (agent !== "codex" || !originalId || i.turnId !== originalId));
  if (end < 0) end = items.length;
  let turn = items.slice(anchor, end);
  if (agent === "codex" && originalId) {
    if (turn.some((i) => !i?.turnId && ["user", "assistant", "tool"].includes(i?.role))) gaps.add("provider_turn_id_unavailable");
    if (turn.some((i) => i?.turnId && i.turnId !== originalId)) gaps.add("history_changed");
    turn = turn.filter((i) => i?.turnId === originalId);
  }
  let replyMatched = null;
  if (replyId) {
    const at = turn.findIndex((i) => i.id === replyId && i.role === "assistant" && i.kind === "text");
    replyMatched = at >= 0;
    if (at < 0) gaps.add("original_turn_unavailable");
    else turn = turn.slice(0, at + 1);
  }
  return { items: turn, found: true, replyMatched, later: end < items.length, incomplete: gaps.size > 0, gaps: [...gaps], session: page?.session, turnId: originalId };
}
