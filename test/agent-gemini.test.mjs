import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createGeminiSessions, geminiItems, parseGeminiSession } from "../server/agent-sessions/gemini.mjs";

// Gemini CLI sessions in Chat, read from its own files (made-up sessions in
// the shapes Gemini CLI 0.39.1 writes).
const ID = "563e04d4-2c16-49ff-97f7-c9f505e5d346";
const line = (o) => JSON.stringify(o);
const at = (s) => new Date(Date.UTC(2026, 3, 27, 10, 0, s)).toISOString();

test("a .jsonl session: the header, then each message as last written (a message is written again as it changes)", () => {
  const source = [
    line({ sessionId: ID, projectHash: "h", startTime: at(0), lastUpdated: at(0), kind: "main" }),
    line({ id: "m1", timestamp: at(1), type: "user", content: [{ text: "Fix the build" }] }),
    line({ $set: { lastUpdated: at(2) } }),
    line({ id: "m2", timestamp: at(3), type: "gemini", content: "Looking", model: "gemini-3-pro" }),
    "{ torn line",
    line({ id: "m2", timestamp: at(3), type: "gemini", content: "Looking at the build.", model: "gemini-3-pro", toolCalls: [{ id: "t1", name: "run_shell_command", args: { command: "npm run build" }, status: "success", resultDisplay: "ok" }] }),
    line({ $set: { lastUpdated: at(9) } }),
  ].join("\n");
  const { header, messages } = parseGeminiSession(source);
  assert.equal(header.lastUpdated, at(9));
  assert.deepEqual(messages.map((m) => [m.id, textOfContent(m.content)]), [
    ["m1", "Fix the build"],
    ["m2", "Looking at the build."],
  ]);
  assert.equal(messages[1].toolCalls.length, 1);
});
const textOfContent = (c) => (typeof c === "string" ? c : c.map((p) => p.text).join(""));

test("messages read as the chat shows them: what you said (pictures counted), Gemini's answer, its tools as steps", () => {
  const items = geminiItems(
    [
      { id: "u", type: "user", timestamp: at(1), content: [{ text: "Look at this" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      {
        id: "g",
        type: "gemini",
        timestamp: at(2),
        content: "Checking.",
        toolCalls: [
          { id: "a", name: "read_file", args: { absolute_path: "/work/app/src/a.ts" }, status: "success" },
          { id: "b", name: "replace", args: { file_path: "/work/app/src/a.ts" }, status: "success" },
          { id: "c", name: "run_shell_command", args: { command: "npm test" }, status: "error", resultDisplay: "1 failing" },
          { id: "d", name: "grep_search", args: { pattern: "TODO" }, status: "success" },
          { id: "e", name: "google_web_search", args: { query: "vite config" }, status: "success" },
        ],
      },
      { id: "i", type: "info", timestamp: at(3), content: "Request cancelled." },
    ],
    "/work/app",
  );
  assert.deepEqual(
    items.map((i) => `${i.role}:${i.kind}:${i.text}${i.status ? `:${i.status}` : ""}${i.images ? `:${i.images}img` : ""}`),
    [
      "user:text:Look at this:1img",
      "assistant:text:Checking.",
      "tool:tool:Read src/a.ts:completed",
      "tool:file-change:src/a.ts:completed",
      "tool:command:npm test:failed",
      "tool:tool:Search TODO:completed",
      "tool:web:vite config:completed",
      "system:notice:Request cancelled.",
    ],
  );
  assert.equal(items[4].detail, "1 failing");
});

const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-gemini-"));
  const project = "/work/app";
  fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ projects: { [project]: "app" } }));
  const chats = path.join(dir, "tmp", "app", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const hash = crypto.createHash("sha256").update(project).digest("hex");
  // The newer format.
  fs.writeFileSync(
    path.join(chats, `session-2026-04-27T10-00-${ID.slice(0, 8)}.jsonl`),
    [
      line({ sessionId: ID, projectHash: hash, startTime: at(0), lastUpdated: at(0), kind: "main" }),
      line({ id: "m1", timestamp: at(1), type: "user", content: [{ text: "Fix the build\nIt fails on CI" }] }),
      line({ id: "m2", timestamp: at(2), type: "gemini", content: "Fixed it.", model: "gemini-3-pro" }),
      line({ $set: { lastUpdated: at(30) } }),
    ].join("\n") + "\n",
  );
  // The older format.
  fs.writeFileSync(
    path.join(chats, "session-2026-04-09T23-29-95504d29.json"),
    JSON.stringify({ sessionId: "95504d29-0000-4000-8000-000000000000", projectHash: hash, startTime: at(0), lastUpdated: at(5), kind: "main", messages: [{ id: "x", type: "user", content: "Older chat" }] }),
  );
  // Not chats of their own: a sub-agent's, and one never spoken in.
  fs.writeFileSync(path.join(chats, "session-2026-04-10T00-00-aaaaaaaa.jsonl"), line({ sessionId: "aaaaaaaa-0000-4000-8000-000000000000", projectHash: hash, kind: "subagent" }) + "\n" + line({ id: "s", type: "user", content: "x" }) + "\n");
  fs.writeFileSync(path.join(chats, "session-2026-04-10T00-01-bbbbbbbb.jsonl"), line({ sessionId: "bbbbbbbb-0000-4000-8000-000000000000", projectHash: hash, kind: "main" }) + "\n");
  return dir;
};

