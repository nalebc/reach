import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { APP_STREAM, AppThreads, phoneViewport } from "../server/app-threads.mjs";

// Apps on your phone, server side. The native helper that makes hidden
// displays and moves windows is replaced by a recording fake; the routes,
// thread lifecycle, persistence and stream wiring are real.
const CHROME = "/Applications/Google Chrome.app";
const NOTES = "/System/Applications/Notes.app";
const until = async (check, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakeHelper() {
  const fake = {
    requests: [],
    starts: 0,
    stops: 0,
    current: null,
    displays: 0,
  };
  fake.start = async ({ onEvent, onExit }) => {
    fake.starts++;
    const helper = {
      stopped: false,
      onEvent,
      async request(cmd, payload = {}) {
        fake.requests.push({ cmd, ...payload });
        if (cmd === "open")
          return {
            thread: payload.thread,
            display: String(900 + ++fake.displays),
            size: { w: 852, h: 1130 },
            region: { x: 352, y: 30, w: 500, h: 1084 },
            scale: 2,
            created: true,
            minimum: { w: 500, h: 0 },
            app: { name: "Google Chrome" },
          };
        if (cmd === "rotate")
          return { region: { x: 0, y: 30, w: 852, h: 393 } };
        if (cmd === "close") return { closed: true, returned: false };
        if (cmd === "quit") return fake.quitReplies?.shift() ?? { quit: true };
        if (cmd === "fields")
          return fake.fieldsReply ?? { fields: [], complete: true };
        return { ok: true };
      },
      async stop() {
        fake.stops++;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-apps-"));
  const fake = extra.fake || fakeHelper();
  const frames = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: extra.dataDir || path.join(dir, "private"),
    screen: true,
    appPlatform: "darwin",
    appDisplays: fake.start,
    appList: async () => [
      { id: CHROME, name: "Google Chrome" },
      { id: NOTES, name: "Notes" },
    ],
    desktopDisplays: async () => [
      {
        id: "1",
        name: "Built-in",
        primary: true,
        width: 1512,
        height: 982,
        x: 0,
        y: 0,
      },
      ...[...Array(fake.displays)].map((_, i) => ({
        id: String(901 + i),
        name: "Reach · App",
        primary: false,
        width: 852,
        height: 1130,
        x: 1512,
        y: 982,
      })),
    ],
    appScreenFactory: async (options) => {
      frames.push(options);
      return () => ({ next: async () => Buffer.from("frame"), stop() {} });
    },
    ...extra.overrides,
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
  const stream = async (message) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen");
    sockets.push(ws);
    const messages = [];
    ws.on("error", () => {});
    ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        type: "auth",
        token: owner.token,
        protocol: 2,
        ...message,
      }),
    );
    return { ws, messages };
  };
  return { reach, fake, call, owner, url, frames, stream, dir };
}

test("an app opens on the phone in its own thread, is reused, rotates, and goes back to the Mac", async (t) => {
  const { fake, call } = await start(t);
  const opened = await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.state, "running");
  assert.equal(opened.body.name, "Google Chrome");
  assert.equal(opened.body.display, "901");
  assert.deepEqual(opened.body.region, { x: 352, y: 30, w: 500, h: 1084 });
  assert.deepEqual(fake.requests[0], {
    cmd: "open",
    thread: opened.body.id,
    path: CHROME,
    phone: { w: 393, h: 852 },
  });

  // Tapping the same app again resumes its thread: no second window.
  const again = await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  assert.equal(again.body.id, opened.body.id);
  assert.equal(fake.requests.filter((r) => r.cmd === "open").length, 1);

  // Turning the phone sideways reshapes the window, not the display.
  const turned = await call(`/api/screen/apps/${opened.body.id}`, {
    method: "PATCH",
    body: { width: 852, height: 393 },
  });
  assert.deepEqual(turned.body.region, { x: 0, y: 30, w: 852, h: 393 });
  assert.deepEqual(fake.requests.at(-1), {
    cmd: "rotate",
    thread: opened.body.id,
    phone: { w: 852, h: 393 },
  });

  const list = await call("/api/screen/apps");
  assert.deepEqual(
    list.body.map((x) => [x.name, x.state]),
    [["Google Chrome", "running"]],
  );

  const closed = await call(`/api/screen/apps/${opened.body.id}`, {
    method: "DELETE",
  });
  assert.deepEqual(closed.body, { closed: true, returned: false });
  assert.deepEqual(fake.requests.at(-1), {
    cmd: "close",
    thread: opened.body.id,
  });
  assert.deepEqual((await call("/api/screen/apps")).body, []);
});

