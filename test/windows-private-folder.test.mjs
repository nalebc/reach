import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountSid, ensurePrivateFolders } from "../server/windows-private-folder.mjs";
import { spawnVerified, windowsHelper } from "../server/desktop-native.mjs";

// Reach's folders on Windows made as private as 0700 makes them on a Mac, and
// checked by a checker compiled just now (docs/parity/D-public-door.md §4.5).
// Off Windows: whoami, icacls, csc and the checker are stand-ins that record
// their arguments; the real ones run in test/windows-tailscaled-peer.test.mjs.
const env = { SystemRoot: String.raw`C:\Windows` };
const system = String.raw`C:\Windows\System32`;
const fx64 = String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319`;
const SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const folder = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-private-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
// csc.exe: writes /out: (its source's name inside, so builds differ).
const csc = () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    const source = args.at(-1);
    await fs.writeFile(args.find((arg) => arg.startsWith("/out:")).slice(5), `MZ ${path.basename(source)} ${calls.length}`);
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
};
const builder = (compiler) => (kind, options) =>
  windowsHelper(kind, { ...options, platform: "win32", env, run: compiler.run, exists: (file) => file === path.win32.join(fx64, "csc.exe") });
// whoami, icacls and the checker: answers by program.
const programs = ({ whoami = `"desktop-7\\owner","${SID}"\r\n`, icacls = () => ({ stdout: "" }), checker = () => "ok\r\n" } = {}) => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === path.win32.join(system, "whoami.exe")) return { stdout: whoami };
    if (file === path.win32.join(system, "icacls.exe")) return icacls(args);
    if (/reach-private-folder-[0-9a-f]{12}-[0-9a-f]{8}\.exe$/.test(file)) return { stdout: checker(args) };
    throw Error(`unexpected ${file}`);
  };
  return { run, calls };
};
const setup = async (t, answers = {}) => {
  const root = await folder(t);
  const state = path.join(root, "state");
  const data = path.join(state, "quick");
  const nativeDir = path.join(state, "native");
  const code = path.join(root, "code");
  const compiler = csc();
  const run = programs(answers);
  const options = { protect: [state, data], check: [code], nativeDir, helpers: ["tailscaled-peer"], run: run.run, build: builder(compiler), platform: "win32", env };
  return { root, state, data, nativeDir, code, compiler, run, options };
};

test("the account is read from whoami's CSV by its SID only, whatever the account's name", () => {
  assert.equal(accountSid(`"desktop-7\\owner","${SID}"\r\n`), SID);
  // Localized and odd names: commas, quotes' neighbours, non-Latin letters.
  assert.equal(accountSid(`"PC\\Jürgen, Müller (Büro)","${SID}"`), SID);
  assert.equal(accountSid(`"ПК\\Пользователь","${SID}"\n`), SID);
  for (const bad of ["", "garbage", `"NT AUTHORITY\\SYSTEM","S-1-5-18"`, `"x","S-1-12-1-1-2-3-4"`, `"x","S-1-5-21-1-2-3"`, `"x","S-1-5-21-1-2-3-4 "`, `"x","S-1-5-21-1-2-3-4-5"`])
    assert.equal(accountSid(bad), "", bad);
});

test("Reach's state and data folders are tightened with SIDs only, inheritance removed, every launch", async (t) => {
  const s = await setup(t);
  const result = await ensurePrivateFolders(s.options);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sid, SID);
  const [whoami, ...rest] = s.run.calls;
  assert.equal(whoami.file, path.win32.join(system, "whoami.exe"));
  assert.deepEqual(whoami.args, ["/user", "/fo", "csv", "/nh"]);
  const icacls = rest.filter((c) => c.file === path.win32.join(system, "icacls.exe"));
  assert.deepEqual(icacls.map((c) => c.args), [s.state, s.data].map((dir) => [
    dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", `*${SID}:(OI)(CI)F`, "/Q",
  ]));
  // Made if missing; Reach's code is never changed, only checked.
  assert.ok(existsSync(s.data));
  assert.ok(!icacls.some((c) => c.args[0] === s.code));
  // The checker was given every folder and the cached helper, in order.
  const checker = s.run.calls.at(-1);
  const helper = (await result.helper("tailscaled-peer")());
  assert.deepEqual(checker.args, [SID, "state", s.state, s.data, "code", s.code, "file", helper.file]);
  assert.equal(path.dirname(helper.file), s.nativeDir);
  assert.match(helper.sha256, /^[0-9a-f]{64}$/);
});

test("a folder icacls couldn't tighten, or an account Reach can't name, refuses browser sign-in", async (t) => {
  const failing = await setup(t, { icacls: () => { throw Object.assign(Error("Command failed"), { code: 5 }); } });
  const refused = await ensurePrivateFolders(failing.options);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, `Reach couldn't make its folder ${failing.state} private to your Windows account, so browser sign-in stays off.`);
  assert.equal(failing.compiler.calls.length, 0, "nothing built in a folder left open");
  for (const whoami of [`"NT AUTHORITY\\SYSTEM","S-1-5-18"`, `"AzureAD\\Owner","S-1-12-1-1-2-3-4"`, ""]) {
    const s = await setup(t, { whoami });
    const result = await ensurePrivateFolders(s.options);
    assert.deepEqual(result, { ok: false, problem: "Reach couldn't tell which Windows account it runs as", reason: "Reach couldn't tell which Windows account it runs as, so browser sign-in stays off." });
    assert.ok(!s.run.calls.some((c) => c.file.endsWith("icacls.exe")));
  }
  const noWindows = await setup(t);
  assert.match((await ensurePrivateFolders({ ...noWindows.options, env: {} })).reason, /couldn't find the Windows folder/);
  assert.deepEqual(await ensurePrivateFolders({ ...noWindows.options, platform: "darwin" }), { ok: false, problem: "Windows only.", reason: "Windows only." });
});

