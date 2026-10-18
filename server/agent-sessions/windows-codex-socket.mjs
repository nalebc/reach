import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { assertUnchanged, windowsHelper } from "../desktop-native.mjs";
import { ensurePrivateFolders } from "../windows-private-folder.mjs";
import { windowsHelperEnv } from "../windows-helper-launch.mjs";
import { windowsPath } from "../app-identity.mjs";

// Node's Windows net module understands named pipes but not Winsock AF_UNIX.
// The native bridge authenticates its actual connected peer before this
// stream is returned to ws; localhost in the WS URL is never a TCP listener.
export const windowsCodexSocketPath = (file) => {
  return typeof file === "string" && windowsPath(file.replace(/^\\\\\?\\/, ""));
};
export const codexNativeFolder = () => path.resolve(process.env.REACH_DATA || path.join(os.homedir(), ".reach"));
const prepared = new Map();
async function prepare(dataDir) {
  const dir = path.join(dataDir, "codex-socket-native");
  if (!prepared.has(dir)) prepared.set(dir, (async () => {
    // Secure Reach's own state root and nested helper directory together.
    // Retained-handle preparation must create an absent state parent first.
    // The Codex socket's ACL is checked read-only, and is never repaired.
    // A helper and its note might both predate this directory's protection.
    // Compile a new unpredictable file on the first use of each Reach process;
    // a pre-existing matching EXE/note pair never establishes provenance.
    const secured = await ensurePrivateFolders({ protect: [dataDir, dir], nativeDir: dir, helpers: ["codex-socket"],
      build: (kind, options) => windowsHelper(kind, { ...options, fresh: true }) });
    if (!secured.ok) throw preparationRefusal(secured);
    return secured.helper("codex-socket")();
  })().catch((error) => { prepared.delete(dir); throw error; }));
  return prepared.get(dir);
}
const reasons = {
  acl: "Codex's session service folder isn't private to your Windows account.",
  reparse: "Codex's session service folder is a link or junction that Reach can't trust.",
  elevation: "Reach and Codex must both run without administrator elevation to share Codex's session service.",
  identity: "Reach couldn't verify that Codex's session service runs as your Windows account.",
  peer: "Windows couldn't identify the process serving Codex's session service.",
  length: "Codex's session service path is longer than Windows AF_UNIX supports.",
};
const refusal = (reason) => Object.assign(new Error(reasons[reason] || "Reach couldn't securely connect to Codex's session service on this Windows PC."), { status: 503, code: "CODEX_SOCKET_REFUSED" });
const prepareCodes = new Set(["EPRIVATESTAGE", "ECHANGED", "EACCES", "EPERM", "ENOENT", "ENOSYS", "ETIMEDOUT", "ABORT_ERR"]);
const prepareStatuses = new Set([400, 401, 403, 409, 421, 423, 429, 500, 501, 502, 503, 504]);
const stagePhases = new Set("validate command token leaf parent path volume ancestors descriptor-build container stage-create stage-check ancestor-recheck output".split(" "));
const stageReasons = new Set("input account leaf path reparse descriptor owner ancestor-access stage-acl profile volume depth exists not-empty changed exception unknown ABORT_ERR ETIMEDOUT ENOENT EACCES EPERM".split(" "));
const exceptionClasses = new Set(["none", "unknown", "System.ArgumentException", "System.ArgumentNullException", "System.InvalidCastException", "System.InvalidOperationException",
  "System.UnauthorizedAccessException", "System.IO.IOException", "System.IO.DirectoryNotFoundException", "System.IO.FileNotFoundException", "System.Security.SecurityException",
  "System.Management.Automation.RuntimeException", "System.Management.Automation.MethodInvocationException", "System.Management.Automation.PropertyNotFoundException"]);
const stageIds = new Set([...stageReasons, "none", "RuntimeException", "MethodInvocationException", "PropertyNotFoundStrict", "InvokeMethodOnNull", "InvalidCastException", "ArgumentException", "UnauthorizedAccessException"]);
function preparationRefusal(value) {
  // Keep only finite diagnostic categories. Native stdout, messages, paths,
  // tokens and arbitrary error fields never become the public failure.
  const error = Object.assign(new Error("Reach couldn't prepare its private Codex connection helper on this Windows PC."), { status: 503, code: "CODEX_SOCKET_PREPARE" });
  const code = value?.prepareCode ?? value?.code, status = value?.prepareStatus ?? value?.status;
  if (prepareCodes.has(code)) error.prepareCode = code;
  if (prepareStatuses.has(status)) error.prepareStatus = status;
  if (value?.stage && typeof value.stage === "object") {
    const stage = value.stage;
    error.stage = { phase: stagePhases.has(stage.phase) ? stage.phase : "unknown", reason: stageReasons.has(stage.reason) ? stage.reason : "unknown" };
    for (const key of ["exception", "innerException"]) if (exceptionClasses.has(stage[key])) error.stage[key] = stage[key];
    if (stageIds.has(stage.id)) error.stage.id = stage.id;
    if (Number.isSafeInteger(stage.line) && stage.line >= 0 && stage.line <= 99999) error.stage.line = stage.line;
  }
  return error;
}

