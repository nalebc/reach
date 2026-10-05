// Starting Reach when you sign in to the Mac, as you start it yourself: a
// Terminal window running ./reach. Reach's permissions (Screen Recording,
// Accessibility, the Documents folder it lives in) belong to Terminal; a job
// launchd starts on its own has none of them, and the background agent failed
// at every attempt (exit 78: launchd couldn't use its folder in Documents).
// So the login agent only opens a start script, kept outside Documents, in
// Terminal. Usage: node scripts/login-start.mjs install|uninstall|status
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const loginLabel = "com.reach.login";
// The background agent this replaces (scripts/background-service.mjs).
const companionLabel = "com.reach.companion";
const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shell = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Run by Terminal at sign-in. Terminal doesn't pass on your shell's PATH,
// so Node's folder is written in; the window closes when Reach ends (also
// when it was already running).
export function loginScript(root, nodeDir) {
  return [
    "#!/bin/bash",
    "# Reach: opened in Terminal at sign-in (com.reach.login). Remove with:",
    `#   node ${shell(path.join(root, "scripts/login-start.mjs"))} uninstall`,
    `export PATH=${shell(nodeDir)}:/opt/homebrew/bin:/usr/local/bin:$PATH`,
    `cd ${shell(root)} || exit 1`,
    "./reach",
    "exit 0",
    "",
  ].join("\n");
}

export function loginPlist(script) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${loginLabel}</string>
<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>Terminal</string><string>${xml(script)}</string></array>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>WorkingDirectory</key><string>/</string>
</dict></plist>
`;
}

export function loginStart(command, { root, home = os.homedir(), uid = process.getuid(), nodeDir = path.dirname(process.execPath), run, platform = process.platform } = {}) {
  if (platform !== "darwin") throw Error("Starting Reach at sign-in this way is for macOS.");
  const launchctl =
    run || ((args) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const agents = path.join(home, "Library/LaunchAgents");
  const plist = path.join(agents, `${loginLabel}.plist`);
  const script = path.join(home, "Library/Application Support/Reach/start-at-login.command");
  const domain = `gui/${uid}`;
  const loaded = (label) => {
    try {
      launchctl(["print", `${domain}/${label}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (command === "status") return { installed: fs.existsSync(plist) && fs.existsSync(script), loaded: loaded(loginLabel), script, plist };
  if (command === "uninstall") {
    if (loaded(loginLabel)) launchctl(["bootout", `${domain}/${loginLabel}`]);
    fs.rmSync(plist, { force: true });
    fs.rmSync(script, { force: true });
    return { installed: false };
  }
  if (command !== "install") throw Error("Use install, uninstall or status.");
  // The background agent from this folder retries every 15 s and never
  // starts; it's stopped, and its file kept in .reach/backups.
  const companion = path.join(agents, `${companionLabel}.plist`);
  let replaced = false;
  if (fs.existsSync(companion) && fs.readFileSync(companion, "utf8").includes(`<string>${xml(root)}</string>`)) {
    if (loaded(companionLabel)) launchctl(["bootout", `${domain}/${companionLabel}`]);
    const backups = path.join(root, ".reach/backups");
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    fs.renameSync(companion, path.join(backups, `${companionLabel}.plist`));
    replaced = true;
  }
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, loginScript(root, nodeDir), { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(plist, loginPlist(script), { mode: 0o644 });
  // Loaded now (it opens Terminal once; a Reach already running just says so
  // and that window closes) and again at every sign-in.
  if (loaded(loginLabel)) launchctl(["bootout", `${domain}/${loginLabel}`]);
  launchctl(["bootstrap", domain, plist]);
  return { installed: true, replaced, script, plist };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = loginStart(process.argv[2] || "status", { root });
    console.log(
      process.argv[2] === "install"
        ? `Reach opens in Terminal when you sign in.${result.replaced ? " The background agent that couldn't start was stopped (its file is in .reach/backups)." : ""}`
        : process.argv[2] === "uninstall"
          ? "Reach no longer opens at sign-in."
          : `Opens at sign-in: ${result.installed ? "yes" : "no"}`,
    );
  } catch (e) {
    console.error(`Reach: ${e.message}`);
    process.exit(1);
  }
}
