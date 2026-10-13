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
function mac({ clients = [], sessions = (typeof clients === "function" ? clients() : clients).filter((c) => c.policy?.browser).map((c) => listed(c)), shortcuts = [], services = [], responses = {} } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([init.method || "GET", route]);
    if (responses[route]) return responses[route](new URL(url), init);
    if (route === "/api/clients") return reply({ current: "me", clients: typeof clients === "function" ? clients() : clients });
    if (route === "/api/browser/agents") return reply({ agents: typeof sessions === "function" ? sessions() : sessions, at: Date.now() });
    if (route === "/api/agents/shortcuts") return reply({ shortcuts, running: null });
    if (route === "/api/agents/services") return reply({ access: services });
    if (route === "/api/agents/tool-setup") return reply({ needed: [] });
    if (["/api/agents/browser-requests", "/api/agents/browser-terminal-history", "/api/agents/admissions"].includes(route)) return reply([]);
    if (route === "/api/agents/actions") return reply({ actions: [] });
    if (route === "/api/guests/keys") return reply({ configured: false });
    return reply({});
  };
  return calls;
}
const render = async (props = {}) => {
  const view = await dom.render(React.createElement(PeopleHub, { peer, device, ...props }));
  views.add(view);
  await settle(60);
  return view;
};
const rows = (c) => [...c.querySelectorAll(".gs-row")];
// The owner's own devices, as /api/clients lists them.
const macWith = (clients) => mac({ clients });
const rowNamed = (c, name) => rows(c).find((r) => r.querySelector("strong, .gs-label")?.textContent.startsWith(name));
const click = async (element) => { assert.ok(element); element.click(); await settle(40); };

test("an unavailable access list reports the failure instead of claiming no agents exist", async () => {
  mac({ responses: { "/api/clients": () => reply({ error: "Access list unavailable" }, 503) } });
  const { container: c } = await render();
  assert.match(c.textContent, /Access list unavailable/);
  assert.doesNotMatch(c.textContent, /No agents yet/);
});

test("malformed access lists report an error instead of becoming an empty list", async () => {
  mac({ responses: { "/api/clients": () => reply(null) } });
  const { container: c } = await render();
  assert.match(c.textContent, /could not be loaded/);
  assert.doesNotMatch(c.textContent, /No agents yet/);
});

test("Remove access keeps the sheet open and reports a refused deletion", async () => {
  const muse = browserAgent("muse-1");
  mac({ clients: [muse], sessions: [listed(muse)], responses: {
    "/api/clients/muse-1": () => reply({ error: "Could not remove this access" }, 503),
  } });
  const { container: c } = await render();
  await click(c.querySelector(".ppl-row"));
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Muse’s access"]'));
  assert.equal(!!c.querySelector(".ppl-sheet"), true);
  assert.match(c.textContent, /Could not remove this access/);
});

test("Remove access reports the computer that failed even after local removal succeeds", async () => {
  const muse = browserAgent("muse-1", { group: "shared" });
  const other = { ...peer, id: "other", name: "Other Mac", url: "https://other.tail.ts.net" };
  let removed = false;
  const calls = mac({ sessions: () => removed ? [] : [listed(muse)], responses: {
    "/api/clients": (url) => reply({ clients: url.hostname.startsWith("other") ? [{ ...muse, id: "remote" }] : removed ? [] : [muse] }),
    "/api/clients/muse-1": () => { removed = true; return reply({ ok: true }); },
    "/api/clients/remote": () => reply({ error: "Connection lost" }, 503),
  } });
  const { container: c } = await render({ peers: [peer, other] });
  await click(c.querySelector(".ppl-row"));
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Muse’s access"]'));
  assert.equal(removed, true);
  assert.ok(calls.some(([method, route]) => method === "DELETE" && route === "/api/clients/remote"));
  assert.match(c.textContent, /Other Mac.*Connection lost/);
});

