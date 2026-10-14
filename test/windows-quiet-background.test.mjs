import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { backgroundService } from "../scripts/background-service.mjs";
import { windowsTask } from "../scripts/windows-task.mjs";
import { setupStamp } from "../scripts/setup-stamp.mjs";
import { windowsProcesses } from "../server/windows-processes.mjs";
import { windowsFixture } from "./helpers/windows-fixtures.mjs";

// Background mode on a real Windows PC (workstreams K and L): the real
// Reach, from this checkout (CI's build, its setup stamp written as
// bootstrap writes it), run by its Scheduled Task in this session with no
// window, then asked for what makes it start console programs (Explorer's
// file icons and an owner's command through PowerShell, a command ended at
// its deadline with taskkill, a terminal). A WinEvent hook
// (test/fixtures/windows/window-watch.cs) sees every window this desktop
// shows, even one that flashes: none may be a console's, nor any of the
// task's programs'. Local mode: no Tailscale here.
const onWindows = { skip: process.platform !== "win32" && "a real Windows PC", timeout: 300000 };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 120000) => {
  for (const end = Date.now() + ms; ; await sleep(250)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
  }
};
const CONSOLES = /^(ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|PseudoConsoleWindow)$/;
// A process's Windows session, as tasklist says it (its fourth column).
const sessionOf = (pid) =>
  new Promise((resolve) =>
    execFile(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 30000 }, (error, stdout) => {
      const cells = String(stdout).trim().split(/\r?\n/)[0]?.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1));
      resolve(!error && cells?.length >= 4 ? Number(cells[3]) : null);
    }));

