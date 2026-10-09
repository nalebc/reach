import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { AgentApps, agentActions, jpegSize } from "../server/agent-apps.mjs";
import { PassThrough } from "node:stream";
import {
  serveMcp,
  toContent,
  toolsFor,
  tools,
} from "../scripts/mcp-server.mjs";

// Tag in, server side: an agent with apps:drive opens an app on its own
// hidden display, looks at it, acts in it, and hands it to the person. The
// native helpers (hidden displays, capture, input) are recording fakes; the
// routes, scopes and every guard are real.
const CHROME = "/Applications/Google Chrome.app";
const NOTES = "/System/Applications/Notes.app";
const SAFARI = "/Applications/Safari.app";
const MAIL = "/System/Applications/Mail.app";
const MAPS = "/System/Applications/Maps.app";
const APPS = [
  { id: CHROME, name: "Google Chrome" },
  { id: NOTES, name: "Notes" },
  { id: SAFARI, name: "Safari" },
  { id: MAIL, name: "Mail" },
  { id: MAPS, name: "Maps" },
];
const REGION = { x: 352, y: 30, w: 500, h: 1084 };
const SIZE = { w: 852, h: 1130 };

// The frame header of a JPEG `width` by `height` (enough for jpegSize).
function jpeg(width, height) {
  return Buffer.from([
    0xff,
    0xd8,
    // APP0 (JFIF), 16 bytes long.
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // DHT, a marker in the SOF range that is not a frame header.
    0xff,
    0xc4,
    0x00,
    0x04,
    0x00,
    0x00,
    // SOF0: precision, height, width, 3 components.
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  ]);
}

function fakeHelper() {
  const fake = { requests: [], displays: 0 };
  fake.start = async ({ onExit }) => {
    const helper = {
      stopped: false,
      async request(cmd, payload = {}) {
        fake.requests.push({ cmd, ...payload });
        // As the real helper: rather than lend a window of an app that has
        // windows (Notes), `lend: false` is refused with code "lend".
        if (cmd === "open" && payload.lend === false && fake.lends?.has(payload.path))
          throw Object.assign(new Error("That app would lend a window someone may be using."), { status: 409, code: "lend" });
        if (cmd === "open")
          return {
            thread: payload.thread,
            display: String(900 + ++fake.displays),
            size: SIZE,
            region: REGION,
            scale: 2,
            created: true,
            app: { name: APPS.find((x) => x.id === payload.path)?.name },
          };
        if (cmd === "close") return { closed: true, returned: false };
        return { ok: true };
      },
      async stop() {
        helper.stopped = true;
        onExit();
      },
    };
    return helper;
  };
  return fake;
}

async function start(
  t,
  { idle = 60, picture = jpeg(500, 1084), threads, inApp } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-apps-"));
  const dataDir = path.join(dir, "private");
  if (threads) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dataDir, "app-threads.json"),
      JSON.stringify({ threads }),
    );
  }
  const fake = fakeHelper();
  const input = { sent: [], created: [], stopped: 0 };
  // The Mac's idle clock as HID keeps it: any input resets it, Reach's
  // own clicks included. `idle` sets how long ago the last input was.
  const state = {
    lastInput: Date.now() - idle * 1000,
    captures: [],
    inApp: [],
  };
  const reach = await createReach({
    roots: [dir],
    dataDir,
    screen: true,
    appPlatform: "darwin",
    appDisplays: fake.start,
    appList: async () => APPS,
    appScreenFactory: async (options) => {
      state.captures.push(options);
      return () => ({ next: async () => picture, stop() {} });
    },
    agentIdle: async () => (Date.now() - state.lastInput) / 1000,
    // The agent-only helper (actions inside the app): `inApp(command)`
    // answers each one; none given, there's no such helper.
    ...(inApp && {
      agentTargeted: () => ({
        async send(command) {
          state.inApp.push(command);
          return inApp(command);
        },
        stop() {},
      }),
    }),
    agentInputFactory: (config, display) => {
      input.created.push(display);
      return {
        async send(action) {
          input.sent.push(action);
          state.lastInput = Date.now();
          return { ok: true };
        },
        stop() {
          input.stopped++;
        },
      };
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("Claude", ["device", "apps:drive"], "agent");
  const call = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const as =
    (token) =>
    (route, options = {}) =>
      call(route, { ...options, token });
  t.after(() => reach.close());
  return {
    url,
    reach,
    fake,
    input,
    state,
    call,
    agent: as(agent.token),
    agentId: agent.clientId,
    owner,
  };
}

test("an agent opens an app on its own phone-shaped hidden display, and the phone sees whose it is", async (t) => {
  const { fake, call, agent } = await start(t);
  const listed = await agent("/api/drive/apps");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { open: [], installed: APPS });

  const opened = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: CHROME },
  });
  assert.equal(opened.status, 201);
  assert.deepEqual(
    {
      app: opened.body.app,
      appId: opened.body.appId,
      state: opened.body.state,
    },
    { app: "Google Chrome", appId: CHROME, state: "running" },
  );
  assert.deepEqual(
    fake.requests.filter((r) => r.cmd === "open").map((r) => r.phone),
    [{ w: 393, h: 852 }],
  );
  const phone = await call("/api/screen/apps");
  assert.deepEqual(
    phone.body.map((t) => [t.name, t.agent]),
    [["Google Chrome", "Claude"]],
  );
  // Opening it again reuses it.
  const again = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: CHROME },
  });
  assert.equal(again.body.id, opened.body.id);
  assert.equal(fake.requests.filter((r) => r.cmd === "open").length, 1);
  assert.deepEqual(
    (await agent("/api/drive/apps")).body.open.map((t) => t.id),
    [opened.body.id],
  );
});

