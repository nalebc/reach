import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startDom, settle } from "./dom/harness.mjs";

const origin = "https://reach.test";
const invitation = "a".repeat(43);
const device = { id: "mac", name: "My Mac", platform: "darwin" };
let dom, React, createFunnelAgent, funnelStorageKey, FunnelAgent, peerFetch, fileBlob;
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ createFunnelAgent, funnelStorageKey } = await dom.load(
    "/src/funnel-agent.ts",
  ));
  ({ default: FunnelAgent } = await dom.load("/src/FunnelAgent.tsx"));
  ({ peerFetch, fileBlob } = await dom.load("/src/api.ts"));
});
after(async () => dom?.close());

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function storage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
function keys() {
  const data = new Map();
  return {
    data,
    read: async (id) => data.get(id)?.keys,
    write: async (id, keys, expiresAt) => {
      data.set(id, structuredClone({ keys, expiresAt }));
    },
    remove: async (id) => {
      data.delete(id);
    },
  };
}
function fixture(answer) {
  const state = storage(),
    keyStore = keys(),
    calls = [];
  let time = Date.now();
  const options = {
    origin,
    storage: state,
    keys: keyStore,
    crypto: webcrypto,
    now: () => time,
    fetch: async (url, init) => {
      assert.equal(
        url,
        `${origin}/agent-gateway`,
        "all network traffic stays on the Reach gateway",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(new Headers(init.headers).get("Authorization"), null);
      const envelope = JSON.parse(init.body);
      assert.deepEqual(Object.keys(envelope).sort(), [
        "payload",
        "publicKey",
        "signature",
      ]);
      assert.deepEqual(Object.keys(envelope.publicKey).sort(), [
        "crv",
        "kty",
        "x",
        "y",
      ]);
      const key = await webcrypto.subtle.importKey(
        "jwk",
        envelope.publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const signature = Buffer.from(envelope.signature, "base64url");
      assert.equal(
        signature.length,
        64,
        "WebCrypto uses raw P1363 ECDSA signatures",
      );
      assert.equal(
        await webcrypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          signature,
          new TextEncoder().encode(envelope.payload),
        ),
        true,
      );
      const payload = JSON.parse(envelope.payload);
      assert.equal(payload.v, 1);
      assert.equal(payload.audience, origin);
      assert.equal(payload.issuedAt, time);
      assert.equal(Buffer.from(payload.nonce, "base64url").length, 24);
      assert.ok(
        !calls.some((c) => c.payload.nonce === payload.nonce),
        "every proof has a new nonce",
      );
      calls.push({ envelope, payload });
      return answer(payload, calls);
    },
  };
  return {
    options,
    client: createFunnelAgent(options),
    calls,
    state,
    keyStore,
    advance: (ms) => {
      time += ms;
    },
  };
}
const receipt = () => ({
  status: "pending",
  requestId: "claim-1",
  requestSecret: "s".repeat(43),
  verificationCode: "123456",
  expiresAt: Date.now() + 300000,
  device,
});
const approved = () => ({
  status: "approved",
  token: "agent-session-token",
  expiresAt: Date.now() + 900000,
  device,
});

test("claim, approval and binary workspace requests are signed with a persisted nonextractable key", async () => {
  const f = fixture((payload) =>
    payload.operation === "claim"
      ? reply(receipt(), 202)
      : payload.operation === "status"
        ? reply(approved())
        : new Response(new Uint8Array([1, 2, 3]), {
            headers: { "Content-Type": "image/jpeg" },
          }),
  );
  let state = await f.client.prepare(invitation);
  assert.equal(
    f.calls.length,
    0,
    "storage succeeds before the invitation is consumed",
  );
  const pair = f.keyStore.data.get(state.id).keys;
  assert.equal(pair.privateKey.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey("jwk", pair.privateKey));
  assert.deepEqual(JSON.parse(f.state.getItem(funnelStorageKey)), state);
  assert.doesNotMatch(
    f.state.getItem(funnelStorageKey),
    /privateKey|publicKey|"d"/,
  );
  state = await f.client.claim(state);
  assert.equal(state.receipt.verificationCode, "123456");
  assert.equal(
    state.session,
    undefined,
    "pending admission grants no credential",
  );
  assert.equal(f.calls[0].payload.invitation, invitation);
  assert.equal(
    f.keyStore.data.get(state.id).expiresAt,
    state.receipt.expiresAt,
  );
  state = await f.client.status(state);
  assert.equal(state.session.peer.transport, "funnel");
  assert.equal(f.calls[1].payload.secret, "s".repeat(43));
  assert.equal(
    JSON.parse(f.state.getItem(funnelStorageKey)).session.peer.token,
    "agent-session-token",
    "approval is saved before rendering",
  );
  assert.equal(
    f.keyStore.data.get(state.id).expiresAt,
    state.session.expiresAt,
  );
  const result = await f.client.request(
    state.session.peer,
    "/api/browser/screen",
  );
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2, 3]);
  assert.equal(f.calls[2].payload.token, "agent-session-token");
  assert.equal(f.calls[2].payload.path, "/api/browser/screen");
  assert.equal(f.calls[2].payload.body, null);
  assert.deepEqual(
    f.calls[0].envelope.publicKey,
    f.calls[2].envelope.publicKey,
  );
  await f.client.forget(state);
  assert.equal(f.state.getItem(funnelStorageKey), null);
  assert.equal(f.keyStore.data.size, 0);
});

