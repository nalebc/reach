import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
import { RemoteBroadcast } from "../server/remote-screen.mjs";
const source = await fs.readFile(
  new URL("../src/desktop-input-queue.ts", import.meta.url),
  "utf8",
);
const outputText = transpile(source);
const { DesktopInputQueue, isInputReconnect, mergeTyping } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("eight-slot input pipeline hides simulated network RTT without reordering keys", async () => {
  async function simulate(window) {
    let now = 0;
    const arrivals = [],
      sent = [];
    const queue = new DesktopInputQueue(
      (id, action) => {
        arrivals.push({ id, at: now + 80 });
        sent.push(action.key);
      },
      (m) => assert.fail(m),
      window,
      () => now,
    );
    const pending = Array.from({ length: 24 }, (_, i) =>
      queue.enqueue({ type: "key", key: String(i) }),
    );
    assert.equal(arrivals.length, window);
    while (arrivals.length) {
      const item = arrivals.shift();
      now = item.at;
      queue.acknowledge(item.id, { ok: true });
    }
    await Promise.all(pending);
    queue.close();
    assert.deepEqual(
      sent,
      Array.from({ length: 24 }, (_, i) => String(i)),
    );
    return now;
  }
  // Keep the comparison within the queue's stale-action bound: 8 commands at a time.
  const pipelined = await simulate(8);
  assert.equal(pipelined, 240);
  assert.ok(pipelined < (24 * 80) / 4);
});
test("motion coalesces behind the bounded window but preserves down/move/up order", async () => {
  let now = 0;
  const sent = [];
  const queue = new DesktopInputQueue(
    (id, action) => sent.push({ id, action }),
    (m) => assert.fail(m),
    1,
    () => now,
  );
  const promises = [queue.enqueue({ type: "down", x: 0, y: 0 })];
  for (let i = 1; i <= 100; i++) {
    now += 16;
    promises.push(queue.enqueue({ type: "move", x: i / 100, y: 0 }));
  }
  promises.push(queue.enqueue({ type: "up", x: 1, y: 0 }));
  assert.equal(sent.length, 1);
  queue.acknowledge(1, { ok: true });
  queue.acknowledge(2, { ok: true });
  queue.acknowledge(3, { ok: true });
  await Promise.all(promises);
  queue.close();
  assert.deepEqual(
    sent.map((s) => s.action.type),
    ["down", "move", "up"],
  );
  assert.equal(sent[1].action.x, 1);
});

