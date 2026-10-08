import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createAuth } from "../server/core.mjs";
import { createFunnelAgentGateway } from "../server/funnel-agent.mjs";

const ORIGIN = "https://computer.example.ts.net";
const random = (size = 32) => crypto.randomBytes(size).toString("base64url");
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
function signed(key, input, overrides = {}) {
  const payload = JSON.stringify({
    v: 1,
    audience: ORIGIN,
    issuedAt: Date.now(),
    nonce: random(24),
    ...input,
    ...overrides,
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
class Response extends Writable {
  headers = {};
  statusCode = 200;
  chunks = [];
  headersSent = false;
  _write(chunk, encoding, done) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers))
      this.setHeader(name, value);
    this.headersSent = true;
  }
}
function send(handler, envelope, options = {}) {
  const req = new PassThrough();
  req.method = options.method ?? "POST";
  req.url = options.url ?? "/agent-gateway";
  req.headers = {
    host: new URL(ORIGIN).host,
    origin: ORIGIN,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    ...options.headers,
  };
  req.socket = { remoteAddress: options.ip ?? "127.0.0.1" };
  const res = new Response();
  const done = new Promise((resolve, reject) => {
    res.once("finish", () => {
      const bytes = Buffer.concat(res.chunks);
      let body;
      try {
        body = JSON.parse(bytes.toString());
      } catch {}
      resolve({ status: res.statusCode, body, bytes, headers: res.headers });
    });
    res.once("error", reject);
  });
  const handled = handler(req, res);
  if (handled && !options.hold)
    req.end(options.raw ?? JSON.stringify(envelope));
  return { req, res, handled, done };
}
function setup(t, options = {}) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-gateway-")),
  );
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const auth = createAuth({
    dataDir: path.join(dir, "private"),
    roots: [shared],
    agentPolicyFile: path.join(dir, "policy.json"),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = signingKey();
  let available = true;
  const claims = [],
    dispatched = [];
  const gateway = createFunnelAgentGateway({
    origin: ORIGIN,
    auth,
    available: () => available,
    device: () => ({ name: "Test laptop", id: "test-device" }),
    claimed: (receipt) => claims.push(receipt),
    dispatch: (req, res, context) => {
      dispatched.push({ req, context });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([0, 255, 1, 128]));
    },
    ...options,
  });
  const call = (envelope, overrides) => send(gateway, envelope, overrides).done;
  const grant = () =>
    auth.inviteBrowser({
      name: "Muse",
      ttlSeconds: 600,
      folders: [{ root: 0, path: "" }],
      screen: "ask",
      commandRequests: true,
      transport: "funnel",
    });
  const claim = async (invite = grant(), signer = key) => {
    const response = await call(
      signed(signer, { operation: "claim", invitation: invite.invitation }),
    );
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return response.body;
  };
  const poll = (receipt, signer = key) =>
    call(
      signed(signer, {
        operation: "status",
        requestId: receipt.requestId,
        secret: receipt.requestSecret,
      }),
    );
  const join = async () => {
    const receipt = await claim();
    auth.decideAgentAdmission(receipt.requestId, "approve");
    const response = await poll(receipt);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "approved");
    return response.body.token;
  };
  const request = (
    token,
    route = "/api/browser",
    method = "GET",
    body = null,
    signer = key,
  ) =>
    signed(signer, { operation: "request", token, method, path: route, body });
  return {
    auth,
    key,
    gateway,
    call,
    grant,
    claim,
    poll,
    join,
    request,
    claims,
    dispatched,
    close: () => {
      available = false;
    },
  };
}

