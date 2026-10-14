import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnVerified } from "./desktop-native.mjs";
import { computerWord } from "./computer-word.mjs";
import { fail } from "./core.mjs";
import { browserPrivatePaths, browserPrivateNames } from "./browser-private-paths.mjs";
import { windowsCanonicalPath, windowsWithin } from "./app-identity.mjs";

const execFileAsync = promisify(execFile);

// The Node end of Reach's Windows sandbox (scripts/native/sandbox.cs,
// docs/parity/C-sandbox.md). It frames requests to the helper, reads its
// framed answers, decides whether the OS will even run the helper, and builds
// each surface's grant and deny descriptor. Nothing here changes a byte of
// macOS behaviour: the server reaches it only on a win32 branch, and every
// function takes its platform and dependencies as options so the unit tests
// drive it on any host (test/helpers/as-windows.mjs).

// ---------------------------------------------------------------------------
// §2.3 Protocol. One length-prefixed request on the helper's stdin; a stream
// of typed frames back on its stdout. The child the helper launches inherits
// only pipe handles the helper owns, so a child's bytes can only ever arrive
// as 'O'/'E' data frames and can never be read as an 'X'/'R'/'F' control frame.

const FRAME = { started: 0x53, stdout: 0x4f, stderr: 0x45, exit: 0x58, result: 0x52, refused: 0x46 }; // S O E X R F

// Build the one request frame: a list of [key, value] entries (a repeated key
// is a list on the helper side), length-prefixed. Any bytes are carried
// verbatim, so a command or path with newlines or quotes needs no escaping.
export function encodeSandboxRequest(entries) {
  const parts = [];
  let total = 0;
  for (const [key, value] of entries) {
    const k = Buffer.from(String(key), "utf8");
    const v = Buffer.from(value == null ? "" : String(value), "utf8");
    const keyLen = Buffer.alloc(4); keyLen.writeUInt32BE(k.length, 0);
    const valLen = Buffer.alloc(4); valLen.writeUInt32BE(v.length, 0);
    parts.push(keyLen, k, valLen, v);
    total += 8 + k.length + v.length;
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(total, 0);
  return Buffer.concat([prefix, ...parts], 4 + total);
}

// A reader for the helper's stdout. Feed it chunks; it calls the handlers as
// whole frames arrive. Data frames ('O'/'E') hand their payload to onStdout /
// onStderr untouched — a data frame whose bytes happen to spell an exit frame
// is still just output, never a control frame. Control frames come only from
// the helper itself.
export function createSandboxFrameReader({
  onStarted = () => {}, onStdout = () => {}, onStderr = () => {},
  onExit = () => {}, onResult = () => {}, onRefused = () => {}, onError = () => {},
  maxFrame = 8 * 1024 * 1024,
} = {}) {
  let buffer = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 5) return;
      const type = buffer[0];
      const length = buffer.readUInt32BE(1);
      if (length > maxFrame) { broken = true; return onError(new Error("Sandbox frame too large.")); }
      if (buffer.length < 5 + length) return;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      switch (type) {
        case FRAME.stdout: onStdout(Buffer.from(payload)); break;
        case FRAME.stderr: onStderr(Buffer.from(payload)); break;
        case FRAME.started: onStarted(payload.length >= 4 ? payload.readUInt32BE(0) : null); break;
        case FRAME.exit: onExit(payload.length >= 4 ? payload.readInt32BE(0) : null); break;
        case FRAME.result: onResult(Buffer.from(payload)); break;
        case FRAME.refused: {
          const status = payload.length >= 4 ? payload.readUInt32BE(0) : 503;
          const message = payload.length > 4 ? payload.subarray(4).toString("utf8") : "The sandbox helper refused the request.";
          onRefused({ status, message });
          break;
        }
        default: broken = true; return onError(new Error("Unknown sandbox frame."));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// §2.2 Launch self-test. A no-op launch of the already-hash-verified helper at
// every start decides whether the OS lets it run; the registry read is kept
// only to word the refusal (Smart App Control). A blocked helper refuses the
// surface, never retries, never falls back to an interpreter (plan rule 2).
// This mirrors B §3.4's classification; it stays here so it never collides with
// workstream B's edits to server/desktop-native.mjs.

export const SAC_BLOCKED = (platform = process.platform) =>
  `Smart App Control on this ${computerWord(platform)} only runs signed programs, so agents' commands can't run here yet.`;
export const POLICY_BLOCKED = (platform = process.platform) =>
  `Windows' application control on this ${computerWord(platform)} (an administrator's policy, Smart App Control or antivirus) blocked Reach's sandbox helper. Reach can't change that policy.`;
export const HELPER_WONT_START = (platform = process.platform) =>
  `Reach's sandbox helper couldn't start on this ${computerWord(platform)}, so agents' commands can't run.`;

// Windows reports a policy block as an access error or UNKNOWN (libuv doesn't
// carry the Win32 code), never a clean exit.
const refusedToStart = (error) =>
  /^spawn/.test(error?.syscall || "") && ["EACCES", "EPERM", "UNKNOWN"].includes(error?.code);

// Reads SAC's state for wording only (B §3.4): REG_DWORD 1 = On. Anything else,
// or an unreadable value, is not treated as On.
export async function smartAppControlOn({ run = execFileAsync, env = process.env } = {}) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  try {
    const { stdout } = await run(`${root}\\System32\\reg.exe`,
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy", "/v", "VerifiedAndReputablePolicyState"],
      { timeout: 5000, windowsHide: true });
    const match = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout));
    return !!match && parseInt(match[1], 16) === 1;
  } catch {
    return false;
  }
}

