import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// The sound's own connection through a real Reach: who may listen, from
// where, and what pausing and turning the screen off do. The capture is a
// stand-in: nothing is recorded.
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`Timed out: ${check}`);
    await delay(10);
  }
}

test("only you and people with full access hear the computer, from another device, while its screen may be watched", { timeout: 20000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-sound-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sources = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    soundFactory: async () => (handlers) => {
      const source = { handlers, info: { rate: 48000, channels: 2 }, stopped: null, stop: (e) => (source.stopped = e) };
      sources.push(source);
      setImmediate(() => handlers.onInfo(source.info));
      return source;
    },
  });
  t.after(() => reach.close());
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const full = reach.auth.redeemGuest(reach.auth.inviteGuest({ name: "Full", ttlSeconds: 600, full: true, fullControlVersion: 1 }).invitation);
  const limited = reach.auth.redeemGuest(reach.auth.inviteGuest({ name: "Watcher", ttlSeconds: 600, screen: "control" }).invitation);
  const agent = reach.auth.issue("agent", ["screen"], "agent");
  const sockets = [];
  // A phone, as Tailscale Serve hands it over: its own address forwarded.
  const listen = async (token, { from = "100.101.102.103", codecs = ["adpcm"] } = {}) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen-sound", from ? { headers: { "x-forwarded-for": from } } : {});
    sockets.push(ws);
    const messages = [];
    ws.on("error", () => {});
    ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token, codecs }));
    return { ws, messages, error: () => messages.find((m) => m.type === "error") };
  };
  const play = () => {
    const samples = new Int16Array(1920).map((_, i) => (i % 50) * 100);
    sources.at(-1)?.handlers.onSamples(samples, sources.at(-1).info);
  };
  try {
    const you = await listen(owner.token);
    await until(() => you.messages.some((m) => m.type === "ready"));
    play();
    await until(() => you.messages.some(Buffer.isBuffer));
    const packet = you.messages.find(Buffer.isBuffer);
    assert.deepEqual([packet[0], packet[1], packet[2], packet.readUInt32LE(4)], [1, 1, 2, 48000]);
    you.ws.send(JSON.stringify({ type: "ack", seq: packet.readUInt32LE(8) }));

    const person = await listen(full.token);
    await until(() => person.messages.some((m) => m.type === "ready"));
    assert.equal(sources.length, 1, "one capture for both");

    for (const [who, token] of [["a person with less access", limited.token], ["an agent", agent.token]]) {
      const refused = await listen(token);
      await until(() => refused.ws.readyState === 3);
      assert.deepEqual(
        [refused.error()?.status, refused.error()?.retryable],
        [403, false],
        `${who}: ${JSON.stringify(refused.messages)}`,
      );
      assert.match(refused.error().error, /owner and people with full access/);
    }
    // A browser on the computer itself would play it into what it captures.
    const here = await listen(owner.token, { from: null });
    await until(() => here.ws.readyState === 3);
    assert.match(here.error().error, /not on this computer itself/);
    const old = await listen(owner.token, { codecs: [] });
    await until(() => old.ws.readyState === 3);
    assert.equal(old.error().status, 400);

    // Pausing: every phone's sound ends for a while, and the capture too.
    await reach.setPaused(true);
    await until(() => you.ws.readyState === 3 && person.ws.readyState === 3);
    assert.deepEqual([you.error().retryable, /paused/.test(you.error().error)], [true, true]);
    assert.ok(sources[0].stopped, "the capture stopped");
    const whilePaused = await listen(owner.token);
    await until(() => whilePaused.ws.readyState === 3);
    assert.equal(whilePaused.error().status, 423);
    await reach.setPaused(false);

    // Screen viewing turned off ends it too, and refuses it after.
    const again = await listen(owner.token);
    await until(() => again.messages.some((m) => m.type === "ready"));
    const off = await fetch(url + "/api/settings", {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ screen: false }),
    });
    assert.equal(off.status, 200);
    await until(() => again.ws.readyState === 3);
    assert.ok(sources.at(-1).stopped);
    const refused = await listen(owner.token);
    await until(() => refused.ws.readyState === 3);
    assert.match(refused.error().error, /Turn on screen viewing/);

    // What the phone is told it can do.
    const device = await (await fetch(url + "/api/device", { headers: { Authorization: `Bearer ${owner.token}` } })).json();
    assert.equal(device.capabilities.sound, false, "screen off: no sound");
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});
