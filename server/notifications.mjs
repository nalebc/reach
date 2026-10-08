import crypto from "node:crypto";
import fs from "node:fs";
import {
  chatNotifications,
  browserNotification,
  admissionNotification,
  restartNotification,
  sealNotification,
  publicNotification,
  notificationPush,
} from "./notification-items.mjs";

const HIDDEN =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Read the same live state as Chat. No transcript scraping, approval hooks,
// or synthetic requests: a notification never creates or answers an approval.
export async function readAttention({
  agentSessions,
  openClaw,
  handoffs,
  browserRequests,
  serviceRequests = () => [],
  admissions,
  accessRequests,
  restartRequests = () => [],
  terminalCount = () => 0,
  // OpenClaw's background work (openclaw-watch.mjs): pushed, not listed.
  background = () => [],
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
      items.push(...chatNotifications(s));
    }
    for (const p of agents.value.macPrompts || [])
      items.push({
        id: `mac:${p.id}`,
        source: "mac",
        sender: "Your computer",
        icon: "mac",
        kind: "computer",
        signature: String(p.id),
        title: "Your computer needs your attention",
        detail: "Review the request on the live screen",
        // Its own words, for the phone's notification (mac-prompts.mjs).
        ...(p.title && { title: String(p.title), summary: String(p.detail || "") }),
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
        sender: "OpenClaw",
        icon: "openclaw",
        kind: "permission",
        signature: String(p.id),
        title: "OpenClaw needs your approval",
        chatTitle:
          claw.value.sessions?.find((s) => s.key === p.sessionKey)?.title || "",
        // Shown only when nothing in it hides what it does (as for chats).
        ...(typeof p.command === "string" &&
          p.command.length <= 8000 &&
          !HIDDEN.test(p.command) && {
            prompt: { command: p.command, cwd: String(p.cwd || "") },
          }),
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
      sender: h.agent,
      icon: /claude/i.test(h.agent)
        ? "claude"
        : /codex/i.test(h.agent)
          ? "codex"
          : "agent",
      kind: "handoff",
      push: false,
      title: `${h.agent} needs you in ${h.app}`,
      detail: h.reason,
      target: { page: "apps", threadId: h.threadId },
    });
  for (const r of browserRequests().filter(
    (r) => !r.status || r.status === "pending",
  ))
    items.push(browserNotification(r));
  for (const r of admissions()) items.push(admissionNotification(r));
  for (const r of serviceRequests().filter((r) => r.status === "pending"))
    items.push({ id: `service:${r.id}`, source: "service", sender: r.agentName,
      icon: "agent", kind: "connection", push: false,
      title: "Review service access", detail: `${r.serviceName} · ${r.permissions.join(", ")}`,
      summary: "Read-only service access",
      target: { page: "overview", needs: `service:${r.id}` } });
  for (const r of accessRequests().filter((r) => r.status === "pending"))
    items.push(
      sealNotification(
        {
          id: `access:${r.id}`,
          source: "access",
          sender: r.name,
          icon: "agent",
          kind: "connection",
          push: false,
          title: "Review requested access",
          detail: "Agent connection",
          summary: "Review the permissions this agent is requesting.",
          target: { page: "overview", needs: `device:${r.id}` },
          actions: [{ id: "deny", label: "Deny", tone: "deny" }],
        },
        { type: "access", id: r.id, evidence: r.scopes },
      ),
    );
  for (const r of restartRequests())
    items.push(restartNotification(r, terminalCount()));
  try {
    items.push(...background());
  } catch {}
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
  intervalMs = 30000,
  wakeMs = 250,
}) {
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  let timer,
    wakeTimer,
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
            ...notificationPush(item),
            category:
              item.category ||
              (["mac", "restart"].includes(item.source) ? "computer" : "chat"),
            tag: `need-${key.slice(0, 24)}`,
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
        // Push-only alerts (bell: false) were deduplicated above.
        items: snapshot.items
          .filter((item) => item.bell !== false)
          .map(publicNotification),
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
    wake() {
      if (closed || !timer || wakeTimer) return;
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        if (enabled()) void refresh({ fresh: true }).catch(() => {});
      }, wakeMs);
      wakeTimer.unref?.();
    },
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(wakeTimer);
    },
  };
}
