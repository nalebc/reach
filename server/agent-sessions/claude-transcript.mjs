// Turns a Claude Code transcript (one JSON object per line) into the
// conversation a person saw. Rules verified against real transcripts:
// - The visible history is the parentUuid chain ending at the last message;
//   other branches are superseded. At a compaction boundary the chain
//   continues through logicalParentUuid.
// - Results of parallel tool calls branch off the chain; they are attached to
//   their tool_use by id, wherever they sit in the file.
// - Messages typed while a turn runs are "queued_command" attachments.
// Nothing here executes or follows paths from the transcript.

const clip = (text, max) => {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const half = Math.floor((max - 20) / 2);
  return `${value.slice(0, half)}\n… (${value.length - 2 * half} characters omitted) …\n${value.slice(-half)}`;
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join("\n")
      : "";
const relative = (file, cwd) =>
  cwd && typeof file === "string" && file.startsWith(`${cwd}/`)
    ? file.slice(cwd.length + 1)
    : file;

// The Claude app's own consent cards: letting Claude use apps (computer use)
// or a folder. They show in its window while the call waits, with no hook and
// no "waiting" in Claude Code's registry, so the waiting call is the sign.
const CONSENT = /^mcp__(?:computer[-_]use__(request_access|request_full_control|request_teach_access)|ccd_directory__(request_directory))$/;
const appNames = (apps) => (Array.isArray(apps) ? apps : []).map((a) => clip(String(a), 60)).filter(Boolean).slice(0, 8);
const appList = (apps) => {
  const names = appNames(apps);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "apps";
};
export function consentOf(name, input = {}) {
  const m = CONSENT.exec(String(name));
  if (!m) return null;
  const reason = clip(String(input.reason ?? ""), 400);
  // Worded as the app's card (verified for apps: "Allow Claude to use
  // Calculator?", then Deny or Allow for this session).
  switch (m[1] || m[2]) {
    case "request_access":
      return {
        kind: "apps",
        title: `Allow Claude to use ${appList(input.apps)}?`,
        reason,
        apps: appNames(input.apps),
        options: ["Deny", "Allow for this session"],
      };
    case "request_full_control":
      return { kind: "screen", title: "Allow Claude to take over the screen?", reason };
    case "request_teach_access":
      return { kind: "teach", title: `Allow Claude to guide you through ${appList(input.apps)}?`, reason, apps: appNames(input.apps) };
    default:
      return {
        kind: "folder",
        title: input.path ? `Allow Claude to access ${clip(String(input.path), 200)}?` : "Claude wants you to pick a folder",
        reason: "",
      };
  }
}

function toolItem(block, result, cwd) {
  const input = block.input || {};
  const consent = consentOf(block.name, input);
  if (consent)
    return {
      id: block.id,
      role: "tool",
      status: result ? (result.is_error ? "failed" : "completed") : "running",
      kind: "tool",
      text: consent.title,
      detail: result ? result.output : "",
      // Kept while the Claude app waits for an answer. Letting Claude use
      // apps (the card Reach knows word for word) can be answered from the
      // phone; its id names the request.
      ...(result ? {} : { consent: { ...consent, ...(consent.kind === "apps" ? { id: `consent:${block.id}` } : {}) } }),
    };
  const output = result ? result.output : "";
  const base = {
    id: block.id,
    role: "tool",
    status: result ? (result.is_error ? "failed" : "completed") : "running",
  };
  switch (block.name) {
    case "Bash":
      return { ...base, kind: "command", text: String(input.command ?? ""), detail: output };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return {
        ...base,
        kind: "file-change",
        text: relative(input.file_path ?? input.notebook_path ?? "", cwd),
        detail: block.name === "Write" ? "Wrote file" : "Edited file",
      };
    case "Read":
      return { ...base, kind: "tool", text: `Read ${relative(input.file_path ?? "", cwd)}` };
    case "Grep":
    case "Glob":
      return { ...base, kind: "tool", text: `${block.name} ${input.pattern ?? ""}`.trim() };
    case "WebFetch":
      return { ...base, kind: "web", text: String(input.url ?? ""), detail: output };
    case "WebSearch":
      return { ...base, kind: "web", text: String(input.query ?? ""), detail: output };
    case "AskUserQuestion": {
      // Claude's question with its choices, kept while it waits for an answer.
      const questions = (Array.isArray(input.questions) ? input.questions : []).slice(0, 4).map((q) => ({
        question: clip(String(q?.question ?? ""), 600),
        header: clip(String(q?.header ?? ""), 40),
        multiSelect: !!q?.multiSelect,
        options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o) => ({
          label: clip(String(o?.label ?? ""), 120),
          description: clip(String(o?.description ?? ""), 400),
        })),
      }));
      return {
        ...base,
        kind: "tool",
        text: questions[0]?.question || "Asked a question",
        detail: output,
        ...(result ? {} : { questions }),
      };
    }
    case "Task":
    case "Agent":
      return { ...base, kind: "tool", text: String(input.description ?? block.name), detail: output };
    default:
      return {
        ...base,
        kind: "tool",
        text: block.name,
        detail: block.detail ?? clip(JSON.stringify(input), 600),
      };
  }
}

