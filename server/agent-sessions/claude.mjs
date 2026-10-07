import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClaudeTranscript } from "./claude-transcript.mjs";
import { claudeLines } from "./move.mjs";
import { randomUUID } from "node:crypto";

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
      entry.transcript.add(added.toString("utf8"), { offset: entry.offset });
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
      // What the Claude app's window header calls it.
      ...(appRecord ? { appTitle: appRecord.title || "Untitled" } : {}),
      updatedAt: parsed.updatedAt,
      createdAt: parsed.items[0]?.at || 0,
      status: "idle",
      preview: String(last?.text || "").split("\n")[0].slice(0, 200),
      archived: !!appRecord?.isArchived,
      // What the Claude app shows under its composer, from its own record.
      model: appRecord?.model || parsed.model || null,
      effort: appRecord?.effort || null,
      mode: appRecord?.permissionMode || null,
      // The transcript ends mid-turn (a prompt or a tool call, no answer
      // yet); a slash command like /clear has no answer to wait for.
      pending: ["user", "tool"].includes(parsed.items.at(-1)?.role) && !parsed.items.at(-1)?.slash,
      // The Claude app's own consent card waits on you (claude-transcript.mjs).
      ...(parsed.items.at(-1)?.consent ? { consent: parsed.items.at(-1).consent } : {}),
    };
  }
  async function locate(id) {
    if (!UUID.test(id)) return null;
    return (await transcripts()).find((t) => t.id === id) || null;
  }
  // Out of usage, as Claude Code last saw it: the newest outcome across its
  // sessions, a limit it hit (it writes that into the session, with when the
  // limit resets) or an answer since. Newest files first; one written before
  // the newest outcome found can't hold a newer one.
  async function usage(now = Date.now()) {
    const files = [];
    for (const t of await transcripts()) {
      const stat = await fs.stat(t.file).catch(() => null);
      if (stat) files.push({ ...t, mtimeMs: stat.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let newest = null;
    for (const t of files) {
      if (newest && t.mtimeMs < newest.at) break;
      const seen = (await parse(t.file).catch(() => null))?.usage;
      if (seen && (!newest || seen.at > newest.at)) newest = seen;
    }
    return newest?.limited && newest.resetsAt > now ? { resetsAt: newest.resetsAt, text: newest.text || "" } : null;
  }
  // The installed Claude Code's version, as its transcripts carry it.
  let installed = null;
  const version = async () => {
    installed ??= run(cli, ["--version"], { timeout: 10000, env: cleanEnv() })
      .then(({ stdout }) => String(stdout).match(/\d+\.\d+\.\d+/)?.[0] || null)
      .catch(() => null);
    return (await installed) || "2.1.0";
  };
  // Claude Code's own environment, never a host app's.
  function cleanEnv() {
    return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) && k !== "CLAUDECODE"));
  }
  // Signed in, but out of usage until that limit resets.
  async function withUsage(health) {
    if (!health.signedIn) return health;
    const limit = await usage().catch(() => null);
    return limit ? { ...health, usable: false, resetsAt: limit.resetsAt, ...(limit.text ? { limit: limit.text } : {}) } : health;
  }
  return {
    usage,
    // A whole chat, and what Claude remembers of it (its latest summary and
    // the items since), for moving it to the other agent (move.mjs).
    async history(id) {
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const parsed = await parse(found.file);
      return { session: await summary(found, (await records()).get(id)), items: parsed.items, memory: parsed.memory || null };
    },
    // A new chat that continues one moved here from another agent: a
    // transcript of its own (never over an existing one), in its folder's
    // real path (the nearest that still exists), as Claude Code writes them.
    async write({ cwd, title, turns, note, model, gitBranch = "" }) {
      let dir = path.resolve(String(cwd || os.homedir()));
      for (;;) {
        try {
          dir = await fs.realpath(dir);
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch {}
        const up = path.dirname(dir);
        if (up === dir) {
          dir = os.homedir();
          break;
        }
        dir = up;
      }
      // Nothing of it left but the disk's root: the home folder instead.
      if (dir === path.parse(dir).root) dir = os.homedir();
      const folder = path.join(projects, dir.replace(/[^a-zA-Z0-9]/g, "-"));
      await fs.mkdir(folder, { recursive: true });
      const ver = await version();
      for (let tries = 0; ; tries++) {
        const id = randomUUID();
        const lines = claudeLines({ id, cwd: dir, title, turns, note, model, gitBranch, version: ver });
        try {
          await fs.writeFile(path.join(folder, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
          // The messages written: one item each when read back.
          return { id, cwd: dir, entries: lines.filter((l) => l.type === "user" || l.type === "assistant").length };
        } catch (e) {
          if (e.code !== "EEXIST" || tries > 3) throw e;
        }
      }
    },
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
    // Whether the Claude app took a message after `since`: its own entry for
    // it (the turn started) or its queue entry (the chat was working).
    async arrived(id, text, since) {
      const found = await locate(id);
      if (!found) return false;
      const stat = await fs.stat(found.file);
      const start = Math.max(0, stat.size - 512 * 1024);
      const handle = await fs.open(found.file, "r");
      let tail = "";
      try {
        tail = (await bytes(handle, start, stat.size - start)).toString("utf8");
      } finally {
        await handle.close();
      }
      const wanted = String(text || "").trim();
      for (const line of tail.split("\n").reverse()) {
        if (!line.includes("queue-operation") && !line.includes("claude-desktop")) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (!e?.timestamp || Date.parse(e.timestamp) < since) continue;
        if (e.type === "queue-operation" && e.operation === "enqueue" && (!wanted || String(e.content ?? "").trim() === wanted)) return true;
        if (e.type === "user" && e.entrypoint === "claude-desktop") {
          const content = e.message?.content;
          const said = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
          if (wanted ? said.trim() === wanted : Array.isArray(content) && content.some((b) => b?.type === "image")) return true;
        }
      }
      return false;
    },
    // A picture sent in a session, read back from the one transcript line
    // that holds it.
    async image(id, uuid, n) {
      const found = await locate(id);
      const missing = () => Object.assign(new Error("That picture isn't in this session."), { status: 404 });
      if (!found || typeof uuid !== "string" || uuid.length > 100 || !Number.isInteger(n) || n < 0) throw missing();
      await parse(found.file);
      if (!cache.get(found.file)?.transcript) {
        // Let go of while idle: read it again, this once.
        cache.delete(found.file);
        await parse(found.file);
      }
      const line = cache.get(found.file).transcript.imageLine(uuid);
      if (!line) throw missing();
      const handle = await fs.open(found.file, "r");
      let entry;
      try {
        entry = JSON.parse((await bytes(handle, line.offset, line.length)).toString("utf8"));
      } catch {
        throw missing();
      } finally {
        await handle.close();
      }
      const block = entry?.uuid === uuid ? (entry.message?.content || []).filter((b) => b?.type === "image")[n] : null;
      const type = block?.source?.media_type;
      if (block?.source?.type !== "base64" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)) throw missing();
      return { type, data: Buffer.from(String(block.source.data), "base64") };
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
        const { stdout } = await run(cli, ["auth", "status", "--json"], { timeout: 10000, env: cleanEnv() });
        return await withUsage(signIn(stdout));
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