test("Funnel claim remains powerless until owner approval, and dispatch retains a frozen browser context", async (t) => {
  const f = setup(t);
  const grant = f.grant();
  const receipt = await f.claim(grant);
  assert.equal(receipt.token, undefined);
  assert.equal(receipt.status, "pending");
  assert.deepEqual(receipt.device, { name: "Test laptop", id: "test-device" });
  assert.equal(f.claims.length, 1);
  for (const token of [grant.invitation, receipt.requestSecret]) {
    assert.equal((await f.call(f.request(token))).status, 401);
    assert.equal(f.auth.verify(token), null);
  }
  assert.equal((await f.poll(receipt)).body.status, "pending");
  assert.equal(
    (
      await f.call(
        signed(f.key, { operation: "claim", invitation: grant.invitation }),
      )
    ).status,
    401,
  );
  assert.equal(f.claims.length, 1);
  assert.equal(f.dispatched.length, 0);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  const result = await f.poll(receipt);
  assert.equal(result.body.status, "approved");
  const token = result.body.token;
  assert.equal(
    f.auth.verify(token),
    null,
    "Funnel token cannot act as a normal bearer credential",
  );
  assert.equal(
    (await f.poll(receipt)).body?.token,
    undefined,
    "one collection only",
  );
  const binary = await f.call(f.request(token));
  assert.equal(binary.status, 200);
  assert.deepEqual([...binary.bytes], [0, 255, 1, 128]);
  assert.equal(binary.headers["cache-control"], "no-store");
  assert.equal(binary.headers["access-control-allow-origin"], undefined);
  assert.equal(f.dispatched[0].req.headers["tailscale-node-id"], undefined);
  assert.equal(f.dispatched[0].context.token, token);
  assert.ok(Object.isFrozen(f.dispatched[0].context));
  assert.equal(
    (
      await f.call(
        f.request(token, "/api/browser/requests", "POST", {
          type: "command",
          command: "pwd",
          details: { nested: true },
        }),
      )
    ).status,
    200,
  );
  assert.ok(Object.isFrozen(f.dispatched[1].context.body.details));
});

test("Funnel keys bind both receipt and token; revocation immediately blocks access", async (t) => {
  const f = setup(t),
    second = signingKey();
  const receipt = await f.claim();
  assert.equal((await f.poll(receipt, second)).status, 401);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  const token = (await f.poll(receipt)).body.token;
  assert.equal(
    (await f.call(f.request(token, "/api/device", "GET", null, second))).status,
    401,
  );
  assert.equal(f.dispatched.length, 0);
  f.auth.revoke(receipt.clientId);
  assert.equal((await f.call(f.request(token))).status, 401);
});

test("the endpoint rejects other origins, hosts, methods and query aliases before consuming invites", async (t) => {
  const f = setup(t),
    grant = f.grant();
  const envelope = signed(f.key, {
    operation: "claim",
    invitation: grant.invitation,
  });
  for (const [options, expected] of [
    [{ method: "GET" }, 405],
    [{ headers: { host: "attacker.example" } }, 421],
    [
      {
        headers: {
          host: "localhost",
          "x-forwarded-host": new URL(ORIGIN).host,
          "tailscale-funnel-request": "?1",
        },
      },
      421,
    ],
    [{ headers: { host: new URL(ORIGIN).host + ":443" } }, 421],
    [{ headers: { origin: "https://attacker.example" } }, 403],
    [{ headers: { origin: undefined } }, 403],
    [{ headers: { origin: "null" } }, 403],
    [{ headers: { "sec-fetch-site": "cross-site" } }, 403],
    [{ headers: { "content-type": "text/plain" } }, 415],
    [{ headers: { "content-encoding": "gzip" } }, 415],
  ])
    assert.equal((await f.call(envelope, options)).status, expected);
  for (const url of [
    "/agent-gateway?x=1",
    "/agent-gateway/",
    "/api/device",
    "/AGENT-GATEWAY",
    "/%61gent-gateway",
  ]) {
    const response = send(f.gateway, envelope, { url });
    assert.equal(response.handled, false);
    response.req.destroy();
    response.res.destroy();
  }
  assert.equal(f.claims.length, 0);
  assert.equal(
    (await f.call(envelope, { headers: { "sec-fetch-site": undefined } }))
      .status,
    202,
  );
});

test("a trusted host resolver supports the Unix proxy without weakening exact host checks", async (t) => {
  let resolved = new URL(ORIGIN).host;
  const f = setup(t, { requestHost: () => resolved });
  const envelope = signed(f.key, {
    operation: "claim",
    invitation: f.grant().invitation,
  });
  resolved = "attacker.example";
  assert.equal(
    (await f.call(envelope, { headers: { host: "localhost" } })).status,
    421,
  );
  resolved = new URL(ORIGIN).host;
  assert.equal(
    (await f.call(envelope, { headers: { host: "localhost" } })).status,
    202,
  );
});

