import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HUB_KEEPS, hubGateway, hubShell, hubTelegram, openClawTarget, wslExe } from "../server/openclaw-hub.mjs";
import { openClawShell } from "../server/openclaw-run.mjs";
import { runTree } from "../server/openclaw-windows.mjs";
import { addOpenClawProvider, onboardOpenClaw, onboardStatus, saveApiKey } from "../server/openclaw-onboard.mjs";
import { addOpenClawChannel, localOpenClawConfig, startOpenClawGateway } from "../server/openclaw.mjs";
import { restartOpenClawGateway, runOpenClawMaintenance } from "../server/openclaw-health.mjs";
import { installPlan } from "../server/agent-install.mjs";

// OpenClaw's own Windows app (Windows Hub) can keep the Gateway in a WSL
// distro of its own (OpenClawGateway): Reach uses that Gateway rather than
// start a second one (owner, Oct 13). Its address and token come from the
// app's registry (%APPDATA%\OpenClawTray\gateways.json, written as the
// app's GatewayRecord.cs), its commands run in the distro as the app runs
// them (`wsl.exe -d <distro> -- bash -s`, the script on stdin), and no
// secret goes on a command line or through the environment. WSL can't run
// on GitHub's runners: the scripts are run by real bash here instead.
const KEY = "sk-or-v1-SECRETKEY0123456789";
const TOKEN = "123456:AAH-telegram_secret_token";
const record = (over = {}) => ({
  id: "a1b2c3", url: "ws://localhost:18789", friendlyName: "Local (OpenClawGateway)",
  sharedGatewayToken: "shared-token-0123456789", bootstrapToken: null, isLocal: true,
  requiresV2Signature: false, setupManagedDistroName: "OpenClawGateway", ...over,
});
function registry(t, data) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-openclaw-hub-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (data !== undefined) {
    fs.mkdirSync(path.join(dir, "roaming", "OpenClawTray"), { recursive: true });
    fs.writeFileSync(path.join(dir, "roaming", "OpenClawTray", "gateways.json"), typeof data === "string" ? data : JSON.stringify(data));
  }
  return { dir, env: { APPDATA: path.join(dir, "roaming"), SystemRoot: "C:\\Windows" }, home: path.join(dir, "home") };
}
const kept = { distro: "OpenClawGateway", port: 18789, token: "shared-token-0123456789" };
const hubTarget = async () => ({ kind: "hub", ...kept });

test("the app's Gateway: from its registry, the active record of a distro it set up, on loopback, with its token", async (t) => {
  const { env, home } = registry(t, { gateways: [record({ id: "x", setupManagedDistroName: "Other" }), record()], activeId: "a1b2c3" });
  assert.deepEqual(await hubGateway({ env, home }), kept);
  // No registry, a corrupt one, or no record of a distro the app set up.
  assert.equal(await hubGateway(registry(t)), null);
  assert.equal(await hubGateway(registry(t, "{not json")), null);
  for (const other of [{ isLocal: false }, { setupManagedDistroName: null }, { sshTunnel: { host: "h" } }, { nativePackageFamilyName: "OpenClaw.Gateway_x" }])
    assert.equal(await hubGateway(registry(t, { gateways: [record(other)], activeId: "a1b2c3" })), null, JSON.stringify(other));
  // One Reach can't use says why: published on the tailnet (the app then
  // reaches it at a wss://…ts.net address), no token, an odd name.
  const served = await hubGateway(registry(t, { gateways: [record({ url: "wss://pc.tail1234.ts.net" })] }));
  assert.equal(served.error.status, 503);
  assert.match(served.error.message, /publishes its Gateway on your tailnet/);
  assert.doesNotMatch(served.error.message, /tail1234/, "no tailnet name to the phone");
  assert.match((await hubGateway(registry(t, { gateways: [record({ sharedGatewayToken: "" })] }))).error.message, /no Gateway token Reach can use/);
  assert.match((await hubGateway(registry(t, { gateways: [record({ setupManagedDistroName: "bad name; rm" })] }))).error.message, /can't read which Gateway/);
});

test("one answer for everything: this PC's own setup first, then the app's Gateway, else this PC's (not set up)", async (t) => {
  const { env, home } = registry(t, { gateways: [record()], activeId: "a1b2c3" });
  assert.equal((await openClawTarget({ env, home, platform: "win32" })).kind, "hub");
  assert.deepEqual((await openClawTarget({ env, home, platform: "darwin" })).kind, "native", "a Mac has no such app");
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}");
  assert.equal((await openClawTarget({ env, home, platform: "win32" })).kind, "native");
  assert.equal((await openClawTarget({ ...registry(t), platform: "win32" })).kind, "native");
});

