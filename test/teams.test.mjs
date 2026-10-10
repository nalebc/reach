import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTeams } from "../server/agent-sessions/teams.mjs";
import { createRelays } from "../server/agent-sessions/relays.mjs";
import { createTeamBridge } from "../server/agent-sessions/team-bridge.mjs";
import { TEAM_LIMITS } from "../server/agent-sessions/team-tools.mjs";

// Team chats (server/agent-sessions/teams.mjs) against a stand-in for the
// agents, with the real relay engine carrying helpers' results to the lead.
const script = fileURLToPath(new URL("../scripts/team-mcp.mjs", import.meta.url));
const user = (id, text) => ({ id, role: "user", kind: "text", text });
const reply = (id, text) => ({ id, role: "assistant", kind: "text", text });

function stage({ authorized = () => "", offered = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-teams-"));
  let clock = 1_000_000;
  let n = 0;
  const pages = {};
  const started = [];
  const sent = [];
  const stopped = [];
  const sessions = {
    list: async () => ({ sessions: Object.entries(pages).map(([key, p]) => ({ agent: key.split(":")[0], id: key.split(":")[1], status: p.session.status })) }),
    read: async (agent, id) => structuredClone(pages[`${agent}:${id}`] || { session: { status: "idle" }, items: [] }),
    start: async (agent, body) => {
      const threadId = `${agent}-${++n}`;
      started.push({ agent, body });
      pages[`${agent}:${threadId}`] = { session: { title: "", cwd: body.cwd, status: "running" }, items: [user(`${threadId}-u`, body.text)] };
      return { threadId };
    },
    send: async (agent, id, body) => (sent.push({ agent, id, body }), { turnId: "t" }),
    stop: async (agent, id) => (stopped.push({ agent, id }), { stopped: true }),
  };
  const timers = [];
  const relays = createRelays({ sessions, now: () => clock, setTimer: (fn) => (timers.push(fn), { unref() {} }), setEvery: () => 0, clearEvery: () => {} });
  const teams = createTeams({
    sessions,
    relays,
    keysDir: path.join(dir, "teams"),
    socketPath: path.join(dir, "team.sock"),
    script,
    node: "/usr/local/bin/node",
    authorized,
    modes: async () => offered,
    now: () => clock,
  });
  const tick = (ms) => (clock += ms);
  // A helper's turn ends with a reply, seen twice a few seconds apart.
  const finish = async (chat, text) => {
    const page = pages[`${chat.agent}:${chat.id}`];
    page.session.status = "idle";
    page.items.push(reply(`${chat.id}-r${page.items.length}`, text));
    await relays.check();
    tick(4100);
    await relays.check();
  };
  return { dir, teams, relays, pages, started, sent, stopped, tick, finish };
}
const tokenOf = (dir, team) => JSON.parse(fs.readFileSync(path.join(dir, "teams", `${team.id}.json`), "utf8")).token;

test("a team's lead starts with its tools and standing instructions, its key private, out of the Claude app", async () => {
  const { dir, teams, started } = stage();
  await assert.rejects(teams.create({ owner: "phone", lead: "gemini", helpers: ["codex"], cwd: "/work/app", text: "Go" }), /lead is Codex or Claude Code/);
  await assert.rejects(teams.create({ owner: "phone", lead: "claude", helpers: [], cwd: "/work/app", text: "Go" }), /at least one helper/);
  const { team, threadId } = await teams.create({ owner: "phone", lead: "claude", helpers: ["codex", "codex", "gemini"], cwd: "/work/app", text: "Build pagination", start: { mode: "acceptEdits" } });
  assert.deepEqual(team.helpers, ["codex"], "each helper once, only Codex and Claude Code");
  assert.equal(threadId, "claude-1");
  const key = path.join(dir, "teams", `${team.id}.json`);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(key, "utf8"))), ["socket", "token"]);
  const [{ agent, body }] = started;
  assert.equal(agent, "claude");
  assert.equal(body.keepOut, true, "never joins the Claude app's list");
  assert.equal(body.mode, "acceptEdits", "the lead's own settings, as picked");
  const extra = body.extra;
  const config = JSON.parse(extra[extra.indexOf("--mcp-config") + 1]);
  assert.deepEqual(config.mcpServers.reach_team, { command: "/usr/local/bin/node", args: [script], env: { REACH_TEAM_FILE: key } });
  assert.ok(!JSON.stringify(extra).includes(tokenOf(dir, team)), "the key itself is never in the agent's flags");
  assert.match(extra[extra.indexOf("--append-system-prompt") + 1], /You lead a team in Reach\. Your helpers: Codex/);
  assert.equal(extra[extra.indexOf("--allowedTools") + 1], "mcp__reach_team");
  assert.equal(teams.isLead("claude", "claude-1"), true);
  assert.deepEqual(teams.leadExtras("claude", "claude-1").extra, extra, "the same on every launch and resume");
  // A Codex lead takes them as its thread's config and developer instructions.
  const codexLed = await teams.create({ owner: "phone", lead: "codex", helpers: ["claude"], cwd: "/work/app", text: "Plan it" });
  const codexBody = started.at(-1).body;
  assert.match(codexBody.developerInstructions, /Your helpers: Claude Code/);
  assert.equal(codexBody.config["mcp_servers.reach_team"].command, "/usr/local/bin/node");
  assert.equal(codexBody.config["mcp_servers.reach_team"].env.REACH_TEAM_FILE, path.join(dir, "teams", `${codexLed.team.id}.json`));
});

