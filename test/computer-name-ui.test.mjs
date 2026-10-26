import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The computer's name, once a page (Oct 25 review): with one computer it
// showed in the top bar's pill, on Home's card, over Files' title, under
// Agents & people and in Chat's strip. Home's card keeps it; the rest say it
// only when there's another computer to tell it from. The top bar's pill
// (and its "+") shows only when there's a choice: two linked computers, or
// one waiting to be linked. Adding a computer stays in More.
const mac = { id: "mac", name: "Lebdiris-MacBook-Pro", url: "https://mac.tail.ts.net", token: "t", platform: "darwin" };
const pc = { id: "pc", name: "Desk-PC", url: "https://desk-pc.tail.ts.net", token: "t", platform: "win32" };
const waiting = { origin: "https://studio.tail.ts.net", name: "Studio", short: "studio", linked: false };
const connections = { mac: { state: "connected", devices: [] }, pc: { state: "connected", devices: [] } };
const chat = {
  agent: "codex", id: "c1", title: "Tidy the build", cwd: "/work/site", branch: "", origin: "reach", inApp: false,
  updatedAt: Date.now(), createdAt: Date.now() - 1000, status: "idle", preview: "", archived: false,
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let dom, React, ComputerSwitcher, ComputerMenu, Files, ChatList, PeopleHub;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/files": () => ({ items: [{ name: "notes.md", path: "notes.md", type: "file", size: 3, modified: "2026-10-25T00:00:00Z" }] }),
      "/api/files/icons": () => ({ icons: {} }),
      "/api/sessions/logos": () => ({ version: "1", logos: {} }),
      "/api/apps/icons": () => ({ icons: {} }),
      "/api/clients": () => ({ current: "me", clients: [] }),
      "/api/browser/agents": () => ({ agents: [], at: Date.now() }),
      "/api/agents/shortcuts": () => ({ shortcuts: [], running: null }),
      "/api/agents/services": () => ({ access: [] }),
      "/api/agents/tool-setup": () => ({ needed: [] }),
      "/api/agents/browser-requests": () => json([]),
      "/api/agents/browser-terminal-history": () => json([]),
      "/api/agents/admissions": () => json([]),
      "/api/agents/actions": () => ({ actions: [] }),
      "/api/guests/keys": () => ({ configured: false }),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.open = false; };
  ({ ComputerSwitcher } = await dom.load("/src/FleetMesh.tsx"));
  ({ default: ComputerMenu } = await dom.load("/src/ComputerMenu.tsx"));
  ({ default: Files } = await dom.load("/src/Files.tsx"));
  ({ default: ChatList } = await dom.load("/src/ChatList.tsx"));
  ({ default: PeopleHub } = await dom.load("/src/PeopleHub.tsx"));
});
after(async () => dom?.close());
const views = new Set();
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
const render = async (component, props, ms = 40) => {
  const view = await dom.render(React.createElement(component, props));
  views.add(view);
  await settle(ms);
  return view.container;
};
const device = (peer) => ({
  id: peer.id, name: peer.name, platform: peer.platform,
  roots: [{ id: 0, name: "Documents", path: "/Users/me/Documents" }],
  capabilities: { files: true, terminal: true, apps: true, screen: true, screenSupported: true },
  network: { connected: true, peers: [] },
});
const switcher = (peers, more = {}) =>
  render(ComputerSwitcher, { peers, active: peers[0].id, connections, choose() {}, pair() {}, waiting: [], ...more });

for (const host of [mac, pc]) {
  test(`one ${host.platform === "darwin" ? "Mac" : "Windows PC"}: no computer pill and no "+" in the top bar`, async () => {
    const c = await switcher([host]);
    assert.equal(c.querySelector(".fleet-switcher"), null);
    assert.equal(c.querySelector(".fleet-add"), null);
    assert.doesNotMatch(c.textContent, new RegExp(host.name));
  });
}

