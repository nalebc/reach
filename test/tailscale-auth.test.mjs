import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import {
  createAuth,
  getConfig,
  atomicJson,
  ALL_SCOPES,
} from "../server/core.mjs";
import { approvalStore } from "../server/device-approval.mjs";
import {
  createIdentityResolver,
  whoisIdentity,
  listenPrivateIngress,
  serveSocketPath,
} from "../server/tailscale-auth.mjs";
import {
  configure,
  setupOwner,
  readPreferences,
  applyPreferences,
  assertSocketSupport,
} from "../scripts/configure.mjs";
import { decideApproval, approveDevice } from "../scripts/approve-device.mjs";
import { parseOptions } from "../scripts/launcher-options.mjs";
import { defaultFileRoots } from "../server/file-roots.mjs";
const owner = { userId: "42", login: "owner@example.test" };
const identity = {
  ...owner,
  nodeId: "nPhone",
  nodeName: "Phone",
  tagged: false,
  validUntil: Date.now() + 3600000,
};
const whois = (node = "nPhone", user = 42) => ({
  Node: {
    StableID: node,
    User: user,
    Name: "phone.test.ts.net.",
    KeyExpiry: "0001-01-01T00:00:00Z",
  },
  UserProfile: {
    ID: user,
    LoginName: user === 42 ? owner.login : "other@example.test",
  },
});
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-auth-"));

