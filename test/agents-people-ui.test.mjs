import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Agents & people is the one place for agents: every live agent is a row,
// a browser agent's sheet holds its live panel (requests, Pause, activity),
// and ended agents, saved shortcuts and shared services are a row each only
// when there are any. No second Agents page, no second Invite button.
let dom, React, PeopleHub;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ({ default: PeopleHub } = await dom.load("/src/PeopleHub.tsx"));
});
after(async () => dom?.close());
const views = new Set();
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });

const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const device = {
  name: "My Mac", platform: "darwin", roots: [{ id: 0, path: "/Users/me", name: "Home" }],
  capabilities: { files: true, terminal: true, apps: true, screen: true, screenSupported: true },
  network: { connected: true, peers: [] },
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const later = () => Date.now() + 3600000;
const browserAgent = (id, overrides = {}) => ({
  id, name: "Muse", kind: "agent", status: "accepted", createdAt: Date.now() - 60000, expiresAt: later(),
  scopes: ["device", "browser:read"], policy: { invite: true, browser: true, preset: "full", roots: ["/Users/me"] },
  ...overrides,
});
const listed = (client, overrides = {}) => ({
  ...client, folders: client.policy?.roots || [], pendingApprovals: 0, activity: { state: "idle" },
  ...(client.policy?.preset ? { preset: client.policy.preset } : {}), ...overrides,
});
function mac({ clients = [], sessions = clients.filter((c) => c.policy?.browser).map((c) => listed(c)), shortcuts = [], services = [] } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([init.method || "GET", route]);
    if (route === "/api/clients") return reply({ current: "me", clients });
    if (route === "/api/browser/agents") return reply({ agents: typeof sessions === "function" ? sessions() : sessions, at: Date.now() });
    if (route === "/api/agents/shortcuts") return reply({ shortcuts, running: null });
    if (route === "/api/agents/services") return reply({ access: services });
    if (route === "/api/agents/tool-setup") return reply({ needed: [] });
    if (["/api/agents/browser-requests", "/api/agents/browser-terminal-history", "/api/agents/admissions"].includes(route)) return reply([]);
    if (route === "/api/guests/keys") return reply({ configured: false });
    return reply({});
  };
  return calls;
}
const render = async () => {
  const view = await dom.render(React.createElement(PeopleHub, { peer, device }));
  views.add(view);
  await settle(60);
  return view;
};
const rows = (c) => [...c.querySelectorAll(".gs-row")];
const rowNamed = (c, name) => rows(c).find((r) => r.querySelector("strong, .gs-label")?.textContent.startsWith(name));
const click = async (element) => { assert.ok(element); element.click(); await settle(40); };

test("one Agents list: no Agent sessions row, no second Invite button, empty extras hidden", async () => {
  mac({ clients: [browserAgent("muse-1")] });
  const { container: c } = await render();
  await dom.waitFor(() => c.querySelector(".ppl-row"));
  assert.doesNotMatch(c.textContent, /Agent sessions|Invite agent|Agent shortcuts|Service access|Search agents/);
  assert.equal(c.querySelectorAll('[aria-label="Invite"]').length, 1, "the + is the one way to invite");
  for (const label of ["Shortcuts", "Services", "Ended"]) assert.equal(rowNamed(c, label), undefined, label);
});

test("an agent waiting on you is first and amber; a working one says what it's using", async () => {
  const calm = browserAgent("calm-1", { name: "Calm" });
  const asking = browserAgent("ask-2", { name: "Asking" });
  mac({
    clients: [calm, asking],
    sessions: [listed(calm, { holdsMac: true, using: { app: "Safari" } }), listed(asking, { pendingApprovals: 2 })],
  });
  const { container: c } = await render();
  await dom.waitFor(() => c.querySelectorAll(".ppl-row").length === 2);
  const [first, second] = c.querySelectorAll(".ppl-row");
  assert.match(first.textContent, /Asking.*2 requests waiting/);
  assert.ok(first.querySelector(".ppl-attention"));
  assert.match(second.textContent, /Calm.*Using Safari/);
});