test("Remove access still revokes locally when another computer cannot be checked, and names the failure", async () => {
  const muse = browserAgent("muse-1", { group: "shared" });
  const other = { ...peer, id: "other", name: "Other Mac", url: "https://other.tail.ts.net" };
  const calls = mac({ clients: [muse], responses: {
    "/api/clients": (url) => url.hostname.startsWith("other") ? reply({ error: "Offline" }, 503) : reply({ clients: [muse] }),
    "/api/clients/muse-1": () => reply({ ok: true }),
  } });
  const { container: c } = await render({ peers: [peer, other] });
  await click(c.querySelector(".ppl-row"));
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Muse’s access"]'));
  assert.ok(calls.some(([method, route]) => method === "DELETE" && route === "/api/clients/muse-1"));
  assert.match(c.textContent, /Other Mac.*Offline/);
});

test("a delayed refresh cannot restore access after Remove access succeeds", async (t) => {
  const polls = [], realInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    if (ms === 5000) { polls.push(callback); return realInterval(callback, 60000, ...args); }
    return realInterval(callback, ms, ...args);
  });
  const muse = browserAgent("muse-1");
  let removed = false, slow = false, release;
  mac({ sessions: () => removed ? [] : [listed(muse)], responses: {
    "/api/clients": () => slow && !removed
      ? new Promise(resolve => { release = () => resolve(reply({ clients: [muse] })); })
      : reply({ clients: removed ? [] : [muse] }),
    "/api/clients/muse-1": () => { removed = true; return reply({ ok: true }); },
  } });
  t.after(() => release?.());
  const { container: c } = await render();
  await click(c.querySelector(".ppl-row"));
  slow = true;
  polls[0]();
  await dom.waitFor(() => release);
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Muse’s access"]'));
  await dom.waitFor(() => !c.querySelector(".ppl-row"));
  release();
  await settle(40);
  assert.equal(!!c.querySelector(".ppl-row"), false, "the old snapshot must be discarded");
});

test("a failed refresh preserves the last access list and clears its warning after recovery", async (t) => {
  const polls = [], realInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    if (ms === 5000) { polls.push(callback); return realInterval(callback, 60000, ...args); }
    return realInterval(callback, ms, ...args);
  });
  const muse = browserAgent("muse-1");
  let failing = false;
  mac({ responses: { "/api/clients": () => failing ? reply(null) : reply({ clients: [muse] }) } });
  const { container: c } = await render();
  failing = true;
  polls[0]();
  await dom.waitFor(() => /could not be loaded/.test(c.textContent));
  assert.match(c.querySelector(".ppl-row").textContent, /Muse/);
  failing = false;
  polls[0]();
  await dom.waitFor(() => !/could not be loaded/.test(c.textContent));
  assert.match(c.querySelector(".ppl-row").textContent, /Muse/);
});

