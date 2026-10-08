// Codex attaches context before the person's message. It belongs to the
// model's input, not to the visible chat. Only unwrap known leading envelopes;
// never strip arbitrary HTML or examples inside the person's own request.
export function visibleUserText(value) {
  let text = String(value ?? "");
  let removed = false;
  // Context an app adds ahead of what the person typed: Codex's, and the
  // Claude app's <system-reminder> (its instructions, when a chat moves into
  // it), which showed in the person's own bubble.
  // Reach's own: a chat mentioned with "@" (chat-context.mjs mentionBlock),
  // shown by its name (mentionedChats below).
  const envelope = /^\s*<(in-app-browser-context|external_codex_apps_open_page|environment_context|ide_context|system-reminder|reach-chat)\b[^>]*>[\s\S]*?<\/\1>\s*/;
  for (;;) {
    const match = text.match(envelope);
    if (!match) break;
    text = text.slice(match[0].length);
    removed = true;
  }
  return removed ? text.replace(/^\s*## My request:\s*\n?/, "").trim() : text;
}

// The chats a message mentioned ("@" in the box), by name and agent, from the
// blocks Reach put ahead of it.
export function mentionedChats(value) {
  const text = String(value ?? "");
  const found = [];
  const block = /<reach-chat\b([^>]*)>[\s\S]*?<\/reach-chat>/g;
  for (const match of text.matchAll(block)) {
    const attr = (name) => match[1].match(new RegExp(`${name}="([^"]*)"`))?.[1] || "";
    found.push({ from: attr("from"), chat: attr("chat") });
  }
  return found;
}
