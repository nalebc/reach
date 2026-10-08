// Pending conversation choices must survive Reach restarting before Send.
// Persist a dispatch marker before a continuation can reach Claude, so a crash
// or lost acknowledgement cannot silently replay that continuation.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => Object.assign(new Error("Reach couldn't read or save the pending Claude rewind. Check the companion's data folder before continuing."), { status: 503 });
const valid = row => row && typeof row === "object" && !Array.isArray(row) &&
  (row.target === "start" || UUID.test(row.target)) && ["pending", "dispatching"].includes(row.phase);
export function createClaudeRewinds({ file = null } = {}) {
  let rows;
  function load() {
    if (rows) return rows;
    if (!file) return (rows = {});
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw unavailable();
      const data = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      if (data?.version !== 1 || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions) ||
          Object.entries(data.sessions).some(([id, row]) => !UUID.test(id) || !valid(row))) throw unavailable();
      rows = Object.fromEntries(Object.entries(data.sessions).map(([id, row]) => [id, { target: row.target, phase: row.phase }]));
      return rows;
    } catch (error) {
      if (error.code === "ENOENT") return (rows = {});
      throw unavailable();
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  function save(next) {
    if (file) {
      const temp = file + "." + randomUUID() + ".tmp";
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions: next }), { mode: 0o600, flag: "wx" });
        fs.renameSync(temp, file);
      } catch { throw unavailable(); }
      finally { try { fs.unlinkSync(temp); } catch { /* renamed or not created */ } }
    }
    rows = next;
  }
  return {
    get(id) { const row = load()[id]; return row ? { ...row } : null; },
    set(id, row) {
      if (!UUID.test(id) || !valid(row)) throw Object.assign(new Error("Unknown rewind target."), { status: 400 });
      save({ ...load(), [id]: { target: row.target, phase: row.phase } });
    },
    delete(id) { const next = { ...load() }; delete next[id]; save(next); },
  };
}