test("without apps:drive an agent can't reach the routes, and its MCP tools stay hidden", async (t) => {
  const { reach, call } = await start(t);
  const exec = reach.auth.issue("Shell", ["device", "exec"], "agent");
  const r = await call("/api/drive/apps", { token: exec.token });
  assert.equal(r.status, 403);
  const driveTools = tools
    .map((t) => t.name)
    .filter((n) =>
      [
        "reach_list_apps",
        "reach_open_app",
        "reach_see_app",
        "reach_app_action",
        "reach_hand_to_person",
        "reach_wait_for_person",
        "reach_close_app",
      ].includes(n),
    );
  assert.equal(driveTools.length, 7);
  assert.deepEqual(
    toolsFor(["device", "exec"]).map((t) => t.name),
    ["reach_device", "reach_run_command", "reach_get_job", "reach_cancel_job"],
  );
  assert.deepEqual(
    toolsFor(["device", "apps:drive"]).map((t) => t.name),
    ["reach_device", ...driveTools],
  );
});

test("a full-access guest never gets apps:drive", async (t) => {
  const { reach } = await start(t);
  reach.auth.inviteGuest({ name: "Sam", full: true, ttlSeconds: 1800 });
  const client = reach.auth.list().find((c) => c.kind === "guest");
  assert.ok(client.scopes.includes("admin"), "full access");
  assert.equal(client.scopes.includes("apps:drive"), false);
});

test("an agent never takes an app a person has open, nor makes room by closing theirs", async (t) => {
  const paused = [CHROME, NOTES, SAFARI, MAIL].map((appId, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    appId,
    name: APPS[i].name,
    createdAt: `2026-10-0${i + 1}T00:00:00.000Z`,
  }));
  const { fake, call, agent } = await start(t, { threads: paused });
  const taken = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: NOTES },
  });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /Notes is open on someone's phone/);
  const full = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: MAPS },
  });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /Four apps are already open/);
  assert.equal(fake.requests.filter((r) => r.cmd === "open").length, 0);
  assert.deepEqual(
    (await call("/api/screen/apps")).body.map((t) => t.id).sort(),
    paused.map((t) => t.id).sort(),
    "the person's apps are all still there",
  );
  // And it can't act in someone else's app by its id.
  const other = await agent(`/api/drive/apps/${paused[0].id}/actions`, {
    method: "POST",
    body: { type: "click", x: 1, y: 1 },
  });
  assert.equal(other.status, 404);
});

