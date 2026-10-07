import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getConfig } from "../server/core.mjs";
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
  const file = path.join(
    process.env.APPDATA,
    "Microsoft/Windows/Start Menu/Programs/Startup/Reach.cmd",
  );
  if (remove) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    console.log("Reach startup entry removed.");
    process.exit();
  }
  const safe = (s) => {
    if (/[\r\n%]/.test(s))
      throw Error(
        "This path cannot be used in a Windows startup script. Start Reach manually.",
      );
    return s;
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `@echo off\r\ncd /d "${safe(cwd)}"\r\nset "REACH_DATA=${safe(config.dataDir)}"\r\nset "REACH_ROOTS=${safe(config.roots.join(path.delimiter))}"\r\nset "REACH_SCREEN=${config.screen ? "1" : "0"}"\r\nstart "Reach Companion" /min "${safe(process.execPath)}" "${safe(path.join(cwd, "server/index.mjs"))}"\r\n`,
  );
  console.log("Reach will start at sign-in. Run npm start now.");
} else {
  throw Error(
    "Login service installation supports macOS and Windows. Run npm start under your service manager on Linux.",
  );
}