test("stopping a fling discards unsent scrolls on a slow link while preserving taps and release order", async () => {
  let now = 0;
  const sent = [], failures = [];
  const queue = new DesktopInputQueue((id, action) => sent.push({ id, action }), (line) => failures.push(line), 1, () => now);
  const first = queue.enqueue({ type: "heartbeat" });
  now += 16;
  const scroll = queue.enqueue({ type: "scroll", dx: 0, dy: -100 });
  const click = { type: "click", x: 0.3, y: 0.4, button: "left", count: 1 };
  const tap = queue.enqueue(click);
  const release = queue.enqueue({ type: "release" });
  const laterScroll = queue.enqueue({ type: "scroll", dx: 0, dy: -80 });
  const cancelled = { type: "scroll", dx: 0, dy: 0, phase: "cancelled" };
  const stop = queue.enqueue(cancelled);
  assert.deepEqual(await scroll, { ok: true, skipped: true });
  assert.deepEqual(await laterScroll, { ok: true, skipped: true });
  now += 16;
  for (let id = 1; id <= 4; id++) queue.acknowledge(id, { ok: true });
  await Promise.all([first, tap, release, stop]);
  assert.deepEqual(sent.map((item) => item.action), [{ type: "heartbeat" }, click, { type: "release" }, cancelled]);
  assert.deepEqual(failures, []);
  queue.close();
});
test("disconnect rejects queued and in-flight input without sending more actions", async () => {
  const sent = [];
  const queue = new DesktopInputQueue(
    (id) => sent.push(id),
    () => {},
    2,
  );
  const results = Array.from({ length: 4 }, () =>
    queue.enqueue({ type: "key", key: "a" }).catch((e) => e.message),
  );
  queue.close();
  assert.equal(sent.length, 2);
  assert.ok(
    (await Promise.all(results)).every((x) => x === "Desktop control ended."),
  );
});
test("only a transient connection end marks rejected input; only never-transmitted pieces are notSent", async () => {
  for (const reconnecting of [false, true]) {
    const sent = [];
    const queue = new DesktopInputQueue((id, action) => sent.push({ id, action }), () => {}, 1);
    const first = queue.enqueue({ type: "type-edit", delete: 0, text: "ab", focus: "old" }).catch(e => e);
    const second = queue.enqueue({ type: "type-edit", delete: 0, text: "cd", focus: "old" }).catch(e => e);
    queue.close(reconnecting);
    const [unknown, unsent] = await Promise.all([first, second]);
    assert.equal(isInputReconnect(unknown), reconnecting);
    assert.equal(isInputReconnect(unsent), reconnecting);
    assert.equal(unknown.notSent, undefined, "transmitted ab has an unknown delivery outcome");
    assert.equal(unsent.notSent, true, "only cd remained wholly inside the queue");
    const later = await queue.enqueue({ type: "text", text: "later" }).catch(e => e);
    assert.equal(later.notSent, true);
    assert.equal(isInputReconnect(later), reconnecting);
    assert.deepEqual(sent.map(item => item.action.text), ["ab"]);
  }
});
test("input the socket refused to transmit is notSent, never an unknown delivery", async () => {
  // The browser's socket is already closing (the computer closed it first):
  // the hook refuses to hand it anything, so that action never left.
  const sent = [], failures = [];
  let open = true;
  const queue = new DesktopInputQueue((id, action) => {
    if (!open) throw Error("Desktop input disconnected.");
    sent.push({ id, action });
  }, (line) => { failures.push(line); queue.close(true); }, 2);
  const delivered = queue.enqueue({ type: "type-edit", delete: 0, text: "ab", focus: "old" }).catch(e => e);
  open = false;
  const refused = queue.enqueue({ type: "type-edit", delete: 0, text: "cd", focus: "old" }).catch(e => e);
  const after = queue.enqueue({ type: "key", key: "enter", modifiers: [] }).catch(e => e);
  const [unknown, unsent, later] = await Promise.all([delivered, refused, after]);
  assert.deepEqual(sent.map(item => item.action.text), ["ab"]);
  assert.equal(unknown.notSent, undefined, "ab left: its outcome stays unknown");
  assert.equal(unsent.notSent, true, "cd was never transmitted");
  assert.equal(isInputReconnect(unsent), true);
  assert.equal(later.notSent, true);
  assert.equal(failures.length, 1);
});

