// "Your chat is done": a chat that was working (or waiting on you) and is now
// finished sends one notification, unless a phone has that chat open right
// then. It looks again when an agent's files change (pushed by agent-watch)
// and, as a fallback, every so often; the first look only learns the states.
import { agentName, chatName, chatEventTitle, pushLine } from "../notification-items.mjs";

const BUSY = new Set(["running", "waiting"]);

export function createDoneWatch({
  list,
  notify,
  // (agent, id): a phone has this chat open now; it sees the reply itself.
  watching = () => false,
  // (agent, id): the agent's last reply, for the notification's text.
  reply = async () => "",
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
          // The chat's name, then the agent's own last words: on an iPhone
          // the icon is always Reach's, so the text tells chats apart.
          const app = agentName(s.agent);
          const said = pushLine(await Promise.resolve().then(() => reply(s.agent, s.id)).catch(() => ""), 200);
          const name = chatName(s.title);
          await notify({
            category: "done",
            title: chatEventTitle(s.title, s.agent, "Finished"),
            body: said ? (name ? `${app}: ${said}` : said) : name ? `${app}’s reply is ready.` : "Your reply is ready.",
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