test("reload and the same invite retain the key and receipt; a new invitation creates a new identity", async () => {
  const f = fixture(() => reply(receipt(), 202));
  const initial = await f.client.prepare(invitation);
  const claimed = await f.client.claim(initial);
  const reloaded = createFunnelAgent(f.options);
  assert.deepEqual(await reloaded.prepare(), claimed);
  assert.deepEqual(await reloaded.prepare(invitation), claimed);
  assert.deepEqual(await reloaded.claim(claimed), claimed);
  assert.equal(f.calls.length, 1, "same-link reopen does not redeem twice");
  const next = await reloaded.prepare("b".repeat(43));
  assert.notEqual(next.id, initial.id);
  assert.equal(f.keyStore.data.has(initial.id), false);
  assert.equal(next.receipt, undefined);
});

test("tab or key storage failures fail closed before claiming, and a missing persisted key cannot be replaced", async () => {
  const f = fixture(() => {
    assert.fail("No invitation should be consumed");
  });
  const blockedTab = createFunnelAgent({
    ...f.options,
    storage: {
      ...f.state,
      setItem() {
        throw Error("blocked");
      },
    },
  });
  await assert.rejects(blockedTab.prepare(invitation), /securely save/);
  const blockedKey = createFunnelAgent({
    ...f.options,
    keys: {
      ...f.keyStore,
      write: async () => {
        throw Error("DataCloneError");
      },
    },
  });
  await assert.rejects(blockedKey.prepare(invitation), /securely save/);
  const ready = await f.client.prepare(invitation);
  f.keyStore.data.delete(ready.id);
  await assert.rejects(
    createFunnelAgent(f.options).prepare(invitation),
    /securely save/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.keyStore.data.size, 0);
});

test("a lost claim response is never automatically redeemed again, including after reload", async () => {
  const f = fixture(() => {
    throw Error("Network reset");
  });
  const state = await f.client.prepare(invitation);
  await assert.rejects(f.client.claim(state), /Network reset/);
  await assert.rejects(f.client.claim(state), /already sent from this tab/);
  const next = createFunnelAgent(f.options);
  await assert.rejects(
    next.claim(await next.prepare(invitation)),
    /already sent from this tab/,
  );
  assert.equal(f.calls.length, 1);
});