test("learned minimum sizes are kept by app ID as keys only, validated when read back", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-app-minimums-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "app-threads.json");
  // A hand-edited file: only well-formed sizes come back.
  fs.writeFileSync(file, `{"threads":[],"minimums":{"__proto__":{"w":1,"h":1},${JSON.stringify(NOTES)}:{"w":400,"h":0},${JSON.stringify(CHROME)}:{"w":"wide"}}}`);
  const odd = ["__proto__", "toString", "constructor"];
  const fake = fakeHelper();
  const make = () => new AppThreads({
    file,
    platform: "darwin",
    listApps: async () => [NOTES, ...odd].map((id) => ({ id, name: id })),
    startHelper: fake.start,
  });
  const phone = { width: 393, height: 852 };
  const threads = make();
  t.after(() => threads.shutdown());
  // Names that are also Object's own never read as a learned size.
  for (const id of odd) await threads.open(id, phone);
  const opens = fake.requests.filter((r) => r.cmd === "open");
  assert.deepEqual(opens.map((r) => r.minimum), [{ w: 1, h: 1 }, undefined, undefined]);
  // The helper's answer is learned for each, kept and saved by its exact ID.
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).minimums;
  assert.deepEqual(Object.keys(saved).sort(), [NOTES, ...odd].sort());
  assert.deepEqual(saved.toString, { w: 500, h: 0 });
  await threads.shutdown();
  const again = make();
  t.after(() => again.shutdown());
  fake.requests.length = 0;
  await again.open("constructor", phone);
  await again.open(NOTES, phone);
  assert.deepEqual(fake.requests.filter((r) => r.cmd === "open").map((r) => r.minimum), [{ w: 500, h: 0 }, { w: 400, h: 0 }]);
});

test("only the computer's owner can open apps, with screen viewing on, from its app list", async (t) => {
  const { reach, call } = await start(t);
  const agent = reach.auth.issue("agent", ["screen", "apps"], "agent");
  const open = (body, token) =>
    call("/api/screen/apps", { method: "POST", body, token });
  assert.equal(
    (await open({ appId: CHROME, width: 393, height: 852 }, agent.token))
      .status,
    403,
  );
  assert.equal(
    (await call("/api/screen/apps", { token: agent.token })).status,
    403,
  );
  assert.equal(
    (await open({ appId: "/Applications/Nope.app", width: 393, height: 852 }))
      .status,
    404,
  );
  for (const size of [
    { width: 50, height: 852 },
    { width: 393 },
    { width: "393px", height: 852 },
  ])
    assert.equal((await open({ appId: CHROME, ...size })).status, 400);
  await call("/api/settings", { method: "POST", body: { screen: false } });
  assert.equal(
    (await open({ appId: CHROME, width: 393, height: 852 })).status,
    403,
  );
});

test("apps on the phone need a Mac for now", async (t) => {
  const { call } = await start(t, { overrides: { appPlatform: "win32" } });
  const result = await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  assert.equal(result.status, 501);
});

test("hidden app displays stay out of Screen's display list", async (t) => {
  const { call } = await start(t);
  await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  const { body } = await call("/api/screen/displays");
  assert.deepEqual(
    body.displays.map((d) => d.id),
    ["1"],
  );
});

test("app streams show only the app's window, at the highest quality, and follow its changes", async (t) => {
  const { call, stream, frames, fake } = await start(t);
  const opened = (
    await call("/api/screen/apps", {
      method: "POST",
      body: { appId: CHROME, width: 393, height: 852 },
    })
  ).body;
  const viewer = await stream({
    thread: opened.id,
    format: "h264",
    display: opened.display,
  });
  await until(() => viewer.messages.some((m) => m.type === "ready"));
  await until(() => frames.length === 1);
  // Full sharpness for this phone (393 points × 3 pixels), and no more: extra
  // pixels only cost the phone decoding and drawing time, which shows as lag.
  assert.deepEqual(frames[0], {
    ...APP_STREAM,
    width: 1179,
    display: opened.display,
    format: "h264",
    region: opened.region,
  });
  assert.deepEqual(APP_STREAM, {
    quality: "auto",
    width: 2560,
    fps: 60,
    bitrate: 16000000,
  });
  await until(() => viewer.messages.some((m) => Buffer.isBuffer(m)));

  // The app resized its window: viewers reconnect for the new crop.
  fake.current.onEvent({
    event: "region",
    thread: opened.id,
    region: { x: 300, y: 30, w: 552, h: 1084 },
  });
  await until(() => viewer.messages.some((m) => m.type === "error"));
  assert.equal(viewer.messages.find((m) => m.type === "error").retryable, true);
  const again = await stream({ thread: opened.id, format: "h264" });
  await until(() => frames.length === 2);
  assert.deepEqual(frames[1].region, { x: 300, y: 30, w: 552, h: 1084 });

  // Returned to the Mac: the stream ends for good.
  await call(`/api/screen/apps/${opened.id}`, { method: "DELETE" });
  await until(() => again.messages.some((m) => m.type === "error"));
  assert.equal(again.messages.find((m) => m.type === "error").retryable, false);

  // A thread that isn't running can't be streamed.
  const stale = await stream({ thread: opened.id, format: "h264" });
  await until(() => stale.messages.some((m) => m.type === "error"));
  assert.match(
    stale.messages.find((m) => m.type === "error").error,
    /isn't open/,
  );
});

