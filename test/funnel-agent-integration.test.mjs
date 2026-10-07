import nodeTest from "node:test";
// This suite exercises the POSIX private ingress socket and its UID/mode checks.
// Signed request, admission and scope suites also run on Windows.
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" ? "Unix private ingress is not implemented on Windows" : false }, fn);
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { publicStartHandler } from "../server/public-start.mjs";

const ORIGIN = "https://fixture.ts.net";
const OWNER = { userId: "42", login: "owner@example.test" };
const CLIENT_IDENTITY = {
  ...OWNER,
  nodeId: "owner-phone",
  tagged: false,
  validUntil: Date.now() + 600_000,
};
const nonce = () => crypto.randomBytes(24).toString("base64url");
function signingKey() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    ...pair,
    jwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      ext: true,
      key_ops: ["verify"],
    },
  };
}
function sign(key, input) {
  const payload = JSON.stringify({
    v: 1,
    audience: ORIGIN,
    issuedAt: Date.now(),
    nonce: nonce(),
    ...input,
  });
  return {
    payload,
    publicKey: key.jwk,
    signature: crypto
      .sign("sha256", Buffer.from(payload), {
        key: key.privateKey,
        dsaEncoding: "ieee-p1363",
      })
      .toString("base64url"),
  };
}

// All network identity, screen capture and native input are fixtures. No real
// Tailscale enrollment, desktop capture, shell command or mouse event is used.
async function setup(t) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-http-")),
  );
  const socketDir = fs.mkdtempSync("/tmp/reach-funnel-socket-");
  const socketPath = path.join(socketDir, "s");
  const shared = path.join(root, "shared");
  const scoped = path.join(shared, "granted");
  const outside = path.join(shared, "outside");
  const state = path.join(root, "state");
  const dist = path.join(root, "public");
  for (const dir of [scoped, outside, dist])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(scoped, "brief.txt"), "Only the shared brief");
  fs.writeFileSync(
    path.join(scoped, "sample.bin"),
    Buffer.from([0, 1, 254, 255, 64]),
  );
  fs.writeFileSync(path.join(outside, "private.txt"), "Outside the grant");
  fs.writeFileSync(
    path.join(dist, "start.html"),
    "<!doctype html><title>Fixture start</title>",
  );
  fs.symlinkSync(
    path.join(outside, "private.txt"),
    path.join(scoped, "escape.txt"),
  );
  let identityLookups = 0;
  const inputs = [],
    publicIdentities = [];
  const frame = Buffer.from("fixture-jpeg-only");
  const reach = await createReach({
    name: "Fixture laptop",
    roots: [shared],
    dataDir: state,
    agentPolicyFile: path.join(state, "agent-policy.json"),
    publicOrigin: `${ORIGIN}:8443`,
    allowedOrigins: [ORIGIN],
    tailscaleOwner: OWNER,
    screen: true,
    browserScreenSupported: true,
    tailscaleIdentity: {
      lookup: async (ip) => {
        identityLookups++;
        assert.equal(ip, "100.64.0.1");
        return {
          Node: {
            StableID: "owner-phone",
            User: 42,
            Name: "owner.test.ts.net.",
            KeyExpiry: "0001-01-01T00:00:00Z",
          },
          UserProfile: { ID: 42, LoginName: OWNER.login },
        };
      },
    },
    desktopTerminals: {
      platform: "linux",
      run: async () => assert.fail("No native terminals"),
    },
    browserCapture: async () => Buffer.from(frame),
    browserInput: async (_config, action, authorize) => {
      authorize();
      inputs.push(action);
      return { ok: true };
    },
  });
  t.after(async () => {
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  const owner = reach.auth.issue("Owner", ALL_SCOPES, "device", {
    tailscale: { userId: OWNER.userId, nodeId: CLIENT_IDENTITY.nodeId },
  });
  const staticHandler = publicStartHandler({
    dist,
    privateOrigin: `${ORIGIN}:8443`,
    name: "Fixture laptop",
    instance: "test",
  });
  await new Promise((resolve, reject) => {
    reach.server.once("error", reject);
    reach.server.listen(0, "127.0.0.1", resolve);
  });
  await reach.listenPrivate(socketPath, {
    publicApp: (req, res) => {
      publicIdentities.push(req.reachIdentity);
      return reach.publicAgent(req, res) || staticHandler(req, res);
    },
  });
  reach.setFunnelController(async () => {});
  const raw = (
    route,
    { target = "public", method = "GET", body, headers = {} } = {},
  ) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          ...(target === "local"
            ? { hostname: "127.0.0.1", port: reach.server.address().port }
            : { socketPath }),
          path: route,
          method,
          headers: {
            Host: new URL(ORIGIN).host,
            ...(target === "public"
              ? {
                  Host: "localhost",
                  "X-Forwarded-Host": new URL(ORIGIN).host,
                  "Tailscale-Funnel-Request": "?1",
                }
              : {}),
            ...(target === "private"
              ? {
                  "X-Forwarded-For": "100.64.0.1",
                  "Tailscale-User-Login": OWNER.login,
                  Authorization: `Bearer ${owner.token}`,
                }
              : {}),
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const bytes = Buffer.concat(chunks);
            let parsed;
            try {
              parsed = JSON.parse(bytes.toString());
            } catch {}
            resolve({
              status: res.statusCode,
              body: parsed,
              bytes,
              headers: res.headers,
            });
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(5000, () =>
        req.destroy(new Error("Fixture request timed out")),
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const key = signingKey();
  const gateway = (input, options = {}, signer = key) =>
    raw("/agent-gateway", {
      method: "POST",
      body: sign(signer, input),
      ...options,
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        ...options.headers,
      },
    });
  const ownerCall = (route, options = {}) =>
    raw(route, { target: "private", ...options });
  const invite = (extra = {}) =>
    ownerCall("/api/agents/browser-invitations", {
      method: "POST",
      body: {
        name: "Muse",
        transport: "funnel",
        ttlSeconds: 600,
        folders: [{ root: 0, path: "granted" }],
        screen: "off",
        commandRequests: true,
        ...extra,
      },
    });
  const join = async (extra = {}) => {
    const grant = await invite(extra);
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    assert.equal(new URL(grant.body.url).origin, ORIGIN);
    const claim = await gateway({
      operation: "claim",
      invitation: grant.body.invitation,
    });
    assert.equal(claim.status, 202, JSON.stringify(claim.body));
    assert.equal(claim.body.token, undefined);
    const polling = {
      operation: "status",
      requestId: claim.body.requestId,
      secret: claim.body.requestSecret,
    };
    assert.equal((await gateway(polling)).body.status, "pending");
    reach.auth.decideAgentAdmission(claim.body.requestId, "approve");
    const joined = await gateway(polling);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.status, "approved");
    const call = (route, { method = "GET", body = null, ...options } = {}) =>
      gateway(
        {
          operation: "request",
          token: joined.body.token,
          method,
          path: route,
          body,
        },
        options,
      );
    return { ...joined.body, call, grant: grant.body, receipt: claim.body };
  };
  return {
    reach,
    owner,
    key,
    raw,
    gateway,
    ownerCall,
    invite,
    join,
    inputs,
    frame,
    publicIdentities,
    identityLookups: () => identityLookups,
    state,
  };
}

test("Funnel HTTP dispatch reaches scoped JSON and binary APIs without creating a tailnet identity", async (t) => {
  const f = await setup(t),
    session = await f.join();
  const lookups = f.identityLookups();
  const browser = await session.call("/api/browser");
  assert.equal(browser.status, 200, JSON.stringify(browser.body));
  assert.equal(browser.body.roots.length, 1);
  assert.equal(browser.body.screen, "off");
  const file = await session.call("/api/files/text?root=0&path=brief.txt");
  assert.equal(file.status, 200, JSON.stringify(file.body));
  assert.equal(file.body.text, "Only the shared brief");
  const binary = await session.call(
    "/api/files/content?root=0&path=sample.bin",
  );
  assert.equal(binary.status, 200, JSON.stringify(binary.body));
  assert.deepEqual([...binary.bytes], [0, 1, 254, 255, 64]);
  const screen = await session.call("/api/browser/screen");
  assert.equal(screen.status, 403, "retired whole-desktop capture remains inaccessible through Funnel");
  assert.equal(screen.bytes.equals(f.frame), false);
  assert.equal(f.identityLookups(), lookups);
  assert.ok(
    f.publicIdentities.length > 0 &&
      f.publicIdentities.every((value) => value === undefined),
  );
  assert.equal(f.reach.auth.verify(session.token, CLIENT_IDENTITY), null);
  assert.deepEqual(f.inputs, []);
});

test("Funnel file scope denies traversal, symlink escape and ungranted roots", async (t) => {
  const f = await setup(t),
    session = await f.join();
  for (const route of [
    "/api/files/text?root=0&path=..%2Foutside%2Fprivate.txt",
    "/api/files/text?root=0&path=escape.txt",
    "/api/files/text?root=1&path=private.txt",
    "/api/files/text?root=0&path=%2Fetc%2Fpasswd",
  ]) {
    const result = await session.call(route);
    assert.ok(
      [400, 403, 404].includes(result.status),
      `${route}: ${result.status}`,
    );
    assert.equal(result.bytes.toString().includes("Outside the grant"), false);
  }
});

test("replacing the granted root with a symlink never retargets agent file access", async (t) => {
  const f = await setup(t), session = await f.join();
  const base = path.dirname(f.state), granted = path.join(base, "shared/granted"), outside = path.join(base, "unshared");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "outside-secret.txt"), "Never inside the granted folder");
  fs.renameSync(granted, `${granted}-original`);
  fs.symlinkSync(outside, granted, "dir");
  for (const route of ["/api/files/text?root=0&path=outside-secret.txt", "/api/files?root=0&path=",
    "/api/browser/files/search?root=0&q=outside-secret"]) {
    const result = await session.call(route);
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(result.bytes.toString().includes("Never inside the granted folder"), false);
  }
});

