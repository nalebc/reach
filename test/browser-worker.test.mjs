import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BrowserWorker } from "../server/browser-worker.mjs";
import { createToolBrowserDriver } from "../server/tool-browser-driver.mjs";

function fake() {
  const child = new EventEmitter(); child.pid = 42;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.kill = signal => { child.kills.push(signal); };
  const writes = []; child.stdin.on("data", chunk => writes.push(chunk.toString()));
  const worker = new BrowserWorker("unused", [], { spawnProcess: () => child });
  return { child, worker, writes };
}

test("warm worker serializes requests and preserves UTF-8 across chunks", async () => {
  const { worker, child, writes } = fake();
  const first = worker.request('{"op":1}'), second = worker.request('{"op":2}');
  assert.equal(writes.length, 1);
  const reply = Buffer.from('{"text":"café"}\n');
  const cut = reply.indexOf(Buffer.from("é")) + 1;
  child.stdout.write(reply.subarray(0, cut)); child.stdout.write(reply.subarray(cut));
  assert.equal(JSON.parse(await first).text, "café");
  assert.equal(writes.length, 2);
  child.stdout.write('{"ok":true}\n'); assert.equal(JSON.parse(await second).ok, true);
  worker.stop(); child.emit("close");
});

test("cancellation waits for process exit and never dispatches queued input", async () => {
  const { worker, child, writes } = fake();
  const abort = new AbortController();
  const first = worker.request('{"op":1}', { signal: abort.signal });
  const second = worker.request('{"op":2}');
  let settled = false; first.catch(() => { settled = true; }); second.catch(() => {});
  abort.abort(); await new Promise(resolve => setImmediate(resolve));
  child.stdout.write('{"ok":true}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.deepEqual(child.kills, ["SIGTERM"]); assert.equal(writes.length, 1);
  child.emit("close");
  await assert.rejects(first, error => error.code === "cancelled" && error.uncertain === true);
  await assert.rejects(second, error => error.uncertain === false);
});

test("driver reuses a worker, with each request retaining its exact browser target", async () => {
  const requests = []; let workers = 0;
  const driver = createToolBrowserDriver({ platform: "darwin", persistent: true, workerFactory: () => {
    workers++; return { request: async input => { requests.push(JSON.parse(input)); return '{"ok":true}'; }, stop() {} };
  } });
  await driver.transport("Chrome", { op: "tabs" });
  await driver.transport("Chrome", { op: "info", target: { window: 1, tab: 2 } });
  assert.equal(workers, 1); assert.deepEqual(requests[1].target, { window: 1, tab: 2 }); driver.close();
});
