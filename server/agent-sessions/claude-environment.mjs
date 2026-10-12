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
