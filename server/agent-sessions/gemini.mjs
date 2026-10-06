import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Gemini CLI sessions, read from its own files (verified with 0.39.1):
// ~/.gemini/tmp/<project>/chats/session-<time>-<id8>.json (older: one object
// with `messages`) or .jsonl (a header line, then message lines; a message is
// written again each time it changes, so the last line with its id wins;
// `{"$set": {...}}` lines update the header). ~/.gemini/projects.json names
// each project folder; a header's projectHash is the SHA-256 of the folder.

const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((p) => p && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
      : "";
const picturesIn = (content) =>
  Array.isArray(content) ? content.filter((p) => String(p?.inlineData?.mimeType || "").startsWith("image/")).length : 0;

// One session file as Gemini last wrote it: the header, the messages in order.
export function parseGeminiSession(source, { jsonl = true } = {}) {
  if (!jsonl) {
    const whole = JSON.parse(source);
    if (!whole || typeof whole !== "object" || Array.isArray(whole)) throw new Error("Unsupported Gemini session format.");
    return { header: { ...whole, messages: undefined }, messages: Array.isArray(whole.messages) ? whole.messages : [] };
  }
  let header = null;
  const order = [];
  const byId = new Map();
  for (const line of String(source).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (!entry || typeof entry !== "object") continue;
    if (!header && entry.sessionId && !entry.type) {
      header = entry;
      continue;
    }
    if (entry.$set && typeof entry.$set === "object") {
      header = { ...(header || {}), ...entry.$set };
      continue;
    }
    if (!entry.type) continue;
    const key = entry.id || `line:${order.length}`;
    if (!byId.has(key)) order.push(key);
    byId.set(key, entry);
  }
  return { header: header || {}, messages: order.map((key) => byId.get(key)) };
}

// What a tool did, as the other agents' tool steps read.
function toolItem(call, cwd) {
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const rel = (p) => {
    const value = String(p || "");
    return cwd && value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value;
  };
  const status = call.status === "success" ? "completed" : call.status === "error" ? "failed" : String(call.status || "completed");
  const result = clip(
    typeof call.resultDisplay === "string" ? call.resultDisplay : textOf(call.result?.[0]?.functionResponse?.response?.output ?? ""),
    4000,
  );
  const base = { id: String(call.id || crypto.randomUUID()), role: "tool", status, ...(result ? { detail: result } : {}) };
  switch (call.name) {
    case "run_shell_command":
      return { ...base, kind: "command", text: String(args.command || "") };
    case "write_file":
    case "replace":
    case "edit":
      return { ...base, kind: "file-change", text: rel(args.file_path || args.path) };
    case "google_web_search":
      return { ...base, kind: "web", text: String(args.query || "") };
    case "web_fetch":
      return { ...base, kind: "web", text: clip(args.prompt || args.url || "", 200) };
    case "read_file":
      return { ...base, kind: "tool", text: `Read ${rel(args.absolute_path || args.file_path || args.path)}` };
    case "grep_search":
    case "search_file_content":
      return { ...base, kind: "tool", text: `Search ${args.pattern || ""}`.trim() };
    case "glob":
      return { ...base, kind: "tool", text: `Find ${args.pattern || ""}`.trim() };
    case "list_directory":
      return { ...base, kind: "tool", text: `List ${rel(args.path || args.dir_path || "")}`.trim() };
    default:
      return { ...base, kind: "tool", text: String(call.displayName || call.name || "Tool") };
  }
}

// A session's messages as the chat shows them.
export function geminiItems(messages, cwd = "") {
  const items = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const at = m.timestamp ? Date.parse(m.timestamp) : undefined;
    if (m.type === "user") {
      const text = textOf(m.content);
      const images = picturesIn(m.content);
      if (text || images) items.push({ id: String(m.id), role: "user", kind: "text", text, ...(images ? { images } : {}), at });
    } else if (m.type === "gemini") {
      const text = textOf(m.content).trim();
      if (text) items.push({ id: `${m.id}:text`, role: "assistant", kind: "text", text, at });
      for (const call of Array.isArray(m.toolCalls) ? m.toolCalls.filter(c => c && typeof c === "object" && !Array.isArray(c)) : []) items.push({ ...toolItem(call, cwd), at });
    } else if (m.type === "error") {
      items.push({ id: String(m.id), role: "system", kind: "error", text: textOf(m.content) || "Gemini CLI hit an error.", at });
    } else if (m.type === "info") {
      const text = textOf(m.content).trim();
      if (text) items.push({ id: String(m.id), role: "system", kind: "notice", text, at });
    }
  }
  return items;
}

