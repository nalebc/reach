import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntimes } from "../server/agent-runtimes.mjs";

// Agents & people shows which runtime each command-line agent runs, against
// the one this computer serves.
const SERVED = "a".repeat(64), OLDER = "b".repeat(64);

test("current, updating, or one to update by hand; never guessed for a page", () => {
  let served = SERVED;
  const runtimes = createAgentRuntimes({ current: () => served });
  const agent = (id, extra = {}) => ({ id, kind: "agent", ...extra });
  runtimes.note(agent("a"), SERVED);
  runtimes.note(agent("b"), OLDER);
  runtimes.note(agent("c", { tailscale: { tagged: true } }), undefined);
  runtimes.note(agent("d", { rotatedAt: 1 }), "not-a-hash");
  runtimes.note(agent("e", { browserTransport: "funnel" }), undefined);
  assert.equal(runtimes.statusOf(agent("a")), "current");
  assert.equal(runtimes.statusOf(agent("b")), "updating", "it fetches the new one by itself");
  assert.equal(runtimes.statusOf(agent("c", { tailscale: { tagged: true } })), "one-time", "its own tailnet device: the command-line runtime");
  assert.equal(runtimes.statusOf(agent("d", { rotatedAt: 1 })), "one-time", "it trades credentials: the command-line runtime");
  assert.equal(runtimes.statusOf(agent("e", { browserTransport: "funnel" })), undefined, "could be a page: always current anyway");
  assert.equal(runtimes.statusOf(agent("never-seen")), undefined);
  // A hosted agent (claude.ai, ChatGPT) trades tokens but runs nothing of Reach's.
  runtimes.note(agent("h", { hosted: true, rotatedAt: 1 }), undefined);
  assert.equal(runtimes.statusOf(agent("h", { hosted: true, rotatedAt: 1 })), undefined);
  // The computer updating (no runtime advertised meanwhile): not "updating".
  served = undefined;
  assert.equal(runtimes.statusOf(agent("b")), "current");
  // Only agents are noted.
  runtimes.note({ id: "phone", kind: "device" }, SERVED);
  assert.equal(runtimes.statusOf({ id: "phone", kind: "device" }), undefined);
});