test("a look gives the window's picture; actions land where the agent pointed in it", async (t) => {
  const { input, state, agent } = await start(t, { picture: jpeg(250, 542) });
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  // Before any look, the window's points are the pixels.
  const before = await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "click", x: 100, y: 200 },
  });
  assert.equal(before.status, 200);
  const seen = await agent(`/api/drive/apps/${id}`);
  assert.equal(seen.status, 200);
  assert.deepEqual(
    [seen.body.width, seen.body.height, seen.body.mimeType],
    [250, 542, "image/jpeg"],
  );
  assert.deepEqual(Buffer.from(seen.body.image, "base64"), jpeg(250, 542));
  assert.deepEqual(state.captures.at(-1), {
    display: "901",
    region: REGION,
    format: "jpeg",
    fps: 2,
    width: 500,
    bitrate: 2000000,
  });
  // After it, the picture's pixels (half size here).
  await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "click", x: 100, y: 200, count: 2 },
  });
  await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "type", text: "hello" },
  });
  await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "key", key: "l", modifiers: ["meta"] },
  });
  assert.deepEqual(input.created, ["901"], "one input helper, kept");
  assert.deepEqual(input.sent, [
    {
      type: "click",
      x: (352 + 100) / 852,
      y: (30 + 200) / 1130,
      button: "left",
      count: 1,
    },
    {
      type: "click",
      x: (352 + 200) / 852,
      y: (30 + 400) / 1130,
      button: "left",
      count: 2,
    },
    { type: "text", text: "hello" },
    { type: "key", key: "l", modifiers: ["meta"] },
  ]);
  const outside = await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "click", x: 251, y: 10 },
  });
  assert.equal(outside.status, 400);
  assert.equal(input.sent.length, 4);
});

test("an agent waits while someone uses the Mac", async (t) => {
  const { input, state, agent } = await start(t, { idle: 60 });
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  // Then someone uses the Mac (3 s ago).
  state.lastInput = Date.now() - 3000;
  const click = () =>
    agent(`/api/drive/apps/${id}/actions`, {
      method: "POST",
      body: { type: "click", x: 10, y: 10 },
    });
  let r = await click();
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, {
    waiting: true,
    error: "Someone is using the Mac. Try again in 12 s.",
  });
  assert.equal(input.sent.length, 0);
});

test("an agent waits while a phone controls the screen or Reach is paused, then acts", async (t) => {
  const { input, call, agent } = await start(t, { idle: 60 });
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const click = () =>
    agent(`/api/drive/apps/${id}/actions`, {
      method: "POST",
      body: { type: "click", x: 10, y: 10 },
    });
  assert.equal(
    (
      await call("/api/screen/control", {
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    200,
  );
  let r = await click();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /owner is using the screen from a phone/);
  await call("/api/screen/control", {
    method: "POST",
    body: { enabled: false },
  });
  await call("/api/settings/pause", { method: "POST", body: { paused: true } });
  r = await click();
  assert.equal(r.status, 423);
  assert.equal(r.body.waiting, true);
  assert.equal(input.sent.length, 0, "nothing reached the Mac");
  await call("/api/settings/pause", {
    method: "POST",
    body: { paused: false },
  });
  // Reach's pause gave the app back to the Mac: the agent opens it again.
  if ((await agent("/api/drive/apps")).body.open[0]?.state !== "running")
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } });
  r = await click();
  assert.equal(r.status, 200);
  assert.equal(input.sent.length, 1);
});

test("an agent's own clicks don't count as someone at the Mac; a person's do", async (t) => {
  const { input, state, agent } = await start(t, { idle: 60 });
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const click = () =>
    agent(`/api/drive/apps/${id}/actions`, {
      method: "POST",
      body: { type: "click", x: 10, y: 10 },
    });
  // Several in a row: each one resets the Mac's idle clock, as it does.
  for (let i = 0; i < 3; i++) assert.equal((await click()).status, 200);
  // A scroll is several steps: none of them blocks the next.
  const scrolled = await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "scroll", x: 10, y: 10, dy: 300 },
  });
  assert.equal(scrolled.status, 200);
  assert.equal(input.sent.length, 3 + 4);
  // Then a person moves the mouse.
  await new Promise((r) => setTimeout(r, 700));
  state.lastInput = Date.now();
  const r = await click();
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, {
    waiting: true,
    error: "Someone is using the Mac. Try again in 15 s.",
  });
  assert.equal(input.sent.length, 7, "nothing more reached the Mac");
});