test("a host typing refusal cannot copy local reconnect or notSent markers", async () => {
  const queue = new DesktopInputQueue(() => {}, () => {}, 1);
  const refused = queue.enqueue({ type: "text", text: "refused" }).catch(e => e);
  queue.acknowledge(1, { ok: false, error: "Field refused typing", inputReconnect: true, notSent: true });
  const error = await refused;
  assert.equal(error.message, "Field refused typing");
  assert.equal(isInputReconnect(error), false);
  assert.equal(error.notSent, undefined);
  queue.close();
});
test("merged never-transmitted edits retain their producer order without retaining the unknown first chunk", async () => {
  const transmitted = [], retained = [];
  const queue = new DesktopInputQueue((id, action) => transmitted.push(action), () => {}, 1);
  const produce = action => queue.enqueue(action).catch(error => {
    if (isInputReconnect(error) && error.notSent) retained.push(action);
  });
  const actions = [
    { type: "type-edit", delete: 0, text: "ab", focus: "old" },
    { type: "type-edit", delete: 0, text: "cd", focus: "old" },
    { type: "type-edit", delete: 0, text: "ef", focus: "old" },
    { type: "type-edit", delete: 1, text: "g", focus: "old" },
  ];
  const pending = actions.map(produce);
  queue.close(true);
  await Promise.all(pending);
  assert.deepEqual(transmitted, actions.slice(0, 1));
  assert.deepEqual(retained, actions.slice(1));
  assert.deepEqual(retained.slice(1).reduce(mergeTyping, retained[0]), {
    type: "type-edit", delete: 0, text: "cdeg", focus: "old",
  });
});
test("automatic video backs off congestion without reconnecting its source", async () => {
  let broadcaster;
  const bitrates = [];
  let stopped = false;
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(packet) {
      queueMicrotask(() => {
        if (Buffer.isBuffer(packet)) broadcaster.ack(ws, packet.readUInt32BE());
      });
    },
    close() {
      this.readyState = 3;
    },
  };
  broadcaster = new RemoteBroadcast(
    async () => () => ({
      next: async () => Buffer.from("frame"),
      setBitrate: (n) => bitrates.push(n),
      stop() {
        stopped = true;
      },
    }),
    { quality: "auto", fps: 60, bitrate: 4000000 },
  );
  broadcaster.add(ws, () => true);
  await sleep(25);
  broadcaster.viewers.get(ws).blocked = true;
  broadcaster.adjustedAt = Date.now() - 1100;
  await sleep(50);
  assert.equal(bitrates[0], 3000000);
  assert.equal(broadcaster.pacing, 48);
  assert.equal(stopped, false);
  broadcaster.remove(ws);
  assert.equal(stopped, true);
});

// "I can no longer scroll … it keeps flipping control off" (2026-10-06): a
// scroll sent a move and a scroll for each finger movement; the two never
// merged, the queue filled in half a second, and control ended.
test("moves and scrolls arriving in turns on a slow link merge instead of filling the queue", async () => {
  let now = 0;
  const sent = [];
  const failures = [];
  const queue = new DesktopInputQueue((id, action) => sent.push({ id, action }), (m) => failures.push(m), 1, () => now);
  const done = [];
  for (let i = 0; i < 200; i++) {
    now += 8;
    done.push(queue.enqueue({ type: "move", x: 0.5, y: 0.5 }));
    done.push(queue.enqueue({ type: "scroll", dx: 0, dy: -1 }));
  }
  assert.deepEqual(failures, [], "control stays on");
  assert.ok(sent.length <= 3, `sent ${sent.length} while the first was unanswered`);
  queue.close();
  await Promise.allSettled(done);
});

test("a move or scroll that waited too long is let go; a late click still ends control", async () => {
  let now = 0;
  const failures = [];
  const queue = new DesktopInputQueue(() => {}, (m) => failures.push(m), 1, () => now);
  void queue.enqueue({ type: "heartbeat" }).catch(() => {});
  const late = queue.enqueue({ type: "scroll", dx: 0, dy: -5 });
  now += 1500;
  queue.acknowledge(1, { ok: true });
  assert.deepEqual(await late, { ok: true, skipped: true });
  assert.deepEqual(failures, []);
  const click = queue.enqueue({ type: "click", x: 0.5, y: 0.5 }).catch(() => {});
  void queue.enqueue({ type: "click", x: 0.6, y: 0.5 }).catch(() => {});
  now += 1500;
  queue.acknowledge(2, { ok: true });
  assert.match(failures[0] || "", /too slow/);
  queue.close();
  await click;
});

test("an action the computer turned down fails alone; the queue and control go on", async () => {
  const failures = [];
  const queue = new DesktopInputQueue(() => {}, (m) => failures.push(m), 8, () => 0);
  const typed = queue.enqueue({ type: "text", text: "hi" });
  const next = queue.enqueue({ type: "key", key: "enter" });
  queue.acknowledge(1, { ok: false, error: "The typing target changed. Tap the text field again." });
  await assert.rejects(typed, /typing target changed/);
  queue.acknowledge(2, { ok: true });
  assert.deepEqual(await next, { ok: true });
  assert.deepEqual(failures, []);
  queue.close();
});
