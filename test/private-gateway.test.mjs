import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { startDom } from "./dom/harness.mjs";

const origin = "https://mac.t.ts.net", privateOrigin = origin + ":8444";
const device = { id: "mac", name: "Mac", platform: "darwin" };
const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
const keys = () => {
  const data = new Map();
  return { read: async key => data.get(key), write: async (key, value) => data.set(key, value), remove: async key => data.delete(key) };
};

test("browser agent prefers a private gateway with the same invitation key and audience", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { createFunnelAgent } = await dom.load("/src/funnel-agent.ts");
    const calls = [];
    const client = createFunnelAgent({
      origin, storage: storage(), keys: keys(), crypto: webcrypto,
      gateway: { endpoint: async () => privateOrigin, failed() {} },
      fetch: async (url, init) => {
        const envelope = JSON.parse(init.body), payload = JSON.parse(envelope.payload);
        calls.push({ url, envelope, payload });
        return Response.json({ status: "pending", requestId: "claim", requestSecret: "s".repeat(43), verificationCode: "123456", expiresAt: Date.now() + 60000, device }, { status: 202 });
      },
    });
    await client.claim(await client.prepare("a".repeat(43)));
    assert.equal(calls[0].url, privateOrigin + "/agent-gateway");
    assert.equal(calls[0].payload.audience, origin, "route changes never change grant/audience");
    const publicKey = await webcrypto.subtle.importKey("jwk", calls[0].envelope.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.equal(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(calls[0].envelope.signature, "base64url"), new TextEncoder().encode(calls[0].envelope.payload)), true);
  } finally { await dom.close(); }
});

test("private-first gateway discovery falls back when unavailable and probes back to private after recovery/restart", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, on = false, instance = "old-runtime";
    const probes = [];
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async (url, init) => {
      probes.push({ url, init });
      if (url.endsWith("/reach-start.json")) return Response.json({ product: "Reach", origin: privateOrigin, name: "Mac", instance: "initial-runtime", tailnet: null });
      if (!on) throw TypeError("not on the tailnet");
      return Response.json({ product: "Reach", instance });
    } });
    assert.equal(await route.endpoint(), origin);
    on = true;
    time = 15001;
    const concurrent = await Promise.all([route.endpoint(), route.endpoint()]);
    assert.deepEqual(concurrent, [privateOrigin, privateOrigin]);
    assert.equal(probes.filter(probe => probe.url.endsWith("/api/health")).length, 2, "one shared new probe per interval");
    route.failed(privateOrigin);
    assert.equal(await route.endpoint(), origin, "future requests use permitted public gateway after private network failure");
    time += 15001;
    instance = "new-runtime-after-normal-restart";
    assert.equal(await route.endpoint(), privateOrigin, "runtime UUID is not the stable grant identity");
    assert.ok(probes.every(({ init }) => init.credentials === "omit" && init.redirect === "error" && !init.headers && !init.body), "discovery and probes carry no credentials/invitation/action");
  } finally { await dom.close(); }
});

for (const bad of ["foreign-host", "non-Reach", "missing-config"]) test(`gateway discovery refuses ${bad} without exposing a grant`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const probes = [];
    const route = privateGatewayRoute({ origin, fetch: async url => {
      probes.push(url);
      if (url.endsWith("/reach-start.json")) return Response.json(bad === "missing-config" ? {} : { product: "Reach", origin: bad === "foreign-host" ? "https://other.t.ts.net:8444" : privateOrigin, name: "Mac", instance: "i1", tailnet: null });
      return Response.json({ product: "Another service" });
    } });
    assert.equal(await route.endpoint(), origin);
    assert.ok(probes.every(url => new URL(url).hostname === new URL(origin).hostname));
  } finally { await dom.close(); }
});

test("lost private action answer is never resent over Funnel; future requests keep the same signed grant", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { createFunnelAgent, funnelFetch } = await dom.load("/src/funnel-agent.ts");
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, loseAction = true;
    const calls = [];
    const gateway = privateGatewayRoute({ origin, now: () => time, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: privateOrigin, name: "Mac", instance: "i1", tailnet: null }
      : { product: "Reach", instance: "i2" }) });
    const client = createFunnelAgent({ origin, storage: storage(), keys: keys(), crypto: webcrypto, gateway,
      fetch: async (url, init) => {
        const envelope = JSON.parse(init.body), payload = JSON.parse(envelope.payload);
        calls.push({ url, payload, publicKey: envelope.publicKey });
        if (payload.operation === "claim") return Response.json({ status: "pending", requestId: "claim", requestSecret: "s".repeat(43), verificationCode: "123456", expiresAt: Date.now() + 60000, device }, { status: 202 });
        if (payload.operation === "status") return Response.json({ status: "approved", token: "same-grant", expiresAt: Date.now() + 60000, device });
        if (payload.method === "POST" && loseAction) { loseAction = false; throw TypeError("action answer lost"); }
        return Response.json({ ok: true });
      },
    });
    let state = await client.claim(await client.prepare("a".repeat(43)));
    state = await client.status(state);
    const peer = state.session.peer;
    await assert.rejects(funnelFetch(peer, "/api/browser/desktop/input", { method: "POST", body: '{"click":true}' }, client, 1), /answer lost/);
    assert.equal(calls.filter(call => call.payload.method === "POST").length, 1);
    await client.request(peer, "/api/browser");
    assert.equal(calls.at(-1).url, origin + "/agent-gateway");
    time = 15001;
    await client.request(peer, "/api/browser");
    assert.equal(calls.at(-1).url, privateOrigin + "/agent-gateway");
    assert.ok(calls.every(call => call.payload.audience === origin));
    assert.ok(calls.every(call => JSON.stringify(call.publicKey) === JSON.stringify(calls[0].publicKey)));
    assert.ok(calls.filter(call => call.payload.operation === "request").every(call => call.payload.token === "same-grant"));
    assert.equal(calls.filter(call => call.payload.operation === "claim").length, 1, "no replacement invitation/approval while routing changes");
    assert.equal(calls.filter(call => call.payload.method === "POST").length, 1, "the unknown action never reappears");
  } finally { await dom.close(); }
});

for (const status of [401, 403, 423, 429, 500]) test(`an authoritative private health ${status} never dispatches a signed operation publicly`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const { createFunnelAgent } = await dom.load("/src/funnel-agent.ts");
    const signed = [];
    const gateway = privateGatewayRoute({ origin, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: privateOrigin, name: "Mac", instance: "i1", tailnet: null }
      : { error: "private policy refused" }, { status: url.endsWith("/reach-start.json") ? 200 : status }) });
    const client = createFunnelAgent({ origin, storage: storage(), keys: keys(), crypto: webcrypto, gateway, fetch: async (url, init) => {
      signed.push({ url, init });
      return Response.json({ status: "pending", requestId: "claim", requestSecret: "s".repeat(43), verificationCode: "123456", expiresAt: Date.now() + 60000, device }, { status: 202 });
    } });
    await assert.rejects(client.claim(await client.prepare("a".repeat(43))), error => error.status === status);
    assert.deepEqual(signed, [], "a reachable private refusal must not become a public signed claim/action");
  } finally { await dom.close(); }
});

test("only the explicit credential-free private availability pause can select public after an HTTP response", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const route = privateGatewayRoute({ origin, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: privateOrigin, name: "Mac", instance: "i1", tailnet: null }
      : { error: "private connection temporarily unavailable" }, { status: url.endsWith("/reach-start.json") ? 200 : 503 }) });
    assert.equal(await route.endpoint(), origin);
  } finally { await dom.close(); }
});