test("the checker is compiled fresh on every call; older checkers are removed; the cached helper is built once", async (t) => {
  const s = await setup(t);
  await fs.mkdir(s.nativeDir, { recursive: true });
  await fs.writeFile(path.join(s.nativeDir, "reach-private-folder-aaaaaaaaaaaa-0badc0de.exe"), "planted");
  await fs.writeFile(path.join(s.nativeDir, "notes.txt"), "kept");
  const first = await ensurePrivateFolders(s.options);
  const second = await ensurePrivateFolders(s.options);
  assert.equal(first.ok && second.ok, true);
  const checkers = s.run.calls.filter((c) => /reach-private-folder-/.test(c.file)).map((c) => c.file);
  assert.equal(checkers.length, 2);
  assert.notEqual(checkers[0], checkers[1], "a new name each time");
  const names = await fs.readdir(s.nativeDir);
  assert.deepEqual(names.filter((n) => n.startsWith("reach-private-folder-")), [path.basename(checkers[1])]);
  assert.ok(names.includes("notes.txt"));
  // private-folder twice, tailscaled-peer once (then reused with its hash).
  const built = s.compiler.calls.map((args) => path.basename(args.at(-1)));
  assert.deepEqual(built.sort(), ["private-folder.cs", "private-folder.cs", "tailscaled-peer.cs"]);
  assert.deepEqual(await first.helper("tailscaled-peer")(), await second.helper("tailscaled-peer")());
});

