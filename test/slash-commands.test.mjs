import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_COMMANDS, createCodexMethods, createSlashCommands } from "../server/agent-sessions/commands.mjs";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { codexInput, createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { codexItem } from "../server/agent-sessions/codex.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

// "/" in a chat: each agent's own commands, from the agent itself. Claude
// Code lists its own (for the chat's folder); Codex has no such call, so its
// own commands are those whose app-server call the installed Codex answers,
// plus the skills it lists for the chat's folder.
const T = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const C = "11111111-2222-4333-8444-555555555555";
const SKILL = { name: "documents:documents", enabled: true, path: "/Users/me/.codex/skills/documents/SKILL.md", description: "Docs", interface: { displayName: "Documents", shortDescription: "Create and edit Word and Google Docs files" } };
const fakeDaemon = (answers = {}) => {
  const calls = [];
  return {
    calls,
    async rpc(method, params) {
      calls.push([method, params]);
      const a = answers[method];
      if (a instanceof Error) throw a;
      return typeof a === "function" ? a(params) : a ?? {};
    },
    onNotification() {},
    onRequest() {},
    onClose() {},
    close() {},
  };
};
const everything = async () => new Set(CODEX_COMMANDS.flatMap((c) => c.needs).concat("skills/list"));
const codexAdapter = { read: async (id) => ({ session: { agent: "codex", id, cwd: "/work/app", model: "gpt-6-astra", effort: "high", title: "Fix" } }) };

test("Claude Code: what its handshake lists, in the chat's own folder", async () => {
  const asked = [];
  const slash = createSlashCommands({
    claudeHost: {
      commands: async (cwd) => (
        asked.push(cwd),
        [
          { name: "compact", description: "Compact", argumentHint: "<instructions>" },
          { name: "deploy", description: "From this project" },
          { name: "clear", description: "Start a new session with empty context" },
        ]
      ),
    },
    claude: { read: async () => ({ session: { cwd: "/work/app" } }) },
    daemon: fakeDaemon(),
    codexMethods: everything,
  });
  const list = await slash.list("claude", { id: C });
  assert.deepEqual(asked, ["/work/app"]);
  assert.deepEqual(list, [
    { name: "compact", description: "Compact", hint: "<instructions>", action: "insert" },
    { name: "deploy", description: "From this project", hint: "", action: "insert" },
    // It starts another session in the same Claude Code, which the phone
    // wouldn't follow: a new chat instead, as /clear makes.
    { name: "clear", description: "Start a new session with empty context", hint: "", action: "new" },
  ]);
  // Gemini CLI chats are read-only: nothing to run.
  assert.deepEqual(await slash.list("gemini", { id: "g" }), []);
});

test("Codex: only the commands whose call the installed Codex answers, then its skills for the chat's folder", async () => {
  const daemon = fakeDaemon({ "skills/list": () => ({ data: [{ cwd: "/work/app", errors: [], skills: [SKILL, { ...SKILL, name: "off", enabled: false }] }] }) });
  const slash = createSlashCommands({
    daemon,
    codex: codexAdapter,
    // An older Codex without review or fork.
    codexMethods: async () => new Set(["account/rateLimits/read", "thread/compact/start", "thread/name/set", "mcpServerStatus/list", "model/list", "thread/start", "skills/list"]),
  });
  const list = await slash.list("codex", { id: T });
  assert.deepEqual(list.map((c) => c.name), ["status", "compact", "rename", "mcp", "model", "new", "documents:documents"]);
  assert.deepEqual(list.at(-1), { name: "documents:documents", title: "Documents", description: "Create and edit Word and Google Docs files", hint: "", group: "skills", action: "insert" });
  assert.ok(!("path" in list.at(-1)), "a skill's path stays on the Mac");
  assert.deepEqual(daemon.calls.find(([m]) => m === "skills/list")[1], { cwds: ["/work/app"] });
  // Nothing answers: nothing offered.
  const none = createSlashCommands({ daemon: fakeDaemon(), codex: codexAdapter, codexMethods: async () => new Set() });
  assert.deepEqual(await none.list("codex", { id: T }), []);
});

test("which calls Codex answers comes from Codex itself, asked again only when Codex changes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-bin-"));
  const bin = path.join(tmp, "codex");
  fs.writeFileSync(bin, "v1");
  const runs = [];
  const run = async (file, args) => {
    runs.push([file, ...args]);
    const out = args[args.indexOf("--out") + 1];
    fs.writeFileSync(path.join(out, "ClientRequest.json"), JSON.stringify({ oneOf: [{ properties: { method: { enum: ["thread/compact/start"] } } }, { properties: { method: { enum: [`v${runs.length}`] } } }] }));
    return { stdout: "" };
  };
  const methods = createCodexMethods({ locate: async () => bin, run, tmp });
  assert.deepEqual([...(await methods())], ["thread/compact/start", "v1"]);
  await methods();
  assert.equal(runs.length, 1, "kept while Codex is the same");
  assert.deepEqual(runs[0].slice(0, 4), [bin, "app-server", "generate-json-schema", "--out"]);
  assert.deepEqual(fs.readdirSync(tmp), ["codex"], "its description isn't left behind");
  fs.writeFileSync(bin, "v2, updated");
  assert.ok((await methods()).has("v2"), "asked again after an update");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("running: only what the menu offers; Claude Code's go as the message", async () => {
  const slash = createSlashCommands({ daemon: fakeDaemon(), codex: codexAdapter, codexMethods: async () => new Set(["account/rateLimits/read"]) });
  await assert.rejects(slash.run("codex", T, "compact"), (e) => e.status === 404 && /doesn't offer \/compact/.test(e.message));
  await assert.rejects(slash.run("codex", T, "rm -rf"), (e) => e.status === 404);
  await assert.rejects(slash.run("claude", C, "compact"), (e) => e.status === 400);
});

test("/status: the chat, its model and the account's limits, from Codex's own calls", async () => {
  const daemon = fakeDaemon({
    "account/rateLimits/read": { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1760000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } },
    "account/read": { account: { type: "chatgpt", email: "someone@example.invalid", planType: "pro" } },
  });
  const slash = createSlashCommands({ daemon, codex: codexAdapter, codexMethods: everything });
  const { card } = await slash.run("codex", T, "status");
  assert.equal(card.title, "Status");
  assert.deepEqual(card.rows, [
    { label: "Chat", value: T },
    { label: "Folder", value: "/work/app" },
    { label: "Model", value: "gpt-6-astra · high" },
    { label: "Plan", value: "Pro" },
    { label: "5-hour limit", value: "12% used", resetsAt: 1760000000000 },
    { label: "Weekly limit", value: "40% used" },
  ]);
  assert.ok(!JSON.stringify(card).includes("example.invalid"), "the account's email isn't shown");
});

