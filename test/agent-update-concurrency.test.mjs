import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { readFeed } from "../server/agent-updates.mjs";
import { latestRelease } from "../server/reach-updates.mjs";

test("agent updates and installs share one lock, including while the update is being planned", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-update-race-"));
  let enter, release, hold = true;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const terminals = [];
  let pendingUpdate;
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, "private"),
    agentInstallPlan: async agent => ({ agent, name: "Codex", command: "fixture-install" }),
    agentUpdates: { plan: async agent => {
      if (hold) { enter(); await waiting; }
      return { agent, name: "Codex", command: "fixture-update", from: "1.0.0", to: "1.0.1" };
    } },
    terminals: {
      create: options => { const terminal = { ...options, id: String(terminals.length), status: "running" }; terminals.push(terminal); return terminal; },
      get: id => terminals.find(terminal => terminal.id === id), list: () => terminals, dispose() {},
    },
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { release(); await pendingUpdate?.catch(() => {}); reach.server.closeAllConnections(); await reach.close(); await fs.rm(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const post = route => fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/${route}/codex`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: '{"confirm":true}',
  });
  const first = pendingUpdate = post("agent-update");
  await entered;
  hold = false;
  assert.equal((await post("agent-update")).status, 409);
  assert.equal((await post("agent-install")).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(terminals.length, 1);
  assert.equal((await post("agent-update")).status, 409);
  terminals[0].status = "exited";
  assert.equal((await post("agent-update")).status, 200);
  assert.equal(terminals.length, 2);
});

for (const kind of ["agent", "reach"]) test(`${kind} update checks stop reading an oversized streamed feed`, async () => {
  let pulls = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (++pulls <= 20) controller.enqueue(new Uint8Array(100));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }));
  const fetch = async () => response;
  const answer = kind === "agent"
    ? await readFeed("fixture", text => text, { fetch, maxBytes: 32 })
    : await latestRelease({ fetch, maxBytes: 32 });
  assert.deepEqual(answer, kind === "agent" ? null : { state: "offline" });
  assert.equal(cancelled, true);
  assert.ok(pulls <= 2, "the size limit must stop the stream before it is buffered");
});