test("chats go to the app's Gateway on this PC's loopback, with its token; a Mac never looks for it", async (t) => {
  const { env, home } = registry(t, { gateways: [record({ url: "ws://localhost:18790" })], activeId: "a1b2c3" });
  assert.deepEqual(await localOpenClawConfig({ env, home, platform: "win32" }), { url: "ws://127.0.0.1:18790", token: "shared-token-0123456789", password: undefined, hub: true });
  await assert.rejects(localOpenClawConfig({ env, home, platform: "darwin" }), (e) => e.notSetUp === true);
  const served = registry(t, { gateways: [record({ url: "wss://pc.tail1234.ts.net" })] });
  await assert.rejects(localOpenClawConfig({ ...served, platform: "win32" }), (e) => e.status === 503 && /tailnet/.test(e.message));
});

test("OpenClaw's commands in the app's distro: wsl.exe from Windows' folder, bash reading the script on stdin, fixed words only", async () => {
  const env = { SystemRoot: "C:\\Windows", Path: "C:\\x" };
  const [file, argv, childEnv, script] = await openClawShell(["models", "auth", "list", "--agent", "main", "--json", "--provider", "anthropic"], { env, platform: "win32", target: hubTarget });
  assert.equal(file, "C:\\Windows\\System32\\wsl.exe");
  assert.deepEqual(argv, ["-d", "OpenClawGateway", "--user", "openclaw", "--", "bash", "-s"]);
  assert.equal(childEnv, env);
  assert.equal(childEnv.WSLENV, undefined, "nothing goes in through WSLENV");
  assert.equal(script, 'set -e\nexport PATH="/home/openclaw/.openclaw/bin:/opt/openclaw/bin:/usr/local/bin:$PATH"\nexec openclaw models auth list --agent main --json --provider anthropic\n');
  assert.ok(!argv.some((arg) => arg.includes("$")), "no $ for wsl.exe to rewrite");
  // Nothing a shell would read goes into the script; no secret goes this way.
  for (const bad of ["two words", "$(id)", "a;b", "'q'", '"q"', "a|b", "`x`", "\n"])
    assert.throws(() => hubShell(["channels", bad], { distro: "OpenClawGateway" }), /unsafe/, JSON.stringify(bad));
  assert.throws(() => hubShell(["--version"], { distro: "bad distro" }), /unsafe/);
  await assert.rejects(openClawShell(["onboard"], { env, platform: "win32", target: hubTarget, secret: "OPENAI_API_KEY" }), /no secret through WSL/);
  // One Reach can't use: its reason, nothing run.
  await assert.rejects(openClawShell(["--version"], { env, platform: "win32", target: async () => ({ kind: "hub", error: Object.assign(new Error("why"), { status: 503 }) }) }), /why/);
  assert.equal(wslExe({}), "wsl.exe");
});

test("a key through the app: OpenClaw's own paste-api-key, the key on stdin after the script, never an argument", async () => {
  const env = { SystemRoot: "C:\\Windows" };
  const ran = [];
  const piped = [];
  const run = async (file, argv, options) => {
    ran.push([file, argv, options]);
    if (options.input.includes("agents list")) return { stdout: JSON.stringify([{ id: "main", isDefault: true }]) };
    return { stdout: JSON.stringify({ profiles: [{ id: "anthropic:default", provider: "anthropic", type: "api_key" }] }) };
  };
  await saveApiKey("anthropic", KEY, { pipe: async (...a) => piped.push(a), run, env, platform: "win32", target: hubTarget });
  const [file, argv, options] = piped[0];
  assert.equal(file, "C:\\Windows\\System32\\wsl.exe");
  assert.equal(options.input, 'set -e\nexport PATH="/home/openclaw/.openclaw/bin:/opt/openclaw/bin:/usr/local/bin:$PATH"\nexec openclaw models auth paste-api-key --agent main --provider anthropic --profile-id anthropic:default\n' + `${KEY}\n`);
  assert.doesNotMatch(JSON.stringify([argv, ran.map(([f, a]) => [f, a])]), /SECRETKEY/);
  assert.ok(ran.every(([, , o]) => !o.input.includes("SECRETKEY")));
  // Adding one isn't "set up OpenClaw first" there: the app set it up.
  const added = await addOpenClawProvider({ provider: "anthropic", key: KEY }, { save: async () => {}, env, platform: "win32", file: path.join(os.tmpdir(), "reach-none", "openclaw.json"), hub: async () => kept });
  assert.equal(added.added, true);
});

