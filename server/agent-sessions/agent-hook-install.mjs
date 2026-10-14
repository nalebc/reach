// Puts Reach's PermissionRequest hook (scripts/agent-hook.mjs), and its
// PreToolUse hook for permission modes (scripts/agent-mode-hook.sh), into
// Claude Code's user settings (and the older Codex entry into Codex's config),
// once, with the person's OK; takes them out again. Only Reach's own entry is touched: other hooks and settings
// stay as they are, and each file keeps its layout. A copy of the file is kept
// before any change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reach's entries, under the hook's current name and its first one, on either
// platform (the Windows mode hook is a Node script, not the Mac's /bin/sh one).
const MARKS = ["agent-hook.mjs", "claude-hook.mjs", "agent-mode-hook.sh", "agent-mode-hook.mjs"];
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// On a Mac, Claude Code runs a hook's `command` through a shell, so Reach's
// command is a quoted shell line. On Windows it uses Git Bash, or PowerShell
// when Git Bash is missing, and a shell-less exec form (an `args` array, run
// since Claude Code 2.1.139) is the only form that needs neither: Reach's own
// node.exe is spawned directly with each argument exactly as written, no
// quoting, no Git Bash. So on Windows the command is { command, args }; on a
// Mac it stays the shell string, byte for byte as before.
// The hook reads the request on stdin and the pipe name from an owner-only
// file in the data folder, never from its arguments: a pipe name freed by a
// restart leaves nothing stale in Claude Code's settings.
export function agentHookCommand({ node = process.execPath, script, agent, socketPath, dataDir, platform = process.platform }) {
  if (platform === "win32") return { command: node, args: [script, agent, "--pipe-dir", dataDir] };
  return `${quote(node)} ${quote(script)} ${quote(agent)} ${quote(socketPath)}`;
}
// The PreToolUse hook, run before every tool call: a few shell lines on a Mac
// (/bin/sh, no Node start-up); a small Node script on Windows, where /bin/sh
// isn't a given and PowerShell's start-up would be too slow before every
// call. Exec form there too, so it needs no shell.
export function agentModeHookCommand({ script, modesDir, node = process.execPath, platform = process.platform }) {
  if (platform === "win32") return { command: node, args: [script, modesDir] };
  return `/bin/sh ${quote(script)} ${quote(modesDir)}`;
}

