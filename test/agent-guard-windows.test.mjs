import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { commandRefusal, nativeRules, protectedAppReason, protectedPage, protectedPathReason, protectedTitle, terminalLikeApp, typedTextRefusal } from "../server/agent-guard.mjs";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { browserPrivatePaths } from "../server/browser-private-paths.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";

// Windows' guard data beside the Mac's, chosen by platform (docs/
// WINDOWS_AGENT_PARITY.md, workstream A). The Mac's rules must not move: the
// fixture is nativeRules' output captured before the Windows data existed.
const win = { platform: "win32" }, mac = { platform: "darwin" };
const macFixture = JSON.parse(fs.readFileSync(new URL("./fixtures/native-rules-mac.json", import.meta.url), "utf8"));
const chrome = { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome", identity: "a".repeat(64) };
const notes = { id: "/System/Applications/Notes.app", name: "Notes", bundleId: "com.apple.Notes" };
const rulesFor = (options) => ({
  full: nativeRules({ preset: "full", hidden: [notes] }, options),
  apps: nativeRules({ preset: "apps", apps: [chrome], hidden: [notes] }, options),
  readonly: nativeRules({ preset: "readonly", hidden: [notes] }, options),
});
// Compared as text: a difference fails without printing 50 KB twice.
const sameJson = (actual, expected, message) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), message);

test("the Mac's native rules are exactly what they were before Windows' data", () => {
  sameJson(rulesFor({ ...macFixture.options, ...mac }), { full: macFixture.full, apps: macFixture.apps, readonly: macFixture.readonly }, "Mac rules changed");
  if (process.platform === "darwin") sameJson(rulesFor(macFixture.options), { full: macFixture.full, apps: macFixture.apps, readonly: macFixture.readonly }, "this Mac's default changed");
});

test("with platform darwin, the guard gives the Mac's answers on any host: POSIX paths, never the host's", () => {
  // On a Windows host, path is path.win32: C:\… would count as absolute and a
  // backslash as a folder break, and a Mac's path checks would change.
  assert.equal(protectedPathReason(String.raw`C:\Users\me\notes.txt`, { ...mac }), "Give the file's full path.");
  assert.equal(protectedPathReason(String.raw`\Users\me\notes.txt`, { ...mac }), "Give the file's full path.");
  const options = { home: "/Users/me", protectedPaths: ["/Users/me/code/reach"], ...mac };
  // A Mac folder may have a backslash in its name: "code\reach" isn't code/reach.
  assert.equal(protectedPathReason(String.raw`/Users/me/code\reach/notes.txt`, options), null);
  assert.ok(protectedPathReason("/Users/me/code/reach/notes.txt", options));
  assert.equal(commandRefusal(String.raw`cat /Users/me/code\reach/notes.txt`, options), null);
  assert.ok(commandRefusal("cat /Users/me/code/reach/notes.txt", options));
  assert.equal(commandRefusal(String.raw`cat C:\Users\me\code\reach\notes.txt`, { home: "/Users/me", protectedPaths: [String.raw`C:\Users\me\code\reach`], ...mac }), null,
    "a Windows root means nothing to a Mac's checks");
});