test("early header rejections drain the unread body before reusing an HTTP connection", async (t) => {
  const f = setup(t);
  const envelope = signed(f.key, {
    operation: "claim",
    invitation: f.grant().invitation,
  });
  for (const [headers, status] of [
    [{ host: "attacker.example" }, 421],
    [{ origin: "https://attacker.example" }, 403],
    [{ "content-type": "text/plain" }, 415],
    [{ "content-length": "32769" }, 413],
  ]) {
    const entry = send(f.gateway, envelope, { headers, hold: true });
    assert.equal((await entry.done).status, status);
    assert.equal(entry.req.readableFlowing, true);
    const drained = new Promise((resolve) => entry.req.once("end", resolve));
    entry.req.end(JSON.stringify(envelope));
    await drained;
    assert.equal(entry.req.readableLength, 0);
  }
  assert.equal(f.claims.length, 0);
  assert.equal((await f.call(envelope)).status, 202);
});

test("signed requests reject replay, stale/future clocks, audience changes, signatures and key substitutions", async (t) => {
  const f = setup(t),
    grant = f.grant(),
    input = { operation: "claim", invitation: grant.invitation };
  const other = signingKey();
  for (const envelope of [
    signed(f.key, input, { audience: "https://other.example.ts.net" }),
    signed(f.key, input, { issuedAt: Date.now() - 61_000 }),
    signed(f.key, input, { issuedAt: Date.now() + 61_000 }),
    signed(f.key, input, { nonce: random(23) }),
    signed(f.key, input, { v: 2 }),
    { ...signed(f.key, input), publicKey: other.jwk },
    { ...signed(f.key, input), signature: random(64) },
    { ...signed(f.key, input), payload: JSON.stringify(input) },
  ])
    assert.ok([400, 401].includes((await f.call(envelope)).status));
  const envelope = signed(f.key, input);
  const simultaneous = await Promise.all([f.call(envelope), f.call(envelope)]);
  assert.deepEqual(
    simultaneous.map((result) => result.status).sort(),
    [202, 409],
  );
  assert.equal(f.claims.length, 1);
  assert.equal((await f.call(envelope)).status, 409);
});

test("P-256 public keys and envelope fields are strict, including private or unexpected JWK attributes", async (t) => {
  const f = setup(t),
    grant = f.grant(),
    input = { operation: "claim", invitation: grant.invitation };
  const valid = signed(f.key, input);
  for (const publicKey of [
    { ...f.key.jwk, d: random() },
    { ...f.key.jwk, alg: "ES256" },
    { ...f.key.jwk, crv: "P-384" },
    { ...f.key.jwk, x: random(31) },
    { ...f.key.jwk, x: "A".repeat(43), y: "A".repeat(43) },
    { ...f.key.jwk, ext: false },
    { ...f.key.jwk, key_ops: ["sign", "verify"] },
  ])
    assert.equal((await f.call({ ...valid, publicKey })).status, 400);
  assert.equal((await f.call({ ...valid, token: random() })).status, 400);
  assert.equal(
    (await f.call(signed(f.key, input, { extra: true }))).status,
    400,
  );
  assert.equal(f.claims.length, 0);
  assert.equal((await f.call(valid)).status, 202);
});

