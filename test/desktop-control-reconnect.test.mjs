import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startDom, settle } from "./dom/harness.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { ScreenControl } from "../server/screen.mjs";

// A brief interruption used to end desktop control: the Mac closed the input
// socket with 4001 "Desktop control expired or was revoked" when Tailscale's
// word on the phone came late, and the phone took any close as the end
// (Oct 7, on 5G through a relay). Now the Mac closes with 1012 and keeps the
// control lease a moment; the phone reconnects quietly, like the live screen,
// and resumes control without the owner granting it again.

const until = async (check, ms = 1500) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out waiting for state");
};
const socket = () =>
  Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close(code, reason) {
      this.readyState = 2;
      this.closedWith = { code, reason };
    },
  });
const phone = { id: "phone", name: "Phone", scopes: ["admin", "screen"] };

// holdFor: how long Tailscale's word may come late before the connection
// ends (held meanwhile: desktop-identity-hold.test.mjs). Short here.
function mac({ grace = 400, holdFor = 100 } = {}) {
  const control = new ScreenControl();
  const connections = new Map();
  const state = { client: phone, interruption: "", creates: 0 };
  const connect = () => {
    const ws = socket();
    desktopConnection(ws, {
      config: { screen: true },
      auth: {
        verify: () => state.client,
        interruption: () => state.interruption,
      },
      control,
      create: async () => (state.creates++, { send: async () => ({ cursor: null }), stop() {} }),
      register: (id, s) => {
        if (connections.get(id)?.readyState === 1) throw Error("duplicate");
        connections.set(id, s);
      },
      unregister: (id, s) => {
        if (connections.get(id) !== s) return false;
        connections.delete(id);
        return true;
      },
      grace,
      holdFor,
    });
    const send = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
    send({ type: "auth", token: "T", display: "1" });
    return { ws, send };
  };
  return { control, state, connect };
}

// Exercise already-queued expiry callbacks explicitly: clearing a timeout
// alone is not sufficient once a replacement grant has been created.
function graceTimers(t) {
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    const timer = { callback, ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => { if (timer) timer.cleared = true; });
  return timers;
}

test("explicit release or a new grant invalidates an old reconnect expiry", (t) => {
  const timers = graceTimers(t);
  for (const release of [false, true]) {
    let now = 1000;
    const control = new ScreenControl(() => now);
    control.acquire(phone, true);
    control.revokeLater(phone.id, 15000);
    const old = timers.at(-1);
    if (release) {
      control.acquire(phone, false);
      assert.equal(control.reconnecting(phone.id), false, "explicit release cancels grace");
    }
    now += 1000;
    const grant = control.acquire(phone, true);
    assert.equal(grant.expiresAt, now + 30000, "the normal new-grant lifetime is unchanged");
    assert.equal(control.reconnecting(phone.id), false);
    assert.equal(old.cleared, true);
    old.callback();
    assert.equal(control.holder()?.clientId, phone.id, "queued old expiry cannot revoke replacement");
    control.clear();
  }
});

test("takeover discards obsolete grace but a refused takeover leaves it active", (t) => {
  const timers = graceTimers(t);
  const control = new ScreenControl(() => 1000);
  const other = { ...phone, id: "other" };
  control.acquire(phone, true);
  control.revokeLater(phone.id, 15000);
  const old = timers.at(-1);
  assert.throws(() => control.acquire(other, true), { status: 409 });
  assert.equal(control.reconnecting(phone.id), true, "failed request must not cancel holder's expiry");
  assert.equal(old.cleared, false);
  control.acquire(other, true, { takeover: true });
  assert.equal(control.reconnecting(phone.id), false);
  control.acquire(phone, true, { takeover: true });
  old.callback();
  assert.equal(control.holder()?.clientId, phone.id, "retaking control creates a new grant");
  control.clear();
});

