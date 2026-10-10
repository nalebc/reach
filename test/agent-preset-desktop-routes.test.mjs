import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { presetFixture, privateIngressTest, apps } from "./helpers/preset-fixture.mjs";

// The Mac behind the preset routes: screen, input, open, apps, shell and file
// changes, with the native layer replaced by stand-ins that record what they
// were asked. Nothing touches this computer's screen or keyboard.
const { chrome, onePassword, messages } = apps;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
function stand() {
  const log = [];
  let busy = null;
  const extras = {
    screenshot: async (client, authorize, options) => { authorize(); log.push(["shot", client.id, options.maxWidth]); return { jpeg, width: 100, height: 60, hidden: 1 }; },
    front: async (client, authorize) => { authorize(); return { app: "Google Chrome", bundle: "com.google.Chrome", title: "Amazon", terminalLike: false, secure: false, blocked: "", holder: "" }; },
    act: async (client, action, authorize) => {
      authorize(); log.push(["act", client.id, action]);
      if (busy && busy !== client.id) throw Object.assign(Object.assign(Error("Muse is using the Mac right now."), { status: 409 }), { kind: "busy", holder: "Muse", retryInMs: 1200 });
      busy = client.id;
      return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" };
    },
    open: async (client, app, authorize) => { authorize(); log.push(["open", client.id, app]); return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }; },
    openUrl: async (client, url, browser, authorize) => { authorize(); log.push(["open-url", client.id, url, browser]); return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }; },
    elements: async (client, authorize) => { authorize(); return { snapshot: "s1", app: "Google Chrome", title: "Uber Eats", truncated: false,
      items: [{ n: 1, role: "TextField", name: "Search", value: "diapers", x: 0.3, y: 0.1, w: 0.2, h: 0.02 }, { n: 2, role: "Button", name: "Add to cart", x: 0.5, y: 0.5, w: 0.05, h: 0.02 }],
      texts: [{ text: "Pampers Swaddlers", heading: true, x: 0.1, y: 0.5, w: 0.2, h: 0.02 }, { text: "$34.99", x: 0.1, y: 0.53, w: 0.05, h: 0.02 }] }; },
    activity: () => ({ holder: busy ? { clientId: busy, name: "Muse" } : null, agents: busy ? { [busy]: { at: 1, kind: "click", app: "Google Chrome", bundle: "com.google.Chrome", name: "Muse" } } : {}, paused: [...paused] }),
    setPaused: (id, value) => { if (value) paused.add(id); else paused.delete(id); return paused.has(id); },
  };
  const paused = new Set();
  return { extras, log };
}

