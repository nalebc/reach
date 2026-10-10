import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const POINT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const gate = () => {
  let release, enter;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
};

async function fixture(t, { pause = null, phase = null, point = POINT } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-rewind-auth-"));
  const calls = { read: 0, point: 0, files: 0, conversation: 0 };
  const stopAt = async value => { if (value === phase) await pause.wait(); };
  const sessions = createAgentSessions({
    dataDir: root, daemon: { close() {} }, codex: {}, codexLive: {}, gemini: {}, signIn: {}, logos: {}, macPrompts: {},
    connectors: { close() {} }, claudeImports: { close() {} }, claudeRefresh: { close() {} }, agentWatch: null,
    live: async () => { await stopAt("holder"); return new Map(); },
    claude: {
      starts: async () => [],
      async read() { calls.read++; await stopAt("read"); return { session: { cwd: root }, items: [] }; },
      async rewindPoint() { calls.point++; await stopAt("point"); return point; },
    },
    claudeHost: {
      drives: () => false,
      async rewindFiles(_id, options) {
        // The coordinator must pass a current trusted authorization callback.
        options.authorize?.();
        calls.files++; await stopAt("files");
        return { canRewind: true, files: ["synthetic.txt"] };
      },
      rewindConversation() { calls.conversation++; }, close() {},
    },
  });
  const reach = await createReach({ roots: [root], dataDir: path.join(root, ".reach"), agentSessions: sessions,
    screen: false, agentDesktop: null });
  t.after(async () => {
    pause?.release(); reach.server.closeAllConnections?.(); await reach.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const owner = reach.auth.issue("Fixture owner", ALL_SCOPES, "device");
  const call = async (body, token = owner.token) => {
    const response = await fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/claude/${ID}/rewind`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: ID, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { reach, owner, call, calls };
}

for (const phase of ["holder", "read", "point"]) {
  test(`rewind revocation during ${phase} preparation prevents file and conversation changes`, async t => {
    const pause = gate(), f = await fixture(t, { pause, phase });
    const result = f.call({ code: true, conversation: true });
    await pause.entered; f.reach.auth.revoke(f.owner.clientId); pause.release();
    assert.equal((await result).status, 401);
    assert.equal(f.calls.files, 0); assert.equal(f.calls.conversation, 0);
  });
}

test("dry-run preparation also rechecks revoked authority before contacting Claude", async t => {
  const pause = gate(), f = await fixture(t, { pause, phase: "read" });
  const result = f.call({ dryRun: true });
  await pause.entered; f.reach.auth.revoke(f.owner.clientId); pause.release();
  assert.equal((await result).status, 401); assert.equal(f.calls.files, 0);
});

// The first message has nothing before it: the preview says so, so the phone
// doesn't offer Restore conversation (it was refused only after the tap).
test("a preview of the chat's first message says its conversation can't go back", async t => {
  const first = await fixture(t, { point: null });
  const preview = await first.call({ dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.conversation, false);
  assert.equal(preview.body.canRewind, true);
  assert.equal((await first.call({ conversation: true })).status, 409);
  const later = await fixture(t);
  assert.equal((await later.call({ dryRun: true })).body.conversation, undefined);
});

test("revocation after an authorized file rewind prevents the subsequent conversation mutation", async t => {
  const pause = gate(), f = await fixture(t, { pause, phase: "files" });
  const result = f.call({ code: true, conversation: true });
  await pause.entered; f.reach.auth.revoke(f.owner.clientId); pause.release();
  assert.equal((await result).status, 401);
  assert.equal(f.calls.files, 1); assert.equal(f.calls.conversation, 0);
});

test("paired owner rewind works while delegated and non-admin credentials never enter preparation", async t => {
  const f = await fixture(t);
  for (const credential of [
    f.reach.auth.redeemGuest(f.reach.auth.inviteGuest({ name: "Guest", ttlSeconds: 600, full: true }).invitation),
    f.reach.auth.issue("Agent", ["files:read"], "agent"),
    f.reach.auth.issue("Service", ALL_SCOPES, "service"),
    f.reach.auth.issue("Limited owner", ["device", "files:read"], "device"),
  ]) {
    const response = await f.call({ code: true }, credential.token);
    assert.equal(response.status, 403, JSON.stringify(response.body));
  }
  assert.equal((await f.call({ code: true }, "")).status, 401);
  assert.equal(f.calls.read, 0); assert.equal(f.calls.files, 0);
  assert.equal((await f.call({ code: true, conversation: true })).status, 200);
  assert.equal(f.calls.files, 1); assert.equal(f.calls.conversation, 1);
});

function fakeClaude({ phase, pause, calls }) {
  return (_file, _args, _options) => {
    calls.spawn++;
    const proc = new EventEmitter(); proc.exitCode = null;
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdin = { on() {}, end() { proc.exitCode = 0; proc.emit("exit", 0); }, write(text, callback) {
      const message = JSON.parse(text), subtype = message.request?.subtype;
      calls.messages.push(subtype);
      callback?.();
      void (async () => {
        if (phase === "initialize" && subtype === "initialize") await pause.wait();
        proc.stdout.emit("data", JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: message.request_id, response: { canRewind: true, filesChanged: [] },
        } }) + "\n");
      })();
    } };
    proc.kill = () => proc.stdin.end(); return proc;
  };
}

for (const phase of ["locate", "check", "initialize"]) {
  test(`Claude rewind stops before dispatch when authority is lost during ${phase}`, async t => {
    const pause = gate(), calls = { spawn: 0, messages: [] };
    let valid = true;
    const authorize = () => { if (!valid) throw Object.assign(new Error("Fixture access revoked"), { status: 401 }); };
    const h = createClaudeHost({
      env: {}, spawn: fakeClaude({ phase, pause, calls }),
      locate: async () => { if (phase === "locate") await pause.wait(); return "inert-claude"; },
      check: async () => { if (phase === "check") await pause.wait(); return { status: "available" }; },
    });
    t.after(() => { pause.release(); h.close(); });
    const result = assert.rejects(h.rewindFiles(ID, { messageId: ID, cwd: os.tmpdir(), authorize }), { status: 401 });
    await pause.entered; valid = false; pause.release(); await result;
    assert.equal(calls.spawn, phase === "initialize" ? 1 : 0);
    assert.equal(calls.messages.includes("rewind_files"), false);
    assert.equal(h.drives(ID), false);
    assert.equal(h.rewoundTo(ID), null);
    // Rejected preparation releases the per-session rewind lock.
    valid = true;
    assert.equal((await h.rewindFiles(ID, { messageId: ID, cwd: os.tmpdir(), authorize })).canRewind, true);
    assert.equal(calls.messages.filter(value => value === "rewind_files").length, 1);
  });
}
