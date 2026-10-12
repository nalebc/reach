import path from "node:path";
import { isIP } from "node:net";
import { browserPrivateNames } from "./browser-private-paths.mjs";
import { moneyRules } from "./money-sites.mjs";
import { windowsAppId, windowsPackageName } from "./app-identity.mjs";

// What narrower presets keep off limits. Full control deliberately bypasses
// these filters. One list, used by the owner's app picker, typed commands for
// Apps, and (as plain data) the native per-event checker.

// Reach itself, in every form, and the ways around it.
export const REACH_WORDS = ["reach", "tailscale", "tailnet"];

// Apps that are never shared: they hold passwords, ask for the owner's
// password, or can stop Reach. Matched on bundle id prefix or exact name.
export const PROTECTED_APP_IDS = [
  "com.apple.screencontinuity", // iPhone Mirroring
  "com.apple.keychainaccess", "com.apple.passwords", "com.apple.passwordsmenubarextra",
  "com.apple.securityagent", "com.apple.localauthentication.uiagent", "com.apple.coreauthui", "com.apple.loginwindow",
  "com.apple.activitymonitor", "com.apple.console", "com.apple.systempreferences.", "com.apple.keychainsharingmessagingd",
  "com.1password", "com.agilebits", "com.bitwarden", "com.lastpass", "com.dashlane", "com.keepassxc", "org.keepassxc",
  "in.sinew.enpass", "com.nordpass", "me.proton.pass", "com.strongbox", "com.roboform", "com.zoho.vault", "com.nortonlifelock",
];
export const PROTECTED_APP_NAMES = [
  "iphone mirroring", "keychain access", "passwords", "securityagent", "loginwindow", "activity monitor", "console",
  "1password", "bitwarden", "lastpass", "dashlane", "keepassxc", "enpass", "nordpass", "proton pass", "strongbox", "roboform",
];
// System Settings is allowed, except the panes that change who may control
// this Mac or reveal secrets. Matched on the window title.
export const PRIVATE_PANES = ["privacy", "security", "accessibility", "screen recording", "screen & system audio", "login items",
  "users & groups", "passwords", "full disk access", "automation", "input monitoring", "vpn", "tailscale", "touch id", "network",
  "wallet", "apple account", "icloud", "lock screen", "login password", "sharing", "remote"];
// Browser pages that reveal saved passwords, cards or run code, and the
// developer tools. Matched on the page address and on window titles.
export const PROTECTED_PAGE_PATTERNS = [
  /^(javascript|data|devtools|chrome-devtools):/i,
  /^(chrome|brave|edge|vivaldi|opera|arc|chromium):\/\/(password-manager|settings\/(passwords|payments|autofill|addresses|privacy|security|content)|extensions|inspect|wallet)/i,
  /^about:(logins|preferences|config|profiles|addons|debugging)/i,
  /^edge:\/\/(wallet|settings\/(passwords|payments|privacy))/i,
  /^view-source:.*(password|keychain)/i,
];
export const PROTECTED_TITLE_WORDS = ["devtools", "developer tools", "web inspector", "javascript console", "password manager", "passwords", "keychain", "force quit"];
// Apps where typed text is a command: the shell deny list applies to typing.
export const TERMINAL_LIKE = ["terminal", "iterm", "warp", "ghostty", "alacritty", "kitty", "wezterm", "hyper", "tabby", "rio",
  "visual studio code", "vscode", "vscodium", "cursor", "windsurf", "xcode", "jetbrains", "intellij", "pycharm", "webstorm", "goland",
  "clion", "rider", "phpstorm", "rubymine", "zed", "nova", "emacs", "neovim", "neovide", "codex", "claude"];