test("an agent hands the live app to the person, waits, and gets it back with their note", async (t) => {
  const { input, agent, call } = await start(t);
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const empty = await agent(`/api/drive/apps/${id}/handoff`, {
    method: "POST",
    body: { reason: "  " },
  });
  assert.equal(empty.status, 400);
  const handed = await agent(`/api/drive/apps/${id}/handoff`, {
    method: "POST",
    body: { reason: "Type the sign-in code from your texts." },
  });
  assert.equal(handed.status, 201);
  assert.deepEqual(
    { app: handed.body.app, state: handed.body.state },
    { app: "Google Chrome", state: "waiting" },
  );
  const pending = (await call("/api/handoffs")).body;
  assert.deepEqual(
    pending.map((h) => [h.id, h.threadId, h.agent, h.app, h.reason]),
    [
      [
        handed.body.handoff,
        id,
        "Claude",
        "Google Chrome",
        "Type the sign-in code from your texts.",
      ],
    ],
  );
  // The agent can't act while the person has it, but may look.
  const act = await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "click", x: 1, y: 1 },
  });
  assert.equal(act.status, 409);
  assert.match(act.body.error, /with the person/);
  assert.equal((await agent(`/api/drive/apps/${id}`)).status, 200);
  assert.equal(input.sent.length, 0);
  // Phones can't hand back what isn't theirs to see: agents can't call it.
  assert.equal(
    (
      await agent(`/api/handoffs/${handed.body.handoff}`, {
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  const now = await agent(`/api/drive/handoffs/${handed.body.handoff}?wait=0`);
  assert.deepEqual(now.body, {
    handoff: handed.body.handoff,
    app: "Google Chrome",
    state: "waiting",
  });
  // A waiting agent hears at once when the person hands it back.
  const started = Date.now();
  const waited = agent(`/api/drive/handoffs/${handed.body.handoff}?wait=20`);
  await new Promise((r) => setTimeout(r, 100));
  const back = await call(`/api/handoffs/${handed.body.handoff}`, {
    method: "POST",
    body: { note: "Done, code entered." },
  });
  assert.equal(back.body.state, "back");
  assert.deepEqual((await waited).body, {
    handoff: handed.body.handoff,
    app: "Google Chrome",
    state: "back",
    note: "Done, code entered.",
  });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual((await call("/api/handoffs")).body, []);
  assert.equal(
    (
      await agent(`/api/drive/apps/${id}/actions`, {
        method: "POST",
        body: { type: "click", x: 1, y: 1 },
      })
    ).status,
    200,
  );
});

test("a hand-off reaches the person's phone at once, over its live connection", async (t) => {
  const { url, owner, agent } = await start(t);
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/presence");
  t.after(() => ws.terminate());
  const snapshots = [];
  ws.on("message", (data) => snapshots.push(JSON.parse(data)));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "auth", token: owner.token, kind: "phone" }),
    ),
  );
  const until = async (check) => {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw Error("no snapshot");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until(() => snapshots.some((s) => s.changes?.handoffs));
  const before = snapshots.at(-1).changes.handoffs;
  await agent(`/api/drive/apps/${id}/handoff`, {
    method: "POST",
    body: { reason: "Approve the payment." },
  });
  await until(() => snapshots.at(-1).changes?.handoffs !== before);
});

test("a full-access guest can't see or answer what agents hand you", async (t) => {
  const { reach, call, agent, url } = await start(t);
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const { handoff } = (
    await agent(`/api/drive/apps/${id}/handoff`, {
      method: "POST",
      body: { reason: "Approve the payment." },
    })
  ).body;
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "Sam", full: true, ttlSeconds: 600 })
      .invitation,
  );
  assert.equal(
    (await call("/api/handoffs", { token: guest.token })).status,
    403,
  );
  assert.equal(
    (
      await call(`/api/handoffs/${handoff}`, {
        token: guest.token,
        method: "POST",
        body: { stop: true },
      })
    ).status,
    403,
  );
  assert.equal(
    (await agent(`/api/drive/handoffs/${handoff}?wait=0`)).body.state,
    "waiting",
  );
  // Nor does its live connection carry the hand-offs' fingerprint.
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/presence");
  t.after(() => ws.terminate());
  const first = new Promise((resolve) =>
    ws.once("message", (d) => resolve(JSON.parse(d))),
  );
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "auth", token: guest.token, kind: "phone" }),
    ),
  );
  const snapshot = await first;
  assert.ok(snapshot.changes, "a snapshot with change fingerprints");
  assert.equal("handoffs" in snapshot.changes, false);
});