test("channels through the app: Telegram's token on stdin into a file only openclaw reads; Discord and Slack said why", async () => {
  const env = { SystemRoot: "C:\\Windows" };
  const ran = [];
  const run = async (...a) => (ran.push(a), { stdout: "" });
  await addOpenClawChannel({ channel: "telegram", token: ` ${TOKEN} `, name: "Ann's bot" }, { run, env, platform: "win32", target: hubTarget });
  const [file, argv, options] = ran[0];
  assert.equal(file, "C:\\Windows\\System32\\wsl.exe");
  assert.deepEqual(argv, ["-d", "OpenClawGateway", "--user", "openclaw", "--", "bash", "-s"]);
  assert.doesNotMatch(JSON.stringify(argv), /telegram_secret/);
  assert.match(options.input, new RegExp(`IFS= read -r token\\n${TOKEN}\\nprintf`), "the token right after its read");
  assert.match(options.input, /IFS= read -r name\nAnn's bot\n/);
  assert.match(options.input, /openclaw channels add --channel telegram --token-file \/home\/openclaw\/\.openclaw\/credentials\/reach-telegram\.token --name "\$name" <\/dev\/null;/);
  for (const [channel, values] of [["discord", { token: "MTA-discord-token" }], ["slack", { botToken: "xoxb-12345678", appToken: "xapp-12345678" }]])
    await assert.rejects(addOpenClawChannel({ channel, ...values }, { run, env, platform: "win32", target: hubTarget }),
      (e) => e.status === 409 && /guided setup \(Other apps\)/.test(e.message) && /won't put them there/.test(e.message), channel);
  assert.equal(ran.length, 1, "nothing run for Discord or Slack");
  await assert.rejects(addOpenClawChannel({ channel: "telegram", token: TOKEN }, { run: async () => { throw new Error("exit 1"); }, env, platform: "win32", target: hubTarget }), (e) => e.status === 409);
});

test("the app's Gateway starts, restarts and gets Doctor's look from Reach; repairs and updates stay with the app", async () => {
  const env = { SystemRoot: "C:\\Windows" };
  const ran = [];
  const run = async (file, argv, options) => (ran.push([file, argv, options.input]), { stdout: "fine", stderr: "" });
  const hubConfig = async () => ({ url: "ws://127.0.0.1:18789", token: "t", hub: true });
  const options = { configuration: hubConfig, env, platform: "win32", run, target: hubTarget };
  await startOpenClawGateway(options);
  await restartOpenClawGateway(options);
  assert.equal((await runOpenClawMaintenance("doctor", { ...options, runtime: null })).status, "done");
  assert.deepEqual(ran.map(([file, argv, script]) => [file, argv.join(" "), script.split("\n").at(-2)]), [
    ["C:\\Windows\\System32\\wsl.exe", "-d OpenClawGateway --user openclaw -- bash -s", "exec openclaw gateway start"],
    ["C:\\Windows\\System32\\wsl.exe", "-d OpenClawGateway --user openclaw -- bash -s", "exec openclaw gateway restart"],
    ["C:\\Windows\\System32\\wsl.exe", "-d OpenClawGateway --user openclaw -- bash -s", "exec openclaw doctor --non-interactive --no-workspace-suggestions"],
  ]);
  for (const action of ["repair", "update", "finish-update", "verify-update", "repair-service"])
    await assert.rejects(runOpenClawMaintenance(action, options), (e) => e.status === 409 && e.message === HUB_KEEPS, action);
  assert.equal(ran.length, 3, "nothing more run");
});

test("set up already in the app: no second install, no second setup; the phone hears it's installed and set up", async (t) => {
  const none = path.join(os.tmpdir(), "reach-hub-none", "openclaw.json");
  const status = await onboardStatus({ has: async () => false, file: none, platform: "win32", hub: async () => kept });
  assert.deepEqual([status.installed, status.configured], [true, true]);
  // An app record Reach can't use still means set up there: no second one.
  const unusable = await onboardStatus({ has: async () => false, file: none, platform: "win32", hub: async () => ({ distro: "OpenClawGateway", error: new Error("why") }) });
  assert.deepEqual([unusable.installed, unusable.configured], [true, true]);
  await assert.rejects(
    onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run: async () => assert.fail("must not run"), env: {}, platform: "win32", file: none, hub: async () => kept, gateway: async () => assert.fail("not asked") }),
    (e) => e.status === 409 && e.message === "OpenClaw is already set up in its Windows app on this PC, and Reach uses that one.",
  );
  await assert.rejects(installPlan("openclaw", { platform: "win32", hub: async () => kept, node: async () => assert.fail("not asked") }),
    (e) => e.status === 409 && e.message === "OpenClaw already runs in its Windows app on this PC, and Reach uses that one.");
});

