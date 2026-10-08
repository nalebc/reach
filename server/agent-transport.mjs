// Shared browser/Node transport contract. Longer calls remain bounded, and
// only known scheduling fields cross an error boundary (never arbitrary data).
export const agentRequestTimeout = (route, method = "GET") =>
  method === "POST" && ["/api/browser/shell", "/api/browser/shortcuts/run", "/api/browser/tools/run", "/api/browser/services/run"].includes(route) ? 70000 : 35000;

const kinds = new Set([
  "busy",
  "paused",
  "retry",
  "blocked",
  "invalid",
  "unavailable",
]);
const helperReasons = new Set(["timeout", "process_exit", "process_error", "stdin_error", "write_error", "invalid_reply", "oversized_reply", "unexpected_reply", "stopped"]);
const helperOperations = new Set(["rules", "catalog", "shot", "front", "act", "open", "unknown"]);
const helperDispatches = new Set(["completion_unknown", "not_dispatched"]);
const clean = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max)
    : "";
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
    if (body.kind === "busy") {
      if (typeof body.holder === "string")
        result.holder = clean(body.holder, 100);
      if (
        Number.isFinite(body.retryInMs) &&
        body.retryInMs >= 0 &&
        body.retryInMs <= 60000
      )
        result.retryInMs = Math.ceil(body.retryInMs);
    }
  }
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
