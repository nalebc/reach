import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureTailscale,
  tailscaleState,
  tailscaleProblem,
} from "../scripts/tailscale-connect.mjs";
import { findTailscaleCli } from "../scripts/tailscale.mjs";

const running = { BackendState: "Running", Self: { DNSName: "mac.t.ts.net." } };
const missing = Object.assign(Error("spawn tailscale ENOENT"), {
  code: "ENOENT",
});
const notRunning = Object.assign(
  Error("failed to connect to local tailscaled"),
  { code: 1 },
);

// Replays one status (or error) per poll; the last one repeats.
function fake(sequence, overrides = {}) {
  const log = [];
  let i = 0;
  const deps = {
    interactive: true,
    platform: "darwin",
    appInstalled: () => false,
    status: async () => {
      const next = sequence[Math.min(i++, sequence.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    open: (url) => log.push(["open", url]),
    openApp: async () => log.push(["openApp"]),
    turnOn: async () => log.push(["turnOn"]),
    login: (onUrl) => {
      log.push(["login"]);
      onUrl("https://login.tailscale.com/a/abc123");
      onUrl("https://login.tailscale.com/a/abc123");
      return () => log.push(["stopLogin"]);
    },
    select: async ({ message }) => {
      log.push(["select", message]);
      return overrides.answer || (message.startsWith("Turn") ? "on" : "open");
    },
    sleep: async () => {},
    print: (line) => log.push(["print", line]),
    ...overrides,
  };
  return { deps, log };
}

test("tailscaleState names every state Reach handles", () => {
  assert.equal(
    tailscaleState({ error: missing, appInstalled: false }),
    "missing",
  );
  assert.equal(
    tailscaleState({ error: missing, appInstalled: true }),
    "closed",
  );
  assert.equal(tailscaleState({ error: notRunning }), "closed");
  assert.equal(tailscaleState({ status: running }), "running");
  assert.equal(
    tailscaleState({ status: { BackendState: "NeedsLogin" } }),
    "signed-out",
  );
  assert.equal(
    tailscaleState({
      status: {
        BackendState: "NoState",
        AuthURL: "https://login.tailscale.com/a/x",
      },
    }),
    "signed-out",
  );
  assert.equal(
    tailscaleState({ status: { BackendState: "NoState" } }),
    "starting",
  );
  assert.equal(
    tailscaleState({ status: { BackendState: "Starting" } }),
    "starting",
  );
  assert.equal(tailscaleState({ status: { BackendState: "Stopped" } }), "off");
  assert.equal(
    tailscaleState({ status: { BackendState: "NeedsMachineAuth" } }),
    "needs-approval",
  );
  assert.equal(tailscaleState({ status: { BackendState: "Weird" } }), "closed");
});

test("a running Tailscale passes straight through without prompts", async () => {
  const { deps, log } = fake([running]);
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(log, []);
});

test("without a terminal it explains what is missing instead of asking", async () => {
  const { deps, log } = fake([{ BackendState: "NeedsLogin" }], {
    interactive: false,
  });
  await assert.rejects(ensureTailscale(deps), {
    message: tailscaleProblem("signed-out"),
  });
  assert.deepEqual(log, []);
});

test("signed out: opens the sign-in link once, waits, then stops the login helper", async () => {
  const { deps, log } = fake([
    { BackendState: "NeedsLogin" },
    { BackendState: "NeedsLogin" },
    { BackendState: "Starting" },
    running,
  ]);
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(log, [
    ["print", "\nReach: Tailscale needs you to sign in on this computer."],
    ["print", "Reach: opening the Tailscale sign-in page in your browser…"],
    ["login"],
    [
      "print",
      "If it doesn't open, visit: https://login.tailscale.com/a/abc123",
    ],
    ["open", "https://login.tailscale.com/a/abc123"],
    ["print", "\nReach: Tailscale is starting…"],
    ["stopLogin"],
    ["print", "Reach: Tailscale is connected."],
  ]);
});

test("not installed: asks, opens the download page, and continues once installed", async () => {
  const { deps, log } = fake(
    [missing, missing, { BackendState: "NeedsLogin" }, running],
    {
      login: () => {
        log.push(["login"]);
        return () => log.push(["stopLogin"]);
      },
    },
  );
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(log, [
    [
      "print",
      "\nReach: Tailscale isn't on this computer yet. Reach uses it (free) to keep the link to your phone private.",
    ],
    ["select", "Install Tailscale to continue"],
    ["open", "https://tailscale.com/download/mac"],
    ["print", "Reach: waiting for Tailscale to be installed… (Ctrl+C to stop)"],
    ["print", "\nReach: Tailscale needs you to sign in on this computer."],
    ["print", "Reach: opening the Tailscale sign-in page in your browser…"],
    ["login"],
    ["stopLogin"],
    ["print", "Reach: Tailscale is connected."],
  ]);
});

test("not installed and declined: exits without opening anything", async () => {
  const { deps, log } = fake([missing], { answer: "cancel" });
  await assert.rejects(
    ensureTailscale(deps),
    /Rerun Reach once it's installed/,
  );
  assert.deepEqual(
    log.filter(([kind]) => kind === "open" || kind === "openApp"),
    [],
  );
});

test("installed but closed on a Mac: opens the app once", async () => {
  const { deps, log } = fake([notRunning, notRunning, notRunning, running], {
    appInstalled: () => true,
  });
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(log, [
    ["print", "\nReach: Tailscale is installed but not running."],
    ["print", "Reach: opening Tailscale…"],
    ["openApp"],
    ["print", "Reach: Tailscale is connected."],
  ]);
});

test("switched off: turns it on after asking; falls back to the app if that fails", async () => {
  const off = { BackendState: "Stopped" };
  const ok = fake([off, running]);
  assert.deepEqual(await ensureTailscale(ok.deps), running);
  assert.deepEqual(
    ok.log.filter(([kind]) => kind !== "print"),
    [["select", "Turn Tailscale on?"], ["turnOn"]],
  );
  const refused = fake([off, off, running], {
    appInstalled: () => true,
    turnOn: async () => {
      throw Error(
        "changing settings via 'tailscale up' requires mentioning all non-default flags",
      );
    },
  });
  assert.deepEqual(await ensureTailscale(refused.deps), running);
  assert.deepEqual(refused.log, [
    ["print", "\nReach: Tailscale is switched off on this computer."],
    ["select", "Turn Tailscale on?"],
    [
      "print",
      "Switch Tailscale on from its menu bar icon. Reach continues once it's on.",
    ],
    ["openApp"],
    ["print", "Reach: Tailscale is connected."],
  ]);
});

test("waiting for admin approval opens the machines page once", async () => {
  const pending = { BackendState: "NeedsMachineAuth" };
  const { deps, log } = fake([pending, pending, pending, running]);
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(
    log.filter(([kind]) => kind === "open"),
    [["open", "https://login.tailscale.com/admin/machines"]],
  );
});

test("gives up with a clear message when nothing changes", async () => {
  const { deps } = fake([{ BackendState: "Starting" }], { waitMs: -1 });
  await assert.rejects(ensureTailscale(deps), {
    message: "Tailscale is starting… Rerun Reach once it's ready.",
  });
});

test("finds the CLI inside the Mac app when it isn't on PATH", () => {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const only =
    (...files) =>
    (file) =>
      files.includes(file);
  assert.equal(
    findTailscaleCli({
      env: { REACH_TAILSCALE: "/x/ts", PATH: "/bin" },
      exists: only(app),
    }),
    "/x/ts",
  );
  assert.equal(
    findTailscaleCli({
      env: { PATH: "/opt/homebrew/bin:/bin" },
      platform: "darwin",
      exists: only("/opt/homebrew/bin/tailscale", app),
    }),
    "tailscale",
  );
  assert.equal(
    findTailscaleCli({
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      exists: only(app),
    }),
    app,
  );
  assert.equal(
    findTailscaleCli({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      exists: only(app),
    }),
    "tailscale",
  );
  assert.equal(
    findTailscaleCli({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      exists: only(),
    }),
    "tailscale",
  );
});
