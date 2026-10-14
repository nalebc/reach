import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../server/index.mjs";
import { createPasskeys } from "../server/passkeys.mjs";
import { createGuestKeys, GUEST_TAG } from "../server/guest-keys.mjs";
import { createFaceJoin } from "../server/face-join.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { softAuthenticator } from "./helpers/soft-authenticator.mjs";
import { tskey } from "./helpers/fake-keys.mjs";

// Face ID sign-in: a new browser, no Tailscale app, no Tailscale login. The
// start page (the internet) gets a challenge, the phone answers with a passkey
// this computer knows, and gets a one-time key (a limited tagged device) and
// a ticket that, shown from that device, makes it yours here. Nothing else
// from the internet, and nobody else's device, gets anything.
const HOST = "mac-a.t.ts.net";
const START = `https://${HOST}`;
const tmp = (t, prefix = "reach-face-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A passkey added here earlier, from a device you approved.
function withPasskey(dataDir, { now } = {}) {
  const passkeys = createPasskeys({ dataDir, rpId: HOST, origins: [`${START}:8443`, START], ...(now ? { now } : {}) });
  const phone = softAuthenticator({ origin: START });
  passkeys.register("c1", phone.create(passkeys.registrationOptions("c1", "me@example.test")), "iPhone");
  return { passkeys, phone };
}
// Tailscale's API, as much of it as Reach uses here.
function tailscaleApi({ devices = [] } = {}) {
  const calls = [];
  let keys = 0;
  const request = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    calls.push([init.method || "GET", u.pathname, body]);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/api/v2/oauth/token") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname === "/api/v2/tailnet/-/keys" && init.method === "POST") return json({ id: `k${++keys}`, key: tskey(`auth-k${keys}CNTRL-secretsecret`) });
    if (u.pathname === "/api/v2/tailnet/-/devices") return json({ devices });
    if (u.pathname.startsWith("/api/v2/device/") && init.method === "DELETE") return json({});
    return json({ message: "no" }, 404);
  };
  return { calls, request, devices };
}
const configure = (dataDir) =>
  fs.writeFileSync(path.join(dataDir, "tailscale-oauth.json"), JSON.stringify({ version: 1, clientId: "kClient", clientSecret: tskey("client-kClient-secret") }));

test("the internet's challenges have a pool of their own: a flood can't block your tailnet's Face ID", (t) => {
  const { passkeys, phone } = withPasskey(tmp(t));
  const first = passkeys.publicOptions();
  assert.deepEqual(first.options.allowCredentials, [], "no passkey IDs handed to the internet");
  assert.equal(first.options.rpId, HOST);
  assert.equal(first.options.userVerification, "required");
  for (let i = 1; i < 32; i++) passkeys.publicOptions();
  assert.throws(() => passkeys.publicOptions(), { status: 429 });
  // Your own devices on the tailnet are untouched by that.
  const own = passkeys.assertionOptions("request-1:nPhone");
  assert.equal(passkeys.verifyAssertion("request-1:nPhone", phone.get(own)).label, "iPhone");
  // And the internet's earlier challenge still works, once.
  assert.equal(passkeys.verifyPublic(first.id, phone.get(first.options)).label, "iPhone");
  assert.throws(() => passkeys.verifyPublic(first.id, phone.get(first.options)), { status: 401 }, "used once");
});

