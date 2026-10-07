import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loginLabel, loginPlist, loginScript, loginStart } from "../scripts/login-start.mjs";

const setup = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-login-"));
  const root = path.join(home, "Documents", "it's reach");
  fs.mkdirSync(root, { recursive: true });
  const calls = [];
  const loaded = new Set();
  const run = (args) => {
    calls.push(args);
    const [verb, target] = args;
    if (verb === "print" && !loaded.has(target)) throw Error("not loaded");
    if (verb === "bootout") loaded.delete(target);
    if (verb === "bootstrap") loaded.add(`${target}/${loginLabel}`);
    return "";
  };
  return { home, root, calls, loaded, run, uid: 501, nodeDir: "/opt/homebrew/Cellar/node/23.7.0/bin", platform: "darwin" };
};

test("at sign-in Reach opens in Terminal (which holds its permissions), from a script kept outside Documents", () => {
  const mac = setup();
  const result = loginStart("install", mac);
  const script = path.join(mac.home, "Library/Application Support/Reach/start-at-login.command");
  const plist = path.join(mac.home, "Library/LaunchAgents/com.reach.login.plist");
  assert.equal(result.installed, true);
  // The script: Node's folder on the PATH (Terminal doesn't pass yours on), then ./reach in its folder.
  const text = fs.readFileSync(script, "utf8");
  assert.match(text, /^#!\/bin\/bash\n/);
  assert.ok(text.includes(`export PATH='${mac.nodeDir}':/opt/homebrew/bin:/usr/local/bin:$PATH`));
  assert.ok(text.includes(`cd '${mac.root.replace(/'/g, `'\\''`)}' || exit 1\n./reach\nexit 0\n`));
  if (process.platform !== "win32") assert.equal(fs.statSync(script).mode & 0o777, 0o700);
  // The agent only opens it in Terminal, once per sign-in, never restarting it.
  const agent = fs.readFileSync(plist, "utf8");
  assert.ok(agent.includes(`<string>/usr/bin/open</string><string>-a</string><string>Terminal</string><string>${script.replace(/'/g, "'")}</string>`));
  assert.ok(agent.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(!agent.includes("KeepAlive"));
  assert.ok(agent.includes("<key>WorkingDirectory</key><string>/</string>"));
  if (process.platform === "darwin") execFileSync("/usr/bin/plutil", ["-lint", plist]);
  assert.deepEqual(mac.calls.at(-1), ["bootstrap", "gui/501", plist]);
  assert.equal(loginStart("status", mac).loaded, true);
  // Off again.
  loginStart("uninstall", mac);
  assert.equal(fs.existsSync(plist) || fs.existsSync(script), false);
  assert.deepEqual(mac.calls.at(-1), ["bootout", "gui/501/com.reach.login"]);
  assert.deepEqual(loginStart("status", mac), { installed: false, loaded: false, script, plist });
});

test("the background agent that can't start is stopped and kept aside; another folder's is left alone", () => {
  const mac = setup();
  const agents = path.join(mac.home, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const companion = path.join(agents, "com.reach.companion.plist");
  fs.writeFileSync(companion, `<plist><dict><key>WorkingDirectory</key><string>${mac.root}</string></dict></plist>`);
  mac.loaded.add("gui/501/com.reach.companion");
  assert.equal(loginStart("install", mac).replaced, true);
  assert.ok(mac.calls.some((c) => c[0] === "bootout" && c[1] === "gui/501/com.reach.companion"));
  assert.equal(fs.existsSync(companion), false);
  assert.ok(fs.existsSync(path.join(mac.root, ".reach/backups/com.reach.companion.plist")));

  const other = setup();
  const otherAgents = path.join(other.home, "Library/LaunchAgents");
  fs.mkdirSync(otherAgents, { recursive: true });
  fs.writeFileSync(path.join(otherAgents, "com.reach.companion.plist"), "<plist><dict><key>WorkingDirectory</key><string>/elsewhere/reach</string></dict></plist>");
  assert.equal(loginStart("install", other).replaced, false);
  assert.ok(fs.existsSync(path.join(otherAgents, "com.reach.companion.plist")));
  assert.ok(!other.calls.some((c) => c[1] === "gui/501/com.reach.companion" && c[0] === "bootout"));
});

test("only on macOS, and only the three commands", () => {
  assert.throws(() => loginStart("install", { ...setup(), platform: "linux" }), /macOS/);
  assert.throws(() => loginStart("start", setup()), /install, uninstall or status/);
  // Paths are quoted for the shell and escaped for the plist.
  assert.ok(loginScript("/a/b'c", "/n").includes(`cd '/a/b'\\''c' || exit 1`));
  // An npm install has no ./reach: the script runs bin/reach.mjs with the chosen Node.
  const npmLayout = (file) => file.endsWith("/bin/reach.mjs");
  assert.ok(loginScript("/opt/pkg", "/n/bin", { exists: npmLayout }).includes("\n'/n/bin/node' '/opt/pkg/bin/reach.mjs'\n"));
  assert.ok(loginScript("/opt/pkg", "/n/bin", { exists: npmLayout, args: "restart --yes", restart: true }).includes("\n'/n/bin/node' '/opt/pkg/bin/reach.mjs' restart --yes\n"));
  assert.ok(loginScript("/src/reach", "/n/bin", { exists: (file) => true }).includes("\n./reach\n"), "a checkout keeps its launcher");
  assert.ok(!loginScript("/opt/pkg", "/n/bin", { exists: npmLayout, restart: true }).includes("uninstall"));
  assert.ok(loginPlist("/x/<y>&.command").includes("<string>/x/&lt;y&gt;&amp;.command</string>"));
});
