import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
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
  // Isolate every provider root: native Claude activity must not enter this
  // fixture through the registry/app-record defaults on the test machine.
  const watch = createAgentWatch({
    codexHome,
    claudeProjects,
    claudeSessions: path.join(root, "claude-sessions"),
    claudeAppRecords: path.join(root, "claude-app-records"),
    geminiHome: path.join(root, "gemini"),
    debounceMs: 40,
  });
  const news = [];
  watch.onChange((n) => news.push(n));
  try {
    // Codex's queue, written three times in a row: said at once, not after
    // a wait, and once more at most for the rest of the burst.
    for (let i = 0; i < 3; i++) fs.appendFileSync(path.join(codexHome, "queue_1.sqlite-wal"), "x");
    assert.ok(await until(() => news.some((n) => n.kind === "queue")), "queue news");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(news.filter((n) => n.agent === "codex" && n.kind === "queue").length <= 2);
    // Its history.
    fs.appendFileSync(path.join(codexHome, "thread_history_1.sqlite-wal"), "y");
    assert.ok(await until(() => news.some((n) => n.agent === "codex" && n.kind === "history")), "history news");
    // A Claude Code transcript, with its session id.
    fs.appendFileSync(path.join(claudeProjects, "-work-app", `${ID}.jsonl`), "{}\n");
    assert.ok(await until(() => news.some((n) => n.agent === "claude" && n.id === ID)), "Claude news");
    // Let the recognized write's trailing notification finish before testing unrelated files.
    await new Promise((r) => setTimeout(r, 150));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-missing-"));
  try {
    const watch = createAgentWatch({
      codexHome: path.join(root, "codex"),
      claudeProjects: path.join(root, "claude"),
      claudeSessions: path.join(root, "claude-sessions"),
      claudeAppRecords: path.join(root, "claude-app-records"),
      geminiHome: path.join(root, "gemini"),
    });
    watch.onChange(() => {});
    watch.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript write is news the moment it happens, not after a wait; writes during the next moment are told once more", async () => {
  const listeners = new Map();
  const watch = createAgentWatch({
    codexHome: "/c",
    claudeProjects: "/p",
    claudeSessions: "/s",
    claudeAppRecords: "/r",
    watch: (dir, options, listener) => (listeners.set(dir, listener), { close() {} }),
    debounceMs: 60,
  });
  const news = [];
  watch.onChange((n) => news.push(n));
  const write = () => listeners.get("/p")("change", `-work-app/${ID}.jsonl`);
  write();
  // Told at once (it used to wait 120 ms after the last write of a burst).
  assert.equal(news.length, 1);
  write();
  write();
  assert.equal(news.length, 1);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(news.length, 2, "the rest of the burst, once");
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(news.length, 2);
  write();
  assert.equal(news.length, 3, "a quiet moment later: at once again");
  watch.close();
});

test("the Codex app saving its choices (the permission mode it's in) is news", () => {
  const listeners = new Map();
  const watch = createAgentWatch({
    codexHome: "/c",
    claudeProjects: "/p",
    claudeSessions: "/s",
    claudeAppRecords: "/r",
    watch: (dir, options, listener) => (listeners.set(dir, listener), { close() {} }),
  });
  const news = [];
  watch.onChange((n) => news.push(n));
  listeners.get("/c")("change", ".codex-global-state.json");
  assert.deepEqual(news, [{ agent: "codex", kind: "settings" }]);
  watch.close();
});

test("Gemini JSON and JSONL writes and project changes wake histories in one burst", async () => {
  const callbacks = new Map(), news = [];
  const watcher = createAgentWatch({
    geminiHome: "/g", debounceMs: 20,
    watch: (dir, options, listener) => (callbacks.set(dir, listener), { close() {} }),
  });
  watcher.onChange(n => news.push(n));
  callbacks.get("/g/tmp")("change", "app/chats/session-2026-10-08T00-00-11111111.jsonl");
  assert.deepEqual(news, [{ agent: "gemini", kind: "history" }]);
  callbacks.get("/g/tmp")("rename", "app/chats/session-2026-10-08T00-00-22222222.json");
  callbacks.get("/g/tmp")("change", "app/logs.json");
  callbacks.get("/g")("change", "oauth_creds.json");
  assert.equal(news.length, 1);
  await new Promise(r => setTimeout(r, 35));
  assert.equal(news.length, 2);
  callbacks.get("/g")("change", "projects.json");
  assert.deepEqual(news.at(-1), { agent: "gemini", kind: "projects" });
  watcher.close();
});