test("a public request can reach only explicitly granted browser APIs, with no ambiguous paths", async (t) => {
  const f = setup(t),
    token = await f.join();
  for (const route of [
    "/api/agents/browser-invitations",
    "/api/agents/admissions",
    "/api/clients",
    "/api/guests",
    "/api/pair",
    "/api/invitations/redeem",
    "/api/exec",
    "/api/terminals",
    "/api/jobs",
    "/api/screen",
    "/api/settings",
    "/api/fleet",
    "/ws",
    "/api/proxy",
    "/api/../api/device",
    "/api//device",
    "/api/browser/../device",
    "/api/browser/%2e%2e/device",
    "/api/browser%2fscreen",
    "/api/browser%5cscreen",
    "/api/browser%252fscreen",
    "/api/browser\\screen",
    "/api/browser#private",
    "https://attacker.example/api/browser",
    "/api/browser?x=1&x=2",
  ])
    assert.ok(
      [400, 403].includes((await f.call(f.request(token, route))).status),
      route,
    );
  for (const [route, method] of [
    ["/api/files", "POST"],
    ["/api/device", "POST"],
    ["/api/browser/scroll", "POST"],
    ["/api/browser", "DELETE"],
  ])
    assert.equal(
      (await f.call(f.request(token, route, method))).status,
      403,
      route,
    );
  assert.equal(f.dispatched.length, 0);
  const route = "/api/files/text?root=0&path=Project%20notes%2Fbrief.txt";
  assert.equal((await f.call(f.request(token, route))).status, 200);
  assert.equal(f.dispatched[0].context.path, route);
  // Preset sessions (agent-presets.mjs) reach the Mac through the same gateway:
  // their screen, input, apps, shell and file changes pass; nothing else new does.
  // The gateway still applies each invitation's own allowlist, so a Full
  // control invitation is claimed and admitted here.
  const presetReceipt = await f.claim(f.auth.inviteBrowser({ name: "Muse", ttlSeconds: 600, preset: "full", transport: "funnel" }));
  f.auth.decideAgentAdmission(presetReceipt.requestId, "approve");
  const admitted = await f.call(signed(f.key, { operation: "status", requestId: presetReceipt.requestId, secret: presetReceipt.requestSecret }));
  assert.equal(admitted.body.status, "approved");
  const presetToken = admitted.body.token;
  assert.equal((await f.call(f.request(token, "/api/browser/desktop/screen"))).status, 403, "the earlier form's invitation never gets the screen");
  for (const [presetRoute, method, body] of [
    ["/api/browser/services", "GET", null],
    ["/api/browser/services/request", "POST", { connectorId: "sample_store", reason: "Read sample order" }],
    ["/api/browser/services/run", "POST", { connectorId: "sample_store", action: "order_status", requestId: crypto.randomUUID(), values: { orderId: "DEMO-1001" } }],
    ["/api/browser/desktop/screen?maxWidth=1440", "GET", null],
    ["/api/browser/desktop/front", "GET", null],
    ["/api/browser/shortcuts", "GET", null],
    ["/api/browser/shortcuts?query=Gmail", "GET", null],
    ["/api/browser/shortcuts/record", "POST", { name: "Open Gmail" }],
    ["/api/browser/shortcuts/save", "POST", {}],
    ["/api/browser/shortcuts/run", "POST", { id: "12345678-1234-4321-8123-123456789abc" }],
    ["/api/browser/shortcuts/record", "DELETE", null],
    ["/api/browser/desktop/apps", "GET", null],
    ["/api/browser/shell/history", "GET", null],
    ["/api/browser/desktop/input", "POST", { action: { type: "click", x: 0.5, y: 0.5 } }],
    ["/api/browser/desktop/open", "POST", { app: "/Applications/Safari.app" }],
    ["/api/browser/shell", "POST", { command: "ls", root: 0, cwd: "" }],
    ["/api/browser/files/change", "POST", { op: "write", root: 0, path: "a.txt", content: "x" }],
  ]) {
    const before = f.dispatched.length;
    assert.equal((await f.call(f.request(presetToken, presetRoute, method, body))).status, 200, `${method} ${presetRoute}`);
    assert.equal(f.dispatched.length, before + 1, `${method} ${presetRoute} dispatched`);
    assert.equal(f.dispatched.at(-1).context.path, presetRoute);
    assert.equal(f.dispatched.at(-1).context.method, method);
  }
  for (const [deniedRoute, method] of [
    ["/api/browser/desktop/input", "GET"],
    ["/api/browser/desktop/screen", "POST"],
    ["/api/browser/desktop/other", "GET"],
    ["/api/browser/shortcuts/other", "POST"],
    ["/api/agents/shortcuts", "GET"],
    ["/api/browser/shell", "GET"],
    ["/api/browser/files/change", "GET"],
    ["/api/browser/agents/pause", "POST"],
    ["/api/agents/browser-invitations", "POST"],
  ]) {
    const before = f.dispatched.length;
    assert.equal((await f.call(f.request(presetToken, deniedRoute, method, method === "POST" ? {} : null))).status, 403, `${method} ${deniedRoute}`);
    assert.equal(f.dispatched.length, before, `${method} ${deniedRoute} never dispatched`);
  }
  assert.equal(
    (await f.call(f.request(token, "/api/browser/terminals/reach%3Asession-1")))
      .status,
    200,
  );
  assert.equal(
    (await f.call(f.request(token, "/api/browser", "GET", {}))).status,
    400,
  );
  assert.equal(
    (await f.call(f.request(token, "/api/browser/requests", "POST", [])))
      .status,
    400,
  );
});

