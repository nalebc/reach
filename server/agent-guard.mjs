import path from "node:path";
import { isIP } from "node:net";
import { browserPrivateNames } from "./browser-private-paths.mjs";
import { moneyRules } from "./money-sites.mjs";
import { windowsAppId, windowsCanonicalPath, windowsFold, windowsPackageName, windowsShortName, windowsWithin } from "./app-identity.mjs";

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

// The same lists on Windows, chosen by platform (guardData below), in the
// same shapes, so a Windows helper gets the rules a Mac's does. Ids are Store
// packages' names (the part of an app id before "_"), matched like bundle
// ids; names are programs' .exe names without .exe, and display names.
export const WINDOWS_PROTECTED_APP_IDS = [
  "microsoft.sechealthui", // Windows Security
  "microsoft.lockapp", "microsoft.creddialoghost", "microsoft.aad.brokerplugin", "microsoft.accountscontrol", "microsoft.bioenrollment",
  "8bitsolutionsllc.bitwardendesktop",
];
export const WINDOWS_PROTECTED_APP_NAMES = [
  // Password managers.
  "1password", "bitwarden", "keepass", "keepassxc", "dashlane", "lastpass", "nordpass", "keeper", "keeper password manager", "keeperpasswordmanager",
  "proton pass", "protonpass", "enpass", "roboform",
  // Windows' security prompts and the tools that change who controls the PC or stop Reach.
  "consent", "credentialuibroker", "logonui", "lockapp", "taskmgr", "task manager", "regedit", "regedt32", "registry editor", "mmc", "gpedit",
  "sechealthui", "windows security", "credential manager",
];
// Settings is allowed except these pages, matched on the page's name in the
// Settings app (WINDOWS_SETTINGS_APPS); their ms-settings: addresses are
// protected pages.
export const WINDOWS_SETTINGS_APPS = ["windows.immersivecontrolpanel", "systemsettings"];
export const WINDOWS_PRIVATE_PANES = ["privacy", "security", "sign-in options", "network", "wi-fi", "ethernet", "vpn", "proxy", "windows update",
  "recovery", "accounts", "tailscale"];
const WINDOWS_SETTINGS_PAGES = [/^ms-settings:(privacy|signinoptions|network|windowsupdate|recovery|windowsdefender)/i, /^windowsdefender:/i];
export const WINDOWS_PROTECTED_PAGE_PATTERNS = [...PROTECTED_PAGE_PATTERNS, ...WINDOWS_SETTINGS_PAGES];
export const WINDOWS_PROTECTED_TITLE_WORDS = [...PROTECTED_TITLE_WORDS, "credential manager", "windows security", "task manager", "registry editor",
  "user account control", "group policy"];
export const WINDOWS_TERMINAL_LIKE = [...TERMINAL_LIKE, "powershell", "pwsh", "windows terminal", "windowsterminal", "cmd", "command prompt", "wt",
  "conhost", "wsl", "git bash", "mintty"];
const guardData = (platform) => platform === "win32"
  ? { appIds: WINDOWS_PROTECTED_APP_IDS, appNames: WINDOWS_PROTECTED_APP_NAMES, panes: WINDOWS_PRIVATE_PANES, titleWords: WINDOWS_PROTECTED_TITLE_WORDS, pages: WINDOWS_PROTECTED_PAGE_PATTERNS, terminals: WINDOWS_TERMINAL_LIKE }
  : { appIds: PROTECTED_APP_IDS, appNames: PROTECTED_APP_NAMES, panes: PRIVATE_PANES, titleWords: PROTECTED_TITLE_WORDS, pages: PROTECTED_PAGE_PATTERNS, terminals: TERMINAL_LIKE };

// Characters that hide or reorder text; refused everywhere an agent sends text.
export const hiddenControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const lower = (value) => (typeof value === "string" ? value.normalize("NFKC").toLowerCase() : "");
// "reach" as a word (Reach.app, com.reach.app, "Reach — node"), not inside
// another word (Preacher).
export const mentionsReach = (value) => REACH_WORDS.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower(value)));
// The app's file name from its id, lowercased: a Mac bundle's name without
// .app; on Windows an .exe's name without .exe, or a Store app's package name.
// On Windows, names compare as Windows compares them (windowsFold).
const folded = (value, platform) => platform === "win32" ? windowsFold(lower(value)) : lower(value);
const appFile = (id, platform) => platform !== "win32"
  ? lower(id).split("/").at(-1)?.replace(/\.app$/, "") || ""
  : windowsAppId(id) ? folded(windowsPackageName(id), platform) : folded(id, platform).split(/[\\/]/).at(-1).replace(/\.(exe|app)$/, "");
