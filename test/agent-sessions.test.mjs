import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeTranscript, parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { codexItem, codexSession } from "../server/agent-sessions/codex.mjs";
import {
  claudeProcesses,
  elapsedSeconds,
  matchClaude,
  parseLsofCwd,
  parsePs,
} from "../server/agent-sessions/processes.mjs";
import { createAgentSessions, nativeLink } from "../server/agent-sessions/index.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const line = (o) => JSON.stringify(o);
const at = (s) => new Date(Date.UTC(2026, 9, 4, 10, 0, s)).toISOString();

// A synthetic transcript with every shape seen in real Claude Code files.
function transcript() {
  const base = { sessionId: ID, cwd: "/work/app", gitBranch: "main", entrypoint: "cli" };
  return [
    line({ type: "queue-operation", operation: "enqueue", sessionId: ID, timestamp: at(0) }),
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Fix the login bug" } }),
    // Superseded: the person edited their next message, so this branch is gone.
    line({ ...base, type: "assistant", uuid: "old", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "OLD BRANCH" }] } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(3), message: { content: [{ type: "text", text: "Looking." }] } }),
    // Two parallel tool calls; the first result branches off the chain.
    line({ ...base, type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: at(4), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
    line({ ...base, type: "assistant", uuid: "a3", parentUuid: "a2", timestamp: at(5), message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/work/app/src/login.ts" } }] } }),
    line({ ...base, type: "user", uuid: "r1", parentUuid: "a2", timestamp: at(6), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 failing" }] } }),
    line({ ...base, type: "user", uuid: "r2", parentUuid: "a3", timestamp: at(7), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }),
    // Typed while the turn ran.
    line({ ...base, type: "attachment", uuid: "q1", parentUuid: "r2", timestamp: at(2), attachment: { type: "queued_command", prompt: "also check signup", humanTurn: true } }),
    line({ ...base, type: "attachment", uuid: "q2", parentUuid: "q1", timestamp: at(8), attachment: { type: "queued_command", prompt: "internal", humanTurn: false } }),
    line({ ...base, type: "user", uuid: "m1", parentUuid: "q2", timestamp: at(9), isMeta: true, message: { content: "meta" } }),
    // Compaction: a new root that continues the old chain logically.
    line({ ...base, type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: null, logicalParentUuid: "m1", timestamp: at(10) }),
    line({ ...base, type: "user", uuid: "s1", parentUuid: "c1", timestamp: at(11), isCompactSummary: true, message: { content: "summary of earlier work" } }),
    line({ ...base, type: "assistant", uuid: "a4", parentUuid: "s1", timestamp: at(12), message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Done: login fixed." }] } }),
    line({ type: "custom-title", customTitle: "Login fix", sessionId: ID }),
    '{"type":"assistant","uuid":"torn"', // a torn final line while writing
  ].join("\n");
}

test("Claude transcripts read as the conversation a person saw", () => {
  const r = parseClaudeTranscript(transcript());
  assert.equal(r.title, "Login fix");
  assert.equal(r.cwd, "/work/app");
  assert.equal(r.gitBranch, "main");
  const view = r.items.map((i) => `${i.role}:${i.kind}:${i.text}${i.queued ? ":queued" : ""}${i.status ? `:${i.status}` : ""}`);
  assert.deepEqual(view, [
    "user:text:Fix the login bug",
    "assistant:text:Looking.",
    "tool:command:npm test:completed",
    "tool:file-change:src/login.ts:completed",
    "user:text:also check signup:queued",
    "system:compaction:Context compacted",
    "assistant:text:Done: login fixed.",
  ]);
  assert.equal(r.items[2].detail, "1 failing", "parallel result attached by tool_use_id");
  assert.ok(!view.some((v) => v.includes("OLD BRANCH")), "superseded branch dropped");
  assert.equal(r.firstAt, Date.parse(at(0)));
});

test("Claude sessions list transcripts, map app records, page and reject unknown ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  const projects = path.join(root, "projects", "-work-app");
  const records = path.join(root, "records", "acct", "org");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), transcript());
  await fs.writeFile(path.join(projects, "22222222-2222-4222-8222-222222222222.jsonl"), line({ type: "queue-operation" }));
  await fs.writeFile(path.join(records, `local_${ID}.json`), JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, title: "From the app", isArchived: false, cwd: "/work/app" }));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  const list = await claude.list();
  assert.equal(list.length, 1, "empty transcripts are left out");
  assert.equal(list[0].title, "From the app");
  assert.equal(list[0].inApp, true);
  assert.equal(list[0].appSessionId, `local_${ID}`);
  const page = await claude.read(ID, { limit: 3 });
  assert.equal(page.items.length, 3);
  const older = await claude.read(ID, { limit: 3, before: page.before });
  assert.ok(!older.items.some((i) => page.items.some((j) => j.id === i.id)));
  await assert.rejects(() => claude.read("../../etc/passwd"), (e) => e.status === 404);
  // The app's records are kept between reads (each read parsed them all) and
  // read again only when one changes: renamed, then removed.
  const record = path.join(records, `local_${ID}.json`);
  await fs.writeFile(record, JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, title: "Renamed in the app", isArchived: false, cwd: "/work/app" }));
  await fs.utimes(record, new Date(), new Date(Date.now() + 5000));
  assert.equal((await claude.read(ID, { limit: 1 })).session.title, "Renamed in the app");
  await fs.rm(record);
  assert.equal((await claude.read(ID, { limit: 1 })).session.inApp, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("a growing Claude transcript is read from where reading stopped, giving what reading it whole gives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  const dir = path.join(root, "projects", "-work-app");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  const base = { sessionId: ID, cwd: "/work/app", entrypoint: "cli" };
  let n = 0;
  const turn = (text, parent) => [
    line({ ...base, type: "user", uuid: `u${++n}`, parentUuid: parent, timestamp: at(n), message: { content: text } }),
    line({ ...base, type: "assistant", uuid: `a${n}`, parentUuid: `u${n}`, timestamp: at(n), message: { model: "claude-x", content: [{ type: "text", text: `ok ${n}` }] } }),
  ];
  // Every reader made, and the text each was given.
  const readers = [];
  const reader = () => {
    const transcript = createClaudeTranscript();
    const fed = [];
    readers.push(fed);
    return { add: (text) => (fed.push(text), transcript.add(text)), view: () => transcript.view() };
  };
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), reader });
  const whole = async () => parseClaudeTranscript(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, turn("first", null).join("\n") + "\n");
  assert.deepEqual((await claude.read(ID)).items.map((i) => i.text), ["first", "ok 1"]);
  // Two more lines appended: only they are read.
  const appended = turn("second", "a1").join("\n") + "\n";
  await fs.appendFile(file, appended);
  const page = await claude.read(ID);
  assert.deepEqual(page.items.map((i) => i.text), ["first", "ok 1", "second", "ok 2"]);
  assert.equal(readers.length, 1);
  assert.deepEqual(readers[0].at(-1), appended);
  assert.deepEqual(page.items, (await whole()).items);
  // A line still being written: shown once whole, never twice.
  const [user3, reply3] = turn("third", "a2");
  await fs.appendFile(file, user3);
  assert.deepEqual((await claude.read(ID)).items.map((i) => i.text).slice(-1), ["third"]);
  await fs.appendFile(file, "\n" + reply3.slice(0, 40));
  assert.deepEqual((await claude.read(ID)).items.map((i) => i.text).slice(-1), ["third"]);
  await fs.appendFile(file, reply3.slice(40) + "\n");
  assert.deepEqual((await claude.read(ID)).items.map((i) => i.text), ["first", "ok 1", "second", "ok 2", "third", "ok 3"]);
  assert.deepEqual((await claude.read(ID)).items, (await whole()).items);
  assert.equal(readers.length, 1, "still the one reader");
  // Written anew (not appended): read whole again.
  await fs.writeFile(file, turn("restarted", null).join("\n") + "\n");
  assert.deepEqual((await claude.read(ID)).items.map((i) => i.text), ["restarted", "ok 4"]);
  assert.equal(readers.length, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("a picture sent in a Claude session is read back from its own line, the transcript growing or not", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  const dir = path.join(root, "projects", "-work-app");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  const base = { sessionId: ID, cwd: "/work/app", entrypoint: "cli" };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 9, 9]);
  const picture = (data, type) => ({ type: "image", source: { type: "base64", media_type: type, data: data.toString("base64") } });
  // Text with characters of several bytes before it, so its place is counted in bytes.
  await fs.writeFile(
    file,
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { content: "héllo — first 🙂" } }) + "\n",
  );
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  await claude.read(ID);
  await fs.appendFile(
    file,
    line({ ...base, type: "user", uuid: "u2", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "look" }, picture(png, "image/png"), picture(jpeg, "image/jpeg")] } }) + "\n",
  );
  assert.equal((await claude.read(ID)).items.at(-1).images, 2);
  assert.deepEqual(await claude.image(ID, "u2", 0), { type: "image/png", data: png });
  assert.deepEqual(await claude.image(ID, "u2", 1), { type: "image/jpeg", data: jpeg });
  // Sent while Claude worked: its pictures sit in the queued command's prompt.
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 7]);
  await fs.appendFile(
    file,
    line({ ...base, type: "attachment", uuid: "q1", parentUuid: "u2", timestamp: at(3), attachment: { type: "queued_command", humanTurn: true, prompt: [picture(webp, "image/webp"), { type: "text", text: "more" }] } }) + "\n" +
      line({ ...base, type: "assistant", uuid: "a3", parentUuid: "q1", timestamp: at(4), message: { content: [{ type: "text", text: "Seen." }] } }) + "\n",
  );
  const queued = (await claude.read(ID)).items.find((i) => i.id === "q1");
  assert.equal(queued.queued, true);
  assert.equal(queued.images, 1);
  assert.deepEqual(await claude.image(ID, "q1", 0), { type: "image/webp", data: webp });
  // Nothing else is served: no such picture, a line without one, a made-up id.
  await assert.rejects(claude.image(ID, "u2", 2), (e) => e.status === 404);
  await assert.rejects(claude.image(ID, "u1", 0), (e) => e.status === 404);
  await assert.rejects(claude.image(ID, "../u2", 0), (e) => e.status === 404);
  await assert.rejects(claude.image("22222222-2222-4222-8222-222222222222", "u2", 0), (e) => e.status === 404);
  // Read whole by a fresh Reach (after a restart): same answer.
  const fresh = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  assert.deepEqual(await fresh.image(ID, "u2", 1), { type: "image/jpeg", data: jpeg });
  await fs.rm(root, { recursive: true, force: true });
});

