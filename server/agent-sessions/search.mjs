// One search across every agent's conversations (docs/ACROSS_AGENTS.md):
// what you and the agents said in Codex and Claude Code chats, read from
// their own history files (not tool output). The words are kept in memory
// while Reach runs; each file is read once, then only what was added to it
// (the files only grow; one that shrank is read again). The newest files go
// first, so a search before everything is read still finds recent chats.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleUserText } from "./message-text.mjs";

// Read a megabyte at a time, letting everything else Reach does (the live
// screen above all) go between pieces: 8 MB at once held it up 100 ms.
const CHUNK = 1024 * 1024;
const breathe = () => new Promise((resolve) => setImmediate(resolve));
// A line this long is a tool's output or a pasted file, not a message.
const LONGEST = 512 * 1024;
// Kept of each message, for finding and showing it.
const KEEP = 4000;
// Codex's second copy of a message comes right after the first: the last
// few messages of each file are remembered to leave it out.
const RECENT = 32;
// A string of its own: a piece cut from a longer one keeps the whole of it
// in memory (a message's start held a 500 KB line).
const own = (text) => Buffer.from(text, "utf8").toString("utf8");
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// The words of one history line, or null: [role, text, at].
export function claudeLine(line) {
  if (line.includes('"isSidechain":true') || line.includes('"isMeta":true') || line.includes('"isCompactSummary":true')) return null;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e.type !== "user" && e.type !== "assistant") return null;
  const content = e.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n") : "";
  const words = e.type === "user" ? visibleUserText(text).trim() : text.trim();
  // Claude Code's own command lines (/compact, its output) aren't what was said.
  if (!words || /^<(command-|local-command-)/.test(words)) return null;
  return [e.type, words, Date.parse(e.timestamp) || 0];
}
export function codexLine(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  const p = e.payload || {};
  let role = null;
  let text = "";
  if (e.type === "event_msg" && (p.type === "user_message" || p.type === "agent_message")) {
    role = p.type === "user_message" ? "user" : "assistant";
    text = typeof p.message === "string" ? p.message : "";
  } else if (e.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    role = p.role;
    text = (Array.isArray(p.content) ? p.content : []).filter((c) => c?.type === "input_text" || c?.type === "output_text").map((c) => c.text || "").join("\n");
  } else return null;
  const words = role === "user" ? visibleUserText(text).trim() : text.trim();
  // Context Codex adds as a message of its own (its environment, instructions).
  if (!words || /^<[a-z_-]+>/.test(words)) return null;
  return [role, words, Date.parse(e.timestamp) || 0];
}

// Each line of `buf` up to its last newline holding one of `markers`, once,
// as [start, end]: found by jumping from marker to marker, not line by line.
export function* markedLines(buf, markers) {
  const last = buf.lastIndexOf(10);
  const next = markers.map(() => -2);
  let pos = 0;
  while (pos <= last) {
    let at = -1;
    for (let m = 0; m < markers.length; m++) {
      if (next[m] !== -1 && next[m] < pos) next[m] = buf.indexOf(markers[m], pos);
      if (next[m] !== -1 && next[m] <= last && (at === -1 || next[m] < at)) at = next[m];
    }
    if (at === -1) return;
    const start = buf.lastIndexOf(10, at) + 1;
    const end = buf.indexOf(10, at);
    yield [start, end];
    pos = end + 1;
  }
}

const KINDS = {
  claude: { markers: ['"type":"user"', '"type":"assistant"'].map((m) => Buffer.from(m)), read: claudeLine },
  codex: {
    markers: ['"type":"user_message"', '"type":"agent_message"', '"role":"user"', '"role":"assistant"'].map((m) => Buffer.from(m)),
    read: codexLine,
  },
};

