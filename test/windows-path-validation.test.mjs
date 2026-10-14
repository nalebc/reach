import test from "node:test";
import assert from "node:assert/strict";
import { rejectOutsidePaths, rejectProtectedProgram } from "../server/browser-scripts.mjs";
import { validateBrowserRoot } from "../server/browser-private-paths.mjs";

// One case per bypass string the first-draft review found passing on Windows
// (docs/parity/C-sandbox.md finding 12). Pure path logic with an injected
// platform; no filesystem, so it runs on any host.
const WIN = { platform: "win32", home: "C:\\Users\\me" };
const root = "C:\\Users\\me\\Projects\\acme";
const cwd = root;
const refused = (arg) => assert.throws(() => rejectOutsidePaths([arg], cwd, root, WIN), { status: 403 }, arg);
const allowed = (arg) => assert.doesNotThrow(() => rejectOutsidePaths([arg], cwd, root, WIN), arg);

test("script arguments that leave the shared folder are refused on Windows", () => {
  for (const bypass of [
    "C:\\Users\\me\\.ssh\\id_rsa",   // drive-absolute, outside
    "..\\..\\x",                       // backslash-relative escape
    "C:/Windows/System32/x",          // forward-slash drive
    "\\\\host\\share\\x",             // UNC
    "\\Windows\\System32",            // root-relative, outside
    "~\\.ssh\\id_rsa",               // home, outside the root
    "C:\\Users\\me\\Projects\\other\\x", // sibling project
    "C:\\PROGRA~1\\x",               // 8.3 short alias
    "sub\\..\\..\\outside",           // normalises out of the root
  ]) refused(bypass);
});

test("script arguments inside the shared folder are allowed on Windows", () => {
  for (const arg of ["file.txt", "sub\\a.txt", ".\\a", "C:\\Users\\me\\Projects\\acme\\deep\\x", "sub\\deep", "-Force", "--max-old-space-size=256"]) allowed(arg);
  // A flag whose value stays inside is allowed; one that escapes is refused.
  allowed("--out=sub\\a.txt");
  refused("--out=..\\..\\secret");
});

test("protected programs are refused on Windows whatever their extension or case", () => {
  for (const program of ["C:\\x\\reach.cmd", "tailscale.exe", "REACH-AGENT.EXE", "C:\\Program Files\\Tailscale\\tailscaled.exe", "reach.exe"])
    assert.throws(() => rejectProtectedProgram(program, WIN), { status: 403 }, program);
  for (const program of ["node.exe", "C:\\x\\git.exe", "python.exe", "cmd.exe"])
    assert.doesNotThrow(() => rejectProtectedProgram(program, WIN), program);
});

test("validateBrowserRoot refuses drive roots, Home, its ancestors and Windows' protected roots", () => {
  const base = { platform: "win32", home: "C:\\Users\\me", runtime: "C:\\Program Files\\nodejs\\node.exe",
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } };
  for (const bad of ["C:\\", "c:\\", "C:\\Users\\me", "C:\\Users", "C:\\Windows", "C:\\Windows\\System32",
    "C:\\Program Files", "C:\\Program Files (x86)\\x", "C:\\ProgramData\\vendor", "C:\\Program Files\\nodejs",
    "C:\\Users\\me\\AppData\\Local\\Programs\\app", "\\\\server\\share\\", "C:\\Users\\me\\Applications"])
    assert.throws(() => validateBrowserRoot(bad, base), { status: 403 }, bad);
  // A legitimate deep folder (a Windows TEMP has an 8.3 component) is accepted;
  // the owner's pick is realpath-expanded upstream and the broker verifies 8.3.
  assert.equal(validateBrowserRoot("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\reach-x\\shared", base), "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\reach-x\\shared");
  // A project folder is accepted, returned unchanged so the caller's identity
  // check (validateBrowserRoot(root) === root) holds; case is folded only for
  // the refuse-comparisons and in the helper.
  assert.equal(validateBrowserRoot("C:\\Users\\me\\Projects\\acme", base), "C:\\Users\\me\\Projects\\acme");
  // A different-case spelling of a protected root is still refused.
  assert.throws(() => validateBrowserRoot("c:\\program files\\x", base), { status: 403 });
  // Full control may share the exact drive/Home it advertises.
  assert.equal(validateBrowserRoot("C:\\", { ...base, policy: { browser: true, preset: "full" } }), "C:\\");
  assert.equal(validateBrowserRoot("C:\\Users\\me", { ...base, policy: { browser: true, preset: "readonly" } }), "C:\\Users\\me");
});

import { relative } from "../server/browser-file-boundary.mjs";

test("the file broker's relative() refuses Windows escapes and awkward component names (§7.2)", () => {
  const ok = (v) => assert.equal(relative(v, { platform: "win32" }), true, v);
  const no = (v) => assert.equal(relative(v, { platform: "win32" }), false, v);
  for (const v of ["notes.txt", "sub\\a.txt", "sub/a.txt", "deep\\deeper\\x"]) ok(v);
  for (const v of [
    "C:\\Users\\me\\x",       // drive-absolute
    "C:x",                     // drive-relative
    "\\\\host\\share",        // UNC
    "..\\x",                   // parent escape
    "sub\\..\\..\\x",         // normalises out
    "a:stream",                // alternate data stream
    "file.txt:$DATA",         // stream on a component
    "CON",                     // reserved device
    "nul.txt",                 // reserved device with extension
    "LPT1",                    // reserved device
    "name.",                   // trailing dot (Windows trims it)
    "name ",                   // trailing space
    "a\\b.\\c",               // trailing dot on an inner component
  ]) no(v);
  // The Mac keeps its own rule: a backslash is an ordinary (refused) character.
  assert.equal(relative("sub\\a.txt", { platform: "darwin" }), false);
  assert.equal(relative("sub/a.txt", { platform: "darwin" }), true);
});