test("whether the Claude app took a message is read from its transcript: its own entry, or its queue entry while working", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  const dir = path.join(root, "projects", "-work-app");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  const since = Date.parse(at(5));
  await fs.writeFile(
    file,
    [
      line({ sessionId: ID, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), entrypoint: "claude-desktop", message: { content: "Run the tests" } }),
    ].join("\n") + "\n",
  );
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  // Only what came after it was sent counts.
  assert.equal(await claude.arrived(ID, "Run the tests", since), false);
  await fs.appendFile(file, line({ type: "queue-operation", operation: "enqueue", timestamp: at(6), sessionId: ID, content: "Run the tests" }) + "\n");
  assert.equal(await claude.arrived(ID, "Run the tests", since), true);
  assert.equal(await claude.arrived(ID, "Something else", since), false);
  await fs.appendFile(file, line({ sessionId: ID, type: "user", uuid: "u2", parentUuid: "u1", timestamp: at(7), entrypoint: "claude-desktop", message: { content: [{ type: "text", text: "Ship it" }] } }) + "\n");
  assert.equal(await claude.arrived(ID, "Ship it", since), true);
  // Written by Reach's own process: not the app taking it.
  await fs.appendFile(file, line({ sessionId: ID, type: "user", uuid: "u3", parentUuid: "u2", timestamp: at(8), entrypoint: "sdk-cli", message: { content: "From Reach" } }) + "\n");
  assert.equal(await claude.arrived(ID, "From Reach", since), false);
  // A chat that moved into the Claude app: its instructions come first, in
  // their own text block (seen Oct 6). Still the message it took.
  const reminder = "<system-reminder>\nThis conversation is now continuing in the Claude desktop app.\n</system-reminder>";
  await fs.appendFile(file, line({ sessionId: ID, type: "user", uuid: "u4", parentUuid: "u3", timestamp: at(9), entrypoint: "claude-desktop", message: { content: [{ type: "text", text: reminder }, { type: "text", text: "Just the coin" }] } }) + "\n");
  assert.equal(await claude.arrived(ID, "Just the coin", since), true);
  assert.equal(await claude.arrived(ID, "Just the", since), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("a transcript is kept as the conversation shows it: big tool inputs, outputs and images don't stay in memory", () => {
  const base = { sessionId: ID, cwd: "/work/app", entrypoint: "cli" };
  const big = "x".repeat(200000);
  const transcript = createClaudeTranscript();
  transcript.add(
    [
      line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", data: big } }] } }),
      line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/work/app/big.txt", content: big } },
        { type: "tool_use", id: "m1", name: "mcp__thing__do", input: { blob: big } },
      ] } }),
      line({ ...base, type: "user", uuid: "r1", parentUuid: "a1", timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: "w1", content: big }] } }),
    ].join("\n"),
  );
  const view = transcript.view();
  assert.equal(view.items[0].images, 1);
  assert.equal(view.items[1].text, "big.txt");
  assert.ok(view.items[1].status === "completed");
  assert.ok(view.items[2].detail.length < 700, "cut to what's shown");
  // What stays in memory is about what's shown, not the 600 KB the lines held.
  assert.ok(JSON.stringify(view).length < 20000);
});

