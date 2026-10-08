// Shared browser/Node transport contract. Longer calls remain bounded, and
// only known scheduling fields cross an error boundary (never arbitrary data).
export const agentRequestTimeout = (route, method = "GET") =>
  method === "POST" && ["/api/browser/shell", "/api/browser/shortcuts/run"].includes(route) ? 70000 : 35000;

const kinds = new Set([
  "busy",
  "paused",
  "retry",
  "blocked",
  "invalid",
  "unavailable",
]);
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
  return result;
}
export function agentRequestError(status, body) {
  const details = agentErrorDetails({ status, body });
  return Object.assign(Error(details.error), details, { body: details });
}
