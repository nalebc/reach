import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { codexItem, codexSession } from "../server/agent-sessions/codex.mjs";
import {
  claudeProcesses,
  elapsedSeconds,
  matchClaude,
  parseLsofCwd,
  parsePs,
} from "../server/agent-sessions/processes.mjs";
import { createAgentSessions, nativeLink } from "../server/agent-sessions/index.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const line = (o) => JSON.stringify(o);
const at = (s) => new Date(Date.UTC(2026, 9, 4, 10, 0, s)).toISOString();

// A synthetic transcript with every shape seen in real Claude Code files.
function transcript() {
  const base = { sessionId: ID, cwd: "/work/app", gitBranch: "main", entrypoint: "cli" };
  return [
    line({ type: "queue-operation", operation: "enqueue", sessionId: ID, timestamp: at(0) }),
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix the login bug" } }),
    // Superseded: the person edited their next message, so this branch is gone.
    line({ ...base, type: "assistant", uuid: "old", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "OLD BRANCH" }] } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(3), message: { content: [{ type: "text", text: "Looking." }] } }),
    // Two parallel tool calls; the first result branches off the chain.
    line({ ...base, type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: at(4), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
    line({ ...base, type: "assistant", uuid: "a3", parentUuid: "a2", timestamp: at(5), message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/work/app/src/login.ts" } }] } }),
    line({ ...base, type: "user", uuid: "r1", parentUuid: "a2", timestamp: at(6), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 failing" }] } }),
    line({ ...base, type: "user", uuid: "r2", parentUuid: "a3", timestamp: at(7), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }),
    // Typed while the turn ran.
    line({ ...base, type: "attachment", uuid: "q1", parentUuid: "r2", timestamp: at(2), attachment: { type: "queued_command", prompt: "also check signup", humanTurn: true } }),
    line({ ...base, type: "attachment", uuid: "q2", parentUuid: "q1", timestamp: at(8), attachment: { type: "queued_command", prompt: "internal", humanTurn: false } }),
    line({ ...base, type: "user", uuid: "m1", parentUuid: "q2", timestamp: at(9), isMeta: true, message: { content: "meta" } }),
    // Compaction: a new root that continues the old chain logically.
    line({ ...base, type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: null, logicalParentUuid: "m1", timestamp: at(10) }),
    line({ ...base, type: "user", uuid: "s1", parentUuid: "c1", timestamp: at(11), isCompactSummary: true, message: { content: "summary of earlier work" } }),
    line({ ...base, type: "assistant", uuid: "a4", parentUuid: "s1", timestamp: at(12), message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Done: login fixed." }] } }),
    line({ type: "custom-title", customTitle: "Login fix", sessionId: ID }),
    '{"type":"assistant","uuid":"torn"', // a torn final line while writing
  ].join("\n");
}

test("Claude transcripts read as the conversation a person saw", () => {
  const r = parseClaudeTranscript(transcript());
  assert.equal(r.title, "Login fix");
  assert.equal(r.cwd, "/work/app");
  assert.equal(r.gitBranch, "main");
  const view = r.items.map((i) => `${i.role}:${i.kind}:${i.text}${i.queued ? ":queued" : ""}${i.status ? `:${i.status}` : ""}`);
  assert.deepEqual(view, [
    "user:text:Fix the login bug",
    "assistant:text:Looking.",
    "tool:command:npm test:completed",
    "tool:file-change:src/login.ts:completed",
    "user:text:also check signup:queued",
    "system:compaction:Context compacted",
    "assistant:text:Done: login fixed.",
  ]);
  assert.equal(r.items[2].detail, "1 failing", "parallel result attached by tool_use_id");
  assert.ok(!view.some((v) => v.includes("OLD BRANCH")), "superseded branch dropped");
  assert.equal(r.firstAt, Date.parse(at(0)));
});

test("Claude sessions list transcripts, map app records, page and reject unknown ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  const projects = path.join(root, "projects", "-work-app");
  const records = path.join(root, "records", "acct", "org");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), transcript());
  await fs.writeFile(path.join(projects, "22222222-2222-4222-8222-222222222222.jsonl"), line({ type: "queue-operation" }));
  await fs.writeFile(path.join(records, `local_${ID}.json`), JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, title: "From the app", isArchived: false, cwd: "/work/app" }));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  const list = await claude.list();
  assert.equal(list.length, 1, "empty transcripts are left out");
  assert.equal(list[0].title, "From the app");
  assert.equal(list[0].inApp, true);
  assert.equal(list[0].appSessionId, `local_${ID}`);
  const page = await claude.read(ID, { limit: 3 });
  assert.equal(page.items.length, 3);
  const older = await claude.read(ID, { limit: 3, before: page.before });
  assert.ok(!older.items.some((i) => page.items.some((j) => j.id === i.id)));
  await assert.rejects(() => claude.read("../../etc/passwd"), (e) => e.status === 404);
  await fs.rm(root, { recursive: true, force: true });
});

test("Claude sign-in status: signed out exits 1 with JSON on stdout", async () => {
  const signedOut = createClaudeSessions({
    run: async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stdout: '{"loggedIn":false}' });
    },
  });
  assert.deepEqual(await signedOut.health(), { agent: "claude", installed: true, signedIn: false, usable: false });
  const signedIn = createClaudeSessions({ run: async () => ({ stdout: '{"loggedIn":true}' }) });
  assert.equal((await signedIn.health()).signedIn, true);
  const missing = createClaudeSessions({
    run: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });
  assert.equal((await missing.health()).installed, false);
});

