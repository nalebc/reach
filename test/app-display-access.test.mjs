import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// The hidden displays Reach makes for apps on phones are not the Screen tab's:
// watched whole over /ws/screen, only by someone who may use that app. The
// app helper and the capture are fakes; no real screen is captured.
const CHROME = "/Applications/Google Chrome.app";
const NOTES = "/System/Applications/Notes.app";
const until = async (check, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("an app's hidden display streams only to its owner and to guests allowed that app", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-app-display-"));
  let displays = 0;
  const prepared = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    appPlatform: "darwin",
    appDisplays: async ({ onExit }) => {
      const helper = {
        stopped: false,
        async request(cmd, payload = {}) {
          if (cmd === "open")
            return {
              thread: payload.thread,
              display: String(900 + ++displays),
              size: { w: 852, h: 1130 },
              region: { x: 352, y: 30, w: 500, h: 1084 },
              scale: 2,
              created: true,
              minimum: { w: 500, h: 0 },
              app: { name: "Google Chrome" },
            };
          return { ok: true };
        },
        async stop() {
          helper.stopped = true;
          onExit();
        },
      };
      return helper;
    },
    appList: async () => [
      { id: CHROME, name: "Google Chrome" },
      { id: NOTES, name: "Notes" },
    ],
    appScreenFactory: async () => () => ({
      next: async () => Buffer.from("frame"),
      stop() {},
    }),
    remoteScreenFactory: async (options, { privateView }) => {
      prepared.push({ display: options.display, privateView });
      return () => ({ next: async () => Buffer.from("frame"), stop() {} });
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const opened = await fetch(url + "/api/screen/apps", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${owner.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId: CHROME, width: 393, height: 852 }),
  }).then((r) => r.json());
  assert.equal(opened.display, "901");
  const guest = (choice) =>
    reach.auth.redeemGuest(
      reach.auth.inviteGuest({ name: "guest", roots: [], ttlSeconds: 600, ...choice }).invitation,
    ).token;
  const watch = async (token, display) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen");
    sockets.push(ws);
    const messages = [];
    ws.on("error", () => {});
    ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token, protocol: 2, display, format: "h264" }));
    await until(
      () => messages.some((m) => Buffer.isBuffer(m) || m.type === "error"),
    );
    const error = messages.find((m) => !Buffer.isBuffer(m) && m.type === "error");
    return error ? { refused: error } : { streamed: true };
  };
  // The owner: their own phone's apps.
  assert.deepEqual(await watch(owner.token, "901"), { streamed: true });
  // Someone invited to watch the screen, not that app: refused, for good.
  const screenOnly = await watch(guest({ screen: "view" }), "901");
  assert.equal(screenOnly.refused?.retryable, false);
  assert.match(screenOnly.refused.error, /isn't shared with you/);
  // Invited to watch another app only: refused too.
  const notes = await watch(guest({ screen: "view", apps: [NOTES] }), "901");
  assert.match(notes.refused?.error ?? "", /isn't shared with you/);
  // Invited to this app: allowed.
  assert.deepEqual(
    await watch(guest({ screen: "view", apps: [CHROME] }), "901"),
    { streamed: true },
  );
  // The Mac's own displays stay as they were for a screen guest.
  assert.deepEqual(await watch(guest({ screen: "view" }), "1"), { streamed: true });
  // Guests' pictures leave out password managers and Reach's windows; the
  // owner's own view is a stream of its own, unchanged.
  assert.deepEqual(prepared, [
    { display: "901", privateView: false },
    { display: "901", privateView: true },
    { display: "1", privateView: true },
  ]);
});