test("Windows background mode: the task's Reach and the console programs it starts show no window, not even for a moment", onWindows, async (t) => {
  const stamp = setupStamp(repo);
  assert.ok(stamp.agent && fs.existsSync(path.join(repo, "dist", "index.html")), "a built checkout (npm run build:release)");
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-quiet-")));
  const state = path.join(base, "state");
  const share = path.join(base, "share");
  fs.mkdirSync(state);
  fs.mkdirSync(share);
  fs.writeFileSync(path.join(state, "setup.json"), JSON.stringify(stamp));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REACH_|NODE_TEST_CONTEXT$)/i.test(key))), REACH_HOME: state };
  const task = windowsTask({ name: `Reach-test-${crypto.randomBytes(4).toString("hex")}` });
  const nativeDir = path.join(base, "native");
  const port = 4300 + crypto.randomInt(600);
  // Every window shown from here on.
  const watch = path.join(base, "windows.jsonl");
  const stop = path.join(base, "stop-watching");
  const watcher = spawn(await windowsFixture("window-watch"), [watch, stop], { stdio: "ignore", windowsHide: true });
  let watching = true;
  t.after(async () => {
    watching = false;
    fs.writeFileSync(stop, "");
    watcher.kill();
    try {
      await backgroundService({ command: "uninstall" }, repo, { platform: "win32", env, task, print: () => {} });
    } catch {}
    try {
      task.remove();
    } catch {}
    await sleep(1500);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  });
  const events = () => (fs.existsSync(watch) ? fs.readFileSync(watch, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  await until(() => events().some((e) => e.watching), "the watcher hooked in", 30000);
  // Its process list's helper, built before anything is timed.
  await windowsProcesses({ nativeDir });
  // Every process the task's starter and its Reach start, as they come.
  const seen = new Map();
  const tree = (async () => {
    while (watching) {
      try {
        for (const p of await windowsProcesses({ nativeDir })) if (!seen.has(p.pid)) seen.set(p.pid, p);
      } catch {}
      await sleep(200);
    }
  })();

  await backgroundService({ command: "install", local: true, folders: [share], httpsPort: 8443 }, repo, {
    platform: "win32",
    env,
    task,
    privateNode: () => process.execPath,
    allocatePort: async () => port,
    print: () => {},
  });
  const origin = `http://127.0.0.1:${port}`;
  const logs = () => ["companion.log", "companion-error.log"].map((name) => {
    try {
      return `${name}: ${fs.readFileSync(path.join(state, "logs", name), "utf8").slice(-3000)}`;
    } catch {
      return `${name}: (none)`;
    }
  }).join("\n");
  await until(async () => {
    try {
      return (await fetch(`${origin}/api/health`)).ok;
    } catch {
      return false;
    }
  }, "the task's Reach answering").catch((error) => {
    throw Error(`${error.message}\n${logs()}`);
  });
  const host = JSON.parse(fs.readFileSync(path.join(state, "host-status.json"), "utf8"));
  assert.equal(host.service, true, "it runs as the background task's");
  // The watcher sees this desktop's windows: the task's Reach must be on it.
  const sessions = { reach: await sessionOf(host.pid), watcher: await sessionOf(watcher.pid) };
  t.diagnostic(`sessions: ${JSON.stringify(sessions)}`);
  assert.ok(sessions.reach !== null && sessions.reach === sessions.watcher, `the task's Reach and the watcher share a session (else this can't see its windows): ${JSON.stringify(sessions)}`);
  // A phone, paired by the code it keeps.
  const { code } = JSON.parse(fs.readFileSync(path.join(state, "quick", "pairing.json"), "utf8"));
  const paired = await (await fetch(`${origin}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "test phone" }) })).json();
  assert.ok(paired.token, JSON.stringify(paired));
  const api = async (method, route, body) => {
    const response = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${paired.token}`, ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  // What starts console programs.
  const icons = await api("GET", "/api/files/icons?types=folder,pdf,txt");
  assert.equal(icons.status, 200, JSON.stringify(icons.json));
  const job = await api("POST", "/api/jobs", { root: 0, path: "", command: "Write-Output 'quiet'" });
  assert.equal(job.status, 202, JSON.stringify(job.json));
  const slow = await api("POST", "/api/jobs", { root: 0, path: "", command: "Start-Sleep 30", timeoutMs: 1000 });
  assert.equal(slow.status, 202, JSON.stringify(slow.json));
  await until(async () => ["completed", "failed", "timed_out", "cancelled"].includes((await api("GET", `/api/jobs/${job.json.id}`)).json?.status), "the command done", 60000);
  await until(async () => (await api("GET", `/api/jobs/${slow.json.id}`)).json?.status === "timed_out", "the slow command ended at its deadline", 60000);
  const terminal = await api("POST", "/api/terminals", { root: 0, path: "" });
  t.diagnostic(`terminal: ${terminal.status}`);
  await sleep(5000);
  watching = false;
  await tree;
  const during = events();
  // The watch itself, checked: a console window opened on purpose is seen.
  execFile(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", '"start "Reach test window" cmd.exe /d /c ping -n 4 127.0.0.1 >nul"'], { windowsVerbatimArguments: true, windowsHide: true }, () => {});
  const control = await until(() => events().slice(during.length).find((e) => e.shown && CONSOLES.test(e.class)), "the watcher seeing a console window opened on purpose", 30000);
  t.diagnostic(`the control window: ${JSON.stringify(control)}`);
  fs.writeFileSync(stop, "");

  // What it ran: the task's starter and everything under it.
  const starter = [...seen.values()].find((p) => /^reach-background-[0-9a-f]{12}\.exe$/i.test(p.image) && p.commandLine?.toLowerCase().includes(repo.toLowerCase()));
  assert.ok(starter, "the task's starter, seen");
  const ours = new Set([starter.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of seen.values())
      if (!ours.has(p.pid) && ours.has(p.ppid) && (p.startedAt == null || seen.get(p.ppid)?.startedAt == null || p.startedAt >= seen.get(p.ppid).startedAt)) {
        ours.add(p.pid);
        grew = true;
      }
  }
  assert.ok(ours.has(host.pid), "Reach itself is the starter's");
  const ran = [...ours].map((pid) => seen.get(pid)?.image).filter(Boolean);
  t.diagnostic(`the task ran: ${[...new Set(ran)].join(", ")}`);
  assert.ok(ran.some((image) => /^powershell\.exe$/i.test(image)), "console programs ran under it");
  const shown = during.filter((e) => e.shown);
  t.diagnostic(`windows shown meanwhile: ${JSON.stringify(shown.map(({ pid, class: kind, title }) => ({ pid, kind, title, image: seen.get(pid)?.image })))}`);
  const mine = during.find((e) => e.session !== undefined && e.pid === undefined);
  t.diagnostic(`watcher's session ${mine?.session}`);
  assert.deepEqual(shown.filter((e) => ours.has(e.pid) || CONSOLES.test(e.class)), [], "no window from the task's programs, and no console window at all");
});
