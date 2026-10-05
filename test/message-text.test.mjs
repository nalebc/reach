import test from "node:test";
import assert from "node:assert/strict";
import { visibleUserText } from "../server/agent-sessions/message-text.mjs";
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