// What the conversation shows of a tool call, and nothing bulkier (a Write's
// whole file, an Edit's old and new text): kept per line as it is read.
const KEEP = {
  Bash: ["command"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Write: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Read: ["file_path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  AskUserQuestion: ["questions"],
  Task: ["description"],
  Agent: ["description"],
};
function slimToolUse(b) {
  const input = b.input && typeof b.input === "object" ? b.input : {};
  const keep = KEEP[b.name] || (consentOf(b.name, input) ? ["apps", "reason", "path"] : null);
  if (!keep) return { type: "tool_use", id: b.id, name: b.name, input: {}, detail: clip(JSON.stringify(input), 600) };
  return { type: "tool_use", id: b.id, name: b.name, input: Object.fromEntries(keep.filter((k) => k in input).map((k) => [k, input[k]])) };
}
const FIELDS = ["uuid", "parentUuid", "logicalParentUuid", "type", "subtype", "isSidechain", "isMeta", "isCompactSummary", "isApiErrorMessage", "error", "timestamp"];
// One transcript line as the conversation needs it; tool results go to
// `results` by their call's id (already cut to what's shown), images stay
// only as a count.
function slimEntry(e, results, maxOutput) {
  const out = {};
  for (const key of FIELDS) if (e[key] !== undefined) out[key] = e[key];
  if (e.type === "attachment") {
    const a = e.attachment || {};
    out.attachment = a.type === "queued_command" ? { type: a.type, humanTurn: a.humanTurn, prompt: a.prompt } : { type: a.type };
  }
  if (e.message && (e.type === "user" || e.type === "assistant")) {
    const content = e.message.content;
    let kept = content;
    if (Array.isArray(content)) {
      kept = [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === "tool_result") {
          if (e.type === "user" && b.tool_use_id)
            results.set(b.tool_use_id, { is_error: !!b.is_error, output: clip(textOf(b.content) || String(b.content ?? ""), maxOutput) });
        } else if (b.type === "tool_use") kept.push(slimToolUse(b));
        else if (b.type === "text") kept.push({ type: "text", text: b.text });
        else if (b.type === "image") kept.push({ type: "image" });
      }
    }
    out.message = { content: kept, ...(e.message.model ? { model: e.message.model } : {}) };
  }
  return out;
}

// A transcript read as it grows: add() takes whole lines (more as they are
// written), view() is the conversation so far. Reading only what was
// appended keeps a 70 MB transcript of a working session from being parsed
// again on every change.
export function createClaudeTranscript({ maxOutput = 4000 } = {}) {
  const byId = new Map();
  const results = new Map();
  const meta = { title: "", cwd: "", gitBranch: "", entrypoint: "", sessionId: "" };
  let last = null;
  let firstAt = null;
  let updatedAt = null;
  // Where each line holding pictures sits in the file (when the reader is
  // told where its text starts), so one picture can be read back alone.
  const imageLines = new Map();
  return {
    add(source, { offset } = {}) {
      let position = Number.isFinite(offset) ? offset : null;
      for (const line of String(source).split("\n")) {
        const at = position;
        if (position !== null) position += Buffer.byteLength(line) + 1;
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue; /* A torn final line while the app is writing: skip it. */
        }
        if (!e || typeof e !== "object") continue;
        if (e.type === "custom-title" && e.customTitle) meta.title = e.customTitle;
        if (e.cwd) meta.cwd = e.cwd;
        if (e.gitBranch) meta.gitBranch = e.gitBranch;
        if (e.sessionId && !meta.sessionId) meta.sessionId = e.sessionId;
        if (e.entrypoint && !meta.entrypoint) meta.entrypoint = e.entrypoint;
        const slim = slimEntry(e, results, maxOutput);
        if (slim.uuid) byId.set(slim.uuid, slim);
        if (at !== null && slim.uuid && Array.isArray(slim.message?.content) && slim.message.content.some((b) => b.type === "image"))
          imageLines.set(slim.uuid, { offset: at, length: Buffer.byteLength(line) });
        if (slim.uuid && (slim.type === "user" || slim.type === "assistant") && !slim.isSidechain) last = slim;
        if (e.timestamp) {
          firstAt ??= e.timestamp;
          updatedAt = e.timestamp;
        }
      }
    },
    imageLine: (uuid) => imageLines.get(uuid) || null,
    view() {
      const chain = [];
      const seen = new Set();
      for (let cur = last; cur && !seen.has(cur.uuid); ) {
        seen.add(cur.uuid);
        chain.push(cur);
        cur = cur.parentUuid
          ? byId.get(cur.parentUuid)
          : cur.logicalParentUuid
            ? byId.get(cur.logicalParentUuid)
            : undefined;
      }
      chain.reverse();
      const items = [];
      let model = null; // the latest model that answered
      let firstUser = "";
      for (const e of chain) {
        const at = e.timestamp ? Date.parse(e.timestamp) : undefined;
        if (e.type === "system" && e.subtype === "compact_boundary") {
          items.push({ id: e.uuid, role: "system", kind: "compaction", text: "Context compacted", at });
        } else if (e.type === "attachment") {
          const a = e.attachment || {};
          if (a.type === "queued_command" && a.humanTurn && a.prompt)
            items.push({ id: e.uuid, role: "user", kind: "text", text: String(a.prompt), queued: true, at });
        } else if (e.type === "user") {
          if (e.isMeta || e.isCompactSummary) continue;
          const content = e.message?.content;
          const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
          const text = blocks
            .filter((b) => b && b.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n");
          const images = blocks.filter((b) => b?.type === "image").length;
          if (!text && !images) continue;
          if (!firstUser && text) firstUser = text;
          items.push({
            id: e.uuid,
            role: "user",
            kind: "text",
            text: text || "",
            ...(images ? { images } : {}),
            at,
          });
        } else if (e.type === "assistant" && e.isApiErrorMessage) {
          // API failures (sign-in, limits) show as an error card in the app.
          const content = Array.isArray(e.message?.content) ? e.message.content : [];
          const text = content
            .filter((b) => b?.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          items.push({
            id: `${e.uuid}:${items.length}`,
            role: "system",
            kind: "error",
            text: text || "Claude Code hit an error.",
            ...(e.error ? { detail: String(e.error) } : {}),
            at,
          });
        } else if (e.type === "assistant") {
          const content = Array.isArray(e.message?.content) ? e.message.content : [];
          if (e.message?.model && e.message.model !== "<synthetic>") model = e.message.model;
          for (const b of content) {
            if (b?.type === "text" && b.text?.trim())
              items.push({ id: `${e.uuid}:${items.length}`, role: "assistant", kind: "text", text: b.text, at });
            else if (b?.type === "tool_use") items.push({ ...toolItem(b, results.get(b.id), meta.cwd), at });
          }
        }
      }
      return {
        ...meta,
        model,
        title: meta.title || firstUser.split("\n")[0].slice(0, 120),
        // When the session started: matches it to an app process started
        // without --resume (see processes.mjs).
        firstAt: firstAt ? Date.parse(firstAt) : 0,
        updatedAt: updatedAt ? Date.parse(updatedAt) : 0,
        items,
      };
    },
  };
}

export function parseClaudeTranscript(source, options) {
  const transcript = createClaudeTranscript(options);
  transcript.add(source);
  return transcript.view();
}
