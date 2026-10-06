import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentWatch } from "../server/agent-sessions/agent-watch.mjs";

// News the moment an agent's app writes it: the Codex app's databases (its
// queue, its history) and Claude Code's transcripts, each burst told once.
const ID = "11111111-2222-4333-8444-555555555555";
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return true;
  return false;
};

test("a write to the Codex app's queue or history, or to a Claude Code transcript, is news at once; once per burst", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-"));
  const codexHome = path.join(root, "codex");
  const claudeProjects = path.join(root, "claude");
  fs.mkdirSync(codexHome);
  fs.mkdirSync(path.join(claudeProjects, "-work-app"), { recursive: true });
  const watch = createAgentWatch({ codexHome, claudeProjects, debounceMs: 40 });
  const news = [];
  watch.onChange((n) => news.push(n));
  try {
    // Codex's queue, written three times in a row: said once.
    for (let i = 0; i < 3; i++) fs.appendFileSync(path.join(codexHome, "queue_1.sqlite-wal"), "x");
    assert.ok(await until(() => news.some((n) => n.kind === "queue")), "queue news");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(news.filter((n) => n.agent === "codex" && n.kind === "queue").length, 1);
    // Its history.
    fs.appendFileSync(path.join(codexHome, "thread_history_1.sqlite-wal"), "y");
    assert.ok(await until(() => news.some((n) => n.agent === "codex" && n.kind === "history")), "history news");
    // A Claude Code transcript, with its session id.
    fs.appendFileSync(path.join(claudeProjects, "-work-app", `${ID}.jsonl`), "{}\n");
    assert.ok(await until(() => news.some((n) => n.agent === "claude" && n.id === ID)), "Claude news");
    // Anything else is no news.
    const before = news.length;
    fs.writeFileSync(path.join(codexHome, "logs_2.sqlite-wal"), "z");
    fs.writeFileSync(path.join(claudeProjects, "-work-app", "notes.txt"), "z");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(news.length, before);
  } finally {
    watch.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an agent that isn't installed is simply not watched", () => {
  const watch = createAgentWatch({ codexHome: "/nonexistent/codex", claudeProjects: "/nonexistent/claude" });
  watch.onChange(() => {});
  watch.close();
});
