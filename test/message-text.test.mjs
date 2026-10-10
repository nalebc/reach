import test from "node:test";
import assert from "node:assert/strict";
import { attachedFiles, visibleUserText } from "../server/agent-sessions/message-text.mjs";
import { codexItem, codexSession } from "../server/agent-sessions/codex.mjs";

const wrapped = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\n<in-app-browser-context source="ambient-ui-state">\nBrowser context, not the message\n</in-app-browser-context>\n\n## My request:\nFix the chat';
test("Codex ambient context is hidden in messages and previews, not the person's request", () => {
  assert.equal(visibleUserText(wrapped), "Fix the chat");
  assert.equal(codexItem({ item: { type: "userMessage", id: "u", content: [{ type: "text", text: wrapped }] } }).text, "Fix the chat");
  assert.equal(codexSession({ preview: wrapped }).preview, "Fix the chat");
  assert.equal(codexItem({ item: { type: "userMessage", content: [{ type: "text", text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] } }), null);
});
test("ordinary HTML, request headings and quoted context examples remain intact", () => {
  for (const text of ['<div>My app</div>', '## My request:\nKeep this', 'Explain:\n' + wrapped, '```xml\n' + wrapped + '\n```'])
    assert.equal(visibleUserText(text), text);
});

test("the Claude app's instructions never show as the person's words", () => {
  // A chat moved into the Claude app: its next user turn starts with the
  // app's <system-reminder> (7 KB of instructions), then what was typed.
  const moved = "<system-reminder>\nThis conversation is now continuing in the Claude desktop app (Code tab).\n<simulator_tools>\n…\n</simulator_tools>\n</system-reminder>\n\n\nreconcile changes";
  assert.equal(visibleUserText(moved), "reconcile changes");
  // Quoted or explained further down, it stays as written.
  const quoted = "What is this?\n<system-reminder>x</system-reminder>";
  assert.equal(visibleUserText(quoted), quoted);
});

// "The bubble shows Reach's internal file path" (a file attached on the
// phone): the words and the file's name, never the path; an "@file" the
// person typed, or a path elsewhere in the words, stays.
test("files attached on the phone show by name, not as Reach's paths", () => {
  const dir = "/Users/me/reach/.reach/quick/agent-files/a7ca5d97-1111-4222-8333-444455556666";
  assert.deepEqual(attachedFiles(`What does it say?\n\n@${dir}/note.txt\n@${dir}/my plan.pdf`), { text: "What does it say?", files: ["note.txt", "my plan.pdf"] });
  assert.deepEqual(attachedFiles(`${dir}/note.txt`), { text: "", files: ["note.txt"] }, "Codex: the bare path");
  for (const text of ["Look at @src/app.ts", `@${dir}/note.txt\nthen fix it`, "@/etc/hosts"]) assert.deepEqual(attachedFiles(text), { text, files: [] });
});