test("a stalled access-list request times out and a later refresh can recover", async (t) => {
  const deadlines = [], polls = [];
  const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 35000) deadlines.push(callback);
    return realTimeout(callback, ms, ...args);
  });
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    if (ms === 5000) { polls.push(callback); return realInterval(callback, 60000, ...args); }
    return realInterval(callback, ms, ...args);
  });
  mac({ responses: {
    "/api/clients": (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  } });
  const { container: c } = await render();
  assert.equal(deadlines.length, 1);
  deadlines[0]();
  await dom.waitFor(() => /didn't answer in time/.test(c.textContent));
  assert.doesNotMatch(c.textContent, /No agents yet/);
  mac({ clients: [browserAgent("muse-1")] });
  polls[0]();
  await dom.waitFor(() => c.querySelector(".ppl-row"));
  assert.doesNotMatch(c.textContent, /didn't answer in time/);
});

test("repeated Remove access taps send one deletion while the first is pending", async (t) => {
  let release;
  const muse = browserAgent("muse-1");
  const calls = mac({ clients: [muse], responses: {
    "/api/clients/muse-1": () => new Promise(resolve => { release = () => resolve(reply({ ok: true })); }),
  } });
  t.after(() => release?.());
  const { container: c } = await render();
  await click(c.querySelector(".ppl-row"));
  dom.window.confirm = globalThis.confirm = () => true;
  const remove = c.querySelector('[aria-label="End Muse’s access"]');
  dom.update(() => { remove.click(); remove.click(); });
  await dom.waitFor(() => release);
  assert.equal(calls.filter(([method]) => method === "DELETE").length, 1);
  assert.equal(remove.disabled, true);
  release();
  await dom.waitFor(() => !c.querySelector(".ppl-sheet"));
});

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

// Who is using their access: active (used it in the last two minutes, or
// holding the Mac) comes first with a green dot; the rest say Idle, and
// their sheet says since when. Someone who hasn't joined says only that.
test("active agents and people come first with a green dot; idle ones say since when", async () => {
  const now = Date.now();
  const cli = (id, name, extra = {}) => ({ id, name, kind: "agent", status: "accepted", expiresAt: later(), scopes: ["device", "files:read"], policy: { invite: true }, ...extra });
  const quiet = cli("quiet-1", "Quiet", { activeAt: now - 3 * 3600000 });
  const busy = cli("busy-2", "Busy", { activeAt: now - 20000 });
  const fresh = cli("fresh-3", "Fresh", { status: "invited" });
  const holder = browserAgent("hold-4", { name: "Holder" });
  const sam = { id: "sam-5", name: "Sam", kind: "guest", status: "accepted", expiresAt: later(), scopes: ["screen"], activeAt: now - 600000 };
  const alex = { id: "alex-6", name: "Alex", kind: "guest", status: "accepted", expiresAt: later(), scopes: ["screen"] };
  mac({ clients: [quiet, busy, fresh, holder, sam, alex], sessions: [listed(holder, { holdsMac: true, using: { at: now, app: "Safari" } })] });
  const { container: c } = await render({ here: [{ id: "client:alex-6", name: "Alex", kind: "phone", self: false, access: [{ kind: "invited", expiresAt: later() }], activity: "viewing" }] });
  await dom.waitFor(() => c.querySelectorAll(".ppl-row").length === 6);
  const state = (r) => [r.querySelector("strong").textContent, r.querySelector(".ppl-use")?.textContent || "", !!r.querySelector(".ppl-live")];
  assert.deepEqual([...c.querySelectorAll(".ppl-row")].map(state), [
    ["Busy", "Active", true],
    ["Holder", "Active", true],
    ["Quiet", "Idle", false],
    ["Fresh", "", false],
    ["Alex", "Active", true],
    ["Sam", "Idle", false],
  ]);
  await click(rowNamed(c, "Quiet"));
  assert.equal(c.querySelector(".ppl-sheet .ppl-hero .ppl-use").textContent, "Idle · last active 3 h ago");
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
  // Each page is an entry of Reach's back stack (src/nav-history.ts).
  const under = dom.window.history.state?.reach?.i ?? 0;
  await click(ended);
  await dom.waitFor(() => c.querySelector('.ppl-page [data-agent-id="old-2"]'));
  assert.match(c.querySelector('.ppl-page [data-agent-id="old-2"]').textContent, /Old helper.*Stopped/);
  assert.equal(c.querySelector(".ppl-head"), null, "Ended is a page in place of the list, not a sheet over it");
  assert.equal(c.querySelector("dialog.ppl-sheet"), null);
  // Its own page, then back twice: Ended, then the list.
  await click(c.querySelector('.ppl-page [data-agent-id="old-2"]'));
  await dom.waitFor(() => c.querySelector('.ppl-page [aria-label="Back to Ended"]'));
  assert.equal(dom.window.history.state.reach.i, under + 2);
  await click(c.querySelector('[aria-label="Back to Ended"]'));
  await dom.waitFor(() => c.querySelector('.ppl-page [data-agent-id="old-2"]'));
  await click([...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Back to Agents & people"));
  await dom.waitFor(() => c.querySelector(".ppl-head"));
  assert.equal(dom.window.history.state?.reach?.i ?? 0, under);
});

// Oct 13 (owner: "only small, compact modals"): someone's access is a long
// form, so their sheet's "Edit access" chevron opens a page in place, not a
// second sheet over the first. Back, or Save, brings their sheet back.
test("Edit access opens as a page in place; back and Save return to the agent's sheet", async () => {
  const muse = browserAgent("muse-1");
  const calls = mac({ clients: [muse], responses: {
    "/api/agents/browser-options": () => reply({ terminals: [], presetApps: [] }),
    "/api/guests/muse-1/access": () => reply({ ok: true }),
  } });
  const { container: c } = await render();
  await dom.waitFor(() => c.querySelector(".ppl-row"));
  const edit = () => [...c.querySelectorAll(".ppl-sheet button")].find((b) => b.textContent.trim() === "Edit access");
  await click(c.querySelector(".ppl-row"));
  await click(edit());
  const page = await dom.waitFor(() => c.querySelector(".ppl-page .sub-page"));
  assert.equal(c.querySelector(".ppl-sheet"), null, "the sheet gives way to the page");
  assert.equal(c.querySelector(".ppl-head"), null, "a page in place of the list");
  assert.equal(page.querySelector("h1").textContent, "Edit access");
  assert.equal(page.closest("dialog"), null, "not a sheet");
  assert.ok(page.querySelector('[aria-label="Edit agent access"]'));
  // Back: Muse's sheet again.
  await click(page.querySelector('[aria-label="Back to Muse"]'));
  await dom.waitFor(() => c.querySelector(".ppl-sheet"));
  assert.ok(c.querySelector(".ppl-head"));
  // Save: back to the sheet, which says so.
  await click(edit());
  await dom.waitFor(() => c.querySelector('.ppl-page [aria-label="Edit agent access"]'));
  await click([...c.querySelectorAll(".ppl-page button")].find((b) => b.textContent.trim() === "Save"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/guests/muse-1/access"));
  await dom.waitFor(() => c.querySelector(".ppl-sheet"));
  assert.match(c.querySelector(".ppl-sheet").textContent, /Access updated\./);
  assert.equal(c.querySelector(".ppl-page"), null);
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
  await dom.waitFor(() => /Morning mail/.test(c.querySelector(".ppl-page")?.textContent || ""));
  assert.equal(c.querySelector(".ppl-page .sub-page h1").textContent, "Shortcuts");
  assert.equal(c.querySelector(".ppl-page .as-shortcuts"), null, "no fold inside its own page");
});

test("a service waiting for you heads the Agents list in amber", async () => {
  const muse = browserAgent("muse-1");
  mac({
    clients: [muse],
    sessions: [listed(muse)],
    services: [{ id: "x", status: "pending", expiresAt: later(), accessExpiresAt: later(), agentName: "Muse", serviceName: "Gmail", permissions: ["read"], account: "me", reason: "" }],
  });
  const { container: c } = await render();
  await dom.waitFor(() => rowNamed(c, "Services"));
  const services = rowNamed(c, "Services");
  assert.equal(services.querySelector(".gs-value").textContent, "1 waiting");
  assert.ok(services.querySelector(".gs-value").classList.contains("ppl-attention"));
  await dom.waitFor(() => c.querySelector(".ppl-row"));
  assert.ok(services.compareDocumentPosition(c.querySelector(".ppl-row")) & 4, "before the agents");
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
  assert.match(lines[1], /^Unknown device · Paired Oct 3.*4:50/);
  assert.match(lines[2], /^Unknown device · Paired Oct 3.*6:56/);
  assert.equal(lines[3], "Unknown device · Paired Oct 5");
});

// One row per Tailscale device: its browsers together, named as Tailscale
// names it; something on the Mac itself says so (the iPhone Simulator, say).
test("your devices: one row per Tailscale device, named, with how many browsers", async () => {
  const at = (iso) => new Date(iso).toISOString();
  const phone = { userId: "u1", nodeId: "nPhone" }, mac = { userId: "u1", nodeId: "nMac" };
  macWith([
    { id: "me", kind: "device", name: "My iPhone", createdAt: at("2026-10-06T05:33:00"), expiresAt: later(), tailscale: phone, deviceGroup: "nPhone", nodeName: "iphone182" },
    { id: "old", kind: "device", name: "My iPhone", createdAt: at("2026-10-04T02:36:00"), expiresAt: later(), tailscale: phone },
    { id: "safari", kind: "device", name: "My iPhone", createdAt: at("2026-10-06T16:56:00"), expiresAt: later(), tailscale: phone, deviceGroup: "nPhone", nodeName: "iphone182" },
    { id: "sim", kind: "device", name: "My iPhone", createdAt: at("2026-10-09T16:31:00"), expiresAt: later(), tailscale: mac, deviceGroup: "nMac", nodeName: "my-mac" },
  ]);
  const { container: c } = await render();
  await dom.waitFor(() => c.querySelectorAll(".ppl-row").length === 2);
  assert.deepEqual([...c.querySelectorAll(".ppl-row small")].map((e) => e.textContent), [
    "iphone182 · 3 browsers · This device",
    "On this Mac · Paired Oct 9",
  ]);
});