// Characters that hide or reorder text; refused everywhere an agent sends text.
export const hiddenControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const lower = (value) => (typeof value === "string" ? value.normalize("NFKC").toLowerCase() : "");
// "reach" as a word (Reach.app, com.reach.app, "Reach — node"), not inside
// another word (Preacher).
export const mentionsReach = (value) => REACH_WORDS.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower(value)));
// The app's file name from its id, lowercased: a Mac bundle's name without
// .app; on Windows an .exe's name without .exe, or a Store app's package name.
const appFile = (id, platform) => platform !== "win32"
  ? lower(id).split("/").at(-1)?.replace(/\.app$/, "") || ""
  : windowsAppId(id) ? lower(windowsPackageName(id)) : lower(id).split(/[\\/]/).at(-1).replace(/\.(exe|app)$/, "");
export function protectedAppReason(app, { platform = process.platform } = {}) {
  const id = lower(app?.bundleId), name = lower(app?.name);
  const file = appFile(app?.id, platform);
  const all = `${id} ${name} ${file}`;
  if (mentionsReach(all)) return "Reach and Tailscale are always protected.";
  if (PROTECTED_APP_IDS.some((prefix) => id === prefix || id.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`)) ||
      PROTECTED_APP_NAMES.includes(name) || PROTECTED_APP_NAMES.includes(file))
    return "Passwords, security prompts and Reach's lifeline are always protected.";
  return null;
}
const SHORT_TERMINAL_WORDS = new Set(["rio", "nova", "zed", "kitty", "hyper"]);
export const terminalLikeApp = (app) => {
  const all = `${lower(app?.bundleId)} ${lower(app?.name)} ${lower(app?.id)}`;
  // Short names only count as whole words ("Zed", not "Authorized"; "Rio", not "Portfolio").
  const tokens = new Set(all.split(/[^a-z0-9]+/).filter(Boolean));
  return TERMINAL_LIKE.some((word) => SHORT_TERMINAL_WORDS.has(word) ? tokens.has(word) : all.includes(word));
};
// Only unambiguous, explicit HTTP(S) URLs may discard their path/query for
// Reach's host check. Keep the old conservative match for everything else.
// This validates syntax; it deliberately does not canonicalize host aliases.
const reachHostSubject = (value) => {
  if (/[\s\\"'`<>\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value) || /%(?![a-f0-9]{2})/i.test(value)) return value;
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/.exec(value)?.[1];
  if (!authority || !/^[a-z0-9.!$&'()*+,;=_~:@\[\]-]+$/.test(authority)) return value;
  const parts = /^(?:[^@]*@)?(\[[a-f0-9:.]+\]|[a-z0-9._-]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!parts || (parts[2] !== undefined && Number(parts[2]) > 65535)) return value;
  const host = parts[1].replace(/^\[|\]$/g, "");
  // Legacy numeric IP spellings and malformed DNS/IP values keep the fallback.
  const dns = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z_](?:[a-z0-9_-]*[a-z0-9_])?\.?$/;
  if (parts[1].startsWith("[") ? isIP(host) !== 6 : !isIP(host) && !dns.test(host)) return value;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return value;
    return authority;
  } catch { return value; }
};
// A shell argument can execute substitutions even when its text parses as a
// URL. Such arguments keep the whole-text check; browser URLs do not expand $.
const commandHostSubject = (value) => value.includes("$") ? value : reachHostSubject(value);
export const protectedPage = (url, hosts = []) => {
  const value = lower(url).trim();
  if (!value) return false;
  const subject = reachHostSubject(value);
  return PROTECTED_PAGE_PATTERNS.some((pattern) => pattern.test(value)) || hosts.some((host) => host && subject.includes(lower(host)));
};
export const protectedTitle = (title) => {
  const value = lower(title);
  return PROTECTED_TITLE_WORDS.some((word) => value.includes(word));
};

