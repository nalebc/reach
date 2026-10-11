import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installMeanwhile, seconds } from "../scripts/first-start.mjs";
import { runSetup, readProgress } from "../scripts/setup.mjs";
import { ensureTailscale } from "../scripts/tailscale-connect.mjs";

// First-run matrix H14–H17: a first `./reach` installs (npm, the phone
// interface, browser sign-in) while its setup asks about Tailscale, instead
// of making a new person wait minutes before the first question.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-first-start-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const missing = Object.assign(Error("spawn tailscale ENOENT"), { code: "ENOENT" });
const READY = {
  BackendState: "Running",
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: ["mac.tail1.ts.net"],
};

// A slow install in three parts, as bootstrap's prepare() runs it.
function slowInstall(log, { ms = 150, fail } = {}) {
  let cancelled = false;
  const work = async ({ say, step }) => {
    for (const label of ["installing dependencies", "preparing the phone interface", "preparing browser sign-in"]) {
      if (cancelled) throw Error("stopped");
      step(label);
      log.push(`install: ${label}`);
      await sleep(ms);
      if (fail === label) throw Error("npm couldn't reach the registry.");
    }
    say("Reach: Go isn't installed, so phones need the Tailscale app.");
  };
  return { work, cancel: () => (cancelled = true), cancelled: () => cancelled };
}

// The real setup and the real Tailscale steps on a computer without
// Tailscale: missing, then installed but signed out, then running.
function setupDeps(log, answers = {}) {
  const statuses = [missing, missing, { BackendState: "NeedsLogin" }, READY];
  let polled = 0;
  const select = async ({ message, choices }) => {
    log.push(`asked: ${message}`);
    if (answers[message] instanceof Error) throw answers[message];
    return answers[message] ?? choices.find((c) => c.recommended)?.value ?? choices[0].value;
  };
  const print = (line) => log.push(`said: ${line}`);
  return {
    print,
    select,
    ask: async () => "",
    platform: "linux",
    ensureTailscale,
    tailscale: {
      interactive: true,
      platform: "darwin",
      appInstalled: () => false,
      status: async () => {
        const next = statuses[Math.min(polled++, statuses.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      open: (url) => log.push(`open: ${url}`),
      openApp: async () => {},
      login: (onUrl) => (onUrl("https://login.tailscale.com/a/abc123"), () => {}),
      sleep: () => sleep(20),
      select,
      print,
    },
    configure: async () => ({ owner: { login: "me@example.test" } }),
    status: async () => READY,
    socketPath: () => "/tmp/reach.sock",
    open: async () => {},
    sleep: async () => {},
  };
}

test("H14: the first question comes before the install ends, and both waits overlap", async (t) => {
  const root = tmp(t);
  const log = [];
  const install = slowInstall(log);
  const started = Date.now();
  const installing = installMeanwhile(install.work, { cancel: install.cancel });
  await runSetup(root, { deps: setupDeps(log) });
  const setupDone = Date.now();
  const printed = [];
  const took = await installing.finish((line) => printed.push(line));
  const total = Date.now() - started;

  const asked = log.indexOf("asked: Install Tailscale to continue");
  assert.ok(asked >= 0, "a computer without Tailscale is asked to install it");
  assert.ok(asked < log.indexOf("install: preparing the phone interface"), "asked before the install got far");
  assert.ok(log.includes("open: https://tailscale.com/download/mac"));
  assert.ok(log.includes("open: https://login.tailscale.com/a/abc123"), "then signed in from the browser");
  assert.equal(readProgress(root).done, true);
  // Nothing the install said reached the terminal while setup ran.
  assert.equal(log.filter((l) => l.startsWith("said:") && /Go isn't installed/.test(l)).length, 0);
  assert.deepEqual(printed.at(-1), "Reach: Go isn't installed, so phones need the Tailscale app.");
  // Overlapped, not queued: the whole start is shorter than both waits added up.
  const setupMs = setupDone - started;
  assert.ok(total < setupMs + took.ms, `overlap: total ${total} ms, setup ${setupMs} ms, install ${took.ms} ms`);
  assert.deepEqual(took.parts.map((p) => p.label), ["installing dependencies", "preparing the phone interface", "preparing browser sign-in"]);
  assert.ok(took.parts.every((p) => p.ms >= 100));
});

test("H15: setup done first: the person is told what the install still does", async () => {
  const log = [];
  const install = slowInstall(log, { ms: 60 });
  const installing = installMeanwhile(install.work);
  await sleep(10);
  const printed = [];
  await installing.finish((line) => printed.push(line));
  assert.match(printed[0], /^\nReach: finishing the first install: installing dependencies…$/);
  // Already finished: nothing about finishing.
  const done = installMeanwhile(async ({ step }) => step("installing dependencies"));
  await sleep(10);
  const quiet = [];
  await done.finish((line) => quiet.push(line));
  assert.deepEqual(quiet, []);
});

test("H16: an install that fails mid-setup never breaks a menu; it's said after setup", async (t) => {
  const root = tmp(t);
  const log = [];
  const install = slowInstall(log, { ms: 5, fail: "installing dependencies" });
  const installing = installMeanwhile(install.work, { cancel: install.cancel });
  await sleep(30); // failed while the person is still at the first menu
  assert.equal(installing.done, true);
  await runSetup(root, { deps: setupDeps(log) });
  assert.equal(readProgress(root).done, true, "setup still finishes and is saved");
  await assert.rejects(installing.finish(() => {}), /couldn't reach the registry/);
});

test("H17: pausing setup (Ctrl+C at a menu) stops the install too", async (t) => {
  const root = tmp(t);
  const log = [];
  const install = slowInstall(log, { ms: 40 });
  const installing = installMeanwhile(install.work, { cancel: install.cancel });
  const cancelled = Object.assign(Error("Cancelled. No pending choice was applied."));
  await assert.rejects(
    runSetup(root, { deps: setupDeps(log, { "Install Tailscale to continue": cancelled }) }),
    (error) => error.paused,
  );
  // As bootstrap does when setup throws.
  installing.cancel();
  assert.equal(install.cancelled(), true);
  for (let i = 0; i < 50 && !installing.done; i++) await sleep(10);
  assert.equal(installing.done, true, "settled, so the process can exit");
  assert.equal(log.includes("install: preparing browser sign-in"), false, "no further part started");
  assert.ok(log.some((l) => /^said: \n  Paused\. Run .+ to continue your setup\.$/.test(l)));
});

test("durations read as people say them", () => {
  assert.equal(seconds(400), "1 s");
  assert.equal(seconds(42_000), "42 s");
  assert.equal(seconds(120_000), "2 min");
  assert.equal(seconds(130_400), "2 min 10 s");
});