test("threads come back paused after a restart, and the Mac's menu can take every app back", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-apps-data-"));
  const first = await start(t, { dataDir });
  const opened = (
    await first.call("/api/screen/apps", {
      method: "POST",
      body: { appId: NOTES, width: 393, height: 852 },
    })
  ).body;
  await first.reach.close();
  // Shutting down closes the helper, which gives every window back.
  assert.equal(first.fake.stops, 1);

  const second = await start(t, { dataDir });
  const listed = (await second.call("/api/screen/apps")).body;
  assert.deepEqual(
    listed.map((x) => [x.id, x.state, x.display]),
    [[opened.id, "paused", undefined]],
  );
  // One tap reopens it, with the app's learned minimum size as a hint.
  const reopened = await second.call("/api/screen/apps", {
    method: "POST",
    body: { appId: NOTES, width: 393, height: 852 },
  });
  assert.equal(reopened.body.id, opened.id);
  assert.deepEqual(second.fake.requests[0].minimum, { w: 500, h: 0 });

  // "Return all to this Mac", clicked on the Mac.
  second.fake.current.onEvent({ event: "released", thread: opened.id });
  assert.equal((await second.call("/api/screen/apps")).body[0].state, "paused");

  // The app closed its window itself: the thread says so.
  await second.call("/api/screen/apps", {
    method: "POST",
    body: { appId: NOTES, width: 393, height: 852 },
  });
  second.fake.current.onEvent({ event: "closed", thread: opened.id });
  assert.equal((await second.call("/api/screen/apps")).body[0].state, "closed");

  // If the helper dies, its displays die with it and threads pause.
  await second.call("/api/screen/apps", {
    method: "POST",
    body: { appId: NOTES, width: 393, height: 852 },
  });
  await second.fake.current.stop();
  assert.equal((await second.call("/api/screen/apps")).body[0].state, "paused");
});

test("turning screen viewing off gives every app back to the Mac", async (t) => {
  const { call, fake } = await start(t);
  await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  await call("/api/settings", { method: "POST", body: { screen: false } });
  await until(() => fake.requests.some((r) => r.cmd === "close"));
  await call("/api/settings", { method: "POST", body: { screen: true } });
  assert.equal((await call("/api/screen/apps")).body[0].state, "paused");
});

test("phone sizes are whole points within a phone or tablet's range", () => {
  assert.deepEqual(phoneViewport({ width: 393.4, height: 852 }), {
    width: 393,
    height: 852,
    scale: 3,
  });
  assert.deepEqual(
    phoneViewport({ width: 440, height: 956, scale: 3 }).scale,
    3,
  );
  assert.equal(phoneViewport({ width: 393, height: 852, scale: 2.2 }).scale, 2);
  for (const scale of [0, 5, "x"])
    assert.throws(
      () => phoneViewport({ width: 393, height: 852, scale }),
      /density/,
    );
  for (const bad of [
    {},
    { width: 0, height: 852 },
    { width: 393, height: 5000 },
    { width: NaN, height: 852 },
  ])
    assert.throws(() => phoneViewport(bad), /screen size/);
});

test(
  "the app display helper builds from source and reports what this Mac allows",
  { skip: process.platform !== "darwin" && "needs macOS", timeout: 120000 },
  async () => {
    const { appDisplaysBinary } = await import("../server/app-threads.mjs");
    const { execFileSync } = await import("node:child_process");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-app-helper-"));
    const binary = await appDisplaysBinary({ dataDir });
    assert.match(path.basename(binary), /^reach-app-displays-[0-9a-f]{12}$/);
    // Cached under its source hash: a second call reuses the build.
    assert.equal(await appDisplaysBinary({ dataDir }), binary);
    const probe = JSON.parse(execFileSync(binary, ["--probe"]).toString());
    assert.deepEqual(Object.keys(probe).sort(), [
      "accessibility",
      "available",
      "screenRecording",
    ]);
    for (const value of Object.values(probe))
      assert.equal(typeof value, "boolean");
  },
);

