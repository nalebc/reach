import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, AGENT_SCOPES, createAuth } from "../server/core.mjs";

// Invitations choose exactly what someone may use. The computer enforces it
// on every request: what isn't granted is refused, never just hidden.
const CHROME = "/Applications/Google Chrome.app";
const NOTES = "/System/Applications/Notes.app";

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-perm-"));
  const files = path.join(dir, "files");
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, "a.txt"), "a");
  let displays = 0;
  const reach = await createReach({
    roots: [files],
    dataDir: path.join(dir, "private"),
    screen: true,
    appPlatform: "darwin",
    appDisplays: async ({ onExit }) => ({
      async request(cmd, payload = {}) {
        if (cmd === "open")
          return {
            thread: payload.thread,
            display: String(900 + ++displays),
            size: { w: 852, h: 1130 },
            region: { x: 0, y: 0, w: 852, h: 1130 },
            scale: 2,
            created: true,
            app: { name: "App" },
          };
        if (cmd === "close") return { closed: true, returned: false };
        if (cmd === "quit") return { quit: true };
        if (cmd === "fields") return { fields: [], complete: true };
        return { ok: true };
      },
      async stop() {
        onExit();
      },
    }),
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
    ],
    appScreenFactory: async () => () => ({
      next: async () => Buffer.from("frame"),
      stop() {},
    }),
    remoteScreenFactory: async () => () => ({
      next: async () => Buffer.from("frame"),
      stop() {},
    }),
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
  const call = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => null),
    }));
  const invite = async (grant) => {
    const created = await call("/api/guests", {
      method: "POST",
      body: { name: "Sam", ttlSeconds: 900, ...grant },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const redeemed = await call("/api/guest/redeem", {
      token: "",
      method: "POST",
      body: { invitation: created.body.invitation },
    });
    assert.equal(redeemed.status, 200);
    return { ...redeemed.body, scopes: created.body.scopes };
  };
  // First message of a screen socket: accepted ("ready"/frames) or refused.
  const stream = async (token, message) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen");
    sockets.push(ws);
    ws.on("error", () => {});
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token, protocol: 2, ...message }));
    const [code] = await Promise.race([
      once(ws, "close"),
      new Promise((r) => setTimeout(() => r(["open"]), 700)),
    ]);
    return code;
  };
  return { reach, call, invite, stream, owner };
}

