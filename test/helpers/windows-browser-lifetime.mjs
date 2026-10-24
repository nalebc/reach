import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { windowsFixture } from "./windows-fixtures.mjs";

const sourceHash = () => crypto.createHash("sha256").update(fs.readFileSync(new URL("../fixtures/windows/browser-job.cs", import.meta.url))).digest("hex");
const fileHash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const marker = (onStage) => (stage, details = {}) => { try { onStage?.(stage, details); } catch {} };

// The parent builds its actual fixture before the failed-start behavior budget.
// Only an explicit child-bound descriptor bypasses the normal per-process build.
export async function prepareWindowsBrowserBroker({ onStage, signal } = {}) {
  const file = fs.realpathSync(await windowsFixture("browser-job", [], { onStage, signal }));
  signal?.throwIfAborted();
  const descriptor = Object.freeze({ schema: 1, file, bytes: fs.statSync(file).size,
    sha256: fileHash(file), sourceSha256: sourceHash(), creatorPid: process.pid });
  marker(onStage)("prepared-broker-created", { bytes: descriptor.bytes });
  return descriptor;
}

export function verifyPreparedBrowserBroker(prepared, { onStage } = {}) {
  const mark = marker(onStage);
  mark("prepared-broker-check-begin");
  const refuse = (reason) => {
    mark("prepared-broker-refused", { reason });
    throw Object.assign(Error("Prepared Windows browser broker is missing, changed or invalid"), { code: "ERR_PREPARED_BROWSER_BROKER", reason });
  };
  const fields = ["schema", "file", "bytes", "sha256", "sourceSha256", "creatorPid"];
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)
      || Object.keys(prepared).length !== fields.length || Object.keys(prepared).some(key => !fields.includes(key))
      || prepared.schema !== 1 || typeof prepared.file !== "string" || prepared.file.length > 4096
      || !path.isAbsolute(prepared.file) || path.basename(prepared.file) !== "browser-job.exe"
      || !/^reach-fixtures-[A-Za-z0-9]{6}$/.test(path.basename(path.dirname(prepared.file)))
      || !Number.isInteger(prepared.bytes) || prepared.bytes < 1 || prepared.bytes > 16 * 1024 * 1024
      || typeof prepared.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(prepared.sha256)
      || typeof prepared.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(prepared.sourceSha256)
      || prepared.creatorPid !== process.ppid) refuse("descriptor");
  if (prepared.sourceSha256 !== sourceHash()) refuse("source");
  let parent, file, actual;
  try {
    parent = fs.lstatSync(path.dirname(prepared.file));
    file = fs.lstatSync(prepared.file);
    actual = fs.realpathSync(prepared.file);
  } catch { refuse("unavailable"); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()
      || actual !== prepared.file || file.size !== prepared.bytes) refuse("file");
  let digest;
  try { digest = fileHash(prepared.file); } catch { refuse("unavailable"); }
  if (digest !== prepared.sha256) refuse("digest");
  mark("prepared-broker-verified", { bytes: prepared.bytes });
  return prepared.file;
}

// Test browsers need an owner that survives their original process. A Windows
// PID tree cannot provide that after the parent exits with inherited pipes open.
// The broker assigns a suspended browser to its own kernel job before resuming
// it. Only the broker inherits fd 5; Chrome keeps the existing CDP fd 3/4 pair.
export async function windowsBrowserProcess(binary, flags, { onStage, preparedBroker } = {}) {
  const mark = marker(onStage);
  const broker = preparedBroker === undefined
    ? await windowsFixture("browser-job", [], { onStage: mark })
    : verifyPreparedBrowserBroker(preparedBroker, { onStage: mark });
  mark("broker-spawn-begin");
  const child = spawn(broker, [binary, ...flags], {
    stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  mark("broker-spawn-returned", { pid: Number.isInteger(child.pid) ? child.pid : null });
  const events = [];
  let buffered = "", protocolError, empty, settleEmpty;
  const stopped = new Promise(resolve => { settleEmpty = resolve; });
  const fields = new Set(["kind", "pid", "creationTime", "assignedBeforeResume", "exitCode", "active", "total", "terminated", "win32", "stage", "elapsedMs"]);
  child.stdio[5].setEncoding("utf8").on("data", chunk => {
    buffered += chunk;
    if (buffered.length > 16384) { protocolError = "oversized broker status"; buffered = ""; return; }
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at < 0) break;
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      try {
        const event = JSON.parse(line);
        if (!event || !["started", "parent-exit", "empty", "error"].includes(event.kind)
            || Object.keys(event).some(key => !fields.has(key))) throw Error("invalid broker status");
        if (events.length >= 32) throw Error("too many broker statuses");
        events.push(event);
        if (event.kind === "error") protocolError = "broker reported a native error";
        if (event.kind === "empty" && event.active === 0 && Number.isInteger(event.total) && event.total >= 1) {
          empty = event; settleEmpty();
        }
      } catch { protocolError = "invalid broker status"; }
    }
  });
  // A stopped launcher must not turn a late write into an unhandled EPIPE.
  child.stdin.on("error", () => {});
  child.stdio[5].on("error", () => { protocolError = "broker status pipe failed"; });
  return {
    child,
    snapshot: () => ({ owner: "windows-job", events: events.map(event => ({ ...event })), protocolError: protocolError || null }),
    async terminate(timeoutMs) {
      if (empty) return;
      child.stdin.write("terminate\n");
      let timer;
      try {
        if (!await Promise.race([stopped.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]))
          throw Error("Disposable Chrome job did not confirm termination within its existing deadline");
      } finally { clearTimeout(timer); }
    },
    assertStopped() {
      if (protocolError || !events.some(event => event.kind === "started" && event.assignedBeforeResume === true)
          || !empty || child.exitCode !== 0)
        throw Error("Disposable Chrome job did not confirm that every owned process stopped");
    },
  };
}
