import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createCodexDaemon, parseDaemonVersion, olderVersion, serviceVersionOf } from "../server/agent-sessions/codex-daemon.mjs";
import { createCodexSessions } from "../server/agent-sessions/codex.mjs";
import { agentSource, codexServiceSource, createKeepInSync, describe, openClawSource, syncNotification } from "../server/keep-in-sync.mjs";
import { sealNotification, notificationPush } from "../server/notification-items.mjs";
import { spawnable } from "../server/agent-cli.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "I still see sol 6.1 not available in reach, why?" / "We should prompt
// users to update and do it on their behalf" / "Reach should keep in sync
// with dependencies" (Oct 13). Codex's service (0.158) ran behind its CLI
// (0.162): Reach says so once per version pair and, on the owner's tap, runs
// `codex app-server daemon update`, reconnects and reads the models again.
// Stand-ins only: the real Codex is never run or updated here.

const windows = process.platform === "win32";
// The owner's Mac, Oct 13.
const OWNER_VERSION = '{"managedCodexVersion":"0.158.0-alpha.2.1","cliVersion":"0.162.0-alpha.17.2","appServerVersion":"0.158.0-alpha.2.1","managedCodexPath":"/Users/me/.codex/packages/app-server-daemon/current/bin/codex"}';

test("detection: `daemon version` JSON and the hello's userAgent; equal or newer services aren't behind", () => {
  const v = parseDaemonVersion(OWNER_VERSION);
  assert.deepEqual(v, { service: "0.158.0-alpha.2.1", cli: "0.162.0-alpha.17.2" });
  assert.equal(olderVersion(v.service, v.cli), true);
  assert.equal(serviceVersionOf("codex_cli_rs/0.158.0-alpha.2.1 (Mac OS 26.6.2; arm64) xterm"), "0.158.0-alpha.2.1");
  assert.equal(olderVersion("0.162.0", "0.162.0-alpha.17.2"), false, "same version: nothing to offer");
  assert.equal(olderVersion("0.163.0", "0.162.0"), false, "a newer service: nothing to offer");
  assert.deepEqual(parseDaemonVersion("not json"), { service: null, cli: null });
  assert.deepEqual(parseDaemonVersion('{"appServerVersion":"latest","cliVersion":3}'), { service: null, cli: null }, "never guessed");
  assert.deepEqual(parseDaemonVersion('{"managedCodexVersion":"0.158.0"}'), { service: "0.158.0", cli: null });
});

test("what a card and a row say: the service names the model it unlocks, else newer models", () => {
  const item = { id: "codex-service", name: "Codex's service", state: "behind", from: "0.158.0-alpha.2.1", to: "0.162.0-alpha.17.2", unlocks: "GPT-6.1 Sol" };
  assert.deepEqual(describe(item), {
    title: "Update Codex's service to use GPT-6.1 Sol and newer models",
    detail: "Codex's service is 0.158; your Codex is 0.162",
  });
  assert.equal(describe({ ...item, unlocks: null }).title, "Update Codex's service to use newer models");
  assert.equal(describe({ id: "claude", name: "Claude Code", state: "behind", from: "2.1.291", to: "2.1.295" }).title, "Claude Code 2.1.295 is out");
  assert.equal(describe({ id: "codex", name: "Codex", state: "too-old", from: "0.140.0", to: "0.148.0" }).title, "Update Codex to 0.148 or newer to use it here");
});

// A JSON-RPC service as Codex answers it, whose version and model list
// change when the stand-in `daemon update` runs.
async function service(t) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = { version: "0.158.0-alpha.2.1", models: ["gpt-6-astra"], connections: 0 };
  wss.on("connection", (socket) => {
    state.connections++;
    socket.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id == null) return;
      const result = m.method === "initialize" ? { userAgent: `codex_cli_rs/${state.version} (Mac OS 26.6.2; arm64)` }
        : m.method === "model/list" ? { data: state.models.map((id) => ({ id, displayName: id, supportedReasoningEfforts: [], isDefault: id === "gpt-6-astra" })) }
        : /\/list$/.test(m.method) ? { data: [] } : {};
      socket.send(JSON.stringify({ id: m.id, result }));
    });
  });
  const endpoint = windows ? `\\\\.\\pipe\\reach-test-sync-${crypto.randomBytes(6).toString("hex")}` : path.join(await fs.mkdtemp(path.join(os.tmpdir(), "reach-sync-")), "s");
  server.listen(endpoint);
  await once(server, "listening");
  t.after(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  return { state, endpoint };
}
const CLI = "0.162.0-alpha.17.2";
const cliCatalog = { data: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, supportedReasoningEfforts: [] }, { id: "gpt-6-astra", displayName: "gpt-6-astra", supportedReasoningEfforts: [] }] };
function daemonWith(t, svc, { update = async () => { svc.state.version = CLI; svc.state.models = ["gpt-6.1-sol", "gpt-6-astra"]; }, file = windows ? "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" : "/opt/codex/bin/codex" } = {}) {
  const calls = [];
  const daemon = createCodexDaemon({
    locate: async () => file,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const verb = args.slice(-1)[0];
      if (verb === "start") return { stdout: JSON.stringify({ socketPath: svc.endpoint }) };
      if (verb === "version") return { stdout: OWNER_VERSION };
      if (verb === "update") { await update(); return { stdout: "" }; }
      throw new Error("unexpected");
    },
    check: async () => ({ status: "available", version: CLI }),
    checkSocket: async () => {},
    listCliModels: async () => cliCatalog,
    defaults: () => ({}),
  });
  t.after(() => daemon.close());
  return { daemon, calls, file };
}