test("only the current reconnect generation can expire its own original lease", (t) => {
  const timers = graceTimers(t);
  let now = 1000;
  const control = new ScreenControl(() => now);
  control.acquire(phone, true);
  const expiresAt = control.lease.expiresAt;
  control.revokeLater(phone.id, 15000);
  const first = timers.at(-1);
  control.revokeLater(phone.id, 15000);
  const second = timers.at(-1);
  first.callback();
  assert.equal(control.reconnecting(phone.id), true, "stale callback leaves replacement grace intact");
  assert.equal(control.holder()?.clientId, phone.id);
  assert.equal(control.lease.expiresAt, expiresAt, "grace never extends the underlying lease");
  now = expiresAt;
  assert.equal(control.holder(), null, "authorization expires even if grace is still pending");
  second.callback();
  assert.equal(control.reconnecting(phone.id), false);
  assert.equal(control.lease, null);
});

test("native retirement survives revoke and clear until every process actually exits", async () => {
  const control = new ScreenControl();
  let endFirst, endSecond;
  const first = new Promise((resolve) => { endFirst = resolve; });
  const second = new Promise((resolve) => { endSecond = resolve; });
  control.acquire(phone, true);
  control.retireInput(first);
  control.retireInput(first);
  assert.equal(control.retiringInputs.size, 1, "repeated close callbacks do not duplicate ownership");
  let stopped = false;
  const wait = control.waitForInputStop().then(() => { stopped = true; });
  control.revoke(phone.id);
  control.clear();
  assert.equal(control.inputStopping(), true, "grant revocation is not process termination");
  control.retireInput(second); // arrives after wait took its first snapshot
  endFirst();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(control.inputStopping(), true);
  endSecond();
  await wait;
  assert.equal(stopped, true);
  assert.equal(control.inputStopping(), false);
});

test("an unconfirmed native termination fails closed instead of releasing input ownership", async () => {
  const control = new ScreenControl();
  const failure = Error("termination unconfirmed");
  control.retireInput(Promise.reject(failure));
  await assert.rejects(control.waitForInputStop(), failure);
  control.clear();
  assert.equal(control.inputStopping(), true);
});

test("a transient denial closes control as retryable and keeps the lease for the reconnect", async () => {
  const { control, state, connect } = mac();
  control.acquire(phone, true);
  const first = connect();
  await until(() => first.ws.sent.some((m) => m.type === "ready"));
  // Tailscale's whois about the phone lapses for a moment: verify says no,
  // but only because the answer is late.
  state.client = null;
  state.interruption = "Checking this phone's connection. Reconnecting…";
  first.send({ type: "input", id: 1, action: { type: "heartbeat" } });
  await until(() => first.ws.closedWith);
  assert.equal(first.ws.closedWith.code, 1012);
  assert.deepEqual(first.ws.sent.at(-1), {
    type: "error",
    error: "Checking this phone's connection. Reconnecting…",
    retryable: true,
  });
  first.ws.emit("close", 1012);
  assert.ok(control.holder(), "the lease waits for the phone");
  assert.ok(control.reconnecting("phone"));
  // The answer comes in; the phone is back within the grace.
  state.client = phone;
  state.interruption = "";
  const second = connect();
  await until(() => second.ws.sent.some((m) => m.type === "ready"));
  assert.equal(control.reconnecting("phone"), false);
  assert.equal(control.holder()?.clientId, "phone");
  second.send({ type: "input", id: 1, action: { type: "heartbeat" } });
  await until(() => second.ws.sent.some((m) => m.type === "ack" && m.id === 1));
  assert.equal(second.ws.closedWith, undefined, "control resumed without a new grant");
  // The first connection's late close changes nothing for the second.
  first.ws.emit("close", 1012);
  await settle(450);
  assert.equal(control.holder()?.clientId, "phone");
  second.ws.emit("close", 1000);
  assert.equal(control.holder(), null, "a clean close lets control go at once");
});

