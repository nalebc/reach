import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { guestRefusal } from "../server/windows-guest-screen.mjs";

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

// A Windows PC paints password managers and Reach's windows black in a
// guest's picture (docs/parity/AUDIT.md #12, server/windows-guest-screen.mjs).
// Its check is a stand-in here (no real screen is captured): while it says
// this PC can, a screen guest watches in a stream of their own and takes
// control, as on a Mac; while it says it can't, the guest is refused with the
// reason, on the old protocol too, nothing is captured for them, and their
// phone shows no Screen. The owner watches either way.
test("on a Windows Reach a screen guest watches and controls once Reach can hide private windows there, and is refused with why when it can't; the owner always watches", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-guest-screen-win-"));
  const prepared = [];
  let check = { ok: true };
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    platform: "win32",
    windowsGuestScreen: {
      probe: async () => check,
      refusal: () => (check.ok ? "" : guestRefusal(check.why)),
      source: async () => {
        throw Error("Streams here come from remoteScreenFactory.");
      },
    },
    remoteScreenFactory: async (options, { privateView }) => {
      prepared.push(privateView);
      return () => ({ next: async () => Buffer.from("frame"), stop() {} });
    },
    screenStreamFactory: async () => () => ({ next: async () => Buffer.from("legacy"), stop() {} }),
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
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "guest", roots: [], ttlSeconds: 600, screen: "control" }).invitation,
  ).token;
  const watch = async (token, protocol) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen");
    sockets.push(ws);
    const messages = [];
    let closed = null;
    ws.on("error", () => {});
    ws.on("close", (code, reason) => (closed = { code, reason: String(reason) }));
    ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token, ...(protocol && { protocol, display: "1", format: "h264" }) }));
    await until(() => closed || messages.some((m) => Buffer.isBuffer(m) || m.type === "error" || m.type === "ready"));
    const error = messages.find((m) => !Buffer.isBuffer(m) && m.type === "error");
    if (!error) ws.terminate();
    return error?.error || closed?.reason || "streamed";
  };
  const control = (enabled) =>
    fetch(url + "/api/screen/control", {
      method: "POST",
      headers: { Authorization: `Bearer ${guest}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  const device = (token) => fetch(url + "/api/device", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

  // It can: as on a Mac.
  assert.equal(await watch(owner.token, 2), "streamed");
  assert.equal(await watch(guest, 2), "streamed");
  assert.equal(await watch(guest), "streamed", "the old protocol's one picture is always the hidden one");
  assert.deepEqual(prepared, [false, true], "the guest's picture is a stream of its own, with the private windows hidden");
  const took = await control(true);
  assert.equal(took.status, 200, await took.clone().text());
  assert.equal((await control(false)).status, 200);
  const seen = await device(guest);
  assert.deepEqual([seen.capabilities.screen, seen.capabilities.screenSupported], [true, true]);
  assert.equal((await device(owner.token)).capabilities.guestScreen, true, "the owner's invite sheet offers screen roles");

  // It can't (the check failed, or the helper gave up): refused, with why.
  check = { ok: false, why: "Screen capture could not hide private windows. Windows wouldn't list every window." };
  prepared.length = 0;
  assert.equal(await watch(owner.token, 2), "streamed");
  assert.match(await watch(guest, 2), /owner can watch or control its screen right now: Screen capture could not hide private windows\. Windows wouldn't list every window\./);
  assert.match(await watch(guest), /owner can watch or control its screen/);
  assert.equal(prepared.includes(true), false, "nothing is prepared for the guest");
  const refused = await control(true);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /owner can watch or control/);
  const off = await device(guest);
  assert.deepEqual([off.capabilities.screen, off.capabilities.screenSupported], [false, false]);
  assert.equal((await device(owner.token)).capabilities.guestScreen, false);
});