test("from the internet, every answer that isn't a fresh, verified Face ID of yours is refused", (t) => {
  let clock = Date.now();
  const { passkeys, phone } = withPasskey(tmp(t), { now: () => clock });
  const someoneElse = softAuthenticator({ origin: START });
  someoneElse.create({ rp: { id: HOST }, user: { id: "c29tZW9uZQ" }, challenge: "x" });
  const tamper = (credential, change) => ({ ...credential, response: { ...credential.response, ...change(credential.response) } });
  const decode = (s) => JSON.parse(Buffer.from(s, "base64url"));
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const cases = [
    ["another site's page", (o) => phone.get(o, { from: "https://evil.example" })],
    ["the private address's page is fine, the wrong port isn't", (o) => phone.get(o, { from: `${START}:9999` })],
    ["a registration, not a sign-in", (o) => tamper(phone.get(o), (r) => ({ clientDataJSON: encode({ ...decode(r.clientDataJSON), type: "webauthn.create" }) }))],
    ["another challenge", (o) => phone.get({ ...o, challenge: "b3RoZXI" })],
    ["no Face ID (presence only)", (o) => {
      const c = phone.get(o);
      const auth = Buffer.from(c.response.authenticatorData, "base64url");
      auth[32] = 0x01;
      return tamper(c, () => ({ authenticatorData: auth.toString("base64url") }));
    }],
    ["a passkey this computer doesn't know", (o) => someoneElse.get(o)],
    ["a broken signature", (o) => {
      const c = phone.get(o);
      const sig = Buffer.from(c.response.signature, "base64url");
      sig[sig.length - 1] ^= 1;
      return tamper(c, () => ({ signature: sig.toString("base64url") }));
    }],
    ["no user handle", (o) => tamper(phone.get(o), () => ({ userHandle: null }))],
    ["someone else's user handle", (o) => tamper(phone.get(o), () => ({ userHandle: Buffer.from("intruder").toString("base64url") }))],
  ];
  for (const [label, answer] of cases) {
    const { id, options } = passkeys.publicOptions();
    assert.throws(() => passkeys.verifyPublic(id, answer(options)), (e) => [400, 401].includes(e.status), label);
  }
  // The tailnet's sign-in still accepts an answer without a user handle.
  const own = passkeys.assertionOptions("r:n");
  assert.ok(passkeys.verifyAssertion("r:n", tamper(phone.get(own), () => ({ userHandle: null }))));
  // Unknown or made-up IDs, and challenges older than two minutes.
  assert.throws(() => passkeys.verifyPublic("made-up", {}), { status: 401 });
  const late = passkeys.publicOptions();
  clock += 121000;
  assert.throws(() => passkeys.verifyPublic(late.id, phone.get(late.options)), { status: 401 });
});

test("a Face ID key: limited, one-time, named for this computer; cleanup takes only ended ones", async (t) => {
  const old = new Date(Date.now() - 3600000).toISOString();
  const fresh = new Date().toISOString();
  const api = tailscaleApi();
  const dataDir = tmp(t);
  configure(dataDir);
  const keys = createGuestKeys({ dataDir, self: "nMacA", request: api.request });
  const made = await keys.createFaceKey();
  assert.match(made.hostname, new RegExp(`^${keys.prefix.replace("rg-", "rf-")}[a-z0-9]{10}$`));
  assert.match(made.key, /^tskey-auth-/);
  const [, , body] = api.calls.find(([m, p]) => m === "POST" && p === "/api/v2/tailnet/-/keys");
  assert.deepEqual(body.capabilities.devices.create, { reusable: false, ephemeral: false, preauthorized: true, tags: [GUEST_TAG] });
  assert.equal(body.expirySeconds, 600);
  assert.equal(keys.isFaceDevice(`${made.hostname}.t.ts.net`), true);
  assert.equal(keys.isFaceDevice(`${made.hostname}-2`), true, "Tailscale's suffix for a repeated name");
  assert.equal(keys.isFaceDevice(`${made.hostname}x`), false);
  assert.equal(keys.isFaceDevice("iphone-browser"), false);
  const face = (id, name, created, tags = [GUEST_TAG]) => ({ nodeId: id, hostname: name, created, tags });
  api.devices.push(
    face("nLive", made.hostname, old), // still yours here
    face("nEnded", `${made.hostname.slice(0, -1)}z`, old), // access ended
    face("nNew", `${made.hostname.slice(0, -1)}y`, fresh), // still signing in
    face("nGuest", `${keys.prefix}aaaaaaaaaa`, old), // a guest's: not this cleanup's
    face("nOtherMac", "rf-zzzz-aaaaaaaaaa", old), // another computer's
    face("nUntagged", `${made.hostname.slice(0, -1)}w`, old, []), // not a Face ID key's
  );
  assert.equal(await keys.reconcileFace(new Set(["nLive"])), 1);
  assert.deepEqual(
    api.calls.filter(([m]) => m === "DELETE").map(([, p]) => p),
    ["/api/v2/device/nEnded"],
  );
});

