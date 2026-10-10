import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Settings → Face ID (for new browsers): what's set up, add this
// phone's, remove one (a lost phone). Only your own approved devices see it.
let dom, React, FaceIdSettings;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ FaceIdSettings } = await dom.load("/src/FaceIdSettings.tsx"));
});
after(async () => dom?.close());

const peer = { id: "a", name: "Mac A", url: "https://reach.test:8443", token: "T", platform: "darwin" };
function computer({ status = 200, keys = [] } = {}) {
  const log = [];
  let list = [...keys];
  const reply = (s, v) => new Response(JSON.stringify(v), { status: s, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    log.push([method, u.pathname]);
    if (status !== 200) return reply(status, { error: "Only your own approved devices can manage Face ID." });
    if (u.pathname === "/api/auth/passkeys" && method === "GET") return reply(200, { passkeys: list });
    if (u.pathname === "/api/auth/passkeys/options")
      return reply(200, { challenge: "Yw", rp: { id: "reach.test", name: "Reach" }, user: { id: "dQ", name: "me", displayName: "me" }, pubKeyCredParams: [], excludeCredentials: list.map((k) => ({ type: "public-key", id: k.id })) });
    if (u.pathname === "/api/auth/passkeys" && method === "POST") {
      list.push({ id: "bmV3", label: "iPhone", createdAt: "2026-10-05T10:00:00Z" });
      return reply(201, list.at(-1));
    }
    if (u.pathname.startsWith("/api/auth/passkeys/") && method === "DELETE") {
      list = list.filter((k) => `/api/auth/passkeys/${k.id}` !== u.pathname);
      return reply(200, { ok: true });
    }
    return reply(404, {});
  };
  const PKC = function () {};
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = PKC;
  const created = [];
  Object.defineProperty(dom.window.navigator, "credentials", {
    configurable: true,
    value: {
      create: (o) => (created.push(o), Promise.resolve({ id: "bmV3", rawId: Uint8Array.of(1).buffer, type: "public-key", response: { clientDataJSON: Uint8Array.of(1).buffer, attestationObject: Uint8Array.of(2).buffer } })),
    },
  });
  return { log, created };
}
const button = (c, text) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

test("lists Face ID set up here; removes one after you confirm", async () => {
  const { log } = computer({ keys: [{ id: "a2V5", label: "iPhone", createdAt: "2026-10-05T10:00:00Z", usedAt: "2026-10-05T11:00:00Z" }] });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await settle(80);
  const c = view.container;
  assert.match(c.textContent, /Approve a new browser of yours with Face ID/);
  assert.match(c.textContent, /iPhone\s*Last used Oct 5/);
  dom.window.confirm = globalThis.confirm = () => false;
  c.querySelector('[aria-label="Remove iPhone"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(60);
  assert.ok(!log.some(([m]) => m === "DELETE"), "not without confirming");
  dom.window.confirm = globalThis.confirm = () => true;
  c.querySelector('[aria-label="Remove iPhone"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(80);
  assert.ok(log.some(([m, p]) => m === "DELETE" && p === "/api/auth/passkeys/a2V5"));
  assert.equal(c.querySelector('[aria-label="Remove iPhone"]'), null);
  await view.unmount();
});

test("add this phone's Face ID, straight from the tap", async () => {
  const { log, created } = computer();
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await settle(120);
  const c = view.container;
  const add = button(c, "Use Face ID");
  assert.equal(add.disabled, false, "options ready before the tap");
  add.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(created.length, 1, "called in the tap itself");
  await settle(120);
  assert.ok(log.some(([m, p]) => m === "POST" && p === "/api/auth/passkeys"));
  assert.match(c.textContent, /iPhone\s*Added Oct 5/);
  await view.unmount();
});

test("not your own approved device (a guest, another computer): nothing shown", async () => {
  computer({ status: 403 });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await settle(80);
  assert.equal(view.container.textContent, "");
  await view.unmount();
});

test("clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