test("nobody back within the grace: the lease is released", async () => {
  const { control, state, connect } = mac({ grace: 100 });
  control.acquire(phone, true);
  const first = connect();
  await until(() => first.ws.sent.some((m) => m.type === "ready"));
  state.client = null;
  state.interruption = "Checking this Mac's connection. Reconnecting…";
  await until(() => first.ws.closedWith, 1500);
  assert.equal(first.ws.closedWith.code, 1012);
  first.ws.emit("close", 1012);
  assert.ok(control.holder());
  await settle(150);
  assert.equal(control.holder(), null);
  assert.equal(control.reconnecting("phone"), false);
});

test("a revoked credential still closes 4001 and releases the lease at once", async () => {
  const { control, state, connect } = mac();
  control.acquire(phone, true);
  const first = connect();
  await until(() => first.ws.sent.some((m) => m.type === "ready"));
  state.client = null;
  first.send({ type: "input", id: 1, action: { type: "heartbeat" } });
  await until(() => first.ws.closedWith);
  assert.equal(first.ws.closedWith.code, 4001);
  assert.equal(first.ws.sent.at(-1).error, "Desktop control expired or was revoked.");
  assert.equal(first.ws.sent.at(-1).retryable, undefined);
  first.ws.emit("close", 4001);
  assert.equal(control.holder(), null);
  assert.equal(control.reconnecting("phone"), false);
});

test("a dropped link keeps the lease; three seconds of silence close as retryable", async () => {
  const { control, connect } = mac();
  control.acquire(phone, true);
  const first = connect();
  await until(() => first.ws.sent.some((m) => m.type === "ready"));
  // The phone's link went away: no close frame, the socket just errors.
  first.ws.emit("error", Error("read ECONNRESET"));
  first.ws.emit("close", 1006);
  assert.ok(control.holder());
  assert.ok(control.reconnecting("phone"));
  control.keep("phone");
  const second = connect();
  await until(() => second.ws.sent.some((m) => m.type === "ready"));
  await until(() => second.ws.closedWith, 4500);
  assert.equal(second.ws.closedWith.code, 1012);
  assert.match(second.ws.sent.at(-1).error, /disconnected\. Reconnecting…$/);
});

// The phone's side: the hook behind Control on the screen page.
class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(m) {
    this.sent.push(JSON.parse(m));
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  push(m) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  ends(code, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
let dom, React, useDesktopInput, realSocket;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ useDesktopInput } = await dom.load("/src/useDesktopInput.ts"));
  realSocket = globalThis.WebSocket;
  dom.window.WebSocket = globalThis.WebSocket = FakeSocket;
});
after(() => {
  globalThis.WebSocket = realSocket;
  dom?.close();
});

async function control() {
  const ended = [];
  const seen = { input: null };
  function Probe() {
    seen.input = useDesktopInput({ url: "http://mac.test", token: "T" }, true, "primary", (m) => ended.push(m));
    return null;
  }
  const before = FakeSocket.all.length;
  const view = await dom.render(React.createElement(Probe));
  await settle(10);
  const first = FakeSocket.all[before];
  first.push({ type: "ready", window: 8, typing: true, probe: true });
  await settle(10);
  assert.equal(seen.input.ready, true);
  return { view, ended, seen, first };
}

