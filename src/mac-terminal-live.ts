// The Mac's live connection says when its Terminal windows change
// ("macTerminals" in the presence changes, server/mac-terminal-watch.mjs).
// Undefined from a computer that doesn't (older Reach, not watching yet):
// those are asked every few seconds as before.
export function macTerminalsFingerprint(changes?: string): string | undefined {
  if (!changes) return undefined;
  try {
    const value = JSON.parse(changes).macTerminals;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