test("quitting an app asks first when it also has windows on the Mac, then ends its thread", async (t) => {
  const { call, fake, stream } = await start(t);
  fake.quitReplies = [{ confirm: true, others: 2 }, { quit: true }];
  const opened = (
    await call("/api/screen/apps", {
      method: "POST",
      body: { appId: CHROME, width: 393, height: 852 },
    })
  ).body;
  const viewer = await stream({ thread: opened.id, format: "h264" });
  await until(() => viewer.messages.some((m) => m.type === "ready"));
  const ask = await call(`/api/screen/apps/${opened.id}/quit`, {
    method: "POST",
    body: {},
  });
  assert.deepEqual(ask.body, { confirm: true, others: 2 });
  assert.deepEqual(fake.requests.at(-1), {
    cmd: "quit",
    thread: opened.id,
    confirm: false,
  });
  assert.equal((await call("/api/screen/apps")).body[0].state, "running");
  const quit = await call(`/api/screen/apps/${opened.id}/quit`, {
    method: "POST",
    body: { confirm: true },
  });
  assert.deepEqual(quit.body, { quit: true });
  assert.deepEqual(fake.requests.at(-1), {
    cmd: "quit",
    thread: opened.id,
    confirm: true,
  });
  assert.deepEqual((await call("/api/screen/apps")).body, []);
  await until(() => viewer.messages.some((m) => m.type === "error"));
  const ended = viewer.messages.find((m) => m.type === "error");
  assert.equal(ended.retryable, false);
  assert.match(ended.error, /Google Chrome quit/);
});

test("an app asking to save stays open until it quits, also when quit on the Mac", async (t) => {
  const { call, fake } = await start(t);
  fake.quitReplies = [{ quit: false, waiting: true }];
  const opened = (
    await call("/api/screen/apps", {
      method: "POST",
      body: { appId: NOTES, width: 393, height: 852 },
    })
  ).body;
  const asked = await call(`/api/screen/apps/${opened.id}/quit`, {
    method: "POST",
    body: { confirm: true },
  });
  assert.deepEqual(asked.body, { quit: false, waiting: true });
  assert.equal((await call("/api/screen/apps")).body[0].state, "running");
  // The question was answered on the phone; the app quits.
  fake.current.onEvent({ event: "quit", thread: opened.id });
  assert.deepEqual((await call("/api/screen/apps")).body, []);
  // A paused thread just goes away; there is nothing to quit.
  await call("/api/screen/apps", {
    method: "POST",
    body: { appId: NOTES, width: 393, height: 852 },
  });
  const again = (await call("/api/screen/apps")).body[0];
  fake.current.onEvent({ event: "released", thread: again.id });
  const removed = await call(`/api/screen/apps/${again.id}/quit`, {
    method: "POST",
    body: {},
  });
  assert.deepEqual(removed.body, { quit: false, removed: true });
  assert.deepEqual((await call("/api/screen/apps")).body, []);
});

test("text fields come back in window points, for the phone's instant keyboard", async (t) => {
  const { reach, call, fake } = await start(t);
  fake.fieldsReply = {
    fields: [
      { x: 10, y: 52, w: 300, h: 30, secure: false },
      { x: 20, y: 400, w: 200, h: 28, secure: true },
      { x: 1, y: 2, w: 3, h: "tall" },
    ],
    complete: true,
  };
  const opened = (
    await call("/api/screen/apps", {
      method: "POST",
      body: { appId: CHROME, width: 393, height: 852 },
    })
  ).body;
  const result = await call(`/api/screen/apps/${opened.id}/fields`);
  assert.deepEqual(result.body, {
    fields: [
      { x: 10, y: 52, w: 300, h: 30, secure: false },
      { x: 20, y: 400, w: 200, h: 28, secure: true },
    ],
    complete: true,
  });
  const agent = reach.auth.issue("agent", ["screen", "apps"], "agent");
  assert.equal(
    (await call(`/api/screen/apps/${opened.id}/fields`, { token: agent.token }))
      .status,
    403,
  );
  assert.equal((await call(`/api/screen/apps/nope/fields`)).status, 404);
});

