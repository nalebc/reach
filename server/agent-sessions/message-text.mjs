// Codex attaches context before the person's message. It belongs to the
// model's input, not to the visible chat. Only unwrap known leading envelopes;
// never strip arbitrary HTML or examples inside the person's own request.
export function visibleUserText(value) {
  let text = String(value ?? "");
  let removed = false;
  // Context an app adds ahead of what the person typed: Codex's, and the
  // Claude app's <system-reminder> (its instructions, when a chat moves into
  // it), which showed in the person's own bubble.
  const envelope = /^\s*<(in-app-browser-context|external_codex_apps_open_page|environment_context|ide_context|system-reminder)\b[^>]*>[\s\S]*?<\/\1>\s*/;
  for (;;) {
    const match = text.match(envelope);
    if (!match) break;
    text = text.slice(match[0].length);
    removed = true;
  }
  return removed ? text.replace(/^\s*## My request:\s*\n?/, "").trim() : text;
}
