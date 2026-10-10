import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// The owner's pause of one agent outlives a restart (reliability audit, Oct
// 10: it lived only in memory, so a crash or restart resumed the agent).
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-pauses-"));
const agent = (id) => {
  const policy = { invite: true, browser: true, preset: "full", roots: ["/Users/me"] };
  return { id, kind: "agent", name: id, expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
};
const desktop = (file, clients) =>
  createAgentDesktop({ screen: true }, {
    available: () => true, home: "/Users/me", verifyClient: (id) => clients.get(id), pausesFile: file,
    spawnHelper: async () => ({ async send() { return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }; }, stop() {} }),
  });

test("a paused agent is still paused after Reach starts again", async () => {
  const file = path.join(dir(), "agent-pauses.json");
  const clients = new Map([["muse", agent("muse")], ["grok", agent("grok")]]);
  const first = desktop(file, clients);
  assert.equal(first.setPaused("muse", true), true);
  first.close();
  const second = desktop(file, clients);
  assert.equal(second.isPaused("muse"), true);
  assert.equal(second.isPaused("grok"), false);
  await assert.rejects(() => second.act(clients.get("muse"), { type: "click", x: 0.5, y: 0.5 }, () => clients.get("muse")), (e) => e.status === 409 && e.kind === "paused");
  assert.equal(second.setPaused("muse", false), false);
  assert.equal(desktop(file, clients).isPaused("muse"), false);
});

test("ending a session's work (Reopen, an access change) never resumes it", () => {
  const file = path.join(dir(), "agent-pauses.json");
  const clients = new Map([["muse", agent("muse")]]);
  const d = desktop(file, clients);
  d.setPaused("muse", true);
  d.cancelClient("muse");
  assert.equal(d.isPaused("muse"), true);
  assert.equal(desktop(file, clients).isPaused("muse"), true);
});

test("pauses of agents whose access ended are forgotten", () => {
  const file = path.join(dir(), "agent-pauses.json");
  const clients = new Map([["muse", agent("muse")], ["grok", agent("grok")]]);
  const d = desktop(file, clients);
  d.setPaused("muse", true);
  d.setPaused("grok", true);
  assert.deepEqual(d.forgetPauses((id) => id === "grok"), ["muse"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).paused, ["grok"]);
});

test("saved pauses that can't be read say so: never read as nobody paused", () => {
  const folder = dir();
  const file = path.join(folder, "agent-pauses.json");
  fs.writeFileSync(file, "{ torn");
  const pauses = createAgentPauses({ file });
  assert.equal(pauses.unreadable, true);
  assert.equal(pauses.has("muse"), false);
  // Pausing everyone (what Reach does then) writes a readable file again.
  assert.deepEqual(pauses.add(["muse", "grok"]), ["muse", "grok"]);
  assert.equal(pauses.unreadable, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).paused, ["muse", "grok"]);
  // No file yet is a first run, not unreadable.
  assert.equal(createAgentPauses({ file: path.join(folder, "none.json") }).unreadable, false);
});

test("a pause that can't be saved still holds now, and says a restart would end it", () => {
  const folder = dir();
  const file = path.join(folder, "agent-pauses.json");
  fs.mkdirSync(file); // a folder where the file goes: every write fails
  const pauses = createAgentPauses({ file });
  assert.throws(() => pauses.set("muse", true), (e) => e.status === 507 && /restart would end it/.test(e.message));
  assert.equal(pauses.has("muse"), true);
  // Resuming can't be saved either: it holds, and a restart would pause again.
  assert.equal(pauses.set("muse", false), false);
});
