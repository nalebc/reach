// Shared browser/Node transport contract. Longer calls remain bounded, and
// only known scheduling fields cross an error boundary (never arbitrary data).
export const agentRequestTimeout = (route, method = "GET") =>
  method === "POST" && (
    ["/api/browser/mcp/call", "/api/browser/shell", "/api/browser/desktop/mac-shortcuts/run", "/api/browser/shortcuts/run", "/api/browser/tools/run", "/api/browser/tools/batch", "/api/browser/services/run"].includes(route) ||
    /^\/api\/browser\/mcp\/call\?runtime=[a-f0-9]{64}$/.test(route)
  ) ? 70000 : 35000;

export const agentErrorKinds = Object.freeze({ blocked: 403, paused: 409, retry: 409, busy: 409, invalid: 400, unavailable: 503, setup_required: 503 });
const kinds = new Set(Object.keys(agentErrorKinds));
const helperReasons = new Set(["timeout", "process_exit", "process_error", "stdin_error", "write_error", "invalid_reply", "oversized_reply", "unexpected_reply", "stopped"]);
// The producer and every transport use the same bounded operation vocabulary.
export const desktopHelperOperations = Object.freeze(["rules", "catalog", "shot", "front", "act", "open", "elements", "open-url", "browser-check", "windows", "focus", "menus", "find", "read", "open-file", "displays", "wait-change"]);
const helperOperations = new Set([...desktopHelperOperations, "unknown"]);
const helperDispatches = new Set(["completion_unknown", "not_dispatched"]);
const clean = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max)
    : "";
// One path segment from an ID an agent gave: never empty, "." or "..",
// which would turn into another route once the address is read (audit L6).
export function idSegment(value) {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text))
    throw Object.assign(Error("Give a valid id."), { status: 400 });
  return encodeURIComponent(text);
}
export function agentErrorDetails(error) {
  const body = error?.body || error || {};
  const result = {
    error:
      clean(error?.message || body.error, 1000) ||
      "Reach could not complete the request.",
  };
  const status = error?.status ?? body.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599)
    result.status = status;
  if (kinds.has(body.kind)) {
    result.kind = body.kind;
    // Busy: another agent, for seconds. Paused: a person using the Mac
    // (server/screen.mjs ownerHoldRefusal), back up to 2 minutes after
    // their last input.
    if (body.kind === "busy" || body.kind === "paused") {
      if (typeof body.holder === "string")
        result.holder = clean(body.holder, 100);
      if (
        Number.isFinite(body.retryInMs) &&
        body.retryInMs >= 0 &&
        body.retryInMs <= (body.kind === "busy" ? 60000 : 120000)
      )
        result.retryInMs = Math.ceil(body.retryInMs);
    }
  }
  if (result.kind === "invalid" && Array.isArray(body.candidates)) result.candidates = body.candidates.slice(0, 8)
    .filter(item => item && typeof item.ref === "string" && /^e-[a-f0-9-]{1,38}$/.test(item.ref))
    .map(item => ({ ref: item.ref, name: clean(item.name, 120), role: clean(item.role, 40), context: clean(item.context, 400) }));
  // Only a complete, fixed diagnostic tuple can cross this boundary. Never
  // forward native stderr, request payloads, paths or arbitrary exit details.
  if (status === 503 && body.kind === "unavailable" && helperReasons.has(body.helperReason) &&
      helperOperations.has(body.helperOperation) && helperDispatches.has(body.helperDispatch)) {
    result.helperReason = body.helperReason;
    result.helperOperation = body.helperOperation;
    result.helperDispatch = body.helperDispatch;
  }
  return result;
}
export function agentRequestError(status, body) {
  const details = agentErrorDetails({ status, body });
  return Object.assign(Error(details.error), details, { body: details });
}
