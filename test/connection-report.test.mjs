import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Synthetic mobile DOM/clipboard. This checks report privacy and gesture
// ordering, not a physical Safari clipboard or live Tailscale connection.
const origin = "https://mac.tail1.ts.net";
const peer = { id: "mac", name: "Mac", url: origin + ":8443", token: "SECRET-TOKEN", platform: "darwin" };

test("connection reports reveal only allowed metadata and leave identities unchanged", async () => {
  const dom = await startDom({ url: origin + "/?invite=SECRET-INVITE#SECRET-HASH", mobile: true });
  try {
    localStorage.setItem("reach.ways", "1");
    localStorage.setItem("reach.devices", JSON.stringify([peer]));
    localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "SECRET-BROWSER" }]));
    localStorage.setItem("reach.tailnet:_current-profile", "SECRET-PROFILE");
    localStorage.setItem("reach.tailnet:_machinekey", "SECRET-PRIVATE-KEY");
    const script = dom.document.createElement("script");
    script.type = "module"; script.src = "/assets/index-AbCd1234.js";
    dom.document.head.append(script);
    const { connectionReport } = await dom.load("/src/connection-report.ts");
    const before = JSON.stringify({ ...localStorage });
    const text = connectionReport(peer), report = JSON.parse(text);
    assert.equal(report.interface.module, "index-AbCd1234.js");
    assert.equal(report.page.port, "443");
    assert.deepEqual(report.connection, { mode: "native", nativeSavedPeers: 1, browserSavedPeers: 1, browserIdentityComplete: false, browserStateKeys: 2, installedBrowserNode: "not-installed", recovery: { phase: "idle", retained: false, nodeState: "none" } });
    assert.doesNotMatch(text, /SECRET|Bearer|privkey|invite=|#|token|nodeId/i);
    assert.equal(JSON.stringify({ ...localStorage }), before, "reporting never rewrites an identity or approval");
    script.src = "/assets/index-AbCd1234.js?SECRET-QUERY";
    assert.equal(JSON.parse(connectionReport(peer)).interface.module, "unavailable");
  } finally { await dom.close(); }
});

test("copy starts in the tap and clipboard denial offers selectable report text", async () => {
  const dom = await startDom({ url: origin, mobile: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const toasts = [], copies = [];
  try {
    const { default: ConnectionReport } = await dom.load("/src/ConnectionReport.tsx");
    let rejectCopy = false, inTap = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText(text) {
      assert.equal(inTap, true, "Safari's user gesture must still be active");
      copies.push(text);
      return rejectCopy ? Promise.reject(Error("denied")) : Promise.resolve();
    } } });
    await dom.render(dom.React.createElement(ConnectionReport, { peer, toast: text => toasts.push(text) }));
    const button = dom.document.querySelector('[aria-label="Copy connection report"]');
    inTap = true; button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); inTap = false;
    await settle();
    assert.equal(toasts.at(-1), "Connection report copied");
    assert.equal(JSON.parse(copies[0]).report, "reach-connection-v1");
    rejectCopy = true;
    inTap = true; button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); inTap = false;
    await settle();
    assert.equal(copies.length, 2);
    const field = await dom.waitFor(() => dom.document.querySelector('[aria-label="Connection report text"]'), 1000);
    assert.ok(field?.readOnly);
    assert.equal(field.value, copies.at(-1));
    assert.doesNotMatch(field.value, /SECRET-TOKEN/);
    const select = [...dom.document.querySelectorAll("button")].find(button => button.textContent === "Select report");
    select.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.equal(field.selectionStart, 0);
    assert.equal(field.selectionEnd, field.value.length);
    dom.document.querySelector('[aria-label="Close panel"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await dom.waitFor(() => !dom.document.querySelector('[aria-label="Connection report text"]'));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const missing = await dom.waitFor(() => dom.document.querySelector('[aria-label="Connection report text"]'));
    assert.ok(missing.readOnly);
    assert.equal(copies.length, 2, "a missing clipboard offers text without pretending to copy");
  } finally { await dom.close(); }
});

test("report defaults and node metadata cannot leak a complete stored identity", async () => {
  const dom = await startDom({ url: "http://mac.tail1.ts.net", mobile: true });
  const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
  try {
    let networkCalls = 0;
    dom.window.fetch = () => { networkCalls++; throw Error("A report must not make network requests"); };
    const values = {
      _machinekey: hex(`privkey:${"1".repeat(64)}`),
      "_current-profile": hex("SECRET-PROFILE"),
      _profiles: hex({ fixture: { Key: "SECRET-PROFILE", NodeID: "SECRET-NODE" } }),
      "SECRET-PROFILE": hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "SECRET-NODE" } }),
    };
    for (const [name, value] of Object.entries(values)) localStorage.setItem("reach.tailnet:" + name, value);
    const transport = await dom.load("/src/tailnet-transport.ts");
    transport.installTailnet({ status: () => ({ self: { state: "SECRET-STATE", login: "SECRET-LOGIN" }, peers: [] }) }, "tail1.ts.net", "native");
    const { connectionReport } = await dom.load("/src/connection-report.ts");
    const text = connectionReport(peer), report = JSON.parse(text);
    assert.equal(report.page.port, "80");
    assert.equal(report.connection.browserIdentityComplete, true);
    assert.equal(report.connection.installedBrowserNode, "unknown");
    assert.deepEqual(report.connection.recovery, { phase: "idle", retained: true, nodeState: "Unknown" });
    assert.doesNotMatch(text, /SECRET|privkey|11111111|22222222|534543524554|login|token|nodeId/i);
    assert.equal(networkCalls, 0);
  } finally { await dom.close(); }
});
