import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates } from "../server/desktop-native.mjs";
import { csharpPolicyProgram, macCases, pureSections, reachUrlCases, windowsCases } from "./helpers/desktop-policy-corpus.mjs";

// The Windows helper's pure policy (scripts/native/agent-desktop.cs, a port of
// agent-desktop.swift's) decides the shared corpus as Swift and JavaScript do
// (docs/parity/B-desktop-helper.md §7.2, §13.2). Its source is read here on
// any computer; the corpus is compiled with the PC's own csc.exe and run on
// Windows only.
// Line ends as written: a Windows checkout may turn them into CRLF.
const source = fs.readFileSync(new URL("../scripts/native/agent-desktop.cs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pure = pureSections(source);
// Its code without its comments (whole-line ones, and those after code).
const code = (text) => text.split("\n").filter((line) => !/^\s*\/\//.test(line)).map((line) => line.replace(/\s\/\/\s.*$/, ""));

test("the corpus's copy of the Reach-address cases is the Swift policy test's own", () => {
  const swiftTest = fs.readFileSync(new URL("./agent-desktop-policy-native.test.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const literal = swiftTest.split("const reachUrlCases = ")[1].split("\n];")[0] + "\n]";
  const theirs = new Function(`return ${literal};`)();
  assert.equal(JSON.stringify(theirs), JSON.stringify(reachUrlCases));
  assert.ok(macCases.length > 150 && windowsCases.length > 80, "every case is there");
});

test("the pure sections call nothing of Windows, never System.Uri, and compare only ordinally", () => {
  const lines = code(pure);
  for (const banned of [/DllImport/, /\bextern\b/, /\bMarshal\./, /\bIntPtr\b/, /\bSystem\.Uri\b|\bnew Uri\(|\bUri\./, /\bConsole\./, /\bFile\./])
    assert.ok(!lines.some((line) => banned.test(line)), `${banned}: ${lines.find((line) => banned.test(line))?.trim()}`);
  for (const line of lines) {
    const shown = line.trim().slice(0, 200);
    if (/\.(StartsWith|EndsWith)\(/.test(line)) assert.ok(/StringComparison\.Ordinal/.test(line), shown);
    if (/(?<!Array)\.(?:Last)?IndexOf\((?!'|c\)|value\[i\])/.test(line)) assert.ok(/StringComparison\.Ordinal/.test(line), shown);
    assert.ok(!/\b(?:string|String)\.Compare\(|\.ToLower\(\)|\.ToUpper\(\)/.test(line), shown);
  }
  // Every pattern: the same in any language, and stopped after its time budget.
  for (const [construction] of lines.join("\n").matchAll(/new Regex\([\s\S]*?\);/g))
    assert.ok(/CultureInvariant/.test(construction) && /TimeSpan|Budget/.test(construction), construction.slice(0, 200));
});

test("Windows' additions to the policy leave the Mac's data alone, and an installed program is matched by its path", () => {
  const policy = source.split("// BEGIN PURE DESKTOP POLICY")[1].split("// END PURE DESKTOP POLICY")[0];
  // A Store app by its package, a package family, a publisher, Settings' and
  // Control Panel's ids, the compositor: each guarded so a Mac's ids never meet it.
  assert.match(policy, /PackageName\(id\)/);
  assert.match(policy, /id\.StartsWith\(entry \+ "!"/);
  assert.match(policy, /ProtectedPublishers/);
  assert.match(policy, /"windows\.controlpanel"/);
  assert.match(policy, /"exe:dwm\.exe"/);
  // The rules' reader drops an exe: bundle from the Apps preset's apps.
  assert.match(policy, /bundle\.StartsWith\("exe:", StringComparison\.OrdinalIgnoreCase\)\) app\["bundleId"\] = ""/);
});

const exec = promisify(execFile);
test("compiled Windows desktop policy decides the same corpus", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "Windows' C# compiler");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach windows policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const program = path.join(dir, "checks.cs"), binary = path.join(dir, "checks.exe");
  fs.writeFileSync(program, csharpPolicyProgram(source));
  const framework = path.win32.dirname(csc);
  await exec(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/codepage:65001", "/utf8output", `/out:${binary}`,
    ...["System.dll", "System.Core.dll"].map((name) => `/reference:${path.win32.join(framework, name)}`), program], { windowsHide: true, timeout: 120000, maxBuffer: 4 << 20 })
    .catch((error) => assert.fail(`${error.stdout || ""}${error.stderr || ""}`.split(/\r?\n/).filter((line) => /error CS/.test(line)).slice(0, 20).join("\n") || error.message));
  const ran = await exec(binary, [], { windowsHide: true, timeout: 60000, maxBuffer: 4 << 20 }).catch((error) => error);
  assert.equal(String(ran.stdout).trim(), "OK", `${String(ran.stdout).slice(0, 3000)}${String(ran.stderr || "").slice(0, 2000)} (exit ${ran.code ?? 0})`);
});

// The helper's own decisions (masks, the race check, line framing, input):
// test/fixtures/windows/agent-desktop-checks.cs, compiled with the helper.
test("the helper's own decisions pass their checks, compiled together with it", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "Windows' C# compiler");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach windows checks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "checks.exe"), framework = path.win32.dirname(csc);
  await exec(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/codepage:65001", "/utf8output", "/main:DesktopChecks", `/out:${binary}`,
    ...["System.dll", "System.Core.dll", "System.Drawing.dll"].map((name) => `/reference:${path.win32.join(framework, name)}`),
    path.resolve("scripts/native/agent-desktop.cs"), path.resolve("test/fixtures/windows/agent-desktop-checks.cs")], { windowsHide: true, timeout: 120000, maxBuffer: 4 << 20 })
    .catch((error) => assert.fail(`${error.stdout || ""}${error.stderr || ""}`.split(/\r?\n/).filter((line) => /error CS/.test(line)).slice(0, 20).join("\n") || error.message));
  const ran = await exec(binary, [], { windowsHide: true, timeout: 60000, maxBuffer: 4 << 20 }).catch((error) => error);
  assert.equal(String(ran.stdout).trim(), "OK", `${String(ran.stdout).slice(0, 3000)}${String(ran.stderr || "").slice(0, 2000)} (exit ${ran.code ?? 0})`);
});

const body = (name) => source.split(`static Dictionary<string, object> ${name}(`)[1].split("\n  }\n")[0];
test("a screenshot is masked before it's encoded, Full control lists no windows, and a picture taken while windows moved is black", () => {
  const shot = body("Shot");
  assert.match(shot, /InputDesktopName\(\) != "Default"\) throw new Refusal\(SecureDesktopReason, "paused"\)/, "not on a secure desktop");
  assert.match(shot, /Settle\([\s\S]*rules\.Mode != "full"/, "only narrower presets list windows");
  assert.match(shot, /Masks\.Black\(rules\.Mode, screen, frame\.Settled \? looks : null, StrictMasks/, "unsettled: all black");
  assert.ok(shot.indexOf("FillRectangle(Brushes.Black") < shot.indexOf("DrawCursor(") && shot.indexOf("DrawCursor(") < shot.indexOf("Jpeg("), "black, then the pointer, then the picture");
  assert.match(source, /public static bool StrictMasks = false;/, "refined by default (D4: the Mac's rule)");
});

test("what is in front never names an app the owner hid, and says why anything else is closed", () => {
  const front = body("Front");
  assert.match(front, /if \(blocked == Policy\.HiddenReason\) \{\n\s+result\["app"\] = ""; result\["bundle"\] = ""; result\["title"\] = ""; result\["terminalLike"\] = false; result\["secure"\] = false;/);
  assert.match(front, /result\["title"\] = blocked == null \? Limit\(w\.Title, 200\) : "";/);
  // Closed: an identity Windows couldn't verify, Reach's own window, a title
  // that can't be read in a browser or a terminal.
  const verdict = source.split("static string Verdict(Win w, Rules rules, bool look) {")[1].split("\n  }\n")[0];
  assert.match(verdict, /AppVerdict\(id, judged\)[\s\S]*w\.Reach[\s\S]*TitleVerdict\(w\.Title, id\.Bundle, w\.Handle, w\.Explorer, rules\)[\s\S]*IsBrowser\(id\) \|\| w\.Terminal\) && \(!w\.TitleRead \|\| w\.Title\.Length == 0\)/);
  assert.match(source, /if \(id == null \|\| !id\.Known\) return UnknownReason;/);
});

test("output is one line per request under one lock, nothing on stderr, never the console's own input", () => {
  const lines = source.split("\n").filter((line) => !/^\s*\/\//.test(line));
  assert.ok(!lines.some((line) => /Console\.(In|Error|Write|ReadLine|Out)\b/.test(line)), "no console reads or writes but the streams opened first");
  assert.match(source, /input = Console\.OpenStandardInput\(\);\n\s+output = new StreamWriter\(Console\.OpenStandardOutput\(\), new UTF8Encoding\(false\)\);/);
  const writes = lines.filter((line) => /output\.(Write|Flush)/.test(line));
  assert.ok(writes.length >= 3);
  const reply = source.split("static void Reply(")[1].split("\n  }\n")[0];
  assert.match(reply, /lock \(outLock\) \{\n\s+output\.Write\(text\);\n\s+output\.Write\('\\n'\);\n\s+output\.Flush\(\);/);
  assert.match(source, /try \{ lock \(outLock\) output\.Flush\(\); \}/, "the last flush too");
});

test("input goes out in one place, after its checks, and never through the APIs that bypass them", () => {
  const lines = code(source);
  const text = lines.join("\n");
  // Only Post and LetGo send; only WindowsInput calls SendInput.
  // Each Input.Send(, by the method it is in.
  const senders = new Set();
  lines.forEach((line, at) => {
    if (!/Input\.Send\(/.test(line)) return;
    for (let up = at; up >= 0; up--) {
      const header = /^ {2}(?:internal |public )?static [^=(]*?\b(\w+)\(/.exec(lines[up]);
      if (header) { senders.add(header[1]); return; }
    }
  });
  assert.deepEqual([...senders].sort(), ["LetGo", "Post"]);
  assert.equal((text.match(/Native\.SendInput\(/g) || []).length, 1);
  assert.match(text, /public uint Send\(Native\.INPUT\[\] batch\) \{ return Native\.SendInput\(/);
  const post = text.split("internal static void Post(Native.INPUT[] batch, int pauseMs) {")[1].split("\n  }\n")[0];
  const order = ["View.InputDesktop()", "View.ForegroundIntegrity()", "if (stopping) return;", "Input.KeyDown(vk) && !HeldByUs(vk)", "Input.Send(batch)"].map((part) => post.indexOf(part));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `Post checks, then sends: ${order}`);
  for (const banned of [/\bkeybd_event\b/, /\bmouse_event\b/, /SetWindowsHookEx/, /AttachThreadInput/, /SwitchToThisWindow/, /SPI_SETFOREGROUNDLOCKTIMEOUT/, /LockSetForegroundWindow/,
    /AllowSetForegroundWindow/, /Process\.Start/, /ShellExecute/, /IAssocHandler/, /\bGetWindowText(W|A)?\(/, /Console\.In\b/, /\.SetFocus\(/])
    assert.ok(!banned.test(text), String(banned));
  // The Windows key is read (is the owner holding it?) and never sent.
  const lwin = lines.filter((line) => /VK_LWIN|VK_RWIN/.test(line));
  assert.ok(lwin.every((line) => /static readonly int\[\] Watched|public const ushort/.test(line)), lwin.join("\n"));
  // The target's own integrity before any pointer or key input (Rule T).
  const checkPoint = text.split("internal static Seen CheckPoint(")[1].split("\n  }\n")[0];
  assert.ok((checkPoint.match(/RuleT\(/g) || []).length >= 3);
  assert.match(text.split("internal static Target Focus(")[1].split("\n  }\n")[0], /RuleT\(front\.Id\)/);
  // A paste's clipboard never reaches Clipboard History or cloud sync, and is restored whatever happens.
  assert.match(text, /"ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"/);
  assert.match(text.split("static void Paste(string text) {")[1].split("\n  }\n")[0], /try \{[\s\S]*Post\([\s\S]*\} finally \{[\s\S]*if \(Clip\.Sequence\(\) == written\) Clip\.Write\(previous\);/);
});

test("a password field's value is never asked for: values come only through the not-a-password condition", () => {
  const text = code(source).join("\n");
  // The structure read (pass 1) never caches a value; only ValueOf reads one,
  // through a request that is never built without the condition.
  const structure = text.split("static readonly int[] StructureProperties = {")[1].split("};")[0];
  assert.doesNotMatch(structure, /ValueValue/);
  const allowed = [/ValueValue = 30045,/, /^\s*Values\.AddProperty\(ValueValue\);$/, /return bearer\.GetCachedPropertyValue\(Uia\.ValueValue\) as string/,
    /AddPropertyChangedEventHandlerNativeArray\(element, Uia\.ScopeSubtree, null, changes, new\[\] \{ Uia\.Name, Uia\.ValueValue, Uia\.BoundingRectangle \}, 3\)/];
  const uses = text.split("\n").filter((line) => /\bValueValue\b/.test(line));
  for (const line of uses) assert.ok(allowed.some((pattern) => pattern.test(line)), line.trim());
  assert.equal(uses.length, 4);
  assert.match(text, /ValueBearing = Automation\.CreateAndCondition\(Automation\.CreatePropertyCondition\(IsPassword, false\), Automation\.CreatePropertyCondition\(IsValuePatternAvailable, true\)\);/);
  const valueOf = text.split("internal static string ValueOf(IUIAutomationElement element) {")[1].split("\n  }\n")[0];
  assert.match(valueOf, /FindFirstBuildCache\(Uia\.ScopeElement, Uia\.ValueBearing, Uia\.Values\)[\s\S]*IsPassword[\s\S]*return ""/);
  for (const banned of [/get_CurrentValue\(/, /CurrentValue\b/, /TextPattern/, /\.SetFocus\(/]) assert.ok(!banned.test(text), String(banned));
  // The change handler counts; it never reads what changed.
  assert.match(text, /public void HandlePropertyChangedEvent\(IUIAutomationElement sender, int propertyId, object newValue\) \{ Desk\.Changed\(\); \}/);
  // Start-up trusts the interfaces only after known answers.
  const start = text.split("public static bool Start() {")[1].split("\n  }\n")[0];
  assert.match(start, /put_ConnectionTimeout\(1000\); timed\.put_TransactionTimeout\(500\)/);
  assert.match(start, /ControlType\)\) != Pane\) return false;[\s\S]*NativeWindowHandle\)\) != Native\.GetDesktopWindow\(\)\.ToInt64\(\)\) return false;[\s\S]*CompareElements\(root, root\) == 0\) return false;/);
  // Texts, values and contexts are shown without the agent's vault values.
  const read = text.split("internal static Screen ReadScreen(")[1].split("\n  }\n")[0];
  assert.ok((read.match(/Policy\.HideSecrets\(/g) || []).length >= 3);
});

// The interfaces as declared here, slot by slot, against the Windows SDK's own
// UIAutomationClient.idl (a mistake compiles clean and calls the wrong slot).
test("the UI Automation interfaces match the Windows SDK's IDL, member by member", { skip: process.platform !== "win32" }, async (t) => {
  const kits = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "Include");
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter((name) => fs.existsSync(path.join(kits, name, "um", "UIAutomationClient.idl"))).sort() : [];
  if (!versions.length) return t.skip("no Windows SDK on this runner");
  const idl = fs.readFileSync(path.join(kits, versions.at(-1), "um", "UIAutomationClient.idl"), "utf8").replace(/\r\n/g, "\n").replace(/\/\/.*$/gm, "");
  const sdk = new Map();
  for (const match of idl.matchAll(/uuid\(([0-9a-fA-F-]{36})\)[^\]]*\]\s*interface\s+(\w+)\s*:\s*(\w+)\s*\{([\s\S]*?)\n\s*\}/g)) {
    const [, uuid, name, base, body] = match;
    const members = [...body.matchAll(/(\[[^\]]*\])?\s*HRESULT\s+(\w+)\s*\(/g)].map(([, attributes = "", member]) =>
      (/propget/.test(attributes) ? "get_" : /propput/.test(attributes) ? "put_" : "") + member);
    sdk.set(name, { uuid: uuid.toLowerCase(), base, members });
  }
  const declared = source.split("// BEGIN NATIVE UIA")[1].split("// END NATIVE UIA")[0];
  let checked = 0;
  for (const match of declared.matchAll(/Guid\("([0-9a-f-]{36})"\), InterfaceType\(ComInterfaceType\.InterfaceIsIUnknown\)\]\ninterface (\w+) \{([\s\S]*?)\n\}/g)) {
    const [, uuid, name, body] = match;
    const ours = body.split("\n").map((line) => /(\w+)\([^()]*(?:\([^()]*\)[^()]*)*\);$/.exec(line.trim())?.[1]).filter(Boolean);
    const theirs = sdk.get(name);
    assert.ok(theirs, `${name} is in the SDK`);
    assert.equal(uuid, theirs.uuid, `${name}'s IID`);
    const all = theirs.base !== "IUnknown" ? [...(sdk.get(theirs.base)?.members || []), ...theirs.members] : theirs.members;
    assert.deepEqual(ours, all.slice(0, ours.length), `${name}'s members, in order`);
    checked++;
  }
  assert.ok(checked >= 15, `${checked} interfaces checked`);
});

test("every program is started with the user's own environment, after its manifest is checked, never through the shell's handlers", () => {
  const text = code(source).join("\n");
  assert.equal((text.match(/Native\.CreateProcessW\(/g) || []).length, 1, "one place starts programs");
  const start = text.split("static int Start(string exe, string arguments) {")[1].split("\n  }\n")[0];
  const order = ["AsksForAdministrator(exe)", "CreateEnvironmentBlock(out environment, token, false)", "Native.CreateProcessW("].map((part) => start.indexOf(part));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `checked, then its environment, then started: ${order}`);
  assert.match(start, /CreateProcessW\(exe, command, IntPtr\.Zero, IntPtr\.Zero, false, Native\.CREATE_UNICODE_ENVIRONMENT, environment,/);
  assert.match(start, /ERROR_ELEVATION_REQUIRED\) throw new Refusal\(AdminAppReason, "blocked"\)/);
  assert.match(text, /level\\\\s\*=\\\\s\*\[\\"'\]\(requireAdministrator\|highestAvailable\)/);
  // Store apps through the activation manager; never ShellExecute or IAssocHandler (banned above).
  assert.match(text, /ActivationManager\(\)\.ActivateApplication\(/);
  assert.match(text, /ActivationManager\(\)\.ActivateForFile\(appId, ItemsOf\(canonical\), "open"\)/);
  assert.match(text, /ActivationManager\(\)\.ActivateForProtocol\(app\.Bundle, ItemsOf\(text\)\)/);
  // A file by its handle: reparse points and hard links refused, protected
  // folders and programs judged on its real name; the handle held until opened.
  const open = text.split("static Dictionary<string, object> OpenFile(string path, bool reveal, Rules rules) {")[1].split("\n  }\n")[0];
  assert.match(open, /FILE_ATTRIBUTE_REPARSE_POINT\) != 0 \|\| \(!directory && info\.nNumberOfLinks > 1\)/);
  assert.match(open, /Within\(canonical, root\)/);
  assert.match(open, /Policy\.ProgramFile\(canonical, rules\)/);
  assert.match(open, /ASSOCSTR_DELEGATEEXECUTE[\s\S]*ASSOCSTR_DDECOMMAND[\s\S]*No app on this Windows PC opens that file/);
  assert.match(open, /\} finally \{\n\s+Native\.CloseHandle\(handle\);\n\s+\}$/);
  // Saved browser tools wait for Reach's browser extension.
  assert.match(text, /case "browser-check": throw new Refusal\("Saved browser tools on Windows come with Reach's browser extension, which isn't installed yet\.", "setup_required"\);/);
});

test("a classic menu's item is pressed by its own command, after its menus get ready and only when it isn't dimmed; nothing else sends a command", () => {
  const text = code(source).join("\n");
  assert.equal((text.match(/Native\.WM_COMMAND/g) || []).length, 1, "one place sends a command");
  const press = text.split("static bool PressClassic(")[1].split("\n  }\n")[0];
  const order = ["Native.WM_INITMENU,", "Native.WM_INITMENUPOPUP", "MFS_DISABLED", "Native.WM_COMMAND"].map((part) => press.indexOf(part));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `ready, checked, then pressed: ${order}`);
  assert.match(text, /if \(!PressClassic\(new IntPtr\(root\), bar, steps\) && !PressThroughUia\(root, names\)\)/, "UI Automation when there's no command to send");
});

test("every action waits for the owner's own desktop and for no elevated window in front, the ones that send no input too", () => {
  const text = code(source).join("\n");
  const perform = text.split("internal static Dictionary<string, object> Perform(")[1].split("\n  }\n")[0];
  assert.ok(perform.indexOf("ReadyToAct();") > 0 && perform.indexOf("ReadyToAct();") < perform.indexOf("switch (type)"), "before any action");
  const ready = text.split("internal static void ReadyToAct() {")[1].split("\n  }\n")[0];
  assert.match(ready, /InputDesktop\(\) != "Default"\) throw new Refusal\(SecureDesktopReason, "paused"\)/);
  assert.match(ready, /front == -1 \|\| front > ownIntegrity\) throw new Refusal\(ElevatedFrontReason, "paused"\)/);
  assert.match(text, /case "focus": RuleS\(\); ReadyToAct\(\);/);
  for (const op of ["open", "open-url", "open-file"]) assert.match(text, new RegExp(`case "${op}": RuleS\\(\\); OnOwnersDesktop\\(\\);`));
});