// The shell deny list. Each rule names what it refuses, in the owner's words.
const PASSWORD_COMMANDS = /^(sudo|su|doas|dscl|security|tccutil|csrutil|spctl|nvram|launchctl|systemsetup|networksetup|dseditgroup|visudo|passwd|chsh|chpass|login|sysadminctl|profiles|fdesetup|kextload|kmutil|bless|softwareupdate|tailscale|tailscaled|ssh-add|osascript|automator|shortcuts|open)$/;
const DISK_COMMANDS = /^(shutdown|reboot|halt|diskutil|dd|fdisk|asr|srm|mkfs(\.\w+)?|newfs(_\w+)?|hdiutil)$/;
const WIDE_TARGETS = /^(\/|~|~\/|\$HOME|\${HOME}|\/users(\/[^/]*)?\/?|\/applications\/?|\/library\/?|\/system\/?|\/private\/?|\/usr\/?|\/etc\/?|\/var\/?|\*|\.\.|\.\.\/)$/i;
const SECRET_PATH = new RegExp(`(^|/)(${[...browserPrivateNames, ".zsh_history", ".bash_history", ".node_repl_history", ".python_history", ".docker", ".vault-token"].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(/|$)`, "i");
const PRIVATE_LIBRARY = /library\/(keychains|cookies|safari|passwords|accounts|messages|mail|autofill|application support\/(google|bravesoftware|microsoft edge|firefox|arc|vivaldi|opera|com\.operasoftware|1password|bitwarden|keepassxc|tailscale|reach))/i;
const SCRIPTED_INPUT = /(system events|keystroke|key code|tell app(lication)? "(terminal|iterm|reach|tailscale|keychain|system settings|system preferences))/i;

const words = (segment) => {
  // An escaped space stays inside its word ("Application\ Support"). Quoted
  // tokens are remembered: a message in quotes is text, not a path or a name.
  const tokens = segment.replace(/\\ /g, "\u0001").trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.map((token) => ({ text: token.replace(/^["']|["']$/g, "").replace(/\u0001/g, " "), quoted: /^["']/.test(token) }));
};
const ACTS_ON = new Set(["kill", "killall", "pkill", "rm", "mv", "cp", "chmod", "chown", "open", "launchctl", "tailscale", "npm", "node", "pnpm", "yarn", "bun", "git", "curl", "wget", "sh", "bash", "zsh", "source", "."]);
// Commands are split at every place a new command can start, so a refusal
// can't hide behind a pipe or a semicolon. Each piece is checked on its own.
const segments = (command) => String(command).split(/\n|;|&&|\|\||\||`|\$\(|\(|\{|\bthen\b|\bdo\b|\belse\b/g);
const baseName = (token) => token.replace(/^.*\//, "").replace(/^\\/, "").toLowerCase();
const skipPrefixes = new Set(["env", "nohup", "nice", "time", "command", "builtin", "exec", "xargs", "caffeinate", "script", "watch", "timeout", "gtimeout", "stdbuf", "ionice", "chroot", "arch"]);

/** Returns null when the command may run, or the reason it may not. */
const isUrl = (value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
export function commandRefusal(command, { protectedPaths = [], home = "", hosts = [] } = {}) {
  if (typeof command !== "string" || !command.trim()) return "Enter a command.";
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(command)) return "Hidden control characters are not allowed in commands.";
  // Preserve quoted/embedded arguments before the conservative segment split:
  // script text is not an independently validated navigation URL.
  if (hosts.length && words(command).some((arg) => hosts.some((host) => host && commandHostSubject(lower(arg.text)).includes(lower(host)))))
    return "That's Reach's own address. The agent can't open Reach.";
  const lowered = command.normalize("NFKC").toLowerCase();
  const canonicalPath = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const roots = protectedPaths.filter((root) => typeof root === "string" && path.isAbsolute(root)).map(canonicalPath);
  const protectedPath = (value) => {
    const expanded = value.replace(/^~(?=[\\/]|$)/, home || "~").replace(/^\$\{?HOME\}?(?=[\\/]|$)/, home || "~");
    const absolute = path.isAbsolute(expanded) ? canonicalPath(expanded) : null;
    const separators = expanded.replace(/\\/g, "/");
    return SECRET_PATH.test(separators) || PRIVATE_LIBRARY.test(separators) ||
      (absolute !== null && roots.some((root) => absolute === root || absolute.startsWith(root.endsWith(path.sep) ? root : root + path.sep)));
  };
  for (const raw of segments(command)) {
    const piece = raw.replace(/\\ /g, " ");
    // Keep quoted assignment values intact. Removing text only up to its
    // first space could turn data such as NOTE='From: Reach Audit' into a
    // supposed Reach command. Embedded command segments are still checked.
    const tokens = words(raw);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].text)) {
      const assignment = tokens.shift().text;
      // A later command may use this value as a path. Quote delimiters do
      // not make the literal path safe, including concatenated quoted parts.
      const value = assignment.slice(assignment.indexOf("=") + 1).replace(/["']/g, "");
      if (protectedPath(value)) return "That path holds your passwords, keys or Reach's own files.";
    }
    if (!tokens.length) continue;
    let index = 0;
    while (index < tokens.length && (skipPrefixes.has(baseName(tokens[index].text)) || /^-/.test(tokens[index].text))) index++;
    const first = tokens[index];
    const name = baseName(first?.text || "");
    const args = tokens.slice(index + 1);
    const plainArgs = args.filter((arg) => !arg.quoted).map((arg) => arg.text);
    const values = args.map((arg) => arg.text);
    // Acting on something named Reach (its folder, its script, its app, its
    // process), or running Reach's own script, is refused; a quoted message
    // that mentions it is just text.
    if ((first && !first.quoted && mentionsReach(first.text)) || (ACTS_ON.has(name) && plainArgs.some((arg) => !isUrl(arg) && mentionsReach(arg))))
      return "That touches Reach or Tailscale. The agent can't change what keeps your phone connected.";
    // Reach's own addresses (its tailnet name, its local ports) stay closed.
    if (hosts.length && values.some((arg) => hosts.some((host) => host && commandHostSubject(lower(arg)).includes(lower(host)))))
      return "That's Reach's own address. The agent can't open Reach.";
    if (PASSWORD_COMMANDS.test(name)) {
      if (name === "open" && !values.some((arg) => (!isUrl(arg) && mentionsReach(arg)) || /keychain|passwords|activity monitor|system settings|system preferences|\.app$/i.test(arg) || protectedPath(arg))) continue;
      if (["osascript", "shortcuts", "automator"].includes(name) && !SCRIPTED_INPUT.test(piece)) continue;
      return ["sudo", "su", "doas", "passwd", "login"].includes(name)
        ? "That needs your password. The agent never gets it."
        : "That changes who can control this Mac, or reads its secrets.";
    }
    if (DISK_COMMANDS.test(name)) return "That could erase or shut down this Mac.";
    // Whatever the pid comes from (a name, a subshell), the whole command is read.
    if (["kill", "killall", "pkill"].includes(name) && /reach|node|tailscale|terminal|iterm|launchd|loginwindow|windowserver|finder|dock|systemuiserver/i.test(lowered))
      return "That would stop Reach or the Mac's own processes.";
    if (name === "rm" && values.some((arg) => /^-[a-z]*r/i.test(arg) || /^--recursive$/i.test(arg)) &&
        values.some((arg) => !arg.startsWith("-") && WIDE_TARGETS.test(arg)))
      return "That would delete far more than a project. Delete specific files or folders instead.";
    if (["chmod", "chown", "chgrp", "chflags"].includes(name) && values.some((arg) => /^-[a-z]*r/i.test(arg)) && values.some((arg) => !arg.startsWith("-") && WIDE_TARGETS.test(arg)))
      return "That would change permissions across the whole Mac.";
    if (name === "defaults" && /tcc|com\.apple\.security|loginwindow|screensaver|universalaccess/i.test(piece)) return "That changes the Mac's security settings.";
    if (["crontab", "at", "batch"].includes(name) && values.length && !values.includes("-l")) return "Scheduled jobs would outlive this session.";
    if (name === "history" || (name === "cat" && values.some((arg) => /_history$/.test(arg)))) return "Shell history can hold your secrets.";
    for (const arg of values) if (!arg.startsWith("-") && protectedPath(arg)) return "That path holds your passwords, keys or Reach's own files.";
    if (/(^|\s)(cat|less|more|head|tail|strings|xxd|hexdump|cp|mv|scp|rsync|sqlite3|plutil|python3?|node|ruby|perl)\s/.test(piece) && (SECRET_PATH.test(piece) || PRIVATE_LIBRARY.test(piece)))
      return "That path holds your passwords, keys or Reach's own files.";
  }
  return null;
}

/** A file an agent may never open or reveal: Reach's own, the browser profiles, keychains, shell histories. */
export function protectedPathReason(target, { protectedPaths = [], home = "", platform = process.platform } = {}) {
  // Windows paths are Windows' (whatever this host), and one file whatever
  // the letters' case.
  const paths = platform === "win32" ? path.win32 : path;
  const canonical = (value) => platform === "win32" ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  if (typeof target !== "string" || !paths.isAbsolute(target)) return "Give the file's full path.";
  const resolved = canonical(target), separators = resolved.replace(/\\/g, "/");
  const roots = protectedPaths.filter((root) => typeof root === "string" && paths.isAbsolute(root)).map(canonical);
  if (SECRET_PATH.test(separators) || PRIVATE_LIBRARY.test(separators) || roots.some((root) => resolved === root || resolved.startsWith(root.endsWith(paths.sep) ? root : root + paths.sep)))
    return "That path holds your passwords, keys or Reach's own files.";
  return null;
}

/** Typed text is checked like a command when a terminal or IDE is in front, and always for protected page addresses. */
export function typedTextRefusal(text, { terminalLike = false, hosts = [], protectedPaths = [], home = "" } = {}) {
  if (typeof text !== "string" || !text) return "Type something.";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const value = line.trim();
    // A recognizable shell command is checked argument by argument below.
    // Direct URLs, malformed addresses and protected schemes retain this check.
    const commandLike = terminalLike && /^[a-z0-9_./~\\-]+\s+\S/i.test(value);
    if (protectedPage(value, commandLike ? [] : hosts)) return "That page shows saved passwords or runs code. It stays closed to the agent.";
  }
  if (terminalLike) {
    for (const line of lines) {
      const reason = line.trim() ? commandRefusal(line, { protectedPaths, home, hosts }) : null;
      if (reason) return reason;
    }
  }
  return null;
}

// The rules the native checker applies to every event, as plain data.
export function nativeRules({ preset, apps = [], hidden = [] }, { hosts = [], titles = [], protectedPaths = [], home = "" } = {}) {
  return {
    mode: preset === "apps" ? "apps" : preset === "full" ? "full" : "view",
    hosts: [...new Set(hosts.map(lower).filter(Boolean))],
    titles: [...new Set(["reach", ...titles.map(lower)].filter(Boolean))],
    allowedApps: preset === "apps" ? apps.map((app) => ({ id: app.id, bundleId: app.bundleId || "", identity: app.identity || "" })) : [],
    hiddenApps: (preset === "full" ? [] : hidden).map((app) => ({ id: app.id, bundleId: app.bundleId || "", name: app.name || "" })),
    protectedAppIds: PROTECTED_APP_IDS,
    protectedAppNames: PROTECTED_APP_NAMES,
    reachWords: REACH_WORDS,
    privatePanes: PRIVATE_PANES,
    protectedTitleWords: PROTECTED_TITLE_WORDS,
    protectedPagePatterns: PROTECTED_PAGE_PATTERNS.map((pattern) => pattern.source),
    terminalLike: TERMINAL_LIKE,
    // Bank sites: sign in, read, download, sign out; nothing else (money-sites.mjs).
    ...moneyRules(),
    protectedPaths,
    home,
  };
}
