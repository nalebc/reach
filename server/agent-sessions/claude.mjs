import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClaudeTranscript } from "./claude-transcript.mjs";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const origins = { "claude-desktop": "app", cli: "cli", "sdk-cli": "reach" };
const signIn = (stdout) => {
  const status = JSON.parse(String(stdout));
  if (typeof status.loggedIn !== "boolean") throw new Error("Unexpected status.");
  return { agent: "claude", installed: true, signedIn: status.loggedIn, usable: status.loggedIn };
};

// Claude Code sessions: transcripts under ~/.claude/projects/<folder>/<id>.jsonl
// (the content), plus the Claude app's own records, which decide what the app
// lists (verified: CLI sessions appear there only after a claude://resume
// import). Transcripts older than about 30 days are deleted by Claude Code
// while app records remain; those have no history to show and are skipped.
export function createClaudeSessions({
  projects = path.join(os.homedir(), ".claude", "projects"),
  appRecords = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  cli = "claude",
  run = exec,
  env = process.env,
  // Reads a transcript as it grows (claude-transcript.mjs).
  reader = createClaudeTranscript,
} = {}) {
  // Per transcript: the conversation, and while it is being written to, where
  // reading stopped. A working session's transcript only grows (one line per
  // event), so a change means reading what was appended, not the whole file
  // again (verified: a 70 MB one took half a second each time).
  const cache = new Map(); // file -> { ino, size, mtimeMs, head, offset, transcript, parsed, at }
  let swept = 0;
  const bytes = async (handle, position, length) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  };
  async function parse(file) {
    const stat = await fs.stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;
    const handle = await fs.open(file, "r");
    try {
      // Its first bytes tell a file that grew from one written anew.
      const head = (await bytes(handle, 0, Math.min(256, stat.size))).toString("latin1");
      let entry = hit;
      if (!(hit?.transcript && hit.ino === stat.ino && stat.size >= hit.offset && hit.head === head.slice(0, hit.head.length))) {
        entry = { ino: stat.ino, head: "", offset: 0, transcript: reader() };
        cache.set(file, entry);
      }
      // A last line without its newline yet is read now if it's whole, and
      // again next time (reading a line twice changes nothing); reading
      // resumes after the last newline.
      const added = await bytes(handle, entry.offset, stat.size - entry.offset);
      entry.transcript.add(added.toString("utf8"));
      entry.offset += added.lastIndexOf(10) + 1;
      Object.assign(entry, { head, size: stat.size, mtimeMs: stat.mtimeMs, parsed: entry.transcript.view(), at: Date.now() });
      // Transcripts no longer written to keep only their conversation.
      if (Date.now() - swept > 60 * 1000) {
        swept = Date.now();
        for (const other of cache.values()) if (other !== entry && Date.now() - other.at > 10 * 60 * 1000) other.transcript = null;
      }
      return entry.parsed;
    } finally {
      await handle.close();
    }
  }
  async function transcripts() {
    const files = [];
    let folders = [];
    try {
      folders = await fs.readdir(projects, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const dir = path.join(projects, folder.name);
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const id = entry.name.slice(0, -6);
        if (entry.isFile() && entry.name.endsWith(".jsonl") && UUID.test(id)) files.push({ id, file: path.join(dir, entry.name) });
      }
    }
    return files;
  }
  async function records() {
    const byCli = new Map();
    const walk = async (dir, depth) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (entry.isFile() && /^local_.+\.json$/.test(entry.name)) {
          try {
            const r = JSON.parse(await fs.readFile(full, "utf8"));
            if (r.cliSessionId) byCli.set(r.cliSessionId, r);
          } catch {}
        }
      }
    };
    await walk(appRecords, 0);
    return byCli;
  }
  async function summary({ id, file }, appRecord) {
    const parsed = await parse(file);
    if (!parsed.items.length) return null;
    const last = [...parsed.items].reverse().find((i) => i.role !== "tool" && i.text) || parsed.items.at(-1);
    return {
      agent: "claude",
      id,
      title: appRecord?.title || parsed.title || "Untitled Claude session",
      cwd: parsed.cwd || appRecord?.cwd || "",
      branch: parsed.gitBranch || "",
      origin: appRecord ? "app" : origins[parsed.entrypoint] || "cli",
      inApp: !!appRecord,
      appSessionId: appRecord?.sessionId || null,
      updatedAt: parsed.updatedAt,
      createdAt: parsed.items[0]?.at || 0,
      status: "idle",
      preview: String(last?.text || "").split("\n")[0].slice(0, 200),
      archived: !!appRecord?.isArchived,
      // What the Claude app shows under its composer, from its own record.
      model: appRecord?.model || parsed.model || null,
      effort: appRecord?.effort || null,
      mode: appRecord?.permissionMode || null,
      // The transcript ends mid-turn (a prompt or a tool call, no answer yet).
      pending: ["user", "tool"].includes(parsed.items.at(-1)?.role),
      // The Claude app's own consent card waits on you (claude-transcript.mjs).
      ...(parsed.items.at(-1)?.consent ? { consent: parsed.items.at(-1).consent } : {}),
    };
  }
  async function locate(id) {
    if (!UUID.test(id)) return null;
    return (await transcripts()).find((t) => t.id === id) || null;
  }
  return {
    async list() {
      const [files, byCli] = await Promise.all([transcripts(), records()]);
      const out = [];
      for (const t of files) {
        try {
          const s = await summary(t, byCli.get(t.id));
          if (s) out.push(s);
        } catch {
          /* unreadable transcript: leave it out */
        }
      }
      return out;
    },
    async read(id, { before = null, limit = 200 } = {}) {
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const byCli = await records();
      const parsed = await parse(found.file);
      // Pages count back from the newest item; `before` is an item index.
      const end = before === null ? parsed.items.length : Math.max(0, Math.min(Number(before) || 0, parsed.items.length));
      const start = Math.max(0, end - Math.min(Math.max(limit, 1), 500));
      return {
        session: await summary(found, byCli.get(id)),
        items: parsed.items.slice(start, end),
        before: start > 0 ? String(start) : null,
      };
    },
    // Session start times per folder, to match app processes started without
    // --resume (live detection).
    async starts() {
      const out = [];
      for (const t of await transcripts()) {
        try {
          const parsed = await parse(t.file);
          if (parsed.items.length) out.push({ id: t.id, cwd: parsed.cwd, firstAt: parsed.firstAt ?? parsed.items[0]?.at ?? 0 });
        } catch {}
      }
      return out;
    },
    async health() {
      try {
        // Run with Reach's own environment, never a host app's.
        const clean = Object.fromEntries(
          Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) && k !== "CLAUDECODE"),
        );
        const { stdout } = await run(cli, ["auth", "status", "--json"], { timeout: 10000, env: clean });
        return signIn(stdout);
      } catch (e) {
        if (e.code === "ENOENT") return { agent: "claude", installed: false, signedIn: false };
        // Signed out: exit code 1 with the same JSON on stdout (verified).
        try {
          return signIn(e.stdout);
        } catch {
          return { agent: "claude", installed: true, signedIn: false, error: "Could not read Claude Code's sign-in status." };
        }
      }
    },
  };
}
