import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Long chats stuttered on the phone: every update, keystroke and the 1 s
// "Working 12s" clock redrew the whole chat, parsing every message's markdown
// again, and one Codex item woke two or three overlapping reads.
const session = fs.readFileSync(new URL("../src/AgentSession.tsx", import.meta.url), "utf8");
const markdown = fs.readFileSync(new URL("../src/AgentMarkdown.tsx", import.meta.url), "utf8");

test("a message's markdown is drawn again only when its text changes", () => {
  assert.match(markdown, /export default memo\(AgentMarkdown\);/);
  assert.doesNotMatch(markdown, /export default function AgentMarkdown/);
});

test("the Working clock ticks on its own, not the whole chat", () => {
  const view = session.slice(session.indexOf("export default function AgentSessionView"));
  assert.doesNotMatch(view, /setInterval\(\(\) => setNow\(/);
  assert.match(session, /function Elapsed\(\{ since, after = "" \}/);
  assert.match(view, /<Elapsed since=\{since\}/);
});

test("one read of the chat at a time; wakes meanwhile are read once after it", () => {
  const load = session.slice(session.indexOf("const load = useCallback("), session.indexOf("const again = useRef(load);"));
  assert.match(load, /if \(!first && reading\.current\) \{\s*reading\.current\.again = true;\s*return;/);
  assert.match(load, /if \(turn\.again\) void again\.current\(false\);/);
});
