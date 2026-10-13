import test from "node:test";
import assert from "node:assert/strict";
import { askKey, parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";

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

// Claude Code 2.1.296 writes a typed message as commandMode "prompt", with no
// humanTurn, and its own background-task notices as "task-notification".
// Reach hid the person's message, so it vanished from the phone though
// Claude had it and answered it (Oct 13).
test("a message typed while Claude works shows in Claude Code 2.1.296's form too; its task notices don't", () => {
  const typed = (uuid, parent, prompt, commandMode) => line({ ...base, type: "attachment", uuid, parentUuid: parent, timestamp: at(3),
    attachment: { type: "queued_command", prompt, source_uuid: `s-${uuid}`, delivery_id: `d-${uuid}`, commandMode, timestamp: at(3) } });
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix it" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "On it." }] } }),
    typed("q1", "a1", [{ type: "text", text: "<task-notification><task-id>x</task-id></task-notification>" }], "task-notification"),
    typed("q2", "q1", [{ type: "text", text: "also the tests" }], "prompt"),
    typed("q3", "q2", [{ type: "text", text: "a mode Claude Code adds later" }], "something-new"),
  ].join("\n");
  const { items } = parseClaudeTranscript(text);
  const mine = items.filter((i) => i.role === "user").map((i) => [i.text, !!i.queued]);
  assert.deepEqual(mine, [["Fix it", false], ["also the tests", true]]);
});

test("Claude's words keep their id when something above them comes or goes, so the phone keeps the pages it loaded", () => {
  const reply = line({ ...base, type: "assistant", uuid: "a2", parentUuid: "q1", timestamp: at(4), message: { content: [{ type: "text", text: "Done." }] } });
  const start = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix it" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "On it." }] } }),
  ];
  const queued = line({ ...base, type: "attachment", uuid: "q1", parentUuid: "a1", timestamp: at(3), attachment: { type: "queued_command", humanTurn: true, prompt: "also the tests" } });
  const empty = line({ ...base, type: "attachment", uuid: "q1", parentUuid: "a1", timestamp: at(3), attachment: { type: "queued_command", humanTurn: true, prompt: "" } });
  const idOf = (lines) => parseClaudeTranscript(lines.join("\n")).items.find((i) => i.text === "Done.").id;
  assert.equal(idOf([...start, queued, reply]), idOf([...start, empty, reply]));
});

