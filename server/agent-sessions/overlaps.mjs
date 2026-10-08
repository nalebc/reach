// Which files each chat changed lately, and the files two chats changed at
// once (docs/ACROSS_AGENTS.md): read from the chats themselves, only those
// working now or written in the last half hour (a dozen at most), each kept
// until its chat changes again. Paths are full paths in the chat's folder, so
// separate worktrees never count as the same file.
import path from "node:path";

export const WINDOW_MS = 30 * 60 * 1000;
const BUSY = new Set(["running", "waiting"]);

// A chat's file changes since `from` (ms), as full paths, newest first. A
// change without a time counts (its chat was written within the window).
export function recentChanges(items = [], cwd = "/", from = 0) {
  const files = new Map(); // full path → when
  for (const item of items) {
    if (item?.role !== "tool" || item.kind !== "file-change") continue;
    const at = Number(item.at) || 0;
    if (at && at < from) continue;
    for (const name of String(item.text || "").split(", ")) {
      if (!name.trim()) continue;
      const file = path.resolve(cwd || "/", name.trim());
      files.set(file, Math.max(files.get(file) || 0, at));
    }
  }
  return [...files.entries()].sort((a, b) => b[1] - a[1]).map(([file, at]) => ({ file, at }));
}

// The files more than one chat changed, with who and when.
export function findOverlaps(chats = []) {
  const byFile = new Map();
  for (const c of chats)
    for (const f of c.files || []) byFile.set(f.file, [...(byFile.get(f.file) || []), { agent: c.agent, id: c.id, title: c.title || "", at: f.at }]);
  return [...byFile.entries()]
    .filter(([, list]) => new Set(list.map((c) => `${c.agent}:${c.id}`)).size > 1)
    .map(([file, list]) => ({ file, chats: list }))
    .sort((a, b) => Math.max(...b.chats.map((c) => c.at)) - Math.max(...a.chats.map((c) => c.at)));
}

export function createOverlaps({ list, read, windowMs = WINDOW_MS, max = 12, now = Date.now }) {
  // "agent:id" → { updatedAt, cwd, changes } (only its file changes are kept).
  const kept = new Map();
  return {
    async scan() {
      const from = now() - windowMs;
      const recent = ((await list())?.sessions || [])
        .filter((s) => !s.archived && (s.agent === "codex" || s.agent === "claude") && (BUSY.has(s.status) || (s.updatedAt || 0) > from))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, max);
      const chats = [];
      for (const s of recent) {
        const key = `${s.agent}:${s.id}`;
        let entry = kept.get(key);
        // Read again when it changed, and while it works (its file may not say yet).
        if (!entry || entry.updatedAt !== s.updatedAt || BUSY.has(s.status)) {
          try {
            const page = await read(s.agent, s.id);
            entry = {
              updatedAt: s.updatedAt,
              cwd: page.session?.cwd || s.cwd || "/",
              changes: (page.items || []).filter((i) => i?.role === "tool" && i.kind === "file-change").map(({ role, kind, text, at }) => ({ role, kind, text, at })),
            };
          } catch {
            continue;
          }
          kept.set(key, entry);
        }
        chats.push({ agent: s.agent, id: s.id, title: s.title || "", cwd: entry.cwd, status: s.status, files: recentChanges(entry.changes, entry.cwd, from) });
      }
      for (const key of [...kept.keys()]) if (!recent.some((s) => `${s.agent}:${s.id}` === key)) kept.delete(key);
      return { chats, overlaps: findOverlaps(chats), windowMs };
    },
  };
}
