import assert from "node:assert/strict";
import test from "node:test";
import { createPermissionRequests } from "../server/permission-requests.mjs";
import { presetRouteAllowed } from "../server/agent-presets.mjs";
import { permittedPath } from "../server/funnel-agent.mjs";
import { toolsFor } from "../scripts/mcp-server.mjs";
import { createAgentRuntimes, updateNotice } from "../server/agent-runtimes.mjs";

const agent = { id: "a1", kind: "agent", name: "Grok", policy: { browser: true, invite: true, preset: "full", roots: [] }, scopes: ["device", "browser:read", "browser:control", "browser:open", "browser:screen"] };
const owner = { id: "d1", kind: "device", scopes: ["admin"] };
function world({ chromeReady = false, screen = false } = {}) {
  const pushes = [], opened = [], enabled = [];
  let clock = 1_000_000;
  const permissions = createPermissionRequests({
    toolSetup: {
      status: async () => ({ browsers: [{ id: "Chrome", ready: chromeReady }, { id: "Safari", ready: false }] }),
      enable: async (id) => { enabled.push(id); return { id, javascript: "on", automation: "ask" }; },
    },
    access: async () => ({ screen, accessibility: true }),
    open: async (url) => { opened.push(url); return true; },
    notify: (message) => pushes.push(message),
    now: () => clock,
  });
  return { permissions, pushes, opened, enabled, tick: (ms) => { clock += ms; } };
}
const asAgent = () => agent, asOwner = () => owner;

test("an agent's ask reaches the owner once, as a notification and a card; Allow does what Reach can on the Mac", async () => {
  const w = world();
  const asked = await w.permissions.request(asAgent, { need: "browser-tools", browser: "Chrome", reason: "Check 24 cart lines with the saved tool." });
  assert.equal(asked.status, "pending");
  assert.match(asked.message, /asked on their phone/);
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].url, `/?page=overview&needs=permission:${asked.id}`);
  assert.match(w.pushes[0].title, /^Grok asks for browser tools in Chrome$/);
  const again = await w.permissions.request(asAgent, { need: "browser-tools", browser: "Chrome", reason: "Again" });
  assert.equal(again.id, asked.id, "a repeat is the same request");
  assert.equal(w.pushes.length, 1, "and no second notification");
  const [card] = w.permissions.list(asOwner).permissions;
  assert.equal(card.title, "Grok asks for browser tools in Chrome");
  assert.match(card.allowDoes, /Allow JavaScript from Apple Events/);
  assert.equal(card.reason, "Check 24 cart lines with the saved tool.");
  const allowed = await w.permissions.decide(asOwner, asked.id, { decision: "allow" });
  assert.deepEqual(w.enabled, ["Chrome"], "the browser's switch and macOS's prompt, through tool-setup");
  assert.equal(allowed.status, "allowed");
  assert.match(allowed.next, /macOS asks on the Mac/);
  assert.equal((await w.permissions.request(asAgent, { need: "browser-tools", browser: "Chrome", reason: "x" })).status, "allowed");
  await assert.rejects(w.permissions.decide(asOwner, asked.id, { decision: "deny" }), /already answered/);
});

