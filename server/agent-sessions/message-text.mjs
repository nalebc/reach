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
  // shown by its name (mentionedChats below); a picture the chat already
  // had (image-repeats.mjs), shown as a tag (repeatedImages below).
  const envelope = /^\s*<(in-app-browser-context|external_codex_apps_open_page|environment_context|ide_context|system-reminder|reach-chat|reach-image)\b[^>]*>[\s\S]*?<\/\1>\s*/;
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

// How many pictures a message sent as "the same as before" (image-repeats.mjs).
export function repeatedImages(value) {
  const match = String(value ?? "").match(/<reach-image\b[^>]*\bcount="(\d{1,2})"/);
  return match ? Number(match[1]) : 0;
}

// Files attached on the phone go after the words as their paths in Reach's
// agent-files/<id>/<name> (server/index.mjs withFiles): "@path" for Claude
// Code, the path for Codex. The chat shows the words and each file's name;
// the path showed in the person's bubble, and the sent copy never matched it.
// Only such a trailing run of lines: an "@file" the person typed stays.
const ATTACHED_FILE = /^@?\/.*\/agent-files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/([^/\\\n]{1,120})$/;
export function attachedFiles(value) {
  const text = String(value ?? "");
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && ATTACHED_FILE.test(lines[end - 1])) end--;
  if (end === lines.length) return { text, files: [] };
  return { text: lines.slice(0, end).join("\n").trim(), files: lines.slice(end).map((line) => ATTACHED_FILE.exec(line)[1]) };
}
