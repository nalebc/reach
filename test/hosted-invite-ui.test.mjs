import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A hosted agent (claude.ai, ChatGPT, Muse, Grok) under Connects: the invite
// asks for a hosted public-link invitation and shows the connector address.
let dom, React, BrowserInvite;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const device = { name: "My Mac", roots: [{ id: 0, name: "Project", path: "/Users/me/Project" }] };
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
});
after(async () => dom?.close());
const views = new Set();
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
const click = async (element) => { assert.ok(element, "element exists"); element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await settle(40); };
const rowMenu = (c, label) => [...c.querySelectorAll(".ivt-row")].find((r) => r.querySelector(".ivt-setting-label")?.textContent.trim() === label)?.querySelector(".ivt-menu-button");
const openMenu = async (c, label) => { const menu = rowMenu(c, label); if (menu?.getAttribute("aria-expanded") !== "true") await click(menu); return c.querySelector(".ivt-menu-list"); };
const item = (list, label) => [...list.querySelectorAll(".ivt-item")].find((b) => b.querySelector("strong").textContent === label);
const preset = (c, title) => [...c.querySelectorAll('[aria-label="Access preset"] [role="radio"]')].find((b) => b.getAttribute("aria-label") === title);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("Connects: Hosted makes a hosted public-link invitation and shows the connector address", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/agents/browser-options") return reply({ terminals: [], desktopAvailable: true, presetApps: [], screenAvailable: true, appAccessAvailable: false, apps: [], maxFunnelSeconds: 86400, standingAllowed: true });
    if (route === "/api/agents/browser-invitations") return reply({ clientId: "claude", url: "https://mac.tail.ts.net/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", privateUrl: "https://mac.tail.ts.net:8443/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hosted: true, transport: "funnel", expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000, scopes: [] });
    return reply({ error: "Unexpected request" }, 404);
  };
  let made = null;
  const view = await dom.render(React.createElement(BrowserInvite, { peer, device, keyPeer: null, onSetup: () => {}, onCreated: (...args) => { made = args; } }));
  views.add(view);
  const c = view.container;
  await settle(80);
  const list = await openMenu(c, "Connects");
  assert.match(item(list, "Hosted").textContent, /claude\.ai, ChatGPT, Muse or Grok/);
  await click(item(list, "Hosted"));
  assert.equal(rowMenu(c, "Connects").textContent, "Hosted");
  await click(preset(c, "Full control"));
  await settle(150);
  const post = calls.find(([method, route]) => method === "POST" && route === "/api/agents/browser-invitations");
  assert.ok(post, "the invitation was asked for");
  assert.equal(post[2].hosted, true);
  assert.equal(post[2].transport, "funnel");
  assert.equal(post[2].preset, "full");
  assert.match(c.textContent, /Your invite is ready/);
  assert.equal(c.querySelector(".ag-done-url").textContent, "https://mac.tail.ts.net/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.match(c.textContent, /custom MCP connector/);
  const message = c.querySelector("textarea.browser-invite-message").value;
  assert.match(message, /https:\/\/mac\.tail\.ts\.net\/mcp\/a{43}/);
  assert.match(message, /custom MCP connector/);
  assert.match(message, /You get full control of my Mac/);
  assert.equal(made[1], "https://mac.tail.ts.net/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});