test("the person can tell the agent to stop", async (t) => {
  const { agent, call } = await start(t);
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const { handoff } = (
    await agent(`/api/drive/apps/${id}/handoff`, {
      method: "POST",
      body: { reason: "Is this the right flight?" },
    })
  ).body;
  await call(`/api/handoffs/${handoff}`, {
    method: "POST",
    body: { stop: true, note: "No, cancel this." },
  });
  assert.deepEqual(
    (await agent(`/api/drive/handoffs/${handoff}?wait=0`)).body,
    {
      handoff,
      app: "Google Chrome",
      state: "stopped",
      note: "No, cancel this.",
    },
  );
});

test("an agent leaves when its access is revoked: its apps go back to the Mac", async (t) => {
  const { fake, call, agent, agentId } = await start(t);
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  const { handoff } = (
    await agent(`/api/drive/apps/${id}/handoff`, {
      method: "POST",
      body: { reason: "Check this." },
    })
  ).body;
  assert.equal(
    (await call(`/api/clients/${agentId}`, { method: "DELETE" })).status,
    200,
  );
  const until = Date.now() + 2000;
  while (!fake.requests.some((r) => r.cmd === "close" && r.thread === id)) {
    if (Date.now() > until) throw Error("the agent's app wasn't released");
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual((await call("/api/screen/apps")).body, []);
  assert.deepEqual(
    (await call("/api/handoffs")).body,
    [],
    "nothing left waiting",
  );
  assert.equal((await agent("/api/drive/apps")).status, 401);
  void handoff;
});

test("an app the person closes ends for the agent too", async (t) => {
  const { call, agent } = await start(t);
  const { id } = (
    await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } })
  ).body;
  assert.equal(
    (await call(`/api/screen/apps/${id}`, { method: "DELETE" })).status,
    200,
  );
  const r = await agent(`/api/drive/apps/${id}/actions`, {
    method: "POST",
    body: { type: "click", x: 1, y: 1 },
  });
  assert.equal(r.status, 410);
  assert.deepEqual((await agent("/api/drive/apps")).body.open, []);
});

test("agents whose access ended are swept out, and only those", async () => {
  const closed = [];
  const threads = {
    threads: new Map(),
    get(id) {
      return this.threads.get(id);
    },
    async close(id) {
      closed.push(id);
      this.threads.delete(id);
      return { closed: true };
    },
  };
  for (const id of ["a1", "b1"])
    threads.threads.set(id, { id, appId: id, name: id, state: "running" });
  const apps = new AgentApps({ threads, control: { holder: () => null } });
  apps.owners.set("a1", { clientId: "gone", agent: "Old" });
  apps.owners.set("b1", { clientId: "here", agent: "New" });
  assert.equal(await apps.sweep((clientId) => clientId === "here"), 1);
  assert.deepEqual(closed, ["a1"]);
  assert.deepEqual([...apps.owners.keys()], ["b1"]);
});

test("scrolling is split into the Mac's steps, downwards for dy > 0", () => {
  const thread = { region: REGION, size: SIZE };
  const steps = agentActions({ type: "scroll", x: 0, y: 0, dy: 250 }, thread, {
    width: 500,
    height: 1084,
  });
  assert.deepEqual(steps, [
    { type: "move", x: 352 / 852, y: 30 / 1130, button: "left", count: 1 },
    { type: "scroll", dx: -0, dy: -83 },
    { type: "scroll", dx: -0, dy: -83 },
    { type: "scroll", dx: -0, dy: -84 },
  ]);
  assert.throws(
    () => agentActions({ type: "drag" }, thread, { width: 500, height: 1084 }),
    /click, type, key, scroll or menu/,
  );
  assert.throws(
    () =>
      agentActions({ type: "key", key: "F13" }, thread, {
        width: 500,
        height: 1084,
      }),
    /Invalid key/,
  );
});

