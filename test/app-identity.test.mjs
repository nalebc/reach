import test from "node:test";
import assert from "node:assert/strict";
import { appLabel, macAppPath, validAppPath, windowsAppId, windowsCanonicalPath, windowsExePath, windowsFold, windowsPackageName, windowsPath } from "../server/app-identity.mjs";
import { validAppPath as presetsValidAppPath, presetAppsFromCatalog, validPresetPolicy } from "../server/agent-presets.mjs";
import { protectedAppReason, protectedPathReason } from "../server/agent-guard.mjs";

// Agents name apps and files the way their computer does (docs/
// WINDOWS_AGENT_PARITY.md, workstream A): a Mac bundle's POSIX path on any
// host; on Windows only, an .exe's absolute path or a Store app's Start-menu
// id. Strictly: one accepted spelling per app or file, nothing guessed.
const win = { platform: "win32" }, mac = { platform: "darwin" };
const chromeExe = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const calculator = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
const settings = "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";

test("Mac app paths are the same on every platform", () => {
  assert.equal(presetsValidAppPath, validAppPath, "agent-presets hands out the one validator");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(validAppPath("/Applications/Google Chrome.app", { platform }), true);
    for (const app of ["Chrome.app", "C:\\Applications\\Chrome.app", "/Applications/../Chrome.app", "//Applications/Chrome.app", "/Applications/Chrome\\helper.app"])
      assert.equal(validAppPath(app, { platform }), false, `${platform}: ${app}`);
  }
  assert.equal(macAppPath("/Applications/Notes.app"), true);
});

test("on Windows only: an .exe by its absolute path, or a Store app by its Start-menu id", () => {
  const accepted = [chromeExe, String.raw`C:\Windows\System32\notepad.exe`, String.raw`d:\Tools\App.EXE`, String.raw`C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`, calculator, settings,
    "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!App"];
  for (const app of accepted) {
    assert.equal(validAppPath(app, win), true, app);
    assert.equal(validAppPath(app, mac), false, `never on a Mac: ${app}`);
    assert.equal(validAppPath(app, { platform: "linux" }), false, app);
  }
});

test("Windows .exe paths are refused unless they are one plain absolute name for one file", () => {
  const refused = [
    "chrome.exe", String.raw`Program Files\chrome.exe`, String.raw`\Program Files\chrome.exe`, "C:chrome.exe", String.raw`C:\\`, "C:\\",
    String.raw`\\server\share\app.exe`, String.raw`\\?\C:\Tools\app.exe`, String.raw`\\.\C:\Tools\app.exe`, String.raw`\??\C:\Tools\app.exe`,
    "C:/Tools/app.exe", String.raw`C:\Tools/app.exe`, String.raw`C:\Tools\..\Windows\app.exe`, String.raw`C:\Tools\.\app.exe`, String.raw`C:\Tools\\app.exe`,
    String.raw`C:\Tools\app.exe:stream`, String.raw`C:\Tools\app.exe::$DATA`, String.raw`C:\Tools\a*.exe`, String.raw`C:\Tools\a?.exe`, String.raw`C:\Tools\"a".exe`,
    String.raw`C:\Tools\a|b.exe`, String.raw`C:\Tools\a<b.exe`, String.raw`C:\Tools\app.exe.`, String.raw`C:\Tools\app.exe `, String.raw`C:\Tools \app.exe`, String.raw`C:\ Tools\app.exe`,
    String.raw`C:\Tools.\app.exe`, String.raw`C:\Tools\nul.exe`, String.raw`C:\Tools\CON.exe`, String.raw`C:\com1\app.exe`, String.raw`C:\Tools\LPT9.exe`, String.raw`C:\Tools\CONIN$.exe`,
    String.raw`C:\PROGRA~1\Google\chrome.exe`, String.raw`C:\Tools\1PASSW~1.EXE`, String.raw`C:\Tools\app.exe` + "\u0000", String.raw`C:\Tools\a` + "\t" + "b.exe",
    String.raw`C:\Tools\a` + "\u202e" + "exe.txt", String.raw`C:\Tools\app.com`, String.raw`C:\Tools\app.bat`, String.raw`C:\Tools\app.cmd`, String.raw`C:\Tools\app.ps1`,
    String.raw`C:\Tools\app.lnk`, String.raw`C:\Tools\app`, String.raw`C:\Tools\app.exe\\`, `C:\\${"a".repeat(4100)}.exe`, 42, null, undefined, {},
  ];
  for (const app of refused) assert.equal(validAppPath(app, win), false, JSON.stringify(app));
  assert.equal(windowsExePath(chromeExe), true);
});

