import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  DesktopSessions,
  desktopSettings,
  peerRoute,
} from "../server/desktop-session.mjs";
import {
  inputAction,
  HID_KEYS,
  streamOptions,
} from "../server/desktop-protocol.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
const owner = {
  id: "owner",
  name: "Owner’s iPad",
  scopes: ["admin", "screen"],
};
const options = { width: 2752, height: 2064 };
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await delay(10);
  }
  assert.fail("Timed out");
}
test("HID, relative pointer and phased scroll are bounded and preserve edges", () => {
  for (const usage of HID_KEYS)
    assert.equal(
      inputAction({ type: "keyDown", usage, modifiers: ["meta", "fn"] }).usage,
      usage,
    );
  assert.deepEqual(inputAction({ type: "keyUp", usage: 6, repeat: true }), {
    type: "keyUp",
    usage: 6,
    repeat: false,
    modifiers: [],
  });
  for (const value of [
    { type: "keyDown", usage: 0 },
    { type: "keyUp", usage: 65535 },
    { type: "keyDown", usage: "4" },
    { type: "keyDown", usage: 4, repeat: "true" },
    { type: "keyDown", usage: 4, modifiers: ["meta", "meta"] },
    { type: "mouseMove", relative: true, dx: Infinity, dy: 0 },
    { type: "mouseMove", relative: true, dx: 2049, dy: 0 },
    { type: "mouseDown", relative: true, dx: 0, dy: 0, button: "back" },
    { type: "mouseUp", x: 2, y: 0 },
    { type: "scroll", dx: 0, dy: 1, phase: "arbitrary" },
    { type: "scroll", dx: 0, dy: 1, momentum: "cancelled" },
    { type: "clipboard-set", data: "remote" },
  ])
    assert.throws(() => inputAction(value));
  assert.deepEqual(
    inputAction({
      type: "mouseDown",
      relative: true,
      dx: 0,
      dy: 0,
      button: "middle",
    }),
    { type: "mouseDown", relative: true, dx: 0, dy: 0, button: "middle" },
  );
  assert.equal(
    inputAction({
      type: "scroll",
      dx: 0.5,
      dy: 2.5,
      phase: "changed",
      momentum: "changed",
    }).momentum,
    "changed",
  );
  assert.equal(streamOptions({ quality: "desktop", width: 2752 }).fps, 60);
  assert.throws(() => streamOptions({ quality: "desktop", width: 10000 }));
});
test("display allocation bounds and route classification do not confuse home DERP with relay", () => {
  for (const v of [
    {},
    { width: 100000, height: 100000 },
    { ...options, mode: "shell" },
    { ...options, clipboard: "true" },
    { width: 3840, height: 3840 },
  ])
    assert.throws(() => desktopSettings(v));
  assert.equal(desktopSettings(options).mode, "match");
  const status = {
    Peer: {
      a: {
        Online: true,
        TailscaleIPs: ["100.65.1.2"],
        CurAddr: "10.1.2.3:1234",
        Relay: "sea",
      },
    },
  };
  assert.equal(peerRoute(status, "100.65.1.2"), "Direct");
  delete status.Peer.a.CurAddr;
  assert.equal(peerRoute(status, "100.65.1.2"), "Relayed");
  assert.equal(peerRoute(status, "100.65.1.3"), "Unknown");
});
test("desktop session retains display during brief reconnect then disposes it; local disconnect cannot be resumed", async () => {
  let stops = 0,
    end,
    labels = [],
    revoked = false;
  const sessions = new DesktopSessions(
    {},
    {
      grace: 20,
      create: async (_, __, stop) => {
        end = stop;
        return {
          display: "42",
          virtual: true,
          stop() {
            stops++;
          },
          update(label) {
            labels.push(label);
          },
        };
      },
    },
  );
  try {
    const session = await sessions.open(owner, options, () => {
      if (revoked) throw Error("Revoked");
    });
    assert.throws(() => sessions.get(session.id, { id: "another" }));
    await assert.rejects(
      sessions.open(owner, options, () => {}),
      /already connected/,
    );
    const socket = () => {
      const ws = new EventEmitter();
      ws.close = () => ws.emit("close");
      return ws;
    };
    const first = socket();
    sessions.attach(session.id, owner, first);
    first.emit("close");
    const second = socket();
    sessions.attach(session.id, owner, second);
    await delay(30);
    sessions.tick();
    assert.equal(stops, 0);
    assert.match(labels[0], /Owner.*viewing/);
    second.emit("close");
    await delay(30);
    sessions.tick();
    assert.equal(stops, 1);
    assert.throws(() => sessions.get(session.id, owner), /ended/);
    const again = await sessions.open(owner, options, () => {});
    end();
    assert.equal(stops, 2);
    assert.throws(() => sessions.get(again.id, owner));
    const final = await sessions.open(owner, options, () => {
      if (revoked) throw Error("Revoked");
    });
    revoked = true;
    sessions.tick();
    assert.throws(() => sessions.get(final.id, owner));
    assert.equal(stops, 3);
  } finally {
    sessions.close();
  }
});
test("revocation while native display is starting cleans up the eventual helper", async () => {
  let ready,
    stops = 0;
  const sessions = new DesktopSessions(
    {},
    { create: () => new Promise((r) => (ready = r)) },
  );
  try {
    const opening = sessions.open(owner, options, () => {});
    sessions.revoke(owner.id);
    ready({
      display: "42",
      stop() {
        stops++;
      },
      update() {},
    });
    await assert.rejects(opening, /ended/);
    assert.equal(stops, 1);
  } finally {
    sessions.close();
  }
});
test(
  "iPad session HTTP and websocket require ownership, lease, clipboard opt-in, and revoke all resources",
  { timeout: 20000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ipad-"));
    let nativeEnd,
      displayStops = 0,
      inputStops = 0;
    const actions = [];
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, "private"),
      screen: true,
      desktopSessionFactory: async (_, options, ended) => {
        nativeEnd = ended;
        return {
          display: "42",
          virtual: options.mode === "match",
          update() {},
          stop() {
            displayStops++;
          },
        };
      },
      desktopInputFactory: async () => ({
        send: async (a) => {
          actions.push(a);
          return a.type === "clipboard-get"
            ? { revision: 1, kind: "text", text: "fixture" }
            : { ok: true };
        },
        stop() {
          inputStops++;
        },
      }),
      remoteScreenFactory: async () => () => ({
        next: async () => Buffer.from("synthetic"),
        stop() {},
      }),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("iPad", ALL_SCOPES),
      other = reach.auth.issue("Other", ALL_SCOPES),
      guest = reach.auth.issue("Viewer", ["screen"], "agent");
    const sockets = [];
    t.after(async () => {
      for (const ws of sockets) ws.terminate();
      await reach.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const request = async (route, body, token = owner.token, method = "POST") =>
      fetch(base + route, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (await request("/api/screen/desktop", options, guest.token)).status,
      403,
    );
    let response = await request("/api/screen/desktop", {
      ...options,
      clipboard: true,
    });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(
      (
        await request(
          `/api/screen/desktop/${session.id}`,
          null,
          other.token,
          "DELETE",
        )
      ).status,
      403,
    );
    const connect = async (route, token, extra = {}) => {
      const ws = new WebSocket(base.replace("http:", "ws:") + route);
      sockets.push(ws);
      ws.messages = [];
      ws.on("message", (b, binary) => {
        if (!binary) ws.messages.push(JSON.parse(b));
      });
      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "auth",
          token,
          desktopSession: session.id,
          ...extra,
        }),
      );
      return ws;
    };
    const denied = await connect("/ws/screen-input", owner.token);
    await once(denied, "close");
    assert.equal(actions.length, 0);
    const foreign = await connect("/ws/screen", other.token, { protocol: 2 });
    await once(foreign, "close");
    await request("/api/screen/control", { enabled: true });
    const input = await connect("/ws/screen-input", owner.token);
    await until(() => input.messages.some((m) => m.type === "ready"));
    for (const [id, action] of [
      [1, { type: "keyDown", usage: 227, modifiers: ["meta"] }],
      [2, { type: "keyDown", usage: 6, modifiers: ["meta"] }],
      [3, { type: "keyUp", usage: 6, modifiers: ["meta"] }],
      [4, { type: "keyUp", usage: 227 }],
    ])
      input.send(JSON.stringify({ type: "input", id, action }));
    await until(() => input.messages.some((m) => m.id === 4));
    assert.deepEqual(
      actions.filter((a) => a.type.startsWith("key")).map((a) => a.type),
      ["keyDown", "keyDown", "keyUp", "keyUp"],
    );
    const read = { session: session.id, operation: "read" };
    response = await request("/api/screen/desktop/clipboard", read);
    assert.equal((await response.json()).text, "fixture");
    assert.equal(
      (
        await request("/api/screen/desktop/clipboard", {
          ...read,
          operation: "write",
          data: "YWJj",
        })
      ).status,
      400,
    );
    const stream = await connect("/ws/screen", owner.token, { protocol: 2 });
    await until(() => stream.messages.some((m) => m.type === "ready"));
    const stoppedInput = once(input, "close"),
      stoppedStream = once(stream, "close");
    nativeEnd();
    await Promise.all([stoppedInput, stoppedStream]);
    assert.equal(displayStops, 1);
    assert.ok(inputStops >= 1);
    assert.equal(
      (await request("/api/screen/desktop/clipboard", read)).status,
      403,
    );
    const resumed = await connect("/ws/screen", owner.token, { protocol: 2 });
    await once(resumed, "close");
    response = await request("/api/screen/desktop", options);
    const noClipboard = await response.json();
    await request("/api/screen/control", { enabled: true });
    assert.equal(
      (
        await request("/api/screen/desktop/clipboard", {
          session: noClipboard.id,
          operation: "read",
        })
      ).status,
      403,
    );
    await request("/api/settings", { screen: false });
    assert.equal(displayStops, 2);
  },
);