export function createSearch({
  claudeProjects = path.join(os.homedir(), ".claude", "projects"),
  codexSessions = path.join(os.homedir(), ".codex", "sessions"),
  now = Date.now,
  // Let go of everything read after this long without a search (about 40 MB
  // for 20,000 messages); the next search reads it again (a few seconds).
  idleMs = 20 * 60 * 1000,
  setEvery = setInterval,
  clearEvery = clearInterval,
} = {}) {
  // file → { agent, id, offset, entries: [{ role, text, at }], recent }
  const files = new Map();
  let indexing = null;
  let used = 0;
  const idle = setEvery(() => {
    if (!indexing && files.size && now() - used > idleMs) files.clear();
  }, Math.min(idleMs, 5 * 60 * 1000));
  idle?.unref?.();
  // The history files, newest first.
  const listFiles = () => {
    const found = [];
    const walk = (dir, depth, agent) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth > 0) walk(full, depth - 1, agent);
        else if (e.isFile() && UUID.test(e.name)) {
          try {
            const st = fs.statSync(full);
            found.push({ file: full, agent, size: st.size, mtime: st.mtimeMs });
          } catch {
            /* gone meanwhile */
          }
        }
      }
    };
    // Claude Code: projects/<folder>/<id>.jsonl (sub-agents' files are deeper).
    walk(claudeProjects, 1, "claude");
    // Codex: sessions/<year>/<month>/<day>/rollout-…-<id>.jsonl.
    walk(codexSessions, 3, "codex");
    return found.sort((a, b) => b.mtime - a.mtime);
  };
  // What a file gained since it was last read.
  const catchUp = async ({ file, agent, size }) => {
    let f = files.get(file);
    if (!f || size < f.offset) {
      f = { agent, id: file.match(UUID)[1].toLowerCase(), offset: 0, entries: [], recent: [], at: 0 };
      files.set(file, f);
    }
    if (size === f.offset) return;
    const kind = KINDS[agent];
    const handle = await fs.promises.open(file, "r");
    try {
      let tail = Buffer.alloc(0);
      let position = f.offset;
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(CHUNK, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const buf = tail.length ? Buffer.concat([tail, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const last = buf.lastIndexOf(10);
        for (const [start, end] of markedLines(buf, kind.markers)) {
          if (end - start > LONGEST) continue;
          const read = kind.read(buf.toString("utf8", start, end));
          if (!read) continue;
          const [role, text, at] = read;
          // Codex writes some messages twice (as an event and as an item).
          const key = `${role}:${text.length}:${text.slice(0, 80)}`;
          if (f.recent.includes(key)) continue;
          f.recent = [...f.recent.slice(1 - RECENT), own(key)];
          f.entries.push({ role, text: own(text.length > KEEP ? text.slice(0, KEEP) : text), at });
          if (at > f.at) f.at = at;
        }
        // The unfinished last line waits for the next read.
        tail = last === -1 ? buf : Buffer.from(buf.subarray(last + 1));
        f.offset = position - tail.length;
        if (tail.length > LONGEST * 4) {
          // One endless line: skip it.
          f.offset = position;
          tail = Buffer.alloc(0);
        }
        await breathe();
      }
    } finally {
      await handle.close();
    }
  };
  // Reads what's new everywhere, newest files first, for up to budgetMs;
  // true when everything is read.
  const index = async (budgetMs) => {
    const started = now();
    for (const entry of listFiles()) {
      const f = files.get(entry.file);
      if (f && f.offset === entry.size) continue;
      try {
        await catchUp(entry);
      } catch {
        /* unreadable now; tried again next time */
      }
      if (now() - started > budgetMs) return false;
    }
    return true;
  };
  // Finishing in the background what a search left (one at a time).
  const finish = () => {
    indexing ||= (async () => {
      while (!(await index(250))) await new Promise((r) => setImmediate(r));
    })().finally(() => {
      indexing = null;
    });
    return indexing;
  };
  return {
    // Messages with every word of the query, newest first: three per chat
    // at most, `limit` in all, each with the words around the first one.
    async search(query, { limit = 40, perChat = 3, budgetMs = 6000 } = {}) {
      const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!words.length) return { results: [], partial: false };
      used = now();
      await indexing?.catch(() => {});
      const complete = await index(budgetMs);
      if (!complete) void finish();
      const hits = [];
      for (const f of files.values())
        for (const e of f.entries) {
          const lower = e.text.toLowerCase();
          if (words.every((w) => lower.includes(w))) hits.push({ f, e, lower });
        }
      hits.sort((a, b) => b.e.at - a.e.at);
      const results = [];
      const per = new Map();
      for (const { f, e, lower } of hits) {
        const key = `${f.agent}:${f.id}`;
        if ((per.get(key) || 0) >= perChat) continue;
        per.set(key, (per.get(key) || 0) + 1);
        const at = lower.indexOf(words[0]);
        const from = Math.max(0, at - 70);
        const snippet = `${from ? "…" : ""}${e.text.slice(from, at + words[0].length + 110).replace(/\s+/g, " ").trim()}${at + words[0].length + 110 < e.text.length ? "…" : ""}`;
        results.push({ agent: f.agent, id: f.id, role: e.role, at: e.at, snippet });
        if (results.length >= limit) break;
      }
      return { results, partial: !complete };
    },
    // How much is held (for tests and checks).
    size: () => [...files.values()].reduce((n, f) => n + f.entries.length, 0),
    stop: () => clearEvery(idle),
  };
}
