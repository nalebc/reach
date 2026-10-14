// OpenClaw's own Windows app (Windows Hub, github.com/openclaw/
// openclaw-windows-node) can keep OpenClaw's Gateway in a locked-down WSL
// distro of its own (OpenClawGateway by default; its docs/
// WSL_GATEWAY_ADMIN.md): the Gateway runs there as the `openclaw` user,
// loopback-bound inside WSL, reached from Windows at ws://localhost:18789
// through WSL's localhost forwarding. Nothing on Windows' side holds its
// openclaw.json. The app's own gateway registry (%APPDATA%\OpenClawTray\
// gateways.json, GatewayRecord.cs) names the distro, the Gateway's address
// and its shared token. Reach uses that Gateway rather than start a second
// one (owner, Oct 13): chats and the rest over its WebSocket, as on a Mac;
// OpenClaw's own commands inside the distro, as the app runs them
// (WslGatewayController.cs): `wsl.exe -d <distro> -- bash -s`, the script
// on stdin. wsl.exe rewrites $ in its arguments before bash sees them
// (its docs/WSL_EXE_ARGV_PITFALL.md); stdin it leaves alone. A secret is
// never an argument nor an environment variable here (no WSLENV): it comes
// on stdin after the script, read by bash's own `read` or by OpenClaw.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });
const envValue = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

// This computer's own OpenClaw setup, as localOpenClawConfig reads it.
export const nativeConfigFile = ({ env = process.env, home = os.homedir() } = {}) =>
  env.REACH_OPENCLAW_CONFIG || env.OPENCLAW_CONFIG_PATH || path.join(env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), "openclaw.json");
export const hubRegistryFile = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(envValue(env, "APPDATA") || path.join(home, "AppData", "Roaming"), "OpenClawTray", "gateways.json");

// WSL distro names: letters, digits, dot, dash, underscore.
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const managed = (record) =>
  record && typeof record === "object" && record.isLocal === true && typeof record.setupManagedDistroName === "string" &&
  !record.sshTunnel && !record.nativePackageFamilyName;

// The app's Gateway in its WSL distro: null without one; { distro, port,
// token } to use; { error } for one Reach can't use, with the reason (a
// Gateway it publishes on the tailnet through Tailscale Serve, which the
// app then reaches at a wss://…ts.net address: Reach is the private way in).
export async function hubGateway({ env = process.env, home = os.homedir(), readFile = fs.readFile } = {}) {
  let data;
  try {
    data = JSON.parse(String(await readFile(hubRegistryFile({ env, home }), "utf8")));
  } catch {
    return null;
  }
  const records = Array.isArray(data?.gateways) ? data.gateways.filter(managed) : [];
  const record = records.find((r) => r.id === data.activeId) || records[0];
  if (!record) return null;
  const distro = record.setupManagedDistroName.trim();
  let url = null;
  try {
    url = new URL(record.url);
  } catch {}
  const unread = { distro, error: fail(503, "Reach can't read which Gateway OpenClaw's Windows app keeps. Open that app's Connections settings.") };
  if (!DISTRO.test(distro) || !url || !["ws:", "wss:"].includes(url.protocol)) return unread;
  if (!LOOPBACK.has(url.hostname))
    return { distro, error: fail(503, "OpenClaw's Windows app publishes its Gateway on your tailnet (Tailscale Serve in its WSL distro). Turn tailnet access off in that app; Reach is the private way in.") };
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return unread;
  if (typeof record.sharedGatewayToken !== "string" || !record.sharedGatewayToken.trim())
    return { distro, error: fail(503, "OpenClaw's Windows app keeps no Gateway token Reach can use. Set its Gateway up again in that app.") };
  return { distro, port, token: record.sharedGatewayToken.trim() };
}

// Which OpenClaw Reach drives here: this computer's own setup when there is
// one, else on Windows the app's Gateway in WSL, else this computer's own
// (not set up yet). One answer for the WebSocket, the commands, setup and
// what the phone is told, so they never part ways.
export async function openClawTarget({ env = process.env, home = os.homedir(), platform = process.platform, access = fs.access, readFile = fs.readFile } = {}) {
  try {
    await access(nativeConfigFile({ env, home }));
    return { kind: "native" };
  } catch {}
  if (platform === "win32") {
    const hub = await hubGateway({ env, home, readFile });
    if (hub) return { kind: "hub", ...hub };
  }
  return { kind: "native" };
}

// What Reach won't do to the app's Gateway, and why: the app keeps it.
export const HUB_KEEPS = "OpenClaw's Windows app keeps this Gateway in its own WSL distro: repair and update it from that app.";

// wsl.exe from Windows' own folder, never one found on PATH.
export function wslExe(env = process.env) {
  const root = envValue(env, "SYSTEMROOT") || envValue(env, "WINDIR");
  return root && /^[A-Za-z]:\\/.test(root) ? path.win32.join(root, "System32", "wsl.exe") : "wsl.exe";
}
// Where the app installs OpenClaw in its distro (OpenClawWslPathPrefix).
export const HUB_PATH = "/home/openclaw/.openclaw/bin:/opt/openclaw/bin:/usr/local/bin";
export const HUB_HOME = "/home/openclaw";
// Words joined into the script: fixed arguments only, nothing a shell reads.
const SAFE = /^[A-Za-z0-9._:/=@+-]+$/;
const words = (args) => {
  for (const arg of args) if (typeof arg !== "string" || !SAFE.test(arg)) throw new Error("unsafe argument");
  return args.join(" ");
};
const wslArgs = (distro) => {
  if (!DISTRO.test(distro || "")) throw new Error("unsafe distro");
  return ["-d", distro, "--user", "openclaw", "--", "bash", "-s"];
};
const head = (prefix) => `set -e\nexport PATH="${prefix}:$PATH"\n`;

// [file, argv, env, script] for one openclaw run in the app's distro. What
// the command reads on its stdin (a key) goes right after the script: bash
// reads its script a line at a time and `exec` hands the rest to OpenClaw.
export function hubShell(args, { distro, env = process.env, prefix = HUB_PATH } = {}) {
  return [wslExe(env), wslArgs(distro), env, `${head(prefix)}exec openclaw ${words(args)}\n`];
}

// Telegram's token into the distro: a file only `openclaw` can read
// (umask 077, bash's own printf: no program gets it as an argument), then
// OpenClaw's own `channels add` with that file; refused, the file goes.
// The account name, too, comes on stdin and stays one argument.
export function hubTelegram({ distro, env = process.env, token, name, prefix = HUB_PATH, home = HUB_HOME } = {}) {
  const file = `${home}/.openclaw/credentials/reach-telegram.token`;
  if (!SAFE.test(file)) throw new Error("unsafe path");
  const input = [
    "set -e",
    "umask 077",
    `mkdir -p ${home}/.openclaw/credentials`,
    "IFS= read -r token",
    token,
    `printf '%s\\n' "$token" > ${file}`,
    "unset token",
    ...(name ? ["IFS= read -r name", name] : []),
    `export PATH="${prefix}:$PATH"`,
    // Its stdin is nothing: the rest of the script stays bash's.
    `if openclaw channels add --channel telegram --token-file ${file}${name ? ' --name "$name"' : ""} </dev/null; then exit 0; fi`,
    `rm -f ${file}`,
    "exit 1",
    "",
  ].join("\n");
  return [wslExe(env), wslArgs(distro), env, input];
}