test("two computers: both in the top bar, with Add", async () => {
  const c = await switcher([mac, pc]);
  const names = [...c.querySelectorAll(".fleet-switcher button[title]:not(.fleet-add)")].map((b) => b.title);
  assert.deepEqual(names, [mac.name, pc.name]);
  assert.ok(c.querySelector(".fleet-add[aria-label='Add a computer']"));
});

test("one computer and another waiting to be linked: the pill shows, the waiting one in it", async () => {
  const c = await switcher([mac], { waiting: [waiting] });
  assert.ok(c.querySelector(".fleet-switcher"));
  assert.match(c.querySelector(".fleet-waiting")?.textContent || "", /Studio/);
  assert.ok(c.querySelector(".fleet-add"));
});

test("one computer: the top bar's computer menu still offers Add a computer", async () => {
  const added = [];
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  const c = await render(ComputerMenu, {
    peers: [mac], active: "mac", connections, waiting: [],
    onWaiting() {}, onChoose() {}, onAdd: () => added.push(1), onClose() {},
  });
  const add = [...(c.ownerDocument || c).querySelectorAll("button")].find((b) => b.textContent.includes("Add a computer"));
  assert.ok(add, "Add a computer in the computer menu");
  add.click();
  assert.deepEqual(added, [1]);
});

for (const host of [mac, pc]) {
  const word = host.platform === "darwin" ? "Mac" : "Windows PC";
  test(`Files on one ${word}: no name caption over the title; two computers: the name says which`, async () => {
    const one = await render(Files, { peer: host, peers: [host], device: device(host), onSession() {}, toast() {} }, 120);
    assert.ok(one.querySelector(".files-titlebar"), "Files rendered");
    assert.equal(one.querySelector(".files-crumbs"), null, "no empty crumb row at the top folder either");
    assert.doesNotMatch(one.querySelector(".files-header").textContent, new RegExp(host.name));
    for (const view of views) await view.unmount();
    views.clear();
    const two = await render(Files, { peer: host, peers: [mac, pc], device: device(host), onSession() {}, toast() {} }, 120);
    assert.equal(two.querySelector(".files-crumbs > span")?.textContent, host.name);
  });
}

test("Files for a guest still says whose files they are", async () => {
  const c = await render(Files, {
    peer: mac, peers: [mac], onSession() {}, toast() {},
    device: { ...device(mac), access: { kind: "guest", scopes: ["files:read"] } },
  }, 120);
  assert.equal(c.querySelector(".files-crumbs > span")?.textContent, `Shared by ${mac.name}`);
});

const chats = (computers) =>
  render(ChatList, {
    peer: mac, sessions: [chat], logos: {}, agent: "codex", apps: [], appPending: {}, pending: 0,
    onOpen() {}, onNew() {}, onAgentChange() {}, ...(computers ? { computers } : {}),
  });

test("Chat with one computer: no strip naming it", async () => {
  for (const computers of [undefined, 1]) {
    const c = await chats(computers);
    assert.ok(c.querySelector(".chat-card"), "the chat list rendered");
    assert.equal(c.querySelector(".chat-source-strip"), null);
    for (const view of views) await view.unmount();
    views.clear();
  }
});

test("Chat with two computers: the strip names the one these chats are on", async () => {
  const c = await chats(2);
  assert.match(c.querySelector(".chat-source-strip")?.textContent || "", new RegExp(mac.name));
});

test("Agents & people with one computer doesn't name it; with two it says which", async () => {
  const one = await render(PeopleHub, { peer: mac, device: device(mac), peers: [mac], toast() {} }, 80);
  assert.equal(one.querySelector(".ppl-head h1")?.textContent, "Agents & people");
  assert.equal(one.querySelector(".ppl-head p"), null);
  assert.doesNotMatch(one.querySelector(".ppl-head").textContent, new RegExp(mac.name));
  for (const view of views) await view.unmount();
  views.clear();
  const two = await render(PeopleHub, { peer: mac, device: device(mac), peers: [mac, pc], toast() {} }, 80);
  assert.equal(two.querySelector(".ppl-head p")?.textContent, `Who can use ${mac.name}`);
});
