import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { parseOptions } from "./launcher-options.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const stateDir = path.join(root, ".reach");
let locked = false;
const lockFile = path.join(stateDir, "launcher.lock");
let child;
const abort = () => {
  child?.kill();
  process.exit(130);
};
function lock() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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
  const log = path.join(stateDir, "setup.log");
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
try {
  let options = parseOptions(process.argv.slice(2));
  const { configure, readPreferences, applyPreferences } =
    await import("./configure.mjs");
  if (options.help) {
    console.log(`Reach — your computer, within reach.

./reach                     Foreground private Tailscale connection
./reach configure           Guided Tailscale account and phone setup
./reach approve             Approve a new phone on this computer
./reach install             Mac: install a background LaunchAgent
./reach install --stay-awake Keep system/display awake while plugged in
./reach uninstall           Stop and remove the service and its own Serve route
./reach status              Running/stopped, private link, and logs
./reach pair                Fresh one-use pairing code and QR
./reach --stay-awake         Stay awake only while plugged in
./reach --stay-awake-always  Keep system/display awake, including on battery
./reach --no-stay-awake      Allow normal idle sleep
./reach --folder /path       Share a folder (repeatable)
./reach --agent-policy FILE  Agent permission policy
./reach --local              Local access only
./reach --port 4318          Local port (service saves a fixed port)
./reach --https-port 8443    Tailscale HTTPS port

Stay-awake uses temporary power assertions; it never changes system settings
or unlocks a locked Mac. LaunchAgents run after sign-in, not before FileVault.
Uninstall/foreground Ctrl+C ends Reach-owned terminals and jobs.
`);
  } else if (options.command === "configure") {
    await configure(root);
  } else if (options.command === "approve") {
    const { approveDevice } = await import("./approve-device.mjs");
    await approveDevice(root);
  } else if (options.command === "pair") {
    const { pairRunningHost } = await import("./pairing.mjs");
    await pairRunningHost(root);
  } else if (options.command || options.background || options.stopBackground) {
    if (options.command === "install" || options.background) {
      lock();
      if (!options.local && process.platform !== "win32") {
        const preferences = readPreferences(root) || (await configure(root));
        options = applyPreferences(options, preferences, process.argv.slice(2));
      }
    }
    const { backgroundService } = await import("./background-service.mjs");
    await backgroundService(options, root);
  } else {
    if (options.service) {
      const saved = JSON.parse(
        fs.readFileSync(path.join(stateDir, "service.json"), "utf8"),
      );
      if (
        !saved.installed ||
        saved.root !== root ||
        saved.node !== process.execPath ||
        saved.options.port !== options.port
      )
        throw Error(
          "Service configuration changed. Reinstall Reach from this checkout.",
        );
      process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`;
    }
    lock();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const stampFile = path.join(stateDir, "setup.json");
    let stamp = {};
    try {
      stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
    } catch {}
    const dependencies = `${digest(["package.json", "package-lock.json"])}:${process.versions.modules}:${process.platform}:${process.arch}`;
    const source = digest([
      "src",
      "public",
      "index.html",
      "vite.config.mjs",
      "tsconfig.json",
    ]);
    if (
      stamp.dependencies !== dependencies ||
      !fs.existsSync("node_modules/.package-lock.json")
    ) {
      console.log("Reach: installing dependencies (first run or update)…");
      await npm(["ci", "--no-audit", "--no-fund"]);
    }
    if (
      stamp.dependencies !== dependencies ||
      stamp.source !== source ||
      !fs.existsSync("dist/index.html")
    ) {
      console.log("Reach: preparing the phone interface…");
      await npm(["run", "build"]);
    }
    fs.writeFileSync(stampFile, JSON.stringify({ dependencies, source }), {
      mode: 0o600,
    });
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (!options.local && process.platform !== "win32") {
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