test("Screen Recording opens its settings pane; Not now stands; nothing is asked when the Mac already allows it", async () => {
  const w = world({ chromeReady: true });
  assert.equal((await w.permissions.request(asAgent, { need: "browser-tools", browser: "Chrome", reason: "x" })).status, "ready");
  assert.equal((await w.permissions.request(asAgent, { need: "accessibility", reason: "x" })).status, "ready");
  assert.equal(w.pushes.length, 0, "nothing to ask: nothing sent");
  const screen = await w.permissions.request(asAgent, { need: "screen-recording", reason: "Screenshots of the cart." });
  const allowed = await w.permissions.decide(asOwner, screen.id, { decision: "allow" });
  assert.deepEqual(w.opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
  assert.match(allowed.next, /restart Reach/);
  const safari = await w.permissions.request(asAgent, { need: "browser-tools", browser: "Safari", reason: "x" });
  assert.equal((await w.permissions.decide(asOwner, safari.id, { decision: "deny" })).status, "denied");
  assert.equal((await w.permissions.request(asAgent, { need: "browser-tools", browser: "Safari", reason: "x" })).status, "denied", "no new ping right after Not now");
  w.tick(11 * 60_000);
  assert.equal((await w.permissions.request(asAgent, { need: "browser-tools", browser: "Safari", reason: "x" })).status, "pending", "later, it may ask again");
});

test("only invited agents ask, only the owner answers, and asks are bounded", async () => {
  const w = world();
  await assert.rejects(w.permissions.request(asOwner, { need: "accessibility", reason: "x" }), /Only an invited agent/);
  await assert.rejects(w.permissions.request(asAgent, { need: "admin", reason: "x" }), /Ask for one of/);
  await assert.rejects(w.permissions.request(asAgent, { need: "browser-tools", reason: "x" }), /Name the browser/);
  await assert.rejects(w.permissions.request(asAgent, { need: "accessibility", browser: "Chrome", reason: "x" }), /Only browser tools/);
  await assert.rejects(w.permissions.request(asAgent, { need: "accessibility", reason: "" }), /why you need it/);
  await assert.rejects(w.permissions.request(asAgent, { need: "accessibility", reason: "x‮" }), /why you need it/);
  await assert.rejects(w.permissions.request(asAgent, { need: "accessibility", reason: "x", extra: 1 }), /Send need/);
  const asked = await w.permissions.request(asAgent, { need: "screen-recording", reason: "x" });
  assert.throws(() => w.permissions.list(asAgent), /Only the owner/);
  await assert.rejects(w.permissions.decide(asAgent, asked.id, { decision: "allow" }), /Only the owner/);
  await assert.rejects(w.permissions.decide(asOwner, asked.id, { decision: "maybe" }), /allow or deny/);
  const other = (n) => () => ({ ...agent, id: `a${n}` });
  const many = world({});
  for (const [index, need] of [["browser-tools", "Chrome"], ["browser-tools", "Safari"], ["screen-recording"]].entries())
    await many.permissions.request(other(9), { need: need[0], ...(need[1] ? { browser: need[1] } : {}), reason: `ask ${index}` });
  assert.equal(many.pushes.length, 3);
});

test("agents reach the ask through the preset allowlist and the public gateway, never the owner's answer", () => {
  const client = { ...agent, policy: { ...agent.policy } };
  assert.equal(presetRouteAllowed(client, "POST", "/browser/permissions/request"), true);
  assert.equal(presetRouteAllowed(client, "GET", "/agents/permissions"), false);
  assert.equal(presetRouteAllowed(client, "POST", "/agents/permissions/x"), false);
  assert.equal(permittedPath("POST", "/api/browser/permissions/request"), "/browser/permissions/request");
  assert.throws(() => permittedPath("POST", "/api/agents/permissions/x"));
});

test("the MCP list offers the new tools (each needs its scope in mcp-server's table)", () => {
  const access = { preset: "full", screen: true, control: true, open: true, shell: true, write: true, roots: [], apps: [], hidden: [] };
  const names = toolsFor(["device", "browser:read", "browser:screen", "browser:control", "browser:open", "browser:shell", "browser:write"], access).map((tool) => tool.name);
  assert.ok(names.includes("reach_open_bank"));
  assert.ok(names.includes("reach_request_permission"));
  const readOnly = toolsFor(["device", "browser:read", "browser:screen"], { preset: "readonly", screen: true, roots: [], apps: [], hidden: [] }).map((tool) => tool.name);
  assert.ok(readOnly.includes("reach_request_permission"), "any preset may ask (Read only needs Screen Recording too)");
  assert.ok(!readOnly.includes("reach_open_bank"));
});

test("a runtime that named itself lately isn't told it's out of date on a call that doesn't say", () => {
  const sha = "a".repeat(64), client = { id: "rt-1", kind: "agent" };
  const runtimes = createAgentRuntimes({ current: () => sha });
  runtimes.note(client, sha, { program: true });
  runtimes.note(client, undefined, { program: true });
  assert.equal(runtimes.statusOf(client), "current");
  assert.deepEqual(updateNotice({ client, req: { headers: {}, query: {} }, served: sha, host: "mac.example" }), {});
  const stranger = { id: "rt-2", kind: "agent" };
  assert.ok(updateNotice({ client: stranger, req: { headers: {}, query: {} }, served: sha, host: "mac.example" }).update, "a copy that never named itself still hears it");
});
