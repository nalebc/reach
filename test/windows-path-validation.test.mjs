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
    "C:\\Users\\me\\AppData\\Local\\Programs\\app", "C:\\PROGRA~1\\acme"])
    assert.throws(() => validateBrowserRoot(bad, base), { status: 403 }, bad);
  // A project folder is accepted, returned as one canonical name.
  assert.equal(validateBrowserRoot("C:\\Users\\me\\Projects\\acme", base), "c:\\users\\me\\projects\\acme");
  // Full control may share the exact drive/Home it advertises.
  assert.equal(validateBrowserRoot("C:\\", { ...base, policy: { browser: true, preset: "full" } }), "c:\\");
  assert.equal(validateBrowserRoot("C:\\Users\\me", { ...base, policy: { browser: true, preset: "readonly" } }), "c:\\users\\me");
});