test("a browser agent's sheet holds its live panel; stopped agents leave the list for Ended", async () => {
  const muse = browserAgent("muse-1");
  const stopped = browserAgent("old-2", { name: "Old helper", status: "revoked" });
  mac({ clients: [muse, stopped], sessions: [listed(muse), listed(stopped, { status: "revoked" })] });
  const { container: c } = await render();
  await dom.waitFor(() => c.querySelector(".ppl-row"));
  assert.deepEqual([...c.querySelectorAll(".ppl-row strong")].map((e) => e.textContent), ["Muse"]);
  await click(c.querySelector(".ppl-row"));
  const sheet = c.querySelector(".ppl-sheet");
  await dom.waitFor(() => sheet.querySelector(".ag-embedded .ag-facts"));
  assert.ok([...sheet.querySelectorAll("button")].some((b) => b.textContent.trim() === "Pause"));
  assert.ok([...sheet.querySelectorAll("button")].some((b) => /Remove access/.test(b.textContent)));
  assert.doesNotMatch(sheet.textContent, /Sessions & activity/);
  await click(sheet.querySelector('[aria-label="Close panel"]'));
  const ended = rowNamed(c, "Ended");
  assert.equal(ended.querySelector(".gs-value").textContent, "1");
  await click(ended);
  await dom.waitFor(() => c.querySelector('.ppl-sheet [data-agent-id="old-2"]'));
  assert.match(c.querySelector('.ppl-sheet [data-agent-id="old-2"]').textContent, /Old helper.*Stopped/);
});

test("Shortcuts and Services are rows only when an agent saved or was given one", async () => {
  mac({
    shortcuts: [{ id: "s1", name: "Morning mail", enabled: true, steps: [{ type: "open", app: "/Applications/Mail.app" }] }],
    services: [{ id: "x", status: "approved", expiresAt: later(), accessExpiresAt: later(), agentName: "Muse", serviceName: "Gmail", permissions: ["read"], account: "me", reason: "" }],
  });
  const { container: c } = await render();
  await dom.waitFor(() => rowNamed(c, "Shortcuts"));
  assert.equal(rowNamed(c, "Shortcuts").querySelector(".gs-value").textContent, "1");
  assert.equal(rowNamed(c, "Services").querySelector(".gs-value").textContent, "1");
  await click(rowNamed(c, "Shortcuts"));
  await dom.waitFor(() => /Morning mail/.test(c.querySelector(".ppl-sheet")?.textContent || ""));
  assert.equal(c.querySelector(".ppl-sheet .as-shortcuts"), null, "no fold inside its own sheet");
});

test("Agents & people renders without React warnings", () => assert.deepEqual(dom.errors, []));

test("devices with the same name say when each was paired, with the time on a shared day", async () => {
  const at = (iso) => new Date(iso).toISOString();
  mac({
    clients: [
      { id: "me", kind: "device", name: "My iPhone", createdAt: at("2026-10-09T16:31:00"), expiresAt: later() },
      { id: "a", kind: "device", name: "My iPhone", createdAt: at("2026-10-03T16:50:00"), expiresAt: later() },
      { id: "b", kind: "device", name: "My iPhone", createdAt: at("2026-10-03T18:56:00"), expiresAt: later() },
      { id: "c", kind: "device", name: "My iPhone", createdAt: at("2026-10-05T18:34:00"), expiresAt: later() },
    ],
  });
  const { container: c } = await render();
  await dom.waitFor(() => c.querySelectorAll(".ppl-row").length === 4);
  const lines = [...c.querySelectorAll(".ppl-row small")].map((e) => e.textContent);
  assert.equal(lines[0], "This device");
  assert.match(lines[1], /^Paired Oct 3.*4:50/);
  assert.match(lines[2], /^Paired Oct 3.*6:56/);
  assert.equal(lines[3], "Paired Oct 5");
});
