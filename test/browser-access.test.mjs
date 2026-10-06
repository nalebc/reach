import test from "node:test";
import { approveAgentClaim } from "./helpers/agent-admission.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson, createAuth } from "../server/core.mjs";

// Fixtures use saved output and a fake native terminal provider. No shell,
// desktop capture, keyboard input, or mouse input reaches the real computer.
async function start(t, overrides = {}) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-browser-access-")),
  );
  const files = path.join(dir, "files");
  const shared = path.join(files, "Project");
  const privateDir = path.join(shared, ".reach");
  fs.mkdirSync(path.join(shared, "nested"), { recursive: true });
  fs.mkdirSync(path.join(files, "Other"), { recursive: true });
  fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(shared, "brief.txt"), "A project brief");
  fs.writeFileSync(path.join(shared, "nested", "BRIEF-notes.txt"), "notes");
  fs.writeFileSync(path.join(files, "Other", "brief-secret.txt"), "outside");
  fs.writeFileSync(path.join(privateDir, "brief-private.txt"), "private");
  if (process.platform !== "win32") {
    fs.symlinkSync(
      path.join(files, "Other"),
      path.join(shared, "outside-link"),
    );
    fs.symlinkSync(privateDir, path.join(shared, "private-link"));
  }
  const nativeCalls = [];
  const reach = await createReach({
    roots: [files],
    dataDir: privateDir,
    desktopTerminals: {
      platform: "darwin",
      run: async (payload) => {
        nativeCalls.push(payload);
        if (payload.action === "list")
          return {
            running: true,
            sessions: [1, 2].map((id) => ({
              target: {
                epoch: "fixture",
                window: "1",
                session:
                  payload.provider === "iterm2"
                    ? `unique-session-${id}`
                    : `tty${id}`,
              },
              name: `${payload.provider === "iterm2" ? "iTerm2" : "Apple Terminal"} ${id}`,
              tty: `tty${id}`,
            })),
          };
        assert.equal(
          payload.action,
          "read",
          "native terminal mutations are forbidden",
        );
        return { text: `Output from ${payload.target.session}` };
      },
    },
    ...overrides,
  });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  for (const id of ["chosen", "unshared"])
    reach.terminals.sessions.set(id, {
      id,
      clientId: owner.clientId,
      name: `Reach ${id}`,
      cwd: shared,
      status: "exited",
      createdAt: new Date().toISOString(),
      buffer: `Saved ${id} output`,
      listeners: new Set(),
      ended: Promise.resolve(),
    });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const request = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (route, options) => {
    const response = await request(route, options);
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };
  const invite = (extra = {}, token = owner.token) =>
    call("/api/agents/browser-invitations", {
      token,
      method: "POST",
      body: {
        name: "Muse",
        ttlSeconds: 600,
        folders: [{ root: 0, path: "Project" }],
        terminalIds: ["reach:chosen"],
        screen: "off",
        ...extra,
      },
    });
  const redeem = async (invitation) =>
    approveAgentClaim(call, await call("/api/invitations/redeem", {
      token: "",
      method: "POST",
      body: { invitation },
    }));
  const join = async (extra = {}) => {
    const created = await invite(extra);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const joined = await redeem(created.body.invitation);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const as = (route, options = {}) =>
      call(route, { token: joined.body.token, ...options });
    return { created: created.body, joined: joined.body, as };
  };
  const changeClient = (id, changes) => {
    const file = path.join(privateDir, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(
      clients.find((client) => client.id === id),
      changes,
    );
    atomicJson(file, clients);
  };
  return {
    reach,
    dir,
    shared,
    privateDir,
    nativeCalls,
    owner,
    url,
    request,
    call,
    invite,
    redeem,
    join,
    changeClient,
  };
}

