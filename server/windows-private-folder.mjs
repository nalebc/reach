import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertUnchanged, windowsHelper } from "./desktop-native.mjs";
import { windowsPath } from "./app-identity.mjs";
const exec = promisify(execFile);

// Reach's folders on Windows, made as private as 0700 makes them on a Mac
// (docs/parity/D-public-door.md §4.5). Windows ignores the modes Reach passes
// (server/core.mjs), and a checkout outside the user folder (C:\reach) keeps
// its state where every signed-in user may change it. Browser sign-in keeps
// an OAuth client there that can make keys and remove devices, and runs a
// helper from there that decides what is Tailscale: so first, each launch
// with REACH_WINDOWS_ACCOUNT=1 (and `invites`, before it saves that client)
// tightens Reach's own folders, then a checker compiled just now confirms
// nobody else can read or change them, nor change Reach's code. Anything it
// can't confirm is refused, with the folder named.
//
// `protect`: Reach's state and data folders, tightened every time.
// `check`: Reach's code, never changed, only checked.
// `nativeDir`: where the helpers are built (inside a `protect` folder).
// `helpers`: helpers built there (cached, by hash), checked with the rest.
const ACCOUNT = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const SYSTEM = "S-1-5-18", ADMINISTRATORS = "S-1-5-32-544";
const CHECKER = "private-folder";
const OFF = "so browser sign-in stays off.";
const UNCHECKED = `Reach couldn't check who can use its folders on this PC, ${OFF}`;
const PROBLEMS = {
  ace: "can be read or changed by other people on this PC",
  owner: "belongs to another account on this PC",
  reparse: "leads somewhere else on this PC (a link or junction)",
  limit: "holds too many files to check",
  missing: "isn't there",
  error: "couldn't be checked",
};
const systemFolder = (env) => {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  return windowsPath(root) ? path.win32.join(root, "System32") : "";
};
// whoami's CSV: "computer\name","S-1-5-21-…". Only the SID is read: account
// names are localized and may hold anything.
export function accountSid(csv) {
  const fields = [...String(csv || "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const sid = fields.at(-1) || "";
  return ACCOUNT.test(sid) ? sid : "";
}
export async function ensurePrivateFolders({
  protect = [],
  check = [],
  nativeDir,
  helpers = [],
  run = exec,
  build = windowsHelper,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "win32") return { ok: false, reason: "Windows only." };
  const system = systemFolder(env);
  if (!system) return { ok: false, reason: `Reach couldn't find the Windows folder on this PC, ${OFF}` };
  if (!protect.length || !nativeDir) return { ok: false, reason: UNCHECKED };
  let sid = "";
  try {
    const { stdout } = await run(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { timeout: 10000, windowsHide: true });
    sid = accountSid(stdout);
  } catch {}
  if (!sid) return { ok: false, reason: `Reach couldn't tell which Windows account it runs as, ${OFF}` };
  // SIDs only, never names (localized): SYSTEM, Administrators and this
  // account, nothing inherited; what's inside takes the same. Only the exit
  // code is read.
  for (const dir of protect) {
    try {
      mkdirSync(dir, { recursive: true });
      await run(
        path.win32.join(system, "icacls.exe"),
        [dir, "/inheritance:r", "/grant:r", `*${SYSTEM}:(OI)(CI)F`, `*${ADMINISTRATORS}:(OI)(CI)F`, `*${sid}:(OI)(CI)F`, "/Q"],
        { timeout: 60000, windowsHide: true },
      );
    } catch {
      return { ok: false, reason: `Reach couldn't make its folder ${dir} private to your Windows account, ${OFF}` };
    }
  }
  const built = {};
  let checker;
  try {
    for (const kind of helpers) built[kind] = await build(kind, { dir: nativeDir });
    // Compiled now, every time: a file put in the folder while it was still
    // open is never what runs.
    checker = await build(CHECKER, { dir: nativeDir, fresh: true });
    const older = new RegExp(`^reach-${CHECKER}-[0-9a-f]{12}-[0-9a-f]{8}\\.exe$`);
    for (const name of await fs.readdir(nativeDir).catch(() => []))
      if (older.test(name) && name !== path.basename(checker.file))
        await fs.rm(path.join(nativeDir, name), { force: true }).catch(() => {});
  } catch (error) {
    return { ok: false, reason: `Reach couldn't prepare its folder check (${error.message}), ${OFF}` };
  }
  const files = Object.values(built).map((helper) => helper.file);
  const listed = [...protect, ...check, ...files];
  let said = "";
  try {
    assertUnchanged(checker.file, checker.sha256);
    const { stdout } = await run(checker.file, [sid, "state", ...protect, "code", ...check, "file", ...files], { timeout: 120000, maxBuffer: 65536, windowsHide: true });
    said = String(stdout).split(/\r?\n/)[0].trim();
  } catch {
    return { ok: false, reason: UNCHECKED };
  }
  if (said === "ok") return { ok: true, sid, helper: (kind) => async () => built[kind] };
  const open = /^open (\d{1,5}) (ace|owner|reparse|limit|missing|error)$/.exec(said);
  const index = open ? Number(open[1]) : -1;
  if (!(index >= 0 && index < listed.length)) return { ok: false, reason: UNCHECKED };
  const code = index >= protect.length && index < protect.length + check.length;
  const what = index >= protect.length + check.length ? "Reach's helper" : "Reach's folder";
  // Reach's code may be read by anyone (an installed program is); only a
  // change by someone else counts there.
  const problem = code && open[2] === "ace" ? "can be changed by other people on this PC" : PROBLEMS[open[2]];
  return {
    ok: false,
    reason: `${what} ${listed[index]} ${problem}, ${OFF}${code ? " Move it into your user folder, or install Reach with npm." : ""}`,
  };
}