test("Store app ids are refused unless they are a packaged app's exact id", () => {
  const refused = [
    "Microsoft.WindowsCalculator!App", "Microsoft.WindowsCalculator_8wekyb3d8bbwe", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!",
    "Microsoft.WindowsCalculator_8wekyb3d8bbw!App", "Microsoft.WindowsCalculator_8wekyb3d8bbwee!App", "Microsoft.WindowsCalculator_8wekyb3d8bbwi!App",
    "Microsoft.WindowsCalculator_8WEKYB3D8BBWE!App", "Mi_8wekyb3d8bbwe!App", `${"a".repeat(51)}_8wekyb3d8bbwe!App`, "Microsoft Calculator_8wekyb3d8bbwe!App",
    "Microsoft.WindowsCalculator_8wekyb3d8bbwe!1App", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App.", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App..x",
    "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App!x", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App x", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!" + "A".repeat(65),
    "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App\n", "Chrome", "MSEdge", "Microsoft.Windows.Explorer", String.raw`{6D809377-6AF0-444B-8957-A3773F02200E}\Notepad++\notepad++.exe`,
    "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
  ];
  for (const app of refused) assert.equal(windowsAppId(app), false, JSON.stringify(app));
  assert.equal(windowsAppId("Microsoft.WindowsCalculator_8wekyb3d8bbwe!" + "A".repeat(64)), true);
  assert.equal(windowsPackageName(calculator), "Microsoft.WindowsCalculator");
  assert.equal(windowsPackageName(chromeExe), "");
});

test("an app's own name from its id, for when the catalog gave none", () => {
  assert.equal(appLabel("/Applications/Google Chrome.app", mac), "Google Chrome");
  assert.equal(appLabel(chromeExe, win), "chrome");
  assert.equal(appLabel(String.raw`C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`, win), "WINWORD");
  assert.equal(appLabel(calculator, win), "Microsoft.WindowsCalculator");
  assert.deepEqual(presetAppsFromCatalog([{ id: "/Applications/Notes.app", bundleId: "com.apple.Notes" }], [{ id: "/Applications/Notes.app" }]),
    [{ id: "/Applications/Notes.app", name: "Notes", bundleId: "com.apple.Notes" }]);
});

test("Windows file paths an agent opens: drive-letter absolute, one name for one file", () => {
  for (const file of [String.raw`C:\Users\me\Documents\notes.txt`, String.raw`C:\Users\me\Documents\Q3 report.pdf`, String.raw`E:\Photos\2026\beach.jpg`])
    assert.equal(windowsPath(file), true, file);
  for (const file of ["/Users/me/notes.txt", String.raw`notes.txt`, String.raw`\\nas\home\notes.txt`, String.raw`C:\Users\me\notes.txt:secret`, String.raw`C:\Users\me\..\other\notes.txt`,
    String.raw`C:\Users\me\SSH~1\id_rsa`, String.raw`C:\Users\me\notes.txt.`, "C:/Users/me/notes.txt"])
    assert.equal(windowsPath(file), false, file);
});

test("on Windows, a password manager's .exe or Store package is protected by its file name", () => {
  for (const id of [String.raw`C:\Program Files\1Password\app\8\1Password.exe`, String.raw`C:\Users\me\AppData\Local\Programs\Bitwarden\Bitwarden.exe`,
    String.raw`C:\Program Files\KeePassXC\KeePassXC.exe`, "/Applications/1Password.app"])
    assert.ok(protectedAppReason({ id, name: "" }, win), id);
  assert.match(protectedAppReason({ id: String.raw`C:\Program Files\Tailscale\tailscale-ipn.exe`, name: "" }, win), /Reach and Tailscale/);
  assert.equal(protectedAppReason({ id: chromeExe, name: "Google Chrome" }, win), null);
  assert.equal(protectedAppReason({ id: calculator, name: "Calculator" }, win), null);
  // A Mac keeps reading ids as Mac paths.
  assert.equal(protectedAppReason({ id: String.raw`C:\Program Files\1Password\1Password.exe`, name: "" }, mac), null);
});

