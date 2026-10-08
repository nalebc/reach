// Shared by the phone and the watcher. Gemini is listed so its place can
// be saved, but Reach currently reads its chats and cannot resume them.
export const CONTINUE_PRIORITY = ["codex", "claude", "gemini", "openclaw"];
export const canContinue = (agent) => ["codex", "claude", "openclaw"].includes(agent);
export function continueUnavailable(agent, health = []) {
  if (!canContinue(agent)) return "Read-only in Reach";
  const h = health.find((h) => h.agent === agent);
  if (!h?.installed) return "Not installed";
  if (agent === "openclaw") {
    if (!h.connected) return "Not connected";
    if (h.canTakeMoves !== true) return "Chat transfer unavailable";
  } else if (!h.signedIn) return "Not signed in";
  if (h.usable === false) return "Out of usage";
  return "";
}
export function checkContinuePriority(priority) {
  if (!Array.isArray(priority) || priority.length < 2 || priority.length > CONTINUE_PRIORITY.length ||
      new Set(priority).size !== priority.length || priority.some((a) => !CONTINUE_PRIORITY.includes(a)))
    throw Object.assign(new Error("Choose at least two different providers in priority order."), { status: 400 });
  return [...priority];
}
