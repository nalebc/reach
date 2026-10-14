import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jobs, terminateWindowsJob } from "../server/jobs.mjs";

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
  t.after(async () => {
    await jobs.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return jobs;
};

test("Windows job retirement never terminates an exited process's reused PID", () => {
  const attempts = [];
  let released = 0;
  const stream = { destroy() { released++; } };
  terminateWindowsJob({ pid: process.pid, exitCode: 3, signalCode: null, stdin: stream, stdout: stream, stderr: stream }, (pid) => attempts.push(pid));
  assert.deepEqual(attempts, [], "an exited PID could now name an unrelated process");
  assert.equal(released, 3, "only the old job's owned output/input handles retire");
  terminateWindowsJob({ pid: 1234, exitCode: null, signalCode: null }, (pid) => attempts.push(pid));
  assert.deepEqual(attempts, [1234], "a live main process can still be terminated");
});

test("shutdown waits for live job processes and their output handles to close", { timeout: 30000 }, async (t) => {
  const jobs = fixture(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reach-job-shutdown-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const job = jobs.start({ command: process.platform === "win32" ? "Write-Output 'ready'; Start-Sleep -Seconds 30" : "echo ready; sleep 30", cwd, timeoutMs: 60000 }, "owner");
  await until(() => job.output.includes("ready"), 15000);
  const child = jobs.running.get(job.id);
  let closed = false;
  child.once("close", () => { closed = true; });
  await jobs.dispose();
  assert.equal(closed, true, "shutdown returns after native close, not just after requesting termination");
  assert.equal(jobs.children.size, 0);
  assert.equal(jobs.running.size, 0);
  fs.rmSync(cwd, { recursive: true });
});

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

// The same three on a real Windows PC (Windows PowerShell 5.1), and its
// output read back as written (parity audit #23).
const windows = { skip: process.platform !== "win32" };
test("Windows: a failing command that starts something in the background reports its own exit code", windows, async (t) => {
  const jobs = fixture(t);
  const job = jobs.start({ command: "Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 3", cwd: os.tmpdir(), timeoutMs: 20000 }, "agent");
  await until(() => job.status !== "running", 15000);
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 3);
});

test("Windows: a command still running at its deadline times out, and nothing of it is left", windows, async (t) => {
  const jobs = fixture(t);
  const job = jobs.start({ command: "ping.exe -n 60 127.0.0.1 | Out-Null", cwd: os.tmpdir(), timeoutMs: 2000 }, "agent");
  await until(() => job.status !== "running" && jobs.running.size === 0, 15000);
  assert.equal(job.status, "timed_out");
});

test("Windows: what a command prints comes back exactly, accents and symbols included", windows, async (t) => {
  const jobs = fixture(t);
  const job = jobs.start({ command: "Write-Output 'café ✓ 日本'", cwd: os.tmpdir(), timeoutMs: 20000 }, "agent");
  await until(() => job.status !== "running", 15000);
  assert.equal(job.status, "completed", job.output);
  assert.equal(job.output.trim(), "café ✓ 日本");
});