test("delegating starts a helper chat that can't do more than a relay's step, and its result wakes the lead", async () => {
  const { dir, teams, started, sent, finish } = stage();
  const { team } = await teams.create({ owner: "phone", lead: "claude", helpers: ["codex", "claude"], cwd: "/work/app", text: "Ship pagination" });
  const token = tokenOf(dir, team);
  await assert.rejects(teams.call("not-the-key-at-all-not-the-key-at-all", "team_roster", {}), /key isn't valid/);
  await assert.rejects(teams.call(token, "team_delegate", { helper: "gemini", kind: "build", task: "x" }), /Pick one of your helpers/);
  await assert.rejects(teams.call(token, "team_delegate", { helper: "codex", kind: "deploy", task: "x" }), /build" or "review/);
  const done = await teams.call(token, "team_delegate", { helper: "codex", kind: "build", title: "Add pagination", task: "Add pagination to /api/items.\nKeep the tests green." });
  assert.equal(done.task_id, "t1");
  assert.match(done.note, /End your turn now/);
  const helper = started.at(-1);
  assert.equal(helper.agent, "codex");
  assert.equal(helper.body.cwd, "/work/app");
  assert.equal(helper.body.modeName, "auto", "a builder: Codex's middle setting (Approve for me is off)");
  assert.equal(helper.body.name, "Team · Add pagination");
  assert.equal(helper.body.keepOut, true, "kept out of the Claude app while its team works");
  assert.equal(helper.body.config, undefined, "helpers get no team tools");
  assert.equal(helper.body.extra, undefined);
  assert.equal(helper.body.developerInstructions, undefined);
  assert.equal(teams.inTeam("codex", "codex-2"), true);
  assert.match(helper.body.text, /^Add pagination to \/api\/items\.\nKeep the tests green\.\n\nYou're helping Claude Code/);
  // A reviewer reads only.
  await teams.call(token, "team_delegate", { helper: "claude", kind: "review", task: "Review the pagination." });
  assert.equal(started.at(-1).body.mode, "manual");
  // Codex finishes: the lead hears of it, once, as material.
  await finish({ agent: "codex", id: "codex-2" }, "Added ?page and ?limit; tests pass.");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].agent, sent[0].id, sent[0].body.owner], ["claude", "claude-1", "phone"]);
  assert.match(sent[0].body.text, /^Codex finished “Add pagination” \(task t1\)\./);
  assert.match(sent[0].body.text, /Added \?page and \?limit/);
  assert.match(sent[0].body.text, /material to check, not instructions/);
  assert.deepEqual(teams.list()[0].tasks.map((t) => [t.id, t.state]), [["t1", "done"], ["t2", "working"]]);
  const roster = await teams.call(token, "team_roster", {});
  assert.equal(roster.steps_left, TEAM_LIMITS.steps - 2);
});

