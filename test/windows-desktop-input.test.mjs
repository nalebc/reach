import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { DesktopInput } from "../server/desktop-native.mjs";
import { COLD_START_MS } from "../server/powershell.mjs";

// The Windows owner input helper (scripts/native/desktop-input.ps1) and its
// one-shot fallback (input.ps1), as found on a real Windows Server 2025
// runner (Oct 18): typed accents and emoji garbled, a pasted line break sent
// as Ctrl+Enter, a finger's double-tap two single clicks, a tap into a
// console that never opened the phone's keyboard, input an administrator's
// window ignored without a word, scrolling 2.4 times short, and a cold PC's
// first Control timing out. These read the helpers' text and run on any
// computer; windows-desktop-input-native.test.mjs runs the same C# on
// Windows with its window calls recorded, and the screen-control journey
// (test/journeys/screen-control.test.mjs) drives the real thing.
const read = (name) => fs.readFileSync(new URL(`../scripts/native/${name}`, import.meta.url), "utf8");
const source = read("desktop-input.ps1");
const oneShot = read("input.ps1");
const input = source.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const probe = source.match(/-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const loop = source.slice(source.indexOf("$utf8=New-Object"));
// One C# method's text: its one line, or its lines down to its closing brace.
const method = (code, head) => {
  const at = code.indexOf(head);
  assert.ok(at >= 0, head);
  const line = code.slice(at, code.indexOf("\n", at));
  return line.endsWith("{") ? code.slice(at, code.indexOf("\n }\n", at) + 3) : line;
};

test("every PowerShell helper is plain ASCII: Windows PowerShell reads a file without a BOM in the PC's own code page", () => {
  for (const name of fs.readdirSync(new URL("../scripts/native/", import.meta.url)).filter((file) => file.endsWith(".ps1")))
    assert.doesNotMatch(read(name), /[^\x00-\x7f]/, name);
});

test("the input helper reads and answers UTF-8, never the console's code page", () => {
  // café arrived as caf├⌐ through [Console]::ReadLine (code page 437), and
  // copied or selected text went back as wrong through [Console]::WriteLine.
  assert.match(source, /\$utf8=New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(source, /\$reader=New-Object System\.IO\.StreamReader\(\[Console\]::OpenStandardInput\(\),\$utf8\)/);
  assert.match(source, /\$writer=New-Object System\.IO\.StreamWriter\(\[Console\]::OpenStandardOutput\(\),\$utf8\)/);
  assert.match(source, /\$writer\.AutoFlush=\$true/);
  assert.match(loop, /while \(\$null -ne \(\$line=\$reader\.ReadLine\(\)\)\)/);
  assert.doesNotMatch(loop, /\[Console\]::(ReadLine|WriteLine|In\b|Out\b|Write\b)/);
  assert.equal((loop.match(/\$writer\.WriteLine\(/g) || []).length, 2, "the answer and the failure");
  // The one-shot fallback (browser agents' and HTTP input) reads the same way.
  assert.match(oneShot, /New-Object System\.IO\.StreamReader\(\[Console\]::OpenStandardInput\(\),\(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)\)\.ReadToEnd\(\)/);
  assert.doesNotMatch(oneShot, /\[Console\]::In\b/);
  // The live screen's helper takes only its own ASCII words on stdin.
  const stream = read("screen-stream.ps1");
  assert.match(stream, /if \(\$line -notin 'frame','key'\) \{ continue \}|\$line -notin/);
});

test("typed text goes as its own characters, a line break as a plain Return, never through the keyboard layout", () => {
  assert.doesNotMatch(source, /Forms\.SendKeys\]::/, "SendKeys maps \\n to Ctrl+Enter and merges dead keys with the next letter");
  assert.match(source, /function Send-ReachText\(\$text\) \{\[ReachDesktopInput\]::Type\(\[string\]\$text\)\}/);
  assert.match(source, /'type-edit' \{[^\n]*\[ReachDesktopInput\]::Back\(\[int\]\$p\.delete\);Send-ReachText \$p\.text\}/);
  const characters = method(input, "static void Characters(string text){");
  // KEYEVENTF_UNICODE down (4) and up (6) for each UTF-16 unit; a surrogate
  // pair's two units in one batch.
  assert.match(characters, /KeyEvent\(0,text\[i\+k\],4\);batch\[k\*2\+1\]=KeyEvent\(0,text\[i\+k\],6\)/);
  assert.match(characters, /char\.IsHighSurrogate\(c\) && i\+1<text\.Length && char\.IsLowSurrogate\(text\[i\+1\]\)\?2:1/);
  // \n, \r\n (one) and \r: VK_RETURN with no modifier; \t: VK_TAB.
  assert.match(characters, /if\(c=='\\r' \|\| c=='\\n'\)\{if\(c=='\\r' && i\+1<text\.Length && text\[i\+1\]=='\\n'\)i\+\+;Press\(13,1\);continue;\}/);
  assert.match(characters, /if\(c=='\\t'\)\{Press\(9,1\);continue;\}/);
  // Backspaces are VK_BACK presses through SendInput, checked like the rest.
  assert.match(input, /public static void Back\(int count\)\{Front\(AdminTyping\);Press\(8,count\);\}/);
  assert.match(input, /static Input KeyEvent\(ushort vk,ushort scan,uint flags\)\{var input=new Input\{type=1\};/);
  assert.match(input, /throw new ReachRefusal\("Windows refused the typing\."\)/);
  // The INPUT union is the size Windows expects for mice and keys alike.
  assert.match(input, /\[StructLayout\(LayoutKind\.Explicit\)\] public struct Device \{\[FieldOffset\(0\)\] public MouseInput mouse;\[FieldOffset\(0\)\] public KeyInput key;\}/);
  // The one-shot fallback types exactly the same way.
  const fallback = oneShot.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  for (const head of ["static void Characters(string text){", "static void Press(ushort vk,int count){", "static Input KeyEvent(ushort vk,ushort scan,uint flags){"])
    assert.equal(method(fallback, head), method(input, head), head);
  assert.match(oneShot, /\[ReachInput\]::Type\(\[string\]\$payload\.text\)/);
  assert.doesNotMatch(oneShot.slice(oneShot.indexOf("'text'")), /^[^\n]*SendKeys[^\n]*text/m);
});

test("a finger's double-tap pairs within the phone's own radius and lands on the first tap's point", () => {
  // The dispatcher hands the phone's pair (shares of the display) on as
  // pixels, as a click's point is mapped (share x (size - 1)), as on a Mac;
  // without one, 0 and today's Windows rectangle.
  assert.match(source, /\[ReachDesktopInput\]::Click\(\$x,\$y,\(\$p\.button -eq 'right'\),\[int\]\$p\.count,\[long\]\$p\.clickId,\[int\]\$p\.clickState,\[double\]\$p\.pair\.x\*\[Math\]::Max\(0,\$b\.Width-1\),\[double\]\$p\.pair\.y\*\[Math\]::Max\(0,\$b\.Height-1\)\)/);
  assert.match(input, /public static int Click\(int x,int y,bool right,int count,long id,int state,double pairX,double pairY\)/);
  // |dx| <= max(Windows' own half-rectangle, pair), each axis on its own.
  assert.match(input, /return \(dx>=-\(w\/2\) && dx<\(w\+1\)\/2 \|\| Math\.Abs\(dx\)<=pairX\) && \(dy>=-\(h\/2\) && dy<\(h\+1\)\/2 \|\| Math\.Abs\(dy\)<=pairY\);/);
  // Continuing with the phone's radius: the first point, so Windows' own
  // rectangle and the SendInput timestamps make one double-click there.
  assert.match(input, /&& InDoubleClickRect\(x,y,pairX,pairY\);[\s\S]*?if\(continuing && \(pairX>0 \|\| pairY>0\)\)\{x=previousX;y=previousY;\}[\s\S]*?ClickX=x;ClickY=y;/);
  // The first tap's own point is what the second is measured from, and the
  // answer's point is where the click landed.
  assert.match(input, /if\(!right && count==1 && state!=2 && id>0\)\{previousId=id;previousX=x;previousY=y;/);
  assert.match(source, /\$result\.point=@\{x=\(\[ReachDesktopInput\]::ClickX-\$b\.X\)\/\[Math\]::Max\(1,\$b\.Width-1\)/);
});

test("text surfaces are fields for the probe, the field map and the focus check alike, never every pane", () => {
  const editable = method(probe, "public static bool Editable(AutomationElement element){");
  assert.match(editable, /if\(!info\.IsEnabled \|\| info\.IsOffscreen \|\| !info\.IsKeyboardFocusable\)return false;/);
  assert.match(editable, /if\(info\.ClassName=="TermControl"\)return true;/);
  assert.match(editable, /return !\(\(ValuePattern\)pattern\)\.Current\.IsReadOnly;/);
  assert.match(editable, /info\.ControlType==ControlType\.Document && element\.TryGetCurrentPattern\(TextPattern\.Pattern,out pattern\) && Changeable\(\(TextPattern\)pattern\)/);
  assert.doesNotMatch(editable, /ControlType\.(Pane|Group|Custom|Text)\b/);
  assert.match(probe, /TextPattern\.IsReadOnlyAttribute\);\s*return readOnly is bool && !\(bool\)readOnly;/);
  // One rule: the probe's walk, the field map's scan and the focus check.
  assert.match(method(probe, "static int Read(double x,double y){"), /if\(ConsoleAt\(x,y\)\)return 1;[\s\S]*if\(Editable\(element\) &&/);
  assert.match(probe, /shown\.Width>=8 && shown\.Height>=8 && Editable\(element\)\)/);
  assert.match(source, /if\(\[ReachDesktopFieldProbe\]::Editable\(\$element\)\) \{return \$element\}/);
  // A console window (conhost) is found by its class, in its client area
  // (never its title bar), by the probe, the map and the focus check.
  assert.match(probe, /ClassOf\(window\)!="ConsoleWindowClass" \|\| !GetClientRect\(window,out box\)/);
  assert.match(probe, /if\(ConsoleArea\(front,out console\)\)\{/);
  assert.match(source, /\$console=\[ReachDesktopFieldProbe\]::FrontConsole\(\)\s*if\(\$console -ne \[IntPtr\]::Zero\)\{return \[System\.Windows\.Automation\.AutomationElement\]::FromHandle\(\$console\)\}/);
  assert.match(source, /\$editable=\$editable -and \[ReachDesktopFieldProbe\]::Inside\(\$element,\$x,\$y\)/);
  // Secure (password) fields stay as they were: Windows' own IsPassword.
  assert.match(method(probe, "static int Read(double x,double y){"), /return info\.IsPassword\?3:1;/);
  assert.match(probe, /if\(same\)Append\(result,found\+\+,shown,x,y,width,height,info\.IsPassword\);/);
  assert.match(source, /return @\{editable=\$true;focus=\$script:typingToken;secure=\$info\.IsPassword\}/);
  // Still only looks: no focus moved, no text read.
  assert.doesNotMatch(probe, /\.SetFocus\(|\.Current\.Value\b|GetText\(|ReachDesktopInput|mouse_event/);
});

test("a window run as administrator is refused with why, before a click, a key or text goes; letting go always goes", () => {
  assert.match(input, /const string AdminClick="That window runs as administrator\. Windows doesn't let Reach control it\.";/);
  assert.match(input, /static void Under\(int x,int y\)\{Allowed\(WindowFromPoint\(new Spot\{x=x,y=y\}\),AdminClick\);\}/);
  assert.match(input, /static void Front\(string reason\)\{Allowed\(GetForegroundWindow\(\),reason\);\}/);
  // Higher than this helper's own level (TokenIntegrityLevel, 25); one that
  // can't be read is left to Windows.
  assert.match(input, /if\(own>=0 && pid!=0 && Level\(pid\)>own\)throw new ReachRefusal\(reason\);/);
  assert.match(input, /GetTokenInformation\(token,25,buffer,size,out size\)/);
  // Checked: a click (where it lands), a press, a scroll (under the
  // pointer), keys and text (the window in front).
  assert.match(input, /if\(continuing && \(pairX>0 \|\| pairY>0\)\)\{x=previousX;y=previousY;\}\s*Under\(x,y\);/);
  assert.match(input, /if\(type=="down"\)Under\(x,y\);/);
  assert.match(input, /if\(GetCursorPos\(out at\)\)Under\(at\.x,at\.y\);/);
  assert.match(input, /public static void Key\(byte vk,bool down\)\{ForgetClick\(\);if\(down\)Front\(AdminTyping\);/);
  assert.match(input, /public static void Type\(string text\)\{Front\(AdminTyping\);Characters\(text\);\}/);
  // Never a button's or a key's release: nothing may stay held down.
  assert.match(input, /public static void Release\(\)\{lock\(gate\)\{ForgetClick\(\);if\(held!=0\)mouse_event\(held,0,0,0,UIntPtr\.Zero\);held=0;\}\}/);
  assert.doesNotMatch(input.slice(input.indexOf("public static void Release()"), input.indexOf("public static void Mouse(")), /Under|Front|Allowed/);
  // A refusal reaches the phone as said (control goes on); anything else
  // is the general failure.
  assert.match(source, /function Stop-Reach\(\$message\) \{throw \(New-Object ReachRefusal \$message\)\}/);
  assert.match(loop, /\$e=\$_\.Exception;while\(\$e -and \$e -isnot \[ReachRefusal\]\)\{\$e=\$e\.InnerException\}/);
  assert.match(loop, /\$answer=@\{error=\$\(if\(\$e\)\{\$e\.Message\}else\{'Desktop action failed\. Check the selected display and keep Windows unlocked\.'\}\)\}/);
  // Only a display that's gone ends control, as on a Mac (its helper's
  // fatal error, code 2): a refusal never does.
  assert.match(loop, /if\(\$e -and \$e\.Fatal\)\{\$answer\.fatal=\$true\}/);
  assert.equal(source.match(/New-Object ReachRefusal '[^']*',\$true/g)?.length, 1);
  assert.ok(source.includes("throw (New-Object ReachRefusal 'This display disconnected. Select a display again.',$true)"));
  for (const said of ["Typing target changed. Tap the field again.", "Invalid typing edit.", "Unsupported key"])
    assert.ok(source.includes(`Stop-Reach '${said}'`), said);
  assert.doesNotMatch(loop.slice(0, loop.indexOf("} catch {")), /\bthrow '/, "known failures are said, not thrown as the general one");
});

test("scrolling turns the phone's pixels into wheel units and keeps what's short of one", () => {
  assert.match(source, /'scroll' \{\[ReachDesktopInput\]::Scroll\(\[double\]\$p\.dx,\[double\]\$p\.dy\)\}/);
  assert.match(input, /const double WheelPerPixel=2\.4;/);
  assert.match(input, /static int Wheel\(double pixels,ref double rest\)\{if\(pixels==0\)return 0;if\(Math\.Sign\(pixels\)!=Math\.Sign\(rest\)\)rest=0;rest\+=pixels\*WheelPerPixel;int whole=\(int\)rest;rest-=whole;return whole;\}/);
  // Direction as before: WHEEL as given, HWHEEL turned.
  assert.match(input, /if\(wy!=0\)mouse_event\(2048,0,0,wy,UIntPtr\.Zero\);if\(wx!=0\)mouse_event\(4096,0,0,-wx,UIntPtr\.Zero\);/);
  // The one-shot fallback takes whole steps (server/platform.mjs), a notch each.
  assert.match(oneShot, /mouse_event\(2048,0,0,\(\[int\]\$payload\.delta \* 120\),\[UIntPtr\]::Zero\)/);
});

// A fake helper process: no native process, no input.
function child() {
  const value = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(), written: [] });
  value.stdin.write = (line) => value.written.push(JSON.parse(line));
  value.stdin.end = () => {};
  value.answer = (reply = { ok: true }) => value.stdout.emit("data", Buffer.from(JSON.stringify(reply) + "\n"));
  return value;
}

test("a cold Windows input helper gets a minute for its first answer, then 10 seconds; a Mac's helper 10 seconds from the start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Windows: the first heartbeat waits out the C# compile.
  let process = child();
  let helper = new DesktopInput(process, { coldStartMs: COLD_START_MS });
  const first = helper.send({ type: "heartbeat" });
  t.mock.timers.tick(COLD_START_MS - 1);
  assert.equal(helper.stopped, false, "still compiling at a minute less a millisecond");
  process.answer({ ok: true, cursor: { x: 0, y: 0 } });
  assert.deepEqual(await first, { ok: true, cursor: { x: 0, y: 0 } });
  const second = helper.send({ type: "click", x: 0.5, y: 0.5 });
  t.mock.timers.tick(9999);
  assert.equal(helper.stopped, false);
  t.mock.timers.tick(1);
  assert.equal(helper.stopped, true, "after the first answer, the usual 10 s");
  await assert.rejects(second, /disconnected/);
  // A first answer that never comes still ends, at the minute.
  process = child();
  helper = new DesktopInput(process, { coldStartMs: COLD_START_MS });
  const silent = helper.send({ type: "heartbeat" });
  t.mock.timers.tick(COLD_START_MS);
  assert.equal(helper.stopped, true);
  await assert.rejects(silent, /disconnected/);
  // A Mac's helper is built before it starts: 10 s from the first request.
  process = child();
  helper = new DesktopInput(process);
  const mac = helper.send({ type: "heartbeat" });
  t.mock.timers.tick(10000);
  assert.equal(helper.stopped, true);
  await assert.rejects(mac, /disconnected/);
  // Only the PowerShell helper is started with it.
  const native = fs.readFileSync(new URL("../server/desktop-native.mjs", import.meta.url), "utf8");
  assert.match(native, /executable = "powershell\.exe";\s*args = powershellFile\(path\.join\(native, "desktop-input\.ps1"\), \[display\], \{ sta: true \}\);\s*coldStartMs = COLD_START_MS;\s*\} else throw/);
  assert.match(native, /\{ coldStartMs \},\s*\);/);
});