test("screen, input, open and the app list follow the preset", privateIngressTest, async (t) => {
  const { extras, log } = stand();
  const runs = [];
  const f = await presetFixture(t, { desktopExtras: extras, agentShellRun: async (input) => { runs.push(input); return { output: `ran: ${input.command}\n`, exitCode: 0, timedOut: false }; } });
  const full = await f.join({ preset: "full", hidden: [{ id: messages.id }] });
  const shot = await full.as("/api/browser/desktop/screen?maxWidth=800");
  assert.equal(shot.status, 200, JSON.stringify(shot.body));
  assert.deepEqual(log[0], ["shot", full.created.clientId, 800]);
  const front = await full.as("/api/browser/desktop/front");
  assert.equal(front.body.app, "Google Chrome");
  const clicked = await full.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 0.5, y: 0.5 } } });
  assert.equal(clicked.status, 200, JSON.stringify(clicked.body));
  assert.equal(clicked.body.app, "Google Chrome");
  assert.equal((await full.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 0.5, y: 0.5 }, extra: 1 } })).status, 400);
  const listed = await full.as("/api/browser/desktop/apps");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const names = listed.body.apps.map((app) => app.name);
  assert.ok(names.includes("Google Chrome") && names.includes("Notes") && names.includes("Terminal"));
  assert.ok(!names.includes("1Password"), "always protected apps are not offered");
  assert.ok(!names.includes("Messages"), "the owner's hidden apps are not offered");
  assert.equal(listed.body.apps.find((app) => app.name === "Terminal").runsCommands, true);
  const opened = await full.as("/api/browser/desktop/open", { method: "POST", body: { app: chrome.id } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(log.at(-1), ["open", full.created.clientId, chrome.id]);
  // Another agent while Muse holds the Mac: told who, and for how long.
  const grok = await f.join({ name: "Grok", preset: "apps", apps: [{ id: chrome.id }] });
  const waiting = await grok.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 0.1, y: 0.1 } } });
  assert.equal(waiting.status, 409, JSON.stringify(waiting.body));
  assert.deepEqual(waiting.body, { error: "Muse is using the Mac right now.", kind: "busy", holder: "Muse", retryInMs: 1200 });
  const grokApps = await grok.as("/api/browser/desktop/apps");
  assert.deepEqual(grokApps.body.apps, [{ id: chrome.id, name: "Google Chrome", bundleId: "com.google.Chrome", running: true }]);
  // The owner sees who is on the Mac.
  const sessions = await f.call("/api/browser/agents");
  const muse = sessions.body.agents.find((agent) => agent.id === full.created.clientId);
  assert.equal(muse.preset, "full"); assert.equal(muse.holdsMac, true); assert.equal(muse.using.app, "Google Chrome");
  assert.equal(sessions.body.agents.find((agent) => agent.id === grok.created.clientId).holdsMac, false);
  // The owner pauses one agent from the list; agents can't pause anyone.
  const pausedNow = await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: full.created.clientId, paused: true } });
  assert.deepEqual(pausedNow.body, { clientId: full.created.clientId, paused: true });
  assert.equal((await f.call("/api/browser/agents")).body.agents.find((agent) => agent.id === full.created.clientId).paused, true);
  assert.equal((await full.as("/api/browser/agents/pause", { method: "POST", body: { clientId: grok.created.clientId, paused: true } })).status, 403);
  assert.equal((await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: "nope", paused: true } })).status, 404);
  assert.equal((await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: full.created.clientId, paused: false } })).body.paused, false);
  // Read only looks but never touches.
  const ro = await f.join({ name: "Watcher", preset: "readonly" });
  assert.equal((await ro.as("/api/browser/desktop/screen")).status, 200);
  assert.equal((await ro.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 0.5, y: 0.5 } } })).status, 403);
  assert.equal((await ro.as("/api/browser/desktop/open", { method: "POST", body: { app: chrome.id } })).status, 403);
  assert.equal((await ro.as("/api/browser/desktop/apps")).status, 403);
  // The shell: logged, refused by the deny list, with history.
  const ran = await full.as("/api/browser/shell", { method: "POST", body: { command: "ls -la", root: 0, cwd: "Desktop" } });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.status, "executed"); assert.equal(ran.body.output, "ran: ls -la\n");
  assert.equal(runs[0].cwd, path.join(f.home, "Desktop"));
  const refused = await full.as("/api/browser/shell", { method: "POST", body: { command: "sudo ls", root: 0, cwd: "" } });
  assert.equal(refused.body.status, "blocked"); assert.match(refused.body.error, /needs your password/);
  assert.equal(runs.length, 1);
  assert.equal((await full.as("/api/browser/shell", { method: "POST", body: { command: "ls", root: 0, cwd: ".reach" } })).status, 403, "private folders are not working folders");
  const history = await full.as("/api/browser/shell/history");
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.map((item) => item.status).sort(), ["blocked", "executed"]);
  assert.equal((await grok.as("/api/browser/shell", { method: "POST", body: { command: "ls", root: 0, cwd: "" } })).status, 403);
  const owner = await f.call("/api/agents/browser-terminal-history");
  assert.ok(owner.body.some((item) => item.action.type === "shell" && item.action.command === "sudo ls" && item.status === "blocked"));
});