test("sign-in tickets: one new browser per Face ID, once, from the device its key made, a few an hour", async (t) => {
  let clock = Date.now();
  const dataDir = tmp(t);
  const { passkeys, phone } = withPasskey(dataDir, { now: () => clock });
  const api = tailscaleApi();
  configure(dataDir);
  const guestKeys = createGuestKeys({ dataDir, self: "nMacA", request: api.request, now: () => clock });
  const face = createFaceJoin({ passkeys, guestKeys, now: () => clock, perHour: 2 });
  const join = async () => {
    const { id, options } = face.options();
    return face.join({ id, credential: phone.get(options) });
  };
  const first = await join();
  const node = (name, tagged = true) => ({ nodeId: "n1", nodeName: name, tagged, userId: tagged ? "" : "42" });
  assert.throws(() => face.redeem(node("rf-zzzz-aaaaaaaaaa"), first.ticket), { status: 403 }, "another device's name");
  assert.throws(() => face.redeem(node(first.hostname, false), first.ticket), { status: 403 }, "not the tagged device");
  assert.deepEqual(face.redeem(node(`${first.hostname}-1.t.ts.net`), first.ticket), { hostname: first.hostname, passkeyId: passkeys.list()[0].id });
  assert.throws(() => face.redeem(node(first.hostname), first.ticket), { status: 401 }, "used once");
  const second = await join();
  clock += 601000;
  assert.throws(() => face.redeem(node(second.hostname), second.ticket), { status: 401 }, "ten minutes");
  await assert.rejects(join(), { status: 429 }, "two new browsers an hour here");
  clock += 3600000;
  assert.ok((await join()).ticket);
  // Without Face ID or invite keys set up, nothing is offered.
  const bare = createFaceJoin({ passkeys: { has: () => false }, guestKeys });
  assert.equal(bare.available(), false);
  assert.throws(() => bare.options(), { status: 404 });
});

