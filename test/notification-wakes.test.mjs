import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";

// "Make everything evented" (2026-10-06): notifications look when told, with
// a 30 s safety look. An OpenClaw approval tells them too; it used to wait
// for their look every 5 s.
const until = async (check, ms = 2000) => {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) return false;
  return true;
};

test("an OpenClaw approval makes notifications look at once, not on their next beat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-claw-wake-"));
  let tell = () => {};
  let looks = 0;
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    openClaw: {
      onApprovalsChange: (listener) => ((tell = listener), () => {}),
      overview: async () => (looks++, { connected: true, sessions: [], approvals: [], revision: 0 }),
      close() {},
    },
    agentSessions: {
      list: async () => ({ sessions: [], errors: {}, projects: { codex: [] }, macPrompts: [] }),
      listRevision: () => 0,
      onListChange: () => () => {},
    },
    // A phone has push on (notifications look only then).
    notifications: { wakeMs: 10, enabled: () => true },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  try {
    assert.ok(await until(() => looks >= 1), "looked when Reach started");
    const before = looks;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(looks, before, "no look on a beat");
    // OpenClaw's Gateway asks to run a command.
    tell();
    assert.ok(await until(() => looks > before, 1000), "looked when told");
  } finally {
    await reach.close?.();
    reach.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