test("Claude out of usage: the limit Claude Code last hit, until it resets or an answer comes after it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-usage-"));
  const dir = path.join(root, "projects", "-work-app");
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const base = { cwd: "/work/app", entrypoint: "claude-desktop" };
  const ask = (id, uuid, when) =>
    line({ ...base, sessionId: id, type: "user", uuid, parentUuid: null, timestamp: iso(when), message: { role: "user", content: "Try again" } });
  // What Claude Code writes into the session when the limit is hit (verified,
  // Claude Code 2.1.28x): its words, and when the limit resets.
  const limit = (id, uuid, parent, when, resetsAt, quota = { status: "rejected", resetsAt: resetsAt / 1000, rateLimitType: "five_hour" }) =>
    line({
      ...base, sessionId: id, type: "assistant", uuid, parentUuid: parent, timestamp: iso(when),
      isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: quota,
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 3:20pm (America/Vancouver)" }] },
    });
  const reply = (id, uuid, parent, when) =>
    line({ ...base, sessionId: id, type: "assistant", uuid, parentUuid: parent, timestamp: iso(when), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Done." }] } });
  const A = "aaaaaaaa-2222-4333-8444-555555555555";
  const B = "bbbbbbbb-2222-4333-8444-555555555555";
  const resets = now + 50 * 60 * 1000;
  await fs.writeFile(path.join(dir, `${A}.jsonl`), `${ask(A, "u1", now - 120000)}\n${limit(A, "e1", "u1", now - 60000, resets)}\n`);
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), run: async () => ({ stdout: '{"loggedIn":true}' }) });
  // Out until it resets: what the Chat tab says, as it does for Codex.
  assert.deepEqual(await claude.health(), {
    agent: "claude", installed: true, signedIn: true, usable: false, resetsAt: resets,
    limit: "You've hit your session limit · resets 3:20pm (America/Vancouver)",
  });
  assert.equal(await claude.usage(resets + 1), null, "the limit has reset");
  // An answer since, in any session: usable again.
  await fs.writeFile(path.join(dir, `${B}.jsonl`), `${ask(B, "u2", now - 40000)}\n${reply(B, "r2", "u2", now - 30000)}\n`);
  assert.equal((await claude.health()).usable, true);
  // A brief slowdown ("rate_limit" without a used-up limit) isn't out of usage.
  const calm = path.join(root, "calm", "-work-app");
  await fs.mkdir(calm, { recursive: true });
  await fs.writeFile(path.join(calm, `${A}.jsonl`), `${ask(A, "u1", now - 120000)}\n${limit(A, "e1", "u1", now - 60000, resets, { status: "allowed_warning" })}\n`);
  assert.equal(await createClaudeSessions({ projects: path.join(root, "calm") }).usage(), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("Claude sign-in status: signed out exits 1 with JSON on stdout", async () => {
  const signedOut = createClaudeSessions({
    run: async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stdout: '{"loggedIn":false}' });
    },
  });
  assert.deepEqual(await signedOut.health(), { agent: "claude", installed: true, signedIn: false, usable: false });
  // (No sessions: nothing of this Mac's own Claude is read.)
  const signedIn = createClaudeSessions({ projects: path.join(os.tmpdir(), "reach-no-claude-projects"), run: async () => ({ stdout: '{"loggedIn":true}' }) });
  assert.deepEqual(await signedIn.health(), { agent: "claude", installed: true, signedIn: true, usable: true });
  const missing = createClaudeSessions({
    run: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });
  assert.equal((await missing.health()).installed, false);
});