test("/status says why Codex couldn't read the limits (signed out), in Codex's own words", async () => {
  const signedOut = new Error(
    'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"error": {"message": "Your authentication token has been invalidated. Please try signing in again.", "code": "token_invalidated"}}',
  );
  const daemon = fakeDaemon({ "account/rateLimits/read": signedOut, "account/read": { account: { type: "chatgpt", planType: "prolite" } } });
  const slash = createSlashCommands({ daemon, codex: codexAdapter, codexMethods: everything });
  const { card } = await slash.run("codex", T, "status");
  assert.deepEqual(card.rows.slice(-2), [
    { label: "Plan", value: "Pro Lite" },
    { label: "Limits", value: "Codex couldn't read them: Your authentication token has been invalidated. Please try signing in again." },
  ]);
});

test("/rename, /fork and /mcp are Codex's own calls; a fork is left to Codex, not held by Reach", async () => {
  const daemon = fakeDaemon({
    "thread/fork": { thread: { id: "0199cccc-bbbb-7ccc-8ddd-eeeeeeeeeeee" } },
    "mcpServerStatus/list": { data: [{ name: "figma", runtimeStatus: "connected", authStatus: "oAuth", tools: { a: {}, b: {} } }, { name: "linear", authStatus: "notLoggedIn", tools: {} }] },
  });
  const slash = createSlashCommands({ daemon, codex: codexAdapter, codexMethods: everything });
  assert.deepEqual(await slash.run("codex", T, "rename", "  Build fixes "), { ok: true, title: "Build fixes" });
  await assert.rejects(slash.run("codex", T, "rename", ""), /Write the chat's new name/);
  const forked = await slash.run("codex", T, "fork");
  assert.equal(forked.session.id, "0199cccc-bbbb-7ccc-8ddd-eeeeeeeeeeee");
  const { card } = await slash.run("codex", T, "mcp");
  assert.deepEqual(card.rows, [
    { label: "figma", value: "Connected · 2 tools" },
    { label: "linear", value: "Needs sign-in" },
  ]);
  assert.deepEqual(
    daemon.calls.map(([m, p]) => [m, p.threadId]),
    [
      ["thread/name/set", T],
      ["thread/fork", T],
      ["thread/unsubscribe", "0199cccc-bbbb-7ccc-8ddd-eeeeeeeeeeee"],
      ["mcpServerStatus/list", T],
    ],
  );
});

test("/compact and /review run in the chat as a turn does; in a chat the Codex app holds, /compact goes through the app, /review says so", async () => {
  const daemon = fakeDaemon({ "review/start": { turn: { id: "turn-1" }, reviewThreadId: T } });
  const live = createCodexLive({ daemon, queues: false });
  const slash = createSlashCommands({ daemon, codex: codexAdapter, codexLive: live, codexMethods: everything });
  await slash.run("codex", T, "review", "main");
  assert.deepEqual(daemon.calls.slice(0, 2), [
    ["thread/resume", { threadId: T, excludeTurns: true }],
    ["review/start", { threadId: T, target: { type: "baseBranch", branch: "main" }, delivery: "inline" }],
  ]);
  assert.equal(live.view(T).status, "running");
  const held = fakeDaemon({ "thread/resume": new Error("thread already has a live local writer") });
  const compacted = [];
  const desktop = { compact: async (id) => (compacted.push(id), { compacted: true }) };
  const busy = createSlashCommands({ daemon: held, codex: codexAdapter, codexLive: createCodexLive({ daemon: held, queues: false, desktop }), codexMethods: everything });
  await busy.run("codex", T, "compact");
  assert.deepEqual(compacted, [T], "as the Codex app's own /compact");
  assert.ok(!held.calls.some(([m]) => m === "thread/compact/start"));
  await assert.rejects(busy.run("codex", T, "review", "main"), (e) => e.status === 409 && /Codex app has this chat open/.test(e.message));
});

test("a skill goes with the message as Codex's skill input; its path is Codex's, never the phone's", async () => {
  assert.deepEqual(codexInput({ text: "Write notes", skill: { name: "documents:documents", path: SKILL.path } }), [
    { type: "skill", name: "documents:documents", path: SKILL.path },
    { type: "text", text: "Write notes", text_elements: [] },
  ]);
  const daemon = fakeDaemon({
    "skills/list": { data: [{ cwd: "/work/app", errors: [], skills: [SKILL] }] },
    "turn/start": { turn: { id: "turn-1" } },
  });
  const sessions = createAgentSessions({
    daemon,
    codex: { ...codexAdapter, list: async () => [], health: async () => ({ agent: "codex", signedIn: true }) },
    codexLive: createCodexLive({ daemon, queues: false }),
    claude: { list: async () => [], health: async () => ({ agent: "claude", signedIn: true }) },
    live: async () => new Map(),
    detect: async () => [],
    slash: createSlashCommands({ daemon, codex: codexAdapter, codexMethods: everything }),
  });
  await sessions.send("codex", T, { text: "Write notes", images: [], skill: "documents:documents", path: "/etc/passwd" });
  const started = daemon.calls.find(([m]) => m === "turn/start")[1];
  assert.deepEqual(started.input[0], { type: "skill", name: "documents:documents", path: SKILL.path });
  await assert.rejects(sessions.send("codex", T, { text: "x", images: [], skill: "nope" }), (e) => e.status === 404);
  sessions.close?.();
});

test("in the chat: a skill shows by its name (it isn't an image); a review shows where it began and what it found", () => {
  const item = codexItem({ item: { id: "u", type: "userMessage", content: [{ type: "skill", name: "documents:documents", path: "/x" }, { type: "text", text: "Write notes" }] } });
  assert.deepEqual([item.text, item.skills, item.images], ["Write notes", ["documents:documents"], undefined]);
  assert.equal(codexItem({ item: { id: "r1", type: "enteredReviewMode", review: "changes" } }).text, "Code review started");
  assert.deepEqual(
    (({ role, kind, text }) => ({ role, kind, text }))(codexItem({ item: { id: "r2", type: "exitedReviewMode", review: "No issues found." } })),
    { role: "assistant", kind: "text", text: "No issues found." },
  );
});

test("Claude Code's slash commands in a chat: the command as typed and what it printed (the output used to vanish)", () => {
  const at = "2026-10-05T19:00:00.000Z";
  const lines = [
    { type: "user", uuid: "m", parentUuid: null, isMeta: true, timestamp: at, message: { role: "user", content: "<local-command-caveat>Caveat: …</local-command-caveat>" } },
    { type: "user", uuid: "c", parentUuid: "m", timestamp: at, message: { role: "user", content: "<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>" } },
    { type: "system", subtype: "local_command", uuid: "o", parentUuid: "c", timestamp: at, isMeta: false, level: "info", content: "<local-command-stdout>## Context Usage\n\n**Tokens:** 26.4k / 200k (13%)</local-command-stdout>" },
  ];
  const view = parseClaudeTranscript(lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.deepEqual(
    view.items.map(({ role, kind, text, slash }) => ({ role, kind, text, ...(slash ? { slash } : {}) })),
    [
      { role: "user", kind: "text", text: "/context", slash: true },
      { role: "system", kind: "output", text: "## Context Usage\n\n**Tokens:** 26.4k / 200k (13%)" },
    ],
  );
  // With words after it, and a chat that goes on after the command.
  const more = [
    ...lines.slice(0, 2).map((l) => (l.uuid === "c" ? { ...l, message: { role: "user", content: "<command-name>/rename</command-name><command-message>rename</command-message><command-args>Auth work</command-args>" } } : l)),
    { type: "system", subtype: "local_command", uuid: "o", parentUuid: "c", timestamp: at, content: "<local-command-stdout>Session renamed to: Auth work</local-command-stdout>" },
    { type: "user", uuid: "n", parentUuid: "o", timestamp: at, message: { role: "user", content: "Thanks" } },
  ];
  const next = parseClaudeTranscript(more.map((l) => JSON.stringify(l)).join("\n"));
  assert.deepEqual(next.items.map((i) => i.text), ["/rename Auth work", "Session renamed to: Auth work", "Thanks"]);
});

test("/fork from a chosen message forks through its turn", async () => {
  const daemon = fakeDaemon({ "thread/fork": { thread: { id: "0199bbbb-cccc-7ddd-8eee-ffffffffffff" } } });
  const slash = createSlashCommands({ daemon, codex: { ...codexAdapter, read: async (id) => ({ session: { agent: "codex", id } }) }, codexLive: createCodexLive({ daemon, queues: false }), codexMethods: everything });
  const r = await slash.run("codex", T, "fork", "turn-0199-abcd");
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/fork")[1], { threadId: T, excludeTurns: true, lastTurnId: "turn-0199-abcd" });
  assert.equal(r.session.id, "0199bbbb-cccc-7ddd-8eee-ffffffffffff");
  // Typed words after /fork aren't a turn: the whole chat.
  await slash.run("codex", T, "fork", "please");
  assert.deepEqual(daemon.calls.filter(([m]) => m === "thread/fork")[1][1], { threadId: T, excludeTurns: true });
});
