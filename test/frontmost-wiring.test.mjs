import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";

// The 5 s retry while you're in the Claude app (2026-10-06): Reach's menu bar
// helper says which app is in front and which opens, and Reach hands that to
// the chats, so a message waiting on the Claude app goes in at once.
const until = async (check, ms = 2000) => {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) return false;
  return true;
};

test("the app in front, as the menu bar's helper tells it, reaches the chats; so does its stopping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-front-wiring-"));
  let helper;
  const fronts = [];
  const launched = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    appPlatform: "darwin",
    menuBar: true,
    appDisplays: async ({ onEvent, onExit }) =>
      (helper = { stopped: false, onEvent, onExit, async request() { return {}; }, async stop() {} }),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {}, projects: { codex: [] }, macPrompts: [] }),
      listRevision: () => 0,
      onListChange: () => () => {},
      frontmost: (bundle) => fronts.push(bundle),
      launched: (bundle) => launched.push(bundle),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  try {
    assert.ok(await until(() => helper), "the menu bar's helper started");
    helper.onEvent({ event: "frontmost", bundle: "com.anthropic.claudefordesktop" });
    helper.onEvent({ event: "launched", bundle: "com.apple.Notes" });
    assert.deepEqual(fronts, ["com.anthropic.claudefordesktop"]);
    assert.deepEqual(launched, ["com.apple.Notes"]);
    // The helper stops: the chats stop trusting what it said.
    helper.onExit();
    assert.equal(fronts.at(-1), null);
  } finally {
    await reach.close?.();
    reach.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
