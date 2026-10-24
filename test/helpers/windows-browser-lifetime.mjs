import { spawn } from "node:child_process";
import { windowsFixture } from "./windows-fixtures.mjs";

// Test browsers need an owner that survives their original process. A Windows
// PID tree cannot provide that after the parent exits with inherited pipes open.
// The broker assigns a suspended browser to its own kernel job before resuming
// it. Only the broker inherits fd 5; Chrome keeps the existing CDP fd 3/4 pair.
export async function windowsBrowserProcess(binary, flags, { onStage } = {}) {
  const mark = (stage, details = {}) => { try { onStage?.(stage, details); } catch {} };
  const broker = await windowsFixture("browser-job", [], { onStage: mark });
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
