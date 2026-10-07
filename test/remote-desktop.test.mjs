import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { inputAction, streamOptions } from "../server/desktop-protocol.mjs";
import { RemoteBroadcast } from "../server/remote-screen.mjs";
import { AnnexBFrames } from "../server/windows-video.mjs";
import { NativeScreenSource } from "../server/screen-stream.mjs";
import ts from "typescript";
const source = await fs.readFile(
  new URL("../src/desktop-geometry.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { boundView, pinchView } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for state");
}
test("desktop protocol rejects invalid actions, injection, oversized clipboard and invalid displays", () => {
  for (const value of [
    null,
    {},
    { type: "down", x: NaN, y: 0 },
    { type: "up", x: 1.01, y: 0 },
    { type: "move", x: 0, y: 0, button: "middle" },
    { type: "key", key: "c", modifiers: ["arbitrary"] },
    { type: "key", key: "c", modifiers: ["meta", "meta"] },
    { type: "clipboard-write", text: "x".repeat(16385) },
    { type: "scroll", dx: Infinity, dy: 0 },
    { type: "shell", command: "whoami" },
  ])
    assert.throws(() => inputAction(value));
  assert.deepEqual(
    inputAction({
      type: "key",
      key: "c",
      modifiers: ["meta"],
      command: "ignored",
    }),
    { type: "key", key: "c", modifiers: ["meta"] },
  );
  assert.deepEqual(inputAction({ type: "down", x: 0, y: 1 }), {
    type: "down",
    x: 0,
    y: 1,
    button: "left",
    count: 1,
  });
  for (const display of ["../file", "--list", "DISPLAY1;echo", "-1"])
    assert.throws(() => streamOptions({ display }));
  assert.equal(streamOptions({ quality: "smooth" }).fps, 60);
  assert.throws(() => streamOptions({ quality: "unbounded" }));
});
test("pinch keeps the touched desktop point anchored and clamps pan/zoom", () => {
  assert.deepEqual(
    pinchView(
      { scale: 1, x: 0, y: 0 },
      { x: 400, y: 225 },
      { x: 400, y: 225 },
      2,
      800,
      450,
      800,
      450,
    ),
    { scale: 2, x: 0, y: 0 },
  );
  assert.deepEqual(
    pinchView(
      { scale: 1, x: 0, y: 0 },
      { x: 600, y: 112.5 },
      { x: 600, y: 112.5 },
      2,
      800,
      450,
      800,
      450,
    ),
    { scale: 2, x: -200, y: 112.5 },
  );
  assert.deepEqual(boundView(8, 9999, -9999, 800, 450, 800, 450), {
    scale: 4,
    x: 1200,
    y: -675,
  });
  assert.deepEqual(boundView(1, 99, 99, 390, 219.375, 390, 600), {
    scale: 1,
    x: 0,
    y: 0,
  });
});
test("Annex B parser preserves split start codes and complete access units", () => {
  const frames = [],
    parser = new AnnexBFrames((frame) => frames.push(frame));
  const nal = (type, data) => Buffer.from([0, 0, 0, 1, type, ...data]);
  const first = Buffer.concat([
    nal(9, [0xf0]),
    nal(7, [0x42, 0, 31]),
    nal(8, [1]),
    nal(5, [1, 2, 3]),
  ]);
  const second = Buffer.concat([nal(9, [0xf0]), nal(1, [4, 5, 6])]);
  const all = Buffer.concat([
    first,
    second,
    nal(9, [0xf0]),
    nal(1, [9]),
    nal(9, [0]),
  ]);
  for (let i = 0; i < all.length; i += 3) parser.push(all.subarray(i, i + 3));
  assert.deepEqual(frames[0], first);
  assert.deepEqual(frames[1], second);
});
test("video backpressure stays bounded and recovers slow viewers with a keyframe", async () => {
  const commands = [];
  let stopped = false;
  const broadcaster = new RemoteBroadcast(
    async () => () => ({
      next: async (c) => {
        commands.push(c);
        return Buffer.from("video");
      },
      stop: () => {
        stopped = true;
      },
    }),
    { fps: 60 },
  );
  const packets = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (p) => packets.push(p),
    close() {
      this.readyState = 3;
    },
  };
  broadcaster.add(ws, () => true);
  await until(() => packets.length === 6);
  await delay(80);
  assert.equal(packets.length, 6);
  const seq = packets.at(-1).readUInt32BE();
  assert.throws(() => broadcaster.ack(ws, 999));
  broadcaster.ack(ws, seq);
  await until(() => packets.length > 6);
  assert.equal(commands[6], "key");
  broadcaster.remove(ws);
  assert.equal(stopped, true);
});
test(
  "desktop input and video enforce owner leases, guest boundaries, expiry and release",
  { timeout: 20000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-desktop-"));
    const actions = [];
    let stops = 0,
      starts = 0,
      resolveClipboard;
    let delayClipboard = false;
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, "private"),
      screen: true,
      desktopDisplays: async () => [
        {
          id: "42",
          name: "Fixture display",
          primary: true,
          width: 1920,
          height: 1080,
          x: 0,
          y: 0,
        },
      ],
      desktopInputFactory: async () => {
        starts++;
        return {
          send: async (a) => {
            actions.push(a);
            if (a.type === "heartbeat")
              return { ok: true, cursor: { x: 0.2, y: 0.7 } };
            if (a.type === "selection-read")
              return { text: "Selected test text" };
            if (a.type === "focus")
              return {
                target: {
                  editable: true,
                  focus: "fixture-focus",
                  secure: false,
                },
              };
            if (a.type === "clipboard-read" && delayClipboard)
              return new Promise((resolve) => {
                resolveClipboard = resolve;
              });
            return a.type === "clipboard-read"
              ? { text: "fixture clipboard" }
              : { ok: true };
          },
          stop: () => {
            stops++;
          },
        };
      },
      remoteScreenFactory: async () => () => ({
        next: async () => Buffer.from("fixture"),
        stop() {},
      }),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("owner", ALL_SCOPES),
      viewer = reach.auth.issue("viewer", ["screen"], "agent");
    const call = (route, token = owner.token, body) =>
      fetch(url + route, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const sockets = [];
    const connect = async (token, route = "/ws/screen-input", extra = {}) => {
      const ws = new WebSocket(url.replace("http:", "ws:") + route);
      sockets.push(ws);
      const messages = [];
      ws.on("error", () => {});
      ws.on("message", (b, binary) =>
        messages.push(binary ? b : JSON.parse(b)),
      );
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token, display: "42", ...extra }));
      return { ws, messages };
    };
    try {
      await t.test(
        "unauthorized viewers cannot open input or read clipboard",
        async () => {
          const result = await connect(viewer.token);
          await until(() => result.ws.readyState === 3);
          assert.equal(starts, 0);
          const noLease = await connect(owner.token);
          await until(() => noLease.ws.readyState === 3);
          assert.equal(starts, 0);
          assert.equal(
            (await call("/api/screen/displays", viewer.token)).status,
            200,
          );
        },
      );
      await t.test(
        "persistent channel handles drag, modifiers and explicit clipboard and releases on close",
        async () => {
          await call("/api/screen/control", owner.token, { enabled: true });
          const c = await connect(owner.token);
          await until(() => c.messages.some((m) => m.type === "ready"));
          assert.equal(c.messages.find((m) => m.type === "ready").window, 8);
          assert.deepEqual(c.messages.find((m) => m.type === "ready").cursor, {
            x: 0.2,
            y: 0.7,
          });
          const duplicate = await connect(owner.token);
          await until(() => duplicate.ws.readyState === 3);
          assert.equal(c.ws.readyState, 1);
          let id = 0;
          for (const action of [
            { type: "down", x: 0.25, y: 0.5 },
            { type: "move", x: 0.75, y: 0.25 },
            { type: "up", x: 0.75, y: 0.25 },
            { type: "key", key: "c", modifiers: ["meta"] },
            { type: "clipboard-read" },
            { type: "clipboard-write", text: "phone fixture" },
            { type: "selection-read" },
            { type: "focus", x: 0.5, y: 0.5 },
            {
              type: "type-edit",
              focus: "fixture-focus",
              delete: 0,
              text: "hello chat",
            },
            { type: "key", key: "enter", focus: "fixture-focus" },
          ]) {
            c.ws.send(JSON.stringify({ type: "input", id: ++id, action }));
            await until(() =>
              c.messages.some((m) => m.type === "ack" && m.id === id),
            );
          }
          assert.ok(
            c.messages.some((m) => m.target?.focus === "fixture-focus"),
          );
          assert(c.messages.some((m) => m.text === "Selected test text"));
          assert.equal(c.messages.find((m) => m.type === "ready").typing, true);
          assert.equal(starts, 1);
          assert.ok(c.messages.some((m) => m.text === "fixture clipboard"));
          c.ws.close();
          await until(() => stops > 0);
          assert.ok(actions.some((a) => a.type === "up")); // No real OS input in this fixture.
        },
      );
      await t.test(
        "expired owner closes input and stops its helper",
        async () => {
          const temporary = reach.auth.issue("temporary", ALL_SCOPES);
          await call("/api/screen/control", temporary.token, { enabled: true });
          const c = await connect(temporary.token);
          await until(() => c.messages.some((m) => m.type === "ready"));
          const before = stops,
            file = path.join(reach.config.dataDir, "clients.json"),
            clients = JSON.parse(await fs.readFile(file, "utf8"));
          clients.find((x) => x.id === temporary.clientId).expiresAt =
            Date.now() - 1;
          atomicJson(file, clients);
          await until(() => c.ws.readyState === 3);
          assert.ok(stops > before);
        },
      );
      await t.test(
        "revocation discards an in-flight clipboard response",
        async () => {
          const temporary = reach.auth.issue("clipboard owner", ALL_SCOPES);
          await call("/api/screen/control", temporary.token, { enabled: true });
          const c = await connect(temporary.token);
          await until(() => c.messages.some((m) => m.type === "ready"));
          delayClipboard = true;
          c.ws.send(
            JSON.stringify({
              type: "input",
              id: 1,
              action: { type: "clipboard-read" },
            }),
          );
          await until(() => !!resolveClipboard);
          const actionStart = actions.length;
          c.ws.send(
            JSON.stringify({
              type: "input",
              id: 2,
              action: { type: "key", key: "f12" },
            }),
          );
          await delay(20);
          reach.auth.revoke(temporary.clientId);
          resolveClipboard({ text: "must not be delivered" });
          await until(() => c.ws.readyState === 3);
          assert.equal(
            c.messages.some((m) => m.text),
            false,
          );
          assert.equal(
            actions.slice(actionStart).some((a) => a.key === "f12"),
            false,
          );
          delayClipboard = false;
        },
      );
      await t.test(
        "guest video selects a display but guest input remains forbidden",
        async () => {
          const invite = reach.auth.inviteGuest({
            name: "guest",
            roots: [],
            ttlSeconds: 60,
            screen: true,
          });
          const guest = reach.auth.redeemGuest(invite.invitation);
          const c = await connect(guest.token, "/ws/screen", {
            protocol: 2,
            format: "jpeg",
          });
          await until(() => c.messages.some((m) => Buffer.isBuffer(m)));
          const ready = c.messages.find((m) => m.type === "ready");
          assert.equal(ready.display, "42");
          assert.equal(ready.protocol, 2);
          const denied = await connect(guest.token);
          await until(() => denied.ws.readyState === 3);
          reach.auth.revoke(guest.clientId);
          await until(() => c.ws.readyState === 3);
        },
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      await reach.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "native Mac encoder produces decodable Annex B keyframes and interframes",
  { skip: !process.env.REACH_TEST_VIDEO_HELPER, timeout: 20000 },
  async () => {
    const source = new NativeScreenSource(process.env.REACH_TEST_VIDEO_HELPER, [
      "--self-test",
    ]);
    try {
      const keys = [];
      source.setBitrate(1500000);
      for (const command of ["key", "frame", "frame", "key"]) {
        const packet = await source.next(command),
          length = packet.readUInt32BE(),
          meta = JSON.parse(packet.subarray(4, 4 + length));
        assert.match(meta.codec, /^avc1\./);
        assert.equal(meta.width, 640);
        assert.equal(meta.height, 360);
        if (command === "key") assert.equal(meta.key, true);
        keys.push(meta.key);
      }
      assert.deepEqual(keys, [true, false, false, true]);
    } finally {
      source.stop();
    }
  },
);
