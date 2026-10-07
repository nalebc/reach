import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { startDom, settle } from "./dom/harness.mjs";

// A notification takes you there in one tap. Before, a tap on "An invited
// agent wants to connect" opened Home, and its review needed another tap; a
// running Reach only opened the notification list.
let dom, React, useAgentAdmissions, NeedsYouStrip, link;
before(async () => {
  dom = await startDom();
  React = dom.React;
  // jsdom has no modal dialogs; the review opens in one.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ useAgentAdmissions } = await dom.load("/src/agent-admissions.tsx"));
  ({ NeedsYouStrip } = await dom.load("/src/NeedsYou.tsx"));
  link = await dom.load("/src/deep-link.ts");
});
after(() => dom?.close());
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "t", platform: "darwin" };
const admission = {
  requestId: "claim-1",
  clientId: "muse",
  name: "Muse",
  scopes: ["device", "files:read"],
  roots: ["/Users/me/Project"],
  requestedAt: Date.now(),
  expiresAt: Date.now() + 300000,
  accessExpiresAt: Date.now() + 3600000,
  verificationCode: "123456",
};

test("a notification's link names the page and what to open; nothing else is read", () => {
  assert.deepEqual(link.openTarget("/?page=overview&needs=agent-admission:claim-1"), { page: "overview", needs: "agent-admission:claim-1" });
  assert.deepEqual(link.openTarget("/?page=sessions&agent=claude&id=11111111-2222"), { page: "sessions", agent: "claude", id: "11111111-2222" });
  assert.equal(link.openTarget("/?notifications=1"), null);
  assert.equal(link.openTarget("/?page=%3Cscript%3E"), null);
  assert.deepEqual(link.openTarget("/?page=apps&threadId=bad%20id"), { page: "apps" });
  assert.equal(link.withoutTarget("/?page=sessions&agent=claude&id=x&keep=1#top"), "/?keep=1#top");
});

test("a request a notification points at opens for review on its own, once", async () => {
  dom.window.fetch = globalThis.fetch = async () => new Response(JSON.stringify([admission]), { headers: { "Content-Type": "application/json" } });
  function Home() {
    const admissions = useAgentAdmissions(peer, true, "one");
    link.useOpenWantedNeed(admissions.items);
    return React.createElement(React.Fragment, null, React.createElement(NeedsYouStrip, { items: admissions.items }), admissions.review);
  }
  link.wantNeed("agent-admission:claim-1");
  const view = await dom.render(React.createElement(Home));
  await dom.waitFor(() => view.container.querySelector('[aria-label="Connection verification code"]'));
  assert.equal(link.wantedNeed(), null, "done with it");
  await view.unmount();
});

test("a decision is never taken for you: a card with only Allow and Deny just shows", async () => {
  const ran = [];
  function Home() {
    const items = [{ key: "device:7", icon: null, title: "Phone wants access", actions: [{ label: "Deny", run: () => ran.push("deny") }, { label: "Allow", primary: true, run: () => ran.push("allow") }] }];
    link.useOpenWantedNeed(items);
    return React.createElement(NeedsYouStrip, { items });
  }
  link.wantNeed("device:7");
  const view = await dom.render(React.createElement(Home));
  await settle(50);
  assert.deepEqual(ran, []);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("with Reach already open, a tap sends it where the notification points", async () => {
  const listeners = {};
  const messages = [];
  const client = { url: "https://mac.tail1.ts.net:8443/", focus: async () => client, postMessage: (m) => messages.push(m) };
  const self = {
    location: { origin: "https://mac.tail1.ts.net:8443" },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    registration: { showNotification: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => [client], openWindow: async () => {} },
  };
  vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
  const tap = async (url) => {
    const waits = [];
    listeners.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  await tap("/?page=overview&needs=agent-admission:claim-1");
  await tap("/?notifications=1");
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: "reach-open", url: "https://mac.tail1.ts.net:8443/?page=overview&needs=agent-admission:claim-1" },
    { type: "reach-notifications" },
  ]);
});
