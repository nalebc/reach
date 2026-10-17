const bounded = (value, limit = 500) => typeof value === "string" ? value.slice(0, limit) : "";
const pathname = value => {
  try { return bounded(new URL(String(value), "http://isolated.test").pathname, 256); }
  catch { return "invalid path"; }
};
const message = value => bounded(value)
  .replace(/https?:\/\/[^\s"'<>]+/g, value => {
    try { const url = new URL(value); return url.origin + url.pathname; }
    catch { return "[invalid URL]"; }
  })
  .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");

// Evidence for one disposable smoke page only. No headers, query strings,
// request bodies, storage, DOM text or user files are recorded.
export function createIosPageEvidence({ now = Date.now, started = now(), maxRequests = 128, maxEvents = 32 } = {}) {
  const network = [], browser = [];
  let droppedRequests = 0, droppedEvents = 0;
  const seconds = () => Math.max(0, Math.round((now() - started) / 100) / 10);
  return {
    request(req, res) {
      if (network.length >= maxRequests) { droppedRequests++; return; }
      const item = { path: pathname(req.url), method: bounded(req.method, 16), seconds: seconds(), outcome: "pending" };
      network.push(item);
      res.once("finish", () => {
        item.outcome = "finished";
        item.status = res.statusCode;
        item.finishedSeconds = seconds();
      });
      res.once("close", () => {
        if (item.outcome === "pending") { item.outcome = "closed"; item.closedSeconds = seconds(); }
      });
    },
    event(value) {
      if (browser.length >= maxEvents) { droppedEvents++; return; }
      if (!value || typeof value !== "object") return;
      browser.push({
        kind: bounded(value.kind, 40), seconds: seconds(),
        ...(typeof value.readyState === "string" ? { readyState: bounded(value.readyState, 20) } : {}),
        ...(typeof value.name === "string" ? { name: bounded(value.name, 80) } : {}),
        ...(typeof value.message === "string" ? { message: message(value.message) } : {}),
        ...(typeof value.source === "string" ? { source: pathname(value.source) } : {}),
        ...(Number.isSafeInteger(value.line) ? { line: value.line } : {}),
        ...(Number.isSafeInteger(value.column) ? { column: value.column } : {}),
      });
    },
    snapshot() { return structuredClone({ network, browser, droppedRequests, droppedEvents }); },
  };
}

// A classic same-origin script runs before the application's module. If that
// module cannot load or throws, its evidence doesn't depend on React or the
// later automated pairing script starting successfully.
export function iosPageDiagnosticScript(endpoint) {
  return `(${function observe(endpoint) {
    const send = value => {
      const body = JSON.stringify({ ...value,
        ...(typeof value.message === "string" ? { message: value.message.slice(0, 500) } : {}),
        ...(typeof value.source === "string" ? { source: value.source.slice(0, 1000) } : {}),
        readyState: document.readyState });
      try { void fetch(endpoint, { method: "POST", body }).catch(() => {}); } catch {}
    };
    window.__reachIosSmokeEvidence = send;
    send({ kind: "diagnostic-script" });
    document.addEventListener("DOMContentLoaded", () => send({ kind: "DOMContentLoaded" }), { once: true });
    window.addEventListener("load", () => send({ kind: "load" }), { once: true });
    window.addEventListener("error", event => {
      const target = event.target;
      if (target && target !== window) {
        send({ kind: "resource-error", source: target.src || target.href || "" });
      } else send({ kind: "error", name: event.error?.name || "Error", message: String(event.message || ""),
        source: event.filename || "", line: event.lineno, column: event.colno });
    }, true);
    window.addEventListener("unhandledrejection", event => send({ kind: "unhandledrejection",
      name: event.reason?.name || "Error", message: String(event.reason?.message || event.reason || "") }));
  }.toString()})(${JSON.stringify(endpoint)});`;
}

export function instrumentIosPage(html, probe) {
  const early = `<script src="${probe}/diagnostics.js"></script>`;
  return html.replace(/<head(?:\s[^>]*)?>/i, head => head + early)
    .replace("</body>", `<script src="${probe}.js" defer></script></body>`);
}

export function iosPageFailureReport({ error, last, context }) {
  return { ...context, ok: false,
    error: (typeof error === "string" ? error : error?.message) || `Did not finish. Last step reached: ${last}.` };
}
