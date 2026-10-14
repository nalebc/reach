// The visible archive and the model's working context have different lifetimes.
// Keep the archive whole; seed large imports with a bounded working context.
import { clipMiddle, handoff, moveTurns } from "./move.mjs";

// Count UTF-8 bytes rather than assuming four characters per token. This also
// leaves room for the destination's instructions, tools and the next reply.
export const TRANSFER_CONTEXT_BUDGET = 96_000;
const MESSAGE_OVERHEAD = 256;
const IMAGE_COST = 16_000;
const bytes = text => Buffer.byteLength(text, "utf8");

export function transferContext({ items, messages, from, title, cwd, context, archivePath = "" }) {
  const size = messages.reduce((n, m) => n + bytes(m.text) + MESSAGE_OVERHEAD + m.images.length * IMAGE_COST, 0);
  if (size <= TRANSFER_CONTEXT_BUDGET) return null;

  const original = items.find(item => item.role === "user" && item.kind === "text" && item.text);
  const note = [
    handoff({ from, title, cwd }),
    "The transferred context was shortened to fit. The full messages, tool output and attachments remain in the saved history. Read older details selectively and check the current files before continuing.",
    archivePath ? `Full history file: ${archivePath}` : "",
    original ? `Original request:\n${clipMiddle(original.text, 2000)}` : "",
  ].filter(Boolean).join("\n\n");
  const source = context?.items || items;
  const summary = context?.summary || "";
  let budget = TRANSFER_CONTEXT_BUDGET - bytes(note) - MESSAGE_OVERHEAD;
  for (;;) {
    let history = moveTurns(source, { summary, from, budget });
    // Thousands of tiny alternating messages also consume context in framing.
    // Fold those into one historical block instead of copying that overhead.
    if (history.length > 128) history = [{ role: "user", text: history.map(t => `**${t.role === "user" ? "You" : from}:**\n${t.text}`).join("\n\n") }];
    const turns = [{ role: "user", text: note }, ...history];
    const used = turns.reduce((n, t) => n + bytes(t.text) + MESSAGE_OVERHEAD, 0);
    if (used <= TRANSFER_CONTEXT_BUDGET) return turns;
    // Rebuild from the source so shortening always favors its latest messages.
    budget = Math.max(1000, Math.floor(budget * (TRANSFER_CONTEXT_BUDGET / used) * 0.9));
  }
}
