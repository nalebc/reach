import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { parseOptions } from "./launcher-options.mjs";
import { command, packaged, stateDir } from "./home.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const state = stateDir(root);
let locked = false;
const lockFile = path.join(state, "launcher.lock");
let child;
const abort = () => {
  child?.kill();
  process.exit(130);
};
function lock() {
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
  } catch {}
  try {
    const previous = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (
      bootSession &&
      previous.bootSession &&
      bootSession !== previous.bootSession
    ) {
      // A PID from an earlier boot may now belong to an unrelated process.
      fs.unlinkSync(lockFile);
    } else
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") fs.unlinkSync(lockFile);
        else throw error;
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
        "Reach is already starting or running from this folder. Use its existing terminal.",
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
    if (process.platform !== "win32") return fs.realpathSync(candidate);
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
  try {
    await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [npmCli(), ...args], {
        cwd: root,
        stdio: ["ignore", fd, fd],
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`Setup failed. See ${log} for details.`)),
      );
    });
  } finally {
    fs.closeSync(fd);
    child = null;
  }
}
process.once("exit", () => {
  if (locked) fs.rmSync(lockFile, { force: true });
});
const readPackage = () =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// `reach update`: npm replaces the installed package; background mode is
// reinstalled so it runs the new version.
async function update() {
  if (!packaged) {
    console.log(
      "This is a source checkout. Update it with git pull, then run ./reach.",
    );
    return;
  }
  const { name } = readPackage();
  console.log(`Reach: updating ${name}…`);
  const run = (args) =>
    new Promise((resolve, reject) => {
      child = spawn(process.execPath, args, { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(code)));
    });
  try {
    await run([npmCli(), "install", "--global", `${name}@latest`]);
  } catch {
    throw Error(
      `The update didn't finish. Run it yourself: npm install --global ${name}@latest`,
    );
  }
  let service = null;
  try {
    service = JSON.parse(
      fs.readFileSync(path.join(state, "service.json"), "utf8"),
    );
  } catch {}
  if (service?.installed) {
    console.log("Reach: restarting background mode on the new version…");
    await run([path.join(root, "scripts/bootstrap.mjs"), "install"]);
  } else console.log("Reach is up to date. Restart it to use the new version.");
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

${command}                     Foreground private Tailscale connection
${command} configure           Guided Tailscale account and phone setup
${command} approve             Approve a new phone on this computer
${command} invites             Set up invite keys (guests need no Tailscale app)
${command} update              Update to the latest Reach (installed with npm)
${command} import <folder>     Bring paired phones and settings from another Reach folder
${command} --version           Show the installed version
${command} install             Mac: install a background LaunchAgent
${command} install --stay-awake Keep system/display awake while plugged in
${command} uninstall           Stop and remove the service and its own Serve route
${command} status              Running/stopped, private link, and logs
${command} pair                Fresh one-use pairing code and QR
${command} --stay-awake         Stay awake only while plugged in
${command} --stay-awake-always  Keep system/display awake, including on battery
${command} --no-stay-awake      Allow normal idle sleep
${command} --folder /path       Share a folder (repeatable)
${command} --agent-policy FILE  Agent permission policy
${command} --local              Local access only
${command} --port 4318          Local port (service saves a fixed port)
${command} --https-port 8443    Tailscale HTTPS port

Stay-awake uses temporary power assertions; it never changes system settings
or unlocks a locked Mac. LaunchAgents run after sign-in, not before FileVault.
Uninstall/foreground Ctrl+C ends Reach-owned terminals and jobs.
`);
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
      lock();
      // An installed reach has no ./reach script to fetch the pinned runtime.
      if (packaged && process.platform === "darwin") {
        const { ensureRuntime } = await import("./runtime.mjs");
        await ensureRuntime(state);
      }
      if (!options.local && process.platform !== "win32") {
        await ensureTailscale();
        const preferences = readPreferences(root) || (await configure(root));
        options = applyPreferences(options, preferences, process.argv.slice(2));
      }
    }
    const { backgroundService } = await import("./background-service.mjs");
    await backgroundService(options, root);
  } else {
    if (options.service) {
      const saved = JSON.parse(
        fs.readFileSync(path.join(state, "service.json"), "utf8"),
      );
      if (
        !saved.installed ||
        saved.root !== root ||
        saved.node !== process.execPath ||
        saved.options.port !== options.port
      )
        throw Error(
          `Service configuration changed. Run ${command} install again.`,
        );
      process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`;
    }
    lock();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    // An installed package ships ready to run; only a checkout installs and
    // builds itself.
    if (packaged && !fs.existsSync("dist/index.html"))
      throw Error(
        `This installation is incomplete. Reinstall it: npm install -g ${readPackage().name}`,
      );
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
    if (
      !packaged &&
      (stamp.dependencies !== dependencies ||
        !fs.existsSync("node_modules/.package-lock.json"))
    ) {
      console.log("Reach: installing dependencies (first run or update)…");
      await npm(["ci", "--no-audit", "--no-fund"]);
    }
    if (
      !packaged &&
      (stamp.dependencies !== dependencies ||
        stamp.source !== source ||
        !fs.existsSync("dist/index.html"))
    ) {
      console.log("Reach: preparing the phone interface…");
      await npm(["run", "build"]);
    }
    if (!packaged)
      fs.writeFileSync(stampFile, JSON.stringify({ dependencies, source }), {
        mode: 0o600,
      });
    // The browser sign-in client, for phones without the Tailscale app.
    if (!packaged && !options.local) {
      const { buildTailnet, tailnetCurrent } = await import("./build-tailnet.mjs");
      if (!tailnetCurrent()) {
        console.log("Reach: preparing browser sign-in for phones (first run or update, about 2 minutes)…");
        try {
          if (!(await buildTailnet()))
            console.log(
              "Reach: Go isn't installed, so phones need the Tailscale app. Install Go (https://go.dev/dl) to let phones sign in from the browser.",
            );
        } catch (error) {
          console.log(`Reach: browser sign-in isn't available: ${error.message.split("\n")[0]}`);
        }
      }
    }
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (!options.local && process.platform !== "win32") {
      if (packaged && !readPreferences(root))
        console.log(
          `Reach: first run here. Moving from a Reach folder you ran before? Stop now (Ctrl+C) and run "reach import <that folder>" to keep your paired phones.\n`,
        );
      // A background service can't ask; it reports what's missing instead.
      await ensureTailscale(options.service ? { interactive: false } : {});
      const preferences = readPreferences(root) || (await configure(root));
      // Installed service arguments are its saved folder/port choices.
      if (!options.service)
        options = applyPreferences(options, preferences, process.argv.slice(2));
    }
    const { launch } = await import("./launch.mjs");
    await launch(options, root);
  }
} catch (error) {
  console.error(`\nReach: ${error.message}`);
  process.exitCode = 1;
}