// Through Tailscale's private socket (a Mac), and through a Windows PC's
// keyed loopback route (docs/parity/D-public-door.md), which Tailscale's own
// process alone may use (here a stand-in check that says it is).
for (const transport of ["socket", "keyed"])
test(
  `end to end${transport === "keyed" ? " on a Windows PC" : ""}: Face ID from the internet, then that browser is yours here; only it, and only that`,
  { skip: transport === "socket" && process.platform === "win32", timeout: 30000 },
  async (t) => {
    const dir = tmp(t, "reach-face-e2e-");
    const dataDir = path.join(dir, "private");
    fs.mkdirSync(dataDir, { recursive: true });
    const { phone } = withPasskey(dataDir);
    configure(dataDir);
    const api = tailscaleApi();
    const owner = { userId: "42", login: "me@example.test" };
    // Tailscale devices by address; the Face ID one appears once it joins.
    const NODES = {
      "100.64.0.10": { id: "nPhone", user: 42, name: "iphone" },
      "100.64.0.20": { id: "nGuest", user: 7, name: "rg-ab12-guest00001", tags: [GUEST_TAG] },
    };
    const reach = await createReach({
      roots: [dir],
      dataDir,
      port: 0,
      publicOrigin: `${START}:8443`,
      allowedOrigins: [START],
      tailscaleOwner: owner,
      tailscaleIdentity: {
        lookup: async (ip) => {
          const n = NODES[ip];
          return n && {
            Node: { StableID: n.id, User: n.user, Name: `${n.name}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z", ...(n.tags ? { Tags: n.tags } : {}) },
            UserProfile: { ID: n.user, LoginName: n.user === 42 ? owner.login : `user${n.user}@x.test` },
          };
        },
      },
      guestKeys: { request: api.request },
      ...(transport === "keyed" && { platform: "win32" }),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const dist = path.join(dir, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "start.html"), "<!doctype html>start");
    const startPage = publicStartHandler({ dist, tailnetDir: null, privateOrigin: `${START}:8443`, home: START, name: "Mac A", instance: reach.instance, faceId: reach.faceIdAvailable });
    // The internet is answered only while a window is open: an unopened invitation opens one.
    reach.auth.inviteGuest({ name: "Sam", full: true, ttlSeconds: 1800 });
    const publicApp = (req, res) => reach.publicFaceId(req, res) || startPage(req, res);
    let target;
    if (transport === "socket") {
      const socketDir = fs.mkdtempSync("/tmp/reach-face-sock-");
      t.after(() => fs.rmSync(socketDir, { recursive: true, force: true }));
      const socketPath = path.join(socketDir, "s");
      await reach.listenPrivate(socketPath, { publicApp });
      target = { socketPath, prefix: "" };
    } else {
      const key = newIngressKey();
      const port = await reach.listenKeyed({ key, peerCheck: { check: async () => true }, publicApp });
      target = { host: "127.0.0.1", port, prefix: `/r-${key}` };
    }
    t.after(() => reach.close());
    const send = (headers, route, { method = "POST", body, raw } = {}) =>
      new Promise((resolve, reject) => {
        const { prefix, ...where } = target;
        const req = http.request({ ...where, agent: false, path: `${prefix}${route}`, method, headers: { Host: HOST, ...(body || raw ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode, json, text });
          });
        });
        req.on("error", reject);
        req.end(raw ?? (body ? JSON.stringify(body) : undefined));
      });
    // The internet, as Funnel delivers it.
    const internet = (route, opts) => send({ "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.7" }, route, opts);
    // A tailnet device, as Serve delivers it.
    const from = (ip, route, { token, ...opts } = {}) => {
      const n = NODES[ip];
      return send(
        {
          "X-Forwarded-For": ip,
          ...(n.tags ? {} : { "Tailscale-User-Login": owner.login }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        route,
        opts,
      );
    };

    assert.equal(JSON.parse((await internet("/reach-start.json", { method: "GET" })).text).faceId, true, "the start page offers it");
    const ask = await internet("/faceid/options", { body: {} });
    assert.equal(ask.status, 200);
    assert.deepEqual(ask.json.options.allowCredentials, []);
    const joined = await internet("/faceid/join", { body: { id: ask.json.id, credential: phone.get(ask.json.options) } });
    assert.equal(joined.status, 200, joined.text);
    assert.match(joined.json.key, /^tskey-auth-/);
    assert.ok(joined.json.ticket.length >= 40);
    assert.ok(api.calls.some(([m, p]) => m === "POST" && p === "/api/v2/tailnet/-/keys"), "one key made in your tailnet");

    // The browser joins with that key: a tagged device named as told.
    const FACE = "100.64.0.30";
    NODES[FACE] = { id: "nFace", user: 0, name: joined.json.hostname, tags: [GUEST_TAG] };
    assert.deepEqual((await from(FACE, "/api/auth/method", { method: "GET" })).json, { method: "tailscale", eligible: false, faceJoin: true });
    // A guest's device can't use the ticket.
    assert.equal((await from("100.64.0.20", "/api/auth/face-join", { body: { ticket: joined.json.ticket } })).status, 403);
    const signedIn = await from(FACE, "/api/auth/face-join", { body: { ticket: joined.json.ticket, name: "iPhone" } });
    assert.equal(signedIn.status, 200, signedIn.text);
    assert.equal(signedIn.json.status, "approved");
    assert.equal(signedIn.json.device.name, reach.config.name);
    const token = signedIn.json.token;
    assert.equal((await from(FACE, "/api/auth/face-join", { body: { ticket: joined.json.ticket } })).status, 401, "the ticket works once");
    // Yours here: the owner's API answers that device.
    assert.equal((await from(FACE, "/api/device", { method: "GET", token })).status, 200);
    // Only from that device: the same credential from the guest's is refused.
    assert.equal((await from("100.64.0.20", "/api/device", { method: "GET", token })).status, 401);
    // It can't manage Face ID (only devices of your Tailscale account can).
    assert.equal((await from(FACE, "/api/auth/passkeys", { method: "GET", token })).status, 403);
    // The owner rule is otherwise unchanged. On a tagged device only the
    // credential the Face ID route made works: one bound to a tagged device
    // any other way (or half-marked) is refused, and your account's devices'
    // credentials never work there.
    const phoneToken = reach.auth.issue("Phone", ["admin", "files"], "device", { tailscale: { userId: "42", nodeId: "nPhone" } }).token;
    assert.equal((await from("100.64.0.10", "/api/device", { method: "GET", token: phoneToken })).status, 200);
    NODES["100.64.0.40"] = { id: "nTagged", user: 0, name: "some-tagged", tags: [GUEST_TAG] };
    assert.equal((await from("100.64.0.40", "/api/device", { method: "GET", token: phoneToken })).status, 401);
    for (const tailscale of [
      { userId: "", nodeId: "nTagged" },
      { userId: "", nodeId: "nTagged", tagged: true },
      { userId: "", nodeId: "nTagged", faceJoin: true },
      { userId: "", nodeId: "nTagged", faceJoin: "true", tagged: true },
    ]) {
      const forged = reach.auth.issue("Forged", ["admin"], "device", { tailscale }).token;
      assert.equal((await from("100.64.0.40", "/api/device", { method: "GET", token: forged })).status, 401, JSON.stringify(tailscale));
    }
    const guestLike = reach.auth.issue("Guest-like", ["files"], "guest", { tailscale: { userId: "", nodeId: "nTagged", tagged: true, faceJoin: true } });
    assert.ok(guestLike.token, "(guests' own rules apply to guests; not an owner credential)");

    // Removing it in Settings: the device leaves your tailnet too.
    const faceClient = reach.auth.list().find((c) => c.tailscale?.faceJoin);
    assert.deepEqual(faceClient.tailscale, { userId: "", nodeId: "nFace", tagged: true, faceJoin: true, passkeyId: phone.get({rpId: HOST, challenge: "x"}).id });
    api.devices.push({ nodeId: "nFace", hostname: joined.json.hostname, created: new Date(Date.now() - 3600000).toISOString(), tags: [GUEST_TAG] });
    const removed = await from("100.64.0.10", `/api/clients/${faceClient.id}`, { method: "DELETE", token: phoneToken });
    assert.equal(removed.status, 200);
    for (let i = 0; i < 50 && !api.calls.some(([m, p]) => m === "DELETE" && p === "/api/v2/device/nFace"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(api.calls.some(([m, p]) => m === "DELETE" && p === "/api/v2/device/nFace"));
    assert.equal((await from(FACE, "/api/device", { method: "GET", token })).status, 401);

    // What the internet can't do: other methods, other bodies, too many tries.
    assert.equal((await internet("/faceid/options", { method: "GET" })).status, 405);
    assert.equal((await send({ "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.8", "Content-Type": "text/plain" }, "/faceid/options", { raw: "{}" })).status, 415);
    // Too large: answered 413, or cut off before the upload even finishes.
    const big = await internet("/faceid/join", { raw: `{"x":"${"a".repeat(9000)}"}` }).catch((e) => ({ status: e.code }));
    assert.ok([413, "EPIPE", "ECONNRESET"].includes(big.status), String(big.status));
    assert.equal((await internet("/faceid/join", { raw: "not json" })).status, 400);
    assert.equal((await internet("/faceid/join", { body: { id: "made-up", credential: {} } })).status, 401);
    // Reach's own routes stay closed to the internet (the start page answers).
    const closed = await internet("/api/auth/face-join", { body: { ticket: "x" } });
    assert.ok([404, 405].includes(closed.status), String(closed.status));
    assert.doesNotMatch(closed.text, /expired|sign-in|error/i);
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await internet("/faceid/options", { body: {} })).status === 429) limited++;
    assert.ok(limited > 0, "rate limited per address");
    // Removing the passkey also ends browsers it already admitted.
    const challenge = await send({ "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.99" }, "/faceid/options", { body: {} });
    const again = await send({ "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.99" }, "/faceid/join", { body: { id: challenge.json.id, credential: phone.get(challenge.json.options) } });
    NODES[FACE].name = again.json.hostname;
    // Use a different address so the WhoIs cache cannot hold the old node name.
    NODES["100.64.0.51"] = { ...NODES[FACE], id: "nFace2" };
    const admitted = await from("100.64.0.51", "/api/auth/face-join", { body: { ticket: again.json.ticket } });
    assert.equal(admitted.status, 200);
    assert.equal((await from("100.64.0.51", "/api/device", { method: "GET", token: admitted.json.token })).status, 200);
    const passkeyId = faceClient.tailscale.passkeyId;
    assert.equal((await from("100.64.0.10", `/api/auth/passkeys/${passkeyId}`, { method: "DELETE", token: phoneToken })).status, 200);
    assert.equal((await from("100.64.0.51", "/api/device", { method: "GET", token: admitted.json.token })).status, 401);
    assert.equal((await from("100.64.0.10", "/api/device", { method: "GET", token: phoneToken })).status, 200, "local-approved owner survives passkey removal");


  },
);


test("removing a passkey cancels pending tickets and admission in flight", async (t) => {
  const { passkeys, phone } = withPasskey(tmp(t));
  let finish;
  const guestKeys = { configured: () => true, createFaceKey: () => new Promise((r) => { finish = r; }) };
  const join = createFaceJoin({ passkeys, guestKeys });
  const first = join.options();
  const waiting = join.join({ id: first.id, credential: phone.get(first.options) });
  finish({ key: "one-time", hostname: "rf-test-abcdefghij" });
  const ready = await waiting;
  const second = join.options();
  const inFlight = join.join({ id: second.id, credential: phone.get(second.options) });
  passkeys.remove(passkeys.list()[0].id);
  finish({ key: "one-time-2", hostname: "rf-test-abcdefghik" });
  await assert.rejects(inFlight, { status: 401 });
  assert.throws(() => join.redeem({ tagged: true, nodeName: ready.hostname }, ready.ticket), { status: 401 });
});
