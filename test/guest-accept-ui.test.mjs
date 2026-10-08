import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The guest opens the link: invitations are accepted on each computer with
// no extra tap, taken out of the address, and kept for this tab only.
const A = "https://mac-a.t.ts.net:8443";
const B = "https://mac-b.t.ts.net:8443";
const sa = "a".repeat(43),
  sb = "b".repeat(43);
let dom, React, GuestAccess, savedGuestSession, readPeers, setGuestPeers;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  const hash = new URLSearchParams([
    ["i", `${A}~${sa}`],
    ["i", `${B}~${sb}`],
  ]).toString();
  dom.window.history.replaceState(null, "", `/guest#${hash}`);
  ({ default: GuestAccess } = await dom.load("/src/GuestAccess.tsx"));
  ({ savedGuestSession } = await dom.load("/src/guest-session.tsx"));
  ({ readPeers, setGuestPeers } = await dom.load("/src/api.ts"));
});
after(async () => dom?.close());

function computers(refuse = []) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push([u.origin, u.pathname, JSON.parse(init.body || "null")]);
    const reply = (status, value) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (refuse.includes(u.origin))
      return reply(401, { error: "This guest link expired, was revoked, or has already been used." });
    return reply(200, {
      token: `token-${u.hostname}`,
      clientId: "c",
      expiresAt: u.origin === A ? 2000000000000 : 1900000000000,
      device: { id: `dev-${u.hostname}`, name: u.hostname.split(".")[0], platform: "darwin" },
    });
  };
  return calls;
}

test("accepts on every invited computer at once, even if one refuses", async () => {
  assert.equal(dom.window.location.hash, "", "the invitations left the address bar at once");
  const calls = computers([B]);
  let ready = null;
  const view = await dom.render(React.createElement(GuestAccess, { onReady: (s) => (ready = s) }));
  await dom.waitFor(() => ready);
  assert.deepEqual(calls, [
    [A, "/api/guest/redeem", { invitation: sa }],
    [B, "/api/guest/redeem", { invitation: sb }],
  ]);
  assert.deepEqual(ready, {
    peers: [{ id: "dev-mac-a.t.ts.net", name: "mac-a", platform: "darwin", url: A, token: "token-mac-a.t.ts.net" }],
    expiresAt: 2000000000000,
    invitationId: ready.invitationId,
  });
  assert.match(ready.invitationId, /^[a-f0-9]{64}$/);
  assert.deepEqual(savedGuestSession(), ready, "kept for this tab");
  // In guest mode the app's computers are the guest's, never saved for good.
  setGuestPeers(ready.peers);
  assert.deepEqual(readPeers(), ready.peers);
  assert.equal(dom.window.localStorage.getItem("reach.devices"), null);
  setGuestPeers(undefined);
  await view.unmount();
});

test("when every computer refuses: says why and offers to try again", async () => {
  dom.window.sessionStorage.clear();
  computers([A, B]);
  let ready = null;
  const view = await dom.render(React.createElement(GuestAccess, { onReady: (s) => (ready = s) }));
  await dom.waitFor(() => /already been used/.test(view.container.textContent));
  assert.equal(ready, null);
  assert.ok([...view.container.querySelectorAll("button")].some((b) => b.textContent === "Try again"));
  await view.unmount();
});

test("rendering stayed clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});


test("each delivered person's credential is saved before another computer responds, even after unmount", async () => {
  dom.window.sessionStorage.clear();
  dom.window.sessionStorage.setItem("reach.guest-session", JSON.stringify({
    peers: [{ id: "old", url: "https://old.tail.ts.net", token: "old-unrelated" }], expiresAt: Date.now() + 600000,
  }));
  const replies = new Map();
  globalThis.fetch = dom.window.fetch = async url => new Promise(resolve => replies.set(new URL(url).origin, resolve));
  let ready = 0;
  const view = await dom.render(React.createElement(GuestAccess, { onReady() { ready++; } }));
  await dom.waitFor(() => replies.size === 2);
  const expiresAt = Date.now() + 600000;
  const response = (id, token) => Response.json({ token, clientId: id, expiresAt, device: { id, name: id, platform: "darwin" } });
  replies.get(A)(response("new-a", "new-token-a"));
  await dom.waitFor(() => savedGuestSession()?.peers.some(p => p.token === "new-token-a"));
  assert.equal(ready, 0, "the other computer is still pending");
  await view.unmount();
  replies.get(B)(response("new-b", "new-token-b"));
  await dom.waitFor(() => savedGuestSession()?.peers.length === 2);
  assert.deepEqual(savedGuestSession().peers.map(p => p.token).sort(), ["new-token-a", "new-token-b"]);
  assert.equal(ready, 0);
  assert.deepEqual(dom.errors, []);
});
