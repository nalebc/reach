import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { terminalPrompts, promptLabel } from "./prompts.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJson, loadJson } from "../server/core.mjs";
import { defaultFileRoots } from "../server/file-roots.mjs";
import { tailscaleJson, tailscaleCli } from "./tailscale.mjs";
import { stateDir, command } from "./home.mjs";
const exec = promisify(execFile);
export const preferencesFile = (root) =>
  path.join(stateDir(root), "preferences.json");
// Phones approved by your Tailscale account: Tailscale reaches Reach through
// a private Unix socket only Reach can answer, which Windows doesn't have.
// There Reach shows a pairing code instead, and keeps no account settings.
export const accountApproval = (platform = process.platform) =>
  platform !== "win32";
export function readPreferences(root) {
  const file = preferencesFile(root);
  if (!fs.existsSync(file)) return null;
  const value = loadJson(file, null);
  if (
    value?.version !== 1 ||
    typeof value.owner?.userId !== "string" ||
    !/^\d+$/.test(value.owner.userId) ||
    !value.owner.login ||
    !Array.isArray(value.folders) ||
    !value.folders.length ||
    value.folders.some((p) => typeof p !== "string" || !path.isAbsolute(p))
  )
    throw Error(
      `Reach configuration is invalid. Run ${command} configure to repair it.`,
    );
  return value;
}
export function setupOwner(status) {
  const self = status?.Self;
  const user = status?.User?.[self?.UserID];
  if (
    status?.BackendState !== "Running" ||
    !self?.UserID ||
    self.Tags?.length ||
    !user?.LoginName
  )
    throw Error(
      "Sign this computer into your personal Tailscale account (not a tagged service device).",
    );
  return { userId: String(self.UserID), login: user.LoginName };
}
export function assertOwnerAccount(status, preferences) {
  const owner = setupOwner(status);
  if (owner.userId !== preferences.owner.userId)
    throw Error(
      `Reach was set up for ${promptLabel(preferences.owner.login)}, but this computer is signed into ${promptLabel(owner.login)}. Switch Tailscale back to the original account, or run ${command} setup account to confirm the new account.`,
    );
}
export async function assertSocketSupport(run = exec) {
  const result = await run(tailscaleCli(), ["serve", "--help"], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  // Tailscale can print successful help output to stderr (including the macOS
  // CLI). Check both streams, while still allowing execution failures to reject.
  const help = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (!help.includes("unix:"))
    throw Error(
      "Update Tailscale: secure device approval requires Serve's Unix socket support. No less secure fallback was enabled.",
    );
}
// `./reach --https-port 9443` once: kept, so the next start, the invite
// rule (invites.mjs) and the background service use it too. True if changed.
export function rememberHttpsPort(root, port) {
  const preferences = readPreferences(root);
  if (!preferences || !Number.isInteger(port) || preferences.httpsPort === port) return false;
  atomicJson(preferencesFile(root), { ...preferences, httpsPort: port });
  return true;
}
export function applyPreferences(options, preferences, args = []) {
  if (!preferences || options.local) return options;
  return {
    ...options,
    folders:
      options.folders.length || process.env.REACH_ROOTS
        ? options.folders
        : preferences.folders,
    // Sleep prevention is a launch default, not an inherited onboarding choice.
    // Only an explicit CLI override should disable it or restrict it to AC.
    stayAwake: options.stayAwake ?? "always",
    ...(args.includes("--https-port")
      ? {}
      : { httpsPort: preferences.httpsPort || options.httpsPort }),
  };
}
export async function configure(root, deps = {}) {
  if (!accountApproval(deps.platform || process.platform))
    throw Error(
      `On Windows, Reach has no account settings to configure: start it with ${command}. It shows a pairing code to enter on your phone, which needs the Tailscale app, signed in to the same account.`,
    );
  if (!deps.ask && !process.stdin.isTTY)
    throw Error(
      `Run ${command} configure in an interactive terminal to confirm your Tailscale account first.`,
    );
  const ui = terminalPrompts();
  const ask = deps.ask || ui.ask;
  const select = deps.select || ui.select;
  const print = deps.print || console.log;
  // Inside the guided setup (`quiet`), the step list gives the context.
  const say = deps.quiet ? () => {} : print;
  say(
    "\nReach setup · private access through Tailscale\nNo Reach account or hosted Reach backend. Tailscale provides identity and connectivity.",
  );
  let owner;
  while (true) {
    try {
      owner = setupOwner(
        await (deps.status || (() => tailscaleJson(["status", "--json"])))(),
      );
    } catch (error) {
      print(`${error.message}\nTailscale: https://tailscale.com/download`);
      const retry = await select({
        message: "Connect Tailscale to continue",
        choices: [
          {
            value: "retry",
            label: "Check connection again",
            description: "After signing into Tailscale on this computer.",
            recommended: true,
          },
          {
            value: "cancel",
            label: "Set up later",
            description: "Exit without changing settings.",
          },
        ],
      });
      if (retry !== "retry")
        throw Error(
          `Setup paused. Rerun ${command} configure when Tailscale is connected.`,
        );
      continue;
    }
    await (deps.checkSupport || assertSocketSupport)();
    print(
      `\nTailscale account: ${promptLabel(owner.login)}\nNew browsers require approval on this computer. Approved browsers can run commands as your OS user; screen permissions stay separate.`,
    );
    const account = await select({
      message: "Which Tailscale account should Reach use?",
      choices: [
        {
          value: "use",
          label: "Use this account",
          description: promptLabel(owner.login),
          recommended: true,
        },
        {
          value: "switch",
          label: "Use a different account",
          description: "Switch in Tailscale, then check again.",
        },
        {
          value: "cancel",
          label: "Cancel setup",
          description: "Keep your current configuration.",
        },
      ],
    });
    if (account === "use") break;
    if (account !== "switch")
      throw Error("Setup cancelled. No settings changed.");
    print(
      "Switch accounts in the Tailscale app. Reach does not sign you out or change your VPN.",
    );
    const next = await select({
      message: "Ready to check your Tailscale account?",
      choices: [
        { value: "retry", label: "Check account again", recommended: true },
        { value: "cancel", label: "Cancel setup" },
      ],
    });
    if (next !== "retry") throw Error("Setup cancelled. No settings changed.");
  }
  const old = loadJson(preferencesFile(root), {});
  let folders = old.folders?.length ? null : defaultFileRoots();
  while (!folders) {
    const selected = await select({
      message: "File access on this computer",
      choices: [
        {
          value: "default",
          label: "All files on this computer",
          description:
            "Browse Home and Computer. System permissions still apply.",
          recommended: true,
        },
        {
          value: "keep",
          label: "Keep current folders",
          description: old.folders.join(", "),
        },
        {
          value: "custom",
          label: "Choose another folder",
          description: "Enter a folder path on this computer.",
        },
        {
          value: "cancel",
          label: "Cancel setup",
          description: "Keep your current configuration.",
        },
      ],
    });
    if (selected === "cancel")
      throw Error("Setup cancelled. No settings changed.");
    if (selected === "default" || selected === "keep") {
      folders = selected === "default" ? defaultFileRoots() : old.folders;
      break;
    }
    const chosen = (await ask("Folder path (or q to cancel):")).trim();
    if (/^(q|cancel)$/i.test(chosen))
      throw Error("Setup cancelled. No settings changed.");
    try {
      if (!chosen) throw Error("Choose a folder.");
      const resolved = fs.realpathSync.native(
        chosen.replace(/^~(?=\/|$)/, os.homedir()),
      );
      if (!fs.statSync(resolved).isDirectory()) throw Error("Choose a folder.");
      folders = [resolved];
    } catch {
      print(
        "That folder is unavailable. Select a folder that exists and that you can access.",
      );
    }
  }
  say(
    "Your approved devices can browse all configured locations using your OS permissions. Guests and agent profiles only receive the access you grant them. Use --folder to restrict file browsing.",
  );
  say(
    "Reach keeps the system and display awake while running, including on battery. Use --no-stay-awake to allow idle sleep. This does not unlock a locked Mac.",
  );
  const preferences = {
    version: 1,
    owner,
    folders,
    stayAwake: "always",
    httpsPort: old.httpsPort || 8443,
  };
  atomicJson(preferencesFile(root), preferences);
  say(
    `\nSaved. Run ${command}, open its link on your phone (the Tailscale app is optional: it's faster), then approve the request here.\nA Reach that's already running keeps its old settings until it restarts.`,
  );
  return preferences;
}
