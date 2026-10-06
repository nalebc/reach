import crypto from "node:crypto";
import fs from "node:fs";

const names = {
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  openclaw: "OpenClaw",
};
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Read the same live state as Chat. No transcript scraping, approval hooks,
// or synthetic requests: a notification never creates or answers an approval.
export async function readAttention({
  agentSessions,
  openClaw,
  handoffs,
  browserRequests,
  admissions,
  accessRequests,
}) {
  const [agents, claw] = await Promise.allSettled([
    Promise.resolve().then(() => agentSessions.list()),
    Promise.resolve().then(() => openClaw.overview()),
  ]);
  const items = [];
  const unavailable = new Set();
  if (agents.status === "fulfilled") {
    for (const source of Object.keys(agents.value.errors || {}))
      unavailable.add(source);
    for (const s of agents.value.sessions || []) {
      if (s.archived || s.status !== "waiting" || unavailable.has(s.agent))
        continue;
      items.push({
        id: `chat:${s.agent}:${s.id}`,
        source: s.agent,
        signature:
          (s.prompts || [])
            .map((p) => String(p.id))
            .sort()
            .join(",") ||
          s.consent?.id ||
          "waiting",
        title: `${names[s.agent] || "An agent"} needs your answer`,
        detail: s.title || "Open the chat to respond",
        target: { page: "sessions", agent: s.agent, id: s.id },
      });
    }
    for (const p of agents.value.macPrompts || [])
      items.push({
        id: `mac:${p.id}`,
        source: "mac",
        signature: String(p.id),
        title: "Your computer needs your attention",
        detail: "Review the request on the live screen",
        target: { page: "screen" },
      });
  } else
    for (const source of ["codex", "claude", "gemini", "mac"])
      unavailable.add(source);
  if (claw.status === "fulfilled" && claw.value.connected) {
    for (const p of claw.value.approvals || [])
      items.push({
        id: `openclaw:${p.id}`,
        source: "openclaw",
        signature: String(p.id),
        title: "OpenClaw needs your approval",
        detail:
          claw.value.sessions?.find((s) => s.key === p.sessionKey)?.title ||
          "Open OpenClaw to review",
        target: {
          page: "sessions",
          agent: "openclaw",
          ...(p.sessionKey && { id: p.sessionKey }),
        },
      });
  } else unavailable.add("openclaw");
  // These already send push from the event that creates them. Include their
  // current requests in the bell without sending them a second time.
  for (const h of handoffs())
    items.push({
      id: `handoff:${h.id}`,
      source: "handoff",
      push: false,
      title: `${h.agent} needs you in ${h.app}`,
      detail: h.reason,
      target: { page: "apps", threadId: h.threadId },
    });
  for (const r of browserRequests())
    items.push({
      id: `browser:${r.id}`,
      source: "browser",
      push: false,
      title: "An AI browser needs your approval",
      detail: r.name,
      // Opened for review straight away (src/deep-link.ts), not just Home.
      target: { page: "overview", needs: `browser:${r.id}` },
    });
  for (const r of admissions())
    items.push({
      id: `admission:${r.requestId}`,
      source: "admission",
      push: false,
      title: `${r.name} wants to connect`,
      detail: "Review the connection request",
      target: { page: "overview", needs: `agent-admission:${r.requestId}` },
    });
  for (const r of accessRequests().filter((r) => r.status === "pending"))
    items.push({
      id: `access:${r.id}`,
      source: "access",
      push: false,
      title: `${r.name} asks for access`,
      detail: "Review requested access",
      target: { page: "agents" },
    });
  return { items, unavailable: [...unavailable] };
}

// Runs on the computer, even when every phone has closed Reach. Only poll
// in the background when an owner has enabled push. Concurrent phone reads
// share a scan; failed providers don't erase deduplication state.
export function createNotifications({
  read,
  notify,
  enabled,
  file,
  intervalMs = 5000,
}) {
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  let timer,
    pending,
    cached,
    checkedAt = 0,
    closed = false;
  const save = () => {
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(seen), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* A read-only disk must not interrupt agent work. */
    }
  };
  const refresh = ({ fresh = false } = {}) => {
    if (pending) return pending;
    if (!fresh && cached && Date.now() - checkedAt < 2000)
      return Promise.resolve(cached);
    pending = (async () => {
      const snapshot = await read();
      if (closed) return { items: [], unavailable: [] };
      const present = new Set(snapshot.items.map((item) => digest(item.id)));
      let changed = false;
      for (const [key, old] of Object.entries(seen)) {
        if (!present.has(key) && !snapshot.unavailable.includes(old.source)) {
          delete seen[key];
          changed = true;
        }
      }
      for (const item of snapshot.items) {
        if (item.push === false || !enabled()) continue;
        const key = digest(item.id);
        const signature = digest(item.signature || "waiting");
        const old = seen[key];
        // A wait gaining a request id is still the same wait.
        if (old?.signature === signature) continue;
        if (old?.signature === digest("waiting")) {
          seen[key] = { source: item.source, signature };
          changed = true;
          continue;
        }
        try {
          const result = await notify({
            title: item.title,
            category: item.source === "mac" ? "computer" : "chat",
            tag: `need-${key.slice(0, 24)}`,
            url: "/?notifications=1",
          });
          if (result?.sent > 0 || result?.suppressed > 0) {
            seen[key] = { source: item.source, signature };
            changed = true;
          }
        } catch {
          /* Retry at the next scan, without interrupting the UI. */
        }
      }
      if (changed) save();
      cached = {
        items: snapshot.items.map(
          ({ source, signature, push, ...item }) => item,
        ),
        unavailable: snapshot.unavailable,
      };
      checkedAt = Date.now();
      return cached;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  return {
    refresh,
    start() {
      if (timer || closed) return;
      const tick = () => {
        if (enabled()) void refresh({ fresh: true }).catch(() => {});
      };
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
