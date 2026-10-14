import os from "node:os";
import { spawnVerified } from "./desktop-native.mjs";
import { computerWord } from "./computer-word.mjs";
import { fail } from "./core.mjs";
import { browserPrivatePaths } from "./browser-private-paths.mjs";
import { windowsCanonicalPath, windowsWithin } from "./app-identity.mjs";

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
export async function smartAppControlOn({ run, env = process.env } = {}) {
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
  helper, start = spawnVerified, run, platform = process.platform, env = process.env,
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
    grants,
    denies: windowsJobDenies(config, { home, platform, env }),
    network: "internet",
    capabilities: ["internetClient"],
    // A fork-bomb guard only, and a runaway-memory cap; no JOB_TIME, so a
    // parallel build isn't cut off before its wall-clock timeout (finding 10).
    limits: { activeProcesses: 512, memoryBytes: 0 },
  };
}
