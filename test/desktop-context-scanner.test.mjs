import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { ScreenControl } from "../server/screen.mjs";

// Which app is in front (the phone asks every 2.5 s) used to be read by the
// input helper, in turn with clicks and keys: a menu rebuild there (up to 300
// items, 0.15 s each at worst) held them until they were dropped late or the
// helper's 10 s timeout ended control. Fake helpers only: nothing here
// launches a native helper or posts input.

const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out waiting for state");
};
const owner = { id: "owner", kind: "device", name: "Owner", scopes: ["admin", "screen"] };
// One request at a time, as DesktopInput.send: a second while one is pending
// is refused (429), which a scan and a read side by side would hit.
const helper = (name, slow = {}, answers = {}) => {
  const fake = {
    name,
    calls: [],
    busy: false,
    overlapped: 0,
    stopped: false,
    async send(action) {
      if (fake.stopped) throw Object.assign(Error("Desktop input disconnected."), { status: 403 });
      if (fake.busy) {
        fake.overlapped++;
        throw Object.assign(Error("Wait for the previous desktop action."), { status: 429 });
      }
      fake.busy = true;
      fake.calls.push(action);
      try {
        if (slow[action.type]) await new Promise((r) => setTimeout(r, slow[action.type]));
        return answers[action.type]?.(action) ?? { ok: true };
      } finally {
        fake.busy = false;
      }
    },
    stop() {
      fake.stopped = true;
    },
  };
  return fake;
};
const context = () => ({ app: { name: "Notes", bundle: "com.apple.Notes" }, stamp: "s1", items: [] });

function connect({ input = helper("input"), scanner = helper("scanner", {}, { fields: () => ({ fields: [] }), context }) } = {}) {
  const control = new ScreenControl();
  control.acquire(owner, true);
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close(code) {
      this.readyState = 2;
      this.closedWith = code;
    },
  });
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => owner },
    control,
    create: async () => input,
    scanner: scanner ? async () => scanner : null,
  });
  const message = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  message({ type: "auth", token: "T", display: "primary" });
  let id = 0;
  const send = (action) => message({ type: "input", id: ++id, action });
  const ack = (n) => ws.sent.find((m) => m.type === "ack" && m.id === n);
  const end = () => {
    ws.readyState = 3;
    ws.emit("close", 1000);
  };
  return { ws, input, scanner, send, ack, end };
}

test("a slow app-in-front read runs on the scanner: clicks and keys behind it aren't held up", async () => {
  const c = connect({ scanner: helper("scanner", { context: 1500 }, { fields: () => ({ fields: [] }), context }) });
  await until(() => c.ws.sent.some((m) => m.type === "ready") && c.scanner.calls.length > 0);
  await until(() => !c.scanner.busy);
  c.send({ type: "context" }); // 1: a menu rebuild, 1.5 s
  c.send({ type: "click", x: 0.5, y: 0.5 }); // 2
  c.send({ type: "key", key: "a" }); // 3
  c.send({ type: "text", text: "hello" }); // 4
  await until(() => c.ack(4));
  for (const n of [2, 3, 4]) assert.equal(c.ack(n).ok, true, `${n} ran at once`);
  assert.equal(c.ack(1), undefined, "the read is still going");
  await until(() => c.ack(1), 3000);
  assert.deepEqual(c.ack(1), { type: "ack", id: 1, ...context() });
  assert.equal(c.input.calls.some((a) => a.type === "context"), false, "never on the input helper");
  assert.deepEqual(c.input.calls.map((a) => a.type), ["heartbeat", "click", "key", "text"]);
  assert.equal(c.ws.readyState, 1);
  c.end();
});

test("reads and field scans share the scanner one at a time; a menu press and a probe stay with the input helper", async () => {
  const c = connect({ scanner: helper("scanner", { fields: 120, context: 60 }, { fields: () => ({ fields: [] }), context }) });
  await until(() => c.ws.sent.some((m) => m.type === "ready") && c.scanner.calls.length > 0);
  // A scan is running; taps ask for more scans; reads come in meanwhile.
  c.send({ type: "click", x: 0.1, y: 0.1 }); // 1
  c.send({ type: "context" }); // 2
  c.send({ type: "context", since: "s1" }); // 3
  c.send({ type: "menu", path: ["File", "New"] }); // 4
  c.send({ type: "probe", x: 0.4, y: 0.4 }); // 5
  await until(() => [2, 3, 4, 5].every((n) => c.ack(n)));
  await new Promise((r) => setTimeout(r, 400)); // the click's rescan
  assert.equal(c.scanner.overlapped, 0, "never two requests at once");
  assert.equal(c.ack(2).ok, undefined);
  assert.equal(c.ack(2).stamp, "s1");
  assert.deepEqual(
    c.scanner.calls.filter((a) => a.type === "context"),
    [{ type: "context" }, { type: "context", since: "s1" }],
  );
  assert.ok(c.scanner.calls.some((a) => a.type === "fields"));
  assert.deepEqual(c.input.calls.map((a) => a.type), ["heartbeat", "click", "menu", "probe"]);
  assert.equal(c.scanner.calls.some((a) => ["menu", "probe", "click"].includes(a.type)), false);
  c.end();
});

test("a failed read costs only that read; with no scanner (or a stopped one) the input helper reads", async () => {
  const failing = helper("scanner", {}, {
    fields: () => ({ fields: [] }),
    context: () => {
      throw Object.assign(Error("No app is in front."), { status: 403 });
    },
  });
  const c = connect({ scanner: failing });
  await until(() => c.ws.sent.some((m) => m.type === "ready") && failing.calls.length > 0);
  c.send({ type: "context" });
  await until(() => c.ack(1));
  assert.deepEqual(c.ack(1), { type: "ack", id: 1, ok: false, error: "No app is in front." });
  assert.equal(c.ws.readyState, 1, "control stays");
  // The scanner gone (its process ended): the input helper answers.
  failing.stop();
  c.send({ type: "context" });
  await until(() => c.ack(2));
  assert.equal(c.ack(2).ok, true);
  assert.deepEqual(c.input.calls.at(-1), { type: "context" });
  c.end();
  const plain = connect({ scanner: null });
  await until(() => plain.ws.sent.some((m) => m.type === "ready"));
  plain.send({ type: "context" });
  await until(() => plain.ack(1));
  assert.deepEqual(plain.input.calls.map((a) => a.type), ["heartbeat", "context"]);
  plain.end();
});

test("a read on the scanner still needs control, and counts in the phone's input window", async () => {
  const c = connect({ scanner: helper("scanner", { context: 300 }, { fields: () => ({ fields: [] }), context }) });
  await until(() => c.ws.sent.some((m) => m.type === "ready") && c.scanner.calls.length > 0);
  await until(() => !c.scanner.busy);
  for (let n = 0; n < 8; n++) c.send({ type: "context" });
  // A ninth in flight is past the window the phone was given (8).
  c.send({ type: "context" });
  await until(() => c.ws.closedWith !== undefined);
  assert.equal(c.ws.closedWith, 4001);
  c.end();
  // Control off (the lease gone): the read is refused and control ends.
  const d = connect();
  await until(() => d.ws.sent.some((m) => m.type === "ready") && d.scanner.calls.length > 0);
  d.ws.parkControl();
  d.send({ type: "context" });
  await until(() => d.ack(1));
  assert.deepEqual(d.ack(1), { type: "ack", id: 1, ok: false, error: "Desktop control is off." });
  assert.equal(d.scanner.calls.some((a) => a.type === "context"), false);
  d.end();
});
