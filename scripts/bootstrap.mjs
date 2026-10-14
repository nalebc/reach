import fs from "node:fs";
import { detachedWarning } from "./detached.mjs";
import { alreadyRunning, handoverFile, hostApp, outsideTerminal, processTable, ProcessInventoryError, reachHosts, sameBoot, startedOf, stateOf, statusText, windowsBootTime, windowsHostApp, windowsImage, windowsReaches, withoutHandover } from "./instances.mjs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { parseOptions } from "./launcher-options.mjs";
import { command, packaged, stateDir } from "./home.mjs";
// Windows PowerShell gets its own modules, never PowerShell 7's (started from
// a PowerShell 7 window, every helper and terminal failed to load them).
import { cleanPowerShellEnv } from "../server/powershell.mjs";
cleanPowerShellEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const state = stateDir(root);
let locked = false;
const lockFile = path.join(state, "launcher.lock");
let child;
// A first start's install running alongside its setup (first-start.mjs).
let stopInstall = () => {};
const abort = () => {
  child?.kill();
  stopInstall();
  process.exit(130);
};
// Windows' process list (server/windows-processes.mjs), read once per
// command unless asked `fresh` (the lock, after a restart stopped Reach): its
// helper is built into Reach's folder the first time, by the PC's own C#
// compiler. Where it can't be read, the Reach this folder runs (instances.mjs
// windowsReaches), said as such.
let inventory = null;
function windowsInventory({ fresh = false } = {}) {
  if (fresh) inventory = null;
  inventory ||= (async () => {
    const list = async () => {
      const { windowsProcesses } = await import("../server/windows-processes.mjs");
      const slow = setTimeout(() => console.error("Reach: checking for another Reach on this PC (the first time takes a few seconds)…"), 2000);
      let limit;
      try {
        return await Promise.race([
          windowsProcesses({ nativeDir: path.join(state, "native") }),
          new Promise((_, reject) => {
            limit = setTimeout(() => reject(Error("it took too long")), 60000);
          }),
        ]);
      } finally {
        clearTimeout(slow);
        clearTimeout(limit);
      }
    };
    return windowsReaches({ root, state, list });
  })();
  return inventory;
}
// Every other Reach on this computer, whichever folder it runs from, with
// why only this folder's is known when Windows' process list can't be read.
async function reaches(options) {
  if (process.platform !== "win32") return { hosts: reachHosts(processTable()), partial: "" };
  const { hosts, partial } = await windowsInventory(options);
  return { hosts, partial };
}
const othersRunning = async (options) => (await reaches(options)).hosts;
// Windows: the version you confirmed on the phone, left for this window by
// the Reach it updates, read once (server/reach-updates.mjs).
async function confirmedUpdate() {
  const { takeUpdateRequest } = await import("../server/reach-updates.mjs");
  const dirs = new Set();
  for (const dir of [...(await othersRunning()).filter((h) => h.root).map((h) => stateOf(h.root)), state])
    try {
      const dataDir = JSON.parse(fs.readFileSync(path.join(dir, "host-status.json"), "utf8")).dataDir;
      if (typeof dataDir === "string" && dataDir) dirs.add(dataDir);
    } catch {}
  dirs.add(process.env.REACH_DATA || path.join(state, "quick"));
  for (const dir of dirs) {
    const version = takeUpdateRequest(dir);
    if (version) return version;
  }
  return null;
}
// After an update that stopped Reach first (Windows): Reach starts again as
// it ran, the background service, or right here.
async function startAgain({ service }) {
  if (service) {
    const { startService } = await import("./stop.mjs");
    startService(root);
    return console.log("Reach's background service started.");
  }
  process.exitCode = await new Promise((resolve) => {
    child = spawn(process.execPath, [path.join(root, "bin/reach.mjs"), "restart", "--yes"], { stdio: "inherit" });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 0));
  });
}
// The app this command runs inside, when it isn't a terminal: on a Mac,
// Reach started there would have a terminal but no Screen Recording or
// Accessibility; on Windows, it would end with that app (an editor, an
// agent's app or CLI), in no window of its own.
async function foreignApp() {
  if (process.platform === "win32") {
    const { processes } = await windowsInventory();
    const app = processes ? windowsHostApp(processes, process.pid) : "";
    return outsideTerminal(app) ? app : "";
  }
  if (process.platform !== "darwin") return "";
  const app = hostApp(processTable(), process.pid);
  return outsideTerminal(app) ? app : "";
}
async function lock() {
  // One Reach per computer: a second one says where the first runs instead.
  const others = withoutHandover(await othersRunning({ fresh: true }), state);
  if (others.length)
    throw Error(alreadyRunning(others, { command, started: startedOf(others) }));
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  let bootSession;
  try {
    if (process.platform === "darwin")
      bootSession = execFileSync(
        "/usr/sbin/sysctl",
        ["-n", "kern.bootsessionuuid"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        },
      ).trim();
    else if (process.platform === "linux")
      bootSession = fs
        .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
        .trim();
    else if (process.platform === "win32") bootSession = windowsBootTime();
  } catch {}
  try {
    const previous = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (
      bootSession &&
      previous.bootSession &&
      !sameBoot(bootSession, previous.bootSession)
    ) {
      // A PID from an earlier boot may now belong to an unrelated process.
      fs.unlinkSync(lockFile);
    } else
      try {
        process.kill(previous.pid, 0);
        // Windows reuses a finished process's id within minutes: a live id
        // holds this lock only while it's still Node.
        if (process.platform === "win32" && !["node.exe", null].includes(windowsImage(previous.pid)))
          fs.unlinkSync(lockFile);
      } catch (error) {
        if (error.code === "ESRCH") fs.unlinkSync(lockFile);
        else if (error.code === "EPERM" && process.platform === "win32") {
          // Another account's (or an administrator's) process: a Reach only if
          // it's Node; tasklist, not /bin/ps, says which.
          const image = windowsImage(previous.pid);
          if (image === null) throw new ProcessInventoryError(error);
          if (image !== "node.exe") fs.unlinkSync(lockFile);
        } else if (error.code === "EPERM") {
          // The pid belongs to another user's process now: a Reach only if
          // its command is one; otherwise the lock is stale.
          let command = "";
          try {
            command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(previous.pid)], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 2000,
            });
          } catch (error) {
            // An inaccessible process might still own this lock. Do not
            // remove it just because its command cannot be inspected.
            throw new ProcessInventoryError(error);
          }
          if (!/scripts\/bootstrap\.mjs|bin\/reach\.mjs/.test(command)) fs.unlinkSync(lockFile);
        } else throw error;
      }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, bootSession }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw Error(
        `Reach is already starting or running from this folder. Use its existing terminal, or run ${command} restart to start it again.`,
      );
    throw error;
  }
  locked = true;
}
function digest(files) {
  const h = crypto.createHash("sha256");
  function visit(file) {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name));
    } else {
      h.update(file);
      h.update(fs.readFileSync(file));
    }
  }
  files.forEach(visit);
  return h.digest("hex");
}
function npmCli() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(
      dir,
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
    if (!fs.existsSync(candidate)) continue;
    if (process.platform !== "win32") return fs.realpathSync.native(candidate);
    const cli = path.join(dir, "node_modules/npm/bin/npm-cli.js");
    if (fs.existsSync(cli)) return cli;
  }
  throw Error(
    "Node.js was found without npm. Run the reach launcher to install the bundled runtime.",
  );
}
async function npm(args) {
  const log = path.join(state, "setup.log");
  const fd = fs.openSync(log, "a", 0o600);
  const from = fs.fstatSync(fd).size;
  // What it most likely needs, from what this run wrote (setup-failure.mjs).
  const failed = async () => {
    let hint = "";
    try {
      const { setupFailureHint } = await import("./setup-failure.mjs");
      hint = setupFailureHint(fs.readFileSync(log, "utf8").slice(from));
    } catch {}
    return Error(`${hint ? `${hint}\n` : ""}Setup failed. See ${log} for details.`);
  };
  try {
    await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [npmCli(), ...args], {
        cwd: root,
        stdio: ["ignore", fd, fd],
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : void failed().then(reject),
      );
    });
  } finally {
    fs.closeSync(fd);
    child = null;
  }
}
// A checkout installs its npm packages and builds the phone interface and
// browser sign-in when they changed. `step(label)` names each part as it
// starts; `say(line)` is everything else it has to tell.
async function prepare(options, { say, step, signal }) {
  const stampFile = path.join(state, "setup.json");
  let stamp = {};
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch {}
  const dependencies = `${digest(["package.json", "package-lock.json"])}:${process.versions.modules}:${process.platform}:${process.arch}`;
  const source = digest([
    "src",
    "public",
    "index.html",
    "start.html",
    "vite.config.mjs",
    "tsconfig.json",
  ]);
  // Reach for agents (dist/agent.mjs): every file it was built from, as
  // esbuild listed them beside it. A server file it bundles (a tool's
  // schema) rebuilds it, alone; agents then pick it up by themselves.
  const agentSource = () => {
    let files;
    try { files = JSON.parse(fs.readFileSync("dist/.agent-inputs.json", "utf8")); } catch { return ""; }
    return Array.isArray(files) && files.length && files.every((file) => typeof file === "string") ? digest(files) : "";
  };
  let built = false;
  if (
    !packaged &&
    (stamp.dependencies !== dependencies ||
      !fs.existsSync("node_modules/.package-lock.json"))
  ) {
    signal?.throwIfAborted();
    step("installing dependencies (first run or update)");
    await npm(["ci", "--no-audit", "--no-fund"]);
  }
  if (
    !packaged &&
    (stamp.dependencies !== dependencies ||
      stamp.source !== source ||
      !fs.existsSync("dist/index.html") ||
      !fs.existsSync("dist/agent.mjs"))
  ) {
    signal?.throwIfAborted();
    step("preparing the phone interface");
    await npm(["run", "build"]);
    built = true;
  }
  if (!packaged && !built && (!fs.existsSync("dist/agent.mjs") || !stamp.agent || stamp.agent !== agentSource())) {
    signal?.throwIfAborted();
    step("preparing Reach for agents");
    const { buildAgent } = await import("./build-agent.mjs");
    await buildAgent();
  }
  if (!packaged)
    fs.writeFileSync(stampFile, JSON.stringify({ dependencies, source, agent: agentSource() }), {
      mode: 0o600,
    });
  // The browser sign-in client, for phones without the Tailscale app.
  if (!packaged && !options.local) {
    const { buildTailnet, tailnetCurrent } =
      await import("./build-tailnet.mjs");
    if (!tailnetCurrent()) {
      signal?.throwIfAborted();
      step("preparing browser sign-in for phones (first run or update, about 2 minutes)");
      try {
        if (!(await buildTailnet({ log: say, signal })))
          say(
            "Reach: Go isn't installed, so phones need the Tailscale app. Install Go (https://go.dev/dl) to let phones sign in from the browser.",
          );
      } catch (error) {
        say(
          `Reach: browser sign-in isn't available: ${error.message.split("\n")[0]}`,
        );
      }
    }
  }
}
// Setup's menus while npm rewrites node_modules: numbered ones until the
// install is done, never a half-installed menu library.
async function menusWhile(installing) {
  const { terminalPrompts } = await import("./prompts.mjs");
  return terminalPrompts({
    load: () =>
      installing.done
        ? import("prompts")
        : Promise.reject(Object.assign(Error("Still installing."), { code: "ERR_MODULE_NOT_FOUND" })),
  });
}
// The install that ran alongside setup: waited for, what it held back said,
// and how long each side took, kept in setup.log.
async function installed(installing, setupMs) {
  const { seconds } = await import("./first-start.mjs");
  const took = await installing.finish();
  stopInstall = () => {};
  process.removeListener("SIGTERM", abort);
  await tidy();
  if (!took.parts.length) return;
  console.log(`Reach: installed in ${seconds(took.ms)}, alongside your setup.`);
  try {
    fs.appendFileSync(
      path.join(state, "setup.log"),
      `\n[${new Date().toISOString()}] first start: setup ${seconds(setupMs)}, install ${seconds(took.ms)} (${took.parts.map((p) => `${p.label.replace(/ \(.*\)$/, "")} ${seconds(p.ms)}`).join(", ")})\n`,
      { mode: 0o600 },
    );
  } catch {}
}
// Logs keep their latest part; old builds of the Mac helpers go.
async function tidy() {
  try {
    const { housekeeping } = await import("./housekeeping.mjs");
    housekeeping(state, { logDirs: [path.join(state, "logs")] });
  } catch {}
}
process.once("exit", () => {
  if (locked) fs.rmSync(lockFile, { force: true });
});
const readPackage = () =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// `reach update`: the newest Reach from npm, exactly the version it shows,
// into the folder npm installed this one in; then Reach starts again on it
// the way it ran (background mode, or this window). It asks first, in
// Terminal only: run without one (an agent), it never installs, and the
// owner gets the update on the phone (Needs you) instead. Agents connected
// to this Mac pick the new version up by themselves.
async function update() {
  const { PACKAGE, installCommand, latestRelease, reachInstall } = await import("../server/reach-updates.mjs");
  const { compareVersions } = await import("../server/versions.mjs");
  const install = reachInstall(root);
  // Windows: the version you confirmed on the phone, handed to this window by
  // the Reach it updates (server/reach-updates.mjs). Asked nothing more.
  const confirmed = process.platform === "win32" ? await confirmedUpdate() : null;
  if (install.source) {
    console.log(`This is a source checkout. Move it to the newest release with git fetch --tags and git checkout v<version> (https://github.com/nalebc/reach/releases), then run ${command} restart: Reach rebuilds, and its agents follow by themselves.`);
    return;
  }
  if (install.reason === "portable") return console.log(install.manual);
  let found;
  if (confirmed) {
    found = { state: "found", version: confirmed };
    if (compareVersions(confirmed, install.version) !== 1) return console.log(`Reach ${install.version} is up to date.`);
    console.log(`Reach ${confirmed}, as you confirmed on your phone (you have ${install.version}).`);
  } else {
    found = await latestRelease();
    if (found.state === "unpublished") return console.log(`No Reach release is published yet. You have ${install.version}.`);
    if (found.state !== "found") throw Error("Couldn't reach npm to check for a newer Reach. Try again in a moment.");
    if (compareVersions(found.version, install.version) !== 1) return console.log(`Reach ${install.version} is up to date.`);
    console.log(`Reach ${found.version} is out (you have ${install.version}).`);
  }
  if (install.reason) throw Error(`Reach can't install it into its own folder. ${install.reason === "permission" ? "" : "Run: "}${install.manual.replace("@latest", `@${found.version}`)}`);
  const plan = installCommand(install, found.version);
  if (!plan) throw Error(`npm wasn't found. Run: npm install --global ${PACKAGE}@${found.version}`);
  if (!confirmed && (!process.stdin.isTTY || (await foreignApp()))) {
    console.log(`Update it from your phone (Needs you), or run ${command} update in ${process.platform === "win32" ? "a terminal" : "Terminal"}.`);
    return;
  }
  const running = (await othersRunning()).length > 0;
  const service = serviceInstalled();
  if (!confirmed) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      running || service
        ? "Install it and restart Reach? Its terminals and live screens end; agents pick it up by themselves. [y/N] "
        : "Install it? [y/N] ",
    ).catch(() => "").finally(() => rl.close());
    if (!/^y(es)?$/i.test(answer.trim())) return console.log("Nothing was installed.");
  }
  // Windows can't replace the files of a Reach that runs, nor the folder a
  // program works in: Reach stops first, and this window leaves its folder.
  const stopFirst = process.platform === "win32" && (running || service);
  if (process.platform === "win32") process.chdir(os.homedir());
  if (stopFirst) {
    console.log("Reach: stopping Reach so npm can replace its files…");
    const { stopReach } = await import("./stop.mjs");
    await stopReach(root, { yes: true });
  }
  console.log(`Reach: ${plan.display}`);
  const run = (args) =>
    new Promise((resolve, reject) => {
      child = spawn(process.execPath, args, { stdio: "inherit", ...(process.platform === "win32" && { cwd: os.homedir() }) });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error(`${path.basename(args[0])} stopped with exit code ${code}.`)),
      );
    });
  // Stopped for nothing: the Reach you had starts again, as it ran.
  const failed = async (message) => {
    if (stopFirst) {
      console.error(`\nReach: ${message}`);
      await startAgain({ service });
      process.exitCode ||= 1;
      return null;
    }
    throw Error(message);
  };
  try {
    await run([plan.file, ...plan.args]);
  } catch {
    return failed(`The update didn't finish. Run it yourself: ${plan.display}`);
  }
  if (reachInstall(root).version !== found.version) return failed(`npm finished, but Reach ${found.version} isn't in place. Run it yourself: ${plan.display}`);
  if (stopFirst) {
    console.log(`Reach ${found.version} is installed. Starting it again…`);
    return startAgain({ service });
  }
  if (service) {
    console.log("Reach: restarting background mode on the new version…");
    // The running service holds the one-Reach-per-computer lock: it stops
    // first, and the install starts it again on the new version.
    let target = null;
    if (process.platform === "darwin") {
      try {
        const { serviceState } = await import("./stop.mjs");
        const launchctl = (a) => execFileSync("/bin/launchctl", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const found = serviceState(root, { run: launchctl });
        if (found.loaded && found.ours) {
          launchctl(["bootout", found.target]);
          target = found;
        }
      } catch {}
      for (let i = 0; i < 40 && withoutHandover(await othersRunning(), state).length; i++)
        await new Promise((r) => setTimeout(r, 250));
    }
    try {
      await run([path.join(root, "scripts/bootstrap.mjs"), "install"]);
    } catch (error) {
      if (target) {
        try {
          const { startService } = await import("./stop.mjs");
          startService(root);
        } catch {}
      }
      throw error;
    }
  } else if (running) {
    // The new version's own restart: everything stops, Reach starts here.
    console.log(`Reach ${found.version} is installed. Restarting it here…`);
    process.exitCode = await new Promise((resolve) => {
      child = spawn(process.execPath, [path.join(root, "bin/reach.mjs"), "restart", "--yes"], { stdio: "inherit" });
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 0));
    });
  } else console.log(`Reach ${found.version} is installed. Start it with ${command}.`);
}
// Hand Reach over to background mode. The LaunchAgent starts its own Reach,
// which takes its own launcher lock, so this process lets go of it first.
const serviceInstalled = () => {
  try {
    return !!JSON.parse(
      fs.readFileSync(path.join(state, "service.json"), "utf8"),
    ).installed;
  } catch {
    return false;
  }
};
// A Reach started from a terminal (not the background service).
const runningElsewhere = () => {
  try {
    const host = JSON.parse(
      fs.readFileSync(path.join(state, "host-status.json"), "utf8"),
    );
    if (!host.pid || host.service || host.pid === process.pid) return false;
    process.kill(host.pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function startInBackground(options) {
  if (locked) {
    fs.rmSync(lockFile, { force: true });
    locked = false;
  }
  // The service it starts must not take this one for a second Reach.
  const handover = handoverFile(state);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(handover, String(process.pid), { mode: 0o600 });
  process.once("exit", () => {
    try {
      if (fs.readFileSync(handover, "utf8") === String(process.pid)) fs.rmSync(handover);
    } catch {}
  });
  if (process.platform === "darwin" || process.platform === "win32") {
    const { ensureRuntime } = await import("./runtime.mjs");
    await ensureRuntime(state);
  }
  const { backgroundService } = await import("./background-service.mjs");
  await backgroundService({ ...options, command: "install" }, root);
}
// `reach restart`: everything stops, then Reach starts again the way it ran:
// the background service, or in a terminal: this one, or (asked without a
// terminal, as agents do) a new Terminal window, where Reach keeps Terminal's
// Screen Recording and Accessibility and device approvals have a place.
// False means: start right here, below.
async function restart(options) {
  const { stopReach, startInWindow, startService } = await import("./stop.mjs");
  // A checkout's agents restart Reach often (each interface edit used to
  // need it): run from an agent, the restart waits for your OK on the phone.
  // Yours, in Terminal, never asks; an installed Reach has no agents editing it.
  const asker = !packaged && ((await foreignApp()) || (!process.stdin.isTTY && "an agent"));
  const running = asker ? await othersRunning() : [];
  if (asker && running.length) {
    // The running Reach's own state (it may run from another folder), then this folder's.
    let dataDir = "";
    for (const dir of [...running.filter((h) => h.root).map((h) => stateOf(h.root)), state]) {
      try {
        dataDir = JSON.parse(fs.readFileSync(path.join(dir, "host-status.json"), "utf8")).dataDir || "";
      } catch {}
      if (dataDir) break;
    }
    if (dataDir) {
      const { askRestart, askingChat } = await import("../server/restart-requests.mjs");
      const { again } = askRestart(dataDir, { app: asker, chat: askingChat() });
      console.log(
        `${again ? "Already asked" : "Asked"} on the phone (Needs you): Reach restarts when the user taps Restart. Nothing restarted yet; don't run this again.\nInterface changes (src/, public/) reach phones without a restart. Only server changes need one.`,
      );
      return true;
    }
  }
  const done = await stopReach(root, { yes: options.yes, restarting: true });
  if (done.cancelled) return true;
  if (done.service) {
    console.log("Reach's background service restarted.");
    return true;
  }
  if (!done.stopped && done.serviceInstalled) {
    startService(root);
    console.log("Reach's background service started.");
    return true;
  }
  // An agent's shell has a terminal too (Codex's does): only Terminal itself
  // holds the permissions. On Windows, Reach's own window, titled Reach, is
  // where you see it and approve new phones.
  if (["darwin", "win32"].includes(process.platform) && (!process.stdin.isTTY || (await foreignApp()))) {
    startInWindow(root, { state });
    console.log(
      process.platform === "win32"
        ? "Reach is starting in a new window of its own."
        : "Reach is starting in a new Terminal window, where it keeps its Screen Recording and Accessibility.",
    );
    return true;
  }
  options.command = undefined;
  return false;
}
try {
  let options = parseOptions(process.argv.slice(2));
  const { configure, readPreferences, applyPreferences } =
    await import("./configure.mjs");
  const { ensureTailscale } = await import("./tailscale-connect.mjs");
  if (options.version) {
    console.log(readPackage().version);
  } else if (options.help) {
    console.log(`Reach — your computer, within reach.

${command}                     Start Reach (the first run walks you through setup)
${command} setup [section]     Change your setup: account, invites, background
${command} configure           Tailscale account and file sharing (part of setup)
${command} approve             Approve a new phone on this computer
${command} invites             Set up invite keys (guests need no Tailscale app)
${command} link [name]         Link another Reach computer (approve phones once)
${command} update              Update to the latest Reach (installed with npm)
${command} import <folder>     Bring paired phones and settings from another Reach folder
${command} --version           Show the installed version
${command} cli                 Make reach a command in every Terminal
${command} install             ${process.platform === "win32" ? "Start Reach at sign-in, in the background (a scheduled task)" : "Mac: install a background LaunchAgent"}
${command} install --stay-awake Keep system/display awake while plugged in
${command} uninstall           ${process.platform === "win32" ? "Stop and remove the background task" : "Stop and remove the service and its own Serve route"}
${command} status              Where Reach runs (whichever folder), since when, its link
${command} stop                Stop every Reach on this computer: in any terminal, started
                               detached, or the background service (asks first if its
                               terminals are open; --yes closes them). One Reach runs at a time.
${command} restart             Stop them all, then start Reach again: the background
                               service, or here (in a new Terminal window if run without one)
${command} pair                Fresh one-use pairing code and QR
${command} --stay-awake         Stay awake only while plugged in
${command} --stay-awake-always  Keep system/display awake, including on battery
${command} --no-stay-awake      Allow normal idle sleep
${command} --folder /path       Share a folder (repeatable)
${command} --agent-policy FILE  Agent permission policy
${command} --local              Local access only
${command} --port 4318          Local port (service saves a fixed port)
${command} --https-port 8443    Tailscale HTTPS port

${process.platform === "win32"
  ? `Stay-awake asks Windows to keep the PC awake while Reach runs; it never changes
power settings or unlocks a locked PC. The background task starts at sign-in.`
  : `Stay-awake uses temporary power assertions; it never changes system settings
or unlocks a locked Mac. LaunchAgents run after sign-in, not before FileVault.`}
Uninstall/foreground Ctrl+C ends Reach-owned terminals and jobs.
`);
  } else if (options.command === "status") {
    // What really runs (any folder, any way), not only the background service.
    const { hosts, partial } = await reaches();
    console.log(statusText(hosts, { command, started: startedOf(hosts), partial }));
  } else if (options.command === "cli") {
    if (packaged) console.log("reach is already a command in every Terminal (installed with npm).");
    else {
      const { linkCli } = await import("./cli-link.mjs");
      const result = linkCli({ script: path.join(root, "reach") });
      console.log(result.text);
      if (!result.ok) process.exitCode = 1;
    }
  } else if (options.command === "stop") {
    const { stopReach } = await import("./stop.mjs");
    await stopReach(root, { yes: options.yes });
  } else if (options.command === "restart" && (await restart(options))) {
    // Restarted in the background, or in a new Terminal window.
  } else if (options.command === "setup") {
    if (!process.stdin.isTTY)
      throw Error(`Run ${command} setup in an interactive terminal.`);
    const { runSetup } = await import("./setup.mjs");
    const result = await runSetup(root, { only: options.setupSection });
    if (result.ran.includes("background")) {
      const installed = serviceInstalled();
      if (result.launch === "background" && !installed && runningElsewhere())
        console.log(
          `Reach is running in another terminal. Stop it there (Ctrl+C), then run ${command} setup background again to move it to the background.`,
        );
      else if (result.launch === "background" && !installed) {
        await ensureTailscale();
        options = applyPreferences(options, readPreferences(root), []);
        await startInBackground(options);
      } else if (result.launch === "login" || (result.launch === "foreground" && process.platform === "darwin")) {
        // Opening in Terminal at sign-in (a checkout in Documents), or not.
        const { loginStart } = await import("./login-start.mjs");
        if (result.launch === "login") {
          loginStart("install", { root, now: false });
          console.log("Reach opens in Terminal each time you sign in to this Mac.");
        } else if (loginStart("status", { root }).installed) {
          loginStart("uninstall", { root });
          console.log("Reach no longer opens at sign-in.");
        }
      }
      if (result.launch === "foreground" && installed)
        console.log(
          `Reach still runs in the background. To stop that: ${command} uninstall (ends its terminals and jobs).`,
        );
    }
  } else if (options.command === "configure") {
    await ensureTailscale();
    await configure(root);
  } else if (options.command === "import") {
    const { importState } = await import("./import-state.mjs");
    const copied = importState(options.importFrom, state);
    console.log(
      `Reach: imported ${copied.join(", ")} into ${state}.\nStop the Reach you imported from before starting this one.`,
    );
  } else if (options.command === "update") {
    await update();
  } else if (options.command === "link") {
    const { linkComputers } = await import("./link.mjs");
    await linkComputers(root, options.linkName);
  } else if (options.command === "invites") {
    const { setupInvites } = await import("./invites.mjs");
    await setupInvites(root);
  } else if (options.command === "approve") {
    const { approveDevice } = await import("./approve-device.mjs");
    await approveDevice(root);
  } else if (options.command === "pair") {
    const { pairRunningHost } = await import("./pairing.mjs");
    await pairRunningHost(root);
  } else if (options.command || options.background || options.stopBackground) {
    if (options.command === "install" || options.background) {
      await lock();
      // An installed reach has no ./reach script to fetch the pinned runtime;
      // on Windows, .\reach.cmd runs the PC's own Node when it has one.
      if ((packaged && process.platform === "darwin") || process.platform === "win32") {
        const { ensureRuntime } = await import("./runtime.mjs");
        await ensureRuntime(state);
      }
      if (!options.local) {
        await ensureTailscale();
        const preferences = readPreferences(root) || (await configure(root));
        options = applyPreferences(options, preferences, process.argv.slice(2));
      }
    }
    // The service it starts takes its own launcher lock: let go of this one first.
    if (locked) {
      fs.rmSync(lockFile, { force: true });
      locked = false;
    }
    const { backgroundService } = await import("./background-service.mjs");
    await backgroundService(options, root);
  } else if (!options.service && (await foreignApp())) {
    // Started from another app's shell: Reach opens in a window of its own
    // instead (Terminal on a Mac).
    const others = withoutHandover(await othersRunning(), state);
    if (others.length)
      throw Error(alreadyRunning(others, { command, started: startedOf(others) }));
    // Windows: a Reach still starting here (its folder's lock) is said here,
    // not in a window opened only to say it.
    if (process.platform === "win32") {
      await lock();
      fs.rmSync(lockFile, { force: true });
      locked = false;
    }
    const app = await foreignApp();
    const { startInWindow } = await import("./stop.mjs");
    startInWindow(root, { state });
    console.log(
      process.platform === "win32"
        ? `Reach is starting in a new window of its own: inside ${app} it would end when ${app} closes.`
        : `Reach is starting in a new Terminal window: inside ${app} it would have no Screen Recording or Accessibility (no live screen, no control).`,
    );
  } else {
    if (options.service) {
      // A start that keeps failing waits longer each time (service-backoff.mjs).
      const { serviceBackoff } = await import("./service-backoff.mjs");
      await serviceBackoff(state);
      const saved = JSON.parse(
        fs.readFileSync(path.join(state, "service.json"), "utf8"),
      );
      // Windows names the same file in any case.
      const same = (a, b) => (process.platform === "win32" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
      if (
        !saved.installed ||
        !same(saved.root, root) ||
        !same(saved.node, process.execPath) ||
        saved.options.port !== options.port
      )
        throw Error(
          `Service configuration changed. Run ${command} install again.`,
        );
      process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`;
    }
    await lock();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    // An installed package ships ready to run; only a checkout installs and
    // builds itself.
    if (packaged && !fs.existsSync("dist/index.html"))
      throw Error(
        `This installation is incomplete. Reinstall it: npm install -g ${readPackage().name}`,
      );
    // A first run in a terminal installs while its setup asks about
    // Tailscale (first-start.mjs); every other start installs first.
    const { installsWhileSetup } = await import("./first-start.mjs");
    const guided =
      installsWhileSetup({ packaged, local: options.local, service: options.service, tty: process.stdin.isTTY }) &&
      (await import("./setup.mjs")).needsOnboarding(root);
    let installing = null;
    if (guided) {
      const { installMeanwhile } = await import("./first-start.mjs");
      const stopGo = new AbortController();
      installing = installMeanwhile(
        (io) => prepare(options, { ...io, signal: stopGo.signal }),
        {
          cancel: () => {
            child?.kill();
            stopGo.abort();
          },
        },
      );
      stopInstall = () => installing.cancel();
      // Ctrl+C now pauses the setup, below; that stops the install too.
      process.removeListener("SIGINT", abort);
      console.log(
        `Reach: installing in the background while you set up (first run only; its log: ${path.join(state, "setup.log")}).`,
      );
    } else {
      const { withStartupProgress } = await import("./startup-progress.mjs");
      await withStartupProgress((io) => prepare(options, io), {
        log: path.join(state, "setup.log"),
      });
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      await tidy();
    }
    let firstRun = null;
    const detached = detachedWarning({ service: !!options.service });
    if (detached) console.warn(detached);
    if (!options.local) {
      if (packaged && !readPreferences(root))
        console.log(
          `Reach: first run here. Moving from a Reach folder you ran before? Stop now (Ctrl+C) and run "reach import <that folder>" to keep your paired phones.\n`,
        );
      // Ctrl+C while setup waits (for Tailscale, its HTTPS switch, a
      // sign-in): said, the lock goes, and the next ./reach picks up here.
      const { pauseOnInterrupt } = await import("./pause-setup.mjs");
      const stopPause =
        !options.service && process.stdin.isTTY
          ? pauseOnInterrupt({ before: stopInstall })
          : () => {};
      try {
        // First run in a terminal: the guided setup, start to finish. A
        // computer already set up (or a background service) never sees it.
        if (!options.service && process.stdin.isTTY) {
          const { needsOnboarding, runSetup } = await import("./setup.mjs");
          const setupStarted = Date.now();
          if (needsOnboarding(root))
            firstRun = await runSetup(
              root,
              installing ? { deps: { ui: await menusWhile(installing) } } : {},
            );
          if (installing) await installed(installing, Date.now() - setupStarted);
        }
        // A background service can't ask; it reports what's missing instead.
        await ensureTailscale(options.service ? { interactive: false } : {});
        const preferences = readPreferences(root) || (await configure(root));
        // Installed service arguments are its saved folder/port choices.
        if (!options.service)
          options = applyPreferences(options, preferences, process.argv.slice(2));
        if (!options.service && process.argv.includes("--https-port")) {
          const { rememberHttpsPort } = await import("./configure.mjs");
          if (rememberHttpsPort(root, options.httpsPort))
            console.log(`Reach: port ${options.httpsPort} saved; later starts use it too.`);
        }
      } catch (error) {
        // Paused or failed: an install still running here stops with it.
        stopInstall();
        throw error;
      } finally {
        stopPause();
      }
    }
    // In Documents (or the like): Reach opens in Terminal at each sign-in,
    // and runs in this one now.
    if (firstRun?.launch === "login") {
      const { loginStart } = await import("./login-start.mjs");
      loginStart("install", { root, now: false });
      console.log("Reach: it opens in Terminal each time you sign in to this Mac.");
    }
    if (firstRun?.launch === "background" && !serviceInstalled()) {
      const since = Date.now();
      await startInBackground(options);
      // Setup ends with the phone connected, as in the foreground.
      const { connectPhone } = await import("./setup.mjs");
      await connectPhone(root, { since });
    } else {
      const { launch } = await import("./launch.mjs");
      // A first run's step 3 is the phone: the launcher says when it's in.
      await launch(firstRun ? { ...options, phoneStep: true } : options, root);
    }
  }
} catch (error) {
  // A paused setup already said how to continue.
  if (error.paused) process.exitCode = 130;
  else {
    console.error(`\nReach: ${error.message}`);
    // Asked to start again at once (scripts/launch.mjs): crash-guard's
    // CRASH_EXIT, so the window that started it does (scripts/supervise.mjs).
    process.exitCode = error.relaunch ? 70 : 1;
  }
}
