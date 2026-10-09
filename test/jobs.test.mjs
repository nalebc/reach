import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jobs } from "../server/jobs.mjs";

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-jobs-"));
  const jobs = new Jobs({ dataDir: dir });
  t.after(() => {
    jobs.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return jobs;
};

test("a command that leaves something running in the background finishes when its shell does", { skip: process.platform === "win32" }, async (t) => {
  const jobs = fixture(t);
  const job = jobs.start({ command: "echo started; sleep 30 &", cwd: os.tmpdir(), timeoutMs: 20000 }, "agent");
  await until(() => job.status !== "running", 6000);
  assert.equal(job.status, "completed");
  assert.equal(job.exitCode, 0);
  assert.equal(job.output, "started\n");
  assert.equal(jobs.running.size, 0, "its slot is free for the next job");
});

test("a failing command that backgrounds a process reports its own exit code", { skip: process.platform === "win32" }, async (t) => {
  const jobs = fixture(t);
  const job = jobs.start({ command: "sleep 30 & exit 3", cwd: os.tmpdir(), timeoutMs: 20000 }, "agent");
  await until(() => job.status !== "running", 6000);
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 3);
});

test("a command still running at its deadline times out", { skip: process.platform === "win32" }, async (t) => {
  const jobs = fixture(t);
  const job = jobs.start({ command: "sleep 30", cwd: os.tmpdir(), timeoutMs: 1000 }, "agent");
  await until(() => job.status !== "running" && jobs.running.size === 0, 6000);
  assert.equal(job.status, "timed_out");
});