test("a 1012 close shows reconnecting, keeps control on, and resumes on the next connection", async () => {
  const { view, ended, seen, first } = await control();
  let rejected;
  seen.input
    .send({ type: "click", x: 0.5, y: 0.5, button: "left", count: 1 })
    .catch((e) => (rejected = e.message));
  await settle(5);
  first.push({ type: "error", error: "Checking this phone's connection. Reconnecting…", retryable: true });
  first.ends(1012, "Desktop control reconnecting");
  await settle(10);
  assert.equal(rejected, "Desktop control ended.", "the click in flight is not kept");
  assert.deepEqual(ended, [], "control is not over");
  assert.equal(seen.input.ready, false);
  assert.equal(seen.input.reconnecting, true);
  assert.deepEqual(first.closedWith, { code: 4002, reason: "Reconnecting" }, "told the Mac it comes back");
  await until(() => FakeSocket.all.at(-1) !== first, 1000);
  const second = FakeSocket.all.at(-1);
  await settle(10);
  assert.deepEqual(second.sent[0], { type: "auth", token: "T", display: "primary" });
  second.push({ type: "ready", window: 8, typing: true, probe: true });
  await settle(10);
  assert.equal(seen.input.ready, true);
  assert.equal(seen.input.reconnecting, false);
  assert.deepEqual(ended, []);
  // Nothing from before the interruption is replayed.
  assert.equal(second.sent.some((m) => m.type === "input" && m.action.type === "click"), false);
  await view.unmount();
});

test("a 4001 close, or a server error not marked retryable, still ends control", async () => {
  const { view, ended, first } = await control();
  first.push({ type: "error", error: "Desktop control expired or was revoked." });
  first.ends(4001, "Desktop control ended");
  await settle(10);
  assert.deepEqual(ended, ["Desktop control expired or was revoked."]);
  const count = FakeSocket.all.length;
  await settle(400);
  assert.equal(FakeSocket.all.length, count, "no reconnect");
  await view.unmount();
});

test("retries are bounded: too many in a row end control with the reason", async () => {
  const { view, ended, seen } = await control();
  const stop = Date.now() + 20000;
  while (!ended.length && Date.now() < stop) {
    const current = FakeSocket.all.at(-1);
    if (current.readyState === 1) current.ends(1006);
    // Each wait is bounded (250 ms, doubling, at most 4 s); jump past it.
    await settle(5);
    dom.window.dispatchEvent(new dom.window.Event("online"));
    await settle(10);
  }
  assert.deepEqual(ended, ["Desktop control disconnected. Try Control again."]);
  assert.equal(seen.input.reconnecting, false);
  await view.unmount();
});

test("another window of this phone taking control over: this one stops quietly, without ending that control", async () => {
  const ended = [];
  const seen = { input: null };
  function Probe() {
    seen.input = useDesktopInput({ url: "http://mac.test", token: "T" }, true, "primary", (m, elsewhere) => ended.push([m, elsewhere]));
    return null;
  }
  const view = await dom.render(React.createElement(Probe));
  await settle(10);
  const first = FakeSocket.all.at(-1);
  first.push({ type: "ready", window: 8, typing: true, probe: true });
  await settle(10);
  first.push({ type: "error", error: "Desktop control moved to a new connection.", retryable: true, superseded: true });
  first.ends(1012, "Superseded");
  await settle(10);
  assert.deepEqual(ended, [["Control moved to your other window.", true]]);
  assert.equal(seen.input.reconnecting, false);
  const count = FakeSocket.all.length;
  await settle(400);
  assert.equal(FakeSocket.all.length, count, "no reconnect taking it back");
  await view.unmount();
});

test("a replaced connection closes as reconnecting while control is on; turned off, it lets go", async () => {
  const { view, first } = await control();
  await view.unmount();
  assert.deepEqual(first.closedWith, { code: 4002, reason: "Reconnecting" }, "never a code-less close (1005), read as letting go");
  let turn;
  function Toggle() {
    const [on, set] = React.useState(true);
    turn = set;
    useDesktopInput({ url: "http://mac.test", token: "T" }, on, "primary", () => {}, on);
    return null;
  }
  const toggle = await dom.render(React.createElement(Toggle));
  await settle(10);
  const live = FakeSocket.all.at(-1);
  live.push({ type: "ready", window: 8, typing: true, probe: true });
  await settle(10);
  turn(false);
  await settle(10);
  assert.deepEqual(live.closedWith, { code: 1000, reason: "Control off" });
  await toggle.unmount();
});
