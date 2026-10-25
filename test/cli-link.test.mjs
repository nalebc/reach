import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linkCli } from "../scripts/cli-link.mjs";

// `./reach cli`: `reach` in every Terminal, so `reach status`, `reach stop`
// and `reach restart` work from any folder, as with an installed CLI. The
// launcher has to find its folder through the link (before, it looked for
// scripts/ next to the link and failed).
const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reach");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-cli-")));

test("links reach into a folder on PATH; the link runs this Reach and its hints say reach", { skip: process.platform === "win32" ? "POSIX shell launcher" : false }, () => {
  const home = scratch();
  const bin = path.join(home, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  const env = { PATH: bin };
  const result = linkCli({ script: launcher, env, home });
  assert.equal(result.ok, true);
  assert.equal(fs.realpathSync(path.join(bin, "reach")), fs.realpathSync(launcher));
  assert.match(result.text, /reach now works in any Terminal/);
  const help = execFileSync(path.join(bin, "reach"), ["--help"], { encoding: "utf8", env: { ...process.env, REACH_COMMAND: "" } });
  assert.match(help, /^reach status +Where Reach runs/m);
  assert.match(help, /^reach cli +Make reach a command/m);
  // Again: nothing to do.
  assert.match(linkCli({ script: launcher, env, home }).text, /already runs this Reach/);
});

// A link, as on a Mac or Linux. Windows has none: there reach cli writes a
// reach.cmd (windowsCli, scripts/cli-link.mjs), the test after this one.
test("replaces a link to another Reach folder, leaves anything else alone", { skip: process.platform === "win32" ? "no links on Windows: its reach.cmd is the next test" : false }, () => {
  const home = scratch();
  const bin = path.join(home, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  const older = path.join(home, "old reach");
  fs.mkdirSync(path.join(older, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(older, "scripts/bootstrap.mjs"), "");
  fs.writeFileSync(path.join(older, "reach"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(path.join(older, "reach"), path.join(bin, "reach"));
  const moved = linkCli({ script: launcher, env: { PATH: bin }, home });
  assert.equal(moved.ok, true);
  assert.match(moved.text, /It pointed to .*old reach[/\\]reach before/);
  assert.equal(fs.realpathSync(path.join(bin, "reach")), fs.realpathSync(launcher));

  fs.unlinkSync(path.join(bin, "reach"));
  fs.writeFileSync(path.join(bin, "reach"), "someone else's tool");
  const refused = linkCli({ script: launcher, env: { PATH: bin }, home });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /is something else, not Reach/);
  assert.equal(fs.readFileSync(path.join(bin, "reach"), "utf8"), "someone else's tool");
});

// The same on a Windows PC's own disk: a reach.cmd that starts another Reach
// folder (an older checkout) is pointed here; anything else is left alone.
test("Windows: replaces another Reach folder's reach.cmd, leaves anything else alone", { skip: process.platform !== "win32" ? "a Windows PC's reach.cmd; a link elsewhere (the test before)" : false }, () => {
  const home = scratch();
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const older = path.join(home, "old reach");
  fs.mkdirSync(path.join(older, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(older, "scripts", "bootstrap.mjs"), "");
  fs.writeFileSync(path.join(older, "reach.cmd"), "@echo off\r\n");
  const shim = path.join(bin, "reach.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"%USERPROFILE%\\old reach\\reach.cmd" %*\r\n`);
  const env = { Path: bin, USERPROFILE: home };
  const moved = linkCli({ script: launcher, env, home });
  assert.equal(moved.ok, true, moved.text);
  assert.equal(moved.at, shim);
  assert.match(moved.text, /It started .*old reach\\reach\.cmd before/);
  assert.equal(fs.readFileSync(shim, "utf8"), `@echo off\r\n"${path.join(path.dirname(launcher), "reach.cmd").replace(/%/g, "%%")}" %*\r\n`);
  assert.equal(linkCli({ script: launcher, env, home }).already, true);

  fs.writeFileSync(shim, "@echo off\r\necho mine\r\n");
  const refused = linkCli({ script: launcher, env, home });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /is something else, not Reach/);
  assert.equal(fs.readFileSync(shim, "utf8"), "@echo off\r\necho mine\r\n");
});

test("with no folder of yours on PATH, says how to add one and links nothing", () => {
  const home = scratch();
  // A Mac's advice; Windows' (PowerShell's) is checked below.
  const result = linkCli({ script: launcher, env: { PATH: "/usr/bin:/bin" }, home, platform: "darwin" });
  assert.equal(result.ok, false);
  assert.match(result.text, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.equal(fs.existsSync(path.join(home, ".local/bin/reach")), false);
});

// Windows (parity audit #44): no symlink (it needs Developer Mode, and cmd
// and PowerShell can't run the sh launcher); a reach.cmd that starts this
// folder's goes into a folder on PATH that's yours, and the advice is
// PowerShell's, not ~/.zshrc.
test("Windows: reach cli writes a reach.cmd into a PATH folder you own, and says so in Windows' words", () => {
  const disk = new Map();
  const dirsOn = new Set();
  const files = {
    existsSync: (p) => disk.has(p.toLowerCase()) || dirsOn.has(p.toLowerCase()),
    accessSync: (p) => { if (!dirsOn.has(p.toLowerCase())) throw Error("EACCES"); },
    readFileSync: (p) => { if (!disk.has(p.toLowerCase())) throw Error("ENOENT"); return disk.get(p.toLowerCase()); },
    writeFileSync: (p, text, { flag } = {}) => {
      if (flag === "wx" && disk.has(p.toLowerCase())) throw Object.assign(Error("EEXIST"), { code: "EEXIST" });
      disk.set(p.toLowerCase(), text);
    },
  };
  const home = "C:\\Users\\Sam";
  const apps = "C:\\Users\\Sam\\AppData\\Local\\Microsoft\\WindowsApps";
  const env = { Path: `C:\\Windows\\system32;${apps}`, LOCALAPPDATA: "C:\\Users\\Sam\\AppData\\Local" };
  const script = "C:\\Users\\Sam\\code\\reach\\reach";
  // No PATH folder of yours: PowerShell's two lines, never a shell profile.
  const none = linkCli({ script, env, home, files, platform: "win32" });
  assert.equal(none.ok, false);
  assert.match(none.text, /SetEnvironmentVariable\("Path"/);
  assert.doesNotMatch(none.text, /zshrc|export PATH/);
  // WindowsApps is on PATH and yours: the shim goes there.
  dirsOn.add(apps.toLowerCase());
  const made = linkCli({ script, env, home, files, platform: "win32" });
  assert.equal(made.ok, true, made.text);
  assert.equal(made.at, `${apps}\\reach.cmd`);
  // Written from %USERPROFILE%: cmd reads the file in the old code page.
  assert.equal(disk.get(`${apps}\\reach.cmd`.toLowerCase()), '@echo off\r\n"%USERPROFILE%\\code\\reach\\reach.cmd" %*\r\n');
  assert.match(made.text, /PowerShell or Command Prompt/);
  assert.equal(linkCli({ script, env, home, files, platform: "win32" }).already, true);
  // Something else named reach.cmd is left alone.
  disk.set(`${apps}\\reach.cmd`.toLowerCase(), "@echo off\r\necho mine\r\n");
  assert.match(linkCli({ script, env, home, files, platform: "win32" }).text, /something else, not Reach/);
  assert.equal(disk.get(`${apps}\\reach.cmd`.toLowerCase()), "@echo off\r\necho mine\r\n");
  // An accented user name is fine (cmd expands %USERPROFILE% itself); a %
  // is doubled; accents outside the profile can't be written, so it says so.
  disk.clear();
  const joseApps = "C:\\Users\\José\\AppData\\Local\\Microsoft\\WindowsApps";
  const jose = { Path: joseApps, LOCALAPPDATA: "C:\\Users\\José\\AppData\\Local", USERPROFILE: "C:\\Users\\José" };
  dirsOn.add(joseApps.toLowerCase());
  const mine = { script: "C:\\Users\\José\\100% done\\reach\\reach", env: jose, home: "C:\\Users\\José", files, platform: "win32" };
  const accented = linkCli(mine);
  assert.equal(accented.ok, true, accented.text);
  assert.equal(disk.get(`${joseApps}\\reach.cmd`.toLowerCase()), '@echo off\r\n"%USERPROFILE%\\100%% done\\reach\\reach.cmd" %*\r\n');
  assert.equal(linkCli(mine).already, true);
  disk.clear();
  const outside = linkCli({ script: "D:\\Projets\\Été\\reach\\reach", env, home, files, platform: "win32" });
  assert.equal(outside.ok, false);
  assert.match(outside.text, /can't hold/);
  assert.equal(disk.size, 0, "nothing written that wouldn't work");
});

// CodeQL #251: Reach looked for a reach.cmd, then wrote one; a reach.cmd made
// in between (another tool's) was overwritten. Now it's written only where
// none is, or over another Reach folder's shim it has just read.
test("Windows: a reach.cmd made after Reach looked is left alone", () => {
  const apps = "C:\\Users\\Sam\\AppData\\Local\\Microsoft\\WindowsApps";
  const at = `${apps}\\reach.cmd`.toLowerCase();
  const disk = new Map();
  let looked = false;
  const files = {
    existsSync: (p) => {
      if (p.toLowerCase() === at && !disk.has(at)) looked = true;
      return disk.has(p.toLowerCase()) || p.toLowerCase() === apps.toLowerCase();
    },
    accessSync: () => {},
    readFileSync: (p) => { if (!disk.has(p.toLowerCase())) throw Object.assign(Error("ENOENT"), { code: "ENOENT" }); return disk.get(p.toLowerCase()); },
    writeFileSync: (p, text, { flag } = {}) => {
      // Another tool's reach.cmd lands right after Reach found none.
      if (looked && !disk.has(at)) disk.set(at, "@echo off\r\necho mine\r\n");
      if (flag === "wx" && disk.has(p.toLowerCase())) throw Object.assign(Error("EEXIST"), { code: "EEXIST" });
      disk.set(p.toLowerCase(), text);
    },
  };
  const env = { Path: apps, LOCALAPPDATA: "C:\\Users\\Sam\\AppData\\Local" };
  const result = linkCli({ script: "C:\\Users\\Sam\\code\\reach\\reach", env, home: "C:\\Users\\Sam", files, platform: "win32" });
  assert.equal(result.ok, false);
  assert.match(result.text, /something else, not Reach/);
  assert.equal(disk.get(at), "@echo off\r\necho mine\r\n");
});
