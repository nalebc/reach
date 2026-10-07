import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Changing someone's access from their row in "People with access", like the
// role menus in Claude's and ChatGPT's share dialogs: no new link. Their
// folders are kept, or chosen first where they have none; an invitation over
// several computers changes on each.
let dom, React, InviteSheet, levelOf;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ InviteSheet, levelOf } = await dom.load("/src/InviteSheet.tsx"));
});
after(async () => dom?.close());

const macA = { id: "a", name: "Mac A", url: "https://mac-a.t.ts.net:8443", token: "ta", platform: "darwin" };
const macB = { id: "b", name: "Mac B", url: "https://mac-b.t.ts.net:8443", token: "tb", platform: "darwin" };
const device = (name, host) => ({
  id: name,
  name,
  platform: "darwin",
  arch: "arm64",
  release: "25",
  roots: [{ id: 0, name: "Projects", path: `/Users/me/${host}/Projects` }],
  memory: { total: 1, free: 1 },
  uptime: 1,
  network: { connected: true, ips: ["100.64.0.1"], peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, screenSupported: true, codex: true },
});
const later = () => Date.now() + 3600000;
// `clients`: each computer's people; `refuse`: a computer that says no.
function computers({ clients = {}, refuse = "" } = {}) {
  const log = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const host = u.hostname.split(".")[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push([init.method || "GET", host, u.pathname, body]);
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/api/guests/keys") return reply(200, { configured: true, policy: null });
    if (u.pathname === "/api/clients") return reply(200, { current: "me", clients: clients[host] || [] });
    if (u.pathname === "/api/device") return reply(200, device(host === "mac-a" ? "Mac A" : "Mac B", host));
    if (u.pathname === "/api/files") return reply(200, { items: [{ name: "notes", type: "directory", path: "notes" }], path: u.searchParams.get("path") || "" });
    const access = /^\/api\/guests\/([^/]+)\/access$/.exec(u.pathname);
    if (access && init.method === "POST") {
      if (host === refuse) return reply(404, { error: "That invitation has ended." });
      return reply(200, { id: access[1], scopes: ["device"] });
    }
    return reply(404, { error: "This action does not exist." });
  };
  return log;
}
const click = async (el) => {
  assert.ok(el, "element exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(60);
};
const row = (c, name) => [...c.querySelectorAll(".ivt-person")].find((r) => r.querySelector("strong")?.textContent === name);
const accessMenu = (c, name) => row(c, name).querySelector(".ivt-access .ivt-menu-button");
const items = (c) => [...c.querySelectorAll(".ivt-access .ivt-item")];
const item = (c, label) => items(c).find((b) => b.querySelector("strong").textContent === label);
const changes = (log) => log.filter(([m, , p]) => m === "POST" && /\/access$/.test(p)).map(([, h, p, b]) => [h, p, b]);
const render = (props) => dom.render(React.createElement(InviteSheet, { peer: macA, device: device("Mac A", "mac-a"), peers: [macA], ...props }));

test("view only → edit files, from their row: one tap, their folders kept, no new link", async () => {
  const log = computers({
    clients: { "mac-a": [{ id: "g2", kind: "guest", name: "Kim", status: "accepted", expiresAt: later(), scopes: ["device", "files:read"], guestRoots: ["/Users/me/mac-a/Projects/notes"] }] },
  });
  const view = await render();
  const c = view.container;
  await settle(60);
  assert.equal(accessMenu(c, "Kim").textContent, "Can open files");
  await click(accessMenu(c, "Kim"));
  assert.deepEqual(items(c).map((b) => b.querySelector("strong").textContent), ["Can watch", "Can control", "Can open files", "Can edit files", "Can work", "Full access"]);
  assert.equal(item(c, "Can open files").getAttribute("aria-checked"), "true");
  await click(item(c, "Can edit files"));
  assert.deepEqual(changes(log), [["mac-a", "/api/guests/g2/access", { folders: "keep", write: true }]]);
  assert.match(c.querySelector(".ivt-people [role=status]").textContent, /Kim: can edit files now\. No new link needed\./);
  assert.ok(!log.some(([m, , p]) => m === "POST" && (p === "/api/guests" || p === "/api/guests/key")), "no new invitation or key");
  await view.unmount();
});

test("from watching to files: their folders are chosen first (or not at all)", async () => {
  const log = computers({
    clients: { "mac-a": [{ id: "g1", kind: "guest", name: "Sam", status: "accepted", expiresAt: later(), scopes: ["device", "screen", "apps:open"], guestRoots: [] }] },
  });
  const view = await render();
  const c = view.container;
  await settle(60);
  await click(accessMenu(c, "Sam"));
  await click(item(c, "Can edit files"));
  assert.deepEqual(changes(log), [], "nothing changes before the folders are chosen");
  const panel = c.querySelector('[aria-label="Folders for Sam"]');
  assert.match(panel.textContent, /Choose the folders Sam may use\./);
  const save = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Save");
  assert.equal(save.disabled, true);
  await click(panel.querySelector('[aria-label="Share Projects"]'));
  assert.equal(save.disabled, false);
  await click(save);
  assert.deepEqual(changes(log), [["mac-a", "/api/guests/g1/access", { folders: [{ root: 0, path: "" }], write: true }]]);
  assert.equal(c.querySelector('[aria-label="Folders for Sam"]'), null);
  // Cancel leaves everything as it was.
  await click(accessMenu(c, "Sam"));
  await click(item(c, "Can work"));
  await click([...c.querySelectorAll('[aria-label="Folders for Sam"] button')].find((b) => b.textContent === "Cancel"));
  assert.equal(changes(log).length, 1);
  await view.unmount();
});

test("one invitation over two computers changes on both; one that says no is named", async () => {
  const notes = (host) => [`/Users/me/${host}/Projects/notes`];
  const clients = {
    "mac-a": [{ id: "g1", kind: "guest", name: "Ali", group: "grp-0123456789", status: "accepted", expiresAt: later(), scopes: ["device", "files:read"], guestRoots: notes("mac-a") }],
    "mac-b": [
      { id: "g9", kind: "guest", name: "Ali", group: "grp-0123456789", status: "accepted", expiresAt: later(), scopes: ["device", "files:read"], guestRoots: notes("mac-b") },
      { id: "x", kind: "guest", name: "Other", group: "grp-other00000", status: "accepted", expiresAt: later(), scopes: ["device", "files:read"], guestRoots: notes("mac-b") },
    ],
  };
  let log = computers({ clients });
  let view = await render({ peers: [macA, macB] });
  let c = view.container;
  await settle(60);
  await click(accessMenu(c, "Ali"));
  await click(item(c, "Can edit files"));
  assert.deepEqual(changes(log), [
    ["mac-a", "/api/guests/g1/access", { folders: "keep", write: true }],
    ["mac-b", "/api/guests/g9/access", { folders: "keep", write: true }],
  ]);
  await view.unmount();
  // Where one computer has no folders to keep, only that one is chosen.
  clients["mac-b"][0] = { ...clients["mac-b"][0], scopes: ["device", "screen"], guestRoots: [] };
  log = computers({ clients });
  view = await render({ peers: [macA, macB] });
  c = view.container;
  await settle(60);
  await click(accessMenu(c, "Ali"));
  await click(item(c, "Can edit files"));
  const panel = c.querySelector('[aria-label="Folders for Ali"]');
  assert.match(panel.textContent, /Choose the folders Ali may use\./);
  assert.equal(panel.querySelectorAll(".fb-crumbs").length, 1, "Mac B's folders only");
  await settle(60);
  await click(panel.querySelector('[aria-label="Share Projects"]'));
  await click([...panel.querySelectorAll("button")].find((b) => b.textContent === "Save"));
  assert.deepEqual(changes(log), [
    ["mac-a", "/api/guests/g1/access", { folders: "keep", write: true }],
    ["mac-b", "/api/guests/g9/access", { folders: [{ root: 0, path: "" }], write: true }],
  ]);
  await view.unmount();
  // A computer that says no is named.
  clients["mac-b"][0] = { ...clients["mac-b"][0], scopes: ["device", "files:read"], guestRoots: notes("mac-b") };
  log = computers({ clients, refuse: "mac-b" });
  view = await render({ peers: [macA, macB] });
  c = view.container;
  await settle(60);
  await click(accessMenu(c, "Ali"));
  await click(item(c, "Can edit files"));
  assert.match(c.querySelector(".ivt-error").textContent, /^Mac B: That invitation has ended\./);
  await view.unmount();
});

test("an agent: only what agents may do", async () => {
  const log = computers({
    clients: { "mac-a": [{ id: "a1", kind: "agent", name: "Builder", policy: { invite: true, roots: ["/Users/me/mac-a/Projects"] }, status: "accepted", expiresAt: later(), scopes: ["device", "files:read"] }] },
  });
  const view = await render();
  const c = view.container;
  await settle(60);
  assert.equal(accessMenu(c, "Builder").textContent, "Can read");
  await click(accessMenu(c, "Builder"));
  assert.deepEqual(items(c).map((b) => b.querySelector("strong").textContent), ["Can read", "Can edit", "Can run commands"]);
  await click(item(c, "Can run commands"));
  assert.deepEqual(changes(log), [["mac-a", "/api/guests/a1/access", { folders: "keep", write: true, exec: true }]]);
  await view.unmount();
});

test("what their access is called, from what the computer granted", () => {
  const level = (scopes, kind = "guest") => levelOf({ kind, scopes });
  assert.equal(level(["device", "screen", "apps:open"]), "watch");
  assert.equal(level(["device", "screen", "screen:control", "apps:open"]), "control");
  assert.equal(level(["device", "files:read"]), "open");
  assert.equal(level(["device", "files:read", "files:write"]), "edit");
  assert.equal(level(["device", "files:read", "files:write", "terminal", "codex"]), "work");
  assert.equal(level(["admin", "device"]), "full");
  assert.equal(level(["device", "screen", "files:read"]), "", "chosen piece by piece");
  assert.equal(level(["device", "terminal"]), "");
  assert.equal(level(["device", "files:read", "files:write", "exec"], "agent"), "run");
  assert.equal(level(["device", "files:read"], "agent"), "read");
});

test("their phone reloads its access when the computer says it changed, and only then", async () => {
  const { accessChanged } = await dom.load("/src/live-access.ts");
  const live = (changes) => JSON.stringify(changes);
  assert.equal(accessChanged(undefined, live({ access: "a" })), false, "the first look");
  assert.equal(accessChanged(live({ access: "a", chats: "1" }), live({ access: "a", chats: "2" })), false, "other lists changed");
  assert.equal(accessChanged(live({ access: "a" }), live({ access: "b" })), true);
  assert.equal(accessChanged(live({}), live({})), false, "your own devices: no access part");
  assert.equal(accessChanged("not json", live({ access: "a" })), true);
});

test("clean (no React warnings)", () => assert.deepEqual(dom.errors, []));
