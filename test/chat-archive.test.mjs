import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { createCodexSessions } from "../server/agent-sessions/codex.mjs";

// Archiving a chat from Reach lands in its own app, so the app and Reach show
// the same: the Claude app's record of it, Codex's own archive.
const ID = "11111111-2222-4333-8444-555555555555";
const CLI_ONLY = "22222222-3333-4444-8555-666666666666";
const at = new Date().toISOString();
const said = (id) =>
  [
    { type: "user", uuid: "u1", timestamp: at, cwd: "/work/app", sessionId: id, message: { role: "user", content: "Build the login page" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at, cwd: "/work/app", sessionId: id, message: { role: "assistant", content: [{ type: "text", text: "Built it." }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

test("archiving a Claude app chat sets the app's own record, and the list follows; one only Claude Code has can't be", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-archive-"));
  const projects = path.join(root, "projects", "-work-app");
  const records = path.join(root, "records", "acct", "org");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), said(ID));
  await fs.writeFile(path.join(projects, `${CLI_ONLY}.jsonl`), said(CLI_ONLY));
  const record = path.join(records, `local_${ID}.json`);
  const kept = { sessionId: `local_${ID}`, cliSessionId: ID, title: "From the app", isArchived: false, cwd: "/work/app", permissionMode: "auto" };
  await fs.writeFile(record, JSON.stringify(kept), { mode: 0o600 });
  const originalMode = (await fs.stat(record)).mode & 0o777;
  if (process.platform !== "win32") assert.equal(originalMode, 0o600, "POSIX fixture starts private");
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  assert.equal((await claude.list()).find((s) => s.id === ID).archived, false);

  assert.deepEqual(await claude.archive(ID), { archived: true });
  const written = JSON.parse(await fs.readFile(record, "utf8"));
  assert.deepEqual(written, { ...kept, isArchived: true }, "only isArchived changes");
  assert.equal((await fs.stat(record)).mode & 0o777, originalMode, "its host-supported permission bits are kept");
  assert.deepEqual((await fs.readdir(records)).sort(), [`local_${ID}.json`], "no temporary file left");
  assert.equal((await claude.list()).find((s) => s.id === ID).archived, true);

  await claude.archive(ID, false);
  assert.equal(JSON.parse(await fs.readFile(record, "utf8")).isArchived, false);
  assert.equal((await claude.list()).find((s) => s.id === ID).archived, false);

  await assert.rejects(() => claude.archive(CLI_ONLY), (e) => e.status === 409 && /Claude app/.test(e.message));
  await assert.rejects(() => claude.archive("../../etc"), (e) => e.status === 404);
  await fs.rm(root, { recursive: true, force: true });
});

// The Claude app reads its records when it opens: the record and its list of
// archived chats both say so, for its next launch.
test("archiving a Claude app chat sets its record and the app's list of archived chats", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-archive-open-"));
  const projects = path.join(root, "projects", "-work-app");
  const records = path.join(root, "records", "acct", "org");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), said(ID));
  const record = path.join(records, `local_${ID}.json`);
  const index = path.join(records, "archived-sessions.idx");
  await fs.writeFile(record, JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, isArchived: false }));
  await fs.writeFile(index, JSON.stringify({ v: 1, archived: ["local_other"] }));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });

  await claude.archive(ID);
  assert.equal(JSON.parse(await fs.readFile(record, "utf8")).isArchived, true);
  assert.deepEqual(JSON.parse(await fs.readFile(index, "utf8")), { v: 1, archived: ["local_other", `local_${ID}`] });
  // Already archived: nothing to do.
  assert.deepEqual(await claude.archive(ID), { archived: true });

  await claude.archive(ID, false);
  assert.deepEqual(JSON.parse(await fs.readFile(index, "utf8")), { v: 1, archived: ["local_other"] });
  assert.deepEqual((await fs.readdir(records)).sort(), ["archived-sessions.idx", `local_${ID}.json`], "no temporary file left");
  await fs.rm(root, { recursive: true, force: true });
});

