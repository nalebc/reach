import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentDesktopHelper } from "../server/agent-desktop.mjs";
import { agentErrorDetails } from "../server/agent-transport.mjs";

const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
function inert(t) {
  // A protocol stand-in only: no process is started and no input is posted.
  const child = new EventEmitter(), writes = [];
  child.pid = 123456789; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = line => { writes.push(JSON.parse(line)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit("exit", 0); };
  child.kill = () => assert.fail("the inert child already exited");
  const helper = new AgentDesktopHelper(child);
  t.after(() => helper.stop());
  return { child, helper, writes, reply: line => child.stdout.emit("data", Buffer.from(line + "\n")) };
}
function diagnostic(error, reason, op, dispatch) {
  assert.equal(error.status, 503);
  assert.equal(error.kind, "unavailable");
  assert.equal(error.helperReason, reason);
  assert.equal(error.helperOperation, op);
  assert.equal(error.helperDispatch, dispatch);
  assert.match(error.message, /Check the screen before trying again/);
  assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
  assert.equal(error.message.includes("PRIVATE"), false);
}
for (const [reason, trigger] of [
  ["process_exit", w => { w.child.exitCode = 99; w.child.emit("exit", 99, "PRIVATE-SIGNAL"); }],
  ["process_error", w => w.child.emit("error", Error("PRIVATE-process-path"))],
  ["stdin_error", w => w.child.stdin.emit("error", Error("PRIVATE-stdin-path"))],
  ["invalid_reply", w => w.reply("PRIVATE-not-json")],
  ["invalid_reply", w => w.reply('{"ok":false,"error":"PRIVATE-message","kind":"PRIVATE-kind"}')],
  ["oversized_reply", w => w.child.stdout.emit("data", Buffer.alloc(12 * 1024 * 1024 + 1, 120))],
  ["stopped", w => w.helper.stop()],
]) {
  test(`helper ${reason} distinguishes in-flight input from its undispatched queue`, async t => {
    const w = inert(t);
    const active = outcome(w.helper.send({ op: "act", action: { type: "type", text: "PRIVATE-text" } }));
    const queued = outcome(w.helper.send({ op: "open", app: "/PRIVATE-path.app" }, () => assert.fail("queue must not dispatch")));
    w.child.stderr.emit("data", Buffer.from("PRIVATE-stderr"));
    trigger(w);
    diagnostic((await active).error, reason, "act", "completion_unknown");
    diagnostic((await queued).error, reason, "open", "not_dispatched");
    assert.equal(w.writes.length, 1, "no automatic retry or queued action");
    const later = await outcome(w.helper.send({ op: "PRIVATE-operation" }));
    diagnostic(later.error, reason, "unknown", "not_dispatched");
    await w.helper.terminated;
  });
}

test("helper timeout diagnostics preserve the startup operation and 503, not a permission refusal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = inert(t);
  const ready = outcome(w.helper.send({ op: "rules", privatePath: "PRIVATE-rules-path" }));
  const queued = outcome(w.helper.send({ op: "act" }));
  t.mock.timers.tick(15000);
  diagnostic((await ready).error, "timeout", "rules", "completion_unknown");
  diagnostic((await queued).error, "timeout", "act", "not_dispatched");
  assert.deepEqual(w.writes.map(item => item.op), ["rules"]);
});

test("navigation helper failures retain their operation and dispatch state across the transport boundary", async t => {
  for (const op of ["elements", "open-url", "browser-check", "windows", "focus", "menus", "find", "read", "open-file", "displays", "wait-change"]) {
    const w = inert(t);
    const active = outcome(w.helper.send({ op, privatePath: "/PRIVATE" }));
    const queued = outcome(w.helper.send({ op }));
    w.child.emit("exit", 99);
    for (const [request, dispatch] of [[active, "completion_unknown"], [queued, "not_dispatched"]]) {
      const { error } = await request;
      diagnostic(error, "process_exit", op, dispatch);
      assert.deepEqual(agentErrorDetails(error), { error: error.message, status: 503, kind: "unavailable", helperReason: "process_exit", helperOperation: op, helperDispatch: dispatch });
    }
    assert.equal(w.writes.length, 1);
  }
});

test("serialization and stdin write failures report dispatch conservatively without retrying", async t => {
  const serial = inert(t);
  const request = { op: "act", text: "PRIVATE-text" }; request.cycle = request;
  diagnostic((await outcome(serial.helper.send(request))).error, "write_error", "act", "not_dispatched");
  assert.equal(serial.writes.length, 0);
  const write = inert(t);
  let attempts = 0;
  write.child.stdin.write = () => { attempts++; throw Error("PRIVATE-write-path"); };
  diagnostic((await outcome(write.helper.send({ op: "act" }))).error, "write_error", "act", "completion_unknown");
  assert.equal(attempts, 1);
});

test("unsolicited native replies end the helper and cannot become a future request's result", async t => {
  const w = inert(t);
  w.reply('{"ok":true,"app":"PRIVATE-old-app"}');
  diagnostic((await outcome(w.helper.send({ op: "front" }))).error, "unexpected_reply", "front", "not_dispatched");
  assert.deepEqual(w.writes, []);
});

test("valid native refusals and dispatch authorization retain their original semantics", async t => {
  const w = inert(t);
  const read = w.helper.send({ op: "front" });
  const denied = Object.assign(Error("Access ended."), { status: 401 });
  const queued = outcome(w.helper.send({ op: "act" }, () => { throw denied; }));
  const allowed = w.helper.send({ op: "front" });
  w.reply('{"kind":"blocked","error":"A protected app."}');
  assert.deepEqual(await read, { kind: "blocked", error: "A protected app." });
  assert.equal((await queued).error, denied);
  assert.deepEqual(w.writes.map(item => item.op), ["front", "front"]);
  w.reply('{"ok":true,"app":"Synthetic"}');
  assert.equal((await allowed).app, "Synthetic");
  assert.equal(w.helper.stopped, false);
});
