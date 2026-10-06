// "Your chat is done": a chat that was working (or waiting on you) and is now
// finished sends one notification, unless a phone has that chat open right
// then. It looks again when an agent's files change (pushed by agent-watch)
// and, as a fallback, every so often; the first look only learns the states.
const BUSY = new Set(["running", "waiting"]);

export function createDoneWatch({
  list,
  notify,
  // (agent, id): a phone has this chat open now; it sees the reply itself.
  watching = () => false,
  everyMs = 20000,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const last = new Map(); // "agent:id" -> status
  let seeded = false;
  let looking = null;
  let again = false;
  const look = async () => {
    if (looking) {
      again = true;
      return looking;
    }
    looking = (async () => {
      do {
        again = false;
        let sessions;
        try {
          sessions = (await list())?.sessions || [];
        } catch {
          return;
        }
        for (const s of sessions) {
          if (!s?.id || !s.agent) continue;
          const key = `${s.agent}:${s.id}`;
          const before = last.get(key);
          last.set(key, s.status || "idle");
          if (!seeded || !BUSY.has(before) || BUSY.has(s.status)) continue;
          if (s.status !== "idle" || watching(s.agent, s.id)) continue;
          // Who, never the chat's words: a notification is read on a lock screen.
          const app = { claude: "Claude Code", codex: "Codex", openclaw: "OpenClaw" }[s.agent] || "Your agent";
          await notify({
            category: "done",
            title: `${app} · Ready for you`,
            body: "The response is ready. Open the conversation to continue.",
            icon: s.agent,
            actions: [{ action: "open", title: "Open conversation" }],
            tag: `done-${s.agent}-${String(s.id).slice(0, 12)}`,
            // One tap: the chat itself (src/deep-link.ts).
            url: `/?page=sessions&agent=${encodeURIComponent(s.agent)}&id=${encodeURIComponent(s.id)}`,
          });
        }
        seeded = true;
      } while (again);
    })().finally(() => {
      looking = null;
    });
    return looking;
  };
  const timer = setTimer(() => void look(), everyMs);
  timer?.unref?.();
  return {
    look,
    stop: () => clearTimer(timer),
  };
}