test("live Claude processes map to sessions, skipping the app's wrapper", () => {
  assert.equal(elapsedSeconds("05:24:59"), 5 * 3600 + 24 * 60 + 59);
  assert.equal(elapsedSeconds("1-00:00:10"), 86410);
  assert.equal(elapsedSeconds("03:21"), 201);
  const now = Date.parse("2026-10-04T12:00:00Z");
  const ps = [
    "  100     1 05:00:00 ??       /Applications/Claude.app/Contents/MacOS/Claude",
    `  200   100 01:00:00 ??       /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --resume=${ID}`,
    `  201   200 01:00:00 ??       /Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --output-format stream-json --effort xhigh --model claude-opus-5-5 --resume=${ID} --permission-mode auto`,
    "  300   100 00:10:00 ??       /Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --output-format stream-json",
    "  400   399 00:05:00 ttys004  claude",
    "  500     1 00:01:00 ??       /usr/bin/claudette --resume=99999999-9999-4999-8999-999999999999",
  ].join("\n");
  const procs = claudeProcesses(parsePs(ps, now));
  assert.deepEqual(procs.map((p) => [p.pid, p.host, p.sessionId]), [
    [201, "claude-app", ID],
    [300, "claude-app", null],
    [400, "terminal", null],
  ]);
  const fresh = "33333333-3333-4333-8333-333333333333";
  const cwds = parseLsofCwd("p300\nfcwd\nn/work/app\np400\nfcwd\nn/elsewhere\n");
  const starts = [
    { id: fresh, cwd: "/work/app", firstAt: now - 600000 + 1000 },
    { id: "44444444-4444-4444-8444-444444444444", cwd: "/work/app", firstAt: now - 60000 },
  ];
  const live = matchClaude(procs, cwds, starts);
  // The settings the app started it with come along.
  assert.deepEqual(live.get(ID), {
    where: "claude-app",
    pid: 201,
    tty: null,
    exact: true,
    model: "claude-opus-5-5",
    effort: "xhigh",
    mode: "auto",
  });
  assert.deepEqual(
    [live.get(fresh).model, live.get(fresh).effort, live.get(fresh).mode],
    [null, null, null],
  );
  assert.equal(live.get(fresh)?.pid, 300, "first entry 1 s after the process started");
  assert.ok(!live.has("44444444-4444-4444-8444-444444444444"), "started too long after any process");
  assert.equal(live.size, 2);
});