// Whole or not at all: written beside it, then moved over it (a Claude Code
// or Codex reading it meanwhile, or Reach stopping halfway, never sees half a
// file). Keeps the file's own permissions; a symlink's target is written.
export function writeWhole(file, text) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {}
  const tmp = `${target}.reach-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    // Windows holds a lock for a moment (an antivirus scanning the new file,
    // Claude Code reading its settings): a rename that hits it is retried a
    // few times before giving up, so the file isn't left half-written.
    for (let tries = 0; ; tries++) {
      try {
        fs.renameSync(tmp, target);
        break;
      } catch (error) {
        if (tries >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        const until = Date.now() + 25;
        while (Date.now() < until) {}
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
// A UTF-8 BOM (Notepad adds one) breaks JSON.parse: dropped on read, not
// written back, so Reach's own write never carries one.
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function edit(settingsPath, backupDir, change) {
  let raw = "";
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const settings = stripBom(raw).trim() ? JSON.parse(stripBom(raw)) : {};
  const before = JSON.stringify(settings);
  change(settings);
  if (JSON.stringify(settings) === before) return { changed: false };
  if (raw && backupDir) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(backupDir, `claude-settings-${stamp}.json`), raw, { mode: 0o600 });
  }
  const indent = raw.match(/\n( +|\t)"/)?.[1] || "  ";
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeWhole(settingsPath, JSON.stringify(settings, null, indent) + (raw && !raw.endsWith("\n") ? "" : "\n"));
  return { changed: true };
}

// Reach's command runs one of its scripts, by path (<Reach>/scripts/<mark>):
// a token of the shell command (a Mac), or an element of the exec-form `args`
// (Windows). A user's hook that only has a similar name in it
// (my-agent-hook.mjs, or a comment) isn't Reach's.
const scriptsOf = (command) =>
  [...String(command || "").matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] ?? m[2]).replace(/'\\''/g, "'"));
// A token that names one of Reach's scripts, whichever way the path is
// written: on a Mac the stored path has forward slashes; a Windows path has
// backslashes, which a Mac's path.basename wouldn't split (and vice versa),
// so both separators are tried.
const marksAScript = (token) => {
  const t = String(token || "");
  for (const p of [path.posix, path.win32]) if (MARKS.includes(p.basename(t)) && p.basename(p.dirname(t)) === "scripts") return true;
  return false;
};
// A hook's tokens: its exec-form command and args (Windows), or the shell
// command split into tokens (a Mac).
const hookTokens = (h) => (Array.isArray(h?.args) ? [h.command, ...h.args] : scriptsOf(h?.command));
const isReachCommand = (command) => scriptsOf(command).some(marksAScript);
const isReach = (entry) => (entry?.hooks || []).some((h) => hookTokens(h).some(marksAScript));

// Each of Reach's hook events, with its entry: the request held for the
// phone (as long as a question may wait), and the mode check before each
// tool call (quick; it never waits). A command may be a shell string (a Mac)
// or { command, args } for Windows' shell-less exec form.
const asHook = (command, extra) => (command && typeof command === "object" ? { type: "command", ...command, ...extra } : { type: "command", command, ...extra });
const claudeEntries = ({ command, modeCommand, timeout }) => ({
  PermissionRequest: { matcher: "*", hooks: [asHook(command, { timeout, statusMessage: "Asking your phone (Reach)" })] },
  ...(modeCommand ? { PreToolUse: { matcher: "*", hooks: [asHook(modeCommand, { timeout: 10 })] } } : {}),
});

export function installClaudeHook({
  settingsPath = path.join(os.homedir(), ".claude", "settings.json"),
  backupDir,
  command,
  modeCommand,
  // Long enough for a question to wait for the phone; Reach lets go once it's
  // answered on the Mac.
  timeout = 24 * 60 * 60,
}) {
  const entries = claudeEntries({ command, modeCommand, timeout });
  return edit(settingsPath, backupDir, (settings) => {
    settings.hooks ??= {};
    for (const [event, entry] of Object.entries(entries)) {
      const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const others = list.filter((e) => !isReach(e));
      const current = list.filter(isReach);
      if (current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(entry)) continue;
      settings.hooks[event] = [...others, entry];
    }
  });
}

// Whether Claude Code runs Reach's hooks: "on" (these commands), "outdated"
// (Reach's entries, other commands: Node or Reach moved, or one missing), or
// "off".
export function claudeHookState({ settingsPath = path.join(os.homedir(), ".claude", "settings.json"), command, modeCommand }) {
  let settings;
  try {
    settings = JSON.parse(stripBom(fs.readFileSync(settingsPath, "utf8")) || "{}");
  } catch {
    return "off";
  }
  const ours = (event) => (Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event].filter(isReach) : []);
  // "On" means the exact command Reach runs now: a shell string (a Mac), or
  // the same exec-form command and args (Windows). Node moved, Reach moved, or
  // an older entry (a different pipe-dir, or the Mac's /bin/sh line) reads as
  // out of date, exactly as a changed string does on a Mac.
  const sameCommand = (h, cmd) =>
    cmd && typeof cmd === "object" ? h?.command === cmd.command && JSON.stringify(h?.args) === JSON.stringify(cmd.args) : h?.command === cmd;
  const has = (event, cmd) => ours(event).some((e) => (e.hooks || []).some((h) => sameCommand(h, cmd)));
  if (!ours("PermissionRequest").length && !ours("PreToolUse").length) return "off";
  return has("PermissionRequest", command) && (!modeCommand || has("PreToolUse", modeCommand)) ? "on" : "outdated";
}

export function uninstallClaudeHook({ settingsPath = path.join(os.homedir(), ".claude", "settings.json"), backupDir }) {
  return edit(settingsPath, backupDir, (settings) => {
    for (const event of ["PermissionRequest", "PreToolUse"]) {
      const list = settings.hooks?.[event];
      if (!Array.isArray(list) || !list.some(isReach)) continue;
      const others = list.filter((e) => !isReach(e));
      if (others.length) settings.hooks[event] = others;
      else delete settings.hooks[event];
    }
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  });
}

// Codex: one marked block at the end of config.toml. Codex runs a new hook only
// once the person has trusted it (its /hooks review); Reach never marks it
// trusted itself.
const CODEX_START = "# Reach: answer Codex approvals from your phone. Added by Reach; remove this block to stop.";
const CODEX_END = "# End of Reach's hook.";
const tomlString = (s) => JSON.stringify(String(s));
const withoutCodexBlock = (raw) => {
  const start = raw.indexOf(CODEX_START);
  const end = raw.indexOf(CODEX_END);
  if (start < 0 || end < start) return raw;
  return (raw.slice(0, start).replace(/\n+$/, "\n") + raw.slice(end + CODEX_END.length).replace(/^\n+/, "")).replace(
    /^\n+$/,
    "",
  );
};
function editText(file, backupDir, change, label) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const next = change(raw);
  if (next === raw) return { changed: false };
  if (raw && backupDir) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(backupDir, `${label}-${stamp}`), raw, { mode: 0o600 });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeWhole(file, next);
  return { changed: true };
}

export function installCodexHook({
  configPath = path.join(os.homedir(), ".codex", "config.toml"),
  backupDir,
  command,
  timeout = 24 * 60 * 60,
}) {
  const block = [
    CODEX_START,
    "[[hooks.PermissionRequest]]",
    "",
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    `command = ${tomlString(command)}`,
    `timeout = ${timeout}`,
    'statusMessage = "Asking your phone (Reach)"',
    CODEX_END,
  ].join("\n");
  return editText(
    configPath,
    backupDir,
    (raw) => {
      // A `hooks = { … }` written inline can't take an appended table.
      if (/^\s*hooks\s*=/m.test(raw)) throw new Error("Codex's config defines hooks inline; add Reach's hook by hand.");
      const rest = withoutCodexBlock(raw);
      return `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${rest ? "\n" : ""}${block}\n`;
    },
    "codex-config.toml",
  );
}

export function uninstallCodexHook({ configPath = path.join(os.homedir(), ".codex", "config.toml"), backupDir }) {
  return editText(configPath, backupDir, withoutCodexBlock, "codex-config.toml");
}
