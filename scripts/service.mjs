import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getConfig } from "../server/core.mjs";
import { command } from "./home.mjs";
import { removeLegacyStartup } from "./windows-task.mjs";
const cwd = process.cwd(),
  config = getConfig(),
  remove = process.argv[2] === "uninstall";
const xml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
if (process.platform === "darwin") {
  const file = path.join(
    os.homedir(),
    "Library/LaunchAgents/com.reach.companion.plist",
  );
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/com.reach.companion`], {
      stdio: "ignore",
    });
  } catch {}
  if (remove) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    console.log("Reach login service removed.");
    process.exit();
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  for (const name of ["companion.log", "companion-error.log"]) {
    const fd = fs.openSync(path.join(config.dataDir, name), "a", 0o600);
    fs.closeSync(fd);
  }
  const env = {
    PATH: process.env.PATH,
    REACH_DATA: config.dataDir,
    REACH_ROOTS: config.roots.join(path.delimiter),
    REACH_NAME: config.name,
    REACH_SCREEN: config.screen ? "1" : "0",
    PORT: String(config.port),
  };
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.reach.companion</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(cwd, "server/index.mjs"))}</string></array><key>WorkingDirectory</key><string>${xml(cwd)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
    env,
  )
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join(
      "",
    )}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(path.join(config.dataDir, "companion.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(config.dataDir, "companion-error.log"))}</string></dict></plist>`;
  fs.writeFileSync(file, plist, { mode: 0o600 });
  execFileSync("launchctl", ["bootstrap", domain, file]);
  console.log(
    "Reach now starts when you sign in. Run npm run pair to connect a browser.",
  );
} else if (process.platform === "win32") {
  // Background mode on Windows is reach install (scripts/background-service.mjs):
  // a task that runs the real launcher at sign-in. The Startup entry this
  // script used to write ran server/index.mjs alone (no launcher, no lock,
  // no phone link) and would start a second Reach at every sign-in: only
  // removed here.
  const removed = removeLegacyStartup();
  if (remove) {
    console.log(removed ? "Reach's old startup entry removed." : "There's no old startup entry to remove.");
    process.exit();
  }
  console.error(`On Windows, background mode is ${command} install (or ${command} setup background).${removed ? " The old startup entry was removed." : ""}`);
  process.exitCode = 1;
} else {
  throw Error(
    "Login service installation supports macOS and Windows. Run npm start under your service manager on Linux.",
  );
}