test("a Windows helper gets the same rule keys, with Windows' lists", () => {
  const windows = rulesFor({ ...macFixture.options, ...win });
  for (const preset of ["full", "apps", "readonly"]) {
    // The Mac's keys, then what the Mac's helper keeps in its own code.
    assert.deepEqual(Object.keys(windows[preset]), [...Object.keys(macFixture[preset]), "programExtensions", "runnerApps"], preset);
    for (const key of ["mode", "hosts", "titles", "allowedApps", "hiddenApps", "reachWords", "protectedPaths", "home"])
      sameJson(windows[preset][key], macFixture[preset][key], `${preset}.${key} is the same everywhere`);
  }
  const rules = windows.apps;
  for (const name of ["consent", "credentialuibroker", "logonui", "taskmgr", "regedit", "mmc", "1password", "bitwarden", "keepass", "keepassxc", "dashlane",
    "lastpass", "nordpass", "keeper", "protonpass", "enpass"])
    assert.ok(rules.protectedAppNames.includes(name), name);
  assert.ok(rules.protectedAppIds.includes("microsoft.sechealthui"));
  for (const pane of ["privacy", "sign-in options", "network", "windows update", "recovery"]) assert.ok(rules.privatePanes.includes(pane), pane);
  for (const word of ["credential manager", "windows security", "task manager", "registry editor", "user account control"]) assert.ok(rules.protectedTitleWords.includes(word), word);
  assert.ok(rules.protectedPagePatterns.some((source) => new RegExp(source, "i").test("ms-settings:signinoptions")));
  for (const shell of ["powershell", "pwsh", "cmd", "wt"]) assert.ok(rules.terminalLike.includes(shell), shell);
  for (const extension of ["exe", "bat", "cmd", "ps1", "vbs", "js", "hta", "lnk", "url", "reg", "msi", "msc", "cpl", "scr", "settingcontent-ms", "appref-ms"])
    assert.ok(rules.programExtensions.includes(extension), extension);
  for (const runner of ["cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "msiexec"]) assert.ok(rules.runnerApps.includes(runner), runner);
  assert.ok([...rules.programExtensions, ...rules.runnerApps].every((entry) => entry === entry.toLowerCase() && !entry.startsWith(".")), "lower case, no dots");
  // Every pattern a helper receives compiles as given.
  for (const source of rules.protectedPagePatterns) assert.doesNotThrow(() => new RegExp(source, "i"), source);
});

test("on Windows, password managers and Windows' security tools are protected by their .exe; ordinary apps aren't", () => {
  const exe = (folder, file) => ({ id: `C:\\Program Files\\${folder}\\${file}`, name: "" });
  for (const app of [exe("1Password", "1Password.exe"), exe("Bitwarden", "Bitwarden.exe"), exe("KeePass Password Safe 2", "KeePass.exe"), exe("KeePassXC", "KeePassXC.exe"),
    exe("Dashlane", "Dashlane.exe"), exe("LastPass", "LastPass.exe"), exe("NordPass", "NordPass.exe"), exe("Keeper", "keeperpasswordmanager.exe"), exe("Proton Pass", "ProtonPass.exe"),
    exe("Enpass", "Enpass.exe"), { id: String.raw`C:\Windows\System32\consent.exe` }, { id: String.raw`C:\Windows\System32\CredentialUIBroker.exe` },
    { id: String.raw`C:\Windows\System32\LogonUI.exe` }, { id: String.raw`C:\Windows\System32\Taskmgr.exe` }, { id: String.raw`C:\Windows\regedit.exe` },
    { id: String.raw`C:\Windows\System32\mmc.exe` }, { id: "Microsoft.SecHealthUI_8wekyb3d8bbwe!SecHealthUI", name: "Windows Security" },
    { id: String.raw`C:\Program Files\Tailscale\tailscale-ipn.exe` }])
    assert.ok(protectedAppReason(app, win), app.id);
  for (const app of [exe(String.raw`Google\Chrome\Application`, "chrome.exe"), { id: String.raw`C:\Windows\System32\notepad.exe` },
    { id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "Calculator" }, { id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", name: "Terminal" }])
    assert.equal(protectedAppReason(app, win), null, app.id);
  // The Mac's lists are the Mac's: Task Manager means nothing there.
  assert.equal(protectedAppReason({ id: "/Applications/Task Manager.app", name: "Task Manager" }, mac), null);
});

test("on Windows, shells, IDEs and WSL are terminals, by .exe, folder or Store package; look-alikes aren't", () => {
  const terminals = [
    { id: String.raw`C:\Program Files\Git\git-bash.exe` }, { id: String.raw`C:\Program Files\Git\bin\bash.exe` }, { id: String.raw`C:\Windows\System32\bash.exe` },
    { id: String.raw`C:\Program Files\Git\usr\bin\mintty.exe` }, { id: String.raw`C:\msys64\msys2.exe` }, { id: String.raw`C:\Windows\System32\wsl.exe` },
    { id: "CanonicalGroupLimited.Ubuntu22.04LTS_79rhkp1fndgsc!ubuntu2204", name: "" }, { id: "CanonicalGroupLimited.Ubuntu_79rhkp1fndgsc!ubuntu", name: "Ubuntu" },
    { id: "TheDebianProject.DebianGNULinux_76v4gfsz19hv4!debian", name: "" }, { id: "KaliLinux.54290C8133FEE_ey8k8hqnwqnmg!kali", name: "" },
    { id: String.raw`C:\Users\me\AppData\Local\Microsoft\WindowsApps\kali.exe` }, { id: String.raw`C:\Users\me\AppData\Local\Microsoft\WindowsApps\ubuntu2204.exe` },
    { id: String.raw`C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\devenv.exe`, name: "" }, { id: String.raw`C:\Program Files\ConEmu\ConEmu64.exe` },
    { id: String.raw`C:\Tools\cmder\Cmder.exe` }, { id: String.raw`C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21_x64__8wekyb3d8bbwe\OpenConsole.exe` },
    { id: String.raw`C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe`, name: "" }, { id: String.raw`D:\Apps\VSCode\Code.exe`, name: "" },
    { id: String.raw`C:\Users\me\AppData\Local\Programs\Microsoft VS Code Insiders\Code - Insiders.exe`, name: "" },
  ];
  for (const app of terminals) assert.equal(terminalLikeApp(app, win), true, app.id);
  for (const app of [{ id: String.raw`C:\Tools\barcode.exe`, name: "Barcode" }, { id: String.raw`C:\Tools\unicode.exe`, name: "" }, { id: String.raw`C:\Users\me\code\app\app.exe`, name: "" },
    { id: String.raw`C:\Tools\bashful.exe`, name: "" }, { id: String.raw`C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`, name: "Word" }])
    assert.equal(terminalLikeApp(app, win), false, app.id);
  // The Mac's list is the Mac's.
  assert.equal(terminalLikeApp({ id: "/Applications/Ubuntu Fonts.app", name: "Ubuntu Fonts" }, mac), false);
  assert.ok(nativeRules({ preset: "apps", apps: [] }, win).terminalLike.includes("devenv"));
});

test("on Windows, the tools that see and stop every process are protected, as Activity Monitor and Console are", () => {
  for (const app of [String.raw`C:\Windows\System32\resmon.exe`, String.raw`C:\Windows\System32\perfmon.exe`, String.raw`C:\Tools\Sysinternals\procexp64.exe`,
    String.raw`C:\Tools\Sysinternals\procexp.exe`, String.raw`C:\Tools\Sysinternals\Procmon64.exe`, String.raw`C:\Program Files\SystemInformer\SystemInformer.exe`,
    String.raw`C:\Program Files\Process Hacker 2\ProcessHacker.exe`, String.raw`C:\Windows\System32\eventvwr.exe`, String.raw`C:\Tools\Sysinternals\Autoruns64.exe`,
    String.raw`C:\Windows\System32\msconfig.exe`, String.raw`C:\Windows\System32\netplwiz.exe`, "Microsoft.YourPhone_8wekyb3d8bbwe!App"])
    assert.ok(protectedAppReason({ id: app, name: "" }, win), app);
  for (const name of ["Resource Monitor", "Performance Monitor", "Process Explorer", "Process Monitor", "System Informer", "Process Hacker", "Event Viewer", "Phone Link"])
    assert.ok(protectedAppReason({ id: String.raw`C:\Tools\x.exe`, name }, win), name);
  for (const title of ["Resource Monitor", "Process Explorer - Sysinternals: www.sysinternals.com [DESKTOP\\me]", "Event Viewer", "System Configuration",
    "Autoruns [DESKTOP\\me] - Sysinternals"])
    assert.equal(protectedTitle(title, win), true, title);
  for (const command of ["resmon", "perfmon /res", "start procexp64", String.raw`C:\Tools\Sysinternals\procmon.exe /accepteula`, "systeminformer", "eventvwr.msc", "msconfig", "netplwiz"])
    assert.ok(commandRefusal(command, win), command);
  assert.equal(protectedAppReason({ id: "/Applications/Process Explorer.app", name: "Process Explorer" }, mac), null, "a Mac's lists are the Mac's");
});

test("on Windows, the Settings pages a Mac keeps closed are closed, by name and by ms-settings: address", () => {
  const rules = nativeRules({ preset: "apps", apps: [] }, win);
  for (const pane of ["accessibility", "startup apps", "lock screen", "your info", "other users", "family", "for developers", "remote desktop", "nearby sharing", "windows backup"])
    assert.ok(rules.privatePanes.includes(pane), pane);
  for (const page of ["ms-settings:easeofaccess-display", "ms-settings:startupapps", "ms-settings:lockscreen", "ms-settings:yourinfo", "ms-settings:emailandaccounts",
    "ms-settings:otherusers", "ms-settings:family-group", "ms-settings:workplace", "ms-settings:backup", "ms-settings:developers", "ms-settings:deviceencryption",
    "ms-settings:findmydevice", "ms-settings:remotedesktop", "ms-settings:optionalfeatures", "ms-settings:mobile-devices", "MS-SETTINGS:RemoteDesktop"])
    assert.equal(protectedPage(page, [], win), true, page);
  for (const page of ["ms-settings:display", "ms-settings:sound", "ms-settings:taskbar", "ms-settings:personalization-background", "ms-settings:bluetooth"])
    assert.equal(protectedPage(page, [], win), false, page);
  assert.ok(commandRefusal("start ms-settings:remotedesktop", win));
});

test("on Windows, protected windows, pages and terminals are Windows' own", () => {
  for (const title of ["Credential Manager", "Windows Security", "Task Manager", "Registry Editor", "User Account Control", "Local Group Policy Editor", "DevTools - example.com"])
    assert.equal(protectedTitle(title, win), true, title);
  assert.equal(protectedTitle("Task Manager", mac), false);
  assert.equal(protectedTitle("Inbox - Outlook", win), false);
  for (const page of ["ms-settings:privacy-webcam", "ms-settings:signinoptions", "ms-settings:network-wifi", "ms-settings:windowsupdate", "ms-settings:recovery",
    "ms-settings:windowsdefender", "windowsdefender://threat", "chrome://password-manager/passwords"])
    assert.equal(protectedPage(page, [], win), true, page);
  for (const page of ["ms-settings:display", "ms-settings:bluetooth", "https://example.com/"]) assert.equal(protectedPage(page, [], win), false, page);
  assert.equal(protectedPage("ms-settings:privacy", [], mac), false, "the Mac's pages are unchanged");
  for (const app of [{ id: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` }, { id: String.raw`C:\Program Files\PowerShell\7\pwsh.exe` },
    { id: String.raw`C:\Windows\System32\cmd.exe`, name: "Command Prompt" }, { id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", name: "Windows Terminal" },
    { id: String.raw`C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe` }])
    assert.equal(terminalLikeApp(app, win), true, app.id);
  for (const app of [{ id: String.raw`C:\Windows\System32\notepad.exe`, name: "Notepad" }, { id: String.raw`C:\Tools\cmdline-viewer.exe`, name: "Viewer" }])
    assert.equal(terminalLikeApp(app, win), false, app.id);
  assert.equal(terminalLikeApp({ id: String.raw`C:\Windows\System32\cmd.exe`, name: "Command Prompt" }, mac), false);
});

test("on Windows, typed commands meet Windows' deny list as well as the shared one", () => {
  const options = { home: String.raw`C:\Users\me`, protectedPaths: [String.raw`C:\Users\me\.reach`], ...win };
  const refused = [
    "runas /user:Administrator cmd", String.raw`reg add HKLM\Software\Example /v Flag /d 1`, String.raw`C:\Windows\System32\REG.EXE query HKLM`,
    "bcdedit /set testsigning on", "netsh advfirewall set allprofiles state off", "sc stop SomeService", "schtasks /create /tn job /tr app.exe /sc daily",
    String.raw`icacls C:\Users\me /grant Everyone:F`, String.raw`takeown /f C:\Windows\System32\example.dll`, "Set-MpPreference -DisableRealtimeMonitoring $true",
    String.raw`Add-MpPreference -ExclusionPath C:\Users\me`, "wmic process list", "vssadmin delete shadows /all", "cipher /w:C:\\", "format D: /q", "diskpart",
    String.raw`Remove-Item -Recurse -Force C:\Windows\System32`, String.raw`Remove-Item 'C:\Program Files\Example' -Recurse`, String.raw`del /s /q C:\Windows\Temp\example`,
    String.raw`rd /s /q "C:\Program Files (x86)\Example"`, String.raw`Remove-Item $env:SystemRoot\System32\drivers\etc\hosts`, String.raw`del %ProgramData%\Example\settings.ini`,
    "rm C:\\", "taskkill /im node.exe /f", "Stop-Process -Name tailscale-ipn", "start taskmgr", "regedit", "mmc gpedit.msc", "gpedit.msc",
    "control /name Microsoft.CredentialManager", "start ms-settings:privacy-webcam", String.raw`cmd /c reg add HKCU\Example`, "dir & reg query HKLM",
    String.raw`type "C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data"`, String.raw`type C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data`,
    String.raw`copy %APPDATA%\Microsoft\Credentials\example C:\temp`, String.raw`Get-Content $env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`,
    String.raw`type C:\Users\me\.reach\clients.json`, String.raw`type c:\USERS\ME\.REACH\clients.json`,
    // The shared list holds on Windows too.
    "sudo ls", "rm -rf ~", "cat ~/.ssh/id_rsa", "tailscale down", "history",
  ];
  for (const command of refused) assert.ok(commandRefusal(command, options), `refuse: ${command}`);
  const allowed = [
    "dir", String.raw`dir C:\Windows`, "git status", "npm test", "node index.mjs", "python script.py", String.raw`Get-ChildItem C:\Users\me\Documents`,
    String.raw`Remove-Item .\build -Recurse`, "del notes.txt", "rd /s /q build", "start https://example.com", "notepad notes.txt", "ipconfig", "Get-Process",
    "echo hello & dir", "cmd /c dir", "ping example.com", String.raw`type C:\Users\me\AppData\Local\Temp\log.txt`, "echo reg",
  ];
  for (const command of allowed) assert.equal(commandRefusal(command, options), null, `allow: ${command}`);
  // Windows' list is Windows': a Mac doesn't read these as commands it refuses.
  for (const command of ["reg add HKLM\\x", "netsh wlan show profiles", "taskkill /im node.exe", "diskpart"])
    assert.equal(commandRefusal(command, { home: "/Users/me", ...mac }), null, command);
  // Typing: a terminal in front gets the deny list; a Settings address anywhere is a protected page.
  assert.ok(typedTextRefusal(String.raw`reg add HKLM\Software\Example`, { terminalLike: true, ...options }));
  assert.equal(typedTextRefusal(String.raw`reg add HKLM\Software\Example`, { terminalLike: false, ...options }), null);
  assert.match(typedTextRefusal("ms-settings:signinoptions", options), /stays closed/);
});

test("on Windows, the files where Windows and its apps keep passwords are protected", () => {
  const options = { home: String.raw`C:\Users\me`, protectedPaths: [], ...win };
  for (const file of [String.raw`C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data`, String.raw`C:\Users\me\AppData\Local\Microsoft\Edge\User Data\Default\Cookies`,
    String.raw`C:\Users\me\AppData\Roaming\Microsoft\Credentials\ABC`, String.raw`C:\Users\me\AppData\Roaming\Microsoft\Protect\S-1-5-21\key`,
    String.raw`C:\Users\me\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`, String.raw`C:\Users\me\AppData\Roaming\Bitwarden\data.json`,
    String.raw`C:\ProgramData\Tailscale\server-state.conf`, String.raw`C:\Windows\System32\config\SAM`])
    assert.ok(protectedPathReason(file, options), file);
  for (const file of [String.raw`C:\Users\me\AppData\Local\Temp\log.txt`, String.raw`C:\Users\me\AppData\Roaming\reachability-notes\a.txt`, String.raw`C:\Users\me\Documents\notes.txt`])
    assert.equal(protectedPathReason(file, options), null, file);
});

// By name, as the Mac's PRIVATE_LIBRARY names ~/Library's secrets: whoever's
// profile they're in, whatever protected folders Reach passes.
test("on Windows, browser profiles, mail, credential stores and startup places are protected by name", () => {
  const options = { home: String.raw`C:\Users\me`, protectedPaths: [], ...win };
  const appData = (rest) => "C:\\Users\\other\\AppData\\" + rest;
  for (const file of [appData(String.raw`Local\Google\Chrome Beta\User Data\Default\Login Data`), appData(String.raw`Local\Chromium\User Data\Default\Cookies`),
    appData(String.raw`Local\BraveSoftware\Brave-Browser\User Data\Default\Login Data`), appData(String.raw`Roaming\Mozilla\Firefox\Profiles\x\logins.json`),
    appData(String.raw`Local\Mozilla\Firefox\Profiles\x\cache2`), appData(String.raw`Roaming\Opera Software\Opera Stable\Login Data`),
    appData(String.raw`Local\Vivaldi\User Data\Default\Login Data`), appData(String.raw`Local\Microsoft\Edge Beta\User Data\Default\Cookies`),
    appData(String.raw`Local\Microsoft\Outlook\me.ost`), appData(String.raw`Roaming\Thunderbird\Profiles\x\key4.db`), appData(String.raw`Local\Comms\Unistore\data`),
    appData(String.raw`Local\Packages\microsoft.windowscommunicationsapps_8wekyb3d8bbwe\LocalState\x`), appData(String.raw`Local\Microsoft\Credentials\x`),
    appData(String.raw`Local\Microsoft\Vault\x`), appData(String.raw`Roaming\Microsoft\Crypto\RSA\x`), appData(String.raw`Roaming\Microsoft\SystemCertificates\My\x`),
    appData(String.raw`Roaming\Microsoft\Windows\Start Menu\Programs\Startup\run.lnk`), appData(String.raw`Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`),
    appData(String.raw`Roaming\KeePass\KeePass.config.xml`), appData(String.raw`Local\1Password\data\1password.sqlite`), appData(String.raw`Roaming\GitHub CLI\hosts.yml`),
    String.raw`C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\run.lnk`, String.raw`C:\Windows\System32\Tasks\job`,
    String.raw`C:\Program Files\Tailscale\tailscaled.exe`, String.raw`C:\Users\me\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`,
    String.raw`C:\Users\me\OneDrive\Documents\WindowsPowerShell\profile.ps1`, String.raw`D:\Scripts\WindowsPowerShell\Microsoft.PowerShellISE_profile.ps1`])
    assert.ok(protectedPathReason(file, options), file);
  for (const file of [appData(String.raw`Local\Programs\Microsoft VS Code\Code.exe`), String.raw`C:\Users\me\Documents\PowerShellScripts\build.ps1`,
    String.raw`C:\Users\me\Documents\keeper-notes.txt`, String.raw`C:\Program Files\Tailscaled-notes\x`])
    assert.equal(protectedPathReason(file, options), null, file);
});

// As a whole, as ~/Library: Reach passes AppData among its protected
// folders (browserPrivatePaths), and a command's own names for it
// (%APPDATA%, $env:LOCALAPPDATA, ~\AppData, %USERPROFILE%\AppData) are read.
test("on Windows, AppData is protected as a whole, whatever name a command gives it", () => {
  const home = String.raw`C:\Users\me`;
  const protectedPaths = browserPrivatePaths({ dataDir: String.raw`C:\Users\me\.reach` }, { home, appRoot: String.raw`C:\Users\me\code\reach`, env: {}, ...win });
  const options = { home, protectedPaths, ...win };
  for (const file of [String.raw`C:\Users\me\AppData\Local\Temp\log.txt`, String.raw`C:\Users\me\AppData\Roaming\SomeApp\token.json`, String.raw`c:\users\me\APPDATA\locallow\x`])
    assert.ok(protectedPathReason(file, options), file);
  for (const command of [String.raw`type %APPDATA%\SomeApp\token.json`, String.raw`Get-Content $env:LOCALAPPDATA\SomeApp\token.json`, "gc ${env:APPDATA}\\x",
    String.raw`type ~\AppData\Roaming\SomeApp\token.json`, String.raw`type $HOME\AppData\Local\x`, String.raw`type %USERPROFILE%\AppData\Local\x`,
    String.raw`type %HOMEDRIVE%%HOMEPATH%\AppData\Local\x`, String.raw`copy C:\Users\me\AppData\Roaming\SomeApp\token.json D:\out`, String.raw`dir %APPDATA%`,
    String.raw`Get-Content -Path:C:\Users\me\AppData\Roaming\x`, String.raw`set TOKEN=C:\Users\me\AppData\Roaming\x`, String.raw`type /Users/me/AppData/Roaming/x`,
    String.raw`type \Users\me\AppData\Roaming\x`, String.raw`type "C:\Users\me\code\reach\server\index.mjs"`, String.raw`type C:\Users\me\code\REACH\server\index.mjs`,
    String.raw`type %USERPROFILE%\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`, String.raw`type %ProgramData%\Tailscale\server-state.conf`,
    String.raw`type %SystemRoot%\System32\config\SAM`, String.raw`copy evil.lnk "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"`])
    assert.ok(commandRefusal(command, options), command);
  for (const command of [String.raw`type %TEMP%\log.txt`, String.raw`type C:\Users\me\Documents\notes.txt`, String.raw`dir %USERPROFILE%\Documents`, "git status",
    String.raw`type C:\Users\me\code\reach-notes\a.txt`])
    assert.equal(commandRefusal(command, options), null, command);
});

test("with no platform given, a Windows host takes Windows' data (test/helpers/as-windows.mjs)", async () => {
  const at = (file) => pathToFileURL(path.resolve(file)).href;
  const code = `
    const guard = await import(${JSON.stringify(at("server/agent-guard.mjs"))});
    const identity = await import(${JSON.stringify(at("server/app-identity.mjs"))});
    const rules = guard.nativeRules({ preset: "apps", apps: [] }, {});
    process.stdout.write(JSON.stringify({
      platform: process.platform,
      panes: rules.privatePanes.includes("sign-in options"),
      app: identity.validAppPath("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
      typed: !!guard.typedTextRefusal("reg add HKLM\\\\Software\\\\Example", { terminalLike: true }),
      protected: !!guard.protectedAppReason({ id: "C:\\\\Program Files\\\\KeePassXC\\\\KeePassXC.exe" }),
    }));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", at("test/helpers/as-windows.mjs"), "--input-type=module", "-e", code], { timeout: 30000 });
  assert.deepEqual(JSON.parse(stdout), { platform: "win32", panes: true, app: true, typed: true, protected: true });
});

test("the desktop hands a Windows helper Windows' rules, and a Mac's helper the Mac's", async () => {
  for (const platform of ["win32", "darwin"]) {
    const policy = { invite: true, browser: true, preset: "apps", roots: [], apps: [chrome] };
    const client = { id: "muse", kind: "agent", name: "Muse", expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
    let rules = null;
    const desktop = createAgentDesktop({ screen: true }, {
      platform, available: () => true, home: macFixture.options.home, verifyClient: () => client, pauses: createAgentPauses(),
      hosts: () => macFixture.options.hosts, titles: () => macFixture.options.titles, protectedPaths: () => macFixture.options.protectedPaths,
      spawnHelper: async (given) => { rules = given; return { async send() { return { ok: true, app: "", bundle: "", title: "" }; }, stop() {} }; },
    });
    await desktop.front(client, () => client);
    desktop.close();
    const expected = nativeRules({ preset: "apps", apps: [chrome] }, { ...macFixture.options, platform });
    sameJson(rules, expected, platform);
    if (platform === "darwin") sameJson(rules, { ...macFixture.apps, hiddenApps: [] }, "the Mac's rules as before");
    else assert.ok(rules.privatePanes.includes("sign-in options"));
  }
});