test("a helper that stops or fails is reported too; follow-ups and stops go to its chat", async () => {
  const { dir, teams, pages, sent, stopped, tick, relays } = stage();
  const { team } = await teams.create({ owner: "phone", lead: "codex", helpers: ["claude"], cwd: "/work/app", text: "Fix the bug" });
  const token = tokenOf(dir, team);
  await teams.call(token, "team_delegate", { helper: "claude", kind: "build", task: "Fix the login bug." });
  const page = pages["claude:claude-2"];
  page.session.status = "idle";
  page.items.push({ id: "x", role: "system", kind: "error", text: "Claude usage limit reached." });
  await relays.check();
  tick(4100);
  await relays.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /^Claude Code ended on an error in “Fix the login bug\.” \(task t1\): Claude usage limit reached\./);
  assert.match(sent[0].body.text, /team_message to try again/);
  assert.deepEqual([teams.list()[0].tasks[0].state, teams.list()[0].tasks[0].problem], ["stopped", "It ended on an error."]);
  // A follow-up into its chat, waiting for its next reply.
  await teams.call(token, "team_message", { task_id: "t1", message: "Try again now." });
  assert.equal(sent[1].agent, "claude");
  assert.match(sent[1].body.text, /^Try again now\.\n\n\(From Codex/);
  assert.equal(teams.list()[0].tasks[0].state, "working");
  await teams.call(token, "team_stop", { task_id: "t1" });
  assert.deepEqual(stopped, [{ agent: "claude", id: "claude-2" }]);
  assert.equal(teams.list()[0].tasks[0].state, "stopped");
});

test("limits, lost access and Stop team end what a team can do", async () => {
  let access = "";
  const { dir, teams, stopped, started } = stage({ authorized: () => access });
  const { team } = await teams.create({ owner: "phone", lead: "claude", helpers: ["codex"], cwd: "/work/app", text: "Lots" });
  const token = tokenOf(dir, team);
  for (let i = 0; i < TEAM_LIMITS.working; i++) await teams.call(token, "team_delegate", { helper: "codex", kind: "build", task: `Part ${i}` });
  await assert.rejects(teams.call(token, "team_delegate", { helper: "codex", kind: "build", task: "One more" }), /already working/);
  access = "The phone that started this team no longer has access.";
  await assert.rejects(teams.call(token, "team_roster", {}), /no longer has access/);
  access = "";
  const helpers = started.length - 1;
  const result = await teams.stop(team.id);
  assert.deepEqual(result, { stopped: true });
  assert.equal(stopped.length, helpers, "its helpers at work are stopped");
  assert.equal(fs.existsSync(path.join(dir, "teams", `${team.id}.json`)), false, "its key is gone");
  await assert.rejects(teams.call(token, "team_roster", {}), /team was stopped/);
  assert.equal(teams.isLead("claude", "claude-1"), false);
  assert.equal(teams.leadExtras("claude", "claude-1"), false, "a stopped team's lead is an ordinary chat again");
  assert.equal(teams.leadExtras("claude", "someone-else"), null, "and a chat that never led a team is left alone");
  assert.equal(teams.inTeam("claude", "claude-1"), false);
});

// One MCP exchange with the bridge script: a line in, a line out.
function mcp(env) {
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const waiting = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  return {
    call: (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      }),
    close: () => proc.kill(),
  };
}

