import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import { RemoteBroadcast } from "../server/remote-screen.mjs";
const source = await fs.readFile(
  new URL("../src/desktop-input-queue.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { DesktopInputQueue } = await import(
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
