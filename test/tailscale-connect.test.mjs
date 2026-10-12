import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  ensureTailscale,
  managesTailscale,
  tailscaleState,
  tailscaleProblem,
  pageOpener,
  windowsApp,
} from "../scripts/tailscale-connect.mjs";
import { findTailscaleCli, findMacTailscaleApp } from "../scripts/tailscale.mjs";

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
    canManage: async () => true,
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
    // Printed too: a computer without a desktop opens nothing.
    ["print", "Reach: get it at https://tailscale.com/download/mac"],
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
  // The app's own command line wins over a Homebrew copy: it matches the daemon.
  assert.equal(
    findTailscaleCli({
      env: { PATH: "/opt/homebrew/bin:/bin" },
      platform: "darwin",
      exists: only("/opt/homebrew/bin/tailscale", app),
    }),
    app,
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

test("finds a per-user Mac install and Homebrew installed while Reach's PATH is stale", () => {
  const home = "/Users/new-person";
  const app = home + "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const opts = { env: { HOME: home, PATH: "/usr/bin:/bin" }, platform: "darwin" };
  for (const location of [app, "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"])
    assert.equal(findTailscaleCli({ ...opts, exists: file => file === location }), location);
  assert.equal(findMacTailscaleApp({ env: opts.env, exists: file => file === app }), home + "/Applications/Tailscale.app");
  const custom = home + "/bin/tailscale";
  assert.equal(findTailscaleCli({ ...opts, env: { ...opts.env, PATH: home + "/bin:/bin" }, exists: file => [custom, "/opt/homebrew/bin/tailscale"].includes(file) }), custom);
});

// First-run matrix T1, T2, T5, T6: what each computer is told, in its own
// terms. A Linux user without Tailscale's operator right is refused by it
// ("access denied") and gets the one command that fixes that.
test("Linux: switched off and refused, or signed out and refused: the operator command, once", async () => {
  const off = { BackendState: "Stopped" };
  const denied = fake([off, off, running], {
    platform: "linux",
    turnOn: async () => {
      throw Object.assign(Error("Command failed"), { stderr: "Access denied: prefs write access denied\nUse 'sudo tailscale up' or 'tailscale set --operator=$USER'" });
    },
  });
  assert.deepEqual(await ensureTailscale(denied.deps), running);
  assert.ok(denied.log.some(([k, l]) => k === "print" && /sudo tailscale set --operator=\$USER/.test(l)));
  assert.ok(!denied.log.some(([k, l]) => k === "print" && /menu bar/.test(l)), "no Mac words on Linux");

  const signedOut = fake([{ BackendState: "NeedsLogin" }, { BackendState: "NeedsLogin" }, running], {
    platform: "linux",
    login: (onUrl) => {
      onUrl(null, "denied");
      onUrl(null, "denied");
      return () => {};
    },
  });
  assert.deepEqual(await ensureTailscale(signedOut.deps), running);
  assert.equal(signedOut.log.filter(([k, l]) => k === "print" && /--operator/.test(l)).length, 1);
});

test("switched off and refused: each computer is told where its own switch is", async () => {
  const off = { BackendState: "Stopped" };
  for (const [platform, words] of [["linux", /sudo tailscale up/], ["win32", /taskbar/], ["darwin", /menu bar icon/]]) {
    const { deps, log } = fake([off, off, running], {
      platform,
      turnOn: async () => {
        throw Error("requires mentioning all non-default flags");
      },
    });
    await ensureTailscale(deps);
    assert.ok(log.some(([k, l]) => k === "print" && words.test(l)), platform);
  }
});

test("not installed on a computer without a desktop: the download link is printed", async () => {
  const { deps, log } = fake([missing, running], { platform: "linux" });
  await ensureTailscale(deps);
  assert.ok(log.some(([k, l]) => k === "print" && l === "Reach: get it at https://tailscale.com/download/linux"));
});

test("a Mac with only Homebrew's Tailscale, not running: the command that starts it", async () => {
  const { deps, log } = fake([notRunning, running], { appInstalled: () => false });
  await ensureTailscale(deps);
  assert.ok(log.some(([k, l]) => k === "print" && /sudo brew services start tailscale/.test(l)));
});

// First-run matrix T17–T21: a Windows computer gets the same walk-through,
// in Windows terms. Its Tailscale lives in Program Files, which a Reach
// started before the install doesn't have on its PATH.
const WINDOWS_CLI = "C:\\Program Files\\Tailscale\\tailscale.exe";
const NOT_WINDOWS = /menu bar|systemctl|brew|sudo|xdg-open|\.\/reach\b/;

test("Windows: finds Tailscale in Program Files, including once it's installed mid-run", () => {
  const only =
    (...files) =>
    (file) =>
      files.includes(file);
  const env = { ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\system32" };
  assert.equal(findTailscaleCli({ env, platform: "win32", exists: only(WINDOWS_CLI) }), WINDOWS_CLI);
  // Another drive, as Windows names it.
  assert.equal(
    findTailscaleCli({ env: { ProgramFiles: "D:\\Apps" }, platform: "win32", exists: only("D:\\Apps\\Tailscale\\tailscale.exe") }),
    "D:\\Apps\\Tailscale\\tailscale.exe",
  );
  // No ProgramFiles in the environment: Windows' default folder.
  assert.equal(findTailscaleCli({ env: {}, platform: "win32", exists: only(WINDOWS_CLI) }), WINDOWS_CLI);
  // Not installed yet: the name on PATH, looked up again on the next try, so
  // the install shows up without restarting Reach.
  let installed = false;
  const exists = (file) => installed && file === WINDOWS_CLI;
  assert.equal(findTailscaleCli({ env, platform: "win32", exists }), "tailscale");
  installed = true;
  assert.equal(findTailscaleCli({ env, platform: "win32", exists }), WINDOWS_CLI);
  // REACH_TAILSCALE still wins, and only Windows looks in Program Files.
  assert.equal(findTailscaleCli({ env: { ...env, REACH_TAILSCALE: "C:\\t\\ts.exe" }, platform: "win32", exists: only(WINDOWS_CLI) }), "C:\\t\\ts.exe");
  assert.equal(findTailscaleCli({ env, platform: "linux", exists: only(WINDOWS_CLI) }), "tailscale");
});

test("Windows: pages open with explorer.exe, the app is tailscale-ipn.exe next to the CLI", () => {
  const url = "https://login.tailscale.com/a/abc123?x=1&y=2";
  // Never cmd's `start`: it isn't a program, and cmd would cut the link at "&".
  assert.deepEqual(pageOpener("win32", url), ["explorer.exe", [url]]);
  assert.deepEqual(pageOpener("darwin", url), ["open", [url]]);
  assert.deepEqual(pageOpener("linux", url), ["xdg-open", [url]]);
  assert.equal(windowsApp({ ProgramFiles: "C:\\Program Files" }), "C:\\Program Files\\Tailscale\\tailscale-ipn.exe");
  assert.equal(path.win32.dirname(windowsApp({})), path.win32.dirname(WINDOWS_CLI));
});

test("Windows first run: install from the Windows page, sign in, connected", async () => {
  const { deps, log } = fake([missing, missing, { BackendState: "NeedsLogin" }, { BackendState: "NeedsLogin" }, running], {
    platform: "win32",
  });
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(log, [
    ["print", "\nReach: Tailscale isn't on this computer yet. Reach uses it (free) to keep the link to your phone private."],
    ["select", "Install Tailscale to continue"],
    ["open", "https://tailscale.com/download/windows"],
    ["print", "Reach: get it at https://tailscale.com/download/windows"],
    ["print", "Reach: waiting for Tailscale to be installed… (Ctrl+C to stop)"],
    ["print", "\nReach: Tailscale needs you to sign in on this computer."],
    ["print", "Reach: opening the Tailscale sign-in page in your browser…"],
    ["login"],
    ["print", "If it doesn't open, visit: https://login.tailscale.com/a/abc123"],
    ["open", "https://login.tailscale.com/a/abc123"],
    ["stopLogin"],
    ["print", "Reach: Tailscale is connected."],
  ]);
  assert.ok(!log.some(([k, l]) => k === "print" && NOT_WINDOWS.test(l)), "no Mac or Linux words on Windows");
});

test("Windows: installed but not running: opens the Tailscale app once, then names its service", async () => {
  const withApp = fake([notRunning, notRunning, running], { platform: "win32", appInstalled: () => true });
  assert.deepEqual(await ensureTailscale(withApp.deps), running);
  assert.deepEqual(withApp.log, [
    ["print", "\nReach: Tailscale is installed but not running."],
    ["print", "Reach: opening Tailscale…"],
    ["openApp"],
    ["print", "If it still isn't running, start its service from a terminal opened as administrator: net start Tailscale\nReach continues as soon as it runs."],
    ["print", "Reach: Tailscale is connected."],
  ]);
  // Only the command line (no app): the Start menu, and the same service line.
  const cliOnly = fake([notRunning, running], { platform: "win32", appInstalled: () => false });
  await ensureTailscale(cliOnly.deps);
  assert.deepEqual(cliOnly.log.filter(([k]) => k === "openApp"), []);
  assert.ok(cliOnly.log.some(([k, l]) => k === "print" && /^Open Tailscale from the Start menu\. .*net start Tailscale/s.test(l)));
  for (const { log } of [withApp, cliOnly])
    assert.ok(!log.some(([k, l]) => k === "print" && NOT_WINDOWS.test(l)), "no Mac or Linux words on Windows");
});

test("Windows: switched off and `tailscale up` refused: the taskbar icon, with the app opened", async () => {
  const off = { BackendState: "Stopped" };
  const { deps, log } = fake([off, off, running], {
    platform: "win32",
    appInstalled: () => true,
    turnOn: async () => {
      throw Error("requires mentioning all non-default flags");
    },
  });
  assert.deepEqual(await ensureTailscale(deps), running);
  assert.deepEqual(log, [
    ["print", "\nReach: Tailscale is switched off on this computer."],
    ["select", "Turn Tailscale on?"],
    ["print", "Switch Tailscale on from its icon in the taskbar's notification area. Reach continues once it's on."],
    ["openApp"],
    ["print", "Reach: Tailscale is connected."],
  ]);
});

test("Windows without a terminal to ask in: says what's missing, opens nothing", async () => {
  const { deps, log } = fake([missing], { platform: "win32", interactive: false });
  await assert.rejects(ensureTailscale(deps), { message: tailscaleProblem("missing") });
  assert.deepEqual(log, []);
});

// First-run matrix M7 (Ubuntu 24.04, Tailscale 1.104.1, Oct 10). Tailscale
// as it really answers a user who isn't root: refused, and the refused
// command exits. Signed out, even its operator is refused; signed in, the
// operator may switch it on and change its routes. It never comes on by
// itself: after the third look, the owner runs the command Reach printed.
function ubuntu(state) {
  const host = { state, operator: false, looks: 0, calls: [] };
  const fixes = {
    // `sudo tailscale up --operator=$USER`: signed in, and the user manages it.
    NeedsLogin: () => Object.assign(host, { state: "Running", operator: true }),
    // `sudo tailscale set --operator=$USER`
    Stopped: () => (host.operator = true),
    Running: () => (host.operator = true),
  };
  const denied = () =>
    Object.assign(Error("Command failed: tailscale up"), {
      stderr: "Access denied: prefs write access denied\n\nUse 'sudo tailscale up'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n",
    });
  const { deps, log } = fake([], {
    platform: "linux",
    status: async () => ({ BackendState: host.state }),
    canManage: async () => host.operator,
    login: (onUrl) => {
      host.calls.push("login");
      onUrl(null, "denied"); // "Access denied: profiles access denied", operator or not
      return () => {};
    },
    turnOn: async () => {
      host.calls.push("up");
      if (!host.operator || host.state !== "Stopped") throw denied();
      host.state = "Running";
    },
    sleep: async () => {
      if (++host.looks === 3) fixes[state]();
      // A Reach that doesn't look again would wait out its 15 minutes.
      if (host.looks > 20) throw Error("Reach was still waiting 20 looks after the owner's command ran");
    },
  });
  const said = (pattern) => log.filter(([k, l]) => k === "print" && pattern.test(l)).length;
  return { host, deps, log, said };
}

test("Linux, signed out: root's first sign-in, keeping the user as operator, is the one command; then Reach goes on", async () => {
  const { host, deps, said } = ubuntu("NeedsLogin");
  assert.deepEqual(await ensureTailscale(deps), { BackendState: "Running" });
  assert.equal(said(/sudo tailscale up --operator=\$USER/), 1, "the command, once");
  // `set --operator` alone can't help a signed-out computer.
  assert.equal(said(/tailscale set --operator/), 0);
  assert.deepEqual(host.calls, ["login"], "a refused sign-in isn't retried: it can't succeed as this user");
});

test("Linux, switched off: `tailscale up` refused until the operator command runs, then on, without asking twice", async () => {
  const { host, deps, log, said } = ubuntu("Stopped");
  assert.deepEqual(await ensureTailscale(deps), { BackendState: "Running" });
  assert.deepEqual(log.filter(([k]) => k === "select"), [["select", "Turn Tailscale on?"]]);
  assert.ok(host.calls.filter((c) => c === "up").length > 1, "tried again after the refusal");
  assert.equal(said(/sudo tailscale set --operator=\$USER/), 1, "the command, once");
});

test("Linux, already on (sudo tailscale up) but not this user's to change: the operator command before setup goes on", async () => {
  const { deps, log, said } = ubuntu("Running");
  assert.deepEqual(await ensureTailscale(deps), { BackendState: "Running" });
  assert.equal(said(/sudo tailscale set --operator=\$USER/), 1);
  assert.deepEqual(log.at(-1), ["print", "Reach: Tailscale is connected."]);
  // Without a terminal (no one to wait with): the same command, and stop.
  const background = ubuntu("Running");
  await assert.rejects(ensureTailscale({ ...background.deps, interactive: false }), {
    message: tailscaleProblem("operator"),
  });
  assert.match(tailscaleProblem("operator"), /sudo tailscale set --operator=\$USER/);
});

test("Linux: the operator is read from Tailscale's prefs, which leave it out while unset", () => {
  // As `tailscale debug prefs` printed them on Ubuntu 24.04 (Tailscale 1.104.1).
  const prefs = { ControlURL: "https://controlplane.tailscale.com", RouteAll: false, WantRunning: true, LoggedOut: false, Hostname: "" };
  assert.equal(managesTailscale(prefs, "ubuntu"), false, "no operator: the field isn't there");
  assert.equal(managesTailscale({ ...prefs, OperatorUser: "ubuntu" }, "ubuntu"), true);
  assert.equal(managesTailscale({ ...prefs, OperatorUser: "someone" }, "ubuntu"), false);
  // Prefs it can't read: not held up here; Tailscale's own refusal says it.
  assert.equal(managesTailscale({ Config: {} }, "ubuntu"), true);
  assert.equal(managesTailscale(null, "ubuntu"), true);
});