test("live Claude processes map to sessions, skipping the app's wrapper", () => {
  assert.equal(elapsedSeconds("05:24:59"), 5 * 3600 + 24 * 60 + 59);
  assert.equal(elapsedSeconds("1-00:00:10"), 86410);
  assert.equal(elapsedSeconds("03:21"), 201);
  const now = Date.parse("2026-10-04T12:00:00Z");
  const ps = [
    "  100     1 05:00:00 ??       /Applications/Claude.app/Contents/MacOS/Claude",
    `  200   100 01:00:00 ??       /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --resume=${ID}`,
    `  201   200 01:00:00 ??       /Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --output-format stream-json --effort xhigh --model claude-opus-5-5 --resume=${ID} --permission-mode auto`,
    "  300   100 00:10:00 ??       /Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude --output-format stream-json",
    "  400   399 00:05:00 ttys004  claude",
    "  500     1 00:01:00 ??       /usr/bin/claudette --resume=99999999-9999-4999-8999-999999999999",
  ].join("\n");
  const procs = claudeProcesses(parsePs(ps, now));
  assert.deepEqual(procs.map((p) => [p.pid, p.host, p.sessionId]), [
    [201, "claude-app", ID],
    [300, "claude-app", null],
    [400, "terminal", null],
  ]);
  const fresh = "33333333-3333-4333-8333-333333333333";
  const cwds = parseLsofCwd("p300\nfcwd\nn/work/app\np400\nfcwd\nn/elsewhere\n");
  const starts = [
    { id: fresh, cwd: "/work/app", firstAt: now - 600000 + 1000 },
    { id: "44444444-4444-4444-8444-444444444444", cwd: "/work/app", firstAt: now - 60000 },
  ];
  const live = matchClaude(procs, cwds, starts);
  // The settings the app started it with come along.
  assert.deepEqual(live.get(ID), {
    where: "claude-app",
    pid: 201,
    tty: null,
    exact: true,
    model: "claude-opus-5-5",
    effort: "xhigh",
    mode: "auto",
  });
  assert.deepEqual(
    [live.get(fresh).model, live.get(fresh).effort, live.get(fresh).mode],
    [null, null, null],
  );
  assert.equal(live.get(fresh)?.pid, 300, "first entry 1 s after the process started");
  assert.ok(!live.has("44444444-4444-4444-8444-444444444444"), "started too long after any process");
  assert.equal(live.size, 2);
});