test("jpegSize reads the frame header, skipping look-alike markers", () => {
  assert.deepEqual(jpegSize(jpeg(393, 852)), { width: 393, height: 852 });
  assert.equal(jpegSize(Buffer.from("frame")), null);
  assert.equal(jpegSize(Buffer.from([0])), null);
});

test("a picture reaches the agent as an image, the rest as text", () => {
  assert.deepEqual(
    toContent({
      image: "AAAA",
      mimeType: "image/jpeg",
      width: 2,
      app: "Notes",
    }),
    [
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      {
        type: "text",
        text: JSON.stringify({ width: 2, app: "Notes" }, null, 2),
      },
    ],
  );
  assert.deepEqual(toContent({ done: true }), [
    { type: "text", text: JSON.stringify({ done: true }, null, 2) },
  ]);
});

test("over MCP, an action is followed by a fresh picture, sent as an image", async () => {
  const calls = [];
  const api = async (route, method = "GET", body) => {
    calls.push([method, route, body]);
    if (route === "/api/device")
      return { access: { scopes: ["device", "apps:drive"] } };
    if (method === "GET" && route === "/api/drive/apps/t1")
      return {
        id: "t1",
        app: "Notes",
        image: "QUJD",
        mimeType: "image/jpeg",
        width: 393,
        height: 852,
      };
    return { done: true };
  };
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = [];
  output.on("data", (b) => lines.push(...b.toString().trim().split("\n")));
  const served = serveMcp({ api, input, output });
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "reach_app_action",
        arguments: { id: "t1", type: "click", x: 5, y: 6 },
      },
    }) + "\n",
  );
  input.end();
  await served;
  assert.deepEqual(calls, [
    ["POST", "/api/drive/apps/t1/actions", { type: "click", x: 5, y: 6 }],
    ["GET", "/api/drive/apps/t1", undefined],
  ]);
  const { result } = JSON.parse(lines[0]);
  assert.deepEqual(result.content[0], {
    type: "image",
    data: "QUJD",
    mimeType: "image/jpeg",
  });
  assert.deepEqual(JSON.parse(result.content[1].text), {
    done: true,
    id: "t1",
    app: "Notes",
    width: 393,
    height: 852,
  });
});

// Parallel: the agent acts inside its own app while you use the Mac.
const openChrome = async (agent) =>
  (await agent("/api/drive/apps", { method: "POST", body: { appId: CHROME } }))
    .body.id;
const act = (agent, id, body) =>
  agent(`/api/drive/apps/${id}/actions`, { method: "POST", body });

test("while you use the Mac, the agent clicks, types and presses keys inside its own app", async (t) => {
  const { input, state, fake, agent } = await start(t, {
    idle: 60,
    inApp: (c) => ({
      done: true,
      kind: { press: "pressed", text: "inserted", key: "posted", menu: "menu" }[
        c.cmd
      ],
    }),
  });
  const id = await openChrome(agent);
  state.lastInput = Date.now() - 3000;
  for (const body of [
    { type: "click", x: 100, y: 200 },
    { type: "type", text: "hello" },
    { type: "key", key: "l", modifiers: ["meta"] },
  ]) {
    const r = await act(agent, id, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { done: true, lane: "app" });
  }
  const base = { app: CHROME, display: "901", thread: id, alone: false };
  const middle = { x: 352 + 250, y: 30 + 542 };
  assert.deepEqual(state.inApp, [
    { ...base, cmd: "press", x: 352 + 100, y: 30 + 200 },
    { ...base, ...middle, cmd: "text", text: "hello" },
    { ...base, ...middle, cmd: "key", key: "l", modifiers: ["meta"] },
  ]);
  assert.deepEqual(input.sent, [], "the Mac's pointer and keyboard untouched");
  assert.equal(
    fake.requests.filter((r) => r.cmd === "activate").length,
    0,
    "nothing brought to the front",
  );
});

