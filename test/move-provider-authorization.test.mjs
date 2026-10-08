import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";

const THREAD = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const deferred = () => {
  let resolve;
  return {
    promise: new Promise((r) => {
      resolve = r;
    }),
    resolve: (...args) => resolve(...args),
  };
};
const authority = () => {
  let revoked = false;
  return {
    revoke() {
      revoked = true;
    },
    authorize() {
      if (revoked) throw Object.assign(Error("Revoked"), { status: 401 });
    },
  };
};
const owner = {
  hasFollowers: () => false,
  update() {},
  reset() {},
  close() {},
  claim: async () => {},
};
function daemon(rpc) {
  return { rpc, onClose() {}, onNotification() {}, onRequest() {}, close() {} };
}

test("Codex move rechecks after model discovery and sends no fork after revocation", async (t) => {
  const ready = deferred(),
    release = deferred(),
    auth = authority(),
    calls = [];
  const live = createCodexLive({
    ownerFactory: () => owner,
    daemon: daemon(async (method, params) => {
      calls.push([method, params]);
      if (method === "model/list") {
        ready.resolve();
        await release.promise;
        return { data: [] };
      }
      return { thread: { id: THREAD } };
    }),
  });
  t.after(async () => {
    live.close();
    const file = calls.find(([method]) => method === "thread/fork")?.[1].path;
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true });
  });
  const work = live.forkHistory({
    cwd: os.tmpdir(),
    name: "Synthetic",
    items: [],
    from: "OpenClaw",
    authorize: auth.authorize,
  });
  await ready.promise;
  auth.revoke();
  release.resolve();
  await assert.rejects(work, { status: 401 });
  assert.deepEqual(
    calls.map(([method]) => method),
    ["model/list"],
  );
});

test("Codex move revoked during ownership claim does not rename and releases only its known fork", async (t) => {
  const ready = deferred(),
    release = deferred(),
    auth = authority(),
    calls = [];
  const live = createCodexLive({
    ownerFactory: () => ({
      ...owner,
      async claim() {
        ready.resolve();
        await release.promise;
      },
    }),
    daemon: daemon(async (method, params) => {
      calls.push([method, params]);
      return { thread: { id: THREAD } };
    }),
  });
  t.after(async () => {
    live.close();
    const file = calls.find(([method]) => method === "thread/fork")?.[1].path;
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true });
  });
  const work = live.forkHistory({
    cwd: os.tmpdir(),
    name: "Synthetic",
    model: "test-model",
    items: [],
    from: "OpenClaw",
    authorize: auth.authorize,
  });
  await ready.promise;
  auth.revoke();
  release.resolve();
  await assert.rejects(work, { status: 401 });
  assert.deepEqual(
    calls.map(([method]) => method),
    ["thread/fork", "thread/unsubscribe"],
  );
  const file = calls[0][1].path;
  assert.ok(
    (await fs.stat(file)).isFile(),
    "a dispatched fork retains its recovery archive",
  );
  assert.deepEqual(calls[1][1], { threadId: THREAD });
});

test("Claude move rechecks after version discovery and writes no transcript after revocation", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "reach-claude-move-auth-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ready = deferred(),
    release = deferred(),
    auth = authority();
  const projects = path.join(root, "projects");
  const claude = createClaudeSessions({
    projects,
    appRecords: path.join(root, "records"),
    run: async () => {
      ready.resolve();
      await release.promise;
      return { stdout: "2.1.289" };
    },
  });
  const work = claude.write({
    cwd: root,
    title: "Synthetic",
    items: [],
    from: "OpenClaw",
    authorize: auth.authorize,
  });
  await ready.promise;
  auth.revoke();
  release.resolve();
  await assert.rejects(work, { status: 401 });
  const files = await fs.readdir(projects, { recursive: true });
  assert.ok(!files.some((file) => file.endsWith(".jsonl")));
});