test("app streams are as sharp as the phone's screen, never sharper", async (t) => {
  const { call, stream, frames } = await start(t);
  const opened = (
    await call("/api/screen/apps", {
      method: "POST",
      body: { appId: CHROME, width: 440, height: 956, scale: 2 },
    })
  ).body;
  const viewer = await stream({ thread: opened.id, format: "h264" });
  await until(() => frames.length === 1);
  assert.equal(frames[0].width, 880);
  viewer.ws.close();
});

test("a phone's video trouble lands in Reach's log, briefly and safely", async (t) => {
  const { call, stream, frames } = await start(t);
  const opened = (
    await call("/api/screen/apps", {
      method: "POST",
      body: { appId: CHROME, width: 440, height: 956, scale: 3 },
    })
  ).body;
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.join(" "));
  t.after(() => (console.warn = warn));
  const viewer = await stream({ thread: opened.id, format: "h264", maxWidth: 1000 });
  await until(() => frames.length === 1);
  // The phone's own cap wins when it's smaller than the app's window.
  assert.equal(frames[0].width, 1000);
  viewer.ws.send(JSON.stringify({ type: "diagnostic", text: "decoder reset:\nbad\u0007 " + "x".repeat(400) }));
  viewer.ws.send(JSON.stringify({ type: "diagnostic", text: "flood" }));
  // Never held back: the phone's video just dropped to still images.
  viewer.ws.send(JSON.stringify({ type: "diagnostic", text: "switching to still images: Decoder failure" }));
  viewer.ws.send(JSON.stringify({ type: "ack", id: 1 }));
  await until(() => logged.length === 2);
  await new Promise((r) => setTimeout(r, 50));
  const ours = logged.filter((line) => line.startsWith("Reach: phone video: "));
  assert.equal(ours.length, 2, "one line per phone every few seconds, and the switch");
  assert.match(ours[0], /^Reach: phone video: decoder reset: bad  x+$/);
  assert.equal(ours[0].length, "Reach: phone video: ".length + 300);
  assert.equal(ours[1], "Reach: phone video: switching to still images: Decoder failure");
  viewer.ws.close();
});

test("two opens of one app at once share one thread (a double tap, or two of your devices)", async (t) => {
  // The Mac's app list takes a moment, as it does for real: both opens wait
  // on it together.
  const { fake, call } = await start(t, {
    overrides: {
      appList: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [
          { id: CHROME, name: "Google Chrome" },
          { id: NOTES, name: "Notes" },
        ];
      },
    },
  });
  const open = () =>
    call("/api/screen/apps", {
      method: "POST",
      body: { appId: CHROME, width: 393, height: 852 },
    });
  const [a, b] = await Promise.all([open(), open()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id, "one thread");
  assert.equal(fake.requests.filter((r) => r.cmd === "open").length, 1, "one window moved, one display");
  assert.equal((await call("/api/screen/apps")).body.length, 1);
});

test("when macOS won't let Reach watch the Mac's own mouse, Reach's log says so", async (t) => {
  const { fake, call } = await start(t);
  await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  const logged = [];
  const log = console.log;
  console.log = (...args) => logged.push(args.join(" "));
  t.after(() => (console.log = log));
  fake.current.onEvent({ event: "pointer-guard", ok: false });
  console.log = log;
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Reach: macOS didn't let Reach watch this Mac's own mouse/);
  assert.match(logged[0], /Accessibility/);
});

test("a guest's phone hears that an app left their list (it used to stay stuck on Opening…)", async (t) => {
  const { reach, call, url } = await start(t);
  const ali = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "Ali", ttlSeconds: 600, screen: "control", apps: "all" }).invitation,
  );
  const opened = await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  // Ali's live connection, as the phone keeps it.
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/presence");
  t.after(() => ws.terminate());
  const snapshots = [];
  ws.on("message", (data) => snapshots.push(JSON.parse(data)));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", token: ali.token, kind: "phone" }));
  const latest = async (test) => {
    for (let i = 0; i < 60; i++) {
      const last = snapshots.at(-1);
      if (last?.changes && test(last.changes)) return last.changes;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("no matching snapshot");
  };
  const before = await latest((c) => typeof c.apps === "string");
  // You give Chrome back to the Mac: Ali's fingerprint changes at once.
  await call(`/api/screen/apps/${opened.body.id}`, { method: "DELETE" });
  const after = await latest((c) => c.apps !== before.apps);
  assert.notEqual(after.apps, before.apps);
  assert.deepEqual((await call("/api/screen/apps", { token: ali.token })).body, []);
});
