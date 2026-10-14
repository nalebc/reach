import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cscCandidates } from "../server/desktop-native.mjs";

// The Windows sandbox escape suite (docs/parity/C-sandbox.md §9.3, §9.4), run as
// a STANDARD, non-elevated local user — GitHub's runners are an elevated admin,
// where escape tests would pass for the wrong reasons (finding 16). It compiles
// scripts/native/sandbox.cs with the PC's own csc.exe, then drives it as that
// user (test/fixtures/windows/drive-sandbox.mjs via run-as.cs) against a scratch
// folder with planted secrets. Only on a disposable CI runner: it creates a
// local user and refuses if one exists. REACH_TEST_WINDOWS_DESKTOP=1, CI=true.
const enabled = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1" && process.env.CI === "true";
const skip = enabled ? false : "a real Windows CI runner only (REACH_TEST_WINDOWS_DESKTOP=1, CI=true)";
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures", "windows");
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const ROOT = "C:\\ReachSandboxCI";
const system = (name) => path.win32.join(SYSTEM32, name);
const password = () => `${crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x")}Aa1!`;

const run = async (file, args, options = {}) => {
  try { const { stdout, stderr } = await exec(file, args, { windowsHide: true, maxBuffer: 8 << 20, timeout: 180000, ...options }); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout || "", stderr: error.stderr || String(error.message) }; }
};
async function compile(source, out, references = []) {
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "csc.exe");
  const framework = path.win32.dirname(csc);
  const built = await run(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", `/out:${out}`,
    ...["System.dll", ...references].map((name) => `/reference:${path.win32.join(framework, name)}`), source]);
  assert.equal(built.code, 0, `${path.basename(source)}: ${built.stdout}${built.stderr}`);
}

test("a sandboxed job runs in its grant but can't touch Reach's data or a folder it wasn't granted", { skip, timeout: 1500000 }, async (t) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const sandbox = path.join(ROOT, "reach-sandbox.exe");
  const runAs = path.join(ROOT, "run-as.exe");
  await compile(path.join(repo, "scripts", "native", "sandbox.cs"), sandbox);
  await compile(path.join(fixtures, "run-as.cs"), runAs);

  const user = "reachsbx";
  const existing = await run(system("net.exe"), ["user", user]);
  assert.notEqual(existing.code, 0, "a leftover reachsbx user exists; refusing to touch it");
  const pw = password();
  assert.equal((await run(system("net.exe"), ["user", user, pw, "/add", "/Y"])).code, 0);
  const sid = (await run(runAs, ["sid", user])).stdout.trim();
  assert.equal((await run(runAs, ["desktop", "grant", sid])).code, 0);
  let rightsAdded = false;
  t.after(async () => {
    if (sid) await run(runAs, ["desktop", "revoke", sid]);
    if (rightsAdded) await run(runAs, ["logon-right", "remove", user]);
    await run(system("net.exe"), ["user", user, "/delete"]);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  // The user's own scratch: a granted project, and a "reach data" folder that
  // stands in for a secret in the deny set (never granted).
  const home = `C:\\Users\\${user}`;
  const project = path.join(home, "Projects", "acme");
  const secretDir = path.join(home, ".reach");
  const asUser = async (commandLine, dir = ROOT) => {
    let started = await run(runAs, ["run", user, pw, dir, "wait", commandLine]);
    if (/error 1385/.test(started.stdout) && !rightsAdded) { assert.equal((await run(runAs, ["logon-right", "add", user])).code, 0); rightsAdded = true; started = await run(runAs, ["run", user, pw, dir, "wait", commandLine]); }
    assert.equal(started.code, 0, `run as ${user}: ${started.stdout}${started.stderr}`);
    return started;
  };
  const q = (v) => `"${v}"`;
  const node = q(process.execPath);
  const driver = q(path.join(fixtures, "drive-sandbox.mjs"));
  let n = 0;
  const drive = async (entries) => {
    const spec = path.join(ROOT, `spec-${n}.json`), outFile = path.join(ROOT, `out-${n++}.json`);
    fs.writeFileSync(spec, JSON.stringify({ entries }));
    fs.rmSync(outFile, { force: true });
    await asUser(`${node} ${driver} ${q(sandbox)} ${q(spec)} ${q(outFile)}`, repo);
    return JSON.parse(fs.readFileSync(outFile, "utf8"));
  };
  // Create the folders as the user, and plant a secret.
  await asUser(`cmd.exe /c mkdir ${q(project)} & mkdir ${q(secretDir)} & echo TOPSECRET> ${q(path.join(secretDir, "clients.json"))}`);

  const jobEntries = (command, cwd) => [["mode", "jobs"], ["client", user], ["interpreter", "cmd.exe"],
    ["command", command], ["cwd", cwd], ["timeoutMs", "60000"], ["network", "internet"], ["activeProcesses", "512"],
    ["grant", project.toLowerCase()], ["grantAccess", "rw"], ["deny", secretDir.toLowerCase()], ["capability", "internetClient"]];

  await t.test("it runs in its granted folder", async () => {
    const out = await drive(jobEntries("echo hello> made.txt & type made.txt", project));
    t.diagnostic(JSON.stringify(out));
    assert.equal(out.started, true);
    assert.equal(out.exit, 0, out.stderr);
    assert.match(out.stdout, /hello/);
    assert.ok(fs.existsSync(path.join(project, "made.txt")), "the file was written in the grant");
  });

  await t.test("it can't read Reach's data (a deny-set secret)", async () => {
    const out = await drive(jobEntries(`type ${q(path.join(secretDir, "clients.json"))}`, project));
    t.diagnostic(JSON.stringify(out));
    // Either the preflight refused the launch, or the read failed; never the secret.
    assert.doesNotMatch(out.stdout, /TOPSECRET/, "the sandboxed job read Reach's data");
    assert.equal(fs.readFileSync(path.join(secretDir, "clients.json"), "utf8").trim(), "TOPSECRET");
  });

  await t.test("it can't write into a folder it wasn't granted (deny-default)", async () => {
    const out = await drive(jobEntries(`echo planted> ${q(path.join(secretDir, "planted.txt"))} & dir ${q(secretDir)}`, project));
    t.diagnostic(JSON.stringify(out));
    assert.ok(!fs.existsSync(path.join(secretDir, "planted.txt")), "a non-granted folder was writable");
  });
});
