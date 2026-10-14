import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { serveMcp, toolsFor } from "../scripts/mcp-server.mjs";
import { isBundle, runtimeUpdater, updatesOff } from "../scripts/agent-remote.mjs";
import { buildAgent, inputsFile } from "../scripts/build-agent.mjs";

// An agent keeps the runtime it downloaded when it joined. When the computer
// serves a newer one (Reach changed: a tool's schema, a new tool), the agent
// brings its tools in by itself: while its MCP server keeps running, and for
// one-off commands. Nothing that doesn't check out ever replaces it.
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const OLD = "a".repeat(64), NEW = "b".repeat(64);
const newer = {
  toolsFor: () => [{ name: "reach_new_tool", description: "From the newer runtime", inputSchema: { type: "object", properties: {} } }],
  callTool: async (_api, name) => ({ called: name, by: "newer" }),
};

// The MCP server over pipes; `messages` in order, answers by id plus any
// notifications.
async function serve({ runtime, device, browser, messages, upgradeWaitMs, pause = 0, routes = [] }) {
  const api = async (route) => {
    routes.push(route);
    const [path] = route.split("?");
    if (path === "/api/device") return device();
    if (path === "/api/browser") return browser();
    throw Error(`Unexpected route ${route}`);
  };
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const served = serveMcp({ api, scopes: ["exec"], input, output, ...(runtime ? { runtime } : {}), ...(upgradeWaitMs ? { upgradeWaitMs } : {}) });
  for (const message of messages) {
    input.write(JSON.stringify(message) + "\n");
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  input.end();
  await served;
  const lines = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { results: new Map(lines.filter((l) => l.id !== undefined).map((l) => [l.id, l.result])), notes: lines.filter((l) => l.id === undefined).map((l) => l.method) };
}

test("a newer runtime on the computer: its tools in the very list that found it", async () => {
  const asked = [];
  const runtime = { current: OLD, update: async (wanted) => { asked.push(wanted); return newer; } };
  const { results, notes } = await serve({
    runtime, device: () => ({ access: { scopes: ["exec"] }, runtime: NEW }),
    messages: [{ id: 1, method: "tools/list" }, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "reach_new_tool", arguments: {} } }],
    pause: 20,
  });
  assert.deepEqual(asked, [NEW], "fetched once");
  assert.deepEqual(results.get(1).tools.map((t) => t.name), ["reach_new_tool"]);
  assert.deepEqual(results.get(2).tools.map((t) => t.name), ["reach_new_tool"]);
  assert.deepEqual(JSON.parse(results.get(3).content[0].text), { called: "reach_new_tool", by: "newer" });
  assert.deepEqual(notes, [], "the list itself carried them: nothing to announce");
});

test("one that loads late is announced with list_changed once it loads", async () => {
  let resolveUpdate;
  const loading = new Promise((resolve) => { resolveUpdate = resolve; });
  const runtime = { current: OLD, update: () => loading };
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const api = async (route) => (route.startsWith("/api/device") ? { access: { scopes: ["exec"] }, runtime: NEW } : {});
  const served = serveMcp({ api, scopes: ["exec"], input, output, runtime, upgradeWaitMs: 20 });
  input.write(JSON.stringify({ id: 1, method: "tools/list" }) + "\n");
  await new Promise((r) => setTimeout(r, 60));
  resolveUpdate(newer);
  await new Promise((r) => setTimeout(r, 20));
  input.write(JSON.stringify({ id: 2, method: "tools/list" }) + "\n");
  input.end();
  await served;
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!lines[0].result.tools.some((t) => t.name === "reach_new_tool"));
  assert.equal(lines[1].method, "notifications/tools/list_changed");
  assert.deepEqual(lines[2].result.tools.map((t) => t.name), ["reach_new_tool"]);
});

test("a call that sees a newer runtime loads it behind the scenes and announces it", async () => {
  const access = { name: "Mac", expiresAt: Date.now() + 60000, roots: [], terminals: [], screen: "off", runtime: NEW };
  const runtime = { current: OLD, update: async () => newer };
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const api = async (route) => (route.startsWith("/api/browser") ? access : route.startsWith("/api/device") ? { access: { scopes: ["browser:read"] } } : {});
  const served = serveMcp({ api, scopes: ["browser:read"], input, output, runtime });
  input.write(JSON.stringify({ id: 1, method: "tools/call", params: { name: "reach_access", arguments: {} } }) + "\n");
  await new Promise((r) => setTimeout(r, 30));
  input.end();
  await served;
  assert.ok(text.includes('"method":"notifications/tools/list_changed"'));
});

test("each agent says which runtime it runs: its own, then the newer one once loaded; with updates off too", async () => {
  const routes = [];
  await serve({
    runtime: { current: OLD, update: async () => newer }, routes,
    device: () => ({ access: { scopes: ["exec"] }, runtime: NEW }),
    messages: [{ id: 1, method: "tools/list" }, { id: 2, method: "tools/list" }], pause: 20,
  });
  assert.deepEqual(routes, [`/api/device?runtime=${OLD}`, `/api/device?runtime=${NEW}`]);
  // Updates off: nothing loads, but the computer still hears which it is.
  const quiet = [];
  const input = new PassThrough(), output = new PassThrough();
  const served = serveMcp({ api: async (route) => { quiet.push(route); return route.startsWith("/api/device") ? { access: { scopes: ["browser:read"] }, runtime: NEW } : { name: "Mac", roots: [], terminals: [], screen: "off" }; },
    scopes: ["browser:read"], input, output, report: OLD });
  input.end(JSON.stringify({ id: 1, method: "tools/list" }) + "\n");
  await served;
  // Reach's own tool list first (a computer without one answers no tools), then the access.
  assert.deepEqual(quiet, [`/api/device?runtime=${OLD}`, `/api/browser/mcp/tools?runtime=${OLD}`, `/api/browser?runtime=${OLD}`]);
  // A source checkout says nothing.
  const plain = [];
  await serve({ device: () => ({ access: { scopes: ["exec"] } }), messages: [{ id: 1, method: "tools/list" }], routes: plain });
  assert.deepEqual(plain, ["/api/device"]);
});