test("Codex threads and items normalize; approvals read as waiting", () => {
  const s = codexSession({ id: ID, name: null, preview: "Fix login\nmore", cwd: "/w", originator: "Codex Desktop", updatedAt: 10, createdAt: 5, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  assert.equal(s.title, "Fix login");
  assert.equal(s.origin, "app");
  assert.equal(s.status, "waiting");
  assert.equal(s.updatedAt, 10000);
  assert.equal(codexSession({ id: ID, status: { type: "active", activeFlags: [] } }).status, "running");
  assert.equal(codexSession({ id: ID, status: { type: "notLoaded" } }).status, "idle");
  assert.equal(codexItem({ item: { type: "reasoning", id: "r" } }), null);
  assert.deepEqual(
    codexItem({ item: { type: "commandExecution", id: "c", command: "npm test", aggregatedOutput: "x", exitCode: 1, status: "completed" } }),
    { id: "c", role: "tool", kind: "command", text: "npm test", detail: "x", status: "failed", at: undefined, turnId: undefined },
  );
  assert.equal(codexItem({ item: { type: "userMessage", id: "u", content: [{ type: "text", text: "hi" }] } }).text, "hi");
  assert.equal(codexItem({ item: { type: "fileChange", id: "f", changes: [{ path: "a.ts", diff: "+1" }], status: "completed" } }).text, "a.ts");
});

test("native links open the right app, only for valid ids", () => {
  assert.equal(nativeLink({ agent: "codex", id: ID }), `codex://threads/${ID}`);
  assert.equal(nativeLink({ agent: "claude", id: ID, appSessionId: `local_${ID}` }), `claude://code/continue?session=local_${ID}`);
  assert.equal(nativeLink({ agent: "claude", id: ID }), `claude://resume?session=${ID}`);
  assert.equal(nativeLink({ agent: "claude", id: "x&y" }), null);
  assert.equal(nativeLink({ agent: "codex", id: "../x" }), null);
});

test("the merged list sorts, marks live sessions and survives one agent failing", async () => {
  const sessions = createAgentSessions({
    codex: { list: async () => { throw new Error("daemon down"); }, health: async () => ({ agent: "codex", signedIn: true }) },
    claude: {
      list: async () => [
        { agent: "claude", id: "a", updatedAt: 1 },
        { agent: "claude", id: "b", updatedAt: 2 },
      ],
      starts: async () => [],
      health: async () => ({ agent: "claude", signedIn: false }),
    },
    live: async () => new Map([["a", { where: "terminal", pid: 9 }]]),
    detect: async () => [{ agent: "gemini", name: "Gemini CLI", installed: true, signedIn: false, supported: false }],
  });
  const { sessions: list, errors } = await sessions.list();
  assert.deepEqual(list.map((s) => s.id), ["b", "a"]);
  assert.equal(list[1].live.where, "terminal");
  assert.equal(errors.codex, "daemon down");
  // The two Reach drives, then the others found on the Mac.
  assert.deepEqual(
    (await sessions.health()).map((h) => [h.agent, h.name, h.supported]),
    [
      ["codex", "Codex", true],
      ["claude", "Claude Code", true],
      ["gemini", "Gemini CLI", false],
    ],
  );
});

test("session routes are owner-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-sessions-"));
  const opened = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [{ agent: "codex", id: ID }], errors: {} }),
      health: async () => [{ agent: "codex", signedIn: true }],
      read: async (agent, id) => ({ session: { agent, id }, items: [], before: null }),
      openInApp: async (agent, id) => (opened.push([agent, id]), { opened: agent }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const call = (route, token, method = "GET") =>
    fetch(url + route, { method, headers: { Authorization: `Bearer ${token || ""}` } });
  try {
    assert.equal((await call("/api/sessions")).status, 401);
    assert.equal((await call("/api/sessions", agent.token)).status, 403);
    assert.equal((await call("/api/SESSIONS", agent.token)).status, 403);
    const list = await call("/api/sessions", owner.token);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).sessions[0].id, ID);
    assert.equal((await call("/api/sessions/health", owner.token)).status, 200);
    assert.equal((await call(`/api/sessions/codex/${ID}`, owner.token)).status, 200);
    assert.equal((await call(`/api/sessions/codex/${ID}/open`, agent.token, "POST")).status, 403);
    assert.equal((await call(`/api/sessions/codex/${ID}/open`, owner.token, "POST")).status, 200);
    assert.deepEqual(opened, [["codex", ID]]);
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude Code's own registry says which process holds a session and whether it's busy", async () => {
  const { readSessionRegistry } = await import("../server/agent-sessions/processes.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-registry-"));
  const write = (pid, record) => fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...record }));
  try {
    await write(11, { sessionId: "app-busy", entrypoint: "claude-desktop", kind: "interactive", status: "busy", hostSessionId: "local_1" });
    await write(12, { sessionId: "app-idle", entrypoint: "claude-desktop", kind: "interactive", status: "idle" });
    await write(13, { sessionId: "term", entrypoint: "cli", kind: "interactive", status: "idle" });
    await write(14, { sessionId: "gone", entrypoint: "cli", kind: "interactive", status: "idle" });
    await fs.writeFile(path.join(dir, "15.json"), "{ half written");
    await fs.writeFile(path.join(dir, "11.abc.key"), "secret");
    const found = readSessionRegistry({ dir, alive: (pid) => pid !== 14 });
    assert.deepEqual(Object.fromEntries(found), {
      "app-busy": { where: "claude-app", pid: 11, tty: null, exact: true, busy: true, appSessionId: "local_1" },
      "app-idle": { where: "claude-app", pid: 12, tty: null, exact: true, busy: false },
      term: { where: "terminal", pid: 13, tty: null, exact: true, busy: false },
    });
    assert.deepEqual([...readSessionRegistry({ dir: path.join(dir, "missing") })], []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
