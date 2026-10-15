import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageWatch, usageBack } from "../server/agent-sessions/usage-watch.mjs";

const out = { agent: "claude", signedIn: true, usable: false, resetsAt: 5000, usage: { available: true, windows: [{ usedPercent: 100, resetsAt: 5000 }] } };
const back = { agent: "claude", signedIn: true, usable: true, usage: { available: true, windows: [{ usedPercent: 3, resetsAt: 9000 }] } };

test("an in-flight notification cannot consume a newly requested watch", async () => {
  let finish;
  const watch = createUsageWatch({
    health: async () => [back],
    notify: () => new Promise((resolve) => { finish = resolve; }),
    setTimer: () => null,
    clearTimer() {},
  });
  watch.add("claude", { session: "old" });
  const pending = watch.look();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  watch.remove("claude");
  watch.add("claude", { session: "new" });
  finish({ sent: 1 });
  await pending;
  assert.equal(watch.has("claude"), true);
  watch.stop();
});

test("stopping while health is loading prevents notification dispatch", async () => {
  let finish;
  let sent = 0;
  const watch = createUsageWatch({
    health: () => new Promise((resolve) => { finish = resolve; }),
    notify: async () => { sent++; return { sent: 1 }; },
    setTimer: () => null,
    clearTimer() {},
  });
  watch.add("claude");
  const pending = watch.look();
  watch.stop();
  finish([back]);
  await pending;
  assert.equal(sent, 0);
  assert.equal(watch.has("claude"), true);
});

const harness = ({ file = null, reply = [out], sent = 1 } = {}) => {
  const sentMessages = [];
  let time = 1000, list = reply, fail = false;
  const watch = createUsageWatch({
    file,
    now: () => time,
    health: async () => { if (fail) throw Error("no"); return list; },
    notify: async (m) => { sentMessages.push(m); return { sent }; },
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { watch, sentMessages, setList: (v) => { list = v; }, setFail: (v) => { fail = v; }, setTime: (v) => { time = v; } };
};

test("back is the agent's own fresh word, never an old or failed reading", () => {
  assert.equal(usageBack(back), true);
  assert.equal(usageBack(out), false);
  assert.equal(usageBack({ ...back, usable: undefined }), false);
  assert.equal(usageBack({ ...back, signedIn: false }), false);
  assert.equal(usageBack({ ...back, usage: { available: true, windows: [{ usedPercent: 100 }] } }), false);
  // Meters that failed: `usable` is only its default then. Back once the
  // limit's reset time has passed, never before.
  // (Claude's health leaves `usable` unknown then, never true.)
  const failed = { ...back, usable: undefined, usage: { available: false, windows: [{ usedPercent: 100 }] } };
  assert.equal(usageBack(failed), false);
  assert.equal(usageBack(failed, { resetsAt: 5000, now: 4000 }), false);
  assert.equal(usageBack(failed, { resetsAt: 5000, now: 6000 }), true);
  assert.equal(usageBack({ ...failed, usable: false }, { resetsAt: 5000, now: 6000 }), false, "the agent's own no stays no");
  assert.equal(usageBack(undefined), false);
});

test("one notification when the limit is back, opening the chat", async () => {
  const h = harness();
  h.watch.add("claude", { session: "s1", resetsAt: 5000 });
  await h.watch.look();
  assert.equal(h.sentMessages.length, 0);
  h.setFail(true);
  await h.watch.look();
  assert.equal(h.sentMessages.length, 0, "a failed read is not back");
  h.setFail(false);
  h.setList([back]);
  await h.watch.look();
  assert.equal(h.sentMessages.length, 1);
  assert.equal(h.sentMessages[0].title, "Claude Code is back");
  assert.match(h.sentMessages[0].url, /page=sessions&agent=claude&id=s1/);
  assert.equal(h.watch.has("claude"), false);
  await h.watch.look();
  assert.equal(h.sentMessages.length, 1, "sent once");
});

test("Claude's sign-in lapsed while nobody used it: back at its reset time, not when you open it", async () => {
  // What claude.mjs says once its limit has passed and its meters can't be
  // read (the token renews only while Claude Code runs): usable unknown, the
  // last meters kept and marked unavailable, no reset of its own.
  const lapsed = { agent: "claude", signedIn: true, usable: undefined,
    usage: { available: false, windows: [{ usedPercent: 100, resetsAt: 5000 }], error: "Claude’s sign-in renews the next time Claude Code runs." } };
  const h = harness({ reply: [lapsed] });
  h.watch.add("claude", { session: "s1", resetsAt: 5000 });
  await h.watch.look();
  assert.equal(h.sentMessages.length, 0, "not before its reset");
  h.setTime(5000 + 30000);
  await h.watch.look();
  assert.equal(h.sentMessages.length, 1);
  assert.equal(h.sentMessages[0].title, "Claude Code is back");
});

test("kept until a phone gets it, and across restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-watch-"));
  const file = path.join(dir, "usage-watch.json");
  const first = harness({ file, sent: 0 });
  first.watch.add("codex");
  first.setList([{ ...back, agent: "codex" }]);
  await first.watch.look();
  assert.equal(first.watch.has("codex"), true, "nothing reached a phone");
  const second = harness({ file, reply: [{ ...back, agent: "codex" }] });
  assert.equal(second.watch.has("codex"), true);
  await second.watch.look();
  assert.equal(second.sentMessages.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cancelled or a week old, nothing is sent", async () => {
  const h = harness({ reply: [back] });
  h.watch.add("claude");
  h.watch.remove("claude");
  await h.watch.look();
  h.watch.add("claude");
  h.setTime(1000 + 9 * 24 * 3600 * 1000);
  await h.watch.look();
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.watch.has("claude"), false);
});
