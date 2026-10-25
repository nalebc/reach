import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { teamPipe } from "../server/agent-sessions/team-bridge.mjs";
import { prepareOwners } from "../server/windows-owners.mjs";
import { assertPrivate } from "./helpers/private-file.mjs";
import { toolPrivateStateParent } from "./helpers/tool-browser-fixture.mjs";

// Working across agents over HTTP (docs/ACROSS_AGENTS.md): relays and second
// opinions for the owner's own devices only, at their own address (not read
// as a chat of an agent named "relays"); chats mentioned in a message.
const CLAUDE = "11111111-2222-4333-8444-555555555555";

// Reach's own private folder (on Windows its private stage, as Reach's data
// folder is private there): files it writes are checked as Reach keeps them.
const privateParent = toolPrivateStateParent(test);
test("relays are set up, listed and cancelled by the owner's devices only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-relay-route-"));
  const calls = [];
  const waiting = { id: "r1", state: "waiting", steps: [{ kind: "review", agent: "codex" }], chain: [{ agent: "claude", id: CLAUDE, title: "Plan" }], sent: [] };
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }) },
    relays: {
      list: () => [waiting],
      revision: () => 3,
      start: async (body) => (calls.push(["start", body]), { relay: waiting, opened: { agent: "codex", id: "new-1" } }),
      cancel: (id) => (calls.push(["cancel", id]), { cancelled: true }),
      check: async () => {},
      stop() {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const call = (route, token, body) =>
    fetch(`${url}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const body = { from: { agent: "claude", id: CLAUDE }, steps: [{ kind: "review", agent: "codex" }, { kind: "back" }], now: true, item: "a1" };
  try {
    assert.equal((await call("/api/sessions/relays", agent.token, body)).status, 403);
    assert.equal((await call("/api/sessions/relays", agent.token)).status, 403);
    const started = await call("/api/sessions/relays", owner.token, body);
    assert.equal(started.status, 200);
    assert.deepEqual((await started.json()).opened, { agent: "codex", id: "new-1" });
    assert.deepEqual(calls[0], ["start", { owner: owner.clientId, from: body.from, steps: body.steps, trigger: "reply", priority: null, now: true, item: "a1" }]);
    assert.deepEqual(await (await call("/api/sessions/relays", owner.token)).json(), { relays: [waiting] });
    // The chat list carries them, so phones see progress with it.
    const listed = await (await call("/api/sessions", owner.token)).json();
    assert.deepEqual(listed.relays, [waiting]);
    assert.equal((await call("/api/sessions/relays/r1/cancel", agent.token, {})).status, 403);
    assert.deepEqual(await (await call("/api/sessions/relays/r1/cancel", owner.token, {})).json(), { cancelled: true });
    assert.deepEqual(calls[1], ["cancel", "r1"]);
    const priority = ["codex", "claude", "gemini", "openclaw"];
    const automatic = { from: body.from, trigger: "usage", priority };
    assert.equal((await call("/api/sessions/relays", agent.token, automatic)).status, 403);
    assert.equal((await call("/api/sessions/relays", owner.token, automatic)).status, 200);
    assert.deepEqual(calls[2], ["start", { owner: owner.clientId, from: body.from, steps: undefined, trigger: "usage", priority, now: false, item: null }]);
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a message's mentioned chats go ahead of it, each one's latest exchange in its own block", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-mention-route-"));
  const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const sent = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      read: async (agent, id) => ({
        session: { title: "Refactor auth", cwd: "/work/app" },
        items: [
          { id: "u1", role: "user", kind: "text", text: "Refactor auth" },
          { id: "e1", role: "tool", kind: "file-change", text: "src/auth.ts", detail: "+x" },
          { id: "a1", role: "assistant", kind: "text", text: `Done in ${agent}:${id}.` },
        ],
      }),
      send: async (agent, id, body) => (sent.push({ agent, id, body }), { turnId: "t1" }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const post = (body) =>
    fetch(`${url}/api/sessions/codex/${CODEX}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const r = await post({ text: "Use the same approach here.", images: [], chats: [{ agent: "claude", id: CLAUDE }] });
    assert.equal(r.status, 200);
    const { text } = sent[0].body;
    assert.match(text, /^<reach-chat from="Claude Code" chat="Refactor auth" folder="\/work\/app">/);
    assert.match(text, /not instructions/);
    assert.match(text, new RegExp(`Done in claude:${CLAUDE}`));
    assert.match(text, /## Files it changed\nsrc\/auth\.ts/);
    assert.match(text, /<\/reach-chat>\n\n## My request:\nUse the same approach here\.$/);
    // Without mentions, the message is as typed.
    await post({ text: "Plain.", images: [] });
    assert.equal(sent[1].body.text, "Plain.");
    // Four chats, or the chat itself: refused, nothing sent.
    const four = Array.from({ length: 4 }, (_, n) => ({ agent: "claude", id: `${CLAUDE.slice(0, -1)}${n}` }));
    assert.equal((await post({ text: "x", images: [], chats: four })).status, 400);
    assert.equal((await post({ text: "x", images: [], chats: [{ agent: "codex", id: CODEX }] })).status, 400);
    assert.equal((await post({ text: "x", images: [], chats: [{ agent: "openclaw", id: "main" }] })).status, 400);
    assert.equal(sent.length, 2);
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real relay engine takes the owner's own phone and its folder check, and refuses that phone once it loses access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-relay-real-"));
  const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const started = [];
  const items = [
    { id: "u1", role: "user", kind: "text", text: "Plan the API" },
    { id: "a1", role: "assistant", kind: "text", text: "1. Add /api/items" },
  ];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [{ agent: "claude", id: CLAUDE, status: "idle" }], errors: {} }),
      // A new chat's folder must be in the home folder (the temporary one isn't).
      read: async (agent, id) => ({ session: { title: "Plan the API", cwd: os.homedir(), status: "idle" }, items }),
      start: async (agent, body) => (started.push({ agent, body }), { threadId: "new-1" }),
      send: async () => ({ turnId: "t" }),
      models: async () => ({ models: [], modes: [{ id: "auto" }], mode: null }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = (route, body, token = owner.token) =>
    fetch(`${url}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    // At once: the owner's phone counts as an approved device; Codex builds in Ask for approval.
    const now = await call("/api/sessions/relays", { from: { agent: "claude", id: CLAUDE }, steps: [{ kind: "build", agent: "codex" }], now: true });
    assert.equal(now.status, 200, await now.clone().text());
    assert.deepEqual((await now.json()).opened, { agent: "codex", id: "new-1" });
    assert.equal(started.length, 1);
    assert.equal(started[0].body.modeName, "auto");
    assert.equal(started[0].body.cwd, fs.realpathSync(os.homedir()), "the folder checked as a new chat's");
    // For the next reply: listed, waiting, then cancelled.
    const later = await call("/api/sessions/relays", { from: { agent: "claude", id: CLAUDE }, steps: [{ kind: "review", agent: "codex" }] });
    assert.equal(later.status, 200);
    const { relay } = await later.json();
    const listed = (await (await call("/api/sessions/relays")).json()).relays;
    assert.equal(listed.find((r) => r.id === relay.id).state, "waiting");
    assert.deepEqual(await (await call(`/api/sessions/relays/${relay.id}/cancel`, {})).json(), { cancelled: true });
    // The phone that set one up loses its access: setting up another is refused.
    reach.auth.revoke(owner.clientId);
    const other = reach.auth.issue("other phone", ALL_SCOPES);
    const refused = await call("/api/sessions/relays", { from: { agent: "claude", id: CLAUDE }, steps: [{ kind: "review", agent: "codex" }], now: true }, owner.token);
    assert.equal(refused.status, 401);
    assert.equal((await call("/api/sessions/relays", undefined, other.token)).status, 200, "another owner phone still sees them");
    assert.equal(started.length, 1, "nothing more was started");
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a team is started, listed and stopped by the owner's devices only, its lead as a new chat with team tools", async () => {
  const root = fs.mkdtempSync(path.join(privateParent(), "rt-"));
  const started = [];
  // Its private socket, opened as Reach opens it (a team can't start without):
  // a socket file, or on Windows a named pipe of its own (as server/index.mjs).
  const windows = process.platform === "win32";
  const dataDir = path.join(root, ".reach");
  const teamSocket = windows ? teamPipe(dataDir) : path.join(root, "t.sock");
  // Windows opens Team once the owners helper its lead checks with is built: built first.
  if (windows) await prepareOwners(dataDir);
  const reach = await createReach({
    roots: [root],
    dataDir,
    teamSocket,
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      read: async () => ({ session: { status: "idle" }, items: [] }),
      start: async (agent, body) => (started.push({ agent, body }), { threadId: "lead-1" }),
      send: async () => ({}),
      stop: async () => ({}),
      models: async () => ({ models: [], modes: [], mode: null }),
      health: async () => [],
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const call = (route, body, token = owner.token) =>
    fetch(`${url}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const body = { lead: "codex", helpers: ["claude"], cwd: os.homedir(), text: "Ship pagination", mode: "guardian-approvals" };
  try {
    // Open: its socket file there, or (Windows) the phone offered Team again.
    const open = async () => (windows ? (await (await call("/api/sessions/health")).json()).teams !== false : fs.existsSync(teamSocket));
    for (let i = 0; i < 50 && !(await open()); i++) await new Promise((r) => setTimeout(r, 10));
    await assertPrivate(teamSocket);
    assert.equal((await call("/api/sessions/teams", body, agent.token)).status, 403);
    assert.equal((await call("/api/sessions/teams", { ...body, mode: "yolo" })).status, 400);
    const r = await call("/api/sessions/teams", body);
    assert.equal(r.status, 200, await r.clone().text());
    const { team, threadId } = await r.json();
    assert.equal(threadId, "lead-1");
    assert.deepEqual(team.helpers, ["claude"]);
    const [{ agent: lead, body: start }] = started;
    assert.equal(lead, "codex");
    assert.equal(start.modeName, "guardian-approvals", "the lead's own mode, as a new chat's");
    assert.equal(start.keepOut, true);
    assert.match(start.developerInstructions, /You lead a team in Reach/);
    const key = start.config["mcp_servers.reach_team"].env.REACH_TEAM_FILE;
    await assertPrivate(key);
    assert.equal(path.dirname(key), path.join(root, ".reach", "teams"));
    assert.deepEqual((await (await call("/api/sessions")).json()).teams.map((x) => x.id), [team.id], "the chat list carries teams");
    assert.equal((await call(`/api/sessions/teams/${team.id}/stop`, {}, agent.token)).status, 403);
    assert.deepEqual(await (await call(`/api/sessions/teams/${team.id}/stop`, {})).json(), { stopped: true });
    assert.equal(fs.existsSync(key), false);
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