test("scopes: invitations get exactly what was chosen; agents never get control", () => {
  for (const s of ["admin", "screen:control", "apps:open"])
    assert.equal(AGENT_SCOPES.includes(s), false, s);
  assert.ok(
    ALL_SCOPES.includes("screen:control") && ALL_SCOPES.includes("apps:open"),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-perm-scopes-"));
  try {
    const auth = createAuth(
      {
        dataDir: dir,
        roots: [dir],
        agentPolicyFile: path.join(dir, "none.json"),
      },
      { rotatePairing: false },
    );
    const scopes = (grant) =>
      auth.inviteGuest({ name: "x", ttlSeconds: 600, ...grant }).scopes;
    assert.deepEqual(scopes({ roots: [0] }), ["device", "files:read"]);
    assert.deepEqual(scopes({ roots: [0], write: true }), [
      "device",
      "files:read",
      "files:write",
    ]);
    assert.deepEqual(scopes({ screen: true }), ["device", "screen"]);
    assert.deepEqual(scopes({ screen: "view" }), ["device", "screen"]);
    assert.deepEqual(scopes({ screen: "control" }), [
      "device",
      "screen",
      "screen:control",
    ]);
    assert.deepEqual(scopes({ apps: [CHROME] }), ["device", "apps:open"]);
    assert.deepEqual(scopes({ apps: "all" }), ["device", "apps:open"]);
    assert.deepEqual(scopes({ terminal: true }), ["device", "terminal"]);
    assert.deepEqual(scopes({ agents: true }), ["device", "codex"]);
    assert.deepEqual(scopes({ full: true }), ALL_SCOPES);
    for (const bad of [
      {},
      { screen: "watch" },
      { apps: [] },
      { apps: [42] },
      { apps: "some" },
      { terminal: "yes" },
      { roots: [9] },
    ])
      assert.throws(
        () => auth.inviteGuest({ name: "x", ttlSeconds: 600, ...bad }),
        /Choose a guest name/,
        JSON.stringify(bad),
      );
    assert.throws(
      () => auth.issue("agent", ["files", "screen:control"], "agent"),
      /Invalid credential scopes/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an invitation to watch one app: that app's window only, nothing else", async (t) => {
  const { call, invite, stream } = await start(t);
  const guest = await invite({ apps: [CHROME] });
  const as = (route, opts = {}) => call(route, { token: guest.token, ...opts });
  // The app list shows only Chrome; Chrome's window opens and streams.
  const listed = await as("/api/apps");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(
    listed.body.every((a) => a.id === CHROME),
    "only the invited app",
  );
  // Guests don't open apps (that can move your window off your screen):
  // Chrome isn't open yet, so they're told to ask you.
  const early = await as("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  assert.equal(early.status, 403);
  assert.match(early.body.error, /Only the computer's owner can open or close apps/);
  // You open Chrome on your phone; now they can watch it.
  const yours = await call("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  assert.equal(yours.status, 200);
  const opened = await as("/api/screen/apps", {
    method: "POST",
    body: { appId: CHROME, width: 393, height: 852 },
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.id, yours.body.id, "the same window you opened");
  assert.equal(await stream(guest.token, { thread: opened.body.id }), "open");
  assert.equal(
    (
      await as(`/api/screen/apps/${opened.body.id}/activate`, {
        method: "POST",
      })
    ).status,
    200,
  );
  // The owner's Notes window exists, but the guest can't see or touch it.
  const notes = await call("/api/screen/apps", {
    method: "POST",
    body: { appId: NOTES, width: 393, height: 852 },
  });
  assert.equal(notes.status, 200);
  assert.deepEqual(
    (await as("/api/screen/apps")).body.map((t) => t.appId),
    [CHROME],
  );
  assert.equal(
    (await as("/api/screen/apps", { method: "POST", body: { appId: NOTES } }))
      .status,
    403,
  );
  assert.equal(
    (await as(`/api/screen/apps/${notes.body.id}`, { method: "DELETE" }))
      .status,
    403,
  );
  assert.equal(
    (await as(`/api/screen/apps/${notes.body.id}/activate`, { method: "POST" }))
      .status,
    403,
  );
  assert.equal(await stream(guest.token, { thread: notes.body.id }), 4003);
  // Watching only: no typing, no quitting, no whole display.
  assert.equal(
    (await as(`/api/screen/apps/${opened.body.id}/fields`)).status,
    403,
  );
  assert.equal(
    (
      await as(`/api/screen/apps/${opened.body.id}/quit`, {
        method: "POST",
        body: { confirm: true },
      })
    ).status,
    403,
  );
  assert.equal(await stream(guest.token, { display: "1" }), 4003);
  for (const [route, method, body] of [
    ["/api/screen/displays", "GET"],
    ["/api/screen/control", "POST", { enabled: true }],
    ["/api/apps/launch", "POST", { id: CHROME }],
    ["/api/apps/shortcuts", "GET"],
    ["/api/files?root=0&path=", "GET"],
    ["/api/terminals", "GET"],
    ["/api/chats", "GET"],
    ["/api/clients", "GET"],
    ["/api/guests", "POST", { name: "x", ttlSeconds: 600, full: true }],
  ])
    assert.equal(
      (await as(route, { method, body })).status,
      403,
      `${method} ${route}`,
    );
  // Nor can they close or resize it: it's yours.
  assert.equal(
    (await as(`/api/screen/apps/${opened.body.id}`, { method: "DELETE" }))
      .status,
    403,
  );
  assert.equal(
    (
      await as(`/api/screen/apps/${opened.body.id}`, {
        method: "PATCH",
        body: { width: 852, height: 393 },
      })
    ).status,
    403,
  );
});

test("screen control can be granted, and you can always take it back", async (t) => {
  const { call, invite, owner } = await start(t);
  const viewer = await invite({ screen: "view" });
  assert.equal(
    (await call("/api/screen/displays", { token: viewer.token })).body.input,
    false,
  );
  assert.equal(
    (
      await call("/api/screen/control", {
        token: viewer.token,
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    403,
  );
  const controller = await invite({ screen: "control" });
  assert.equal(
    (await call("/api/screen/displays", { token: controller.token })).body
      .input,
    true,
  );
  const lease = await call("/api/screen/control", {
    token: controller.token,
    method: "POST",
    body: { enabled: true },
  });
  assert.equal(lease.status, 200);
  assert.equal(lease.body.enabled, true);
  // The owner takes over; the guest can't take it back from the owner.
  assert.equal(
    (
      await call("/api/screen/control", {
        token: owner.token,
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/screen/control", {
        token: controller.token,
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    409,
  );
  // Control doesn't bring files, terminals or apps with it.
  for (const route of [
    "/api/files?root=0&path=",
    "/api/terminals",
    "/api/screen/apps",
  ])
    assert.equal(
      (await call(route, { token: controller.token })).status,
      403,
      route,
    );
});

test("full access uses the computer like you, but can't manage access", async (t) => {
  const { call, invite } = await start(t);
  const guest = await invite({ full: true });
  const as = (route, opts = {}) => call(route, { token: guest.token, ...opts });
  for (const route of [
    "/api/files?root=0&path=",
    "/api/terminals",
    "/api/screen/apps",
    "/api/apps",
    "/api/screen/displays",
  ])
    assert.equal((await as(route)).status, 200, route);
  assert.equal((await as("/api/screen/displays")).body.input, true);
  assert.equal(
    (
      await as("/api/screen/control", {
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    200,
  );
  for (const [route, method, body] of [
    ["/api/clients", "GET"],
    ["/api/clients/x", "DELETE"],
    ["/api/guests", "POST", { name: "x", ttlSeconds: 600, full: true }],
    ["/api/settings", "GET"],
    ["/api/activity", "GET"],
    ["/api/agents/requests", "GET"],
  ])
    assert.equal(
      (await as(route, { method, body })).status,
      403,
      `${method} ${route}`,
    );
});

test("terminal and AI invitations: only their own sessions, nothing of yours", async (t) => {
  const { call, invite } = await start(t);
  const guest = await invite({ terminal: true, agents: true });
  assert.equal(
    (await call("/api/terminals", { token: guest.token })).status,
    200,
  );
  assert.equal(
    (await call("/api/terminals/desktop", { token: guest.token })).status,
    403,
    "the Mac's own terminals stay yours",
  );
  assert.equal(
    (await call("/api/files?root=0&path=", { token: guest.token })).status,
    403,
  );
  assert.equal(
    (await call("/api/screen/displays", { token: guest.token })).status,
    403,
  );
});

test("folders chosen by browsing: exactly that folder, nothing beside or above it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-perm-folders-"));
  const files = path.join(dir, "files");
  for (const d of ["Projects/acme/designs", "Projects/other", "Taxes", "state/inside"])
    fs.mkdirSync(path.join(files, d), { recursive: true });
  fs.writeFileSync(path.join(files, "Projects/acme/brief.txt"), "brief");
  fs.writeFileSync(path.join(files, "Projects/other/secret.txt"), "secret");
  fs.writeFileSync(path.join(files, "Taxes/2025.pdf"), "taxes");
  const reach = await createReach({
    roots: [files],
    dataDir: path.join(dir, "private"),
    privatePaths: [path.join(files, "state")],
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const invite = (folders, extra = {}) =>
    call("/api/guests", { method: "POST", body: { name: "Sam", ttlSeconds: 900, folders, ...extra } });

  // Refused: a file, a path outside, Reach's private folder, too many, bad shapes.
  assert.equal((await invite([{ root: 0, path: "Projects/acme/brief.txt" }])).status, 400);
  assert.equal((await invite([{ root: 0, path: "../" }])).status, 403);
  assert.equal((await invite([{ root: 0, path: "state/inside" }])).status, 403);
  assert.equal((await invite([{ root: 0, path: "state" }])).status, 403);
  assert.equal((await invite([{ root: 5, path: "" }])).status, 400);
  assert.equal((await invite([{ root: 0, path: 42 }])).status, 400);
  assert.equal((await invite(Array(21).fill({ root: 0, path: "Taxes" }))).status, 400);

  // Shared: Projects/acme only, read-only.
  const created = await invite([{ root: 0, path: "Projects/acme" }]);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.scopes, ["device", "files:read"]);
  const guest = (
    await call("/api/guest/redeem", { token: "", method: "POST", body: { invitation: created.body.invitation } })
  ).body;
  const as = (route, opts = {}) => call(route, { token: guest.token, ...opts });
  const device = (await as("/api/device")).body;
  assert.deepEqual(device.roots.map((r) => [r.name, r.path]), [["acme", fs.realpathSync(path.join(files, "Projects/acme"))]]);
  const listing = await as("/api/files?root=0&path=");
  assert.deepEqual(listing.body.items.map((i) => i.name), ["designs", "brief.txt"]);
  assert.equal((await as("/api/files/content?root=0&path=brief.txt")).status, 200);
  // Nothing beside or above it.
  assert.equal((await as("/api/files?root=0&path=..")).status, 403);
  assert.equal((await as("/api/files/content?root=0&path=../other/secret.txt")).status, 403);
  assert.equal((await as("/api/files?root=1&path=")).status, 400);
  // Read-only: no uploads, no new folders.
  assert.equal((await as("/api/files/folder", { method: "POST", body: { root: 0, path: "", name: "x" } })).status, 403);

  // Editable, and several folders (and old-style shared roots still work).
  const both = await invite([{ root: 0, path: "Projects/acme" }, { root: 0, path: "Taxes" }], { write: true });
  assert.deepEqual(both.body.scopes, ["device", "files:read", "files:write"]);
  const legacy = await call("/api/guests", { method: "POST", body: { name: "Old", ttlSeconds: 900, roots: [0] } });
  assert.equal(legacy.status, 201);
});