export function createGeminiSessions({
  home = path.join(os.homedir(), ".gemini"),
  env = process.env,
  run = exec,
  // The gemini executable as the owner's login shell finds it.
  locate = () =>
    run(env.SHELL || "/bin/zsh", ["-lc", "command -v gemini"], { timeout: 8000 })
      .then(({ stdout }) => String(stdout).trim().split("\n").pop() || null)
      .then((found) => (found?.startsWith("/") ? found : null))
      .catch(() => null),
} = {}) {
  const cache = new Map(); // file -> { mtimeMs, size, parsed }
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  // Project folder names -> folders, and folders by their hash.
  async function projects() {
    let named = {};
    try {
      named = JSON.parse(await fs.readFile(path.join(home, "projects.json"), "utf8")).projects || {};
    } catch {}
    const byName = new Map();
    const byHash = new Map();
    for (const [folder, name] of Object.entries(named)) {
      byName.set(name, folder);
      byHash.set(sha(folder), folder);
    }
    return { byName, byHash };
  }
  async function files() {
    const out = [];
    const tmp = path.join(home, "tmp");
    for (const project of await fs.readdir(tmp, { withFileTypes: true }).catch(() => [])) {
      if (!project.isDirectory()) continue;
      const chats = path.join(tmp, project.name, "chats");
      for (const f of await fs.readdir(chats).catch(() => []))
        if (/^session-.+\.jsonl?$/.test(f)) out.push({ project: project.name, file: path.join(chats, f) });
    }
    return out;
  }
  async function parse(file) {
    const stat = await fs.stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;
    const parsed = parseGeminiSession(await fs.readFile(file, "utf8"), { jsonl: file.endsWith(".jsonl") });
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    return parsed;
  }
  // A session: what the list shows, and its items.
  async function load({ project, file }, known) {
    const { header, messages } = await parse(file);
    if (!header.sessionId || (header.kind && header.kind !== "main")) return null;
    const cwd = known.byHash.get(header.projectHash) || known.byName.get(project) || "";
    const items = geminiItems(messages, cwd);
    if (!items.some((i) => i.role === "user")) return null;
    const first = items.find((i) => i.role === "user" && i.text)?.text || "";
    const last = [...items].reverse().find((i) => i.role !== "tool" && i.text);
    const model = [...messages].reverse().find((m) => m.type === "gemini" && m.model)?.model || null;
    const session = {
      agent: "gemini",
      id: String(header.sessionId),
      // Without the "›" prompt sign a pasted terminal line starts with.
      title: clip(first.split("\n")[0].replace(/^\s*(?:[›❯]\s*)+/, ""), 120) || "Gemini CLI session",
      cwd,
      branch: "",
      origin: "cli",
      inApp: false,
      updatedAt: Date.parse(header.lastUpdated || header.startTime) || 0,
      createdAt: Date.parse(header.startTime) || items[0]?.at || 0,
      status: "idle",
      preview: String(last?.text || "").split("\n")[0].slice(0, 200),
      archived: false,
      model,
      effort: null,
      mode: null,
      pending: items.at(-1)?.role === "user",
    };
    return { session, items };
  }
  async function locateSession(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(id)) return null;
    const known = await projects();
    for (const f of await files()) {
      // The file name carries the id's first 8 characters.
      if (!f.file.includes(id.slice(0, 8))) continue;
      const found = await load(f, known).catch(() => null);
      if (found?.session.id === id) return found;
    }
    return null;
  }
  return {
    async list() {
      const known = await projects();
      const out = [];
      for (const f of await files()) {
        try {
          const found = await load(f, known);
          if (found) out.push(found.session);
        } catch {
          /* unreadable session file: leave it out */
        }
      }
      return out;
    },
    async read(id, { before = null, limit = 200 } = {}) {
      const found = await locateSession(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const end = before === null ? found.items.length : Math.max(0, Math.min(Number(before) || 0, found.items.length));
      const start = Math.max(0, end - Math.min(Math.max(limit, 1), 500));
      return { session: found.session, items: found.items.slice(start, end), before: start > 0 ? String(start) : null };
    },
    // The whole chat, for moving it to another agent (move.mjs).
    async history(id) {
      const found = await locateSession(id);
      if (!found) throw Object.assign(new Error("Unknown session."), { status: 404 });
      return { session: found.session, items: found.items, memory: null };
    },
    // Installed, and signed in as Gemini CLI keeps it (its own sign-in file,
    // or an API key in the environment); nothing of them is read.
    async health() {
      const cli = await locate();
      if (!cli) return { agent: "gemini", installed: false, signedIn: false };
      const signedIn =
        existsSync(path.join(home, "oauth_creds.json")) || !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI);
      return { agent: "gemini", installed: true, signedIn, usable: signedIn };
    },
  };
}
