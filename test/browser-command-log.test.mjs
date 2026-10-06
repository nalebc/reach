import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createBrowserCommandLog } from "../server/browser-command-log.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-command-log-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { temp, dir: path.join(temp, "log") };
}
const record = (id = "request-1", extra = {}) => ({ id, clientId: "agent-one", name: "Muse", reason: "Inspect notes", action: { type: "terminal", command: "pwd", root: 0, cwd: "" }, status: "pending", createdAt: 100, expiresAt: 10000, approval: "automatic", ...extra });

test("history is durable, private, credential-free, immutable and filtered by client", async (t) => {
  const { dir } = await fixture(t);
  let now = 200;
  let log = await createBrowserCommandLog({ dir, now: () => now++ });
  await log.append({ ...record(), token: "DO-NOT-STORE", browserBinding: "SECRET", headers: { Authorization: "Bearer SECRET" } });
  await log.append(record("request-1", { status: "executing" }));
  await log.append(record("request-1", { status: "executed", output: "\u001b[31mhello\u001b[0m\u202e", completedAt: 400 }));
  await log.append(record("request-2:0", { clientId: "agent-two", action: { type: "terminal-change", command: "touch note.txt", root: 0 }, status: "denied", approval: "owner", createdAt: 300 }));
  if (process.platform !== "win32") assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  const file = path.join(dir, "commands.jsonl");
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /DO-NOT-STORE|SECRET|Authorization|browserBinding|token/);
  assert.equal((await log.history({ clientId: "agent-one" })).length, 1);
  assert.equal((await log.history({ clientId: "agent-one" }))[0].output, "hello");
  assert.equal((await log.history())[0].id, "request-2:0");
  for (const extra of [{ clientId: "other" }, { action: { type: "terminal", command: "cat secret", root: 0 } }, { reason: "different" }, { status: "executing" }]) await assert.rejects(log.append(record("request-1", { status: "executed", ...extra })), /cannot/);
  await log.close();
  log = await createBrowserCommandLog({ dir });
  assert.equal((await log.history()).length, 2); assert.equal((await log.history({ clientId: "agent-one" }))[0].status, "executed");
  await log.close();
});

test("restart persists interrupted outcomes and never replays pending or executing commands", async (t) => {
  const { dir } = await fixture(t);
  let log = await createBrowserCommandLog({ dir });
  await log.append(record());
  await log.append(record("request-2", { status: "executing" }));
  await log.close();
  log = await createBrowserCommandLog({ dir });
  const history = await log.history();
  assert.ok(history.every((item) => item.status === "interrupted" && /restarted/.test(item.error)));
  assert.equal((await fs.readFile(path.join(dir, "commands.jsonl"), "utf8")).trim().split("\n").length, 4);
  await log.close();
});

test("capacity reserves final outcomes, rejects regressions, deduplicates polling and bounds output", async (t) => {
  const { dir } = await fixture(t);
  const log = await createBrowserCommandLog({ dir, maxEntries: 3, maxBytes: 512 * 1024 });
  await log.append(record());
  await assert.rejects(log.append(record("request-2")), /history is full/);
  const before = (await fs.stat(path.join(dir, "commands.jsonl"))).size;
  await log.append(record());
  assert.equal((await fs.stat(path.join(dir, "commands.jsonl"))).size, before);
  await log.append(record("request-1", { status: "executing" }));
  await assert.rejects(log.append(record()), /return to pending/);
  await log.append(record("request-1", { status: "executed", output: "界".repeat(100000) }));
  const latest = (await log.history())[0];
  assert.ok(Buffer.byteLength(latest.output) <= 65536);
  await log.append(latest);
  await assert.rejects(log.append(record("request-3", { status: "blocked" })), /history is full/);
  await log.close();
});

test("history fails closed on symlinks, unsafe modes, truncated records and unexpected changes", async (t) => {
  const { dir, temp } = await fixture(t);
  const actual = path.join(temp, "actual"); await fs.mkdir(actual, { mode: 0o700 });
  await fs.symlink(actual, dir);
  await assert.rejects(createBrowserCommandLog({ dir }), /private owned directory/);
  await fs.unlink(dir); await fs.mkdir(dir, { mode: 0o755 });
  // Windows uses ACLs, not POSIX permission bits. Link and tamper checks still run.
  if (process.platform !== "win32") await assert.rejects(createBrowserCommandLog({ dir }), /private owned directory/);
  await fs.chmod(dir, 0o700);
  const outside = path.join(temp, "outside"); await fs.writeFile(outside, "", { mode: 0o600 });
  await fs.symlink(outside, path.join(dir, "commands.jsonl"));
  await assert.rejects(createBrowserCommandLog({ dir }));
  await fs.unlink(path.join(dir, "commands.jsonl"));
  await fs.writeFile(path.join(dir, "commands.jsonl"), '{"unfinished":', { mode: 0o600 });
  await assert.rejects(createBrowserCommandLog({ dir }), /incomplete record/);
  await fs.writeFile(path.join(dir, "commands.jsonl"), "", { mode: 0o600 });
  const log = await createBrowserCommandLog({ dir });
  await fs.appendFile(path.join(dir, "commands.jsonl"), "outside edit\n");
  await assert.rejects(log.append(record()), /changed outside Reach/);
  await assert.rejects(log.append(record()), /unavailable/);
  await log.close();
});
