import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JSDOM } from "jsdom";
import { createIosPageEvidence, instrumentIosPage, iosPageDiagnosticScript, iosPageFailureReport, applyIosAssetGate, iosPairingState } from "./helpers/ios-page-evidence.mjs";

const probe = "/__simulator_disposable";
function request(evidence, path, status = 200) {
  const res = new EventEmitter();
  res.statusCode = status;
  evidence.request({ url: path, method: "GET" }, res);
  return res;
}

test("an unvisited smoke page is distinguishable from HTML loaded with a stalled module", () => {
  const absent = createIosPageEvidence();
  assert.deepEqual(absent.snapshot().network, []);
  const loaded = createIosPageEvidence();
  request(loaded, "/").emit("finish");
  request(loaded, "/assets/app.js?token=secret");
  assert.deepEqual(loaded.snapshot().network.map(({ path, outcome }) => [path, outcome]), [["/", "finished"], ["/assets/app.js", "pending"]]);
  assert.doesNotMatch(JSON.stringify(loaded.snapshot()), /secret|token/);
  assert.deepEqual(loaded.snapshot().browser, [], "no bootstrap event is not proof the page never requested HTML");
});

test("resource response failures and aborted loads remain evidence without converting the failed verdict", () => {
  const evidence = createIosPageEvidence();
  request(evidence, "/assets/missing.js", 404).emit("finish");
  request(evidence, "/assets/aborted.js").emit("close");
  const original = Error("iOS test page did not report within 100 s");
  const report = iosPageFailureReport({ error: original, last: "app launched", context: { ok: true, error: "must not override the original failure", pageSeen: false, pageEvidence: evidence.snapshot() } });
  assert.equal(report.ok, false);
  assert.equal(report.error, "iOS test page did not report within 100 s");
  assert.deepEqual(report.pageEvidence.network.map(({ outcome, status }) => [outcome, status]), [["finished", 404], ["closed", undefined]]);
});

test("the diagnostic script loads before the application module and the pairing script stays deferred", () => {
  const html = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>';
  const dom = new JSDOM(instrumentIosPage(html, probe));
  try {
    const scripts = [...dom.window.document.scripts];
    assert.deepEqual(scripts.map(script => [script.getAttribute("src"), script.type, script.defer]), [
      [probe + "/diagnostics.js", "", false], ["/assets/app.js", "module", false], [probe + ".js", "", true],
    ]);
  } finally { dom.window.close(); }
});

test("early JavaScript beacons distinguish module and runtime errors before automated pairing starts", async () => {
  const evidence = createIosPageEvidence();
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:12345/", runScripts: "outside-only" });
  const calls = [];
  dom.window.fetch = async (path, init) => { calls.push({ path, method: init.method }); evidence.event(JSON.parse(init.body)); };
  try {
    dom.window.eval(iosPageDiagnosticScript(probe + "/evidence"));
    assert.equal(dom.window.__reachIosSmokePairingState().nativeBridge, false);
    assert.equal(dom.window.__reachIosSmokePairingState().formPresent, false);
    const script = dom.window.document.createElement("script");
    script.src = "/assets/module.js?credential=must-not-record";
    dom.window.document.head.append(script);
    script.dispatchEvent(new dom.window.Event("error"));
    dom.window.dispatchEvent(new dom.window.ErrorEvent("error", { error: new dom.window.TypeError("Module failed"), message: "Module failed", filename: "http://127.0.0.1:12345/assets/app.js?secret=hidden", lineno: 7, colno: 9 }));
    const rejection = new dom.window.Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: new dom.window.TypeError("Bridge failed") });
    dom.window.dispatchEvent(rejection);
    await Promise.resolve();
    const events = evidence.snapshot().browser;
    assert.equal(events[0].kind, "diagnostic-script");
    assert.ok(events.some(event => event.kind === "resource-error" && event.source === "/assets/module.js"));
    assert.ok(events.some(event => event.kind === "error" && event.message === "Module failed" && event.line === 7 && event.column === 9));
    assert.ok(events.some(event => event.kind === "unhandledrejection" && event.message === "Bridge failed"));
    assert.ok(!events.some(event => event.kind === "test-script"), "diagnostics do not depend on the pairing automation running");
    assert.ok(calls.every(call => call.path === probe + "/evidence" && call.method === "POST"));
    assert.doesNotMatch(JSON.stringify(evidence.snapshot()), /credential|must-not-record|secret|hidden/);
  } finally { dom.window.close(); }
});

