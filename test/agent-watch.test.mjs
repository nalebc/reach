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
// A file watch can take seconds to report on a loaded runner; success
// still returns the moment it's seen.
const until = async (check, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return true;
  return false;
};

// DIAGNOSTIC CANARY ONLY: fixed fixture metadata, never provider paths/content.
// The source assertions and delivery behavior below remain the AA5 baseline.
function burstTrace() {
  const start = performance.now(), startWallMs = Date.now(), limit = 128;
  const events = [], counters = Object.fromEntries(["stage", "append", "native-enter", "native-exit", "news"].map(kind => [kind, { count: 0, maxGapMs: 0, lastMs: null }]));
  let overwritten = 0;
  return {
    record(kind, values = {}, at = performance.now()) {
      if (!Object.hasOwn(counters, kind)) return;
      const event = { kind, tMs: at - start };
      for (const key of ["stage", "write", "size", "mtimeMs", "exists", "unavailable", "deliveryID", "activeDeliveryID"]) {
        if (typeof values[key] === "number" && Number.isFinite(values[key])) event[key] = values[key];
      }
      if (values.activeDeliveryID === null) event.activeDeliveryID = null;
      for (const [key, allowed] of [
        ["eventType", ["change", "rename", "other"]],
        ["root", ["codex", "claude", "other"]],
        ["category", ["probe", "queue", "history", "transcript", "other"]],
        ["agent", ["codex", "claude", "gemini", "other"]],
        ["newsKind", ["queue", "history", "settings", "rollout", "status", "app", "projects", "other"]],
      ]) if (Object.hasOwn(values, key)) event[key] = allowed.includes(values[key]) ? values[key] : "other";
      const counter = counters[kind];
      if (counter.lastMs !== null) counter.maxGapMs = Math.max(counter.maxGapMs, event.tMs - counter.lastMs);
      counter.lastMs = event.tMs;
      counter.count++;
      if (events.length === limit) { events.shift(); overwritten++; }
      events.push(event);
    },
    report() { return { startWallMs, limit, overwritten, counters: structuredClone(counters), events: structuredClone(events) }; },
  };
}

function retainBurst(t, report) {
  if (process.env.REACH_TEST_WATCH_REPORT) {
    fs.mkdirSync(path.dirname(process.env.REACH_TEST_WATCH_REPORT), { recursive: true });
    fs.appendFileSync(process.env.REACH_TEST_WATCH_REPORT, JSON.stringify(report) + "\n");
  }
  t.diagnostic(JSON.stringify(report));
}

