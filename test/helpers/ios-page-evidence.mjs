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

// The disposable page's failure state only: no input values, error text,
// storage, names, URLs or credentials leave the page through this observer.
export function iosPairingState(doc, native) {
  const pairing = doc.querySelector("input.pair-code");
  const form = pairing?.closest("form");
  const address = form?.querySelector('input[type="url"]') || doc.querySelector('input[type="url"]');
  const error = form?.querySelector('.error[role="alert"]')?.textContent || "";
  let errorCategory = error.trim() ? "other" : "none";
  if (/can[’']t reach|could not connect|couldn[’']t connect|connect tailscale|didn[’']t answer/i.test(error)) errorCategory = "unreachable";
  else if (/pairing code.*incorrect|code.*expired|code.*incorrect/i.test(error)) errorCategory = "pairing-code";
  else if (/too many attempts/i.test(error)) errorCategory = "rate-limit";
  // Read validity properties only: checkValidity() would dispatch invalid
  // events and turn this diagnostic into another interaction with the form.
  return {
    nativeBridge: typeof native?.nativePromise === "function",
    addressPresent: !!address, addressHasValue: !!address?.value,
    addressValid: address?.validity?.valid === true,
    pairingPresent: !!pairing, pairingHasValue: !!pairing?.value,
    pairingLengthValid: typeof pairing?.value === "string" && /^\d{8}$/.test(pairing.value.replace(/\s/g, "")),
    formPresent: !!form,
    formValid: !!form && [...form.querySelectorAll("input, textarea, select")].every(input => input.validity.valid),
    formBusy: !!form?.querySelector("button:disabled"), errorCategory,
  };
}

// A classic same-origin script runs before the application's module. If that
// module cannot load or throws, its evidence doesn't depend on React or the
// later automated pairing script starting successfully.
export function iosPageDiagnosticScript(endpoint) {
  return `(${function observe(endpoint, pairingState) {
    const send = value => {
      const body = JSON.stringify({ ...value,
        ...(typeof value.message === "string" ? { message: value.message.slice(0, 500) } : {}),
        ...(typeof value.source === "string" ? { source: value.source.slice(0, 1000) } : {}),
        readyState: document.readyState });
      try { void fetch(endpoint, { method: "POST", body }).catch(() => {}); } catch {}
    };
    window.__reachIosSmokeEvidence = send;
    window.__reachIosSmokePairingState = () => pairingState(document, window.Capacitor);
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
  }.toString()})(${JSON.stringify(endpoint)}, ${iosPairingState.toString()});`;
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

export function applyIosAssetGate(report, evidence) {
  const failures = new Map();
  const asset = value => {
    const path = pathname(value);
    return path.startsWith("/assets/") ? path : "";
  };
  for (const response of evidence?.network || []) {
    const path = asset(response.path);
    if (path && response.status >= 400) failures.set(path, { path, status: response.status });
  }
  for (const event of evidence?.browser || []) {
    const path = asset(event.source);
    if (path && event.kind === "resource-error") failures.set(path, { ...failures.get(path), path, resourceError: true });
  }
  const assetFailures = [...failures.values()];
  if (!assetFailures.length) return { ...report, assetFailures };
  const detail = assetFailures.slice(0, 8).map(value => `${value.path}${value.status ? ` (HTTP ${value.status})` : " (resource error)"}`).join(", ");
  return { ...report, ok: false, assetFailures,
    error: report.ok === false && report.error ? report.error : `Built interface assets failed to load: ${detail}` };
}