test("Gemini CLI's sessions are listed with their folder, title, model and time; read in pages; unknown ids refused", async () => {
  const dir = home();
  const gemini = createGeminiSessions({ home: dir, locate: async () => "/opt/homebrew/bin/gemini" });
  const list = (await gemini.list()).sort((a, b) => b.updatedAt - a.updatedAt);
  assert.deepEqual(
    list.map((s) => [s.agent, s.id, s.title, s.cwd, s.model, s.origin]),
    [
      ["gemini", ID, "Fix the build", "/work/app", "gemini-3-pro", "cli"],
      ["gemini", "95504d29-0000-4000-8000-000000000000", "Older chat", "/work/app", null, "cli"],
    ],
  );
  assert.equal(list[0].updatedAt, Date.parse(at(30)));
  assert.equal(list[0].preview, "Fixed it.");
  const page = await gemini.read(ID, { limit: 1 });
  assert.deepEqual(page.items.map((i) => i.text), ["Fixed it."]);
  const older = await gemini.read(ID, { limit: 1, before: page.before });
  assert.deepEqual(older.items.map((i) => i.text), ["Fix the build\nIt fails on CI"]);
  assert.equal(older.before, null);
  assert.equal((await gemini.history(ID)).items.length, 2);
  await assert.rejects(gemini.read("../../etc/passwd"), (e) => e.status === 404);
  await assert.rejects(gemini.read("ffffffff-0000-4000-8000-000000000000"), (e) => e.status === 404);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Gemini CLI's health: installed, and signed in by its own sign-in file or an API key, never reading either", async () => {
  const dir = home();
  const missing = createGeminiSessions({ home: dir, locate: async () => null });
  assert.deepEqual(await missing.health(), { agent: "gemini", installed: false, signedIn: false });
  const out = createGeminiSessions({ home: dir, env: {}, locate: async () => "/bin/gemini" });
  assert.deepEqual(await out.health(), { agent: "gemini", installed: true, signedIn: false, usable: false });
  fs.writeFileSync(path.join(dir, "oauth_creds.json"), "{}");
  assert.equal((await out.health()).signedIn, true);
  assert.equal((await createGeminiSessions({ home: fs.mkdtempSync(path.join(os.tmpdir(), "g-")), env: { GEMINI_API_KEY: "k" }, locate: async () => "/bin/gemini" }).health()).signedIn, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("in Chat: Gemini CLI's chats are listed and read with the others, idle, and replying waits for its host", async () => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const dir = home();
  const sessions = createAgentSessions({
    gemini: createGeminiSessions({ home: dir, locate: async () => "/opt/homebrew/bin/gemini" }),
    codex: { list: async () => [], health: async () => ({ agent: "codex", installed: true, signedIn: true }) },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ agent: "claude", installed: true, signedIn: true }) },
    live: async () => new Map(),
    detect: async () => [{ agent: "gemini", name: "Gemini CLI", installed: true, signedIn: false, supported: false }],
    dataDir: dir,
  });
  const { sessions: list } = await sessions.list();
  assert.deepEqual(list.map((s) => [s.agent, s.id]).slice(0, 1), [["gemini", ID]]);
  const page = await sessions.read("gemini", ID, {});
  assert.deepEqual(page.items.map((i) => i.text), ["Fix the build\nIt fails on CI", "Fixed it."]);
  // Idle; its long poll waits instead of answering at once.
  assert.equal(sessions.view("gemini", ID).status, "idle");
  const started = Date.now();
  await sessions.changes("gemini", ID, sessions.view("gemini", ID).version, 150);
  assert.ok(Date.now() - started >= 140, "held until the wait ends");
  await assert.rejects(sessions.send("gemini", ID, { text: "hi" }), (e) => e.status === 409 && /Gemini CLI no longer answers personal Google accounts/.test(e.message));
  // Supported once Reach finds it installed.
  const gem = (await sessions.health()).find((h) => h.agent === "gemini");
  assert.deepEqual([gem.installed, gem.supported, gem.name], [true, true, "Gemini CLI"]);
  assert.deepEqual(await sessions.models("gemini"), { models: [], modes: [], mode: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Gemini CLI chat continues in Codex with its conversation, shown there as a fork", async () => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const { createCodexLive } = await import("../server/agent-sessions/codex-live.mjs");
  const dir = home();
  const NEW = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const calls = [];
  const daemon = {
    async rpc(method, params) {
      calls.push([method, params]);
      return { "model/list": { data: [{ id: "gpt-6-astra", isDefault: true }] }, "thread/start": { thread: { id: NEW } } }[method] ?? {};
    },
    onNotification() {},
    onRequest() {},
    onClose() {},
    close() {},
  };
  const sessions = createAgentSessions({
    daemon,
    codexLive: createCodexLive({ daemon }),
    gemini: createGeminiSessions({ home: dir, locate: async () => "/opt/homebrew/bin/gemini" }),
    codex: { read: async (id) => ({ session: { agent: "codex", id, title: "", cwd: "/work/app", status: "idle" }, items: [], before: null }), list: async () => [], health: async () => ({ agent: "codex", signedIn: true }) },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ agent: "claude", signedIn: true }) },
    live: async () => new Map(),
    detect: async () => [],
    dataDir: dir,
  });
  assert.deepEqual(await sessions.move("gemini", ID, { to: "codex" }), { agent: "codex", id: NEW });
  assert.deepEqual(
    calls.find(([m]) => m === "thread/inject_items")[1].items.map((i) => i.content[0].text),
    ["Fix the build\nIt fails on CI", "Fixed it."],
  );
  assert.match(calls.find(([m]) => m === "thread/start")[1].developerInstructions, /moved here from Gemini CLI \(“Fix the build”, in \/work\/app\)/);
  const page = await sessions.read("codex", NEW, {});
  assert.deepEqual(page.items.map((i) => i.text).slice(-1), ["Continued with Codex · earlier messages are from Gemini CLI"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
