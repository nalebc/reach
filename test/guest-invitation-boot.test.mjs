import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startDom, settle } from "./dom/harness.mjs";

const origin = "https://guest-boot.tail.ts.net";
const oldSecret = "a".repeat(43), newSecret = "b".repeat(43);
const fingerprint = secret => createHash("sha256").update(JSON.stringify([[origin, secret]])).digest("hex");
const old = () => ({ peers: [{ id: "old", name: "Previous guest", url: origin, token: "old-token" }],
  expiresAt: Date.now() + 600000, invitationId: fingerprint(oldSecret) });

async function boot(t, { secret = newSecret, refuse = false, hash, saved = old() } = {}) {
  const dom = await startDom({ fakes: {
    "src/App.tsx": "test/dom/fakes/guest-boot-app.mjs",
  } });
  const calls = [], reloads = [];
  // jsdom cannot perform navigation. Observe the real entry's reload call
  // while delegating every other Location property to the actual DOM URL.
  Object.defineProperty(globalThis, "location", { configurable: true, value: new Proxy({}, {
    get(_target, key) {
      const target = dom.window.location;
      if (key === "reload") return () => reloads.push(target.hash);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) });
  const sessionKey = "reach.guest-session", ownerKey = "reach.devices";
  dom.window.sessionStorage.setItem(sessionKey, JSON.stringify(saved));
  dom.window.localStorage.setItem(ownerKey, "owner-pairing-unchanged");
  dom.window.history.replaceState(null, "", "/guest" + (hash ?? `#${new URLSearchParams({ i: `${origin}~${secret}`, k: "tskey-auth-never-store-this-key" })}`));
  globalThis.fetch = dom.window.fetch = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    const token = new Headers(init.headers).get("Authorization");
    calls.push({ path: url.pathname, token });
    if (url.pathname === "/api/guest/redeem") {
      assert.equal(JSON.parse(init.body).invitation, secret);
      if (refuse) return Response.json({ error: "This invitation expired." }, { status: 401 });
      return Response.json({ token: "new-token", clientId: "new", expiresAt: Date.now() + 600000,
        device: { id: "new", name: "New visitor", platform: "darwin" } });
    }
    assert.equal(url.pathname, "/api/device");
    assert.ok(["Bearer old-token", "Bearer new-token"].includes(token));
    return Response.json({ id: "fixture", access: { scopes: ["device"], expiresAt: Date.now() + 600000 } });
  };
  const root = dom.document.createElement("div"); root.id = "root"; dom.document.body.append(root);
  const { appRoot } = await dom.load("/src/main.tsx");
  const view = { container: root };
  t.after(async () => {
    dom.update(() => appRoot.unmount()); await settle(); await dom.close();
  });
  return { dom, view, calls, saved, sessionKey, ownerKey, reloads };
}

test("a different valid invitation in the same tab starts its own flow instead of the old guest workspace", async t => {
  const f = await boot(t);
  await f.dom.waitFor(() => f.view.container.querySelector('[aria-label="Opened guest workspace"]'));
  assert.equal(f.view.container.querySelector('[aria-label="Opened guest workspace"]').textContent, "New visitor");
  assert.equal(f.calls.filter(c => c.path === "/api/guest/redeem").length, 1);
  assert.ok(!f.calls.some(c => c.token === "Bearer old-token"), "new-link startup never sends the older guest credential");
  const saved = JSON.parse(f.dom.window.sessionStorage.getItem(f.sessionKey));
  assert.equal(saved.invitationId, fingerprint(newSecret));
  assert.doesNotMatch(JSON.stringify(saved), /tskey-auth|bbbbbbbbbb/);
  assert.equal(f.dom.window.location.hash, "");
  assert.equal(f.dom.window.localStorage.getItem(f.ownerKey), "owner-pairing-unchanged");
  assert.deepEqual(f.dom.errors, []);
});

test("reopening the same consumed invitation resumes saved access without redeeming it again", async t => {
  const f = await boot(t, { secret: oldSecret });
  await f.dom.waitFor(() => f.view.container.querySelector('[aria-label="Opened guest workspace"]'));
  assert.match(f.view.container.textContent, /Previous guest/);
  assert.equal(f.calls.filter(c => c.path === "/api/guest/redeem").length, 0);
  assert.equal(f.dom.window.location.hash, "");
  assert.equal(JSON.parse(f.dom.window.sessionStorage.getItem(f.sessionKey)).invitationId, fingerprint(oldSecret));
  assert.equal(f.dom.window.localStorage.getItem(f.ownerKey), "owner-pairing-unchanged");
  assert.deepEqual(f.dom.errors, []);
});

test("an expired replacement invitation shows its error and preserves the previous saved access", async t => {
  const f = await boot(t, { refuse: true });
  await f.dom.waitFor(() => /invitation expired/.test(f.view.container.textContent));
  assert.equal(f.view.container.querySelector('[aria-label="Opened guest workspace"]'), null);
  assert.ok(!f.calls.some(c => c.token === "Bearer old-token"));
  assert.deepEqual(JSON.parse(f.dom.window.sessionStorage.getItem(f.sessionKey)), f.saved);
  assert.equal(f.dom.window.localStorage.getItem(f.ownerKey), "owner-pairing-unchanged");
  assert.deepEqual(f.dom.errors, []);
});

for (const hash of ["", "#i=invalid"]) {
  test(`ordinary guest startup preserves legacy sessions when no valid invitation is present (${JSON.stringify(hash)})`, async t => {
    const saved = old(); delete saved.invitationId;
    const f = await boot(t, { hash, saved });
    await f.dom.waitFor(() => /Previous guest/.test(f.view.container.textContent));
    assert.equal(f.calls.filter(c => c.path === "/api/guest/redeem").length, 0);
    assert.equal(f.dom.window.localStorage.getItem(f.ownerKey), "owner-pairing-unchanged");
    await settle(); assert.deepEqual(f.dom.errors, []);
  });
}

test("reordered copies of the same invitation preserve already delivered peers without claiming extra access", async t => {
  const second = "https://second.tail.ts.net", otherSecret = "c".repeat(43);
  const saved = old();
  saved.invitationId = createHash("sha256").update(JSON.stringify([[origin, oldSecret], [second, otherSecret]])).digest("hex");
  const hash = "#" + new URLSearchParams([
    ["i", `${second}~${otherSecret}`], ["i", `${origin}~${oldSecret}`],
    ["k", "tskey-auth-a-different-enrollment-key"],
  ]);
  const f = await boot(t, { hash, saved });
  await f.dom.waitFor(() => /Previous guest/.test(f.view.container.textContent));
  assert.equal(f.calls.filter(c => c.path === "/api/guest/redeem").length, 0);
  const restored = JSON.parse(f.dom.window.sessionStorage.getItem(f.sessionKey));
  assert.deepEqual(restored.peers, saved.peers, "only previously delivered peer credentials are retained");
  assert.equal(restored.invitationId, saved.invitationId);
  assert.doesNotMatch(JSON.stringify(restored), /tskey-auth|cccccccccc/);
  assert.equal(f.dom.window.location.hash, "");
  assert.deepEqual(f.dom.errors, []);
});


test("same-document valid guest links reload once; invalid or cleared hashes never reload or redeem", async t => {
  const f = await boot(t, { hash: "" });
  await f.dom.waitFor(() => /Previous guest/.test(f.view.container.textContent));
  f.dom.window.location.hash = "i=invalid";
  await settle(30);
  f.dom.window.location.hash = "";
  await settle(30);
  assert.deepEqual(f.reloads, []);
  f.dom.window.location.hash = new URLSearchParams({ i: `${origin}~${newSecret}` }).toString();
  await f.dom.waitFor(() => f.reloads.length === 1);
  f.dom.window.dispatchEvent(new f.dom.window.HashChangeEvent("hashchange"));
  await settle(30);
  assert.equal(f.reloads.length, 1, "multiple notifications cannot restart more than once");
  assert.equal(f.calls.filter(c => c.path === "/api/guest/redeem").length, 0, "the hash listener never redeems a credential itself");
  assert.equal(f.dom.window.localStorage.getItem(f.ownerKey), "owner-pairing-unchanged");
  assert.deepEqual(f.dom.errors, []);
});