test("agents open apps by name and websites in the owner's browser, and read the screen as text", privateIngressTest, async (t) => {
  const { extras, log } = stand();
  const f = await presetFixture(t, { desktopExtras: extras });
  const full = await f.join({ preset: "full", hidden: [{ id: messages.id }] });
  const byName = await full.as("/api/browser/desktop/open", { method: "POST", body: { app: "google chrome" } });
  assert.equal(byName.status, 200, JSON.stringify(byName.body));
  assert.deepEqual(log.at(-1), ["open", full.joined.clientId, chrome.id]);
  assert.equal((await full.as("/api/browser/desktop/open", { method: "POST", body: { app: "1Password" } })).status, 404, "protected apps have no name to open");
  assert.equal((await full.as("/api/browser/desktop/open", { method: "POST", body: { app: "Messages" } })).status, 404, "hidden apps neither");
  const site = await full.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://www.ubereats.com", browser: "Google Chrome" } });
  assert.equal(site.status, 200, JSON.stringify(site.body));
  assert.deepEqual(log.at(-1), ["open-url", full.joined.clientId, "https://www.ubereats.com", chrome.id]);
  assert.equal((await full.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://x.test", extra: 1 } })).status, 400);
  const described = await full.as("/api/browser/desktop/describe");
  assert.equal(described.status, 200);
  assert.match(described.body.screenText, /^Google Chrome — Uber Eats/);
  assert.match(described.body.screenText, /\[1\] TextField "Search" = "diapers"/);
  assert.match(described.body.screenText, /# Pampers Swaddlers {3}\[2\] Button "Add to cart"/, "text and controls share their row, left to right");
  const readonly = await f.join({ preset: "readonly" });
  assert.equal((await readonly.as("/api/browser/desktop/describe")).status, 403, "describing is for agents that may act");
  assert.equal((await readonly.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://x.test" } })).status, 403);
});

test("file changes: Full control writes directly inside shared folders, never into private files; Read only cannot", privateIngressTest, async (t) => {
  const f = await presetFixture(t, { desktopExtras: stand().extras });
  const full = await f.join({ preset: "full" });
  const change = (body, as = full.as) => as("/api/browser/files/change", { method: "POST", body });
  let result = await change({ op: "write", root: 0, path: "Desktop/Project/notes.txt", content: "hello" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fs.readFileSync(path.join(f.home, "Desktop", "Project", "notes.txt"), "utf8"), "hello");
  result = await change({ op: "mkdir", root: 0, path: "Desktop/Project/out" });
  assert.equal(result.status, 200);
  assert.ok(fs.statSync(path.join(f.home, "Desktop", "Project", "out")).isDirectory());
  result = await change({ op: "cp", root: 0, path: "Desktop/Project/notes.txt", to: "Desktop/Project/out/copy.txt" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  result = await change({ op: "rm", root: 0, path: "Desktop/Project/notes.txt" });
  assert.equal(result.status, 200);
  assert.ok(!fs.existsSync(path.join(f.home, "Desktop", "Project", "notes.txt")));
  for (const body of [
    { op: "write", root: 0, path: ".ssh/authorized_keys", content: "x" },
    { op: "write", root: 0, path: "../outside.txt", content: "x" },
    { op: "write", root: 0, path: "/etc/hosts", content: "x" },
    { op: "rm", root: 0, path: ".zshrc" },
  ]) {
    const refused = await change(body);
    assert.ok([403, 404].includes(refused.status), `${JSON.stringify(body)} -> ${refused.status} ${JSON.stringify(refused.body)}`);
  }
  assert.equal((await change({ op: "write", root: 0, path: "a.txt", content: "x", nope: 1 })).status, 400);
  assert.equal((await change({ op: "move", root: 0, path: "a.txt" })).status, 400);
  assert.ok([400, 413].includes((await change({ op: "write", root: 0, path: "a.txt", content: "x".repeat(1048577) })).status), "content over 1 MiB");
  assert.equal((await change({ op: "write", root: 0, path: ".ssh/known_hosts", content: "x" })).status, 403);
  assert.equal(fs.readFileSync(path.join(f.home, ".ssh", "id_rsa"), "utf8"), "secret");
  fs.symlinkSync("/etc", path.join(f.home, "Desktop", "Project", "link"));
  assert.equal((await change({ op: "write", root: 0, path: "Desktop/Project/link/hosts", content: "x" })).status, 403, "no writing through links");
  const ro = await f.join({ name: "Watcher", preset: "readonly" });
  assert.equal((await change({ op: "write", root: 0, path: "Desktop/Project/x.txt", content: "x" }, ro.as)).status, 403);
  const reader = await f.join({ name: "Reader", preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] });
  assert.equal((await change({ op: "write", root: 0, path: "x.txt", content: "x" }, reader.as)).status, 403, "Files without editing");
});

test("Files with editing changes files through the sandboxed helper", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await presetFixture(t, { desktopExtras: stand().extras });
  const editor = await f.join({ name: "Editor", preset: "files", folders: [{ root: 0, path: "Desktop/Project" }], write: true });
  const change = (body) => editor.as("/api/browser/files/change", { method: "POST", body });
  let result = await change({ op: "write", root: 0, path: "draft.md", content: "# Draft\n" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fs.readFileSync(path.join(f.home, "Desktop", "Project", "draft.md"), "utf8"), "# Draft\n");
  result = await change({ op: "write", root: 0, path: "draft.md", content: "# Draft 2\n" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fs.readFileSync(path.join(f.home, "Desktop", "Project", "draft.md"), "utf8"), "# Draft 2\n");
  assert.equal((await change({ op: "mkdir", root: 0, path: "notes" })).status, 200);
  assert.equal((await change({ op: "cp", root: 0, path: "draft.md", to: "notes/draft.md" })).status, 200);
  assert.equal((await change({ op: "rm", root: 0, path: "draft.md" })).status, 200);
  assert.ok(!fs.existsSync(path.join(f.home, "Desktop", "Project", "draft.md")));
  assert.ok(fs.existsSync(path.join(f.home, "Desktop", "Project", "notes", "draft.md")));
  assert.equal((await change({ op: "write", root: 0, path: "../escape.txt", content: "x" })).status, 403);
  assert.equal((await change({ op: "write", root: 0, path: ".git/config", content: "x" })).status, 403);
  const read = await editor.as("/api/files/text?root=0&path=notes/draft.md");
  assert.equal(read.status, 200);
});


test("desktop helper failures preserve 503 and bounded diagnostics across every desktop route", privateIngressTest, async t => {
  const extras = stand().extras;
  let failure = null, calls = 0;
  // All OS calls stay inert. Admission and HTTP authorization use the real server.
  extras.catalog = async authorize => { authorize(); return Object.values(apps); };
  for (const method of ["screenshot", "front", "catalog", "act", "open"]) {
    const original = extras[method];
    extras[method] = async (...args) => {
      if (failure) { calls++; throw failure; }
      return original(...args);
    };
  }
  const f = await presetFixture(t, { desktopExtras: extras });
  const full = await f.join({ preset: "full" });
  const routes = [
    ["screenshot", "shot", "/api/browser/desktop/screen", {}],
    ["front", "front", "/api/browser/desktop/front", {}],
    ["catalog", "catalog", "/api/browser/desktop/apps", {}],
    ["act", "act", "/api/browser/desktop/input", { method: "POST", body: { action: { type: "key", key: "enter" } } }],
    ["open", "open", "/api/browser/desktop/open", { method: "POST", body: { app: chrome.id } }],
  ];
  for (const [, helperOperation, route, options] of routes) {
    const message = "The Mac's agent helper exited. Completion is unknown. Check the screen before trying again.";
    const expected = { error: message, kind: "unavailable", helperReason: "process_exit", helperOperation, helperDispatch: "completion_unknown" };
    failure = Object.assign(Error(message), expected, { status: 503, stderr: "PRIVATE-stderr", request: "PRIVATE-text", path: "/PRIVATE", exitCode: 99 });
    const result = await full.as(route, options);
    assert.equal(result.status, 503, route);
    assert.deepEqual(result.body, expected, route);
  }
  assert.equal(calls, routes.length, "no native mutation retries");
});

// Muse's feedback, Oct 10: round trips are the cost. A batch runs several
// actions in one request, each checked as if sent alone, stopping at the
// first refused; describe brings the screen as text back in the same answer.
test("a batch of actions in one request, stopping at the first refused, with the screen as text after", privateIngressTest, async (t) => {
  const { extras, log } = stand();
  const f = await presetFixture(t, { desktopExtras: extras });
  const full = await f.join({ preset: "full" });
  const input = (body) => full.as("/api/browser/desktop/input", { method: "POST", body });
  const id = full.created.clientId;
  const batch = await input({ actions: [{ type: "element", snapshot: "s1", n: 1 }, { type: "type", text: "diapers" }, { type: "wait", ms: 50 }, { type: "key", key: "enter" }], describe: true });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.equal(batch.body.ok, true);
  assert.equal(batch.body.done, 4);
  assert.deepEqual(log.filter(([op]) => op === "act").map(([, who, action]) => [who, action.type]), [[id, "element"], [id, "type"], [id, "key"]]);
  assert.equal(batch.body.screen.snapshot, "s1");
  assert.match(batch.body.screen.text, /\[2\] Button "Add to cart"/);
  // One action, then see: one request.
  const seen = await input({ action: { type: "element", snapshot: "s1", n: 2 }, describe: true });
  assert.equal(seen.body.ok, true);
  assert.match(seen.body.screen.text, /Pampers Swaddlers/);
  // Another agent holds the Mac: the batch stops at once and says who.
  const other = await f.join({ preset: "full", name: "Grok" });
  const stopped = await other.as("/api/browser/desktop/input", { method: "POST", body: { actions: [{ type: "key", key: "enter" }, { type: "type", text: "never typed" }] } });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.ok, false);
  assert.equal(stopped.body.done, 0);
  assert.deepEqual([stopped.body.stopped.index, stopped.body.stopped.kind, stopped.body.stopped.holder], [0, "busy", "Muse"]);
  assert.ok(!log.some(([, , action]) => action?.text === "never typed"), "nothing after the refusal ran");
  // Checked before any runs: a bad action anywhere leaves nothing half done.
  const before = log.length;
  for (const body of [
    { actions: [{ type: "key", key: "enter" }, { type: "click", x: 2, y: 0.5 }] },
    { actions: [{ type: "wait", ms: 5000 }] },
    { actions: [{ type: "wait", ms: 2000 }, { type: "wait", ms: 2000 }, { type: "wait", ms: 2000 }, { type: "wait", ms: 2000 }] },
    { actions: Array.from({ length: 11 }, () => ({ type: "key", key: "enter" })) },
    { actions: [{ type: "type", text: "x".repeat(1500) }, { type: "type", text: "y".repeat(600) }] },
    { action: { type: "key", key: "enter" }, actions: [{ type: "key", key: "enter" }] },
    { actions: [{ type: "key", key: "enter" }], describe: false },
  ]) assert.equal((await input(body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(log.length, before, "nothing ran");
  // One action alone answers as before.
  const single = await input({ action: { type: "key", key: "enter" } });
  assert.equal(single.body.app, "Google Chrome");
});

// The Mac waits for its own screen (a page to load, a dialog) instead of the
// agent asking again and again; press and fill ride in batches.
test("the Mac waits for text or a control to appear; press and fill ride in batches", privateIngressTest, async (t) => {
  const { extras, log } = stand();
  const f = await presetFixture(t, { desktopExtras: extras });
  const full = await f.join({ preset: "full" });
  const wait = (body) => full.as("/api/browser/desktop/wait", { method: "POST", body });
  const seen = await wait({ text: "pampers swaddlers" });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.found, true);
  assert.match(seen.body.screen.text, /Pampers Swaddlers/);
  assert.equal((await wait({ name: "add to" })).body.found, true, "a control by the start of its name");
  const started = Date.now();
  const missing = await wait({ text: "Order placed", timeoutMs: 900 });
  assert.equal(missing.body.found, false);
  assert.ok(missing.body.waitedMs >= 800 && Date.now() - started < 5000, `waited ${missing.body.waitedMs} ms`);
  assert.match(missing.body.screen.text, /Uber Eats/, "the screen as text comes back either way");
  for (const body of [{}, { text: "a", name: "b" }, { text: "" }, { text: "a", timeoutMs: 100 }, { text: "a", extra: 1 }, { text: "x".repeat(201) }])
    assert.equal((await wait(body)).status, 400, JSON.stringify(body));
  const batch = await full.as("/api/browser/desktop/input", { method: "POST", body: { actions: [{ type: "press", name: "Search" }, { type: "fill", fields: [{ label: "Search", text: "diapers" }], submit: true }], describe: true } });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.equal(batch.body.done, 2);
  assert.deepEqual(log.filter(([op]) => op === "act").map(([, , action]) => action.type), ["press", "fill"]);
  assert.match(batch.body.screen.text, /Fields: "Search"/);
  const ro = await f.join({ preset: "readonly", name: "Reader" });
  assert.equal((await ro.as("/api/browser/desktop/wait", { method: "POST", body: { text: "x" } })).status, 403, "waiting is control");
});