test("a folder that appears after Reach starts (an agent installed later) is watched once it's there", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-"));
  const claudeProjects = path.join(root, "claude");
  const watch = createAgentWatch({
    codexHome: path.join(root, "codex"),
    claudeProjects,
    claudeSessions: path.join(root, "claude-sessions"),
    claudeAppRecords: path.join(root, "claude-app-records"),
    geminiHome: path.join(root, "gemini"),
    debounceMs: 40,
    retryMs: 50,
  });
  const news = [];
  watch.onChange((n) => news.push(n));
  try {
    fs.mkdirSync(path.join(claudeProjects, "-work-app"), { recursive: true });
    // A transcript grows line by line: keep writing until the watch, which
    // starts on its next retry and (on Linux) then reaches the new folder,
    // reports it. A slow runner took longer than one fixed wait.
    const heard = () => news.some((n) => n.agent === "claude" && n.id === ID);
    for (const end = Date.now() + 5000; !heard() && Date.now() < end; ) {
      fs.appendFileSync(path.join(claudeProjects, "-work-app", `${ID}.jsonl`), "{}\n");
      await until(heard, 250);
    }
    assert.ok(heard(), "Claude news");
  } finally {
    watch.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing-root watcher that fails silently is retried after an agent is installed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-silent-"));
  const claudeProjects = path.join(root, "claude");
  const nativeWatch = fs.watch;
  // Node 24's Linux recursive watcher can return an inert watcher for a
  // missing root, with neither a synchronous exception nor an error event.
  t.mock.method(fs, "watch", (dir, options, listener) =>
    fs.existsSync(dir) ? nativeWatch(dir, options, listener) : { close() {}, unref() {}, on() {} },
  );
  const watch = createAgentWatch({
    codexHome: path.join(root, "codex"),
    claudeProjects,
    claudeSessions: path.join(root, "claude-sessions"),
    claudeAppRecords: path.join(root, "claude-app-records"),
    geminiHome: path.join(root, "gemini"),
    debounceMs: 40,
    retryMs: 50,
  });
  const news = [];
  watch.onChange(n => news.push(n));
  try {
    fs.mkdirSync(path.join(claudeProjects, "-work-app"), { recursive: true });
    const heard = () => news.some(n => n.agent === "claude" && n.id === ID);
    for (const end = Date.now() + 3000; !heard() && Date.now() < end;) {
      fs.appendFileSync(path.join(claudeProjects, "-work-app", `${ID}.jsonl`), "{}\n");
      await until(heard, 100);
    }
    assert.ok(heard(), "the installed agent's transcript wakes its chat");
  } finally {
    watch.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const replacement of ["remove and recreate", "move away", "atomic replacement"]) {
  test(`transcript watching recovers after provider root ${replacement}`, { skip: replacement === "atomic replacement" && process.platform === "win32" }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-replace-"));
    const projects = path.join(root, "projects"), old = path.join(root, "old"), next = path.join(root, "next");
    const transcript = dir => path.join(dir, "project", `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(transcript(projects)), { recursive: true });
    const news = [];
    const watcher = createAgentWatch({
      codexHome: path.join(root, "codex"), claudeProjects: projects,
      claudeSessions: path.join(root, "sessions"), claudeAppRecords: path.join(root, "records"),
      geminiHome: path.join(root, "gemini"), retryMs: 50, debounceMs: 20,
    });
    watcher.onChange(n => news.push(n));
    const writeUntilHeard = async () => {
      for (const end = Date.now() + 3000; !news.some(n => n.id === ID) && Date.now() < end;) {
        fs.appendFileSync(transcript(projects), "{}\n");
        await until(() => news.some(n => n.id === ID), 100);
      }
      assert.ok(news.some(n => n.id === ID), "the current provider root wakes its chat");
    };
    try {
      await writeUntilHeard();
      if (replacement === "move away") {
        fs.renameSync(projects, old);
        await new Promise(r => setTimeout(r, 100));
        news.length = 0;
        const privateId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        fs.writeFileSync(path.join(old, "project", `${privateId}.jsonl`), "{}\n");
        await new Promise(r => setTimeout(r, 100));
        assert.ok(!news.some(n => n.id === privateId), "a moved-away root emits no stale transcript news");
        fs.mkdirSync(path.dirname(transcript(projects)), { recursive: true });
      } else if (replacement === "atomic replacement") {
        fs.rmSync(path.join(projects, "project"), { recursive: true });
        fs.mkdirSync(path.dirname(transcript(next)), { recursive: true });
        fs.renameSync(next, projects);
      } else {
        fs.rmSync(projects, { recursive: true });
        await new Promise(r => setTimeout(r, 100));
        fs.mkdirSync(path.dirname(transcript(projects)), { recursive: true });
      }
      await new Promise(r => setTimeout(r, 100));
      news.length = 0;
      await writeUntilHeard();
    } finally {
      watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("one failed watcher gets one retry, and closing cancels every pending retry", async () => {
  const calls = new Map(), watchers = new Map();
  const watch = createAgentWatch({
    codexHome: "/c", claudeProjects: "/p", claudeSessions: "/s", claudeAppRecords: "/r", geminiHome: "/g",
    retryMs: 40,
    watch: dir => {
      calls.set(dir, (calls.get(dir) || 0) + 1);
      const watcher = new EventEmitter();
      watcher.close = () => watcher.emit("error", Error("late close error"));
      watchers.set(dir, watcher);
      return watcher;
    },
  });
  const failed = watchers.get("/p");
  failed.emit("error", Error("folder changed"));
  failed.emit("error", Error("duplicate error"));
  assert.ok(await until(() => calls.get("/p") === 2));
  assert.equal(calls.get("/p"), 2);
  watchers.get("/p").emit("error", Error("changed again"));
  watch.close();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(calls.get("/p"), 2, "close cancels the retry");
});

test("a queued root event after close cannot emit errors or transcript news", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-closed-"));
  let callback;
  t.mock.method(fs, "watch", (_dir, _options, listener) => {
    callback = listener;
    const watcher = new EventEmitter();
    watcher.close = () => {};
    return watcher;
  });
  const watcher = createAgentWatch({
    codexHome: path.join(root, "codex"), claudeProjects: root,
    claudeSessions: path.join(root, "sessions"), claudeAppRecords: path.join(root, "records"),
    geminiHome: path.join(root, "gemini"), retryMs: 40,
  });
  const news = [];
  watcher.onChange(n => news.push(n));
  watcher.close();
  fs.rmSync(root, { recursive: true, force: true });
  assert.doesNotThrow(() => callback("rename", `${ID}.jsonl`));
  assert.deepEqual(news, []);
});