test("browser invitation grants only selected folders and terminal output, once", async (t) => {
  const { reach, call, join, redeem, shared, nativeCalls } = await start(t);
  const options = await call("/api/agents/browser-options");
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.equal(options.body.screenAvailable, false);
  const selected = options.body.terminals.find(
    (terminal) => terminal.name === "iTerm2 1",
  );
  const unshared = options.body.terminals.find(
    (terminal) => terminal.name === "iTerm2 2",
  );
  assert.ok(selected?.id.startsWith("desktop:"));
  assert.ok(unshared?.id.startsWith("desktop:"));
  assert.ok(
    options.body.terminals.some((terminal) => terminal.id === "reach:chosen"),
  );
  const before = Date.now();
  const { created, joined, as } = await join({
    terminalIds: ["reach:chosen", selected.id],
  });
  assert.equal(joined.kind, "agent");
  assert.deepEqual(joined.scopes, created.scopes);
  assert.ok(joined.scopes.includes("browser:read"));
  assert.ok(joined.scopes.includes("files:read"));
  for (const scope of [
    "admin",
    "exec",
    "terminal",
    "screen",
    "files:write",
    "browser:scroll",
  ])
    assert.equal(joined.scopes.includes(scope), false, scope);
  assert.ok(reach.auth.verify(joined.token).policy.browser);
  assert.match(created.invitation, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(
    created.joinBy > before && created.joinBy <= before + 900_000 + 1000,
  );
  assert.equal(created.expiresAt, joined.expiresAt);
  assert.equal((await redeem(created.invitation)).status, 401);
  const browser = await as("/api/browser");
  assert.equal(browser.status, 200);
  assert.equal(browser.body.name, reach.config.name);
  assert.equal(browser.body.expiresAt, created.expiresAt);
  assert.deepEqual(
    browser.body.roots.map((root) => root.path),
    [shared],
  );
  assert.deepEqual(
    browser.body.terminals.map((terminal) => terminal.id).sort(),
    ["reach:chosen", selected.id].sort(),
  );
  assert.equal(browser.body.screen, "off");
  assert.equal(
    (await as("/api/browser/terminals/reach%3Achosen")).body.output,
    "Saved chosen output",
  );
  assert.equal(
    (await as(`/api/browser/terminals/${encodeURIComponent(selected.id)}`)).body
      .output,
    "Output from unique-session-1",
  );
  assert.equal(
    (await as("/api/browser/terminals/reach%3Aunshared")).status,
    403,
  );
  assert.equal(
    (await as(`/api/browser/terminals/${encodeURIComponent(unshared.id)}`))
      .status,
    403,
  );
  assert.equal(
    (await as("/api/browser/terminals/desktop%3Amissing")).status,
    403,
  );
  assert.equal(
    nativeCalls.filter((payload) => payload.action === "read").length,
    1,
  );
  assert.deepEqual(
    (await as("/api/device")).body.roots.map((root) => root.path),
    [shared],
  );
});

test("Apple Terminal tabs with reusable tty identities cannot be shared with browser agents", async (t) => {
  const { call, invite, join, nativeCalls } = await start(t);
  const desktop = await call("/api/terminals/desktop");
  assert.equal(desktop.status, 200);
  const apple = desktop.body.sessions.find(
    (terminal) => terminal.provider === "terminal",
  );
  assert.ok(apple, "the owner can still use Apple Terminal tabs");
  const appleId = `desktop:${apple.id}`;
  const options = await call("/api/agents/browser-options");
  assert.equal(options.status, 200);
  assert.equal(
    options.body.terminals.some((terminal) => terminal.id === appleId),
    false,
  );
  assert.equal(
    options.body.terminals.some((terminal) =>
      terminal.name.startsWith("Apple Terminal"),
    ),
    false,
  );
  assert.equal((await invite({ terminalIds: [appleId] })).status, 400);
  const { as } = await join();
  assert.equal(
    (await as(`/api/browser/terminals/${encodeURIComponent(appleId)}`)).status,
    403,
  );
  assert.equal(
    nativeCalls.some((payload) => payload.action === "read"),
    false,
  );
});

test("browser file reads and recursive search stay inside grants and exclude private state", async (t) => {
  const { join } = await start(t);
  const { as } = await join();
  assert.equal(
    (await as("/api/files/text?root=0&path=brief.txt")).body.text,
    "A project brief",
  );
  const found = await as("/api/browser/files/search?root=0&q=brief");
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.items.map((item) => item.path).sort(), [
    "brief.txt",
    "nested/BRIEF-notes.txt",
  ]);
  assert.equal(found.body.truncated, false);
  assert.ok(found.body.items.every((item) => item.type === "file"));
  const folders = await as("/api/browser/files/search?root=0&q=nested");
  assert.ok(
    folders.body.items.some(
      (item) => item.path === "nested" && item.type === "directory",
    ),
  );
  const listing = await as("/api/files?root=0&hidden=1");
  assert.equal(listing.status, 200);
  assert.ok(
    listing.body.items.every(
      (item) => ![".reach", "private-link", "outside-link"].includes(item.name),
    ),
  );
  for (const relative of [
    "..",
    "../Other/brief-secret.txt",
    ".reach/brief-private.txt",
    "outside-link/brief-secret.txt",
    "private-link/brief-private.txt",
  ]) {
    if (process.platform === "win32" && relative.includes("-link")) continue;
    const response = await as(
      `/api/files/text?${new URLSearchParams({ root: "0", path: relative })}`,
    );
    assert.equal(response.status, 403, relative);
  }
  assert.equal((await as("/api/files?root=1")).status, 400);
  assert.equal(
    (await as("/api/browser/files/search?root=1&q=brief")).status,
    400,
  );
  assert.equal(
    (await as("/api/files/download-link?root=0&path=brief.txt")).status,
    403,
  );
});