test("what the app can't do itself waits for the pointer while you're at the Mac", async (t) => {
  const { input, state, agent } = await start(t, {
    idle: 60,
    inApp: () => ({ done: false, why: "nothing to press there" }),
  });
  const id = await openChrome(agent);
  state.lastInput = Date.now() - 3000;
  let r = await act(agent, id, { type: "click", x: 10, y: 10 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, {
    waiting: true,
    error:
      "Someone is using the Mac, and this needs the pointer (nothing to press there). Try again in 12 s.",
  });
  // A double-click has no in-app form: it needs the pointer at once.
  r = await act(agent, id, { type: "click", x: 10, y: 10, count: 2 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "Someone is using the Mac. Try again in 12 s.");
  assert.equal(state.inApp.length, 1);
  assert.deepEqual(input.sent, []);
});

test("when nobody is at the Mac, an action the app can't do itself uses the pointer", async (t) => {
  const { input, state, fake, agent } = await start(t, {
    idle: 60,
    inApp: () => ({ done: false, why: "nothing to press there" }),
  });
  const id = await openChrome(agent);
  const r = await act(agent, id, { type: "click", x: 100, y: 200 });
  assert.deepEqual(r.body, { done: true, lane: "pointer" });
  assert.equal(state.inApp[0].alone, true);
  assert.deepEqual(input.sent, [
    {
      type: "click",
      x: (352 + 100) / 852,
      y: (30 + 200) / 1130,
      button: "left",
      count: 1,
    },
  ]);
  assert.equal(fake.requests.filter((r) => r.cmd === "activate").length, 1);
});

test("a menu the app won't open says why; a bad menu path is refused", async (t) => {
  const { agent } = await start(t, {
    idle: 60,
    inApp: () => ({ done: false, why: "another window of the app is in use" }),
  });
  const id = await openChrome(agent);
  let r = await act(agent, id, { type: "menu", path: ["Edit", "Select All"] });
  assert.equal(r.status, 409);
  assert.equal(
    r.body.error,
    "Couldn't use that menu: another window of the app is in use.",
  );
  r = await act(agent, id, { type: "menu", path: [] });
  assert.equal(r.status, 400);
});

test("a phone in the agent's own app makes it take turns; a phone elsewhere doesn't", async () => {
  const thread = {
    id: "t1",
    appId: CHROME,
    name: "Google Chrome",
    state: "running",
    display: "901",
    region: REGION,
    size: SIZE,
  };
  const threads = {
    threads: new Map([["t1", thread]]),
    get: (id) => (id === "t1" ? thread : undefined),
    activate: async () => {},
  };
  let on = "901";
  const sent = [];
  const apps = new AgentApps({
    threads,
    control: { holder: () => ({ clientId: "phone", name: "Owner" }) },
    controlDisplay: (clientId) => (clientId === "phone" ? on : undefined),
    idle: async () => 60,
    targeted: () => ({
      send: async (c) => (sent.push(c.cmd), { done: true, kind: "pressed" }),
      stop() {},
    }),
    createInput: () => ({ send: async () => ({}), stop() {} }),
  });
  apps.owners.set("t1", { clientId: "agent", agent: "Claude" });
  const client = { id: "agent" };
  await assert.rejects(apps.act(client, "t1", { type: "click", x: 1, y: 1 }), {
    message:
      "Owner is using Google Chrome from a phone; you take turns in the same app. Try again in a minute.",
  });
  assert.deepEqual(sent, []);
  on = "1";
  assert.deepEqual(
    await apps.act(client, "t1", { type: "click", x: 1, y: 1 }),
    {
      done: true,
      lane: "app",
    },
  );
  // The pointer is the phone's while it controls: that step waits.
  await assert.rejects(
    apps.act(client, "t1", { type: "click", x: 1, y: 1, count: 2 }),
    {
      message:
        "Owner is using the screen from a phone. Try again in a minute.",
    },
  );
  assert.deepEqual(sent, ["press"]);
});

test("a phone's screen control remembers which display it's on", async () => {
  const { EventEmitter } = await import("node:events");
  const { desktopConnection } =
    await import("../server/desktop-connection.mjs");
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close() {},
  });
  const client = { id: "phone", scopes: ["admin", "screen"] };
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => client },
    control: { check() {}, acquire() {}, revoke() {} },
    create: async () => ({ send: async () => ({ cursor: null }), stop() {} }),
  });
  ws.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "auth", token: "T", display: "901" })),
    false,
  );
  const end = Date.now() + 1000;
  while (!ws.sent.some((m) => m.type === "ready") && Date.now() < end)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(ws.reachDisplay, "901");
  ws.emit("close");
});