test("expiry deletes stored credentials and signed requests reject different peers or paths", async () => {
  const f = fixture((payload) =>
    reply(payload.operation === "claim" ? receipt() : approved()),
  );
  let state = await f.client.prepare(invitation);
  state = await f.client.claim(state);
  state = await f.client.status(state);
  const { peer } = state.session;
  await assert.rejects(
    f.client.request({ ...peer, url: "https://other.test" }, "/api/browser"),
    /connection has ended/,
  );
  await assert.rejects(
    f.client.request({ ...peer, sessionId: "other-tab" }, "/api/browser"),
    /connection has ended/,
  );
  await assert.rejects(
    f.client.request(peer, "https://other.test/api/browser"),
    /outside/,
  );
  await assert.rejects(f.client.request(peer, "/api/browser#x"), /outside/);
  f.advance(3600000);
  await assert.rejects(
    f.client.request(peer, "/api/browser"),
    /connection has ended/,
  );
  await assert.rejects(f.client.prepare(), /connection has ended/);
  assert.equal(f.state.getItem(funnelStorageKey), null);
  assert.equal(f.keyStore.data.size, 0);
  assert.equal(f.calls.length, 2);
});

test("strict rendering claims once, displays the owner's comparison code, and resumes its receipt", async () => {
  dom.window.history.replaceState(
    null,
    "",
    `/agent-browser#invite=${invitation}`,
  );
  const f = fixture((payload) =>
    reply(payload.operation === "claim" ? receipt() : { status: "pending" }),
  );
  let view = await dom.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(FunnelAgent, { client: f.client }),
    ),
  );
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Verification code"]'),
  );
  assert.match(view.container.textContent, /Ask the owner to approve/);
  assert.match(view.container.textContent, /123 456/);
  assert.match(
    view.container.textContent,
    /Temporary connection through Tailscale/,
  );
  assert.equal(
    f.calls.filter(({ payload }) => payload.operation === "claim").length,
    1,
  );
  assert.equal(dom.window.location.hash, "");
  assert.equal(
    JSON.parse(f.state.getItem(funnelStorageKey)).session,
    undefined,
  );
  await view.unmount();
  view = await dom.render(
    React.createElement(FunnelAgent, { client: createFunnelAgent(f.options) }),
  );
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Verification code"]'),
  );
  assert.equal(
    f.calls.filter(({ payload }) => payload.operation === "claim").length,
    1,
  );
  await view.unmount();
});

test("file downloads cannot fall back to bearer requests when a signed browser session is missing", async () => {
  let calls = 0;
  globalThis.fetch = dom.window.fetch = async () => { calls++; return reply({}); };
  await assert.rejects(fileBlob({ ...device, url: origin, token: "agent-session-token", transport: "funnel", sessionId: "missing" }, "report.pdf", 0), { status: 401 });
  assert.equal(calls, 0, "no unsigned request or token leak");
});

test("ordinary owner calls keep their bearer transport and the agent entry loads no Tailscale browser client", async () => {
  let called;
  globalThis.fetch = dom.window.fetch = async (...args) => {
    called = args;
    return reply({ ok: true });
  };
  await peerFetch(
    { ...device, url: "https://private.ts.net:8443", token: "owner" },
    "/api/device",
  );
  assert.equal(called[0], "https://private.ts.net:8443/api/device");
  assert.equal(
    new Headers(called[1].headers).get("Authorization"),
    "Bearer owner",
  );
  const entry = await readFile(
    new URL("../src/funnel-agent-entry.tsx", import.meta.url),
    "utf8",
  );
  const app = await readFile(
    new URL("../src/FunnelAgent.tsx", import.meta.url),
    "utf8",
  );
  const transport = await readFile(
    new URL("../src/funnel-agent.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    entry + app + transport,
    /tailnet-transport|tailscale\.com|WebAssembly|\/api\/guests\/key/,
  );
  assert.deepEqual(dom.errors, []);
});