test("after an update: one fixed command, a new connection, and gpt-6.1-sol is pickable", async (t) => {
  const svc = await service(t);
  const { daemon, calls, file } = daemonWith(t, svc);
  const codex = createCodexSessions({ daemon, appState: () => ({}) });
  // Before any connection: `daemon version`.
  assert.deepEqual(await daemon.serviceStatus(), { service: "0.158.0-alpha.2.1", cli: CLI, behind: true });
  // The CLI catalog comes in the background; the second sheet has it.
  await codex.models();
  await new Promise((r) => setImmediate(r));
  const before = await codex.models();
  const sol = before.models.find((m) => m.id === "gpt-6.1-sol");
  assert.equal(sol.unconfirmed, true);
  assert.equal(sol.needsServiceUpdate, true);
  assert.deepEqual(before.serviceUpdate, { from: "0.158.0-alpha.2.1", to: CLI, unlocks: "GPT-6.1 Sol" });
  // Connected: the hello says it.
  assert.deepEqual(await daemon.serviceStatus(), { service: "0.158.0-alpha.2.1", cli: CLI, behind: true });
  const connections = svc.state.connections;
  let closedOnce = 0;
  daemon.onClose(() => closedOnce++);
  const after = await daemon.updateService();
  assert.deepEqual(after, { service: CLI, cli: CLI, behind: false });
  // The same Codex Reach runs, by the same route as `daemon start` (on
  // Windows CI: node and Codex's script, never cmd.exe).
  const cli = spawnable(file);
  assert.deepEqual(calls.find((c) => c.at(-1) === "update"), [cli.file, ...cli.args, "app-server", "daemon", "update"]);
  assert.ok(svc.state.connections > connections, "a new connection after the update");
  assert.equal(closedOnce, 1, "subscriptions hear the old connection end");
  const now = await codex.models();
  assert.equal(now.models.find((m) => m.id === "gpt-6.1-sol").unconfirmed, undefined, "pickable now");
  assert.equal(now.serviceUpdate, undefined);
});

