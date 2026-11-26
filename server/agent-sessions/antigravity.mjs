import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Antigravity local conversation reader: scans Antigravity CLI and IDE brain
// directories (~/.gemini/antigravity-cli/brain and ~/.gemini/antigravity/brain)
// and surfaces conversations in Reach's unified Anything Chat list.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUserContent(raw) {
  const text = String(raw || "");
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  const body = match ? match[1] : text;
  return body
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
}

function titleFromText(text) {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "Antigravity conversation";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

export function parseAntigravityTranscript(source) {
  const items = [];
  let model = null;
  let createdAt = 0;
  let updatedAt = 0;
  let firstUser = "";

  for (const line of String(source || "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const at = entry.created_at ? Date.parse(entry.created_at) : 0;
    if (Number.isFinite(at) && at > 0) {
      if (!createdAt || at < createdAt) createdAt = at;
      if (at > updatedAt) updatedAt = at;
    }
    if (typeof entry.model === "string" && entry.model) model = entry.model;

    if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") {
      const text = cleanUserContent(entry.content);
      if (!text) continue;
      if (!firstUser) firstUser = text;
      items.push({
        id: `ag-u-${entry.step_index ?? items.length}`,
        role: "user",
        kind: "text",
        text,
        ...(at ? { at } : {}),
      });
    } else if (entry.type === "PLANNER_RESPONSE") {
      if (typeof entry.thinking === "string" && entry.thinking.trim()) {
        items.push({
          id: `ag-t-${entry.step_index ?? items.length}`,
          role: "assistant",
          kind: "thinking",
          text: entry.thinking.trim().slice(0, 4000),
          status: "done",
          ...(at ? { at } : {}),
        });
      }
      if (typeof entry.content === "string" && entry.content.trim()) {
        items.push({
          id: `ag-a-${entry.step_index ?? items.length}`,
          role: "assistant",
          kind: "text",
          text: entry.content.trim(),
          status: "done",
          ...(entry.model ? { detail: entry.model } : {}),
          ...(at ? { at } : {}),
        });
      }
    }
  }

  return { items, model, createdAt, updatedAt, firstUser };
}

export function createAntigravitySessions({ home = os.homedir(), roots } = {}) {
  const dirs = roots || [
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity", "brain"),
  ];

  const transcriptFiles = () => {
    const found = new Map();
    for (const root of dirs) {
      if (!fs.existsSync(root)) continue;
      let names = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const id of names) {
        if (!UUID_RE.test(id) || found.has(id)) continue;
        const file = path.join(root, id, ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(file)) found.set(id, file);
      }
    }
    return found;
  };

  return {
    list() {
      const out = [];
      for (const [id, file] of transcriptFiles()) {
        try {
          const stat = fs.statSync(file);
          const parsed = parseAntigravityTranscript(fs.readFileSync(file, "utf8"));
          if (!parsed.items.length) continue;
          const lastText = [...parsed.items].reverse().find((i) => i.kind === "text" && i.text)?.text || "";
          const updatedAt = parsed.updatedAt || stat.mtimeMs;
          const createdAt = parsed.createdAt || stat.birthtimeMs || updatedAt;
          out.push({
            agent: "antigravity",
            id,
            title: titleFromText(parsed.firstUser),
            cwd: "",
            branch: "",
            origin: "app",
            inApp: true,
            updatedAt,
            createdAt,
            status: Date.now() - stat.mtimeMs < 15000 ? "running" : "idle",
            preview: lastText.replace(/\s+/g, " ").trim().slice(0, 140),
            archived: false,
            model: parsed.model,
            providerName: "Antigravity",
          });
        } catch {
          continue;
        }
      }
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    read(id, { limit = 200, before } = {}) {
      if (!UUID_RE.test(String(id || "")))
        throw Object.assign(new Error("Invalid Antigravity conversation ID."), { status: 400 });
      const file = transcriptFiles().get(id);
      if (!file) throw Object.assign(new Error("Antigravity conversation not found."), { status: 404 });
      const stat = fs.statSync(file);
      const parsed = parseAntigravityTranscript(fs.readFileSync(file, "utf8"));
      const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const end = before != null ? Math.min(Math.max(Number(before) || 0, 0), parsed.items.length) : parsed.items.length;
      const start = Math.max(0, end - max);
      const lastText = [...parsed.items].reverse().find((i) => i.kind === "text" && i.text)?.text || "";
      const updatedAt = parsed.updatedAt || stat.mtimeMs;
      return {
        session: {
          agent: "antigravity",
          id,
          title: titleFromText(parsed.firstUser),
          cwd: "",
          branch: "",
          origin: "app",
          inApp: true,
          updatedAt,
          createdAt: parsed.createdAt || stat.birthtimeMs || updatedAt,
          status: Date.now() - stat.mtimeMs < 15000 ? "running" : "idle",
          preview: lastText.replace(/\s+/g, " ").trim().slice(0, 140),
          archived: false,
          model: parsed.model,
          providerName: "Antigravity",
        },
        items: parsed.items.slice(start, end),
        before: start > 0 ? String(start) : null,
      };
    },
  };
}