test("anything the checker finds open refuses, naming the folder; Reach's code is told how to fix", async (t) => {
  const s = await setup(t);
  const answer = async (line) => {
    const run = programs({ checker: () => `${line}\r\n` });
    return ensurePrivateFolders({ ...s.options, run: run.run });
  };
  const off = "so browser sign-in stays off.";
  assert.equal((await answer("open 0 ace")).reason, `Reach's folder ${s.state} can be read or changed by other people on this PC, ${off}`);
  assert.equal((await answer("open 1 owner")).reason, `Reach's folder ${s.data} belongs to another account on this PC, ${off}`);
  assert.equal((await answer("open 0 reparse")).reason, `Reach's folder ${s.state} leads somewhere else on this PC (a link or junction), ${off}`);
  assert.equal((await answer("open 0 limit")).reason, `Reach's folder ${s.state} holds too many files to check, ${off}`);
  assert.equal((await answer("open 2 ace")).reason, `Reach's folder ${s.code} can be changed by other people on this PC, ${off} Move it into your user folder, or install Reach with npm.`);
  assert.equal((await answer("open 2 owner")).reason, `Reach's folder ${s.code} belongs to another account on this PC, ${off} Move it into your user folder, or install Reach with npm.`);
  // What's wrong, without what it turns off for sign-in: agents' helpers say it their own way.
  const code = await answer("open 2 ace");
  assert.equal(code.problem, `Reach's folder ${s.code} can be changed by other people on this PC`);
  assert.equal(code.advice, "Move it into your user folder, or install Reach with npm.");
  assert.equal((await answer("open 0 ace")).problem, `Reach's folder ${s.state} can be read or changed by other people on this PC`);
  const helper = await answer("open 3 ace");
  assert.match(helper.reason, /^Reach's helper .*reach-tailscaled-peer-[0-9a-f]{12}\.exe can be read or changed by other people on this PC/);
  for (const line of ["open 4 ace", "open 0 weird", "", "OK", "ok but", "open -1 ace", "open 99999 ace"])
    assert.equal((await answer(line)).reason, `Reach couldn't check who can use its folders on this PC, ${off}`, line);
  assert.equal((await answer("ok")).ok, true);
});

test("a checker or helper changed on disk after its build is never run", async (t) => {
  const s = await setup(t);
  // The checker swapped between its build and its run: refused before running.
  const build = builder(s.compiler);
  const swapping = async (kind, options) => {
    const built = await build(kind, options);
    if (kind === "private-folder") await fs.writeFile(built.file, "MZ swapped");
    return built;
  };
  const refused = await ensurePrivateFolders({ ...s.options, build: swapping });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /couldn't check who can use its folders/);
  assert.ok(!s.run.calls.some((c) => /reach-private-folder-/.test(c.file)), "never run");
});

test("a cached helper whose noted hash doesn't match is built again; spawnVerified refuses a changed file", async (t) => {
  const dir = await folder(t);
  const compiler = csc();
  const build = builder(compiler);
  const first = await build("tailscaled-peer", { dir });
  assert.equal(readFileSync(first.file.replace(/\.exe$/, ".sha256"), "utf8"), `${first.sha256}\n`);
  assert.deepEqual(await build("tailscaled-peer", { dir }), first, "reused while its hash holds");
  assert.equal(compiler.calls.length, 1);
  // Replaced on disk: built again, with a new note.
  await fs.writeFile(first.file, "MZ replaced");
  const again = await build("tailscaled-peer", { dir });
  assert.equal(compiler.calls.length, 2);
  assert.equal(again.file, first.file);
  assert.notEqual(again.sha256, first.sha256);
  // No note at all (an older build): built again too.
  await fs.rm(first.file.replace(/\.exe$/, ".sha256"));
  await build("tailscaled-peer", { dir });
  assert.equal(compiler.calls.length, 3);
  // A security helper is only ever built in a named private folder.
  await assert.rejects(windowsHelper("tailscaled-peer", {}), /private folder/);
  // Started only with the hash it was built with.
  const started = [];
  const start = (...args) => (started.push(args), { pid: 1 });
  const current = await build("tailscaled-peer", { dir });
  spawnVerified(current.file, current.sha256, ["x"], { windowsHide: true }, { start });
  assert.deepEqual(started, [[current.file, ["x"], { windowsHide: true }]]);
  await fs.writeFile(current.file, "MZ evil");
  assert.throws(() => spawnVerified(current.file, current.sha256, [], {}, { start }), { message: "Reach's helper changed on disk." });
  assert.throws(() => spawnVerified(current.file, "", [], {}, { start }), { message: "Reach's helper changed on disk." });
  assert.throws(() => spawnVerified(path.join(dir, "missing.exe"), current.sha256, [], {}, { start }), { message: "Reach's helper changed on disk." });
  assert.equal(started.length, 1);
});

test("private-folder.cs only reads permissions, owners and attributes", async () => {
  const source = await fs.readFile(new URL("../scripts/native/private-folder.cs", import.meta.url), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");
  for (const word of ["File.Write", "File.Create", "File.Delete", "File.Move", "File.Copy", "File.Open", "File.Set", "File.Append",
    "Directory.Create", "Directory.Delete", "Directory.Move", "Directory.Set", "SetAccessControl", "FileStream", "StreamWriter",
    "Process", "GetEnvironmentVariable", "Registry", "Socket", "WebClient", "DllImport"])
    assert.ok(!code.includes(word), word);
  for (const word of ["GetAccessControl", "GetOwner", "GetAccessRules", "FileAttributes.ReparsePoint", "S-1-5-18", "S-1-5-32-544"])
    assert.ok(code.includes(word), word);
  // C# 5: the .NET Framework's own compiler.
  for (const later of [/[\s=(,]\$"/, /\?\./, /\?\[/, /\bnameof\(/, /=>/, /\bstatic\s+using\b/]) assert.doesNotMatch(code, later);
});