test("starting an app that isn't running waits while you're at the Mac; one already running opens", async (t) => {
  let running = false;
  const { state, fake, agent } = await start(t, {
    idle: 60,
    inApp: (c) =>
      c.cmd === "running" ? { done: true, running } : { done: true },
  });
  state.lastInput = Date.now() - 3000;
  let r = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: CHROME },
  });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, {
    waiting: true,
    error:
      "Someone is using the Mac, and starting that app could take their focus. Try again in 12 s, or use an app that's already open.",
  });
  assert.deepEqual(state.inApp, [{ cmd: "running", app: CHROME }]);
  assert.equal(fake.requests.filter((x) => x.cmd === "open").length, 0);
  running = true;
  r = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: CHROME },
  });
  assert.equal(r.status, 201);
  assert.equal(fake.requests.filter((x) => x.cmd === "open").length, 1);
});

test("while you're at the Mac, an app that would lend its window waits; a browser opens a window of its own", async (t) => {
  const { state, fake, call, agent } = await start(t, {
    idle: 60,
    inApp: (c) =>
      c.cmd === "running" ? { done: true, running: true } : { done: true },
  });
  fake.lends = new Set([NOTES]);
  state.lastInput = Date.now() - 3000;
  let r = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: NOTES },
  });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, {
    waiting: true,
    error:
      "Someone is using the Mac, and opening that app would take their window. Try again in 12 s.",
  });
  const opens = () => fake.requests.filter((x) => x.cmd === "open");
  assert.equal(opens().at(-1).lend, false);
  // Nothing is left behind: not on the phone, not in the agent's way.
  assert.deepEqual((await call("/api/screen/apps")).body, []);
  assert.deepEqual((await agent("/api/drive/apps")).body.open, []);
  // A browser gets a fresh window, so it opens alongside the person.
  r = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: CHROME },
  });
  assert.equal(r.status, 201);
  assert.equal(opens().at(-1).lend, false);
  // The refused try left nothing that blocks the next one.
  fake.lends.clear();
  r = await agent("/api/drive/apps", {
    method: "POST",
    body: { appId: NOTES },
  });
  assert.equal(r.status, 201);
  // When nobody is at the Mac, Notes may lend its window, as before.
  const alone = await start(t, { idle: 60 });
  r = await alone.agent("/api/drive/apps", {
    method: "POST",
    body: { appId: NOTES },
  });
  assert.equal(r.status, 201);
  assert.equal(
    "lend" in alone.fake.requests.filter((x) => x.cmd === "open").at(-1),
    false,
  );
});

test("menus wait while you're at the Mac", async (t) => {
  const { state, fake, agent } = await start(t, {
    idle: 60,
    inApp: () => ({ done: true, kind: "menu" }),
  });
  const id = await openChrome(agent);
  state.lastInput = Date.now() - 3000;
  const r = await act(agent, id, {
    type: "menu",
    path: ["View", "Reload This Page"],
  });
  assert.equal(r.status, 409);
  assert.equal(
    r.body.error,
    "Someone is using the Mac, and menus need Google Chrome in front. Try again in 12 s.",
  );
  assert.deepEqual(state.inApp, []);
  assert.equal(fake.requests.filter((x) => x.cmd === "activate").length, 0);
});

test("when nobody is at the Mac, a menu brings the app to the front first", async (t) => {
  const { state, fake, agent } = await start(t, {
    idle: 60,
    inApp: () => ({ done: true, kind: "menu" }),
  });
  const id = await openChrome(agent);
  const r = await act(agent, id, {
    type: "menu",
    path: ["View", "Reload This Page"],
  });
  assert.deepEqual(r.body, { done: true, lane: "app" });
  assert.equal(fake.requests.filter((x) => x.cmd === "activate").length, 1);
  assert.deepEqual(state.inApp, [
    {
      app: CHROME,
      display: "901",
      thread: id,
      x: 352 + 250,
      y: 30 + 542,
      cmd: "menu",
      path: ["View", "Reload This Page"],
      alone: true,
    },
  ]);
});
