// Reach's background task on Windows: what the LaunchAgent is on a Mac
// (scripts/background-service.mjs). A Scheduled Task of yours that starts
// when you sign in, in your session: an InteractiveToken logon ("run only
// when the user is logged on"), never a batch, S4U or saved-password one,
// which has no desktop (no live screen, no control) and which Tailscale's
// service won't answer about Reach's private route (scripts/native/
// tailscaled-peer.cs: its service lets interactive and service logons ask,
// not batch ones), so browser sign-in would fall back to pairing codes.
// Least privilege, no time limit, on battery too, started again if it fails
// to start. It runs Reach's starter (scripts/native/background.cs), which
// runs the real launcher with --service and no window, and starts it again
// when it ends unexpectedly.
// Everything goes through Windows' own schtasks.exe and whoami.exe, from the
// Windows folder, never PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { windowsPath } from "../server/app-identity.mjs";
import { accountSid } from "../server/windows-private-folder.mjs";

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
export const systemFolder = (env = process.env) => {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  return windowsPath(root) ? path.win32.join(root, "System32") : "";
};
// One task per Windows account (task names are the PC's, not yours), as
// Windows' own per-user tasks are named.
export const taskName = (sid) => `Reach-${sid}`;
// Which Reach folder installed it: a name the task carries (its Source), in
// ASCII, so schtasks' code page can't spoil it.
export const taskMarker = (root) => `Reach ${crypto.createHash("sha256").update(path.win32.resolve(String(root)).toLowerCase()).digest("hex").slice(0, 16)}`;
// While this file exists, the starter doesn't start Reach again: stop, uninstall
// and update write it first. Your own app data, whichever folder runs Reach.
export const holdFile = (env = process.env) =>
  path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Reach", "background.hold");

// Element text only (no value goes in an attribute).
const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// An argument as the C runtime reads it back (the starter does; Node does).
export function windowsArg(value) {
  const arg = String(value);
  if (arg.length && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  for (let i = 0; ; i++) {
    let slashes = 0;
    while (i < arg.length && arg[i] === "\\") (i++, slashes++);
    if (i === arg.length) {
      quoted += "\\".repeat(slashes * 2);
      break;
    }
    quoted += arg[i] === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${arg[i]}`;
  }
  return `${quoted}"`;
}
// The task, as Task Scheduler reads it (schema 1.2: Windows 7 and later).
export function taskXml({ sid, starter, args, root, profile = "" }) {
  if (!SID.test(String(sid))) throw Error("Reach couldn't tell which Windows account it runs as.");
  // Task Scheduler reads %…% in a program's arguments as a variable.
  const odd = [starter, root, profile, ...args].find((value) => /[%\r\n]/.test(String(value)));
  if (odd !== undefined) throw Error(`Windows' Task Scheduler would change ${odd}: its path has a % sign. Move Reach to a folder without one to use background mode.`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Reach</Author>
    <Description>${xml(`Reach in the background, from ${root}: it starts when you sign in. Remove it with reach uninstall.`)}</Description>
    <Source>${xml(taskMarker(root))}</Source>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${sid}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(starter)}</Command>
      <Arguments>${xml(args.map(windowsArg).join(" "))}</Arguments>${profile ? `
      <WorkingDirectory>${xml(profile)}</WorkingDirectory>` : ""}
    </Exec>
  </Actions>
</Task>
`;
}
// What schtasks says, in whichever encoding it chose.
export const decodeOutput = (buffer) => {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""));
  const wide = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0 && bytes[3] === 0);
  return (wide ? bytes.toString("utf16le") : bytes.toString("latin1")).replace(/^﻿/, "");
};

// The task's operations. `run(file, args)` runs a program and returns its
// output as a Buffer, or throws when it fails. `name`: tests only.
export function windowsTask({
  env = process.env,
  run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30000 }),
  name: fixedName = "",
} = {}) {
  const system = systemFolder(env);
  const program = (name) => {
    if (!system) throw Error("Reach couldn't find the Windows folder on this PC.");
    return path.win32.join(system, name);
  };
  let sid = "";
  const account = () => {
    if (sid) return sid;
    const whoami = program("whoami.exe");
    try {
      // whoami's CSV: only its SID is read (server/windows-private-folder.mjs).
      sid = accountSid(decodeOutput(run(whoami, ["/user", "/fo", "csv", "/nh"])));
    } catch {}
    if (!sid) throw Error("Reach couldn't tell which Windows account it runs as.");
    return sid;
  };
  const schtasks = (args) => decodeOutput(run(program("schtasks.exe"), args));
  const name = () => fixedName || taskName(account());
  const ops = {
    sid: account,
    name,
    // Installed, and whether it's this folder's (its marker); the folder it
    // names when it's another's.
    state(root) {
      const task = name();
      let text;
      try {
        text = schtasks(["/Query", "/TN", task, "/XML"]);
      } catch {
        return { installed: false, ours: false, name: task };
      }
      const folder = (text.match(/<Description>Reach in the background, from ([^<]*?): it starts/) || [])[1] || "";
      return { installed: true, ours: !!root && text.includes(taskMarker(root)), name: task, folder: folder.replace(/&amp;/g, "&") };
    },
    create(file) {
      schtasks(["/Create", "/TN", name(), "/XML", file]);
    },
    run() {
      schtasks(["/Run", "/TN", name()]);
    },
    // Ends the starter (Task Scheduler's own stop); the Reach it ran was
    // asked to stop first.
    end() {
      try {
        schtasks(["/End", "/TN", name()]);
      } catch {}
    },
    remove() {
      schtasks(["/Delete", "/TN", name(), "/F"]);
    },
    hold() {
      const file = holdFile(env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(Date.now()));
    },
    release() {
      fs.rmSync(holdFile(env), { force: true });
    },
  };
  return ops;
}
// The task as stop.mjs and restart use it, ready only when they need it
// (whoami and schtasks run then, not before).
export const backgroundTask = (deps) => {
  let task = null;
  const get = () => (task ||= windowsTask(deps));
  const quiet = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    state: (root) => quiet(() => get().state(root)) || { installed: false, ours: false },
    hold: () => quiet(() => get().hold()),
    release: () => quiet(() => get().release()),
    end: () => quiet(() => get().end()),
    run: () => get().run(),
  };
};

// The Startup-folder entry `npm run install-service` used to write: it ran
// server/index.mjs alone (no launcher, no phone link, no lock), and would
// start a second Reach at every sign-in. Removed by reach install and
// uninstall; anything else of that name is left alone.
export function legacyStartup(env = process.env) {
  const appData = env.APPDATA;
  if (!appData) return null;
  const file = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Reach.cmd");
  try {
    const text = fs.readFileSync(file, "utf8");
    return /server[\\/]index\.mjs/.test(text) && /Reach Companion/.test(text) ? file : null;
  } catch {
    return null;
  }
}
export function removeLegacyStartup(env = process.env) {
  const file = legacyStartup(env);
  if (file) fs.rmSync(file, { force: true });
  return !!file;
}
