import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { AppThreads } from "../server/app-threads.mjs";
import { ScreenControl, pausedMessage } from "../server/screen.mjs";

// Pause: the person at the computer gets it back (someone else wants to
// watch something on the Mac). Streams end, nobody controls it, and apps on
// the phone come back to the Mac's own screens without closing anything.
// Resume puts everything back. The native helper is a recording fake here;
// the last test runs the real one's new commands.
const CHROME = "/Applications/Google Chrome.app";
const NOTES = "/System/Applications/Notes.app";
const PAUSED = pausedMessage();
const until = async (check, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// Remembers which threads have a window, like the helper: "pause" holds them
// all, "resume" brings one back unless its window is gone.
function fakeHelper() {
  const fake = { requests: [], starts: 0, current: null, displays: 0 };
  fake.windows = new Map();
  fake.gone = new Set();
  // Threads held by the last pause, as the helper keeps them; and an
  // optional gate a resume waits on, to look at the moment in between.
  fake.held = new Set();
  fake.resumeGate = null;
  const placed = (thread) => ({
    thread,
    display: String(900 + ++fake.displays),
    size: { w: 852, h: 1130 },
    region: { x: 352, y: 30, w: 500, h: 1084 },
    scale: 2,
    created: true,
    minimum: { w: 500, h: 0 },
    app: { name: fake.windows.get(thread) },
  });
  fake.start = async ({ onEvent, onExit }) => {
    fake.starts++;
    const helper = {
      stopped: false,
      onEvent,
      async request(cmd, payload = {}) {
        fake.requests.push({ cmd, ...payload });
        // Like the real helper, it lends no window while told Reach is paused.
        if (cmd === "open" && fake.paused)
          throw Object.assign(new Error("Reach is paused on this Mac."), {
            status: 409,
          });
        if (cmd === "open") {
          fake.windows.set(
            payload.thread,
            payload.path === NOTES ? "Notes" : "Google Chrome",
          );
          return placed(payload.thread);
        }
        if (cmd === "pause") {
          fake.held = new Set(fake.windows.keys());
          return { held: [...fake.held] };
        }
        if (cmd === "resume") {
          await fake.resumeGate;
          fake.held.delete(payload.thread);
          if (
            !fake.windows.has(payload.thread) ||
            fake.gone.has(payload.thread)
          ) {
            fake.windows.delete(payload.thread);
            throw Object.assign(
              new Error("The window was closed on the Mac."),
              {
                status: 409,
                code: "gone",
              },
            );
          }
          return placed(payload.thread);
        }
        if (cmd === "state") {
          fake.paused = payload.paused;
          return { paused: payload.paused };
        }
        if (cmd === "close") {
          fake.windows.delete(payload.thread);
          fake.held.delete(payload.thread);
          return { closed: true, returned: false };
        }
        // A held thread can't be quit from the phone, like the helper.
        if (cmd === "quit" && fake.held.has(payload.thread))
          throw Object.assign(new Error("Reach is paused on this Mac."), {
            status: 409,
          });
        if (cmd === "quit") {
          fake.windows.delete(payload.thread);
          return { quit: true };
        }
        return { ok: true };
      },
      async stop() {
        helper.stopped = true;
        onExit();
      },
    };
    fake.current = helper;
    return helper;
  };
  return fake;
}

async function start(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-pause-"));
  const fake = fakeHelper();
  const inputs = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: extra.dataDir || path.join(dir, "private"),
    screen: true,
    appPlatform: "darwin",
    appDisplays: fake.start,
    // Reach's menu bar item, as on a real Mac.
    ...(extra.menuBar && { menuBar: true }),
    appList: async () => [
      { id: CHROME, name: "Google Chrome" },
      { id: NOTES, name: "Notes" },
    ],
    appScreenFactory: async () => () => ({
      next: async () => Buffer.from("frame"),
      stop() {},
    }),
    remoteScreenFactory: async () => () => ({
      next: async () => Buffer.from("frame"),
      stop() {},
    }),
    desktopInputFactory: async () => ({
      async send(action) {
        inputs.push(action);
        return { ok: true };
      },
      stop() {},
    }),
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await reach.close();
  });
  const socket = async (route, auth) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + route);
    sockets.push(ws);
    const messages = [];
    ws.on("error", () => {});
    ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: owner.token, ...auth }));
    return { ws, messages };
  };
  const stream = (message = {}) =>
    socket("/ws/screen", { protocol: 2, display: "primary", ...message });
  const pause = (paused) =>
    call("/api/settings/pause", { method: "POST", body: { paused } });
  const open = (appId) =>
    call("/api/screen/apps", {
      method: "POST",
      body: { appId, width: 393, height: 852 },
    });
  return { reach, fake, call, owner, url, stream, socket, pause, open, inputs };
}

