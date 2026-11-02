import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Synthetic suspended phone and sockets, not a physical-device/VPN test.
let dom, useFleetConnections, originalSocket, now = 0;
const sockets = [];
const peer = { id: "computer", name: "Computer", url: "https://reach.test", token: "fixture-approval", platform: "win32" };
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; sent = []; closes = 0;
  constructor(url) { this.url = String(url); sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  // The lost transport never acknowledges close, as after phone suspension.
  close() { this.closes++; this.readyState = Socket.CLOSING; }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  presence(revision) { this.onmessage?.({ data: JSON.stringify({ type: "presence", devices: [], changes: { sessions: revision } }) }); }
}
before(async () => {
  dom = await startDom();
  originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  ({ useFleetConnections } = await dom.load("/src/useFleetConnections.ts"));
});
after(async () => { globalThis.WebSocket = originalSocket; await dom?.close(); });
afterEach(() => { sockets.length = 0; Object.defineProperty(dom.document, "hidden", { configurable: true, value: false }); });
const visible = value => {
  Object.defineProperty(dom.document, "hidden", { configurable: true, value: !value });
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
};
const wake = () => {
  dom.window.dispatchEvent(new dom.window.Event("pageshow"));
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  dom.document.dispatchEvent(new dom.window.Event("resume"));
};
let feed;
function Probe({ peers = [peer] }) {
  feed = useFleetConnections(peers);
  return dom.React.createElement("output", null, JSON.stringify(feed));
}
async function mounted(t) {
  const realNow = Date.now;
  now = 0;
  t.mock.method(Date, "now", () => realNow() + now);
  const view = await dom.render(dom.React.createElement(Probe));
  t.after(async () => { await view.unmount(); t.mock.restoreAll(); });
  sockets[0].open(); sockets[0].presence("before");
  await dom.waitFor(() => feed.computer?.state === "connected");
  return view;
}

for (const client of ["iPhone", "iPad", "Android"]) test(`${client}: returning replaces an apparently open dead presence socket exactly once`, async t => {
  const tablet = client === "iPad";
  Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: tablet ? "Mozilla/5.0 (iPad)" : client === "iPhone" ? "Mozilla/5.0 (iPhone)" : "Mozilla/5.0 (Linux; Android) Mobile" });
  await mounted(t);
  assert.equal(sockets[0].sent[0].kind, tablet ? "tablet" : "phone");
  const old = sockets[0], lateMessage = old.onmessage, lateClose = old.onclose;
  visible(false); now += 60000; visible(true); wake();
  await settle();
  assert.equal(sockets.length, 2, "an OPEN flag is not proof that a suspended connection still works");
  assert.equal(old.closes, 1, "retire the old socket without waiting for its close callback");
  const fresh = sockets[1]; fresh.open(); fresh.presence("after");
  await dom.waitFor(() => feed.computer?.changes?.includes("after"));
  lateMessage?.({ data: JSON.stringify({ type: "presence", devices: [], changes: { sessions: "stale" } }) });
  lateClose?.({ code: 4003 });
  wake(); await settle();
  assert.equal(feed.computer.state, "connected", "retired callbacks cannot deny the replacement");
  assert.match(feed.computer.changes, /after/);
  assert.equal(sockets.length, 2, "duplicate foreground events share the replacement");
  assert.ok(sockets.every(socket => socket.sent.length === 1 && socket.sent[0].type === "auth"), "no commands, writes or action payloads are replayed");
  assert.ok(sockets.every(socket => socket.sent[0].token === peer.token), "the device keeps its existing credential");
});

test("a short interruption leaves the current healthy socket and rendered work mounted", async t => {
  const view = await mounted(t);
  const root = view.container;
  visible(false); now += 100; visible(true); wake(); await settle();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closes, 0);
  assert.equal(view.container, root);
  assert.equal(feed.computer.state, "connected");
});

test("a denied grant stays denied across every foreground and network event", async t => {
  await mounted(t);
  sockets[0].readyState = Socket.CLOSED;
  sockets[0].onclose({ code: 4003 });
  visible(false); now += 60000; visible(true); wake();
  dom.window.dispatchEvent(new dom.window.Event("online")); await settle();
  assert.equal(sockets.length, 1);
  assert.equal(feed.computer.state, "denied");
});

test("a suspended timer gap recovers a dead socket when no visibility event was delivered", async t => {
  await mounted(t);
  now += 60000;
  await dom.waitFor(() => sockets.length === 2, 4500);
  assert.equal(sockets[0].closes, 1);
  sockets[1].open(); sockets[1].presence("resumed");
  await dom.waitFor(() => feed.computer?.state === "connected");
});