async function nativeBurst(t, mode = "native") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-"));
  const codexHome = path.join(root, "codex");
  const claudeProjects = path.join(root, "claude");
  const trace = burstTrace(), queueFile = path.join(codexHome, "queue_1.sqlite-wal");
  let stage = 0, nextDeliveryID = 0, activeDeliveryID = null;
  const queueMetadata = () => {
    try { const stat = fs.statSync(queueFile); return { exists: 1, size: stat.size, mtimeMs: stat.mtimeMs }; }
    catch { return { exists: 0, unavailable: 1 }; }
  };
  trace.record("stage", { stage });
  fs.mkdirSync(codexHome);
  fs.mkdirSync(path.join(claudeProjects, "-work-app"), { recursive: true });
  // fs.watch returning does not acknowledge native event registration.
  // Observe ignored probe events through the production adapter before the
  // single measured burst, rather than repeat that burst until it passes.
  const probe = ".reach-watch-ready", registered = new Set();
  const nativeWatch = fs.watch;
  fs.watch = (dir, options, listener) => nativeWatch(dir, options, (event, file) => {
    const enteredAt = performance.now(), deliveryID = ++nextDeliveryID, previousDeliveryID = activeDeliveryID;
    activeDeliveryID = deliveryID;
    const name = String(file || ""), metadata = {
      deliveryID,
      eventType: event, root: dir === codexHome ? "codex" : dir === claudeProjects ? "claude" : "other",
      category: name === probe ? "probe" : name === "queue_1.sqlite-wal" ? "queue" : name === "thread_history_1.sqlite-wal" ? "history" : path.basename(name) === `${ID}.jsonl` ? "transcript" : "other",
    };
    trace.record("native-enter", metadata, enteredAt);
    try {
      if (String(file || "") === probe) registered.add(dir);
      listener(event, file);
    } finally {
      trace.record("native-exit", { ...metadata, ...(dir === codexHome && name === "queue_1.sqlite-wal" ? queueMetadata() : {}) });
      activeDeliveryID = previousDeliveryID;
    }
  });
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
  watch.onChange((n) => {
    trace.record("news", { agent: n.agent, newsKind: n.kind, activeDeliveryID });
    news.push(n);
  });
  // after() retains the trace before the original cleanup, even on assertion
  // failure. This is evidence collection; it never repeats a measured write.
  t.after(() => {
    try { retainBurst(t, { schema: 1, mode, stage, debounceMs: 40, node: process.versions.node, ...trace.report() }); }
    finally {
      fs.watch = nativeWatch;
      watch.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  {
    // Readiness consumes the existing queue-news budget; a missing or dead
    // native watcher still fails within 15 seconds.
    const queueDeadline = Date.now() + 15000;
    const roots = [codexHome, claudeProjects];
    for (; registered.size < roots.length && Date.now() < queueDeadline;) {
      for (const dir of roots) if (!registered.has(dir)) fs.appendFileSync(path.join(dir, probe), "x");
      await until(() => registered.size === roots.length, Math.min(20, Math.max(0, queueDeadline - Date.now())));
    }
    assert.equal(registered.size, roots.length, "native fixture watchers acknowledge registration");
    trace.record("stage", { stage: ++stage });
    for (const dir of roots) fs.rmSync(path.join(dir, probe), { force: true });
    // Codex's queue, written three times in a row: said at once, not after
    // a wait, and once more at most for the rest of the burst.
    for (let i = 0; i < 3; i++) {
      fs.appendFileSync(path.join(codexHome, "queue_1.sqlite-wal"), "x");
      const completedAt = performance.now();
      trace.record("append", { write: i, ...queueMetadata() }, completedAt);
    }
    trace.record("stage", { stage: ++stage });
    assert.ok(await until(() => news.some((n) => n.kind === "queue"), Math.max(0, queueDeadline - Date.now())), "queue news");
    trace.record("stage", { stage: ++stage });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(news.filter((n) => n.agent === "codex" && n.kind === "queue").length <= 2);
    trace.record("stage", { stage: ++stage });
    // Its history.
    fs.appendFileSync(path.join(codexHome, "thread_history_1.sqlite-wal"), "y");
    assert.ok(await until(() => news.some((n) => n.agent === "codex" && n.kind === "history")), "history news");
    trace.record("stage", { stage: ++stage });
    // A Claude Code transcript, with its session id.
    fs.appendFileSync(path.join(claudeProjects, "-work-app", `${ID}.jsonl`), "{}\n");
    assert.ok(await until(() => news.some((n) => n.agent === "claude" && n.id === ID)), "Claude news");
    trace.record("stage", { stage: ++stage });
    // Let the recognized write's trailing notification finish before testing unrelated files.
    await new Promise((r) => setTimeout(r, 150));
    // Anything else is no news.
    const before = news.length;
    fs.writeFileSync(path.join(codexHome, "logs_2.sqlite-wal"), "z");
    fs.writeFileSync(path.join(claudeProjects, "-work-app", "notes.txt"), "z");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(news.length, before);
    trace.record("stage", { stage: ++stage });
  }
}
test("a write to the Codex app's queue or history, or to a Claude Code transcript, is news at once; once per burst", nativeBurst);

test("the first native burst waits for registration instead of losing its only notification", async t => {
  // A native watcher may return before its event source is registered. This
  // stand-in drops mutations in that first turn; the files themselves are
  // real, and the production watch/filter/debounce path remains in use.
  const states = [];
  t.mock.method(fs, "watch", (dir, options, listener) => {
    const watcher = new EventEmitter(), state = { dir, options, listener, active: false };
    const registering = setImmediate(() => { state.active = true; });
    watcher.close = () => { clearImmediate(registering); state.active = false; };
    watcher.unref = () => {};
    states.push(state);
    return watcher;
  });
  const notify = file => {
    for (const state of states) {
      const relative = path.relative(state.dir, String(file));
      if (state.active && relative && !relative.startsWith("..") && !path.isAbsolute(relative) &&
          (state.options.recursive || path.dirname(relative) === ".")) state.listener("change", relative);
    }
  };
  for (const method of ["appendFileSync", "writeFileSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => { const result = original(file, ...args); notify(file); return result; });
  }
  await nativeBurst(t, "modeled-registration");
});

for (const spread of [false, true]) {
  test(`[modeled delivery, not native timing] three queue callbacks ${spread ? "span debounce windows" : "arrive together"}`, t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const callbacks = new Map(), news = [], delivered = [];
    let modelMs = 0, deliveryID = 0, activeDeliveryID = null;
    const watcher = createAgentWatch({
      codexHome: "/c", claudeProjects: "/p", claudeSessions: "/s", claudeAppRecords: "/r", geminiHome: "/g", debounceMs: 40,
      watch: (dir, _options, listener) => (callbacks.set(dir, listener), { close() {} }),
    });
    t.after(() => watcher.close());
    watcher.onChange(n => news.push({ modelMs, activeDeliveryID, agent: n.agent, kind: n.kind }));
    const advance = ms => { modelMs += ms; t.mock.timers.tick(ms); };
    const callback = () => {
      activeDeliveryID = ++deliveryID;
      delivered.push({ phase: "enter", modelMs, deliveryID });
      try { callbacks.get("/c")("change", "queue_1.sqlite-wal"); }
      finally { delivered.push({ phase: "exit", modelMs, deliveryID }); activeDeliveryID = null; }
    };
    callback();
    assert.equal(news.length, 1, "the first delivered callback is told immediately");
    if (spread) {
      advance(20); callback();
      assert.equal(news.length, 1);
      advance(20);
      assert.equal(news.length, 2, "one trailing notification for the first delivery window");
      advance(20); callback();
      assert.equal(news.length, 2);
      advance(20);
      assert.equal(news.length, 3, "a later delivery window may legitimately emit again");
    } else {
      callback(); callback();
      assert.equal(news.length, 1);
      advance(39);
      assert.equal(news.length, 1);
      advance(1);
      assert.equal(news.length, 2, "the synchronous delivered burst is told exactly twice");
    }
    advance(40);
    assert.equal(news.length, spread ? 3 : 2, "no extra notification after that delivery window becomes quiet");
    assert.deepEqual(news.map(n => n.activeDeliveryID), spread ? [1, null, null] : [1, null], "only the leading news is emitted inside modeled callback delivery");
    retainBurst(t, { schema: 1, mode: spread ? "modeled-spread" : "modeled-together", debounceMs: 40, delivered, news });
  });
}

test("[diagnostic only] native burst metadata is bounded and cannot retain paths or contents", () => {
  const trace = burstTrace(), secret = "PRIVATE_FIXTURE_MARKER_DO_NOT_RETAIN";
  for (let i = 0; i < 1000; i++) trace.record("native-enter", { eventType: secret, category: secret, path: secret, content: secret, size: i, mtimeMs: Infinity });
  trace.record(secret, { size: 1 });
  const report = trace.report();
  assert.equal(report.events.length, 128);
  assert.equal(report.counters["native-enter"].count, 1000);
  assert.equal(report.overwritten, 872);
  assert.equal(report.events.at(-1).size, 999);
  assert.ok(Number.isFinite(report.counters["native-enter"].maxGapMs));
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(report.events.every(event => !Object.hasOwn(event, "mtimeMs")));
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

for (const windowsPaths of [false, true]) {
test(`Gemini JSON and JSONL writes and project changes wake histories in one burst${windowsPaths ? " (Windows path model)" : ""}`, async t => {
  // Exercise Windows separator handling on every host, through the same
  // production watch/filter/debounce path. No native provider files run.
  if (windowsPaths) t.mock.method(path, "join", path.win32.join);
  const callbacks = new Map(), news = [], geminiHome = "/g";
  const transcripts = path.join(geminiHome, "tmp");
  const watcher = createAgentWatch({
    geminiHome, debounceMs: 20,
    watch: (dir, options, listener) => (callbacks.set(dir, listener), { close() {} }),
  });
  t.after(() => watcher.close());
  watcher.onChange(n => news.push(n));
  callbacks.get(transcripts)("change", path.join("app", "chats", "session-2026-10-08T00-00-11111111.jsonl"));
  assert.deepEqual(news, [{ agent: "gemini", kind: "history" }]);
  callbacks.get(transcripts)("rename", path.join("app", "chats", "session-2026-10-08T00-00-22222222.json"));
  callbacks.get(transcripts)("change", path.join("app", "logs.json"));
  callbacks.get(geminiHome)("change", "oauth_creds.json");
  assert.equal(news.length, 1);
  await new Promise(r => setTimeout(r, 35));
  assert.equal(news.length, 2);
  callbacks.get(geminiHome)("change", "projects.json");
  assert.deepEqual(news.at(-1), { agent: "gemini", kind: "projects" });
});
}

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
