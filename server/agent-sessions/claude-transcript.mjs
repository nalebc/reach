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

function toolItem(block, result, cwd, maxOutput) {
  const input = block.input || {};
  const output = result
    ? clip(textOf(result.content) || String(result.content ?? ""), maxOutput)
    : "";
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
        detail: clip(JSON.stringify(input), 600),
      };
  }
}

export function parseClaudeTranscript(source, { maxOutput = 4000 } = {}) {
  const entries = [];
  for (const line of String(source).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* A torn final line while the app is writing: skip it. */
    }
  }
  const byId = new Map();
  const results = new Map();
  const meta = { title: "", cwd: "", gitBranch: "", entrypoint: "", sessionId: "" };
  for (const e of entries) {
    if (e.uuid) byId.set(e.uuid, e);
    if (e.type === "custom-title" && e.customTitle) meta.title = e.customTitle;
    if (e.cwd) meta.cwd = e.cwd;
    if (e.gitBranch) meta.gitBranch = e.gitBranch;
    if (e.sessionId && !meta.sessionId) meta.sessionId = e.sessionId;
    if (e.entrypoint && !meta.entrypoint) meta.entrypoint = e.entrypoint;
    if (e.type === "user" && Array.isArray(e.message?.content))
      for (const b of e.message.content)
        if (b?.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
  }
  let last;
  for (let i = entries.length - 1; i >= 0 && !last; i--) {
    const e = entries[i];
    if (e.uuid && (e.type === "user" || e.type === "assistant") && !e.isSidechain)
      last = e;
  }
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
        else if (b?.type === "tool_use")
          items.push({ ...toolItem(b, results.get(b.id), meta.cwd, maxOutput), at });
      }
    }
  }
  const lastEntry = [...entries].reverse().find((e) => e.timestamp);
  const firstEntry = entries.find((e) => e.timestamp);
  return {
    ...meta,
    model,
    title: meta.title || firstUser.split("\n")[0].slice(0, 120),
    // When the session started: matches it to an app process started
    // without --resume (see processes.mjs).
    firstAt: firstEntry?.timestamp ? Date.parse(firstEntry.timestamp) : 0,
    updatedAt: lastEntry?.timestamp ? Date.parse(lastEntry.timestamp) : 0,
    items,
  };
}