// "Sending messages sometimes disappear and come back": one typed into the
// busy Claude app waits in Claude Code's queue (only queue-operation lines,
// outside the chain) for seconds to minutes; the phone showed nothing until
// Claude took it. Lines as Claude Code 2.1.295 writes them (78001d5b): the
// app's carry the words; Reach's own process's carry none.
test("a message waiting in Claude Code's queue shows as waiting until Claude takes it", () => {
  const q = (operation, s, extra = {}) => line({ type: "queue-operation", operation, timestamp: at(s), sessionId: ID, ...extra });
  const start = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "start a long job" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "Working on it" }] } }),
  ];
  const waiting = (lines) => parseClaudeTranscript([...start, ...lines].join("\n")).waiting.map((w) => w.text);
  assert.deepEqual(waiting([q("enqueue", 3, { content: "zq9 from the phone" })]), ["zq9 from the phone"]);
  // Taken in order; one folded into the turn running goes by its words.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("dequeue", 5)]), ["two"]);
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("remove", 5, { content: "two", reason: "absorbed_mid_turn" })]), ["one"]);
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("popAll", 5)]), []);
  // Reach's own process (no words: claude-host shows those), a background
  // task's notice: never shown as yours. Pairing still counts them.
  assert.deepEqual(waiting([q("enqueue", 3), q("enqueue", 4, { content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" }), q("enqueue", 5, { content: "mine" }), q("dequeue", 6)]), ["mine"]);
  // An operation Reach doesn't know takes nothing away.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "kept" }), q("someday", 4)]), ["kept"]);
  // Review (Oct 9): a remove whose words match none took the oldest away.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("remove", 5, { content: "three" })]), ["one", "two"]);
  // One without words (Reach's own) pairs with one without words.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4), q("remove", 5)]), ["one"]);
  // Waiting entries never join the conversation itself.
  assert.deepEqual(parseClaudeTranscript([...start, q("enqueue", 3, { content: "zq9" })].join("\n")).items.map((i) => i.text), ["start a long job", "Working on it"]);
});

// Oct 9 (ca28bb90): "Messages are stuck, I can't delete, edit, re-arrange or
// force send." A dequeue says nothing of which it took, and Claude Code took
// "continue" 14 ms after it came, ahead of a background notice waiting six
// minutes; read as the notice taken, "continue with all" (taken an hour
// before) and each message after it showed as waiting, where nothing changes
// them.
test("a dequeue takes your message before a background notice, and the message it made says which", () => {
  const q = (operation, s, extra = {}) => line({ type: "queue-operation", operation, timestamp: at(s), sessionId: ID, ...extra });
  const user = (uuid, parentUuid, s, content) => line({ ...base, type: "user", uuid, parentUuid, timestamp: at(s), message: { role: "user", content } });
  const start = [
    user("u1", null, 1, "start a long job"),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "Working on it" }] } }),
  ];
  const waiting = (lines) => parseClaudeTranscript([...start, ...lines].join("\n")).waiting.map((w) => w.text);
  const note = q("enqueue", 3, { content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" });
  // As it happened: yours taken first, then the next one, each at once.
  assert.deepEqual(waiting([
    note, q("enqueue", 4, { content: "continue" }), q("dequeue", 5), user("u2", "a1", 6, "continue"),
    q("enqueue", 7, { content: "continue with all" }), q("dequeue", 8), user("u3", "u2", 9, "continue with all"),
  ]), []);
  // The message it made names another one waiting: that one was taken.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("dequeue", 5), user("u2", "a1", 6, "two")]), ["one"]);
  // ...after the turn's own tool results too.
  assert.deepEqual(waiting([
    q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("dequeue", 5),
    user("r1", "a1", 6, [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]), user("u2", "r1", 7, "two"),
  ]), ["one"]);
  // The same words twice: one taken, the other still waits.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "yes" }), q("enqueue", 4, { content: "yes" }), q("dequeue", 5), user("u2", "a1", 6, "yes")]), ["yes"]);
  // Words that match none change nothing.
  assert.deepEqual(waiting([q("enqueue", 3, { content: "one" }), q("enqueue", 4, { content: "two" }), q("dequeue", 5), user("u2", "a1", 6, "three")]), ["two"]);
  // Only notices waiting: the oldest goes, as before.
  assert.deepEqual(waiting([note, q("enqueue", 4, { content: "<task-notification>\n<task-id>b2</task-id>\n</task-notification>" }), q("dequeue", 5), q("enqueue", 6, { content: "mine" })]), ["mine"]);
});

// A call still running carries the key of its whole input (agent-asks.mjs
// checks a re-asked permission against it), though most of it isn't kept.
test("a running call carries the key of its whole input", () => {
  const input = { command: "npm test", description: "Run the tests", timeout: 600000 };
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "test" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input }, { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/p/a" } }] } }),
    line({ ...base, type: "user", uuid: "u2", parentUuid: "a1", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "x" }] } }),
  ].join("\n");
  const [, bash, read] = parseClaudeTranscript(text).items;
  assert.equal(bash.key, askKey("Bash", input));
  assert.equal(read.key, undefined);
});

// Two messages taken as one keep each one's words (the phone's copies of
// both stayed as ghosts); a file attached on the phone shows by its name,
// not as the path Reach sent it as (SWEEP-1).
test("messages taken together keep their parts; attached files show by name", () => {
  const file = "@/Users/me/reach/.reach/quick/agent-files/a7ca5d97-1111-4222-8333-444455556666/note.txt";
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "zq1 Reply one" }, { type: "text", text: "zq2 Reply\ntwo" }] } }),
    line({ ...base, type: "user", uuid: "u2", parentUuid: "u1", timestamp: at(2), message: { role: "user", content: [{ type: "text", text: `What does it say?\n\n${file}` }] } }),
  ].join("\n");
  const [merged, attached] = parseClaudeTranscript(text).items;
  assert.deepEqual([merged.text, merged.parts], ["zq1 Reply one\nzq2 Reply\ntwo", ["zq1 Reply one", "zq2 Reply\ntwo"]]);
  assert.deepEqual([attached.text, attached.attachments, attached.parts], ["What does it say?", ["note.txt"], undefined]);
});
