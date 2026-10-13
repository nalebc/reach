import fs from "node:fs/promises";
import { claudeSubagents } from "./subagents.mjs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClaudeTranscript, imageBlocks, parseClaudeTranscript } from "./claude-transcript.mjs";
import { claudeArchive } from "./portable-history.mjs";
import { claudeLines } from "./move.mjs";
import { visibleUserText } from "./message-text.mjs";
import { randomUUID } from "node:crypto";
import { createClaudeAccountUsage } from "./account-usage.mjs";
import { claudeEnvironment, windowsGitBash, withGitBash } from "./claude-environment.mjs";
import { spawnable } from "../agent-cli.mjs";
import { recycle as recycleFile } from "../recycle-bin.mjs";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const origins = { "claude-desktop": "app", cli: "cli", "sdk-cli": "reach" };
// A chat's own folder: the Claude app's record of it (a worktree chat's is
// the worktree), else the folder its transcript is kept under (Claude Code
// names it after the folder, and resumes it there), else where it began.
// Never the last line's: a Bash `cd` changes that (Oct 9).
const folderOf = (file, parsed, appRecord) => {
  if (typeof appRecord?.cwd === "string" && appRecord.cwd) return appRecord.cwd;
  const named = path.basename(path.dirname(file));
  return (parsed.cwds || []).find((cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-") === named) || parsed.cwd || "";
};
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
  // The claude command where the owner's login shell finds it, when Reach's
  // own PATH doesn't (index.mjs locateClaude): it read "isn't installed".
  locateCli = null,
  // Reads a transcript as it grows (claude-transcript.mjs).
  reader = createClaudeTranscript,
  accountUsage = process.env.NODE_TEST_CONTEXT ? null : createClaudeAccountUsage(),
  // How much of a transcript is read at once, and how much of the Mac's
  // Claude history (its transcripts' size) stays whole in memory: past it,
  // the chats least recently written or opened keep only their summary.
  chunkBytes = 8 * 1024 * 1024,
  // A 64th of the Mac's memory, 64 to 256 MB of transcripts (parsed, they
  // take about 0.76× their size): 512 MB kept ~390 MB in Reach for good
  // (reliability audit, Oct 10). A chat nobody wrote to or opened for
  // idleMs keeps only its summary too.
  budgetBytes = Math.max(64 * 1024 * 1024, Math.min(256 * 1024 * 1024, Math.floor(os.totalmem() / 64))),
  idleMs = 10 * 60 * 1000,
  now = Date.now,
  // Git Bash, without which Claude Code on Windows won't start a chat
  // (claude-host.mjs); only a real Windows Claude Code needs it.
  platform = process.platform,
  gitBash = run === exec && platform === "win32" ? () => windowsGitBash(env) : () => true,
} = {}) {
  // Per transcript: the conversation, and while it is being written to, where
  // reading stopped. A working session's transcript only grows (one line per
  // event), so a change means reading what was appended, not the whole file
  // again (verified: a 70 MB one took half a second each time).
  const cache = new Map(); // file -> { ino, size, mtimeMs, head, offset, transcript, parsed, at }
  const bytes = async (handle, position, length) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  };
  // What the list needs of a chat nobody has opened for a while: its
  // first item, its last words and its last item stand in for all of them
  // (the whole conversation, kept for every chat ever listed, grew with the
  // Mac's entire Claude history). Opening it reads it again.
  const brief = (parsed) => {
    const items = parsed.items || [];
    const said = [...items].reverse().find((i) => i.role !== "tool" && i.kind !== "thinking" && i.text);
    const kept = [...new Set([items[0], said, items.at(-1)].filter(Boolean))].map((i) => ({
      role: i.role,
      at: i.at,
      ...(i.text ? { text: String(i.text).split("\n")[0].slice(0, 400) } : {}),
      ...(i.slash ? { slash: true } : {}),
      ...(i.consent ? { consent: i.consent } : {}),
    }));
    return { ...parsed, items: kept, memory: undefined, brief: true };
  };
  async function parse(file, { full = false } = {}) {
    const stat = await fs.stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && !(full && hit.parsed?.brief)) {
      // A chat being read stays whole while someone has it open.
      if (full) hit.at = now();
      return hit.parsed;
    }
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
      // In pieces: a first read of a 100 MB transcript held the whole file
      // three times over (bytes, text, lines), 800 MB for a few chats.
      let at = entry.offset;
      while (at < stat.size) {
        let length = Math.min(chunkBytes, stat.size - at);
        let added = await bytes(handle, at, length);
        let cut = added.lastIndexOf(10) + 1;
        // One line longer than a piece (a picture): read until it ends.
        while (!cut && at + added.length < stat.size && added.length === length) {
          length = Math.min(length * 2, stat.size - at);
          added = await bytes(handle, at, length);
          cut = added.lastIndexOf(10) + 1;
        }
        const end = at + added.length >= stat.size || added.length < length;
        entry.transcript.add((end ? added : added.subarray(0, cut)).toString("utf8"), { offset: at });
        // The last line without its newline yet is read again next time.
        at += cut;
        if (end || !cut) break;
      }
      entry.offset = at;
      Object.assign(entry, { head, size: stat.size, mtimeMs: stat.mtimeMs, parsed: entry.transcript.view(), at: now() });
      // Past the budget, the chats least recently written to or opened keep
      // only their summary, and so do chats idle for idleMs (never the one
      // just read).
      let whole = 0;
      for (const other of cache.values()) if (other.parsed && !other.parsed.brief) whole += other.size || 0;
      for (const other of [...cache.values()].sort((a, b) => a.at - b.at)) {
        if (other === entry || !other.parsed || other.parsed.brief) continue;
        if (whole <= budgetBytes && now() - other.at <= idleMs) continue;
        other.transcript = null;
        other.parsed = brief(other.parsed);
        whole -= other.size || 0;
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
  // The Claude app's records, each read again only when it changed (every
  // read of a chat parsed all of them, ~65 files, on each reply written).
  const recordCache = new Map(); // file -> { mtimeMs, size, record }
  async function records() {
    const byCli = new Map();
    const seen = new Set();
    const walk = async (dir, depth) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && depth < 3) return walk(full, depth + 1);
          if (!entry.isFile() || !/^local_.+\.json$/.test(entry.name)) return;
          seen.add(full);
          try {
            const stat = await fs.stat(full);
            let hit = recordCache.get(full);
            if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
              hit = { mtimeMs: stat.mtimeMs, size: stat.size, record: JSON.parse(await fs.readFile(full, "utf8")) };
              recordCache.set(full, hit);
            }
          } catch {
            recordCache.delete(full);
          }
        }),
      );
    };
    await walk(appRecords, 0);
    for (const file of [...recordCache.keys()]) if (!seen.has(file)) recordCache.delete(file);
    // In the order the folders list them, as before (the last one wins).
    for (const { record } of recordCache.values()) if (record?.cliSessionId) byCli.set(record.cliSessionId, record);
    return byCli;
  }
  async function summary({ id, file }, appRecord) {
    const parsed = await parse(file);
    if (!parsed.items.length) return null;
    const last = [...parsed.items].reverse().find((i) => i.role !== "tool" && i.kind !== "thinking" && i.text) || parsed.items.at(-1);
    return {
      agent: "claude",
      id,
      title: appRecord?.title || parsed.title || "Untitled Claude session",
      cwd: folderOf(file, parsed, appRecord),
      // The project the Claude app files it under: a worktree chat's repo
      // (its record's originCwd), while cwd stays the worktree it runs in.
      ...(typeof appRecord?.originCwd === "string" && appRecord.originCwd ? { project: appRecord.originCwd } : {}),
      // Claude Code writes "HEAD" outside a git repo (and on a detached HEAD,
      // where the Claude app shows no branch either): no branch.
      branch: parsed.gitBranch && parsed.gitBranch !== "HEAD" ? parsed.gitBranch : "",
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
      // The app's pick (it applies before the next turn), else the level its
      // latest reply ran at; null is unknown, never a guessed default.
      effort: appRecord?.effort || parsed.effort || null,
      // The app's own, alone: only it confirms a pick made in the app.
      ...(appRecord ? { appEffort: appRecord.effort || null } : {}),
      // The Claude app's Ultracode, a per-chat option beside its effort.
      ...(appRecord?.sessionSettings?.ultracode === true ? { ultracode: true } : {}),
      // The app's pick for its chats; else the mode its latest message ran in.
      mode: appRecord?.permissionMode || parsed.mode || null,
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
    return newest?.limited && newest.resetsAt > now ? { at: newest.at, resetsAt: newest.resetsAt, text: newest.text || "" } : null;
  }
  // The installed Claude Code's version, as its transcripts carry it.
  let installed = null;
  const version = async () => {
    installed ??= runCli(["--version"], { timeout: 10000, env: cleanEnv() })
      .then(({ stdout }) => String(stdout).match(/\d+\.\d+\.\d+/)?.[0] || null)
      .catch(() => null);
    return (await installed) || "2.1.0";
  };
  // Claude Code's own environment, never a host app's.
  // The claude command, as Reach's PATH finds it, else as the login shell does.
  const runCli = async (args, options) => {
    try {
      return await run(cli, args, options);
    } catch (e) {
      const found = e?.code === "ENOENT" && locateCli ? await locateCli() : null;
      if (!found) throw e;
      const where = spawnable(found);
      return run(where.file, [...where.args, ...args], options);
    }
  };
  function cleanEnv() {
    return withGitBash(claudeEnvironment(env), gitBash());
  }
  async function cliHealth() {
    try {
      // Run with Reach's own environment, never a host app's.
      const { stdout } = await runCli(["auth", "status", "--json"], { timeout: 10000, env: cleanEnv() });
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
  }
  // Signed in, but out of usage until that limit resets.
  async function withUsage(health) {
    if (!health.signedIn) return health;
    const [limit, meters] = await Promise.all([usage().catch(() => null), accountUsage?.().catch(() => null)]);
    // Usable: as meters read since its last limit message (a window for all
    // models at 100% is out; one model's isn't): an upgrade or reset shows
    // at once (Oct 10). Else out on that message; meters unread, unknown
    // (never "has usage": a chat would be moved here, "back" sent).
    // Fail-open audit, Oct 8.
    const fresh = meters?.available === true && (!limit || meters.updatedAt > limit.at);
    const usable = fresh ? !meters.windows.some((w) => !w.scoped && w.usedPercent >= 100)
      : limit ? false
      : meters ? undefined : health.usable;
    // Out on its meters: back when the last full window resets.
    const full = fresh ? meters.windows.filter((w) => !w.scoped && w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt) : [];
    const held = limit && !fresh ? limit : full.length ? { resetsAt: Math.max(...full) } : null;
    return { ...health, usable, ...(meters ? { usage: meters } : {}), ...(held ? { resetsAt: held.resetsAt, ...(held.text ? { limit: held.text } : {}) } : {}) };
  }
  return {
    usage,
    // A whole chat, and what Claude remembers of it (its latest summary and
    // the items since), for moving it to the other agent (move.mjs).
    async history(id) {
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const source = await fs.readFile(found.file, "utf8");
      const parsed = parseClaudeTranscript(source, { maxOutput: Infinity });
      // The ordinary reader keeps tool inputs small for the phone. An export
      // retains their complete input and result, including opaque tool data.
      const tools = new Map(), results = new Map();
      for (const line of source.split("\n")) {
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== "object") continue;
        if (!Array.isArray(entry.message?.content)) continue;
        for (const block of entry.message.content) {
          if (block.type === "tool_use") tools.set(block.id, block.input);
          if (block.type === "tool_result") results.set(block.tool_use_id, block.content);
        }
      }
      for (const item of parsed.items) if (item.role === "tool") {
        const result = results.get(item.id);
        item.detail = [tools.has(item.id) ? `Input:\n${JSON.stringify(tools.get(item.id), null, 2)}` : "", result !== undefined ? `Output:\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}` : item.detail || ""].filter(Boolean).join("\n\n");
      }
      return { session: await summary(found, (await records()).get(id)), items: parsed.items, memory: parsed.memory || null };
    },
    // Copy native records, including compaction, thinking, tool calls and
    // attachments. Re-rendering visible text would lose Claude's context.
    async fork(id, { through = null, authorize = () => {} } = {}) {
      authorize();
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const source = await fs.readFile(found.file, "utf8");
      const rows = source.split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (through) {
        const point = rows.findIndex(row => row.uuid === through ||
          (row.type === "assistant" && Array.isArray(row.message?.content) && row.message.content.some((_, n) => `${row.uuid}:${n}` === through)));
        if (point < 0) throw Object.assign(new Error("That message isn't in this chat."), { status: 404 });
        const row = rows[point];
        if (row.uuid !== through) row.message.content = row.message.content.slice(0, Number(through.slice(row.uuid.length + 1)) + 1);
        rows.splice(point + 1);
      }
      const target = randomUUID();
      authorize();
      await fs.writeFile(path.join(path.dirname(found.file), `${target}.jsonl`),
        rows.map(row => JSON.stringify({ ...row, sessionId: target })).join("\n") + "\n",
        { flag: "wx", mode: 0o600 });
      return { id: target };
    },
    // A new chat that continues one moved here from another agent: a
    // transcript of its own (never over an existing one), in its folder's
    // real path (the nearest that still exists), as Claude Code writes them.
    async write({ cwd, title, turns, note, model, gitBranch = "", items, from, authorize = () => {} }) {
      authorize();
      let dir = path.resolve(String(cwd || os.homedir()));
      for (;;) {
        authorize();
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
      authorize();
      await fs.mkdir(folder, { recursive: true });
      authorize();
      const ver = await version();
      for (let tries = 0; ; tries++) {
        authorize();
        const id = randomUUID();
        const lines = items ? claudeArchive({ id, cwd: dir, title, items, from, model, gitBranch, version: ver }) : claudeLines({ id, cwd: dir, title, turns, note, model, gitBranch, version: ver });
        try {
          await fs.writeFile(path.join(folder, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
          authorize();
          // The messages written: one item each when read back.
          return { id, cwd: dir, entries: lines.filter((l) => l.type === "user" || l.type === "assistant").length };
        } catch (e) {
          if (e.code !== "EEXIST" || tries > 3) throw e;
        }
      }
    },
    async list() {
      const [files, byCli] = await Promise.all([transcripts(), records()]);
      // A transcript deleted since leaves the cache with it.
      const present = new Set(files.map((t) => t.file));
      for (const file of cache.keys()) if (!present.has(file)) cache.delete(file);
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
    // The entry a rewind to this message continues from (its parent), if
    // the message is the chat's: null for its first message.
    async rewindPoint(id, messageId) {
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      await parse(found.file, { full: true });
      const t = cache.get(found.file)?.transcript;
      if (!t?.has(messageId)) throw Object.assign(new Error("That message isn't in this chat."), { status: 404 });
      return t.parentOf(messageId);
    },
    // at: show the conversation as it stood at that entry (a rewind waiting
    // for the next message).
    async read(id, { before = null, limit = 200, at = undefined } = {}) {
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const byCli = await records();
      let parsed = await parse(found.file, { full: true });
      if (at !== undefined) {
        const t = cache.get(found.file)?.transcript;
        parsed = at === null ? { ...parsed, items: [], context: null } : t?.has(at) ? { ...parsed, ...t.view({ from: at }) } : parsed;
      }
      // Pages count back from the newest item; `before` is an item index.
      const end = before === null ? parsed.items.length : Math.max(0, Math.min(Number(before) || 0, parsed.items.length));
      const start = Math.max(0, end - Math.min(Math.max(limit, 1), 500));
      // Its sub-agents, from their own files; each Agent call shows its own.
      const subagents = await claudeSubagents({ transcript: found.file, sessionId: id, notes: parsed.tasks, items: parsed.items }).catch(() => []);
      const byCall = new Map(subagents.filter((a) => a.toolUseId).map((a) => [a.toolUseId, a]));
      const items = parsed.items.slice(start, end).map((item) => {
        const agent = item.kind === "agent" && byCall.get(item.id);
        return agent ? { ...item, agentId: agent.id, agentStatus: agent.status, activity: agent.activity } : item;
      });
      return {
        // Its todo list as Claude last left it (claude-transcript.mjs todoList).
        session: {
          ...(await summary(found, byCli.get(id))),
          subagents,
          todos: parsed.todos || [],
          // Sent while it worked, still in Claude Code's queue (claude-transcript.mjs).
          waiting: parsed.waiting || [],
          // The app's model naming a 1M window ("…[1m]") widens it.
          ...(parsed.context ? { context: at === undefined && /\[1m\]/i.test(byCli.get(id)?.model || "") ? { ...parsed.context, window: 1000000 } : parsed.context } : {}),
        },
        items,
        before: start > 0 ? String(start) : null,
      };
    },
    // Archived (or back) in the Claude app: its own record of the chat says
    // so (isArchived, what its sidebar's Archive sets), written whole and
    // swapped in, so the app never reads half of it, and its list of archived
    // chats (archived-sessions.idx, beside the records) to match. A chat only
    // Claude Code has (never opened in the app) has no archive to set.
    // The Claude app reads them when it opens: one already open keeps the
    // chat in its sidebar until then (it has no way to be told; Oct 8), but
    // leaves the record as written (one archived at 09:08 stayed so).
    async archive(id, archived = true) {
      if (!UUID.test(id)) throw Object.assign(new Error("Unknown session."), { status: 404 });
      await records();
      const file = [...recordCache.entries()].find(([, hit]) => hit.record?.cliSessionId === id)?.[0];
      if (!file) throw Object.assign(new Error("Only chats in the Claude app can be archived."), { status: 409 });
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      // Only a record kept the way Reach knows (isArchived on it): a Claude
      // app that keeps it elsewhere would silently ignore the change.
      if (typeof record?.isArchived !== "boolean")
        throw Object.assign(new Error("This Claude app keeps archived chats differently. Archive it in the Claude app."), { status: 409 });
      if (record.isArchived === !!archived) return { archived: !!archived };
      const swap = async (to, text) => {
        const temporary = `${to}.reach-${process.pid}-${Date.now()}`;
        const { mode } = await fs.stat(to);
        await fs.writeFile(temporary, text, { mode });
        await fs.rename(temporary, to);
      };
      record.isArchived = !!archived;
      await swap(file, JSON.stringify(record));
      recordCache.delete(file);
      // The app's list of archived chats, when it keeps one the way Reach
      // knows ({ v: 1, archived: [local_…] }); otherwise left alone.
      const index = path.join(path.dirname(file), "archived-sessions.idx");
      const local = path.basename(file, ".json");
      try {
        const list = JSON.parse(await fs.readFile(index, "utf8"));
        if (list?.v === 1 && Array.isArray(list.archived)) {
          const rest = list.archived.filter((x) => x !== local);
          await swap(index, JSON.stringify({ ...list, archived: archived ? [...rest, local] : rest }));
        }
      } catch {
        /* none yet: the record alone says it */
      }
      return { archived: !!archived };
    },
    // An effort picked on the phone, in the Claude app's record of the chat
    // (written whole and swapped in, as for archive): the app starts the
    // chat's Claude Code at it when it next loads it. A running app may
    // write its own back. Only a record that keeps a model the way Reach knows.
    async appEffort(id, effort) {
      if (!UUID.test(id) || !/^[a-z][a-z0-9_-]{0,23}$/.test(String(effort))) return false;
      await records();
      const file = [...recordCache.entries()].find(([, hit]) => hit.record?.cliSessionId === id)?.[0];
      if (!file) return false;
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof record?.model !== "string" || record.effort === effort) return record?.effort === effort;
      record.effort = effort;
      const temporary = `${file}.reach-${process.pid}-${Date.now()}`;
      await fs.writeFile(temporary, JSON.stringify(record), { mode: (await fs.stat(file)).mode });
      await fs.rename(temporary, file);
      recordCache.delete(file);
      return true;
    },
    // Deleted: its transcript (and the Claude app's record of it) to the
    // Trash, where it can still be found. appOpen: the Claude app is running;
    // a chat it lists is deleted there then (it would write it back).
    // Windows: its Recycle Bin (recycle-bin.mjs); a folder Explorer never
    // empties only if that fails.
    async remove(id, { appOpen = false, trash = path.join(os.homedir(), ".Trash"), recycle = process.platform === "win32" ? recycleFile : null } = {}) {
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      await records();
      const record = [...recordCache.entries()].find(([, hit]) => hit.record?.cliSessionId === id)?.[0] || null;
      if (record && appOpen) throw Object.assign(new Error("The Claude app has this chat in its list: delete it there."), { status: 409 });
      const away = async (file) => {
        if (recycle)
          try {
            return await recycle(file);
          } catch {
            /* moved to the folder below instead */
          }
        await fs.mkdir(trash, { recursive: true });
        const to = path.join(trash, `${path.basename(file, path.extname(file))} ${new Date().toISOString().replace(/[:.]/g, "-")}${path.extname(file)}`);
        try {
          await fs.rename(file, to);
        } catch (e) {
          if (e.code !== "EXDEV") throw e;
          await fs.copyFile(file, to);
          await fs.rm(file);
        }
      };
      await away(found.file);
      if (record) {
        await away(record);
        recordCache.delete(record);
      }
      cache.delete(found.file);
      return { deleted: true };
    },
    // Renamed as Claude Code renames a chat: a custom-title line in its
    // transcript (what rename_session writes; appended whole, as one line);
    // in the Claude app's list too, its record's title.
    async rename(id, title) {
      const name = String(title ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
      if (!name) throw Object.assign(new Error("Name the chat."), { status: 400 });
      const found = await locate(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      await fs.appendFile(found.file, JSON.stringify({ type: "custom-title", customTitle: name, sessionId: id }) + "\n");
      await records();
      const file = [...recordCache.entries()].find(([, hit]) => hit.record?.cliSessionId === id)?.[0];
      if (file) {
        const record = JSON.parse(await fs.readFile(file, "utf8"));
        // Only a record kept the way Reach knows; the transcript has it either way.
        if (typeof record?.isArchived === "boolean") {
          record.title = name;
          record.titleSource = "user";
          const temporary = `${file}.reach-${process.pid}-${Date.now()}`;
          const { mode } = await fs.stat(file);
          await fs.writeFile(temporary, JSON.stringify(record), { mode });
          await fs.rename(temporary, file);
          recordCache.delete(file);
        }
      }
      cache.delete(found.file);
      return { title: name };
    },
    // Whether Claude Code still has this chat (deleted: no transcript).
    async exists(id) {
      return !!(await locate(id));
    },
    // Whether the Claude app took a message after `since`: its own entry for
    // it (the turn started) or its queue entry (the chat was working). A
    // message with pictures is queued with no text (verified, the Claude app
    // on 2026-10-05), so an empty queue entry is it.
    async arrived(id, text, since, { images = 0 } = {}) {
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
        if (e.type === "queue-operation" && e.operation === "enqueue") {
          const queued = String(e.content ?? "").trim();
          if (!wanted || queued === wanted || (images > 0 && !queued)) return true;
        }
        if (e.type === "user" && e.entrypoint === "claude-desktop") {
          const content = e.message?.content;
          // Read as the chat shows it: the Claude app puts its <system-reminder>
          // ahead of the words (a chat that moved into it), and a match against
          // the raw entry missed it, so the phone said "Sending…" 10 s longer.
          const said = visibleUserText(typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
          if (wanted ? said.trim() === visibleUserText(wanted).trim() : Array.isArray(content) && content.some((b) => b?.type === "image")) return true;
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
      await parse(found.file, { full: true });
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
      const block = entry?.uuid === uuid ? imageBlocks(entry)[n] : null;
      const type = block?.source?.media_type;
      if (block?.source?.type !== "base64" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)) throw missing();
      return { type, data: Buffer.from(String(block.source.data), "base64") };
    },
    // Session start times per folder, to match app processes started without
    // --resume (live detection).
    async starts() {
      const out = [];
      const byCli = await records().catch(() => new Map());
      for (const t of await transcripts()) {
        try {
          const parsed = await parse(t.file);
          // Where its process runs: the same folder the list shows.
          if (parsed.items.length) out.push({ id: t.id, cwd: folderOf(t.file, parsed, byCli.get(t.id)), firstAt: parsed.firstAt ?? parsed.items[0]?.at ?? 0 });
        } catch {}
      }
      return out;
    },
    async health() {
      const health = await cliHealth();
      // Installed on Windows without Git for Windows: said before sign-in
      // (and before a sign-in status that may fail for want of it), with its
      // install a tap away on the phone; a chat would only fail.
      if (!health.installed || gitBash()) return health;
      const { error, ...rest } = health;
      return { ...rest, needs: ["git"] };
    },
  };
}
