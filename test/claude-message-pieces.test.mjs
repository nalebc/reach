import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";

// What a Claude chat showed as the person's words: the Claude app's
// <system-reminder> (its 7 KB of instructions, added when a chat moves into
// it) in front of "reconcile changes", and a message typed with a picture
// while Claude worked as "[object Object],[object Object]".
const ID = "11111111-2222-4333-8444-555555555555";
const base = { sessionId: ID, cwd: "/work", entrypoint: "claude-desktop" };
const at = (s) => new Date(Date.UTC(2026, 9, 5, 22, 0, s)).toISOString();
const line = (o) => JSON.stringify(o);

test("only what the person wrote shows: no app instructions, no object text, pictures counted", () => {
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix it" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "On it." }] } }),
    line({ ...base, type: "attachment", uuid: "q1", parentUuid: "a1", timestamp: at(3), attachment: { type: "queued_command", humanTurn: true, prompt: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "This is not true" }] } }),
    line({ ...base, type: "user", uuid: "u2", parentUuid: "q1", timestamp: at(4), origin: { kind: "human" }, message: { role: "user", content: [
      { type: "text", text: "<system-reminder>\nThis conversation is now continuing in the Claude desktop app (Code tab).\n</system-reminder>\n\n" },
      { type: "text", text: "reconcile changes" },
    ] } }),
  ].join("\n");
  const { items } = parseClaudeTranscript(text);
  const said = items.filter((i) => i.role === "user").map((i) => [i.text, i.images || 0, !!i.queued]);
  assert.deepEqual(said, [
    ["Fix it", 0, false],
    ["This is not true", 1, true],
    ["reconcile changes", 0, false],
  ]);
});

// Stopped mid-reply (recorded from Claude Code 2.1.291): the words so far, then
// "[Request interrupted by user]" written as a user turn. It showed as a
// message you sent, and a chat moved elsewhere carried it as yours.
test("a stopped turn keeps its words and shows a quiet Stopped, not a message from you", () => {
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Write a story" }] } }),
    line({ ...base, type: "assistant", uuid: "a0", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "thinking", thinking: "" }], stop_reason: null } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "a0", timestamp: at(2), message: { content: [{ type: "text", text: "Marcus had tended the lighthouse" }], stop_reason: null } }),
    line({ ...base, type: "user", uuid: "u2", parentUuid: "a1", timestamp: at(3), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    line({ ...base, type: "user", uuid: "u3", parentUuid: "u2", timestamp: at(4), message: { role: "user", content: [{ type: "text", text: "Shorter" }] } }),
    line({ ...base, type: "user", uuid: "u4", parentUuid: "u3", timestamp: at(5), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
  ].join("\n");
  const { items } = parseClaudeTranscript(text);
  assert.deepEqual(
    items.map((i) => [i.role, i.kind, i.text]),
    [
      ["user", "text", "Write a story"],
      ["assistant", "text", "Marcus had tended the lighthouse"],
      ["system", "notice", "Stopped"],
      ["user", "text", "Shorter"],
      ["system", "notice", "Stopped"],
    ],
  );
});

test("a message typed while Claude works shows at once, before Claude writes anything after it", () => {
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix it" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "On it." }] } }),
    line({ ...base, type: "attachment", uuid: "q1", parentUuid: "a1", timestamp: at(3), attachment: { type: "queued_command", humanTurn: true, prompt: "also the tests" } }),
  ].join("\n");
  const { items } = parseClaudeTranscript(text);
  assert.deepEqual(items.at(-1) && [items.at(-1).text, items.at(-1).queued], ["also the tests", true]);
});