test("archiving a Codex chat uses Codex's own archive (and unarchive)", async () => {
  const calls = [];
  const daemon = {
    on() {},
    rpc: async (method, params) => {
      calls.push([method, params]);
      return {};
    },
  };
  const codex = createCodexSessions({ daemon, holder: async () => null, appState: () => ({ threads: {} }), runningElsewhere: (s) => s });
  const thread = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  assert.deepEqual(await codex.archive(thread), { archived: true });
  await codex.archive(thread, false);
  assert.deepEqual(calls, [
    ["thread/archive", { threadId: thread }],
    ["thread/unarchive", { threadId: thread }],
  ]);
  await assert.rejects(() => codex.archive("nope"), (e) => e.status === 404);
});

test("renaming a Claude chat writes Claude Code's own title line, and the Claude app's record when it lists the chat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-rename-"));
  const projects = path.join(root, "projects", "-work-app");
  const records = path.join(root, "records", "acct", "org");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), said(ID));
  await fs.writeFile(path.join(projects, `${CLI_ONLY}.jsonl`), said(CLI_ONLY));
  const record = path.join(records, `local_${ID}.json`);
  const kept = { sessionId: `local_${ID}`, cliSessionId: ID, title: "From the app", isArchived: false, cwd: "/work/app", permissionMode: "auto" };
  await fs.writeFile(record, JSON.stringify(kept), { mode: 0o600 });
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });

  assert.deepEqual(await claude.rename(ID, "  Login\npage  "), { title: "Login page" });
  const lines = (await fs.readFile(path.join(projects, `${ID}.jsonl`), "utf8")).trim().split("\n");
  assert.deepEqual(JSON.parse(lines.at(-1)), { type: "custom-title", customTitle: "Login page", sessionId: ID });
  assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), { ...kept, title: "Login page", titleSource: "user" });
  // One only Claude Code has: its transcript alone.
  await claude.rename(CLI_ONLY, "CLI chat");
  assert.equal((await claude.read(CLI_ONLY, { limit: 1 })).session.title, "CLI chat");
  await assert.rejects(() => claude.rename(ID, "   "), (e) => e.status === 400);
  await assert.rejects(() => claude.rename("33333333-4444-4555-8666-777777777777", "x"), (e) => e.status === 404);
  await fs.rm(root, { recursive: true, force: true });
});

test("deleting a Claude chat moves its transcript and the app's record to the Trash; while the Claude app lists it, it's deleted there", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-delete-"));
  const projects = path.join(root, "projects", "-work-app");
  const records = path.join(root, "records", "acct", "org");
  const trash = path.join(root, "Trash");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), said(ID));
  await fs.writeFile(path.join(projects, `${CLI_ONLY}.jsonl`), said(CLI_ONLY));
  await fs.writeFile(path.join(records, `local_${ID}.json`), JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, isArchived: false }));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  await assert.rejects(() => claude.remove(ID, { appOpen: true, trash }), (e) => e.status === 409 && /delete it there/.test(e.message));
  assert.deepEqual(await claude.remove(ID, { appOpen: false, trash }), { deleted: true });
  assert.deepEqual(await fs.readdir(projects), [`${CLI_ONLY}.jsonl`]);
  assert.deepEqual(await fs.readdir(records), []);
  const kept = await fs.readdir(trash);
  assert.equal(kept.length, 2, "both still in the Trash");
  assert.ok(kept.some((f) => f.startsWith(ID) && f.endsWith(".jsonl")));
  // Only Claude Code has it: deleted while the app is open too.
  assert.deepEqual(await claude.remove(CLI_ONLY, { appOpen: true, trash }), { deleted: true });
  await assert.rejects(() => claude.remove(ID, { trash }), (e) => e.status === 404);
  await fs.rm(root, { recursive: true, force: true });
});