test("browser credentials reject mutations and APIs outside the explicit allowlist", async (t) => {
  const { join, shared } = await start(t);
  const { as } = await join();
  for (const [route, method = "GET", body] of [
    ["/api/clients"],
    ["/api/settings"],
    ["/api/jobs"],
    ["/api/jobs", "POST", { command: "echo forbidden", root: 0 }],
    ["/api/terminals"],
    ["/api/terminals", "POST", { root: 0, name: "Forbidden" }],
    ["/api/terminals/chosen", "DELETE"],
    ["/api/terminals/desktop"],
    ["/api/TeRmiNals/desktop"],
    ["/api/terminals/desktop/any/send", "POST", { text: "echo forbidden" }],
    ["/api/browser/terminals/reach%3Achosen", "POST", { text: "forbidden" }],
    ["/api/apps"],
    ["/api/chats"],
    ["/api/sessions"],
    ["/api/fleet/computers"],
    ["/api/agents/browser-options"],
    [
      "/api/agents/browser-invitations",
      "POST",
      { name: "Nested", ttlSeconds: 600 },
    ],
    ["/api/agents/invitations", "POST", { name: "Nested", ttlSeconds: 600 }],
    ["/api/guests", "POST", { name: "Nested", ttlSeconds: 600, full: true }],
    ["/api/device/unknown"],
    ["/api/device", "POST", {}],
    ["/api/files/uploads/unknown"],
    ["/api/files/folder", "POST", { root: 0, name: "forbidden" }],
    ["/api/files/text?root=0&path=brief.txt", "PUT", { text: "forbidden" }],
    ["/api/browser/screen"],
    ["/api/browser/scroll", "POST", { direction: "down" }],
    ["/api/screen"],
    ["/api/screen/input", "POST", { type: "key", key: "Enter" }],
    ["/api/screen/control", "POST", { enabled: true }],
  ])
    assert.equal(
      (await as(route, { method, body })).status,
      403,
      `${method} ${route}`,
    );
  assert.equal(
    fs.readFileSync(path.join(shared, "brief.txt"), "utf8"),
    "A project brief",
  );
  assert.equal(fs.existsSync(path.join(shared, "forbidden")), false);
});

test("even supervised Muse access cannot invite, delegate, mint keys, or use public admission routes", async (t) => {
  const { reach, join, invite, redeem, call } = await start(t, {
    screen: true,
    browserScreenSupported: true,
  });
  const { as, joined } = await join({ screen: "ask", commandRequests: true });
  const unopened = await invite({ name: "Someone else" });
  assert.equal(unopened.status, 201);
  const before = reach.auth.list();
  for (const [route, body] of [
    ["/api/agents/browser-invitations", { name: "Delegate", ttlSeconds: 600, commandRequests: true }],
    ["/api/AgEnTs/browser-invitations", { name: "Delegate", ttlSeconds: 600 }],
    ["/api/agents/invitations", { name: "Delegate", ttlSeconds: 600, exec: true }],
    ["/api/guests", { name: "Delegate", ttlSeconds: 600, full: true }],
    ["/api/guests/key", { ttlSeconds: 600, clientIds: [joined.clientId] }],
    ["/api/guests/keys", { ttlSeconds: 600 }],
    [`/api/guests/${joined.clientId}/access`, { full: true, exec: true }],
    ["/api/clients", { name: "Delegate", scopes: ["admin"] }],
    ["/api/agents/requests", { name: "Delegate", scopes: ["device", "exec"] }],
    ["/api/auth/requests", { name: "Delegate" }],
    ["/api/pair", { name: "Delegate", code: "00000000" }],
    ["/api/invitations/redeem", { invitation: unopened.body.invitation }],
    ["/api/guest/redeem", { invitation: unopened.body.invitation }],
    ["/api/agents/requests/unknown", { decision: "approve" }],
  ]) {
    const result = await as(route, { method: "POST", body });
    assert.equal(result.status, 403, route + ": " + JSON.stringify(result.body));
  }
  assert.deepEqual(reach.auth.list(), before, "denied requests do not create or broaden any credential");
  assert.equal((await call("/api/agents/requests")).body.length, 0, "no delegated access request is queued");
  assert.equal((await redeem(unopened.body.invitation)).status, 200, "a denied redemption does not consume someone else's invitation");
  assert.equal((await as("/api/browser")).status, 200, "the original selected access still works");
});