test("pause gives the Mac back: streams end, control ends, apps come home open; resume brings it all back", async (t) => {
  const { fake, call, stream, socket, pause, open, inputs } = await start(t);
  const chrome = (await open(CHROME)).body;
  assert.equal(chrome.state, "running");
  const app = await stream({ thread: chrome.id });
  const screen = await stream();
  await until(() => app.messages.some((m) => m.type === "ready"));
  await until(() => screen.messages.some((m) => m.type === "ready"));
  const control = await call("/api/screen/control", {
    method: "POST",
    body: { enabled: true },
  });
  assert.equal(control.status, 200);
  const input = await socket("/ws/screen-input", { display: "primary" });
  await until(() => input.messages.some((m) => m.type === "ready"));

  assert.deepEqual((await pause(true)).body, { paused: true });

  // Every stream is told why, and may come back by itself after resume.
  for (const viewer of [app, screen]) {
    await until(() => viewer.messages.some((m) => m.type === "error"));
    const error = viewer.messages.find((m) => m.type === "error");
    assert.deepEqual(
      { error: error.error, retryable: error.retryable },
      { error: PAUSED, retryable: true },
    );
  }
  // The phone's control channel ends too.
  await until(() => input.ws.readyState === WebSocket.CLOSED);

  // The app's window came back to the Mac: held, never closed.
  assert.deepEqual(
    fake.requests.map((r) => r.cmd),
    ["open", "pause"],
  );
  const held = (await call("/api/screen/apps")).body;
  assert.deepEqual(
    held.map((x) => [x.id, x.state, x.held, x.display]),
    [[chrome.id, "paused", true, undefined]],
  );

  // Nothing reaches the Mac's screen while paused.
  const refused = [
    await call("/api/screen/control", {
      method: "POST",
      body: { enabled: true },
    }),
    await call("/api/screen/input", {
      method: "POST",
      body: { type: "click", x: 0.5, y: 0.5 },
    }),
    await open(NOTES),
    await call(`/api/screen/apps/${chrome.id}`, {
      method: "PATCH",
      body: { width: 852, height: 393 },
    }),
    await call(`/api/screen/apps/${chrome.id}/activate`, { method: "POST" }),
    await call(`/api/screen/apps/${chrome.id}`, { method: "DELETE" }),
    await call(`/api/screen/apps/${chrome.id}/quit`, {
      method: "POST",
      body: {},
    }),
    await call(`/api/screen/apps/${chrome.id}/fields`),
    await call("/api/screen"),
    await call("/api/apps/launch", {
      method: "POST",
      body: { id: "/Applications/Reach Test Missing.app" },
    }),
    await call("/api/terminals/desktop", {
      method: "POST",
      body: { provider: "terminal" },
    }),
    await call("/api/terminals/desktop/any/focus", {
      method: "POST",
      body: {},
    }),
    await call("/api/terminals/desktop/any/close", {
      method: "POST",
      body: {},
    }),
    await call("/api/sessions/codex/any/open", { method: "POST", body: {} }),
  ];
  assert.deepEqual(
    refused.map((r) => [r.status, r.body.error]),
    refused.map(() => [423, PAUSED]),
  );
  const late = await stream();
  await until(() => late.messages.some((m) => m.type === "error"));
  assert.deepEqual(
    late.messages.map((m) => [m.type, m.error, m.status, m.retryable]),
    [["error", PAUSED, 423, true]],
  );
  // Only the channel's own startup probe ever reached the input helper.
  assert.deepEqual(inputs, [{ type: "heartbeat" }]);
  assert.deepEqual(
    fake.requests.map((r) => r.cmd),
    ["open", "pause"],
  );

  // Phones learn it at once, and from the device itself.
  assert.equal((await call("/api/device")).body.paused, true);
  const presence = await socket("/ws/presence", { kind: "phone" });
  await until(() => presence.messages.some((m) => m.type === "presence"));
  assert.equal(presence.messages.at(-1).changes.paused, true);

  assert.deepEqual((await pause(false)).body, { paused: false });
  // The same window goes back to the phone, on a fresh hidden display.
  assert.deepEqual(
    fake.requests.map((r) => [r.cmd, r.thread]),
    [
      ["open", chrome.id],
      ["pause", undefined],
      ["resume", chrome.id],
    ],
  );
  const back = (await call("/api/screen/apps")).body;
  assert.deepEqual(
    back.map((x) => [x.id, x.state, x.held, x.display]),
    [[chrome.id, "running", undefined, "902"]],
  );
  assert.equal((await call("/api/device")).body.paused, undefined);
  await until(() => presence.messages.at(-1).changes.paused === undefined);
  const again = await stream({ thread: chrome.id });
  await until(() => again.messages.some((m) => m.type === "ready"));
  assert.equal(
    (
      await call("/api/screen/control", {
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    200,
  );
});

test("pausing twice or resuming twice changes nothing; only the owner may pause", async (t) => {
  const { fake, call, pause, open } = await start(t);
  await open(CHROME);
  await Promise.all([pause(true), pause(true)]);
  assert.equal(fake.requests.filter((r) => r.cmd === "pause").length, 1);
  await Promise.all([pause(false), pause(false)]);
  assert.equal(fake.requests.filter((r) => r.cmd === "resume").length, 1);
  assert.equal((await pause("yes")).status, 400);

  // Someone invited to control the screen can't pause or resume it.
  const created = await call("/api/guests", {
    method: "POST",
    body: { name: "Sam", ttlSeconds: 900, screen: "control" },
  });
  const guest = await call("/api/guest/redeem", {
    token: "",
    method: "POST",
    body: { invitation: created.body.invitation },
  });
  assert.equal(guest.status, 200);
  const asGuest = await call("/api/settings/pause", {
    token: guest.body.token,
    method: "POST",
    body: { paused: true },
  });
  assert.equal(asGuest.status, 403);
  assert.equal((await call("/api/device")).body.paused, undefined);
});

test("a window closed on the Mac while paused opens again on resume", async (t) => {
  const { fake, call, pause, open } = await start(t);
  const notes = (await open(NOTES)).body;
  await pause(true);
  fake.gone.add(notes.id);
  await pause(false);
  assert.deepEqual(
    fake.requests.map((r) => [r.cmd, r.thread]),
    [
      ["open", notes.id],
      ["pause", undefined],
      ["resume", notes.id],
      ["open", notes.id],
    ],
  );
  // Opened as a fresh tap would: the phone's shape from before the pause.
  assert.deepEqual(fake.requests.at(-1).phone, { w: 393, h: 852 });
  assert.deepEqual(
    (await call("/api/screen/apps")).body.map((x) => [x.id, x.state]),
    [[notes.id, "running"]],
  );
});

test("apps show as coming back until they're back on the phone", async (t) => {
  const { fake, call, pause, open } = await start(t);
  const chrome = (await open(CHROME)).body;
  await pause(true);
  let release;
  fake.resumeGate = new Promise((r) => (release = r));
  const resuming = pause(false);
  await until(() => fake.requests.some((r) => r.cmd === "resume"));
  // Mid-resume: still held, so the phone shows it opening, not "back on
  // the Mac".
  assert.deepEqual(
    (await call("/api/screen/apps")).body.map((x) => [x.id, x.state, x.held]),
    [[chrome.id, "paused", true]],
  );
  release();
  assert.deepEqual((await resuming).body, { paused: false });
  assert.deepEqual(
    (await call("/api/screen/apps")).body.map((x) => [x.id, x.state, x.held]),
    [[chrome.id, "running", undefined]],
  );
});

test("an app whose window was already closed isn't left behind by a pause", async (t) => {
  const { fake, call, pause, open } = await start(t);
  const notes = (await open(NOTES)).body;
  fake.current.onEvent({ event: "closed", thread: notes.id });
  await pause(true);
  // The helper lets go of it at once; the phone still offers Open again.
  assert.deepEqual(
    fake.requests.map((r) => [r.cmd, r.thread]),
    [
      ["open", notes.id],
      ["pause", undefined],
      ["close", notes.id],
    ],
  );
  await pause(false);
  assert.equal((await call("/api/screen/apps")).body[0].state, "closed");
  // So swiping it away later quits it, instead of "paused".
  const quit = await call(`/api/screen/apps/${notes.id}/quit`, {
    method: "POST",
    body: {},
  });
  assert.deepEqual([quit.status, quit.body], [200, { quit: true }]);
});

test("Reach restarted while paused stays paused, and resume still brings the apps back", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-pause-data-"));
  const first = await start(t, { dataDir });
  const chrome = (await first.open(CHROME)).body;
  await first.pause(true);
  await first.reach.close();

  const second = await start(t, { dataDir });
  assert.equal(second.reach.paused, true);
  assert.equal((await second.call("/api/device")).body.paused, true);
  assert.deepEqual(
    (await second.call("/api/screen/apps")).body.map((x) => [
      x.id,
      x.state,
      x.held,
    ]),
    [[chrome.id, "paused", true]],
  );
  assert.equal((await second.open(NOTES)).status, 423);
  // The new helper never had the window: it opens anew at the phone's shape.
  await second.pause(false);
  assert.deepEqual(
    second.fake.requests.map((r) => [r.cmd, r.thread, r.phone]),
    [
      ["resume", chrome.id, undefined],
      ["open", chrome.id, { w: 393, h: 852 }],
    ],
  );
  assert.equal(
    (await second.call("/api/screen/apps")).body[0].state,
    "running",
  );
});

test("Pause and Resume in the Mac's menu bar work like the phone's", async (t) => {
  const { reach, fake, call, open } = await start(t);
  await open(CHROME);
  fake.current.onEvent({ event: "pause" });
  await until(async () => (await call("/api/device")).body.paused === true);
  await until(() => fake.requests.some((r) => r.cmd === "pause"));
  fake.current.onEvent({ event: "resume" });
  await until(() => reach.paused === false);
  await until(() => fake.requests.some((r) => r.cmd === "resume"));
  // The terminal running Reach can do the same.
  await reach.setPaused(true);
  assert.equal((await call("/api/device")).body.paused, true);
});

test("with the menu bar item, resume tells the Mac first, so every app comes back", async (t) => {
  const { fake, call, pause, open } = await start(t, { menuBar: true });
  await until(() => fake.requests.some((r) => r.cmd === "state"));
  const chrome = (await open(CHROME)).body;
  const notes = (await open(NOTES)).body;
  // Notes' window was closed on the Mac while paused: it opens anew.
  fake.gone.add(notes.id);
  await pause(true);
  await pause(false);
  assert.deepEqual(
    fake.requests.map((r) => [r.cmd, r.thread ?? r.paused]),
    [
      ["state", false],
      ["open", chrome.id],
      ["open", notes.id],
      ["pause", undefined],
      ["state", true],
      ["state", false],
      ["resume", chrome.id],
      ["resume", notes.id],
      ["open", notes.id],
    ],
  );
  assert.deepEqual(
    (await call("/api/screen/apps")).body.map((x) => [x.name, x.state]).sort(),
    [
      ["Google Chrome", "running"],
      ["Notes", "running"],
    ],
  );
});

test("Reach's menu bar item stays while Reach runs and follows pause, also after the helper restarts", async (t) => {
  const fake = fakeHelper();
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-pause-menu-")),
    "app-threads.json",
  );
  const threads = new AppThreads({
    file,
    listApps: async () => [{ id: CHROME, name: "Google Chrome" }],
    startHelper: fake.start,
    platform: "darwin",
  });
  t.after(() => threads.shutdown());
  await threads.showMenu();
  assert.deepEqual(fake.requests, [{ cmd: "state", paused: false }]);
  const clicks = [];
  threads.onMenu = (paused) => clicks.push(paused);
  fake.current.onEvent({ event: "pause" });
  fake.current.onEvent({ event: "resume" });
  assert.deepEqual(clicks, [true, false]);

  // A crashed helper comes back with the item in its current state.
  threads.paused = true;
  fake.current.stopped = true;
  threads.exited();
  await until(() => fake.starts === 2, 4000);
  await until(() => fake.requests.length === 2);
  assert.deepEqual(fake.requests[1], { cmd: "state", paused: true });
});

test("screen control can't be taken or renewed while paused", () => {
  let now = 1000;
  const control = new ScreenControl(() => now);
  const owner = { id: "a", kind: "device", scopes: ["admin", "screen"] };
  control.acquire(owner, true);
  control.paused = true;
  assert.throws(() => control.check(owner), { status: 423, message: PAUSED });
  assert.throws(() => control.acquire(owner, true), { status: 423 });
  // Letting go always works.
  assert.deepEqual(control.acquire(owner, false), { enabled: false });
  control.paused = false;
  assert.equal(control.acquire(owner, true).enabled, true);
  control.check(owner);
});

test(
  "the real app display helper answers pause, resume and menu state",
  { skip: process.platform !== "darwin" && "needs macOS", timeout: 120000 },
  async () => {
    const { appDisplaysBinary, AppDisplaysHelper } =
      await import("../server/app-threads.mjs");
    const { spawn } = await import("node:child_process");
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "reach-pause-helper-"),
    );
    const binary = await appDisplaysBinary({ dataDir });
    // Its own display range, so it can never touch a running Reach's.
    const helper = new AppDisplaysHelper(
      spawn(binary, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, REACH_APP_DISPLAY_SLOTS: "40" },
      }),
    );
    try {
      assert.deepEqual(await helper.request("state", { paused: true }), {
        re: 1,
        paused: true,
      });
      // Nothing lent out: nothing to hold, nothing opens while paused.
      assert.deepEqual(await helper.request("pause"), { re: 2, held: [] });
      await assert.rejects(
        helper.request("open", {
          thread: "t",
          path: "/System/Applications/Calculator.app",
          phone: { w: 393, h: 852 },
        }),
        { message: "Reach is paused on this Mac." },
      );
      await assert.rejects(helper.request("resume", { thread: "t" }), {
        code: "gone",
      });
      assert.deepEqual(await helper.request("state", { paused: false }), {
        re: 5,
        paused: false,
      });
      assert.deepEqual(await helper.request("list"), { re: 6, threads: [] });
    } finally {
      await helper.stop();
    }
  },
);