test("Codex threads and items normalize; approvals read as waiting", () => {
  const s = codexSession({ id: ID, name: null, preview: "Fix login\nmore", cwd: "/w", originator: "Codex Desktop", updatedAt: 10, createdAt: 5, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  assert.equal(s.title, "Fix login");
  assert.equal(s.origin, "app");
  assert.equal(s.status, "waiting");
  assert.equal(s.updatedAt, 10000);
  assert.equal(codexSession({ id: ID, status: { type: "active", activeFlags: [] } }).status, "running");
  assert.equal(codexSession({ id: ID, status: { type: "notLoaded" } }).status, "idle");
  assert.equal(codexItem({ item: { type: "reasoning", id: "r" } }), null);
  assert.deepEqual(
    codexItem({ item: { type: "commandExecution", id: "c", command: "npm test", aggregatedOutput: "x", exitCode: 1, status: "completed" } }),
    { id: "c", role: "tool", kind: "command", text: "npm test", detail: "x", status: "failed", at: undefined, turnId: undefined },
  );
  assert.equal(codexItem({ item: { type: "userMessage", id: "u", content: [{ type: "text", text: "hi" }] } }).text, "hi");
  assert.equal(codexItem({ item: { type: "fileChange", id: "f", changes: [{ path: "a.ts", diff: "+1" }], status: "completed" } }).text, "a.ts");
});

test("Codex async questions survive history reads, including question-only messages", () => {
  const questions = [{ title: "Which target?", options: ["Mac", "Phone"] }, { title: "Anything else?", options: null }];
  const item = codexItem({ item: { type: "agentMessage", id: "async-question", text: "", questions, delivery: "async" }, turnId: "t1" });
  assert.equal(item.role, "assistant");
  assert.equal(item.text, "");
  assert.deepEqual(item.questions, [{ title: "Which target?", options: ["Mac", "Phone"] }, { title: "Anything else?", options: [] }]);
  assert.equal(item.turnId, "t1");
  assert.equal(codexItem({ item: { type: "agentMessage", id: "empty", text: "", questions: [] } }), null);
});

test("native links open the right app, only for valid ids", () => {
  assert.equal(nativeLink({ agent: "codex", id: ID }), `codex://threads/${ID}`);
  assert.equal(nativeLink({ agent: "claude", id: ID, appSessionId: `local_${ID}` }), `claude://code/continue?session=local_${ID}`);
  assert.equal(nativeLink({ agent: "claude", id: ID }), `claude://resume?session=${ID}`);
  assert.equal(nativeLink({ agent: "claude", id: "x&y" }), null);
  assert.equal(nativeLink({ agent: "codex", id: "../x" }), null);
});

test("the merged list sorts, marks live sessions and survives one agent failing", async () => {
  const sessions = createAgentSessions({
    codex: { list: async () => { throw new Error("daemon down"); }, health: async () => ({ agent: "codex", signedIn: true }) },
    claude: {
      list: async () => [
        { agent: "claude", id: "a", updatedAt: 1 },
        { agent: "claude", id: "b", updatedAt: 2 },
      ],
      starts: async () => [],
      health: async () => ({ agent: "claude", signedIn: false }),
    },
    live: async () => new Map([["a", { where: "terminal", pid: 9 }]]),
    detect: async () => [{ agent: "gemini", name: "Gemini CLI", installed: true, signedIn: false, supported: false }],
  });
  const { sessions: list, errors } = await sessions.list();
  assert.deepEqual(list.map((s) => s.id), ["b", "a"]);
  assert.equal(list[1].live.where, "terminal");
  assert.equal(errors.codex, "daemon down");
  // The two Reach drives, then the others found on the Mac.
  assert.deepEqual(
    (await sessions.health()).map((h) => [h.agent, h.name, h.supported]),
    [
      ["codex", "Codex", true],
      ["claude", "Claude Code", true],
      ["gemini", "Gemini CLI", false],
    ],
  );
});

test("session routes are owner-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-sessions-"));
  const opened = [];
  const resets = [];
  const settings = [];
  const answers = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [{ agent: "codex", id: ID }], errors: {} }),
      health: async () => [{ agent: "codex", signedIn: true }],
      read: async (agent, id) => ({ session: { agent, id }, items: [], before: null }),
      openInApp: async (agent, id) => (opened.push([agent, id]), { opened: agent }),
      resetUsage: async (agent) => (resets.push(agent), { outcome: "reset" }),
      image: async () => ({ type: "image/png", data: Buffer.from("png-bytes") }),
      openMacSetting: async (id) => (settings.push(id), { opened: "Accessibility", app: "claude" }),
      pressMacPrompt: async (id, button) => (answers.push([id, button]), { pressed: button }),
      typeMacPassword: async (id, password) => (answers.push([id, password]), { done: true }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  // Any credential that isn't one of the owner's own devices, whatever it
  // grants (admin included): another kind, or one added later.
  const other = reach.auth.issue("linked", ALL_SCOPES, "linked-mac");
  const call = (route, token, method = "GET") =>
    fetch(url + route, { method, headers: { Authorization: `Bearer ${token || ""}` } });
  try {
    assert.equal((await call("/api/sessions")).status, 401);
    assert.equal((await call("/api/sessions", agent.token)).status, 403);
    assert.equal((await call("/api/SESSIONS", agent.token)).status, 403);
    assert.equal((await call("/api/sessions", other.token)).status, 403);
    assert.equal((await call(`/api/sessions/codex/${ID}`, other.token)).status, 403);
    assert.equal((await call("/api/clients", other.token)).status, 200);
    const list = await call("/api/sessions", owner.token);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).sessions[0].id, ID);
    assert.equal((await call("/api/sessions/health", owner.token)).status, 200);
    assert.equal((await call(`/api/sessions/codex/${ID}`, owner.token)).status, 200);
    assert.equal((await call(`/api/sessions/codex/${ID}/open`, agent.token, "POST")).status, 403);
    assert.equal((await call(`/api/sessions/codex/${ID}/open`, owner.token, "POST")).status, 200);
    assert.deepEqual(opened, [["codex", ID]]);
    // A Mac prompt's System Settings page, opened on the Mac: the owner only.
    assert.equal((await call(`/api/sessions/mac-prompts/7/setting`, agent.token, "POST")).status, 403);
    const setting = await call(`/api/sessions/mac-prompts/7/setting`, owner.token, "POST");
    assert.equal(setting.status, 200);
    assert.deepEqual(await setting.json(), { opened: "Accessibility", app: "claude" });
    assert.deepEqual(settings, ["7"]);
    // A Mac dialog answered: its own button, or its password; never an agent.
    const answer = (route, token, body) =>
      fetch(`${url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await answer("/api/sessions/mac-prompts/7/press", agent.token, { button: "Allow" })).status, 403);
    assert.equal((await answer("/api/sessions/mac-prompts/7/password", agent.token, { password: "pw" })).status, 403);
    assert.equal((await answer("/api/sessions/mac-prompts/7/press", other.token, { button: "Allow" })).status, 403);
    assert.equal((await answer("/api/sessions/mac-prompts/7/password", other.token, { password: "pw" })).status, 403);
    assert.equal((await call(`/api/sessions/mac-prompts/7/setting`, other.token, "POST")).status, 403);
    assert.deepEqual(answers, []);
    assert.deepEqual(settings, ["7"]);
    assert.deepEqual(await (await answer("/api/sessions/mac-prompts/7/press", owner.token, { button: "Allow" })).json(), { pressed: "Allow" });
    assert.deepEqual(await (await answer("/api/sessions/mac-prompts/7/password", owner.token, { password: "s3cret-pw" })).json(), { done: true });
    assert.deepEqual(answers, [["7", "Allow"], ["7", "s3cret-pw"]]);
    // The password never reaches Reach's activity list.
    const activity = await (await call("/api/activity", owner.token)).json();
    assert.ok(!JSON.stringify(activity).includes("s3cret-pw"));
    // A picture from a session: the owner only, as the picture it is.
    assert.equal((await call(`/api/sessions/claude/${ID}/images/u1/0`, agent.token)).status, 403);
    const picture = await call(`/api/sessions/claude/${ID}/images/u1/0`, owner.token);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), "image/png");
    assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await picture.arrayBuffer()).toString(), "png-bytes");
    // Spending a rate-limit reset: the owner only.
    const reset = (token) =>
      fetch(`${url}/api/sessions/usage/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "codex" }),
      });
    assert.equal((await reset(agent.token)).status, 403);
    assert.deepEqual(resets, []);
    const spent = await reset(owner.token);
    assert.equal(spent.status, 200);
    assert.deepEqual(await spent.json(), { outcome: "reset" });
    assert.deepEqual(resets, ["codex"]);
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude Code's own registry says which process holds a session and whether it's busy", async () => {
  const { readSessionRegistry } = await import("../server/agent-sessions/processes.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-registry-"));
  const write = (pid, record) => fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...record }));
  try {
    await write(11, { sessionId: "app-busy", entrypoint: "claude-desktop", kind: "interactive", status: "busy", hostSessionId: "local_1" });
    await write(12, { sessionId: "app-idle", entrypoint: "claude-desktop", kind: "interactive", status: "idle" });
    await write(13, { sessionId: "term", entrypoint: "cli", kind: "interactive", status: "idle" });
    await write(14, { sessionId: "gone", entrypoint: "cli", kind: "interactive", status: "idle" });
    await write(16, { sessionId: "app-asking", entrypoint: "claude-desktop", kind: "interactive", status: "waiting", waitingFor: "input needed" });
    await write(17, { sessionId: "term-allow", entrypoint: "cli", kind: "interactive", status: "waiting", waitingFor: "permission prompt" });
    await fs.writeFile(path.join(dir, "15.json"), "{ half written");
    await fs.writeFile(path.join(dir, "11.abc.key"), "secret");
    const found = readSessionRegistry({ dir, alive: (pid) => pid !== 14 });
    assert.deepEqual(Object.fromEntries(found), {
      "app-busy": { where: "claude-app", pid: 11, tty: null, exact: true, busy: true, waiting: null, appSessionId: "local_1" },
      "app-idle": { where: "claude-app", pid: 12, tty: null, exact: true, busy: false, waiting: null },
      term: { where: "terminal", pid: 13, tty: null, exact: true, busy: false, waiting: null },
      // Stopped on the person: a question, or a permission to allow.
      "app-asking": { where: "claude-app", pid: 16, tty: null, exact: true, busy: false, waiting: "input needed" },
      "term-allow": { where: "terminal", pid: 17, tty: null, exact: true, busy: false, waiting: "permission prompt" },
    });
    assert.deepEqual([...readSessionRegistry({ dir: path.join(dir, "missing") })], []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// "It says working even though it's not": a session's record outlived its
// process, and the system gave that pid to another app (Voice Memos), so the
// record read as a busy chat. A record counts only while its start time is
// still that process's.
test("a registry record whose pid now belongs to another process is ignored", async () => {
  const { readSessionRegistry, processStarts } = await import("../server/agent-sessions/processes.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-registry-"));
  const write = (pid, record) => fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...record }));
  try {
    const app = { entrypoint: "claude-desktop", kind: "interactive" };
    // Read after the live one (file order), as on the Mac where it showed.
    await write(2402, { ...app, sessionId: "redesign", status: "busy", updatedAt: 2, procStart: "Tue Oct  6 14:20:34 2026" });
    await write(1451, { ...app, sessionId: "redesign", status: "idle", updatedAt: 1, procStart: "Tue Oct  6 16:41:40 2026" });
    await write(1509, { ...app, sessionId: "other", status: "busy", procStart: "Tue Oct  6 16:41:56 2026" });
    await write(1600, { ...app, sessionId: "undated", status: "busy" });
    const starts = new Map([
      [2402, "Tue Oct 6 09:41:26 2026"], // Voice Memos now
      [1451, "Tue Oct 6 16:41:40 2026"],
      [1509, "Tue Oct 6 16:41:56 2026"],
    ]);
    const found = readSessionRegistry({ dir, alive: () => true, started: () => starts });
    assert.equal(found.get("redesign").pid, 1451);
    assert.equal(found.get("redesign").busy, false);
    assert.equal(found.get("other").busy, true);
    assert.equal(found.get("undated").busy, true, "an older Claude Code without start times");
    // ps unavailable: nothing is hidden.
    assert.equal(readSessionRegistry({ dir, alive: () => true, started: () => null }).get("redesign").pid, 2402);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("process start lookup uses the Unix contract and leaves Windows registry records visible", async () => {
  const { processStarts } = await import("../server/agent-sessions/processes.mjs");
  const starts = processStarts([1451, 1509], { platform: "linux", run: (command, args, options) => {
    assert.equal(command, "ps");
    assert.deepEqual(args, ["-o", "pid=,lstart=", "-p", "1451,1509"]);
    assert.equal(options.env.TZ, "UTC");
    assert.equal(options.env.LC_ALL, "C");
    return " 1451 Tue Oct  6 16:41:40 2026\n 1509 Tue Oct  6 16:41:56 2026\n";
  } });
  assert.deepEqual([...starts], [[1451, "Tue Oct 6 16:41:40 2026"], [1509, "Tue Oct 6 16:41:56 2026"]]);
  assert.equal(processStarts([1451], { platform: "win32", run: () => assert.fail("Windows must not invoke an unrelated ps") }), null);
  assert.equal(processStarts([1451], { platform: "linux", run: () => { throw Object.assign(Error("unavailable"), { code: "ENOENT" }); } }), null);
  assert.deepEqual([...processStarts([1451], { platform: "linux", run: () => { throw Object.assign(Error("none running"), { status: 1 }); } })], []);
  // The actual host lookup is asserted separately from the portable parser.
  const native = processStarts([process.pid], { now: 1 });
  if (process.platform === "win32") assert.equal(native, null);
  else assert.match(native?.get(process.pid), /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
});

test("a question Claude waits on is read from the transcript, with its choices, until it's answered", () => {
  const base = { sessionId: ID, cwd: "/work/app", entrypoint: "claude-desktop" };
  const ask = {
    type: "tool_use",
    id: "q1",
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which database?",
          header: "Database",
          multiSelect: false,
          options: [
            { label: "Postgres (Recommended)", description: "What the app already uses" },
            { label: "SQLite", description: "One file" },
          ],
        },
      ],
    },
  };
  const lines = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { content: "Set up storage" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [ask] } }),
  ];
  const waiting = parseClaudeTranscript(lines.join("\n")).items.at(-1);
  assert.equal(waiting.status, "running");
  assert.equal(waiting.text, "Which database?");
  assert.deepEqual(waiting.questions, [
    {
      question: "Which database?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "Postgres (Recommended)", description: "What the app already uses" },
        { label: "SQLite", description: "One file" },
      ],
    },
  ]);
  lines.push(
    line({ ...base, type: "user", uuid: "r1", parentUuid: "a1", timestamp: at(3), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "Postgres" }] } }),
  );
  const answered = parseClaudeTranscript(lines.join("\n")).items.at(-1);
  assert.equal(answered.status, "completed");
  assert.equal(answered.questions, undefined);
});

