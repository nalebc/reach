// A chat's turn ending, seen in the chat list and confirmed by reading the
// chat. The list's status is a guess for some chats (the Claude app's comes
// from its registry and from how recently it wrote), so a chat that stopped
// working is read again a few seconds later: its turn has ended only if it
// still isn't working then. What it ended on comes with it (turnOutcome).
const BUSY = new Set(["running", "waiting"]);

// How a chat's latest turn ended, from its newest items:
// - reply: the agent's words came after your last message, and nothing after;
// - error: it ended on an error (a used-up limit among them);
// - stopped: you stopped it;
// - open: anything else (working on a tool, nothing yet, a question asked).
// request: your message that began the turn; turn: everything after it.
export function turnOutcome(items = []) {
  let start = -1;
  for (let i = items.length - 1; i >= 0; i--)
    if (items[i]?.role === "user") {
      start = i;
      break;
    }
  const request = start >= 0 ? items[start] : null;
  const turn = items.slice(start + 1).filter(Boolean);
  if (turn.some((i) => i.role === "system" && i.kind === "notice" && i.text === "Stopped")) return { kind: "stopped", request, turn };
  const last = turn.filter((i) => i.kind !== "notice" && i.kind !== "compaction").at(-1);
  if (!last) return { kind: "open", request, turn };
  if (last.kind === "error") return { kind: "error", item: last, request, turn };
  if (last.role === "assistant" && last.kind === "text" && String(last.text || "").trim() && !last.questions?.length)
    return { kind: "reply", item: last, request, turn };
  return { kind: "open", request, turn };
}

// An error that is a used-up limit, in each agent's own words (as the phone
// reads them, src/agent-sessions.ts usageLink).
export function usageLimited(agent, item) {
  const text = String(item?.text || "");
  if (agent === "codex") return item?.detail === "usageLimitExceeded" || /hit your usage limit|purchase more credits/i.test(text);
  if (agent === "claude")
    return (
      item?.detail === "billing_error" ||
      /hit your [\w' ]{0,30}limit|usage limit|out of (extra )?usage|usage credits|spend limit|credit balance/i.test(text)
    );
  if (agent === "openclaw") return /usage limit|out of (extra )?usage|credit balance|insufficient credits|quota exhausted/i.test(text);
  return false;
}

// The files a turn changed, each once, as written (Claude Code's relative to
// the chat's folder, Codex's as it gives them; several in one Codex item).
export function changedFiles(turn = []) {
  const files = [];
  for (const item of turn)
    if (item?.role === "tool" && item.kind === "file-change")
      for (const file of String(item.text || "").split(", "))
        if (file.trim() && !files.includes(file.trim())) files.push(file.trim());
  return files;
}

export function createTurnWatch({
  list,
  // (agent, id) → the chat's newest page ({ session, items }).
  read,
  // Each ended turn, once: ({ session, outcome }).
  onEnded = () => {},
  settleMs = 4000,
  everyMs = 20000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setEvery = setInterval,
  clearEvery = clearInterval,
}) {
  const last = new Map(); // "agent:id" -> status
  const pending = new Map(); // "agent:id" -> timer
  let seeded = false;
  let looking = null;
  let again = false;
  let stopped = false;
  const confirm = async (s) => {
    const key = `${s.agent}:${s.id}`;
    pending.delete(key);
    if (stopped) return;
    let page;
    try {
      page = await read(s.agent, s.id);
    } catch {
      return;
    }
    // Working again (or still): the turn hasn't ended after all.
    // Only a plain "idle" is an ended turn; a status Reach doesn't know isn't.
    if (!page?.session || page.session.status !== "idle" || BUSY.has(last.get(key))) return;
    await Promise.resolve()
      .then(() => onEnded({ session: { ...s, ...page.session, agent: s.agent, id: s.id }, outcome: turnOutcome(page.items || []) }))
      .catch(() => {});
  };
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
          if (!seeded || !BUSY.has(before) || s.status !== "idle" || pending.has(key)) continue;
          const timer = setTimer(() => void confirm(s), settleMs);
          timer?.unref?.();
          pending.set(key, timer);
        }
        seeded = true;
      } while (again);
    })().finally(() => {
      looking = null;
    });
    return looking;
  };
  const timer = setEvery(() => void look(), everyMs);
  timer?.unref?.();
  return {
    look,
    stop() {
      stopped = true;
      clearEvery(timer);
      for (const t of pending.values()) clearTimer(t);
      pending.clear();
    },
  };
}
