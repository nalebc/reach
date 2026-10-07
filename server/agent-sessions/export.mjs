// A whole chat as Markdown, to share or keep, as both apps export one: who
// said what, in order, with what the agent did summed up in a line each.
// Built from the chat's items as Reach shows them (claude-transcript.mjs,
// codex.mjs codexItem); nothing the phone wasn't already shown.
const quote = (text) =>
  String(text || "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
const fence = (text) => {
  const body = String(text || "");
  const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${body}\n${ticks}`;
};

export function chatMarkdown({ title = "", agent = "", cwd = "", items = [], exportedAt = new Date() } = {}) {
  const who = agent === "codex" ? "Codex" : agent === "claude" ? "Claude" : "Agent";
  const out = [`# ${String(title || "Chat").replace(/\n/g, " ")}`, ""];
  const meta = [who, cwd, exportedAt.toISOString().slice(0, 10)].filter(Boolean).join(" · ");
  out.push(`_${meta}_`, "");
  let steps = [];
  const flush = () => {
    if (!steps.length) return;
    out.push(...steps.map((s) => `- ${s}`), "");
    steps = [];
  };
  for (const item of items) {
    if (!item) continue;
    if (item.role === "user") {
      flush();
      const text = item.slash ? `\`${item.text}\`` : item.text;
      if (!String(text || "").trim() && !item.images) continue;
      out.push("**You**", "", quote(text || ""), ...(item.images ? ["", `_${item.images} picture${item.images === 1 ? "" : "s"}_`] : []), "");
    } else if (item.role === "assistant" && item.kind === "text") {
      flush();
      out.push(`**${who}**`, "", String(item.text || ""), "");
    } else if (item.kind === "command") {
      steps.push(`Ran \`${String(item.text || "").split("\n")[0].slice(0, 200)}\`${item.status === "failed" ? " (failed)" : ""}`);
    } else if (item.kind === "file-change") {
      steps.push(`Edited ${item.text}`);
    } else if (item.kind === "agent") {
      steps.push(`Agent: ${item.text}`);
    } else if (item.kind === "compaction") {
      steps.push("Context compacted");
    } else if (item.kind === "output" && item.text) {
      flush();
      out.push(fence(item.text), "");
    } else if (item.role === "tool" && item.text) {
      steps.push(String(item.text).split("\n")[0].slice(0, 200));
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
