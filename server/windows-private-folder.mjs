import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertUnchanged, registerWindowsBuildDirectory, windowsHelper } from "./desktop-native.mjs";
import { windowsPath } from "./app-identity.mjs";
import { createWindowsPrivateStage } from "./windows-private-stage.mjs";
const exec = promisify(execFile);

// Reach's folders on Windows, made as private as 0700 makes them on a Mac
// (docs/parity/D-public-door.md §4.5). Windows ignores the modes Reach passes
// (server/core.mjs), and a checkout outside the user folder (C:\reach) keeps
// its state where every signed-in user may change it. Browser sign-in keeps
// an OAuth client there that can make keys and remove devices, and runs a
// helper from there that decides what is Tailscale: so first, each launch
// with browser sign-in (and `invites`, before it saves that client)
// tightens Reach's own folders, then a checker compiled just now confirms
// nobody else can read or change them, nor change Reach's code. Anything it
// can't confirm is refused, with the folder named.
//
// `protect`: Reach's state and data folders. A retained-handle native preflight
// repairs only recognized broad READ grants in simple allow-only ACLs.
// `check`: Reach's code, never changed, only checked.
// `nativeDir`: the old helper directory, covered by state verification, never
// used as build input or output. A matching old EXE/digest is not provenance.
// `helpers`: helpers compiled fresh into an atomically private new stage.
const ACCOUNT = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const CHECKER = "private-folder";
const OFF = "so browser sign-in stays off.";
const UNCHECKED = "Reach couldn't check who can use its folders on this PC";
// A refusal says what's wrong (`problem`) and, in `reason`, what that turns
// off for sign-in. The same problem turns off agents' helpers too (the
// sandbox, the agent desktop: scripts/launch.mjs), said in their own words
// with `advice` kept.
const refused = (problem, advice = "") => ({ ok: false, problem, ...(advice ? { advice } : {}), reason: `${problem}, ${OFF}${advice ? ` ${advice}` : ""}` });
const PROBLEMS = {
  ace: "can be read or changed by other people on this PC",
  owner: "belongs to another account on this PC",
  reparse: "leads somewhere else on this PC (a link or junction)",
  limit: "holds too many files to check",
  missing: "isn't there",
  error: "couldn't be checked",
  hardlink: "has more than one name on this PC (a hard link)",
  ancestor: "can be changed by other people on this PC",
  write: "has sharing permissions that allow changes by other people; Reach couldn't safely change them automatically",
  deny: "has sharing and deny rules that Reach couldn't safely change automatically",
  complex: "has permissions Reach couldn't safely check or change automatically",
  access: "doesn't allow Reach to safely make its permissions private",
  sharing: "is in use by another program, so Reach couldn't check it safely",
  changed: "changed while Reach checked it",
  path: "isn't a canonical local NTFS path Reach can safely check",
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
  createStage = createWindowsPrivateStage,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "win32") return { ok: false, problem: "Windows only.", reason: "Windows only." };
  const system = systemFolder(env);
  if (!system) return refused("Reach couldn't find the Windows folder on this PC");
  if (!protect.length || !nativeDir) return refused(UNCHECKED);
  let sid = "";
  try {
    const { stdout } = await run(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { timeout: 10000, windowsHide: true });
    sid = accountSid(stdout);
  } catch {}
  if (!sid) return refused("Reach couldn't tell which Windows account it runs as");
  let stage;
  // This bootstrap runs BEFORE any state mutation or compilation. It does
  // not load an old helper, compile interop, follow a junction or trust a
  // cached digest to establish the first private directory.
  try {
    stage = await createStage({ sid, env, run });
  } catch (error) {
    return { ...refused("Reach couldn't prepare a private helper folder on this Windows PC"), ...(error.stage ? { stage: error.stage } : {}) };
  }
  const built = new Map();
  let closed = false, verified = false, unregister = null, checker;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    unregister?.();
    await fs.rm(stage.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  const fail = async result => {
    await dispose().catch(() => {});
    return result;
  };
  const readCheck = async ({ state = [], code = [], files = [] } = {}) => {
    const listed = [...state.map(file => ({ file })), ...code.map(file => ({ file, code: true })), ...files.map(file => ({ file, helper: true }))];
    assertUnchanged(checker.file, checker.sha256);
    const { stdout } = await run(checker.file, [sid, "state", ...state, "code", ...code, "file", ...files], { timeout: 120000, maxBuffer: 65536, windowsHide: true });
    const said = String(stdout).trim();
    if (said === "ok") return null;
    const match = /^open (\d{1,5}) (ace|owner|reparse|limit|missing|error)$/.exec(said);
    const item = match && listed[Number(match[1])];
    if (!item) return refused(UNCHECKED);
    const what = item.helper ? "Reach's helper" : "Reach's folder";
    const problem = item.code && match[2] === "ace" ? "can be changed by other people on this PC" : PROBLEMS[match[2]];
    return refused(`${what} ${item.file} ${problem}`, item.code ? "Move it into your user folder, or install Reach with npm." : "");
  };
  const helper = async kind => {
    if (closed) throw Error("Reach's private helper folder has closed.");
    if (!built.has(kind)) built.set(kind, (async () => {
      if (verified) {
        const problem = await readCheck({ state: [stage.dir] });
        if (problem) throw Error(problem.problem);
      }
      const result = await build(kind, { dir: stage.dir, fresh: true });
      if (closed) throw Error("Reach's private helper folder has closed.");
      assertUnchanged(result.file, result.sha256);
      return result;
    })().catch(error => { built.delete(kind); throw error; }));
    const result = await built.get(kind);
    assertUnchanged(result.file, result.sha256);
    return result;
  };
  try {
    checker = await helper(CHECKER);
    // Code remains read-only, and an insecure installation is refused before
    // any existing state descriptor is changed.
    const initial = await readCheck({ state: [stage.dir], code: check });
    if (initial) return await fail(initial);
    const normalizer = await helper("private-state");
    assertUnchanged(normalizer.file, normalizer.sha256);
    const { stdout } = await run(normalizer.file, [sid, ...protect], { timeout: 120000, maxBuffer: 65536, windowsHide: true });
    const said = String(stdout).trim();
    if (said !== "ok") {
      const match = /^open (\d{1,2}) (ace|owner|reparse|limit|missing|error|hardlink|ancestor|write|deny|complex|access|sharing|changed|path) ([A-Za-z0-9+/]+={0,2})$/.exec(said);
      if (!match || Number(match[1]) >= protect.length) return await fail(refused(UNCHECKED));
      const bytes = Buffer.from(match[3], "base64");
      if (bytes.toString("base64") !== match[3]) return await fail(refused(UNCHECKED));
      const file = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!windowsPath(file) && !/^[A-Za-z]:\\$/.test(file)) return await fail(refused(UNCHECKED));
      return await fail(refused(`Reach's folder ${file} ${PROBLEMS[match[2]]}`));
    }
    const files = [];
    for (const kind of helpers) files.push((await helper(kind)).file);
    const final = await readCheck({ state: [...protect, stage.dir], code: check, files });
    if (final) return await fail(final);
    verified = true;
    return { ok: true, sid, nativeDir: stage.dir, privatePaths: [...new Set([stage.privateRoot, stage.dir].filter(Boolean))], dispose,
      activate: () => {
        if (closed) throw Error("Reach's private helper folder has closed.");
        unregister ||= registerWindowsBuildDirectory({ roots: [...protect, nativeDir], dir: stage.dir });
      },
      helper: kind => () => helper(kind) };
  } catch (error) {
    return await fail(refused(error?.code === "ECHANGED" ? UNCHECKED : `Reach couldn't prepare its folder check (${error.message})`));
  }
}