test("fails closed: a runtime that doesn't load leaves the tools as they are, and isn't asked for again at once", async () => {
  let asked = 0;
  const runtime = { current: OLD, update: async () => { asked++; throw Error("its runtime didn't match the hash it named"); } };
  const own = toolsFor(["exec"]).map((t) => t.name);
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    const { results } = await serve({
      runtime, device: () => ({ access: { scopes: ["exec"] }, runtime: NEW }),
      messages: [{ id: 1, method: "tools/list" }, { id: 2, method: "tools/list" }], pause: 20,
    });
    assert.deepEqual(results.get(1).tools.map((t) => t.name), own);
    assert.deepEqual(results.get(2).tools.map((t) => t.name), own);
  } finally { console.error = original; }
  assert.equal(asked, 1);
  assert.match(errors.join("\n"), /kept this runtime/);
  // Something that isn't tools, or no hash at all, changes nothing.
  for (const [update, named] of [[async () => ({ toolsFor: "no" }), NEW], [async () => newer, "not-a-hash"], [async () => newer, OLD], [async () => newer, undefined]]) {
    const { results } = await serve({ runtime: { current: OLD, update }, device: () => ({ access: { scopes: ["exec"] }, runtime: named }), messages: [{ id: 1, method: "tools/list" }] });
    assert.deepEqual(results.get(1).tools.map((t) => t.name), own, String(named));
  }
  // Without an updater (a source checkout, updates off): never asked.
  const { results } = await serve({ device: () => ({ access: { scopes: ["exec"] }, runtime: NEW }), messages: [{ id: 1, method: "tools/list" }] });
  assert.deepEqual(results.get(1).tools.map((t) => t.name), own);
});

// The real thing: the bundle an agent downloads, replaced by a newer one the
// computer serves, checked byte for byte.
test("the bundle takes the computer's newer runtime: checked, loaded from its own copy, saved for the next start", { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "agent.mjs");
  await buildAgent(file);
  const inputs = JSON.parse(fs.readFileSync(inputsFile(file), "utf8"));
  assert.ok(inputs.includes("server/browser-tools.mjs"), "a tool's schema rebuilds the bundle");
  assert.ok(inputs.includes("scripts/mcp-server.mjs"));
  const bundle = await import(pathToFileURL(file).href);
  assert.equal(bundle.isBundle(), true, "the bundle knows it is one");
  assert.equal(isBundle(), false, "a source checkout never replaces itself");
  assert.equal(runtimeUpdater({ home, api: async () => ({}), file }), null, "from source: no updater");
  for (const off of ["off", "0", "false", "NO"]) assert.equal(updatesOff({ REACH_AGENT_UPDATES: off }), true);
  assert.equal(runtimeUpdater({ home, api: async () => ({}), file, bundle: true, env: { REACH_AGENT_UPDATES: "off" } }), null);

  const original = fs.readFileSync(file, "utf8");
  const served = original + "\n// rebuilt on the computer\n";
  let answer = { sha256: sha(served), text: served };
  const lines = [];
  const updater = runtimeUpdater({ home, api: async (route) => { assert.equal(route, "/api/device/runtime"); return answer; }, file, bundle: true, env: {}, log: (line) => lines.push(line) });
  assert.equal(updater.current, sha(original));

  // Not what it named: refused, nothing written or loaded.
  answer = { sha256: sha(served), text: served + "tampered" };
  await assert.rejects(updater.update(sha(served)), /didn't match/);
  answer = { sha256: NEW, text: served };
  await assert.rejects(updater.update(sha(served)), /didn't match/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(path.join(home, "runtime", `agent-${sha(served).slice(0, 16)}.mjs`)), false);

  // As named: its tools, from its own copy; this file replaced for next time.
  answer = { sha256: sha(served), text: served };
  const next = await updater.update(sha(served));
  assert.equal(typeof next.toolsFor, "function");
  assert.notEqual(next.toolsFor, bundle.toolsFor, "a fresh copy, not this one");
  assert.ok(next.toolsFor(["browser:read", "browser:control"], { preset: "full", screen: true, control: true }).some((tool) => tool.name === "reach_act"));
  assert.equal(fs.readFileSync(file, "utf8"), served);
  assert.equal(updater.current, sha(served));
  assert.deepEqual(fs.readdirSync(path.join(home, "runtime")), [`agent-${sha(served).slice(0, 16)}.mjs`]);
  assert.match(lines.join("\n"), /updated to this computer's runtime/);
});

test("connected to several computers, the file stays: each may serve its own runtime", { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "agent.mjs");
  await buildAgent(file);
  for (const name of ["mac", "studio"]) {
    fs.mkdirSync(path.join(home, name));
    fs.writeFileSync(path.join(home, name, "credential.json"), JSON.stringify({ token: "x" }));
  }
  const original = fs.readFileSync(file, "utf8");
  const served = original + "\n// the studio's\n";
  const updater = runtimeUpdater({ home, api: async () => ({ sha256: sha(served), text: served }), file, bundle: true, env: {}, log: () => {} });
  const next = await updater.update(sha(served));
  assert.equal(typeof next.callTool, "function");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});