test("a failed update says why; an exit code alone isn't success", async (t) => {
  const svc = await service(t);
  const failing = daemonWith(t, svc, { update: async () => { throw Object.assign(new Error("Command failed"), { stderr: "error: couldn't download the daemon package\n" }); } });
  await assert.rejects(failing.daemon.updateService(), /^Error: Codex's service didn't update: error: couldn't download the daemon package$/);
  const still = daemonWith(t, svc, { update: async () => {} });
  await assert.rejects(still.daemon.updateService(), /Codex's service is still 0\.158\.0-alpha\.2\.1\./);
});

test("Windows: the update runs Codex's script with node, as its daemon start does (mocked check)", async (t) => {
  // spawnable decides; the service is a stand-in.
  const js = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const run = spawnable(js, { platform: "win32", node: "C:\\node\\node.exe" });
  assert.deepEqual([run.file, ...run.args, "app-server", "daemon", "update"], ["C:\\node\\node.exe", js, "app-server", "daemon", "update"]);
  const exe = spawnable("C:\\Users\\me\\.codex\\bin\\codex.exe", { platform: "win32" });
  assert.deepEqual(exe, { file: "C:\\Users\\me\\.codex\\bin\\codex.exe", args: [] });
  if (!windows) return;
  const svc = await service(t);
  const { daemon, calls } = daemonWith(t, svc, { file: js });
  await daemon.updateService();
  assert.deepEqual(calls.find((c) => c.at(-1) === "update"), [process.execPath, js, "app-server", "daemon", "update"]);
});

// The shared list: once per pair, the owner's tap, what it would stop said first.
function syncWith({ dataDir = null, working = [], behind = true, update } = {}) {
  const ran = [];
  const sync = createKeepInSync({
    dataDir,
    sources: [
      codexServiceSource({
        status: async () => ({ service: "0.158.0-alpha.2.1", cli: CLI, behind }),
        models: async () => ({ serviceUpdate: { unlocks: "GPT-6.1 Sol" } }),
        update: update || (async () => (ran.push("codex-service"), { service: CLI })),
        working: () => working,
      }),
      agentSource("claude", { updates: { status: async () => ({ state: "current", installed: "2.1.295", latest: "2.1.295" }) }, update: async () => ran.push("claude") }),
      openClawSource({ tooOld: () => null }),
    ],
  });
  return { sync, ran };
}

test("the prompt appears once per version pair; Not now keeps that pair away", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-sync-dismiss-"));
  const { sync } = syncWith({ dataDir });
  await sync.refresh();
  const [offer] = sync.offers();
  assert.equal(sync.offers().length, 1, "only what's behind");
  const card = syncNotification(offer, sealNotification);
  assert.equal(card.id, `sync:codex-service:0.158.0-alpha.2.1>${CLI}`);
  assert.equal(card.title, "Update Codex's service to use GPT-6.1 Sol and newer models");
  assert.equal(card.detail, "Codex's service is 0.158; your Codex is 0.162");
  assert.equal(card.push, false, "behind is quiet");
  assert.deepEqual(card.actions.map((a) => a.label), ["Update", "Not now"]);
  assert.equal(notificationPush(card).title, card.title);
  sync.dismiss("codex-service", `0.158.0-alpha.2.1>${CLI}`);
  assert.equal(sync.offers().length, 0);
  // Remembered across a restart; a new pair shows again.
  const again = syncWith({ dataDir }).sync;
  await again.refresh();
  assert.equal(again.offers().length, 0);
  const newer = createKeepInSync({ dataDir, sources: [codexServiceSource({ status: async () => ({ service: "0.162.0", cli: "0.163.0", behind: true }) })] });
  await newer.refresh();
  assert.equal(newer.offers().length, 1);
  // Equal (or newer) services: nothing.
  const { sync: even } = syncWith({ behind: false });
  await even.refresh();
  assert.equal(even.offers().length, 0);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("a working Codex chat is said first; Update anyway runs it; the result is shown", async () => {
  const working = ["thread-1"];
  const { sync, ran } = syncWith({ working });
  await sync.refresh();
  const card = syncNotification(sync.offers()[0], sealNotification);
  assert.equal(card.summary, "1 Codex chat is working: it may stop.");
  assert.deepEqual(card.actions.map((a) => a.label), ["Update anyway", "Not now"]);
  await assert.rejects(sync.start("codex-service"), (e) => e.status === 409 && e.working === 1 && e.message === "1 Codex chat is working: it may stop. Update anyway?");
  assert.deepEqual(ran, [], "nothing ran");
  await sync.start("codex-service", { anyway: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ["codex-service"]);
  assert.deepEqual(sync.list().find((i) => i.id === "codex-service").run.message, "Codex's service is 0.162");
  // Failure: its reason.
  const failing = syncWith({ update: async () => { throw new Error("Codex's service didn't update: no network."); } }).sync;
  await failing.refresh();
  await failing.start("codex-service");
  await new Promise((r) => setTimeout(r, 20));
  const run = failing.list().find((i) => i.id === "codex-service").run;
  assert.deepEqual([run.state, run.message], ["failed", "Codex's service didn't update: no network."]);
});

test("Update runs as the owner only, never for guests or agents (Needs you and Settings)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-sync-route-"));
  const { sync, ran } = syncWith();
  await sync.refresh();
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    keepInSync: sync,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const other = reach.auth.issue("linked", ALL_SCOPES, "linked-mac");
  const call = (token, route, body) =>
    fetch(`${url}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    for (const who of [agent, other]) {
      assert.equal((await call(who.token, "/api/sessions/keep-in-sync")).status, 403);
      assert.equal((await call(who.token, "/api/sessions/keep-in-sync/codex-service", { action: "update" })).status, 403);
    }
    const list = await (await call(owner.token, "/api/sessions/keep-in-sync")).json();
    assert.equal(list.items.find((i) => i.id === "codex-service").title, "Update Codex's service to use GPT-6.1 Sol and newer models");
    // Needs you: the card, answered by the owner.
    const needs = await (await call(owner.token, "/api/notifications")).json();
    const card = needs.items.find((i) => i.source === "sync");
    assert.ok(card, "a Needs you card");
    assert.equal((await call(agent.token, `/api/notifications/${encodeURIComponent(card.id)}/actions`, { revision: card.revision, action: "update" })).status, 403);
    assert.deepEqual(ran, []);
    const answered = await call(owner.token, `/api/notifications/${encodeURIComponent(card.id)}/actions`, { revision: card.revision, action: "update" });
    assert.equal(answered.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(ran, ["codex-service"]);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