test("on Windows, a protected file is protected whatever its letters' case, on any host", () => {
  const options = { protectedPaths: [String.raw`C:\Users\me\.reach`, String.raw`C:\Users\me\code\reach`], home: String.raw`C:\Users\me`, platform: "win32" };
  for (const file of [String.raw`C:\Users\me\.reach\clients.json`, String.raw`c:\USERS\ME\.REACH\clients.json`, String.raw`C:\Users\me\code\Reach\server\index.mjs`,
    String.raw`C:\Users\me\.ssh\id_rsa`, String.raw`C:\Users\me\.SSH\id_rsa`])
    assert.ok(protectedPathReason(file, options), file);
  assert.equal(protectedPathReason(String.raw`C:\Users\me\Documents\notes.txt`, options), null);
  assert.equal(protectedPathReason(String.raw`C:\Users\me\code\reach-notes\a.txt`, options), null, "a sibling folder isn't inside");
  assert.equal(protectedPathReason("notes.txt", options), "Give the file's full path.");
});

test("Windows names: device names whatever spaces end them, no hidden format characters", () => {
  for (const file of [String.raw`C:\Tools\NUL .exe`, String.raw`C:\Tools\nul  .txt`, String.raw`C:\CON .d\notes.txt`, String.raw`C:\Tools\COM1 .exe`, String.raw`C:\Tools\aux .tar.gz`])
    assert.equal(windowsPath(file), false, file);
  assert.equal(validAppPath(String.raw`C:\Tools\NUL .exe`, win), false);
  // Every format character (Cf), a line or paragraph separator, half a surrogate pair.
  for (const hidden of ["\u00ad", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u061c", "\u180e", "\u2029", "\ud800", "\udc00"]) {
    assert.equal(windowsPath(String.raw`C:\Tools\no` + hidden + "tes.txt"), false, JSON.stringify(hidden));
    assert.equal(validAppPath(String.raw`C:\Tools\ch` + hidden + "rome.exe", win), false, JSON.stringify(hidden));
  }
  // Names that merely contain a device name's letters are files.
  for (const file of [String.raw`C:\Tools\nullable.txt`, String.raw`C:\Tools\console.exe`, String.raw`C:\Tools\com10.txt`, String.raw`C:\Users\me\Café\menu.pdf`])
    assert.equal(windowsPath(file), true, file);
});

test("Windows paths and app names compare as Windows compares them: upper-cased, not lower-cased", () => {
  assert.equal(windowsFold("ſ"), windowsFold("S"), "long s is S");
  assert.equal(windowsFold("ı"), windowsFold("I"), "dotless i is I");
  assert.equal(windowsFold("ΟΔΟΣ"), windowsFold("οδοσ"), "final and medial sigma are one letter");
  assert.notEqual("ΟΔΟΣ".toLowerCase(), "οδοσ".toLowerCase(), "lower-casing alone keeps them apart");
  const options = { protectedPaths: [String.raw`C:\Users\me\code\ΟΔΟΣ`], home: String.raw`C:\Users\me`, platform: "win32" };
  for (const file of [String.raw`C:\Users\me\.ſsh\id_rsa`, String.raw`C:\Users\me\code\οδοσ\notes.txt`, String.raw`C:\Users\me\code\Οδος\notes.txt`])
    assert.ok(protectedPathReason(file, options), file);
  assert.ok(protectedAppReason({ id: String.raw`C:\Program Files\Bıtwarden\Bıtwarden.exe`, name: "" }, win), "dotless i");
  assert.equal(protectedAppReason({ id: "/Applications/Bıtwarden.app", name: "" }, mac), null, "a Mac's checks are unchanged");
});

test("a Windows path is one file whatever prefix, trimmed dots or stream it's written with", () => {
  const options = { protectedPaths: [String.raw`C:\Users\me\code\reach`], home: String.raw`C:\Users\me`, platform: "win32" };
  for (const file of [String.raw`\\?\C:\Users\me\code\reach\server\index.mjs`, String.raw`\\.\C:\Users\me\code\reach\x`, String.raw`\??\C:\Users\me\code\reach\x`,
    String.raw`\\localhost\c$\Users\me\code\reach\x`, String.raw`\\127.0.0.1\C$\Users\me\code\reach\x`, String.raw`\\?\UNC\localhost\c$\Users\me\code\reach\x`,
    String.raw`C:\Users\me\code\reach.\x`, String.raw`C:\Users\me\code\reach. .\x`, String.raw`C:\Users\me\code\reach::$INDEX_ALLOCATION\x`,
    String.raw`C:\Users\me\code\reach::$INDEX_ALLOCATION`, String.raw`C:\Users\me\code\reach\x::$DATA`, String.raw`C:\Users\me\.reach.\clients.json`, "C:/Users/me/code/reach/x"])
    assert.ok(protectedPathReason(file, options), file);
  assert.equal(windowsCanonicalPath(String.raw`\\?\C:\Users\Me\Code.\x::$DATA`), String.raw`c:\users\me\code\x`);
  // A short (8.3) alias hides which folder is meant: refused, with how to fix it.
  assert.match(protectedPathReason(String.raw`C:\Users\me\code\REACH~1\x`, options), /full name/);
  assert.match(protectedPathReason(String.raw`C:\PROGRA~1\Tailscale\x`, options), /full name/);
  assert.equal(protectedPathReason(String.raw`C:\Users\me\code\reach-notes\x`, options), null);
});

test("a Windows host takes Windows app ids in stored policies; a Mac never does", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => Object.defineProperty(process, "platform", platform));
  const policy = { invite: true, browser: true, preset: "apps", roots: [], apps: [{ id: chromeExe, name: "Google Chrome", bundleId: "" }, { id: calculator, name: "Calculator", bundleId: "" }] };
  Object.defineProperty(process, "platform", { value: "darwin" });
  assert.equal(validPresetPolicy(policy), false);
  Object.defineProperty(process, "platform", { value: "win32" });
  assert.equal(validPresetPolicy(policy), true);
  assert.equal(validPresetPolicy({ ...policy, apps: [{ id: String.raw`C:\Program Files\1Password\1Password.exe`, name: "1Password" }] }), false, "never a password manager");
  assert.equal(validPresetPolicy({ ...policy, apps: [{ id: String.raw`C:\PROGRA~1\Google\Chrome\Application\chrome.exe` }] }), false);
});