test("a closed ephemeral window rejects claim, status and even an approved credential", async (t) => {
  const f = setup(t),
    token = await f.join(),
    grant = f.grant();
  const receipt = await f.claim(grant);
  f.close();
  assert.equal((await f.call(f.request(token))).status, 503);
  assert.equal((await f.poll(receipt)).status, 503);
  assert.equal(
    (
      await f.call(
        signed(f.key, { operation: "claim", invitation: f.grant().invitation }),
      )
    ).status,
    503,
  );
  assert.equal(f.dispatched.length, 0);
});

test("oversized and invalid request bodies fail closed without consuming an invitation", async (t) => {
  const f = setup(t),
    grant = f.grant();
  const envelope = signed(f.key, {
    operation: "claim",
    invitation: grant.invitation,
  });
  for (const [options, status] of [
    [{ raw: "x".repeat(32 * 1024 + 1) }, 413],
    [{ headers: { "content-length": "32769" } }, 413],
    [{ raw: "{" }, 400],
    [{ raw: Buffer.from([0xc3, 0x28]) }, 400],
    [{ raw: "[]" }, 400],
  ])
    assert.equal((await f.call(envelope, options)).status, status);
  assert.equal(f.claims.length, 0);
  assert.equal((await f.call(envelope)).status, 202);
});

test("slow bodies have bounded active slots which are released on completion", async (t) => {
  const f = setup(t),
    grant = f.grant(),
    envelope = signed(f.key, {
      operation: "claim",
      invitation: grant.invitation,
    });
  const held = Array.from({ length: 8 }, () =>
    send(f.gateway, envelope, { hold: true }),
  );
  assert.equal((await f.call(envelope)).status, 429);
  for (const entry of held) entry.req.end("{}");
  assert.ok(
    (await Promise.all(held.map((entry) => entry.done))).every(
      (response) => response.status === 400,
    ),
  );
  assert.equal((await f.call(envelope)).status, 202);
});

test("per-key rate limiting bounds signed polling and recovers after its window", async (t) => {
  let clock = Date.now();
  const f = setup(t, { now: () => clock });
  const receipt = await f.claim();
  for (let index = 0; index < 179; index++)
    assert.equal((await f.poll(receipt)).status, 200);
  const limited = await f.poll(receipt);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "5");
  clock += 60_001;
  const envelope = signed(
    f.key,
    {
      operation: "status",
      requestId: receipt.requestId,
      secret: receipt.requestSecret,
    },
    { issuedAt: clock },
  );
  assert.equal((await f.call(envelope)).status, 200);
});

test("the body deadline ends stalled requests and rechecks an expired window before claim", async (t) => {
  const f = setup(t);
  const envelope = signed(f.key, {
    operation: "claim",
    invitation: f.grant().invitation,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled = send(f.gateway, envelope, { hold: true });
  t.mock.timers.tick(8000);
  assert.equal((await stalled.done).status, 408);
  stalled.req.end();
  const closing = send(f.gateway, envelope, { hold: true });
  f.close();
  closing.req.end(JSON.stringify(envelope));
  assert.equal((await closing.done).status, 503);
  assert.equal(f.claims.length, 0);
});

test("global in-flight limits apply across IP addresses and release on disconnect", async (t) => {
  const f = setup(t);
  const envelope = signed(f.key, {
    operation: "claim",
    invitation: f.grant().invitation,
  });
  const held = Array.from({ length: 32 }, (_, index) =>
    send(f.gateway, envelope, { hold: true, ip: `192.0.2.${index + 1}` }),
  );
  assert.equal((await f.call(envelope, { ip: "198.51.100.1" })).status, 429);
  for (const entry of held) {
    entry.res.destroy();
    entry.req.emit("aborted");
    entry.req.end();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.call(envelope, { ip: "198.51.100.1" })).status, 202);
});

test("gateway errors never return raw auth details or credentials", async (t) => {
  const secret = random();
  const f = setup(t, {
    auth: {
      redeemFunnelBrowser: () => {
        throw Object.assign(new Error(`Internal ${secret}`), { status: 401 });
      },
    },
  });
  const response = await f.call(
    signed(f.key, { operation: "claim", invitation: secret }),
  );
  assert.equal(response.status, 401);
  assert.equal(response.bytes.toString().includes(secret), false);
  assert.equal(response.bytes.toString().includes("Internal"), false);
});
