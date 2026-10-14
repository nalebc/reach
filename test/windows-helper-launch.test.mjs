import test from "node:test";
import assert from "node:assert/strict";
import { blockedByPolicy, POLICY_REFUSAL, smartAppControlState, systemRoot, windowsHelperEnv } from "../server/windows-helper-launch.mjs";

// Why Windows won't run the agent helper Reach built (docs/parity/
// B-desktop-helper.md §3.4), with Windows' own programs as stand-ins: what
// they're asked, by which full path, and what their answers mean. Nothing
// here runs a Windows program.
const env = { SystemRoot: String.raw`C:\Windows` };
const recorder = (answer) => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return answer(file, args);
  };
  return { run, calls };
};

test("the Windows folder comes from the environment only when it's one absolute drive path", () => {
  assert.equal(systemRoot({ SystemRoot: String.raw`D:\WINNT` }), String.raw`D:\WINNT`);
  assert.equal(systemRoot({ windir: String.raw`E:\Windows` }), String.raw`E:\Windows`);
  for (const bad of [{}, { SystemRoot: "Windows" }, { SystemRoot: String.raw`\\server\Windows` }, { SystemRoot: "/tmp" }, { SystemRoot: String.raw`C:\Windows\..\Temp` }])
    assert.equal(systemRoot(bad), String.raw`C:\Windows`, JSON.stringify(bad));
});

test("Smart App Control is read from the registry by reg.exe in System32, never through a shell", async () => {
  for (const [stdout, state] of [
    ["\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n", 1],
    ["    VerifiedAndReputablePolicyState    REG_DWORD    0x2\r\n", 2],
    ["    VerifiedAndReputablePolicyState    REG_DWORD    0x0\r\n", 0],
    ["ERROR: The system was unable to find the specified registry key or value.", null],
    ["", null],
  ]) {
    const reg = recorder(() => ({ stdout, stderr: "" }));
    assert.equal(await smartAppControlState({ run: reg.run, env }), state, stdout);
    assert.equal(reg.calls[0].file, String.raw`C:\Windows\System32\reg.exe`);
    assert.deepEqual(reg.calls[0].args, ["query", String.raw`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`, "/v", "VerifiedAndReputablePolicyState"]);
    assert.equal(reg.calls[0].options.windowsHide, true);
    assert.equal(reg.calls[0].options.shell, undefined);
  }
  // A value that isn't there makes reg.exe fail: unreadable, not "off".
  const missing = recorder(() => { throw Object.assign(Error("Command failed"), { code: 1 }); });
  assert.equal(await smartAppControlState({ run: missing.run, env }), null);
});

const event = (id, when, text) =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>${id}</EventID><TimeCreated SystemTime='${new Date(when).toISOString()}'/></System><EventData>${text}</EventData></Event>`;

test("a helper Windows blocked is named in its own logs: code integrity, AppLocker or Defender, in the last 30 seconds", async () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const file = String.raw`C:\Users\Me Too\.reach\reach-agent-desktop-0123456789ab.exe`;
  const logs = (entries) => recorder((program, args) => ({ stdout: entries[args[1]] || "", stderr: "" }));
  const integrity = logs({ "Microsoft-Windows-CodeIntegrity/Operational": event(3077, now - 5000, String.raw`\Device\HarddiskVolume3\Users\Me Too\.reach\REACH-AGENT-DESKTOP-0123456789AB.EXE`) });
  assert.equal(await blockedByPolicy(file, { run: integrity.run, env, now: () => now }), true);
  assert.equal(integrity.calls[0].file, String.raw`C:\Windows\System32\wevtutil.exe`);
  assert.deepEqual(integrity.calls[0].args, ["qe", "Microsoft-Windows-CodeIntegrity/Operational", "/rd:true", "/c:20", "/f:xml"]);
  const applocker = logs({ "Microsoft-Windows-AppLocker/EXE and DLL": event(8004, now - 1000, "reach-agent-desktop-0123456789ab.exe was prevented from running.") });
  assert.equal(await blockedByPolicy(file, { run: applocker.run, env, now: () => now }), true);
  const defender = logs({ "Microsoft-Windows-Windows Defender/Operational": event(1116, now - 2000, `Path: file:_${file}`) });
  assert.equal(await blockedByPolicy(file, { run: defender.run, env, now: () => now }), true);
  // Too old, another file, another event, or nothing readable: not blocked.
  for (const entries of [
    { "Microsoft-Windows-CodeIntegrity/Operational": event(3077, now - 60000, "reach-agent-desktop-0123456789ab.exe") },
    { "Microsoft-Windows-CodeIntegrity/Operational": event(3077, now - 1000, "reach-owners-0123456789ab.exe") },
    { "Microsoft-Windows-CodeIntegrity/Operational": event(3089, now - 1000, "reach-agent-desktop-0123456789ab.exe") },
    {},
  ]) {
    const quiet = logs(entries);
    assert.equal(await blockedByPolicy(file, { run: quiet.run, env, now: () => now }), false, JSON.stringify(entries));
    assert.equal(quiet.calls.length, 3, "every log is read");
  }
  const unreadable = recorder(() => { throw Object.assign(Error("Access is denied."), { code: 5 }); });
  assert.equal(await blockedByPolicy(file, { run: unreadable.run, env, now: () => now }), false);
  assert.match(POLICY_REFUSAL, /application control/);
});

test("the helper's environment is Windows' and the user's folders only: no runtime switches, PATH the Windows folder", () => {
  const given = {
    SystemRoot: String.raw`C:\Windows`, windir: String.raw`C:\Windows`, Path: String.raw`C:\Users\me\AppData\Roaming\npm;C:\Windows\System32`,
    ProgramFiles: String.raw`C:\Program Files`, "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`, COMSPEC: String.raw`C:\Windows\system32\cmd.exe`,
    LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`, APPDATA: String.raw`C:\Users\me\AppData\Roaming`, USERPROFILE: String.raw`C:\Users\me`, TEMP: String.raw`C:\Users\me\AppData\Local\Temp`,
    COR_ENABLE_PROFILING: "1", COR_PROFILER: "{00000000-0000-0000-0000-000000000000}", COMPlus_EnableDiagnostics: "1", DOTNET_gcServer: "1", CORECLR_PROFILER: "x",
    REACH_TOKEN: "secret", NODE_OPTIONS: "--require evil.js", ANTHROPIC_API_KEY: "sk-secret",
  };
  const out = windowsHelperEnv(given);
  assert.equal(out.PATH, String.raw`C:\Windows\System32;C:\Windows`);
  assert.equal(out.ProgramFiles, String.raw`C:\Program Files`);
  assert.equal(out["ProgramFiles(x86)"], String.raw`C:\Program Files (x86)`);
  assert.equal(out.ComSpec, String.raw`C:\Windows\system32\cmd.exe`, "found whatever its case");
  assert.equal(out.LOCALAPPDATA, String.raw`C:\Users\me\AppData\Local`);
  for (const key of Object.keys(out)) assert.doesNotMatch(key, /^(COR_|COMPlus_|DOTNET_|CORECLR_|REACH|NODE|ANTHROPIC)/i, key);
  assert.equal(Object.keys(out).filter((key) => key.toLowerCase() === "path").length, 1);
});