test("page evidence is bounded, omits non-allowlisted data and snapshots cannot be mutated by late events", () => {
  let now = 0;
  const evidence = createIosPageEvidence({ now: () => now, started: 0, maxRequests: 2, maxEvents: 2 });
  const first = request(evidence, "/");
  const snapshot = evidence.snapshot();
  now = 1200;
  first.emit("finish");
  request(evidence, "/asset");
  request(evidence, "/ignored");
  evidence.event({ kind: "error", message: "m".repeat(2000), storage: "private", authorization: "must-not-record" });
  evidence.event({ kind: "load" });
  evidence.event({ kind: "ignored" });
  assert.equal(snapshot.network[0].outcome, "pending");
  assert.equal(evidence.snapshot().network[0].finishedSeconds, 1.2);
  assert.equal(evidence.snapshot().network.length, 2);
  assert.equal(evidence.snapshot().browser.length, 2);
  assert.equal(evidence.snapshot().browser[0].message.length, 500);
  assert.equal(evidence.snapshot().droppedRequests, 1);
  assert.equal(evidence.snapshot().droppedEvents, 1);
  assert.doesNotMatch(JSON.stringify(evidence.snapshot()), /private|must-not-record|storage|authorization/);
});

test("diagnostic error messages redact URL credentials, query strings and bearer values", () => {
  const evidence = createIosPageEvidence();
  evidence.event({ kind: "error", message: "Failed https://user:password@isolated.test/assets/app.js?token=secret#fragment with Bearer private-value" });
  const entry = evidence.snapshot().browser[0];
  assert.equal(entry.message, "Failed https://isolated.test/assets/app.js with Bearer [redacted]");
});

test("pairing failure state records only booleans and a category, without validating or exposing the synthetic form", () => {
  const dom = new JSDOM('<form><input type="url" required><input class="pair-code" required><input value="private name"><div class="error" role="alert"></div><button disabled>Connecting…</button></form>');
  try {
    const { document } = dom.window;
    document.querySelector('input[type="url"]').value = "https://user:password@isolated.test/?credential=must-not-record";
    document.querySelector("input.pair-code").value = "12345678";
    document.querySelector(".error").textContent = "Can’t reach this computer. Keep Reach running and your computer awake. private error text";
    let invalid = 0;
    document.addEventListener("invalid", () => invalid++, true);
    const state = iosPairingState(document, { nativePromise() {} });
    assert.deepEqual(state, { nativeBridge: true, addressPresent: true, addressHasValue: true, addressValid: true,
      pairingPresent: true, pairingHasValue: true, pairingLengthValid: true, formPresent: true, formValid: true,
      formBusy: true, errorCategory: "unreachable" });
    document.querySelector('input[type="url"]').value = "not a url";
    assert.equal(iosPairingState(document).formValid, false);
    assert.equal(invalid, 0, "diagnostics must not dispatch validation events");
    assert.doesNotMatch(JSON.stringify(state), /user|password|isolated|credential|must-not-record|12345678|private/);
    for (const [text, category] of [["That pairing code is incorrect or expired.", "pairing-code"], ["Too many attempts.", "rate-limit"], ["unexpected private text", "other"], ["", "none"]]) {
      document.querySelector(".error").textContent = text;
      assert.equal(iosPairingState(document).errorCategory, category);
    }
  } finally { dom.window.close(); }
});

const observedAssets = [
  "/assets/r2-Screen-DhsLo3GP.js", "/assets/r2-screen-bar-ONjNkpRo.css", "/assets/r2-KeyRow-CTFHeBlt.js",
  "/assets/r2-screen-bar-DWtt80gK.js", "/assets/r2-useImmersiveChrome-DmMoYGQd.js",
];
const observedEvidence = () => ({ network: observedAssets.map(path => ({ path, method: "GET", outcome: "finished", status: 502 })),
  browser: observedAssets.map(source => ({ kind: "resource-error", source })) });

test("the observed402 report with eight native checks and five asset502s must fail its final verdict", () => {
  const report = { ok: true, checks: Array.from({ length: 8 }, (_, i) => `native check ${i}`), platform: "ios" };
  const final = applyIosAssetGate(report, observedEvidence());
  assert.equal(final.ok, false);
  assert.match(final.error, /built interface assets/i);
  assert.equal(final.assetFailures.length, 5);
  assert.deepEqual(final.checks, report.checks, "all eight original native checks remain required");
  assert.equal(report.ok, true, "the source evidence is preserved");
});

test("a native failure remains the primary error when interface assets also fail", () => {
  const report = { ok: false, error: "Native download failed: certificate rejected", checks: ["pairing succeeded"] };
  const final = applyIosAssetGate(report, observedEvidence());
  assert.equal(final.ok, false);
  assert.equal(final.error, report.error);
  assert.equal(final.assetFailures.length, 5);
});

test("an assets resource error without an HTTP status still fails, and intentionally blocked API calls do not", () => {
  const report = { ok: true, checks: [] };
  const apiOnly = { network: [{ path: "/api/sessions", status: 503 }], browser: [] };
  assert.equal(applyIosAssetGate(report, apiOnly).ok, true);
  const failed = applyIosAssetGate(report, { ...apiOnly, browser: [{ kind: "resource-error", source: "/assets/r2-module.js" }] });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.assetFailures, [{ path: "/assets/r2-module.js", resourceError: true }]);
});
