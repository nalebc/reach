import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cscCandidates } from "../server/desktop-native.mjs";
import { browserPrivateNames } from "../server/browser-private-paths.mjs";

// The Files-broker boundary on a real PC (docs/parity/C-sandbox.md §7, §9.3), as
// a standard, non-elevated user. It compiles scripts/native/sandbox.cs and drives
// its `file` mode (test/fixtures/windows/drive-sandbox.mjs via run-as.cs) against
// a shared folder with a symlink out, a hard link and a private name. Disposable
// runner only. REACH_TEST_WINDOWS_DESKTOP=1, CI=true.
const enabled = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1" && process.env.CI === "true";
const skip = enabled ? false : "a real Windows CI runner only (REACH_TEST_WINDOWS_DESKTOP=1, CI=true)";
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures", "windows");
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const ROOT = "C:\\ReachFilesCI";
const system = (name) => path.win32.join(SYSTEM32, name);
const password = () => `${crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x")}Aa1!`;
const run = async (file, args, options = {}) => {
  try { const { stdout, stderr } = await exec(file, args, { windowsHide: true, maxBuffer: 8 << 20, timeout: 180000, ...options }); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout || "", stderr: error.stderr || String(error.message) }; }
};
async function compile(source, out) {
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "csc.exe");
  const framework = path.win32.dirname(csc);
  const built = await run(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", `/out:${out}`, `/reference:${path.win32.join(framework, "System.dll")}`, source]);
  assert.equal(built.code, 0, `${path.basename(source)}: ${built.stdout}${built.stderr}`);
}

test("the Files broker reads inside the root but follows no link out and refuses private names", { skip, timeout: 1500000 }, async (t) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const sandbox = path.join(ROOT, "reach-sandbox.exe");
  const runAs = path.join(ROOT, "run-as.exe");
  await compile(path.join(repo, "scripts", "native", "sandbox.cs"), sandbox);
  await compile(path.join(fixtures, "run-as.cs"), runAs);
  const user = "reachfb";
  assert.notEqual((await run(system("net.exe"), ["user", user])).code, 0, "a leftover reachfb user exists");
  const pw = password();
  assert.equal((await run(system("net.exe"), ["user", user, pw, "/add", "/Y"])).code, 0);
  const sid = (await run(runAs, ["sid", user])).stdout.trim();
  await run(runAs, ["desktop", "grant", sid]);
  let rightsAdded = false;
  t.after(async () => { if (sid) await run(runAs, ["desktop", "revoke", sid]); if (rightsAdded) await run(runAs, ["logon-right", "remove", user]); await run(system("net.exe"), ["user", user, "/delete"]); fs.rmSync(ROOT, { recursive: true, force: true }); });

  const home = `C:\\Users\\${user}`;
  const root = path.join(home, "shared");
  const outside = path.join(home, "outside");
  // Create the layout and the planted secrets as the user; the symlink needs the
  // runner's privilege, so the elevated test makes it (pointing out of the root).
  const q = (v) => `"${v}"`;
  const asUser = async (commandLine, dir = ROOT) => {
    let started = await run(runAs, ["run", user, pw, dir, "wait", commandLine]);
    if (/error 1385/.test(started.stdout) && !rightsAdded) { await run(runAs, ["logon-right", "add", user]); rightsAdded = true; started = await run(runAs, ["run", user, pw, dir, "wait", commandLine]); }
    assert.equal(started.code, 0, `${started.stdout}${started.stderr}`);
    return started;
  };
  await asUser(`cmd.exe /c mkdir ${q(root)} & mkdir ${q(outside)} & mkdir ${q(path.join(root, ".ssh"))} & echo shared> ${q(path.join(root, "safe.txt"))} & echo secret> ${q(path.join(outside, "secret.txt"))} & echo key> ${q(path.join(root, ".ssh", "id_ed25519"))}`);
  // A directory symlink inside the root pointing outside (made by the runner).
  await run(system("cmd.exe"), ["/c", "mklink", "/d", path.join(root, "escape"), outside]);

  const node = q(process.execPath);
  const driver = q(path.join(fixtures, "drive-sandbox.mjs"));
  let n = 0;
  const drive = async (op, rel, extra = []) => {
    const spec = path.join(ROOT, `fspec-${n}.json`), outFile = path.join(ROOT, `fout-${n++}.json`);
    const entries = [["mode", "file"], ["op", op], ["root", root], ["rootDev", ""], ["rootIno", ""], ["path", rel],
      ["maxBytes", "1048576"], ["maxEntries", "2000"], ["fullControl", "0"], ...browserPrivateNames.map((x) => ["privateName", x]), ...extra];
    fs.writeFileSync(spec, JSON.stringify({ entries }));
    fs.rmSync(outFile, { force: true });
    await asUser(`${node} ${driver} ${q(sandbox)} ${q(spec)} ${q(outFile)}`, repo);
    return JSON.parse(fs.readFileSync(outFile, "utf8"));
  };

  await t.test("reads a file inside the root", async () => {
    const out = await drive("read", "safe.txt");
    t.diagnostic(JSON.stringify(out));
    assert.ok(out.result, out.stderr);
    const result = JSON.parse(out.result);
    assert.equal(Buffer.from(result.data, "base64").toString().trim(), "shared");
  });
  await t.test("refuses to read through a symlink that leaves the root", async () => {
    const out = await drive("read", "escape\\secret.txt");
    t.diagnostic(JSON.stringify(out));
    assert.ok(out.refused, "a read through the escape symlink was not refused");
    assert.ok(!out.result || !/secret/.test(Buffer.from(JSON.parse(out.result).data || "", "base64").toString()), "the outside secret leaked");
  });
  await t.test("refuses a private name inside the root", async () => {
    const out = await drive("read", ".ssh\\id_ed25519");
    t.diagnostic(JSON.stringify(out));
    assert.ok(out.refused, "a private name was not refused");
  });
  await t.test("a listing of the root does not disclose the outside target", async () => {
    const out = await drive("list", "escape");
    t.diagnostic(JSON.stringify(out));
    // Listing the symlink itself is refused (no-reparse open); the outside file is never named.
    assert.ok(out.refused || (out.result && !/secret\.txt/.test(out.result)), "the outside listing leaked");
  });
});
