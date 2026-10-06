import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";

// The phone showed "<task-notification><task-id>…</task-id>…" as if you'd
// written it (2026-10-05): Claude Code writes a background task's notice (a
// watcher reporting, a task ending) into the chat as a user turn from itself.
// The Claude app shows only text outside the notice, if any.
const A = "11111111-2222-4333-8444-555555555555";
const at = (s) => new Date(Date.UTC(2026, 9, 6, 3, 55, s)).toISOString();
const line = (o) => JSON.stringify(o);
const base = { sessionId: A, cwd: "/work/app", entrypoint: "claude-desktop" };
const notice =
  '<task-notification>\n<task-id>bzr91e4bj</task-id>\n<summary>Monitor event: "Reach outbox for this chat"</summary>\n<event>20:55:42 2 waiting</event>\n</task-notification>';
const fromClaude = { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system" };

test("a background task's notice isn't shown as your message; text outside it shows as a quiet line", () => {
  const view = parseClaudeTranscript(
    [
      line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix the chat list" } }),
      line({ ...base, type: "user", uuid: "n1", parentUuid: "u1", timestamp: at(2), ...fromClaude, message: { role: "user", content: notice } }),
      line({ ...base, type: "user", uuid: "n2", parentUuid: "n1", timestamp: at(3), ...fromClaude, message: { role: "user", content: `${notice}\nThe build finished.` } }),
      line({ ...base, type: "user", uuid: "u2", parentUuid: "n2", timestamp: at(4), message: { role: "user", content: "Thanks" } }),
    ].join("\n"),
  );
  assert.deepEqual(
    view.items.map((i) => [i.role, i.kind, i.text]),
    [
      ["user", "text", "Fix the chat list"],
      ["system", "notice", "The build finished."],
      ["user", "text", "Thanks"],
    ],
  );
  assert.ok(!JSON.stringify(view.items).includes("task-notification"));
});

test("a chat whose first turn is a notice isn't named after it", () => {
  const view = parseClaudeTranscript(
    [
      line({ ...base, type: "user", uuid: "n1", parentUuid: null, timestamp: at(1), ...fromClaude, message: { role: "user", content: notice } }),
      line({ ...base, type: "user", uuid: "u1", parentUuid: "n1", timestamp: at(2), message: { role: "user", content: "Fix the chat list" } }),
    ].join("\n"),
  );
  assert.equal(view.title, "Fix the chat list");
});