export function protectedAppReason(app, { platform = process.platform } = {}) {
  const id = folded(app?.bundleId, platform), name = folded(app?.name, platform);
  const file = appFile(app?.id, platform);
  const all = `${id} ${name} ${file}`;
  if (mentionsReach(all)) return "Reach and Tailscale are always protected.";
  const { appIds, appNames } = guardData(platform);
  // On Windows a Store app's package name counts as its id too.
  const ids = platform === "win32" && windowsAppId(app?.id) ? [id, file] : [id];
  if (ids.some((value) => appIds.some((prefix) => value === prefix || value.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`))) ||
      appNames.includes(name) || appNames.includes(file))
    return "Passwords, security prompts and Reach's lifeline are always protected.";
  return null;
}
const SHORT_TERMINAL_WORDS = new Set(["rio", "nova", "zed", "kitty", "hyper", "cmd", "wt", "wsl"]);
export const terminalLikeApp = (app, { platform = process.platform } = {}) => {
  const all = `${folded(app?.bundleId, platform)} ${folded(app?.name, platform)} ${folded(app?.id, platform)}`;
  // Short names only count as whole words ("Zed", not "Authorized"; "Rio", not "Portfolio").
  const tokens = new Set(all.split(/[^a-z0-9]+/).filter(Boolean));
  return guardData(platform).terminals.some((word) => SHORT_TERMINAL_WORDS.has(word) ? tokens.has(word) : all.includes(word));
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
export const protectedPage = (url, hosts = [], { platform = process.platform } = {}) => {
  const value = lower(url).trim();
  if (!value) return false;
  const subject = reachHostSubject(value);
  return guardData(platform).pages.some((pattern) => pattern.test(value)) || hosts.some((host) => host && subject.includes(lower(host)));
};
export const protectedTitle = (title, { platform = process.platform } = {}) => {
  const value = lower(title);
  return guardData(platform).titleWords.some((word) => value.includes(word));
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
// On Windows too at a lone & (cmd) and at DO in any case, but never inside a
// folder's name (Program Files (x86)) or a variable's (${env:APPDATA}).
const windowsSegments = (command) =>
  String(command).split(/\n|;|&&|\|\||\||`|\$\(|\((?!x86\))|(?<!\$)\{|\bthen\b|\bdo\b|\belse\b/gi).flatMap((piece) => piece.split("&"));
const baseName = (token) => token.replace(/^.*\//, "").replace(/^\\/, "").toLowerCase();
const skipPrefixes = new Set(["env", "nohup", "nice", "time", "command", "builtin", "exec", "xargs", "caffeinate", "script", "watch", "timeout", "gtimeout", "stdbuf", "ionice", "chroot", "arch"]);

// Windows, added to the list above (commandRefusal with platform "win32").
// A program's name is matched whatever its folder, letters' case or
// extension (C:\Windows\System32\REG.EXE is reg).
const windowsName = (token) => token.split(/[\\/]/).at(-1).toLowerCase().replace(/\.(exe|com|cmd|bat|ps1|msc)$/, "");
const WINDOWS_SKIP = new Set(["cmd", "start", "start-process", "call"]);
const WINDOWS_ADMIN_COMMANDS = new Set(["runas", "reg", "bcdedit", "netsh", "sc", "icacls", "takeown", "set-mppreference", "add-mppreference", "wmic"]);
const WINDOWS_DISK_COMMANDS = new Set(["vssadmin", "cipher", "format", "diskpart"]);
// Windows' security tools, opened from a command line.
const WINDOWS_PROTECTED_PROGRAMS = new Set(["taskmgr", "regedit", "regedt32", "mmc", "gpedit", "credentialuibroker", "consent"]);
const WINDOWS_DELETE = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const WINDOWS_SHORT_NAME = "Give the full name: a short name such as PROGRA~1 hides which folder is meant.";
// Windows' own folders and every program's: the drive's root, Windows,
// Program Files and ProgramData, by path or by their environment names.
const WINDOWS_SYSTEM_PATH = /^(?:[a-z]:[\\/]?$|[a-z]:[\\/](?:windows|program files|program files \(x86\)|programdata)(?:[\\/]|$)|(?:%|\$\{?env:)(?:systemroot|windir|programfiles|programw6432|programdata))/i;
const WINDOWS_SYSTEM_PLACE = /(?:^|[\s"'])(?:[a-z]:[\\/](?:windows|program files|programdata)(?=[\\/\s"' (]|$)|(?:%|\$\{?env:)(?:systemroot|windir|programfiles|programw6432|programdata))/i;
// Where Windows and its apps keep passwords and sign-ins (beside SECRET_PATH),
// as the Mac's PRIVATE_LIBRARY names ~/Library's: browser profiles, mail,
// credential stores, the Startup folders, PowerShell's history and profiles
// (its .zshrc), password managers, Tailscale and Reach. Matched on a path or
// on a whole command, with / for \. AppData by its environment names
// (%APPDATA%, $env:LOCALAPPDATA) is private as a whole, as ~/Library is
// (browserPrivatePaths protects the folder itself).
const WINDOWS_APP_DATA_SECRETS = ["google/chrome", "chromium", "microsoft/edge", "bravesoftware", "mozilla", "thunderbird", "opera software", "vivaldi", "yandex",
  "librewolf", "waterfox", "packages/thebrowsercompany\\.arc_[^/]*", "microsoft/outlook", "comms", "packages/microsoft\\.windowscommunicationsapps_[^/]*",
  "packages/microsoft\\.outlookforwindows_[^/]*", "microsoft/(?:credentials|protect|vault|crypto|systemcertificates)", "microsoft/windows/start menu/programs/startup",
  "microsoft/windows/powershell/psreadline", "packages/microsoft\\.windowsterminal[^/]*", "1password", "agilebits", "bitwarden", "keepassxc", "keepass", "dashlane",
  "lastpass", "nordpass", "enpass", "proton pass", "protonpass", "keeper", "roboform", "gnupg", "github cli", "tailscale", "reach"];
const WINDOWS_PRIVATE_DATA = new RegExp("(?:" + [
  `appdata/(?:local|roaming|locallow)/(?:${WINDOWS_APP_DATA_SECRETS.join("|")})`,
  "%(?:local)?appdata%", "\\$\\{?env:(?:local)?appdata\\b",
  "(?:programdata|%programdata%|%allusersprofile%|\\$\\{?env:(?:programdata|allusersprofile)\\}?)/(?:tailscale|microsoft/windows/start menu/programs/startup)",
  "(?:windows|%systemroot%|%windir%|\\$\\{?env:(?:systemroot|windir)\\}?)/system32/(?:config|tasks)",
  "program files(?: \\(x86\\))?/tailscale", "documents/(?:windows)?powershell", "(?:windows)?powershell/[^/]*profile\\.ps1",
].join("|") + ")(?![a-z0-9])", "i");
// The owner's and Windows' folders as a command names them (%USERPROFILE%,
// $env:APPDATA, ${env:LOCALAPPDATA}, ~, $HOME), read as the folders they are
// so the protected folders' check sees them. Per-user ones only with home.
const windowsFolders = (home) => {
  const drive = /^[a-z]:/i.exec(home)?.[0] || "C:";
  const system = { systemdrive: "C:", systemroot: "C:\\Windows", windir: "C:\\Windows", programfiles: "C:\\Program Files", "programfiles(x86)": "C:\\Program Files (x86)",
    programw6432: "C:\\Program Files", commonprogramfiles: "C:\\Program Files\\Common Files", programdata: "C:\\ProgramData", allusersprofile: "C:\\ProgramData", public: "C:\\Users\\Public" };
  return home ? { ...system, userprofile: home, home, homedrive: drive, homepath: home.slice(drive.length) || "\\", appdata: `${home}\\AppData\\Roaming`,
    localappdata: `${home}\\AppData\\Local`, onedrive: `${home}\\OneDrive` } : system;
};
const windowsExpand = (value, home) => {
  const folders = windowsFolders(home);
  return value.replace(/%([a-z0-9_()]+)%|\$\{env:([^}]+)\}|\$env:([a-z0-9_]+)/gi, (whole, a, b, c) => folders[(a || b || c).toLowerCase()] ?? whole)
    .replace(/^~(?=[\\/]|$)/, home || "~").replace(/^\$\{?home\}?(?=[\\/]|$)/i, home || "~");
};

/** Returns null when the command may run, or the reason it may not. */
const isUrl = (value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
export function commandRefusal(command, { protectedPaths = [], home = "", hosts = [], platform = process.platform } = {}) {
  const windows = platform === "win32", paths = windows ? path.win32 : path.posix;
  if (typeof command !== "string" || !command.trim()) return "Enter a command.";
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(command)) return "Hidden control characters are not allowed in commands.";
  // Preserve quoted/embedded arguments before the conservative segment split:
  // script text is not an independently validated navigation URL.
  if (hosts.length && words(command).some((arg) => hosts.some((host) => host && commandHostSubject(lower(arg.text)).includes(lower(host)))))
    return "That's Reach's own address. The agent can't open Reach.";
  const lowered = command.normalize("NFKC").toLowerCase();
  const canonicalPath = (value) => windows ? windowsCanonicalPath(value) : paths.resolve(value);
  const roots = protectedPaths.filter((root) => typeof root === "string" && paths.isAbsolute(root)).map(canonicalPath);
  const protectedPath = (value) => {
    if (windows) {
      // As written, with its folders' names read (%APPDATA%, ~), and as the one file it is.
      const expanded = windowsExpand(value, home);
      const absolute = paths.isAbsolute(expanded) ? canonicalPath(expanded) : null;
      return [value, expanded, absolute ?? ""].some((text) => {
        const separators = text.replace(/\\/g, "/");
        return SECRET_PATH.test(separators) || PRIVATE_LIBRARY.test(separators) || WINDOWS_PRIVATE_DATA.test(separators);
      }) || (absolute !== null && roots.some((root) => windowsWithin(absolute, root)));
    }
    const expanded = value.replace(/^~(?=[\\/]|$)/, home || "~").replace(/^\$\{?HOME\}?(?=[\\/]|$)/, home || "~");
    const absolute = paths.isAbsolute(expanded) ? canonicalPath(expanded) : null;
    const separators = expanded.replace(/\\/g, "/");
    return SECRET_PATH.test(separators) || PRIVATE_LIBRARY.test(separators) || (windows && WINDOWS_PRIVATE_DATA.test(separators)) ||
      (absolute !== null && roots.some((root) => absolute === root || absolute.startsWith(root.endsWith(paths.sep) ? root : root + paths.sep)));
  };
  // On Windows a lone & starts a new command too (cmd).
  for (const raw of windows ? windowsSegments(command) : segments(command)) {
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
    while (index < tokens.length && (skipPrefixes.has(baseName(tokens[index].text)) || /^-/.test(tokens[index].text) ||
      (windows && (WINDOWS_SKIP.has(windowsName(tokens[index].text)) || /^\/[a-z]$/i.test(tokens[index].text))))) index++;
    const first = tokens[index];
    const name = windows ? windowsName(first?.text || "") : baseName(first?.text || "");
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
    if (windows) {
      if (WINDOWS_ADMIN_COMMANDS.has(name)) return "That changes who can control this PC, or reads its secrets.";
      if (name === "schtasks") return "Scheduled jobs would outlive this session.";
      if (WINDOWS_DISK_COMMANDS.has(name)) return "That could erase or shut down this PC.";
      if (WINDOWS_PRIVATE_DATA.test(piece.replace(/\\/g, "/"))) return "That path holds your passwords, keys or Reach's own files.";
      if (WINDOWS_PROTECTED_PROGRAMS.has(name) || (name === "control" && values.some((arg) => /credentialmanager/i.test(arg))) ||
          [first?.text || "", ...values].some((arg) => WINDOWS_SETTINGS_PAGES.some((pattern) => pattern.test(arg.trim()))))
        return "That opens a part of Windows that holds passwords or controls this PC.";
      if (["taskkill", "stop-process"].includes(name) && /reach|node|tailscale/i.test(lowered)) return "That would stop Reach or Windows' own processes.";
      // Read in the whole command too: a quoted path such as "C:\Program
      // Files (x86)\…" is split at its bracket above.
      if (WINDOWS_DELETE.has(name) && (values.some((arg) => !/^[-/]/.test(arg) && WINDOWS_SYSTEM_PATH.test(arg)) || WINDOWS_SYSTEM_PLACE.test(command)))
        return "That would delete Windows' or your apps' own files.";
    }
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
    // On Windows a path also comes as an option's value (-Path:C:\…, /d:C:\…)
    // or a variable's (set X=C:\…).
    const pathArgs = !windows ? values : values.flatMap((arg) => {
      const option = /^[-/][a-z][\w-]*[:=](.+)$/is.exec(arg), assigned = /^[a-z_]\w*=(.+)$/is.exec(arg);
      return option ? [option[1]] : assigned ? [arg, assigned[1]] : [arg];
    });
    for (const arg of pathArgs) if (!arg.startsWith("-") && protectedPath(arg)) return "That path holds your passwords, keys or Reach's own files.";
    if (/(^|\s)(cat|less|more|head|tail|strings|xxd|hexdump|cp|mv|scp|rsync|sqlite3|plutil|python3?|node|ruby|perl)\s/.test(piece) && (SECRET_PATH.test(piece) || PRIVATE_LIBRARY.test(piece)))
      return "That path holds your passwords, keys or Reach's own files.";
    if (windows && /(^|\s)(type|gc|get-content|cat|more|copy|xcopy|robocopy|copy-item|cpi|move|move-item|mi|findstr|select-string|sls|certutil|format-hex|fhx|py|python3?|node|sqlite3)\s/i.test(piece) &&
        SECRET_PATH.test(piece.replace(/\\/g, "/")))
      return "That path holds your passwords, keys or Reach's own files.";
  }
  return null;
}

/** A file an agent may never open or reveal: Reach's own, the browser profiles, keychains, shell histories. */
export function protectedPathReason(target, { protectedPaths = [], home = "", platform = process.platform } = {}) {
  // Windows paths are Windows' (whatever this host), and one file whatever
  // the letters' case, prefix or trimmed dots (windowsCanonicalPath).
  const paths = platform === "win32" ? path.win32 : path.posix;
  const canonical = (value) => platform === "win32" ? windowsCanonicalPath(value) : paths.resolve(value);
  if (typeof target !== "string" || !paths.isAbsolute(target)) return "Give the file's full path.";
  if (platform === "win32" && windowsShortName(target)) return WINDOWS_SHORT_NAME;
  const resolved = canonical(target), separators = resolved.replace(/\\/g, "/");
  const roots = protectedPaths.filter((root) => typeof root === "string" && paths.isAbsolute(root)).map(canonical);
  const within = (root) => platform === "win32" ? windowsWithin(resolved, root) : resolved === root || resolved.startsWith(root.endsWith(paths.sep) ? root : root + paths.sep);
  if (SECRET_PATH.test(separators) || PRIVATE_LIBRARY.test(separators) || (platform === "win32" && WINDOWS_PRIVATE_DATA.test(separators)) || roots.some(within))
    return "That path holds your passwords, keys or Reach's own files.";
  return null;
}

/** Typed text is checked like a command when a terminal or IDE is in front, and always for protected page addresses. */
export function typedTextRefusal(text, { terminalLike = false, hosts = [], protectedPaths = [], home = "", platform = process.platform } = {}) {
  if (typeof text !== "string" || !text) return "Type something.";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const value = line.trim();
    // A recognizable shell command is checked argument by argument below.
    // Direct URLs, malformed addresses and protected schemes retain this check.
    const commandLike = terminalLike && /^[a-z0-9_./~\\-]+\s+\S/i.test(value);
    if (protectedPage(value, commandLike ? [] : hosts, { platform })) return "That page shows saved passwords or runs code. It stays closed to the agent.";
  }
  if (terminalLike) {
    for (const line of lines) {
      const reason = line.trim() ? commandRefusal(line, { protectedPaths, home, hosts, platform }) : null;
      if (reason) return reason;
    }
  }
  return null;
}

// The rules the native checker applies to every event, as plain data. A
// Windows helper gets the same keys with Windows' lists (guardData): Store
// package names as ids, .exe names as names, Settings pages as panes.
export function nativeRules({ preset, apps = [], hidden = [] }, { hosts = [], titles = [], protectedPaths = [], home = "", platform = process.platform } = {}) {
  if (platform === "win32") {
    const data = guardData(platform);
    return { ...nativeRules({ preset, apps, hidden }, { hosts, titles, protectedPaths, home, platform: "darwin" }),
      protectedAppIds: data.appIds, protectedAppNames: data.appNames, privatePanes: data.panes, protectedTitleWords: data.titleWords,
      protectedPagePatterns: data.pages.map((pattern) => pattern.source), terminalLike: data.terminals };
  }
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
