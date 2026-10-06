import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";

// The phone said "Claude Code isn't installed on this Mac" while it was: Reach
// had been started with a PATH without ~/.local/bin, and the check looked
// only there (Reach's own Claude runner already asked the login shell).
test("Claude Code found where the login shell finds it reads as installed, not missing", async () => {
  const ran = [];
  const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const run = async (file, args) => {
    ran.push(file);
    if (file === "claude") throw missing;
    if (args[0] === "auth") return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    return { stdout: "2.1.291 (Claude Code)" };
  };
  const health = await createClaudeSessions({ run, locateCli: async () => "/Users/me/.local/bin/claude", projects: "/nonexistent" }).health();
  assert.equal(health.installed, true);
  assert.deepEqual(ran.slice(0, 2), ["claude", "/Users/me/.local/bin/claude"]);
  // Not there either: not installed, as before.
  const none = await createClaudeSessions({ run: async () => { throw missing; }, locateCli: async () => null, projects: "/nonexistent" }).health();
  assert.deepEqual(none, { agent: "claude", installed: false, signedIn: false });
});