test("the Claude app's own consent card (using apps, a folder) is read from its waiting call, and the session's entry carries it", async () => {
  const base = { sessionId: ID, cwd: "/work/app", entrypoint: "claude-desktop" };
  const call = (name, input) => [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { content: "Check the calculator" } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "tool_use", id: "c1", name, input }] } }),
  ];
  const last = (lines) => parseClaudeTranscript(lines.join("\n")).items.at(-1);
  const access = call("mcp__computer-use__request_access", { apps: ["Calculator", "Notes"], reason: "Add up the receipts." });
  // Worded as the app's own card.
  assert.deepEqual(last(access).consent, {
    kind: "apps",
    title: "Allow Claude to use Calculator and Notes?",
    reason: "Add up the receipts.",
    apps: ["Calculator", "Notes"],
    options: ["Deny", "Allow for this session"],
    // Names the request when the phone answers it.
    id: "consent:c1",
  });
  assert.equal(last(access).text, "Allow Claude to use Calculator and Notes?");
  assert.equal(last(call("mcp__computer-use__request_full_control", {})).consent.title, "Allow Claude to take over the screen?");
  // Only the card Reach knows word for word (using apps) is answered from the phone.
  assert.equal(last(call("mcp__computer-use__request_full_control", {})).consent.id, undefined);
  assert.equal(last(call("mcp__computer-use__request_teach_access", { apps: ["Notes"], reason: "" })).consent.title, "Allow Claude to guide you through Notes?");
  assert.equal(last(call("mcp__ccd_directory__request_directory", { path: "/work/docs" })).consent.title, "Allow Claude to access /work/docs?");
  assert.equal(last(call("mcp__ccd_directory__request_directory", {})).consent.title, "Claude wants you to pick a folder");
  // Other tools, even long ones, aren't consent cards.
  assert.equal(last(call("Bash", { command: "sleep 600" })).consent, undefined);
  assert.equal(last(call("mcp__computer-use__screenshot", {})).consent, undefined);
  // Answered: no longer waiting.
  const answered = [
    ...access,
    line({ ...base, type: "user", uuid: "r1", parentUuid: "a1", timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "granted" }] } }),
  ];
  assert.equal(last(answered).consent, undefined);
  assert.equal(last(answered).status, "completed");

  // The list entry carries it while it waits.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  const projects = path.join(root, "projects", "-work-app");
  await fs.mkdir(projects, { recursive: true });
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), access.join("\n"));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  assert.equal((await claude.list())[0].consent.title, "Allow Claude to use Calculator and Notes?");
  assert.equal((await claude.read(ID)).session.consent.kind, "apps");
  await fs.writeFile(path.join(projects, `${ID}.jsonl`), answered.join("\n"));
  assert.equal((await claude.list())[0].consent, undefined);
  await fs.rm(root, { recursive: true, force: true });
});