test(
  "browser credentials cannot authenticate any websocket channel",
  { timeout: 10000 },
  async (t) => {
    const { join, url } = await start(t);
    const { joined } = await join();
    for (const channel of [
      "/ws/presence",
      "/ws/terminal",
      "/ws/screen",
      "/ws/screen-input",
    ]) {
      const ws = new WebSocket(url.replace("http:", "ws:") + channel);
      t.after(() => ws.terminate());
      const messages = [];
      ws.on("message", (data, binary) =>
        messages.push(binary ? "binary" : JSON.parse(data.toString())),
      );
      await once(ws, "open");
      const closed = once(ws, "close");
      ws.send(
        JSON.stringify({
          type: "auth",
          token: joined.token,
          sessionId: "chosen",
        }),
      );
      const [code] = await closed;
      assert.ok([4001, 4003].includes(code), `${channel}: ${code}`);
      assert.ok(
        messages.every(
          (message) => message !== "binary" && message.type === "error",
        ),
        channel,
      );
    }
  },
);

test("screen grants permit snapshots and bounded scrolling without arbitrary input", async (t) => {
  let captures = 0;
  const inputs = [];
  const { reach, call, request, join } = await start(t, {
    screen: true,
    browserScreenSupported: true,
    browserCapture: async () => {
      captures++;
      return Buffer.from("fixture-jpeg");
    },
    browserInput: async (_config, payload, authorize) => {
      authorize();
      inputs.push(payload);
      return { ok: true };
    },
  });
  assert.equal(
    (await call("/api/agents/browser-options")).body.screenAvailable,
    true,
  );
  const view = await join({ folders: [], terminalIds: [], screen: "view" });
  assert.equal(view.joined.scopes.includes("browser:scroll"), false);
  const image = await request("/api/browser/screen", {
    token: view.joined.token,
  });
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /^image\/jpeg/);
  assert.match(image.headers.get("cache-control"), /no-store/);
  assert.equal(await image.text(), "fixture-jpeg");
  assert.equal(captures, 1);
  assert.equal(
    (
      await view.as("/api/browser/scroll", {
        method: "POST",
        body: { direction: "down" },
      })
    ).status,
    403,
  );

  const scroll = await join({ folders: [], terminalIds: [], screen: "scroll" });
  assert.ok(scroll.joined.scopes.includes("browser:scroll"));
  for (const body of [
    { direction: "up", amount: 1 },
    { direction: "down", amount: 5 },
    { direction: "down" },
  ])
    assert.equal(
      (await scroll.as("/api/browser/scroll", { method: "POST", body })).status,
      200,
    );
  assert.deepEqual(inputs, [
    { type: "scroll", delta: 1 },
    { type: "scroll", delta: -5 },
    { type: "scroll", delta: -3 },
  ]);
  for (const body of [
    { direction: "left" },
    { direction: "down", amount: 0 },
    { direction: "down", amount: 6 },
    { direction: "down", amount: 1.5 },
    { direction: "down", amount: "2" },
    { direction: "down", type: "click", x: 1, y: 1 },
    { direction: "down", text: "forbidden" },
    { direction: "down", key: "Enter" },
  ])
    assert.equal(
      (await scroll.as("/api/browser/scroll", { method: "POST", body })).status,
      400,
      JSON.stringify(body),
    );
  assert.equal(
    (
      await scroll.as("/api/screen/input", {
        method: "POST",
        body: { type: "key", key: "Enter" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await scroll.as("/api/screen/control", {
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    403,
  );
  assert.equal(inputs.length, 3);

  assert.equal(
    (
      await call("/api/screen/control", {
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await scroll.as("/api/browser/scroll", {
        method: "POST",
        body: { direction: "up" },
      })
    ).status,
    409,
  );
  await call("/api/screen/control", {
    method: "POST",
    body: { enabled: false },
  });
  await reach.setPaused(true);
  assert.equal((await view.as("/api/browser/screen")).status, 423);
  assert.equal(
    (
      await scroll.as("/api/browser/scroll", {
        method: "POST",
        body: { direction: "up" },
      })
    ).status,
    423,
  );
  await reach.setPaused(false);
  assert.equal(
    (await call("/api/settings", { method: "POST", body: { screen: false } }))
      .status,
    200,
  );
  assert.equal((await view.as("/api/browser/screen")).status, 403);
  assert.equal(
    (
      await scroll.as("/api/browser/scroll", {
        method: "POST",
        body: { direction: "up" },
      })
    ).status,
    403,
  );
  assert.equal(captures, 1);
  assert.equal(inputs.length, 3);
});

test("browser invitations expire, revoke, and disconnect immediately with persisted deadlines", async (t) => {
  const { reach, call, invite, redeem, join, changeClient } = await start(t);
  const { created, joined, as } = await join();
  const restarted = createAuth(reach.config, { rotatePairing: false });
  assert.equal(restarted.verify(joined.token).expiresAt, created.expiresAt);
  assert.ok(restarted.verify(joined.token).policy.browser);
  assert.equal(
    (await call(`/api/clients/${joined.clientId}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal((await as("/api/browser")).status, 401);
  assert.equal(restarted.verify(joined.token), null);
  assert.equal((await redeem(created.invitation)).status, 401);
  const expired = await join();
  changeClient(expired.joined.clientId, { expiresAt: Date.now() - 1 });
  assert.equal((await expired.as("/api/browser")).status, 401);
  assert.equal(
    (await expired.as("/api/files/text?root=0&path=brief.txt")).status,
    401,
  );
  const late = await invite();
  changeClient(late.body.clientId, { inviteExpiresAt: Date.now() - 1 });
  assert.equal((await redeem(late.body.invitation)).status, 401);
  const revokedBeforeJoin = await invite();
  await call(`/api/clients/${revokedBeforeJoin.body.clientId}`, {
    method: "DELETE",
  });
  assert.equal((await redeem(revokedBeforeJoin.body.invitation)).status, 401);
  const left = await join();
  assert.equal(
    (await left.as("/api/device/access", { method: "DELETE" })).status,
    200,
  );
  assert.equal((await left.as("/api/browser")).status, 401);
  const race = await invite();
  const winners = await Promise.all([
    redeem(race.body.invitation),
    redeem(race.body.invitation),
  ]);
  assert.deepEqual(winners.map((result) => result.status).sort(), [200, 401]);
  assert.equal((await call("/api/device")).status, 200);
});

test("only the owner can create browser grants and invalid grants fail closed", async (t) => {
  const { reach, call, invite, join } = await start(t);
  const guestInvite = reach.auth.inviteGuest({
    name: "Guest",
    ttlSeconds: 600,
    full: true,
  });
  const guest = reach.auth.redeemGuest(guestInvite.invitation);
  assert.equal((await invite({}, guest.token)).status, 403);
  assert.equal(
    (await call("/api/agents/browser-options", { token: guest.token })).status,
    403,
  );
  for (const extra of [
    { ttlSeconds: 59 },
    { ttlSeconds: 86401 },
    { ttlSeconds: "600" },
    { ttlSeconds: 600.5 },
    { name: " " },
    { name: "x".repeat(81) },
    { screen: "control" },
    { screen: true },
    { folders: [{ root: 0, path: "../" }] },
    { folders: [{ root: 0, path: "Project/.reach" }] },
    { terminalIds: ["reach:missing"] },
    { terminalIds: ["chosen"] },
  ]) {
    const result = await invite(extra);
    assert.ok(
      [400, 403, 404].includes(result.status),
      `${JSON.stringify(extra)}: ${result.status}`,
    );
  }
  const terminalOnly = await join({
    folders: [],
    terminalIds: ["reach:chosen"],
  });
  assert.equal(terminalOnly.joined.scopes.includes("files:read"), false);
  assert.deepEqual((await terminalOnly.as("/api/browser")).body.roots, []);
  assert.equal((await terminalOnly.as("/api/files?root=0")).status, 403);
  assert.equal(
    (await terminalOnly.as("/api/browser/files/search?root=0&q=brief")).status,
    403,
  );
  assert.equal(
    (await terminalOnly.as("/api/browser/terminals/reach%3Achosen")).status,
    200,
  );
});
