import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { startDom, settle } from "./dom/harness.mjs";

const ORIGIN = "https://person-fixture.tail.ts.net";
const gate = () => {
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
};

// The browser components use their real API contracts, translated only from
// the synthetic HTTPS origin to this temporary loopback server. Tailscale
// enrollment is deliberately absent: this fixture represents an already
// connected guest and never mints a real network key or controls the desktop.
async function fixture(t, { redeemPause } = {}) {
  const nativeFetch = globalThis.fetch;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-person-ui-"));
  const shared = path.join(root, "shared");
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, "sample.txt"), "PERSON-FIXTURE-73");
  const reach = await createReach({
    roots: [shared], dataDir: path.join(root, "private"), publicOrigin: ORIGIN,
    screen: false, agentDesktop: null,
    tailscaleStatus: async () => ({ Self: { TailscaleIPs: ["100.64.0.5"] }, Peer: {} }),
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Fixture owner", ALL_SCOPES, "device");
  const call = (route, { token = owner.token, method = "GET", body } = {}) => nativeFetch(url + route, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const device = await (await call("/api/device")).json();
  const dom = await startDom(), views = [], requests = [];
  t.after(async () => {
    redeemPause?.release();
    for (const view of views.splice(0)) await view.unmount();
    await dom.close();
    reach.server.closeAllConnections?.(); await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.fetch = dom.window.fetch = async (input, init = {}) => {
    const target = new URL(typeof input === "string" ? input : input.url);
    assert.equal(target.origin, ORIGIN, "fixture refuses nonfixture network calls");
    requests.push({ path: target.pathname, method: init.method || "GET" });
    const response = await nativeFetch(url + target.pathname + target.search, init);
    if (target.pathname === "/api/guest/redeem") await redeemPause?.wait();
    return response;
  };
  const peer = { id: device.id, name: "Fixture computer", url: ORIGIN, token: owner.token, platform: device.platform };
  const { InviteSheet } = await dom.load("/src/InviteSheet.tsx");
  const view = await dom.render(dom.React.createElement(InviteSheet, { peer, device, peers: [peer] }));
  views.push(view);
  const click = async element => {
    assert.ok(element, "fixture control exists");
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
  };
  await dom.waitFor(() => view.container.querySelector(".ivt-setup-line"));
  const input = view.container.querySelector(".ivt-name");
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "Synthetic visitor");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  await click(view.container.querySelector(".ivt-menu-button"));
  await click([...view.container.querySelectorAll(".ivt-item")].find(item => item.textContent.startsWith("Full access")));
  await click(view.container.querySelector(".ivt-submit"));
  await dom.waitFor(() => view.container.querySelector(".ivt-tailscale"));
  await click(view.container.querySelector(".ivt-tailscale input[type=checkbox]"));
  const link = (await dom.waitFor(() => view.container.querySelector(".ivt-link-field"))).value;
  await view.unmount(); views.splice(views.indexOf(view), 1);
  dom.window.history.replaceState(null, "", "/guest" + new URL(link).hash);
  const { default: GuestAccess } = await dom.load("/src/GuestAccess.tsx");
  const guestSession = await dom.load("/src/guest-session.tsx");
  return { dom, views, reach, call, GuestAccess, guestSession, requests, link };
}

test("person share UI creates a real invitation; redemption, scope changes and expiry use the same server grant", async t => {
  const f = await fixture(t);
  let ready;
  const view = await f.dom.render(f.dom.React.createElement(f.GuestAccess, { onReady(value) { ready = value; } }));
  f.views.push(view);
  await f.dom.waitFor(() => ready);
  assert.equal(f.dom.window.location.hash, "");
  assert.equal(f.requests.filter(r => r.path === "/api/guest/redeem").length, 1);
  assert.equal(f.requests.some(r => r.path === "/api/guests/key"), false, "no network key is minted");
  assert.deepEqual(f.guestSession.savedGuestSession(), ready);
  const token = ready.peers[0].token;
  assert.equal((await f.call("/api/files?root=0&path=", { token })).status, 200);
  assert.equal((await f.call("/api/clients", { token })).status, 403, "full guests cannot manage access");
  const guest = f.reach.auth.list().find(c => c.kind === "guest");
  assert.ok(guest.redeemedAt);
  const change = await f.call(`/api/guests/${guest.id}/access`, {
    method: "POST", body: { roots: [0], write: false },
  });
  assert.equal(change.status, 200);
  assert.equal((await f.call("/api/files?root=0&path=", { token })).status, 200);
  assert.equal((await f.call("/api/files/folder", { token, method: "POST", body: { root: 0, path: "", name: "blocked" } })).status, 403);
  const end = await f.call(`/api/guests/${guest.id}/access`, {
    method: "POST", body: { roots: [0], write: false, expiresAt: Date.now() + 200 },
  });
  assert.equal(end.status, 200);
  await settle(250);
  assert.equal((await f.call("/api/device", { token })).status, 401);
  assert.deepEqual(f.dom.errors, []);
});

test("a person redemption completing after unmount keeps its one-time credential for this tab", async t => {
  const pause = gate(), f = await fixture(t, { redeemPause: pause });
  let ready = 0;
  const view = await f.dom.render(f.dom.React.createElement(f.GuestAccess, { onReady() { ready++; } }));
  f.views.push(view);
  await pause.entered;
  await view.unmount(); f.views.splice(f.views.indexOf(view), 1);
  pause.release();
  await settle(100);
  assert.equal(ready, 0, "unmounted UI is not called");
  const saved = f.guestSession.savedGuestSession();
  assert.ok(saved?.peers[0]?.token, "delivered one-use credential survives component teardown");
  assert.equal((await f.call("/api/device", { token: saved.peers[0].token })).status, 200);
  assert.equal(f.requests.filter(r => r.path === "/api/guest/redeem").length, 1);
  assert.equal(f.dom.window.localStorage.getItem("reach.devices"), null, "owner pairings remain separate");
  assert.deepEqual(f.dom.errors, []);
});
