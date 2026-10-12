import fs from "node:fs";
import path from "node:path";
import { envValue } from "../agent-cli.mjs";

// Login, account checks and chat processes must use the same Claude profile.
// Keep the owner's Git Bash executable choice, but discard inherited host
// session flags, credentials and Reach settings (case-insensitive on Windows).
// Custom CLAUDE_CONFIG_DIR support also needs transcript-root handling; retain
// the default-profile behavior until those paths are supported together.
export function claudeEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^CLAUDE_CODE_GIT_BASH_PATH$/i.test(key) || !/^(CLAUDE|ANTHROPIC|REACH_)/i.test(key),
  ));
}

const fileAt = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
// Git Bash, which Claude Code on Windows won't start without: the owner's
// CLAUDE_CODE_GIT_BASH_PATH when set, else in Git for Windows' usual folders
// or beside git on PATH (Git\cmd\git.exe, Git\bin\bash.exe), as Claude Code
// looks; null when there's none, so a chat says so instead of failing vaguely.
export function windowsGitBash(env = process.env, { isFile = fileAt } = {}) {
  const chosen = envValue(env, "CLAUDE_CODE_GIT_BASH_PATH");
  if (chosen) return isFile(chosen) ? chosen : null;
  const local = envValue(env, "LOCALAPPDATA");
  const gits = [envValue(env, "PROGRAMFILES"), envValue(env, "PROGRAMW6432"), "C:\\Program Files", local && path.join(local, "Programs")]
    .filter(Boolean)
    .map((dir) => path.join(dir, "Git"));
  for (const dir of (envValue(env, "PATH") || "").split(";").filter(Boolean))
    if (isFile(path.join(dir, "git.exe"))) gits.push(path.dirname(dir));
  return gits.map((git) => path.join(git, "bin", "bash.exe")).find((bash) => isFile(bash)) || null;
}