// CodeQL #243: trailing dots and spaces were cut with /[. ]+$/, which retries
// from every space of a long run. A path an agent sends (a command, a file to
// open) held a Windows host's server for seconds (64k spaces: 2.4 s).
test("a long run of spaces in a Windows name is trimmed in linear time, with the same result", () => {
  for (const [file, canonical] of [
    ["C:\\a\\..", "c:\\"], ["C:\\a\\. .\\b", "c:\\a\\b"], ["C:\\a. \\b", "c:\\a\\b"], ["C:\\a:s . \\b", "c:\\a\\b"],
    ["C:\\a\\   \\b", "c:\\a\\b"], ["C:\\a\\b.. . ", "c:\\a\\b"], ["C:\\a\\...  ", "c:\\a\\..."], ["C:\\a\\ . x. .", "c:\\a\\ . x"],
    ["C:\\a\\x\t. ", "c:\\a\\x\t"], ["C:\\a\\.. \\b", "c:\\b"], ["C:\\a\\ ..\\b", "c:\\a\\b"],
  ])
    assert.equal(windowsCanonicalPath(file), canonical, file);
  for (const file of ["C:\\Tools\\NUL   .txt", "C:\\Tools\\nul .x", "C:\\Tools\\COM1 . .txt"]) assert.equal(windowsPath(file), false, file);
  assert.equal(windowsPath("C:\\Tools\\null.txt"), true);
  const started = performance.now();
  windowsCanonicalPath("C:\\x\\" + " ".repeat(64000) + "x");
  windowsPath("C:\\x\\NUL" + " ".repeat(4000) + "x.txt");
  const ms = performance.now() - started;
  assert.ok(ms < 250, `${Math.round(ms)} ms`);
});