test("public owner, delegation, shell and ordinary API paths remain inaccessible", async (t) => {
  const f = await setup(t),
    session = await f.join();
  for (const [route, method] of [
    ["/api/agents/browser-invitations", "POST"],
    ["/api/agents/invitations", "POST"],
    ["/api/guests", "POST"],
    ["/api/clients", "GET"],
    ["/api/settings", "POST"],
    ["/api/pair", "POST"],
    ["/api/auth/requests", "POST"],
    ["/api/invitations/redeem", "POST"],
    ["/api/agents/admissions", "GET"],
    ["/api/jobs", "POST"],
    ["/api/terminals", "POST"],
    ["/api/screen/input", "POST"],
    ["/api/drive", "POST"],
    ["/api/fleet", "GET"],
  ])
    assert.equal(
      (
        await session.call(route, {
          method,
          body: method === "POST" ? {} : null,
        })
      ).status,
      403,
      route,
    );
  for (const target of ["public", "private", "local"]) {
    const plain = await f.raw("/api/browser", {
      target,
      headers: {
        Authorization: `Bearer ${session.token}`,
        "X-Forwarded-For": "100.64.0.1",
        "Tailscale-User-Login": OWNER.login,
      },
    });
    assert.ok(
      [401, 403, 404].includes(plain.status),
      `${target}: ${plain.status}`,
    );
  }
  assert.equal((await f.raw("/api/health")).status, 404);
  assert.equal(
    (
      await f.raw("/api/agents/browser-invitations", {
        method: "POST",
        body: {},
        headers: { Authorization: `Bearer ${f.owner.token}` },
      })
    ).status,
    405,
  );
  const malformed = await f.raw("/agent-gateway", {
    method: "POST",
    body: { token: session.token, method: "GET", path: "/api/browser" },
    headers: { Origin: ORIGIN },
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(f.reach.jobs.list(), []);
});

test("same-origin gateway on private or local ingress still requires the signed browser credential", async (t) => {
  const f = await setup(t),
    session = await f.join();
  for (const target of ["private", "local"]) {
    const result = await session.call("/api/files/text?root=0&path=brief.txt", {
      target,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.text, "Only the shared brief");
  }
  const wrongKey = await f.gateway(
    {
      operation: "request",
      token: session.token,
      method: "GET",
      path: "/api/browser",
      body: null,
    },
    {},
    signingKey(),
  );
  assert.equal(wrongKey.status, 401);
});

test("only the Tailscale Unix proxy's forwarded host can identify the public gateway", async (t) => {
  const f = await setup(t),
    session = await f.join();
  const spoofed = {
    Host: "localhost",
    "X-Forwarded-Host": new URL(ORIGIN).host,
    "X-Forwarded-For": "100.64.0.1",
    "Tailscale-User-Login": OWNER.login,
  };
  for (const headers of [
    spoofed,
    { ...spoofed, "Tailscale-Funnel-Request": "?1" },
  ]) {
    const result = await session.call("/api/browser", {
      target: "local",
      headers,
    });
    assert.equal(result.status, 421);
  }
  assert.equal(
    (
      await session.call("/api/browser", {
        headers: { "X-Forwarded-Host": "attacker.example" },
      })
    ).status,
    421,
  );
  assert.equal(
    (
      await session.call("/api/browser", {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal((await session.call("/api/browser")).status, 200);
  assert.ok(f.publicIdentities.every((value) => value === undefined));
});

test("retired screen actions stay blocked and dangerous command handoffs never execute", async (t) => {
  const f = await setup(t),
    session = await f.join();
  const click = {
    type: "click",
    x: 0.25,
    y: 0.5,
    button: "left",
    count: 1,
    reason: "Review the fixture screen action",
  };
  const submitted = await session.call("/api/browser/requests", {
    method: "POST",
    body: click,
  });
  assert.equal(submitted.status, 403, JSON.stringify(submitted.body));
  assert.deepEqual(f.inputs, []);
  assert.equal((await f.ownerCall("/api/agents/browser-requests")).body.length, 0,
    "a retired screen action cannot create anything for an owner to approve");
  const command = await session.call("/api/browser/requests", {
    method: "POST",
    body: {
      type: "command",
      command: "sudo rm -rf /example/never-run",
      reason: "Fixture command must remain a human handoff",
    },
  });
  assert.equal(command.status, 201, JSON.stringify(command.body));
  const commandRoute = `/api/agents/browser-requests/${command.body.id}`;
  assert.equal(
    (
      await f.ownerCall(commandRoute, {
        method: "POST",
        body: { decision: "approve" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.ownerCall(commandRoute, {
        method: "POST",
        body: { decision: "handled" },
      })
    ).body.status,
    "handled",
  );
  assert.deepEqual(f.reach.jobs.list(), []);
  assert.equal(f.inputs.length, 0);
});

test("revocation, expiry, and pause close signed access and its ephemeral window", async (t) => {
  const f = await setup(t),
    first = await f.join();
  f.reach.auth.revoke(first.clientId);
  assert.equal(f.reach.funnelWindow().open, false);
  assert.equal((await first.call("/api/browser")).status, 503);
  const second = await f.join();
  assert.equal((await first.call("/api/browser")).status, 401);
  const file = path.join(f.state, "clients.json"),
    clients = JSON.parse(fs.readFileSync(file, "utf8"));
  clients.find((client) => client.id === second.clientId).expiresAt =
    Date.now() - 1;
  atomicJson(file, clients);
  assert.equal(f.reach.funnelWindow().open, false);
  assert.equal((await second.call("/api/browser")).status, 503);
  const third = await f.join();
  await f.reach.setPaused(true);
  assert.equal(f.reach.funnelWindow().open, false);
  assert.equal((await third.call("/api/browser")).status, 503);
});

test("browser invite waits for temporary Funnel readiness and revokes a failed startup", async (t) => {
  const f = await setup(t);
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.reach.setFunnelController(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  let settled = false;
  const pending = f.invite().then((result) => {
    settled = true;
    return result;
  });
  try {
    // If validation rejects before the controller is entered, fail with that
    // result instead of hanging forever on a readiness signal that cannot fire.
    await Promise.race([ready, pending.then((result) => {
      throw Error(`Invitation settled before Funnel readiness: ${result.status} ${JSON.stringify(result.body)}`);
    })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the invitation must not escape before Funnel is ready");
  } finally { release?.(); }
  const successful = await pending;
  assert.equal(successful.status, 201);
  assert.equal(successful.body.transport, "funnel");
  assert.match(
    successful.body.url,
    /^https:\/\/fixture\.ts\.net\/agent-browser#invite=/,
  );
  f.reach.auth.revoke(successful.body.clientId);
  const existing = new Set(f.reach.auth.list().map((client) => client.id));
  f.reach.setFunnelController(async () => {
    throw Object.assign(new Error("Fixture startup failure"), { status: 503 });
  });
  const failed = await f.invite();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.invitation, undefined);
  assert.equal(failed.body.url, undefined);
  assert.equal(
    f.reach.auth
      .list()
      .filter(
        (client) => !existing.has(client.id) && client.status !== "revoked",
      ).length,
    0,
  );
  assert.equal(f.reach.funnelWindow().open, false);
});

test("only an authorized browser request extends the idle lease; silence expires credentials and Funnel", async (t) => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  const f = await setup(t),
    session = await f.join();
  const current = () =>
    JSON.parse(
      fs.readFileSync(path.join(f.state, "clients.json"), "utf8"),
    ).find((client) => client.id === session.clientId);
  const firstDeadline = current().browserIdleExpiresAt;
  offset = 30_000;
  assert.equal((await session.call("/api/browser")).status, 200);
  const renewed = current().browserIdleExpiresAt;
  assert.ok(renewed > firstDeadline);
  assert.ok(renewed <= session.expiresAt);
  offset = 50_000;
  assert.equal(
    (
      await session.call("/api/agents/browser-invitations", {
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(current().browserIdleExpiresAt, renewed);
  const stored = current();
  assert.ok(f.reach.auth.verifyFunnel(session.token, stored.browserBinding));
  assert.equal(
    current().browserIdleExpiresAt,
    renewed,
    "internal authorization checks cannot renew the lease",
  );
  offset = renewed - realNow() + 1;
  assert.equal(f.reach.funnelWindow().open, false);
  assert.equal((await session.call("/api/browser")).status, 503);
  assert.equal(
    f.reach.auth.verifyFunnel(session.token, stored.browserBinding),
    null,
  );
  assert.equal(
    current().browserIdleExpiresAt,
    renewed,
    "an expired browser cannot revive its own session",
  );
});