// Launch the helper once with `selftest`: a Started frame means the OS runs it.
// A spawn error or an exit with no Started frame is classified (SAC first, for
// wording), and the surface is refused. `start` and `reg` are injected in tests.
export async function sandboxSelfTest({
  helper, start = spawnVerified, run = execFileAsync, platform = process.platform, env = process.env,
  timeoutMs = 60000, sac = smartAppControlOn,
} = {}) {
  let built;
  try {
    built = await helper();
  } catch (error) {
    return { ok: false, permanent: false, reason: HELPER_WONT_START(platform) + (error?.message ? " (" + String(error.message).slice(0, 160) + ")" : "") };
  }
  // A spawn refusal is how Windows reports an application-control block, so it
  // is a permanent policy refusal (SAC-worded when SAC is on). A helper that
  // spawned but then died without answering is more likely a crash than a
  // policy block, so unless SAC is on it is a non-permanent "won't start".
  const onSpawnRefused = async () => {
    const on = await sac({ run, env }).catch(() => false);
    return { ok: false, permanent: true, reason: on ? SAC_BLOCKED(platform) : POLICY_BLOCKED(platform) };
  };
  const onEarlyExit = async () => {
    const on = await sac({ run, env }).catch(() => false);
    return on ? { ok: false, permanent: true, reason: SAC_BLOCKED(platform) } : { ok: false, permanent: false, reason: HELPER_WONT_START(platform) };
  };
  return await new Promise((resolve) => {
    let child, started = false, settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); try { child?.kill(); } catch {} resolve(value); };
    const timer = setTimeout(() => finish({ ok: false, permanent: false, reason: HELPER_WONT_START(platform) }), timeoutMs);
    try {
      child = start(built.file, built.sha256, ["selftest"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (error) {
      if (refusedToStart(error)) return void onSpawnRefused().then(finish);
      return finish({ ok: false, permanent: false, reason: HELPER_WONT_START(platform) });
    }
    const read = createSandboxFrameReader({ onStarted: () => { started = true; finish({ ok: true }); } });
    child.stdout?.on("data", read);
    child.on("error", (error) => { if (refusedToStart(error)) return void onSpawnRefused().then(finish); finish({ ok: false, permanent: false, reason: HELPER_WONT_START(platform) }); });
    child.on("exit", () => { if (!started) void onEarlyExit().then(finish); });
  });
}

// ---------------------------------------------------------------------------
// §4.3 What may be granted, and §4.4 what is denied. A jobs or scripts grant is
// confined to a per-root capability SID the helper ACLs onto that root's tree;
// the file boundary is the intersection of the owner's access and the
// capability grant, so a folder is reachable only if both allow it (§4.1). The
// access masks and the DENY carve-outs live on the helper side (§4.4, §4.5);
// here we only decide which roots may be granted and which paths must be denied.

const isDriveRoot = (canonical) => /^[a-z]:\\$/.test(canonical);

// Finding 2: a jobs or scripts grant whose root is a drive root, Home, or an
// ancestor of Home is refused with a worded reason; grants never come from a
// drive letter. This closes the Home/drive walk and keeps an ALLOW out of
// appRoot/dataDir/state even when a root would contain them (finding 1). The
// cost — a client whose only roots are Home plus drive letters can't run jobs
// on Windows — is the §10 parity break the owner accepted.
export function windowsGrantRoots(roots, { home = os.homedir(), platform = process.platform } = {}) {
  const canonicalHome = windowsCanonicalPath(home);
  const granted = [];
  for (const root of roots || []) {
    if (typeof root !== "string" || !root) continue;
    const canonical = windowsCanonicalPath(root);
    if (isDriveRoot(canonical))
      throw fail(403, `A whole drive (${root}) can't be shared with an agent's commands on a ${computerWord(platform)}. Share a project folder inside it.`);
    // windowsWithin(home, root) is true when root is Home itself or an ancestor
    // of Home, so both cases refuse with the same reason.
    if (windowsWithin(canonicalHome, canonical))
      throw fail(403, `Your home folder (or a folder that contains it) can't be shared with an agent's commands on a ${computerWord(platform)}. Share a project folder inside it.`);
    granted.push(canonical);
  }
  return granted;
}

// §4.4 The jobs deny set mirrors agentShellSandbox's read/write lists on the
// Mac: Reach's code and data, the agent vault, the credential and browser
// stores, Tailscale's state, the Windows persistence points — but NOT the
// in-root private names (.git, .npmrc, .config), so git and npm work in a
// shared folder exactly as they do on the Mac (finding 5). browserPrivatePaths
// on win32 already builds this set from the environment (server/
// browser-private-paths.mjs windowsPrivatePaths).
export function windowsJobDenies(config, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  return browserPrivatePaths(config, { home, platform, env });
}

// §3.1, §8: the descriptor the jobs POST hands the helper. Not a profile
// string — a regular AppContainer with per-root capability grants, the mirror
// deny set, internet (the loopback/tailnet self-test refuses any reach to
// Reach, §5), a fork-bomb process cap and a runaway-memory cap, and no job CPU
// time limit (finding 10). Grants come from the client's current roots, never
// from config.roots (findings 1, 2); a refused root throws a worded 403.
export function windowsJobSandbox(config, client, { sockets = [], home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const roots = client?.agentRoots?.length ? client.agentRoots : config.roots || [];
  const grants = windowsGrantRoots(roots, { home, platform }).map((root) => ({ root, access: "rw" }));
  return {
    mode: "jobs",
    // A stable per-client AppContainer package SID (§4.1); the per-root
    // capabilities handed to each launch decide what it can touch.
    client: client?.id || "jobs",
    grants,
    denies: [...windowsJobDenies(config, { home, platform, env }), ...sockets],
    network: "internet",
    capabilities: ["internetClient"],
    // A fork-bomb guard only, and a runaway-memory cap; no JOB_TIME, so a
    // parallel build isn't cut off before its wall-clock timeout (finding 10).
    limits: { activeProcesses: 512, memoryBytes: 0 },
  };
}

// ---------------------------------------------------------------------------
// §5 Network, and the self-test gate. The jobs AppContainer gets internet
// (internetClient) but Reach's own listener must be unreachable from it; the
// helper proves that inside the container before each launch (§5), so no claim
// rests on a firewall rule an unelevated Reach can't install (finding 9). The
// local addresses the probe must find refused: loopback v4/v6, the LAN IP, and
// the tailnet IP and MagicDNS name (Tailscale Serve would otherwise present the
// owner node's identity).
export function windowsLoopbackTargets({ port, lanIps = [], tailnetIps = [], magicDns = "" } = {}) {
  const addresses = ["127.0.0.1", "::1", ...lanIps, ...tailnetIps, ...(magicDns ? [magicDns] : [])];
  return [...new Set(addresses.filter(Boolean))].map((address) => ({ address, port }));
}

export const SANDBOX_UNPREPARED = (platform = process.platform) =>
  `Reach couldn't prepare its command sandbox on this ${computerWord(platform)} (its private folder isn't ready), so agents' commands can't run here yet.`;

// The server's handle to the Windows sandbox: it builds the helper once (A's
// windowsBinary/spawnVerified, into a folder D made private this launch) and
// runs the launch self-test once at start, caching the outcome. A permanent
// policy block stays cached; a transient "won't start" is re-tried on the next
// request, never retried in a loop and never falling back to an interpreter.
export function createWindowsSandbox({ helper = null, start = spawnVerified, run = execFileAsync, platform = process.platform, env = process.env } = {}) {
  let pending = null;
  const ready = () => {
    if (!helper) return Promise.resolve({ ok: false, permanent: true, reason: SANDBOX_UNPREPARED(platform) });
    if (pending) return pending;
    pending = (async () => {
      let built;
      try { built = await helper(); }
      catch (error) { return { ok: false, permanent: false, reason: HELPER_WONT_START(platform) + (error?.message ? " (" + String(error.message).slice(0, 160) + ")" : "") }; }
      const result = await sandboxSelfTest({ helper: async () => built, start, run, platform, env });
      return { ...result, built: result.ok ? built : null };
    })();
    pending = pending.then((result) => {
      // Let a non-permanent failure (a crash, a transient block) be re-tried on
      // the next job; a success or a permanent policy block stays cached.
      if (!result.ok && !result.permanent) pending = null;
      return result;
    });
    return pending;
  };
  return { ready, reset: () => { pending = null; } };
}

// The request entries for one job, in the order the helper reads them. cmd.exe
// /d /s /c is the interpreter for jobs (D-C-1); the command string is carried
// verbatim as one field, never concatenated into a shell line.
export function jobRequestEntries(descriptor, { command, cwd, timeoutMs, interpreter = "cmd.exe", loopback = [] }) {
  const entries = [
    ["mode", "jobs"],
    ["client", descriptor.client || "jobs"],
    ["interpreter", interpreter],
    ["command", command],
    ["cwd", cwd],
    ["timeoutMs", String(timeoutMs)],
    ["network", descriptor.network || "internet"],
    ["activeProcesses", String(descriptor.limits?.activeProcesses ?? 512)],
  ];
  for (const { root, access } of descriptor.grants || []) entries.push(["grant", root], ["grantAccess", access || "rw"]);
  for (const deny of descriptor.denies || []) entries.push(["deny", deny]);
  for (const capability of descriptor.capabilities || []) entries.push(["capability", capability]);
  for (const { address, port } of loopback) entries.push(["loopback", address + ":" + port]);
  return entries;
}

// ---------------------------------------------------------------------------
// §3.2 Full-control shell. Parity with the Mac's unsandboxed /bin/zsh: a Job
// Object only, on the owner's own token, no AppContainer and no caps, killed
// only on abort or timeout (so `start`-ed background apps survive a normal
// completion, as the Mac's process-group kill leaves them). The env is the
// owner's (built helper-side with CreateEnvironmentBlock + REACH_AGENT=1), so
// the Mac env createAgentShell passes is ignored (finding 17).
export function shellRequestEntries({ command, cwd, timeoutMs, interpreter = "cmd.exe" }) {
  return [
    ["mode", "shell"],
    ["interpreter", interpreter],
    ["command", command],
    ["cwd", cwd || ""],
    ["timeoutMs", String(timeoutMs || 60000)],
  ];
}

// The production `run` for createAgentShell on Windows (wired at index.mjs's
// agentShell creation, not the test override). It proves the helper runs (§2.2),
// then streams one shell command through it, honouring the caller's timeout and
// its revocation signal (stdin-EOF aborts; the Job Object reaps the tree).
export function windowsShellRunner(windowsSandbox, { start = spawnVerified, interpreter = "cmd.exe" } = {}) {
  return async ({ command, cwd, timeoutMs = 60000, maxOutput = 256 * 1024, signal }) => {
    if (signal?.aborted) throw signal.reason;
    const ready = await windowsSandbox.ready();
    if (!ready.ok) throw fail(503, ready.reason);
    return await new Promise((resolve, reject) => {
      let output = "", size = 0, truncated = false, exitCode = null, settled = false;
      let child;
      const collect = (buffer) => {
        if (size >= maxOutput) { truncated = true; return; }
        const slice = buffer.subarray(0, maxOutput - size);
        output += slice.toString("utf8"); size += slice.length;
        if (slice.length < buffer.length) truncated = true;
      };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const settle = (timedOut) => { if (settled) return; settled = true; cleanup(); resolve({ output: output + (truncated ? "\n[Output truncated]" : ""), exitCode, timedOut }); };
      const die = (error) => { if (settled) return; settled = true; cleanup(); try { child?.stdin.end(); } catch {} try { child?.kill(); } catch {} reject(error); };
      const onAbort = () => { try { child?.stdin.end(); } catch {} try { child?.kill(); } catch {} die(signal.reason); };
      const timer = setTimeout(() => { try { child?.stdin.end(); } catch {} try { child?.kill(); } catch {} settle(true); }, timeoutMs);
      timer.unref?.();
      try { child = start(ready.built.file, ready.built.sha256, ["run"], { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); }
      catch { return die(fail(503, "The command could not start.")); }
      const read = createSandboxFrameReader({
        onStdout: collect, onStderr: collect,
        onExit: (code) => { exitCode = code; settle(false); },
        onRefused: ({ status, message }) => die(fail([400, 403, 409, 503].includes(status) ? status : 503, message)),
        onError: () => die(fail(503, "The command could not complete.")),
      });
      child.stdout.on("data", read);
      child.on("error", () => die(fail(503, "The command could not start.")));
      signal?.addEventListener("abort", onAbort, { once: true });
      try { child.stdin.write(encodeSandboxRequest(shellRequestEntries({ command, cwd, timeoutMs, interpreter }))); } catch { die(fail(503, "The command could not start.")); }
    });
  };
}

// ---------------------------------------------------------------------------
// §3.3 Browser scripts. The strictest shape: an LPAC AppContainer with no
// capabilities beyond what the interpreter needs to start, no network, a
// one-process Job Object with CHILD_PROCESS_RESTRICTED, the one shared root
// granted (plus the Node runtime read+execute), browserPrivatePaths + the
// private names denied, and a post-run scan for planted private names (finding
// 5). Grants still refuse a drive root, Home or an ancestor of Home (finding 2).
export function windowsScriptSandbox(config, root, { privatePaths = [], home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const [canonicalRoot] = windowsGrantRoots([root], { home, platform });
  return {
    mode: "script",
    client: "script",
    grants: [{ root: canonicalRoot, access: "rw" }],
    nodeRuntime: path.win32.dirname(process.execPath),
    denies: [...browserPrivatePaths(config, { home, platform, env }), ...privatePaths],
    denyNames: [...browserPrivateNames],
    network: "none",
    lpac: true,
    limits: { activeProcesses: 1, childRestricted: true },
  };
}

export function scriptRequestEntries(descriptor, { executable, args = [], cwd, timeoutMs }) {
  const entries = [
    ["mode", "script"],
    ["client", descriptor.client || "script"],
    ["executable", executable],
    ["cwd", cwd || ""],
    ["timeoutMs", String(timeoutMs || 30000)],
    ["network", "none"],
    ["lpac", descriptor.lpac ? "1" : "0"],
    ["activeProcesses", String(descriptor.limits?.activeProcesses ?? 1)],
    ["childRestricted", descriptor.limits?.childRestricted ? "1" : "0"],
  ];
  for (const arg of args) entries.push(["arg", arg]);
  for (const { root, access } of descriptor.grants || []) entries.push(["grant", root], ["grantAccess", access || "rw"]);
  if (descriptor.nodeRuntime) entries.push(["nodeRuntime", descriptor.nodeRuntime]);
  for (const deny of descriptor.denies || []) entries.push(["deny", deny]);
  for (const name of descriptor.denyNames || []) entries.push(["denyName", name]);
  return entries;
}

// ---------------------------------------------------------------------------
// §4.2, §4.6 Revocation, change and the sweeps. A change of roots already takes
// effect on the next launch with no walk (the live token no longer carries that
// capability); the on-disk ACEs are reclaimed by a revoke walk that continues
// past reparse points. A ledger records which roots a client was granted, so the
// expiry sweep (which fires no event) and the startup sweep can find orphans.
export function revokeRequestEntries(roots) {
  const entries = [["mode", "revoke"]];
  for (const root of roots) entries.push(["grant", root]);
  return entries;
}

// Spawns the helper to remove a set of roots' capability ACEs (the job is killed
// first by the caller). Best-effort and bounded; a failure is left for a sweep.
export function windowsRevoker(windowsSandbox, { start = spawnVerified } = {}) {
  return async (roots) => {
    if (!roots || !roots.length) return;
    const ready = await windowsSandbox.ready();
    if (!ready.ok) return;
    await new Promise((resolve) => {
      let child, settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { child?.kill(); } catch {} finish(); }, 120000);
      timer.unref?.();
      try { child = start(ready.built.file, ready.built.sha256, ["run"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); }
      catch { return finish(); }
      child.on("close", finish);
      child.on("error", finish);
      try { child.stdin.write(encodeSandboxRequest(revokeRequestEntries(roots))); } catch { finish(); }
    });
  };
}

// The grants ledger, in an ensurePrivateFolders-protected folder. One entry per
// client; a changed client's roots replace its entry (an atomic write).
export function createWindowsGrantLedger({ dir, revoke = async () => {}, now = Date.now } = {}) {
  const file = path.join(dir, "windows-sandbox", "grants.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
  const save = (list) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, file); };
  return {
    record({ clientId, roots, expiresAt = 0 }) {
      if (!clientId || !roots?.length) return;
      const list = load().filter((entry) => entry.clientId !== clientId);
      list.push({ clientId, roots, expiresAt, grantedAt: now() });
      save(list);
    },
    async revokeClient(clientId) {
      const list = load();
      const entry = list.find((e) => e.clientId === clientId);
      if (!entry) return;
      await revoke(entry.roots);
      save(list.filter((e) => e.clientId !== clientId));
    },
    // Reclaim entries whose client is gone or whose grant has expired.
    async sweep(isLive) {
      const list = load();
      const keep = [];
      for (const entry of list) {
        if ((entry.expiresAt && entry.expiresAt <= now()) || !isLive(entry.clientId)) await revoke(entry.roots);
        else keep.push(entry);
      }
      if (keep.length !== list.length) save(keep);
    },
  };
}
