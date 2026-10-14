import test from "node:test";
import assert from "node:assert/strict";
import { commandFor, parseJsonc, splitCommandLine, terminalSettingsFiles, windowsPowerShell, windowsShell, windowsTerminal } from "../server/windows-shell.mjs";
import { powershellCall } from "../server/powershell.mjs";

// Reach's terminals on Windows open the owner's own shell, as a Mac opens
// $SHELL (owner, Oct 12): Windows Terminal's default profile, else PowerShell
// 7, else Windows PowerShell.
const ENV = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\System32;C:\\Tools" };
const [STORE, , PORTABLE] = terminalSettingsFiles({ env: ENV, home: "C:\\Users\\me" });
const SYS = "C:\\Windows\\System32";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const CLASSIC = `${SYS}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const computer = ({ files = {}, programs = [] } = {}) => ({
  env: ENV,
  home: "C:\\Users\\me",
  read: (file) => {
    if (!(file in files)) throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
    return files[file];
  },
  exists: (file) => programs.includes(file),
});

test("Windows Terminal's default profile, its settings read with their comments and trailing commas", () => {
  const settings = `{
    // Windows Terminal writes comments
    "defaultProfile": "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}",
    "profiles": { "defaults": {}, "list": [
      { "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}", "name": "Windows PowerShell", "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", },
      { "guid": "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}", "name": "Command Prompt", "commandline": "%SystemRoot%\\\\System32\\\\cmd.exe" },
      /* a closed note */
    ], },
  }`;
  const shell = windowsShell(computer({ files: { [STORE]: settings }, programs: [`${SYS}\\cmd.exe`, CLASSIC] }));
  assert.deepEqual(shell, { file: `${SYS}\\cmd.exe`, args: "", kind: "cmd", name: "Command Prompt" });
});

test("a profile with its own arguments, a Git Bash profile, PowerShell 7's and a WSL distribution's", () => {
  const settings = (defaultProfile, extra) => JSON.stringify({ defaultProfile, profiles: { list: [extra] } });
  const bash = windowsShell(computer({
    files: { [STORE]: settings("{aaaaaaaa-0000-0000-0000-000000000001}", { guid: "{AAAAAAAA-0000-0000-0000-000000000001}", name: "Git Bash", commandline: '"C:\\Program Files\\Git\\bin\\bash.exe" -i -l' }) },
    programs: ["C:\\Program Files\\Git\\bin\\bash.exe"],
  }));
  assert.deepEqual(bash, { file: "C:\\Program Files\\Git\\bin\\bash.exe", args: "-i -l", kind: "other", name: "Git Bash" });
  const seven = windowsShell(computer({ files: { [STORE]: settings("PowerShell", { guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell", source: "Windows.Terminal.PowershellCore" }) }, programs: [PWSH] }));
  assert.deepEqual(seven, { file: PWSH, args: ["-NoLogo"], kind: "powershell", name: "PowerShell" }, "named by its profile's name");
  const wsl = windowsShell(computer({ files: { [PORTABLE]: settings("{b}", { guid: "{b}", name: "Ubuntu-24.04", source: "Windows.Terminal.Wsl" }) }, programs: [`${SYS}\\wsl.exe`, CLASSIC] }));
  assert.deepEqual(wsl, { file: `${SYS}\\wsl.exe`, args: ["-d", "Ubuntu-24.04"], kind: "other", name: "Ubuntu-24.04" });
  // Windows Terminal's own profiles without a command line in the settings.
  const plain = windowsShell(computer({ files: { [STORE]: settings("{0caa0dad-35be-5f56-a8ff-afceeeaa6101}", { guid: "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}", name: "Command Prompt" }) }, programs: [`${SYS}\\cmd.exe`] }));
  assert.equal(plain.file, `${SYS}\\cmd.exe`);
});

test("no Windows Terminal, an unreadable one, or a profile whose program is gone: PowerShell 7, else Windows PowerShell", () => {
  assert.deepEqual(windowsShell(computer({ programs: [PWSH, CLASSIC] })), { file: PWSH, args: ["-NoLogo"], kind: "powershell", name: "PowerShell" });
  assert.deepEqual(windowsShell(computer({ programs: [CLASSIC] })), { file: CLASSIC, args: ["-NoLogo"], kind: "powershell", name: "Windows PowerShell" });
  assert.deepEqual(windowsShell(computer({ files: { [STORE]: "{ not json" }, programs: [CLASSIC] })).file, CLASSIC);
  const gone = JSON.stringify({ defaultProfile: "{x}", profiles: { list: [{ guid: "{x}", name: "Old", commandline: "D:\\gone\\shell.exe" }] } });
  assert.deepEqual(windowsShell(computer({ files: { [STORE]: gone }, programs: [CLASSIC] })).file, CLASSIC);
  assert.equal(windowsPowerShell(computer({ programs: [] })).file, "powershell.exe", "named, for Windows to find, when even its usual place can't be checked");
  // pwsh on PATH counts too.
  assert.equal(windowsPowerShell(computer({ programs: ["C:\\Tools\\pwsh.exe"] })).file, "C:\\Tools\\pwsh.exe");
});

test("an agent's command written as each shell runs a program by its path; none for another shell", () => {
  assert.equal(commandFor("powershell", '"C:\\Users\\me\\.local\\bin\\claude.exe"', powershellCall), "& 'C:\\Users\\me\\.local\\bin\\claude.exe'");
  assert.equal(commandFor("powershell", '"C:\\node.exe" "C:\\codex\\cli.js"', powershellCall), "& 'C:\\node.exe' 'C:\\codex\\cli.js'");
  assert.equal(commandFor("cmd", '"C:\\Users\\me\\.local\\bin\\claude.exe"', powershellCall), '"C:\\Users\\me\\.local\\bin\\claude.exe"');
  assert.equal(commandFor("other", '"C:\\claude.exe"', powershellCall), null);
});

test("the pieces: JSON with comments, and a command line's program", () => {
  assert.deepEqual(parseJsonc('{"a": "// not a comment", /* x */ "b": [1, 2,], }'), { a: "// not a comment", b: [1, 2] });
  assert.deepEqual(parseJsonc('{"a": "quote \\" inside // still text"}'), { a: 'quote " inside // still text' });
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" -i -l'), { file: "C:\\Program Files\\Git\\bin\\bash.exe", rest: "-i -l" });
  assert.deepEqual(splitCommandLine("cmd.exe /k echo hi"), { file: "cmd.exe", rest: "/k echo hi" });
  assert.equal(splitCommandLine("   "), null);
});

// An install or update types PowerShell's own text (agent-install.mjs): it
// opens PowerShell whatever the owner's shell, or cmd would get PowerShell
// text (found merging OpenClaw's Windows installer, Oct 13).
test("a Reach terminal on Windows: the owner's shell, an agent's command written for it, PowerShell for installs", () => {
  const cmd = { file: "C:\\Windows\\System32\\cmd.exe", args: "", kind: "cmd", name: "Command Prompt" };
  const bash = { file: "C:\\Git\\bin\\bash.exe", args: "-i -l", kind: "other", name: "Git Bash" };
  const ps = { file: "C:\\pwsh.exe", args: ["-NoLogo"], kind: "powershell", name: "PowerShell" };
  const at = (own) => ({ own: () => own, fallback: () => ps, call: powershellCall });
  assert.deepEqual(windowsTerminal({ ...at(cmd) }), { shell: cmd, typed: "" });
  assert.deepEqual(windowsTerminal({ ...at(cmd), command: '"C:\\claude.exe"' }), { shell: cmd, typed: '"C:\\claude.exe"' });
  assert.deepEqual(windowsTerminal({ ...at(bash), command: '"C:\\claude.exe"' }), { shell: ps, typed: "& 'C:\\claude.exe'" });
  const install = "$ErrorActionPreference = 'Stop'; try { irm https://claude.ai/install.ps1 | iex; exit 0 } catch { exit 1 }";
  for (const own of [cmd, bash, ps]) assert.deepEqual(windowsTerminal({ ...at(own), command: install, powershell: true }), { shell: ps, typed: install }, own.name);
});
