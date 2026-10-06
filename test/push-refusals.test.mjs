import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPush } from "../server/push.mjs";

// Reach's log filled with "a notification was refused (HTTP 400)": no reason,
// and the same phone was tried again on every event. Apple says why in the
// body; a refusal over the topic is tried once without it; a phone refused
// three times in a row rests 15 minutes.
const subscription = () => {
  const phone = crypto.createECDH("prime256v1");
  phone.generateKeys();
  return { endpoint: "https://web.push.apple.com/QGuQ", keys: { p256dh: phone.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
};
const refusal = (reason) => ({ status: 400, ok: false, text: async () => JSON.stringify({ reason }) });
const setup = (answer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-push-refused-"));
  const calls = [];
  const logged = [];
  let clock = Date.now();
  const push = createPush({
    dataDir: dir,
    subject: () => "https://mac.test",
    post: async (url, init) => (calls.push(init.headers.Topic ?? null), answer(init)),
    now: () => clock,
    log: (m) => logged.push(m),
  });
  push.subscribe("phone", subscription());
  return { push, calls, logged, later: (ms) => (clock += ms), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test("a refusal over the topic goes again without one, and the reason is in the log", async () => {
  const t = setup((init) => (init.headers.Topic ? refusal("BadWebPushTopic") : { status: 201, ok: true }));
  try {
    assert.deepEqual(await t.push.notify(["phone"], { title: "Hi", tag: "agent-admission-1" }), { sent: 1 });
    assert.deepEqual(t.calls, ["agent-admission-1", null]);
    assert.deepEqual(t.logged, []);
  } finally {
    t.done();
  }
});

test("a phone refused again and again: why, once, then 15 minutes of rest", async () => {
  const t = setup(() => refusal("BadJwtToken"));
  try {
    for (let i = 0; i < 6; i++) await t.push.notify(["phone"], { title: "Hi" });
    assert.equal(t.calls.length, 3, "rests after three refusals");
    assert.deepEqual(t.logged, [
      "a notification was refused (HTTP 400: BadJwtToken).",
      "notifications to one phone are paused for 15 minutes after 3 refusals (HTTP 400: BadJwtToken).",
    ]);
    t.later(16 * 60 * 1000);
    await t.push.notify(["phone"], { title: "Hi" });
    assert.equal(t.calls.length, 4, "tried again after the rest");
  } finally {
    t.done();
  }
});
