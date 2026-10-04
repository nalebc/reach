import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import {
  NativeScreenSource,
  ScreenBroadcast,
} from "../server/screen-stream.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail("Timed out waiting for stream state");
}

test("native frame pipe handles split packets and reuses one capture process", async () => {
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    `let n=0;process.stdin.on('data',()=>{const b=Buffer.from('frame-'+(++n));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(h.subarray(0,2));setTimeout(()=>{process.stdout.write(h.subarray(2));process.stdout.write(b);},5);});`,
  ]);
  try {
    assert.equal((await source.next()).toString(), "frame-1");
    assert.equal((await source.next()).toString(), "frame-2");
  } finally {
    source.stop();
  }
  await assert.rejects(source.next(), /stopped/);
});

test("native frame pipe rejects oversized input before buffering a frame", async () => {
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    `process.stdin.on('data',()=>process.stdout.write(Buffer.from([255,255,255,255])));`,
  ]);
  try {
    await assert.rejects(source.next(), /Invalid screen frame/);
  } finally {
    source.stop();
  }
});

test("disconnect while preparing the helper never starts screen capture", async () => {
  let finish;
  let starts = 0;
  const prepare = new Promise((r) => (finish = r));
  const broadcast = new ScreenBroadcast(() => prepare);
  const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  broadcast.add(ws, () => true);
  broadcast.remove(ws);
  finish(() => {
    starts++;
    return { next: async () => Buffer.from("fixture"), stop() {} };
  });
  await sleep(20);
  assert.equal(starts, 0);
});

test(
  "screen stream enforces auth, scope, enablement, backpressure, revocation and shutdown",
  { timeout: 15000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-live-test-"));
    let starts = 0,
      stops = 0,
      captures = 0;
    const reach = await createReach({
      roots: [root],
      dataDir: path.join(root, ".reach"),
      port: 0,
      screenStreamFactory: async () => () => {
        starts++;
        return {
          next: async () => Buffer.from(`synthetic-${++captures}`),
          stop: () => {
            stops++;
          },
        };
      },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("owner", ALL_SCOPES);
    const other = reach.auth.issue("other", ALL_SCOPES);
    const files = reach.auth.issue("files", ["files"], "agent");
    const viewer = reach.auth.issue("screen viewer", ["screen"], "agent");
    const sockets = [];
    const connect = async (token) => {
      const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen");
      sockets.push(ws);
      const frames = [],
        messages = [];
      ws.on("message", (b, binary) => {
        if (binary) frames.push(b);
        else messages.push(JSON.parse(b));
      });
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token }));
      return { ws, frames, messages };
    };
    const settings = async (screen) => {
      const res = await fetch(url + "/api/settings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ screen }),
      });
      assert.equal(res.status, 200);
    };
    try {
      await t.test("denied viewers never start a native capture", async () => {
        for (const token of ["invalid", files.token, owner.token]) {
          const s = await connect(token);
          await until(() => s.messages.some((m) => m.type === "error"));
          assert.equal(s.frames.length, 0);
        }
        assert.equal(starts, 0);
      });
      await t.test(
        "host, origin and Funnel protections apply to the stream",
        async () => {
          for (const headers of [
            { Origin: "https://hostile.invalid" },
            { "Tailscale-Funnel-Request": "1" },
            { Host: "hostile.invalid" },
          ]) {
            const ws = new WebSocket(
              url.replace("http:", "ws:") + "/ws/screen",
              { headers },
            );
            sockets.push(ws);
            await new Promise((resolve) => ws.once("error", resolve));
            assert.notEqual(ws.readyState, WebSocket.OPEN);
          }
          assert.equal(starts, 0);
        },
      );
      await settings(true);
      const a = await connect(owner.token);
      await until(() => a.frames.length === 1);
      const b = await connect(viewer.token);
      await until(() => b.frames.length === 1);
      await t.test(
        "viewers share capture and slow phones do not accumulate frames",
        async () => {
          assert.equal(starts, 1);
          await sleep(160);
          assert.equal(a.frames.length, 1);
          assert.equal(b.frames.length, 1);
          a.ws.send(JSON.stringify({ type: "ack" }));
          await until(() => a.frames.length === 2);
          assert.equal(b.frames.length, 1);
          assert.equal(a.messages[0].fps, 15);
        },
      );
      await t.test(
        "turning viewing off closes all viewers and stops the helper",
        async () => {
          await settings(false);
          await until(
            () =>
              a.ws.readyState === WebSocket.CLOSED &&
              b.ws.readyState === WebSocket.CLOSED,
          );
          assert.equal(stops, 1);
        },
      );
      await settings(true);
      const c = await connect(other.token);
      await until(() => c.frames.length === 1);
      await t.test("revoking access ends the stream and capture", async () => {
        const res = await fetch(url + "/api/clients/" + other.clientId, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${owner.token}` },
        });
        assert.equal(res.status, 200);
        await until(() => c.ws.readyState === WebSocket.CLOSED);
        assert.equal(stops, 2);
      });
      const d = await connect(owner.token);
      await until(() => d.frames.length === 1);
      await t.test(
        "disconnecting the last phone releases native capture",
        async () => {
          d.ws.close();
          await until(() => stops === 3);
        },
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("revoking access during capture discards the in-flight frame", async () => {
  let complete;
  let allowed = true;
  let stopped = 0;
  const sent = [];
  const source = {
    next: () => new Promise((r) => (complete = r)),
    stop: () => stopped++,
  };
  const broadcast = new ScreenBroadcast(async () => () => source);
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (b) => sent.push(b),
    close() {},
  };
  broadcast.add(ws, () => allowed);
  await until(() => !!complete);
  allowed = false;
  complete(Buffer.from("must not leave the host"));
  await until(() => stopped === 1);
  assert.equal(sent.length, 0);
});
