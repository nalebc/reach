// Puts Reach's PermissionRequest hook (scripts/agent-hook.mjs), and its
// PreToolUse hook for permission modes (scripts/agent-mode-hook.sh), into
// Claude Code's user settings (and the older Codex entry into Codex's config),
// once, with the person's OK; takes them out again. Only Reach's own entry is touched: other hooks and settings
// stay as they are, and each file keeps its layout. A copy of the file is kept
// before any change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reach's entries, under the hook's current name and its first one.
const MARKS = ["agent-hook.mjs", "claude-hook.mjs", "agent-mode-hook.sh"];
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function agentHookCommand({ node = process.execPath, script, agent, socketPath }) {
  return `${quote(node)} ${quote(script)} ${quote(agent)} ${quote(socketPath)}`;
}
// The PreToolUse hook: a few shell lines, run before every tool call.
export function agentModeHookCommand({ script, modesDir }) {
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
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function edit(settingsPath, backupDir, change) {
  let raw = "";
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const settings = raw.trim() ? JSON.parse(raw) : {};
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

const isReach = (entry) =>
  (entry?.hooks || []).some((h) => MARKS.some((mark) => String(h?.command || "").includes(mark)));

// Each of Reach's hook events, with its entry: the request held for the
// phone (as long as a question may wait), and the mode check before each
// tool call (quick; it never waits).
const claudeEntries = ({ command, modeCommand, timeout }) => ({
  PermissionRequest: { matcher: "*", hooks: [{ type: "command", command, timeout, statusMessage: "Asking your phone (Reach)" }] },
  ...(modeCommand ? { PreToolUse: { matcher: "*", hooks: [{ type: "command", command: modeCommand, timeout: 10 }] } } : {}),
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
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
  } catch {
    return "off";
  }
  const ours = (event) => (Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event].filter(isReach) : []);
  const has = (event, cmd) => ours(event).some((e) => (e.hooks || []).some((h) => h?.command === cmd));
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
