import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentHookCommand,
  installClaudeHook,
  installCodexHook,
  uninstallClaudeHook,
  uninstallCodexHook,
} from "../server/agent-sessions/agent-hook-install.mjs";

// The person's own settings, as Claude Code keeps them (two-space JSON).
const theirs = {
  permissions: { allow: ["Bash(npm test)"] },
  model: "opus",
  hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "/Users/me/.claude/hooks/lint-jsx.sh", timeout: 30 }] }] },
  effortLevel: "max",
};

test("Reach's hook goes into Claude Code's settings once, next to the person's own, and comes out cleanly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hook-install-"));
  const settingsPath = path.join(dir, "settings.json");
  const backupDir = path.join(dir, "backups");
  const original = `${JSON.stringify(theirs, null, 2)}\n`;
  fs.writeFileSync(settingsPath, original);
  const command = agentHookCommand({ node: "/opt/homebrew/bin/node", script: "/r/scripts/agent-hook.mjs", agent: "claude", socketPath: "/r/.reach/it's.sock" });
  assert.equal(command, `'/opt/homebrew/bin/node' '/r/scripts/agent-hook.mjs' 'claude' '/r/.reach/it'\\''s.sock'`);

  assert.deepEqual(installClaudeHook({ settingsPath, backupDir, command }), { changed: true });
  const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(installed.hooks.PostToolUse, theirs.hooks.PostToolUse);
  assert.deepEqual(installed.permissions, theirs.permissions);
  assert.equal(installed.effortLevel, "max");
  assert.deepEqual(installed.hooks.PermissionRequest, [
    { matcher: "*", hooks: [{ type: "command", command, timeout: 86400, statusMessage: "Asking your phone (Reach)" }] },
  ]);
  assert.match(fs.readFileSync(settingsPath, "utf8"), /^\{\n {2}"permissions"/);
  // The file as it was is kept.
  const [backup] = fs.readdirSync(backupDir);
  assert.equal(fs.readFileSync(path.join(backupDir, backup), "utf8"), original);

  // Again: nothing changes, nothing is duplicated.
  assert.deepEqual(installClaudeHook({ settingsPath, backupDir, command }), { changed: false });
  // Reach moved: its one entry is replaced, not added to.
  installClaudeHook({ settingsPath, backupDir, command: command.replace("/r/", "/moved/") });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.PermissionRequest.length, 1);

  assert.deepEqual(uninstallClaudeHook({ settingsPath, backupDir }), { changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), theirs);
  assert.deepEqual(uninstallClaudeHook({ settingsPath, backupDir }), { changed: false });
});

test("someone else's PermissionRequest hook stays when Reach's comes and goes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hook-install-"));
  const settingsPath = path.join(dir, "settings.json");
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard" }] };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PermissionRequest: [other] } }, null, 4));
  // An entry from Reach's first version of the hook is Reach's too.
  installClaudeHook({ settingsPath, command: "'node' '/r/scripts/claude-hook.mjs' '/s'" });
  installClaudeHook({ settingsPath, command: "'node' '/r/scripts/agent-hook.mjs' 'claude' '/s'" });
  const list = JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.PermissionRequest;
  assert.deepEqual(list[0], other);
  assert.equal(list.length, 2);
  assert.match(fs.readFileSync(settingsPath, "utf8"), /^\{\n {4}"hooks"/);
  uninstallClaudeHook({ settingsPath });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { hooks: { PermissionRequest: [other] } });
});

test("Codex's config gets one marked block at the end, trusted only by the person, and loses it cleanly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hook-install-"));
  const configPath = path.join(dir, "config.toml");
  const backupDir = path.join(dir, "backups");
  const original = '[projects."/Users/me/app"]\ntrust_level = "trusted"\n\n[mcp_servers.node_repl]\ncommand = "node"\n';
  fs.writeFileSync(configPath, original);
  const command = agentHookCommand({ node: "/opt/homebrew/bin/node", script: "/r/scripts/agent-hook.mjs", agent: "codex", socketPath: "/r/s.sock" });
  assert.deepEqual(installCodexHook({ configPath, backupDir, command }), { changed: true });
  const installed = fs.readFileSync(configPath, "utf8");
  assert.ok(installed.startsWith(original), "the person's config is untouched");
  assert.equal(
    installed.slice(original.length),
    [
      "",
      "# Reach: answer Codex approvals from your phone. Added by Reach; remove this block to stop.",
      "[[hooks.PermissionRequest]]",
      "",
      "[[hooks.PermissionRequest.hooks]]",
      'type = "command"',
      `command = "'/opt/homebrew/bin/node' '/r/scripts/agent-hook.mjs' 'codex' '/r/s.sock'"`,
      "timeout = 86400",
      'statusMessage = "Asking your phone (Reach)"',
      "# End of Reach's hook.",
      "",
    ].join("\n"),
  );
  assert.ok(!/trusted_hash/.test(installed), "Codex's own review trusts it, not Reach");
  assert.equal(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]), "utf8"), original);
  assert.deepEqual(installCodexHook({ configPath, backupDir, command }), { changed: false });
  installCodexHook({ configPath, backupDir, command: command.replace("/r/s.sock", "/moved/s.sock") });
  assert.equal(fs.readFileSync(configPath, "utf8").split("[[hooks.PermissionRequest]]").length, 2, "one block, replaced");
  assert.deepEqual(uninstallCodexHook({ configPath, backupDir }), { changed: true });
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  assert.deepEqual(uninstallCodexHook({ configPath, backupDir }), { changed: false });
  // Hooks written inline can't take a table: the person adds it by hand.
  fs.writeFileSync(configPath, "hooks = {}\n");
  assert.throws(() => installCodexHook({ configPath, command }), /inline/);
});

test("settings are replaced whole: same permissions, through a symlink, nothing left beside them", async () => {
  const { writeWhole } = await import("../server/agent-sessions/agent-hook-install.mjs");
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "reach-whole-"));
  const real = pathm.join(dir, "dotfiles-settings.json");
  fsm.writeFileSync(real, "{}\n", { mode: 0o640 });
  fsm.chmodSync(real, 0o640);
  const link = pathm.join(dir, "settings.json");
  fsm.symlinkSync(real, link);
  writeWhole(link, '{"a":1}\n');
  assert.equal(fsm.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fsm.readFileSync(real, "utf8"), '{"a":1}\n');
  assert.equal(fsm.statSync(real).mode & 0o777, 0o640);
  assert.deepEqual(fsm.readdirSync(dir).sort(), ["dotfiles-settings.json", "settings.json"]);
  // A new file is the owner's only.
  const fresh = pathm.join(dir, "new.json");
  writeWhole(fresh, "{}\n");
  assert.equal(fsm.statSync(fresh).mode & 0o777, 0o600);
  fsm.rmSync(dir, { recursive: true, force: true });
});