// Exported separately to exercise helper protocol and lifecycle on every OS;
// those tests model the child, and do not qualify Windows socket security.
export function codexSocketBridge(child, { timeout = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let ready = false, settled = false, control = "", timer;
    const stream = new Duplex({
      read() { child.stdout.resume(); },
      write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
      final(callback) {
        if (child.stdin.destroyed || child.stdin.writableEnded) callback();
        else child.stdin.end(callback);
      },
      destroy(error, callback) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        try { child.kill(); } catch {}
        callback(error);
      },
    });
    // A child can fail between resolving readiness and ws attaching its own
    // listener. Retain the error on the stream without an uncaught emission.
    stream.on("error", () => {});
    // ws treats this as an already connected local Duplex. It implements no
    // net.connect or TCP fallback, and cannot reconnect or replay a write.
    stream.connecting = false;
    stream.setTimeout = () => stream;
    stream.setNoDelay = () => stream;
    stream.setKeepAlive = () => stream;
    const fail = (reason) => {
      const error = reason instanceof Error && reason.name === "AbortError" ? reason : refusal(reason);
      if (!settled) { settled = true; reject(error); }
      // Before resolve, nobody else owns an error listener on this stream.
      if (!ready) stream.once("error", () => {});
      stream.destroy(error);
    };
    const abort = () => fail(signal.reason);
    timer = setTimeout(() => fail("timeout"), timeout);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => {
      // Node's "ascii" decoder masks high bits. Reject non-ASCII bytes first
      // so a malformed control line cannot decode into the readiness token.
      if (chunk.some((byte) => byte > 127)) return fail("protocol");
      control += chunk.toString("ascii");
      if (control.length > 1024) return fail("protocol");
      for (let at; (at = control.indexOf("\n")) >= 0; ) {
        const line = control.slice(0, at);
        control = control.slice(at + 1);
        if (line === "ready 1" && !ready) {
          ready = true; settled = true; clearTimeout(timer); resolve(stream);
        } else if (/^error [a-z]+$/u.test(line)) fail(line.slice(6));
        else fail("protocol");
      }
    });
    child.stdout.on("data", (chunk) => {
      if (!ready) return fail("protocol");
      if (!stream.push(chunk)) child.stdout.pause();
    });
    child.stdout.on("end", () => {
      if (!ready) fail("connection");
      else stream.push(null);
    });
    for (const io of [child.stdin, child.stdout, child.stderr]) io.on("error", () => fail("connection"));
    child.once("error", () => fail("connection"));
    child.once("close", (code, stoppedBy) => {
      if (!ready) fail("connection");
      else if (code || stoppedBy) fail("connection");
      // stdout's end has already queued EOF. Let its final bytes drain before
      // ws observes end/close; destroy here would discard buffered replies.
    });
    // Do not read or queue peer bytes until the separate control channel has
    // established readiness. Native code emits it only after peer validation.
    child.stdout.pause();
    if (signal?.aborted) abort();
  });
}

export async function openWindowsCodexSocket(file, {
  dataDir = codexNativeFolder(), timeout = 8000, signal,
  prepareHelper = prepare, unchanged = assertUnchanged, start = spawn,
} = {}) {
  if (!windowsCodexSocketPath(file)) throw refusal("endpoint");
  signal?.throwIfAborted();
  let helper;
  try { helper = await prepareHelper(dataDir); }
  catch (error) {
    if (error?.name === "AbortError") throw error;
    throw preparationRefusal(error);
  }
  signal?.throwIfAborted();
  try { unchanged(helper.file, helper.sha256); }
  catch (error) { prepared.delete(path.join(dataDir, "codex-socket-native")); throw error; }
  const child = start(helper.file, [file, String(process.pid)], { windowsHide: true, env: windowsHelperEnv(), stdio: ["pipe", "pipe", "pipe"] });
  return codexSocketBridge(child, { timeout, signal });
}