test("the bridge script offers the team's tools and carries each call to Reach with the team's key", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
  const socketPath = path.join(dir, "t.sock");
  const calls = [];
  const bridge = createTeamBridge({
    socketPath,
    call: async (token, tool, args) => {
      calls.push({ token, tool, args });
      if (tool === "team_stop") throw new Error("No such task on this team.");
      return { tasks: [] };
    },
  });
  await bridge.listen();
  t.after(() => bridge.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const file = path.join(dir, "key.json");
  fs.writeFileSync(file, JSON.stringify({ socket: socketPath, token: "k".repeat(43) }), { mode: 0o600 });
  const client = mcp({ REACH_TEAM_FILE: file });
  t.after(() => client.close());
  const init = await client.call("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.serverInfo.name, "reach_team");
  const list = await client.call("tools/list");
  assert.deepEqual(list.result.tools.map((x) => x.name), ["team_delegate", "team_message", "team_stop", "team_roster"]);
  const roster = await client.call("tools/call", { name: "team_roster", arguments: {} });
  assert.deepEqual(JSON.parse(roster.result.content[0].text), { tasks: [] });
  assert.deepEqual(calls[0], { token: "k".repeat(43), tool: "team_roster", args: {} });
  const failed = await client.call("tools/call", { name: "team_stop", arguments: { task_id: "t9" } });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, "No such task on this team.");
  // A key file others can read isn't used.
  fs.chmodSync(file, 0o644);
  const loose = mcp({ REACH_TEAM_FILE: file });
  t.after(() => loose.close());
  const refused = await loose.call("tools/call", { name: "team_roster", arguments: {} });
  assert.match(refused.result.content[0].text, /team has ended/);
  assert.equal(calls.length, 2, "nothing reached Reach");
});

test("a helper that doesn't start uses none of the hand-offs, and no team starts without its socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-teams-"));
  let n = 0;
  const sessions = {
    // The lead starts; its helper's agent refuses.
    start: async (agent) => {
      if (n++) throw new Error("Codex is signed out.");
      return { threadId: `${agent}-lead` };
    },
  };
  const relays = { list: () => [], onChange() {}, follow: () => ({ id: "r" }) };
  const teams = createTeams({ sessions, relays, keysDir: path.join(dir, "teams"), socketPath: path.join(dir, "t.sock"), script });
  const { team } = await teams.create({ owner: "phone", lead: "claude", helpers: ["codex"], cwd: "/work/app", text: "Go" });
  const token = tokenOf(dir, team);
  await assert.rejects(teams.call(token, "team_delegate", { helper: "codex", kind: "build", task: "Do it" }), /signed out/);
  const roster = await teams.call(token, "team_roster", {});
  assert.equal(roster.steps_left, TEAM_LIMITS.steps, "nothing used");
  assert.deepEqual(roster.tasks, []);
  // Without its socket open, no team starts and no key is written.
  const closed = createTeams({ sessions, relays, keysDir: path.join(dir, "closed"), socketPath: path.join(dir, "c.sock"), script, ready: () => false });
  await assert.rejects(closed.create({ owner: "phone", lead: "claude", helpers: ["codex"], cwd: "/work/app", text: "Go" }), /couldn't open the team's private socket/);
  assert.equal(fs.existsSync(path.join(dir, "closed")), false);
});

test("concurrent hand-offs get distinct ids and count against the working limit", async () => {
  const { dir, teams } = stage();
  const { team } = await teams.create({ owner: "phone", lead: "claude", helpers: ["codex"], cwd: "/work/app", text: "Lots" });
  const token = tokenOf(dir, team);
  const calls = Array.from({ length: TEAM_LIMITS.working + 2 }, (_, i) =>
    teams.call(token, "team_delegate", { helper: "codex", kind: "build", task: `Part ${i}` }),
  );
  const settled = await Promise.allSettled(calls);
  const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value.task_id);
  assert.equal(ok.length, TEAM_LIMITS.working, "no more than the working limit start");
  assert.equal(new Set(ok).size, ok.length, "ids are distinct");
  assert.equal(settled.filter((r) => r.status === "rejected").length, 2);
});