test("the app's script goes on wsl.exe's stdin, and stdin then closes", async () => {
  let written = null;
  const start = (file, args, options, done) => {
    setTimeout(() => done(null, "ok", ""), 5);
    return { pid: 1, stdin: { on() {}, end: (text) => (written = text) } };
  };
  assert.deepEqual(await runTree("wsl.exe", ["-d", "X"], { input: "set -e\n", timeout: 1000 }, { start, kill: () => {} }), { stdout: "ok", stderr: "" });
  assert.equal(written, "set -e\n");
});

// The scripts as bash runs them in the app's distro (bash reads its script
// a line at a time from stdin; OpenClaw then reads what follows): a
// stand-in openclaw logs its arguments and stdin. Real bash; WSL itself
// can't run on GitHub's runners.
const bash = ["/bin/bash", "/usr/bin/bash"].find((file) => fs.existsSync(file));
test("in the distro, the key reaches OpenClaw's stdin and Telegram's token its file; neither is ever an argument", { skip: !bash && "no bash here" }, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-hub-bash-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "log.jsonl");
  fs.writeFileSync(path.join(bin, "openclaw"), `#!${bash}\nstdin=$(cat)\n{ printf 'ARGV'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\nSTDIN\\t%s\\n' "$stdin"; } >> "${log}"\nexit \${STUB_EXIT:-0}\n`, { mode: 0o755 });
  const runScript = (input, extra = {}) => spawnSync(bash, ["-s"], { input, encoding: "utf8", timeout: 30000, env: { PATH: "/usr/bin:/bin", ...extra } });
  // The paste: OpenClaw gets the key on its stdin.
  const [, , , script] = hubShell(["models", "auth", "paste-api-key", "--agent", "main", "--provider", "anthropic", "--profile-id", "anthropic:default"], { distro: "OpenClawGateway", prefix: bin });
  const paste = runScript(`${script}${KEY}\n`);
  assert.equal(paste.status, 0, paste.stderr);
  const pasted = fs.readFileSync(log, "utf8");
  assert.match(pasted, /^ARGV\tmodels\tauth\tpaste-api-key\t--agent\tmain\t--provider\tanthropic\t--profile-id\tanthropic:default\nSTDIN\tsk-or-v1-SECRETKEY0123456789\n$/);
  fs.rmSync(log);
  // Telegram: the token in a 600 file, the name one argument with its quote and spaces.
  const home = path.join(dir, "home");
  const [, , , input] = hubTelegram({ distro: "OpenClawGateway", token: TOKEN, name: "Ann's \"bot\" $HOME", prefix: bin, home });
  const tg = runScript(input);
  assert.equal(tg.status, 0, tg.stderr);
  const file = path.join(home, ".openclaw", "credentials", "reach-telegram.token");
  assert.equal(fs.readFileSync(file, "utf8"), `${TOKEN}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const added = fs.readFileSync(log, "utf8");
  assert.equal(added.split("\n")[0], ["ARGV", "channels", "add", "--channel", "telegram", "--token-file", file, "--name", 'Ann\'s "bot" $HOME'].join("\t"));
  assert.doesNotMatch(added.split("\n")[0], /telegram_secret/, "the token itself is never an argument");
  // Refused by OpenClaw: the file goes, and the run fails.
  fs.rmSync(log);
  const refused = runScript(input, { STUB_EXIT: "1" });
  assert.equal(refused.status, 1);
  assert.equal(fs.existsSync(file), false);
});