test("setup confirms a personal Tailscale identity, saves privately, honors CLI overrides and refuses silent fallback", async () => {
  const root = await temp();
  const status = {
    BackendState: "Running",
    Self: { UserID: 42 },
    User: { 42: { LoginName: owner.login } },
  };
  try {
    assert.deepEqual(setupOwner(status), owner);
    for (const bad of [
      {},
      { ...status, BackendState: "NeedsLogin" },
      { ...status, Self: { UserID: 42, Tags: ["tag:agent"] } },
    ])
      assert.throws(() => setupOwner(bad));
    let answers = [],
      selections = ["cancel"];
    const deps = {
      platform: "darwin",
      status: async () => status,
      checkSupport: async () => {},
      print() {},
      ask: async () => answers.shift(),
      select: async () => selections.shift(),
    };
    await assert.rejects(configure(root, deps), /cancelled/);
    assert.equal(readPreferences(root), null);
    selections = ["use"];
    const result = await configure(root, deps);
    assert.equal(selections.length, 0);
    assert.deepEqual(result.folders, defaultFileRoots());
    assert.deepEqual(result.owner, owner);
    assert.equal(result.stayAwake, "always");
    assert.equal(answers.length, 0);
    // Old setup answers must not silently disable the new launch default.
    for (const legacy of [false, true, undefined]) {
      const saved = { ...result, stayAwake: legacy };
      for (const args of [[], ["install"], ["--service"]])
        assert.equal(
          applyPreferences(parseOptions(args), saved, args).stayAwake,
          "always",
        );
      assert.equal(
        applyPreferences(parseOptions(["--no-stay-awake"]), saved).stayAwake,
        false,
      );
      assert.equal(
        applyPreferences(parseOptions(["--stay-awake"]), saved).stayAwake,
        true,
      );
    }
    assert.equal(
      (await fs.stat(path.join(root, ".reach/preferences.json"))).mode & 0o777,
      0o600,
    );
    assert.deepEqual(
      applyPreferences(parseOptions([]), result).folders,
      defaultFileRoots(),
    );
    const explicit = parseOptions([
      "--folder",
      "/tmp",
      "--https-port",
      "9999",
      "--stay-awake",
    ]);
    assert.equal(
      applyPreferences(explicit, result, ["--https-port"]).httpsPort,
      9999,
    );
    assert.equal(applyPreferences(explicit, result).stayAwake, true);
    assert.deepEqual(applyPreferences(explicit, result).folders, ["/tmp"]);
    await assert.rejects(
      assertSocketSupport(async () => ({ stdout: "old Serve version" })),
      /Update Tailscale/,
    );
    await assertSocketSupport(async () => ({
      stdout: "unix:/tmp/server.sock",
    }));
    await fs.writeFile(path.join(root, ".reach/preferences.json"), "broken");
    assert.throws(() => readPreferences(root), /invalid/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Serve capability detection accepts help on either stream and fails closed on CLI errors", async () => {
  for (const result of [
    { stdout: "Unix domain socket: unix:/tmp/service.sock", stderr: "" },
    { stdout: "", stderr: "Unix domain socket: unix:/tmp/service.sock" },
    {
      stdout: "Serve content",
      stderr: "Unix domain socket: unix:/tmp/service.sock",
    },
  ]) {
    await assertSocketSupport(async (_command, args) => {
      assert.deepEqual(args, ["serve", "--help"]);
      return result;
    });
  }
  for (const result of [
    {},
    { stdout: "Serve content", stderr: "No socket support" },
  ])
    await assert.rejects(
      assertSocketSupport(async () => result),
      /Update Tailscale/,
    );
  const failure = Object.assign(new Error("Tailscale command failed"), {
    code: 1,
    stderr: "unix:/tmp/service.sock",
  });
  await assert.rejects(
    assertSocketSupport(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("device approvals expire, require a local decision and claimant secret, and never recreate revoked sessions", async () => {
  const root = await temp();
  let now = Date.now();
  const auth = createAuth(getConfig({ dataDir: root, tailscaleOwner: owner }));
  const store = approvalStore(root, { now: () => now });
  try {
    for (const bad of [
      null,
      { ...identity, userId: "99" },
      { ...identity, tagged: true },
    ])
      assert.throws(() => store.request(bad, "Phone", owner), /account/);
    assert.throws(() => store.request(identity, "\x1b[2J", owner), /name/);
    const request = store.request(identity, "iPhone", owner);
    assert.equal(
      store.poll(request.id, request.secret, identity, owner, auth).status,
      "pending",
    );
    assert.throws(
      () => store.poll(request.id, "wrong", identity, owner, auth),
      /belongs/,
    );
    assert.throws(
      () =>
        store.poll(
          request.id,
          request.secret,
          { ...identity, nodeId: "nOther" },
          owner,
          auth,
        ),
      /belongs/,
    );
    assert.throws(() =>
      store.poll("../../clients", request.secret, identity, owner, auth),
    );
    assert.throws(() => decideApproval(root, "invalid"));
    decideApproval(root, request.verification);
    const claimed = store.poll(
      request.id,
      request.secret,
      identity,
      owner,
      auth,
    );
    assert.equal(claimed.status, "approved");
    assert.equal(
      store.poll(request.id, request.secret, identity, owner, auth).token,
      claimed.token,
    );
    assert.equal(auth.list().length, 1);
    const restoredAuth = createAuth(
      getConfig({ dataDir: root, tailscaleOwner: owner }),
      { rotatePairing: false },
    );
    assert.equal(
      approvalStore(root).poll(
        request.id,
        request.secret,
        identity,
        owner,
        restoredAuth,
      ).token,
      claimed.token,
    );
    assert.equal(auth.verify(claimed.token), null);
    assert.equal(
      auth.verify(claimed.token, { ...identity, nodeId: "nOther" }),
      null,
    );
    assert(auth.verify(claimed.token, identity));
    auth.revoke(auth.list()[0].id);
    assert.throws(
      () => store.poll(request.id, request.secret, identity, owner, auth),
      /revoked/,
    );
    assert.equal(auth.list().length, 0);
    const unbound = auth.issue("Pre-upgrade browser", ALL_SCOPES);
    assert.equal(auth.verify(unbound.token, identity), null);
    assert.equal(
      auth.verify(claimed.token, { ...identity, validUntil: 0 }),
      null,
    );
    const denied = store.request(identity, "Other browser", owner);
    decideApproval(root, `deny ${denied.verification}`);
    assert.equal(
      store.poll(denied.id, denied.secret, identity, owner, auth).status,
      "denied",
    );
    // Simulate a crash after the issuing marker: retries must never create a
    // second credential, even if issuance happened before the crash.
    const broken = store.request(
      { ...identity, nodeId: "nCrash" },
      "Interrupted",
      owner,
    );
    store.decide(broken.id, "approve");
    const brokenFile = path.join(root, "device-requests", broken.id + ".json");
    const receipt = JSON.parse(await fs.readFile(brokenFile, "utf8"));
    atomicJson(brokenFile, { ...receipt, status: "issuing" });
    const count = auth.list().length;
    assert.throws(
      () =>
        store.poll(
          broken.id,
          broken.secret,
          { ...identity, nodeId: "nCrash" },
          owner,
          auth,
        ),
      /interrupted/,
    );
    assert.equal(auth.list().length, count);
    const expiring = store.request(identity, "One more", owner);
    now += 300001;
    assert.throws(
      () => store.poll(expiring.id, expiring.secret, identity, owner, auth),
      /expired/,
    );
    assert.deepEqual(store.list(), []);
    assert.equal(
      (await fs.readdir(path.join(root, "device-requests"))).length,
      0,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("identity resolution refuses ordinary TCP headers, tagged owners and expired nodes", async () => {
  let lookups = 0;
  const resolve = createIdentityResolver({
    lookup: async () => {
      lookups++;
      return whois();
    },
  });
  assert.equal(
    await resolve({
      headers: {
        "x-forwarded-for": "100.64.0.1",
        "tailscale-user-login": owner.login,
      },
    }),
    null,
  );
  assert.equal(lookups, 0);
  assert.throws(() =>
    whoisIdentity({ ...whois(), Node: { ...whois().Node, Expired: true } }),
  );
  assert.throws(() =>
    whoisIdentity({
      ...whois(),
      Node: { ...whois().Node, KeyExpiry: "2020-01-01T00:00:00Z" },
    }),
  );
  assert.throws(() => whoisIdentity({ ...whois(), UserProfile: { ID: 999 } }));
  assert.equal(
    whoisIdentity({ Node: { StableID: "nAgent", Tags: ["tag:agent"] } }).tagged,
    true,
  );
});

test(
  "private ingress enforces approval, node binding, pairing gates, scopes, WS revocation and reconnect",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const root = await temp();
    // Keep below Darwin's Unix socket path limit.
    const socketDir = await fs.mkdtemp("/tmp/reach-auth-socket-");
    const socketPath = path.join(socketDir, "s");
    const dataDir = path.join(root, "private");
    const source = new Map([
      ["100.64.0.1", whois()],
      ["100.64.0.2", whois("nOther")],
      ["100.64.0.3", whois("nStranger", 99)],
      ["100.64.0.4", { Node: { StableID: "nAgent", Tags: ["tag:agent"] } }],
    ]);
    let clock = Date.now();
    const reach = await createReach({
      roots: [root],
      dataDir,
      port: 0,
      tailscaleOwner: owner,
      tailscaleIdentity: {
        now: () => clock,
        lookup: async (ip) => {
          if (!source.has(ip)) throw Error("disconnected");
          return source.get(ip);
        },
      },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socketPath);
    const headers = {
      Host: "localhost",
      "X-Forwarded-For": "100.64.0.1",
      "Tailscale-User-Login": owner.login,
    };
    const call = (route, body, extra = {}, tcp = false) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            ...(tcp
              ? { hostname: "127.0.0.1", port: reach.server.address().port }
              : { socketPath }),
            path: route,
            method: body ? "POST" : "GET",
            headers: {
              ...headers,
              ...extra,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(data) });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.once("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    const connect = (token, address = "100.64.0.1") => {
      const ws = new WebSocket(`ws+unix:${socketPath}:/ws/screen`, {
        headers: { ...headers, "X-Forwarded-For": address },
      });
      ws.on("error", () => {});
      ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      return ws;
    };
    try {
      assert.equal((await fs.stat(socketDir)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
      await assert.rejects(
        listenPrivateIngress({
          socketPath,
          app() {},
          upgrade() {},
          resolveIdentity: async () => null,
        }),
        /already running/,
      );
      assert.equal(
        (await call("/api/auth/method", null, {}, true)).body.eligible,
        false,
      );
      assert.equal(
        (await call("/api/auth/requests", { name: "Phone" }, {}, true)).status,
        403,
      );
      assert.equal(
        (await call("/api/pair", { code: reach.auth.pairing.code }, {}, true))
          .status,
        403,
      );
      assert.equal(
        (
          await call(
            "/api/auth/requests",
            { name: "Phone" },
            { "X-Forwarded-For": "100.64.0.1, 100.64.0.2" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call("/api/auth/method", null, {
            "Tailscale-Funnel-Request": "?1",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/api/auth/requests",
            { name: "Phone" },
            { "X-Forwarded-For": "100.64.0.3" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/api/auth/requests",
            { name: "Phone" },
            { "X-Forwarded-For": "100.64.0.4" },
          )
        ).status,
        403,
      );
      assert.equal((await call("/api/auth/method")).body.eligible, true);
      const request = (await call("/api/auth/requests", { name: "Phone" }))
        .body;
      const poll = () =>
        call(`/api/auth/requests/${request.id}`, { secret: request.secret });
      assert.equal((await poll()).body.status, "pending");
      approvalStore(dataDir).decide(request.id, "approve");
      const token = (await poll()).body.token;
      const authorization = { Authorization: `Bearer ${token}` };
      assert.equal(
        (await call("/api/device", null, authorization)).status,
        200,
      );
      assert.equal(
        (
          await call("/api/device", null, {
            ...authorization,
            "X-Forwarded-For": "100.64.0.2",
          })
        ).status,
        401,
      );
      assert.equal(
        (await call("/api/device", null, authorization, true)).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/api/pair",
            { code: reach.auth.pairing.code },
            { "X-Forwarded-For": "100.64.0.3" },
          )
        ).status,
        403,
      );
      const legacyPair = (
        await call("/api/pair", {
          code: reach.auth.pairing.code,
          name: "Fallback",
        })
      ).body;
      assert(legacyPair.token);
      assert.equal(
        (
          await call("/api/device", null, {
            Authorization: `Bearer ${legacyPair.token}`,
            "X-Forwarded-For": "100.64.0.2",
          })
        ).status,
        401,
      );
      const agent = reach.auth.issue("Agent", ["files:read"], "agent");
      const agentHeaders = {
        Authorization: `Bearer ${agent.token}`,
        "X-Forwarded-For": "100.64.0.4",
      };
      assert.equal((await call("/api/device", null, agentHeaders)).status, 200);
      assert.equal(
        (await call("/api/clients", null, agentHeaders)).status,
        403,
      );
      // Wrong-node token rejected at WS auth, before screen access checks.
      const wrong = connect(token, "100.64.0.2");
      const [wrongMessage] = await once(wrong, "message");
      assert.match(String(wrongMessage), /Pair this device/);
      wrong.terminate();
      // Keep a real terminal WS authenticated without executing shell commands.
      reach.terminals.sessions.set("test-session", {
        id: "test-session",
        clientId: reach.auth.list()[0].id,
        cwd: root,
        status: "running",
        buffer: "hello",
        listeners: new Set(),
        proc: { kill() {} },
      });
      const terminal = () => {
        const ws = new WebSocket(`ws+unix:${socketPath}:/ws/terminal`, {
          headers,
        });
        ws.on("error", () => {});
        ws.once("open", () =>
          ws.send(
            JSON.stringify({ type: "auth", token, sessionId: "test-session" }),
          ),
        );
        return ws;
      };
      let ws = terminal();
      assert.match(String((await once(ws, "message"))[0]), /snapshot/);
      let closed = once(ws, "close");
      ws.close();
      await closed;
      ws = terminal();
      assert.match(String((await once(ws, "message"))[0]), /snapshot/);
      // Tailscale identity disappears/reassigns while the WS remains open.
      closed = once(ws, "close");
      source.set("100.64.0.1", whois("nReassigned"));
      clock += 3000;
      await closed;
      source.set("100.64.0.1", whois());
      clock += 3000;
      ws = terminal();
      assert.match(String((await once(ws, "message"))[0]), /snapshot/);
      closed = once(ws, "close");
      reach.auth.revoke(reach.auth.list()[0].id);
      await closed;
      assert.equal(
        (await call("/api/device", null, authorization)).status,
        401,
      );
      // Identity lookup failure fails closed, including bearer tokens for agents.
      source.delete("100.64.0.4");
      clock += 3000;
      assert.equal((await call("/api/device", null, agentHeaders)).status, 403);
    } finally {
      reach.terminals.sessions.clear();
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  },
);

test("Mac socket selection stays in an existing app group and within Unix path limits", () => {
  const group =
    "/Users/test/Library/Group Containers/W5364U7YZB.group.io.tailscale.ipn.macos";
  const socket = serveSocketPath("/workspace/reach", {
    platform: "darwin",
    home: "/Users/test",
    uid: 501,
    exists: (p) => p === group,
  });
  assert(socket.startsWith(group + "/r-"));
  assert(Buffer.byteLength(socket) < 104);
  assert.equal(
    serveSocketPath("/workspace/reach", {
      platform: "darwin",
      home: "/Users/test",
      uid: 501,
      exists: () => false,
    }).startsWith("/tmp/reach-501-"),
    true,
  );
  assert.throws(
    () =>
      serveSocketPath("/workspace/reach", {
        platform: "darwin",
        home: "/Users/" + "x".repeat(90),
        uid: 501,
        exists: () => true,
      }),
    /too long/,
  );
});

test("device menus keep review-later safe and require the selected phone's matching code", async () => {
  const root = await temp();
  try {
    atomicJson(path.join(root, ".reach/host-status.json"), {
      tailscaleApproval: true,
      dataDir: root,
    });
    const store = approvalStore(root);
    const request = store.request(identity, "Phone", owner);
    const id = request.id;
    for (const selections of [["later"], [id, "later"]]) {
      await approveDevice(root, {
        select: async () => selections.shift(),
        ask: async () => assert.fail("No code needed"),
        print() {},
      });
      assert.equal(store.list().find((r) => r.id === id).status, "pending");
    }
    let selections = [id, "approve"];
    await assert.rejects(
      approveDevice(root, {
        select: async () => selections.shift(),
        ask: async () => "wrong",
        print() {},
      }),
      /does not match/,
    );
    assert.equal(store.list().find((r) => r.id === id).status, "pending");
    selections = [id, "approve"];
    await approveDevice(root, {
      select: async () => selections.shift(),
      ask: async () => request.verification,
      print() {},
    });
    assert.equal(store.list().find((r) => r.id === id).status, "approved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("setup menus reread switched accounts and preserve existing settings on cancellation", async () => {
  const root = await temp();
  try {
    const status = (id) => ({
      BackendState: "Running",
      Self: { UserID: id },
      User: { [id]: { LoginName: `owner${id}@example.test` } },
    });
    let selections = ["switch", "retry", "use"],
      count = 0;
    const result = await configure(root, {
      platform: "darwin",
      status: async () => status(++count),
      checkSupport: async () => {},
      select: async () => selections.shift(),
      ask: async () => root,
      print() {},
    });
    assert.equal(result.owner.userId, "2");
    // Explicit restrictions survive an ordinary launch. Reconfiguration can
    // keep every selected folder, or opt into full computer browsing.
    atomicJson(path.join(root, ".reach/preferences.json"), {
      ...result,
      folders: [root, os.homedir()],
    });
    const saved = readPreferences(root);
    assert.deepEqual(
      applyPreferences(parseOptions([]), saved).folders,
      saved.folders,
    );
    const before = await fs.readFile(
      path.join(root, ".reach/preferences.json"),
      "utf8",
    );
    selections = ["use", "custom", "cancel"];
    await assert.rejects(
      configure(root, {
        platform: "darwin",
        status: async () => status(3),
        checkSupport: async () => {},
        select: async () => selections.shift(),
        ask: async () => path.join(root, "missing"),
        print() {},
      }),
      /cancelled/,
    );
    assert.equal(
      await fs.readFile(path.join(root, ".reach/preferences.json"), "utf8"),
      before,
    );
    selections = ["use", "keep"];
    const kept = await configure(root, {
      platform: "darwin",
      status: async () => status(2),
      checkSupport: async () => {},
      select: async () => selections.shift(),
      ask: async () => {
        throw Error("No folder input expected");
      },
      print() {},
    });
    assert.deepEqual(kept.folders, saved.folders);
    selections = ["use", "default"];
    const expanded = await configure(root, {
      platform: "darwin",
      status: async () => status(2),
      checkSupport: async () => {},
      select: async () => selections.shift(),
      ask: async () => {
        throw Error("No folder input expected");
      },
      print() {},
    });
    assert.deepEqual(expanded.folders, defaultFileRoots());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
