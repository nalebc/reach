import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inputAction } from "../server/desktop-protocol.mjs";
import { powershellFile } from "../server/powershell.mjs";
const exec = promisify(execFile);
const source = await fs.readFile(
  new URL("../scripts/native/desktop-input.ps1", import.meta.url),
  "utf8",
);
const fieldProbe = source.match(/-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const probeAction = source.match(/'probe'\s*\{([^\r\n]+)\}/)[1];

test("Windows implements the advertised field probe with a bounded read-only hit test and the same focus eligibility", () => {
  assert.match(fieldProbe, /AutomationElement\.FromPoint\(new Point\(x,y\)\)/);
  // 250 ms once UI Automation is up; a look before then gets 1 s, since its
  // client starts on the first call (warmed as the helper starts).
  assert.match(fieldProbe, /worker\.Join\(warm\?250:1000\)/);
  assert.match(fieldProbe, /public static void Warm\(\)/);
  assert.match(source, /\[ReachDesktopFieldProbe\]::Warm\(\)/);
  // Each look's thread takes the helper's per-monitor DPI awareness.
  assert.match(
    fieldProbe,
    /SetThreadDpiAwarenessContext\(new IntPtr\(-4\)\);result=Read/,
  );
  assert.match(fieldProbe, /worker!=null && worker\.IsAlive/);
  assert.match(fieldProbe, /depth<4/);
  // One rule for the probe, the field map and the focus check (Editable):
  // a read-only value is never a field, an offscreen one neither.
  assert.match(fieldProbe, /if\(!info\.IsEnabled \|\| info\.IsOffscreen \|\| !info\.IsKeyboardFocusable\)return false;/);
  assert.match(fieldProbe, /TryGetCurrentPattern\(ValuePattern\.Pattern,out pattern\)\)return !\(\(ValuePattern\)pattern\)\.Current\.IsReadOnly;/);
  assert.match(source, /if\(\[ReachDesktopFieldProbe\]::Editable\(\$element\)\) \{return \$element\}/);
  assert.doesNotMatch(
    fieldProbe,
    /\.SetFocus\(|\.Current\.Value\b|ReachDesktopInput|mouse_event/,
  );
  assert.doesNotMatch(probeAction, /Release\(|Mouse\(/);
  assert.match(probeAction, /\$b\.X\+\$p\.x\*\(\$b\.Width-1\)/);
});

test("Windows completes rapid pairs with timestamped input and releases partially delivered clicks", () => {
  assert.equal(
    (source.match(/public class ReachDesktopInput\b/g) || []).length,
    1,
    "the native pointer class must compile once per helper",
  );
  assert.match(
    source,
    /static extern uint SendInput\(uint count,Input\[\] inputs,int size\)/,
  );
  assert.match(source, /id==previousId/);
  assert.match(
    source,
    /previousTime\+Math\.Max\(1u,Math\.Min\(50u,GetDoubleClickTime\(\)\/2\)\)/,
  );
  // The second tap moves to the first one's point only when the phone said
  // how far it pairs taps (pair); otherwise it keeps its own point.
  assert.equal((source.match(/x=previousX|y=previousY/g) || []).length, 2);
  assert.match(source, /if\(continuing && \(pairX>0 \|\| pairY>0\)\)\{x=previousX;y=previousY;\}/);
  assert.match(source, /GetSystemMetrics\(36\).*GetSystemMetrics\(37\)/);
  assert.match(source, /InDoubleClickRect\(x,y,pairX,pairY\)/);
  assert.match(source, /Input\[\] inputs=new Input\[count\*2\]/);
  assert.match(source, /held=up;\s*try\{if\(SendInput/);
  assert.match(source, /catch\{Release\(\);throw;\}/);
});

// Compile the production C# probe and execute the production PowerShell
// dispatch/focus functions on Windows. Only the UI Automation provider is
// a stand-in; the live provider is covered by windows-desktop-e2e.test.mjs.
test(
  "Windows field detection rejects disabled, read-only, offscreen and out-of-bounds inputs without reading text or blocking clicks",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const provider = `
namespace System.Windows {
 public struct Point { public double X,Y;public Point(double x,double y){X=x;Y=y;} }
 public struct Rect {
  public double Left,Top,Width,Height;public bool IsEmpty {get{return Width<=0 || Height<=0;}}
  public double Right {get{return Left+Width;}} public double Bottom {get{return Top+Height;}}
  public Rect(double x,double y,double w,double h){Left=x;Top=y;Width=w;Height=h;}
 }
}
namespace System.Windows.Automation {
 public class ControlType {
  public static readonly ControlType Edit=new ControlType(),ComboBox=new ControlType(),Text=new ControlType(),Document=new ControlType(),Pane=new ControlType();
 }
 public class ValuePattern {
  public static readonly object Pattern=new object();public ValueInfo Current=new ValueInfo();
  public class ValueInfo { public bool IsReadOnly;public string Value {get{throw new System.Exception("Text must never be read");}} }
 }
 public class TextPattern {
  public static readonly object Pattern=new object(),IsReadOnlyAttribute=new object();public Range DocumentRange=new Range();
  public class Range {
   public object ReadOnly=false;
   public object GetAttributeValue(object attribute){if(attribute!=IsReadOnlyAttribute)throw new System.Exception("Only IsReadOnly is asked");return ReadOnly;}
   public string GetText(int max){throw new System.Exception("Text must never be read");}
  }
 }
 public class FieldInfo {
  public bool IsEnabled=true,IsKeyboardFocusable=true,IsOffscreen=false,IsPassword=false;public string ClassName="";public int NativeWindowHandle;
  public ControlType ControlType=System.Windows.Automation.ControlType.Edit;public System.Windows.Rect BoundingRectangle=new System.Windows.Rect(-1200,50,300,40);
 }
 public class AutomationElement {
  public FieldInfo Current=new FieldInfo();public ValuePattern Value;public TextPattern Text;public AutomationElement Parent;
  public static AutomationElement Hit,FocusedElement,Window;public static int Delay,Calls;public static bool Refused;
  public static readonly object NotSupported=new object();
  public static System.Windows.Point LastPoint;
  public static AutomationElement FromPoint(System.Windows.Point at){Calls++;LastPoint=at;
   if(Delay>0)System.Threading.Thread.Sleep(Delay);if(Refused)throw new System.Exception("Provider refused");return Hit;}
  public static AutomationElement FromHandle(System.IntPtr window){return Window;}
  public bool TryGetCurrentPattern(object pattern,out object value){
   if(pattern==TextPattern.Pattern){value=Text;return Text!=null;}
   value=Value;return Value!=null;
  }
  public int Runtime=42;
  public int[] GetRuntimeId(){return new int[]{Runtime};}
 }
 public class TreeWalker {
  public static readonly TreeWalker RawViewWalker=new TreeWalker();
  public AutomationElement GetParent(AutomationElement element){return element.Parent;}
 }
}
`;
    const focus = source.match(/function Stop-Reach[^\n]*\n/)[0] + ["Get-ReachFocusedTextElement", "Get-ReachTextTarget", "Assert-ReachTypingTarget"]
      .map((name) => source.match(new RegExp(`function ${name}[^\\n]*\\n[\\s\\S]*?\\r?\\n}\\r?\\n`))[0]).join("\n");
    const refusal = source.match(/public class ReachRefusal[^\n]*/)[0];
    // This fixture replaces only the point-provider API, and the window
    // calls that find a console (its window, its class, its client area).
    // Field-tree scans use the actual UI Automation provider in
    // windows-desktop-e2e, so keep their separate methods out of this
    // intentionally small provider stub.
    let pointProbe = fieldProbe.replace(/ public static string Fields[\s\S]*?(?= static int Read\()/, "");
    for (const [from, to] of [
      ['[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();', "public static IntPtr Front;static IntPtr GetForegroundWindow(){return Front;}"],
      ['[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Spot point);', "public static IntPtr Pointed;static IntPtr WindowFromPoint(Spot point){return Pointed;}"],
      ['[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);', "static IntPtr GetAncestor(IntPtr window,uint flags){return window;}"],
      ['[DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Box box);', "static bool GetClientRect(IntPtr window,out Box box){box=new Box{right=300,bottom=200};return true;}"],
      ['[DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Spot point);', "static bool ClientToScreen(IntPtr window,ref Spot point){point.x-=1200;point.y+=60;return true;}"],
    ]) {
      assert.ok(pointProbe.includes(from), from);
      pointProbe = pointProbe.replace(from, to);
    }
    assert.match(pointProbe, / static string ClassOf\(IntPtr window\)\{[^\n]*\}/);
    pointProbe = pointProbe.replace(/ static string ClassOf\(IntPtr window\)\{[^\n]*\}/,
      ' public static IntPtr ConsoleWindow;static string ClassOf(IntPtr window){return window!=IntPtr.Zero && window==ConsoleWindow?"ConsoleWindowClass":"";}');
    const script = `
$ErrorActionPreference='Stop'
Add-Type @'
${pointProbe}
${refusal}
${provider}
'@
${focus}
function Check($expected,$actual) {if($actual -ne $expected){throw "Expected $expected; got $actual"}}
function Field {return New-Object System.Windows.Automation.AutomationElement}
$field=Field
[System.Windows.Automation.AutomationElement]::Hit=$field
[System.Windows.Automation.AutomationElement]::FocusedElement=$field
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
$field.Current.IsPassword=$true
Check 3 ([ReachDesktopFieldProbe]::At(-1100,70))
$field.Current.IsPassword=$false
$field.Current.IsEnabled=$false
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$field.Current.IsEnabled=$true
$field.Current.IsOffscreen=$true
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$field.Current.IsOffscreen=$false
$field.Value=New-Object System.Windows.Automation.ValuePattern
$field.Value.Current.IsReadOnly=$true
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$screen=@{Bounds=@{X=-1440;Y=0;Width=1440;Height=1000}}
$p=[pscustomobject]@{x=(340.0/1439);y=(70.0/999)}
Check $false (Get-ReachTextTarget $p $screen).editable
$field.Value.Current.IsReadOnly=$false
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
Check $true (Get-ReachTextTarget $p $screen).editable
Check 0 ([ReachDesktopFieldProbe]::At(-800,70))
Check $false (Get-ReachTextTarget ([pscustomobject]@{x=0;y=0}) $screen).editable
$child=Field;$child.Current.ControlType=[System.Windows.Automation.ControlType]::Text
$child.Current.IsKeyboardFocusable=$false;$child.Parent=$field;$child.Runtime=77
[System.Windows.Automation.AutomationElement]::Hit=$child
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
[System.Windows.Automation.AutomationElement]::FocusedElement=$child
$target=Get-ReachTextTarget $p $screen
Check $true $target.editable
Assert-ReachTypingTarget $target.focus
$other=Field;$other.Runtime=99
[System.Windows.Automation.AutomationElement]::FocusedElement=$other
$refused=$null;try{Assert-ReachTypingTarget $target.focus}catch{$refused=$_.Exception}
# Said as it is to the phone (a ReachRefusal), not as the general failure.
Check $true ($refused -is [ReachRefusal])
Check 'Typing target changed. Tap the field again.' $refused.Message
[System.Windows.Automation.AutomationElement]::FocusedElement=$child
$field.Current.IsEnabled=$false
Check $false (Get-ReachTextTarget $p $screen).editable
$field.Current.IsEnabled=$true
# Four ancestors maximum, without walking the entire desktop.
for($i=0;$i -lt 4;$i++){$next=Field;$next.Current.IsKeyboardFocusable=$false;$next.Parent=$child;$child=$next}
[System.Windows.Automation.AutomationElement]::Hit=$child
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
[System.Windows.Automation.AutomationElement]::Hit=$field
$result=@{};${probeAction}
Check $true $result.field
Check $false $result.secure
Check (-1100) ([System.Windows.Automation.AutomationElement]::LastPoint.X)
Check 70 ([System.Windows.Automation.AutomationElement]::LastPoint.Y)
[System.Windows.Automation.AutomationElement]::Refused=$true
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
[System.Windows.Automation.AutomationElement]::Refused=$false
# Text surfaces count as fields: a document that says its text can be
# changed (a rich text box, Word), or says nothing; never one that says
# read-only (a web page) or mixed, nor one that can't be focused, nor a
# pane. Windows Terminal's text area is a TermControl.
$doc=Field;$doc.Current.ControlType=[System.Windows.Automation.ControlType]::Document;$doc.Text=New-Object System.Windows.Automation.TextPattern
[System.Windows.Automation.AutomationElement]::Hit=$doc
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
[System.Windows.Automation.AutomationElement]::FocusedElement=$doc
Check $true (Get-ReachTextTarget $p $screen).editable
$doc.Text.DocumentRange.ReadOnly=[System.Windows.Automation.AutomationElement]::NotSupported
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
$doc.Text.DocumentRange.ReadOnly=$true
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
Check $false (Get-ReachTextTarget $p $screen).editable
$doc.Text.DocumentRange.ReadOnly=(New-Object Object)
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$doc.Text.DocumentRange.ReadOnly=$false;$doc.Current.IsKeyboardFocusable=$false
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$doc.Current.IsKeyboardFocusable=$true;$doc.Value=New-Object System.Windows.Automation.ValuePattern;$doc.Value.Current.IsReadOnly=$true
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$doc.Value=$null;$doc.Text=$null
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$pane=Field;$pane.Current.ControlType=[System.Windows.Automation.ControlType]::Pane;$pane.Text=New-Object System.Windows.Automation.TextPattern
[System.Windows.Automation.AutomationElement]::Hit=$pane
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
$pane.Current.ClassName='TermControl'
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
$pane.Current.IsKeyboardFocusable=$false
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
# A console (conhost): its text area is a field for the probe and the
# focus check alike, though its own text can't be focused; its title bar,
# above that area, is not.
[System.Windows.Automation.AutomationElement]::Hit=$null
[ReachDesktopFieldProbe]::ConsoleWindow=[IntPtr]9;[ReachDesktopFieldProbe]::Pointed=[IntPtr]9
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
Check 0 ([ReachDesktopFieldProbe]::At(-1100,40))
$console=Field;$console.Current.ControlType=[System.Windows.Automation.ControlType]::Text;$console.Current.IsKeyboardFocusable=$false
$console.Current.NativeWindowHandle=9;$console.Current.BoundingRectangle=New-Object System.Windows.Rect(-1210,20,320,250);$console.Runtime=9
[System.Windows.Automation.AutomationElement]::Window=$console
[System.Windows.Automation.AutomationElement]::FocusedElement=$null
[ReachDesktopFieldProbe]::Front=[IntPtr]9
$target=Get-ReachTextTarget $p $screen
Check $true $target.editable
Check $false $target.secure
Assert-ReachTypingTarget $target.focus
Check $false (Get-ReachTextTarget ([pscustomobject]@{x=(340.0/1439);y=(40.0/999)}) $screen).editable
[ReachDesktopFieldProbe]::Front=[IntPtr]::Zero;[ReachDesktopFieldProbe]::Pointed=[IntPtr]::Zero
# (The probe's own line above reused $field for its answer.)
$edit=Field;[System.Windows.Automation.AutomationElement]::Hit=$edit;[System.Windows.Automation.AutomationElement]::FocusedElement=$edit
# Timed-out provider calls cannot accumulate behind later fingers or publish
# stale results. They continue only as one read-only background worker.
[System.Windows.Automation.AutomationElement]::Delay=800
$calls=[System.Windows.Automation.AutomationElement]::Calls
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
Check ($calls+1) ([System.Windows.Automation.AutomationElement]::Calls)
Start-Sleep -Milliseconds 900
[System.Windows.Automation.AutomationElement]::Delay=0
[System.Windows.Automation.AutomationElement]::Hit=$null
Check 0 ([ReachDesktopFieldProbe]::At(-1100,70))
Write-Output 'Windows field probe and focus guards passed'
`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-field-probe-check-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "probe.ps1");
    await fs.writeFile(file, script, "utf8");
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass", "-File", file,
      ],
      { timeout: 45000, windowsHide: true, maxBuffer: 65536 },
    );
    assert.match(stdout, /Windows field probe and focus guards passed/);
  },
);

test("the shared scroll protocol delivers fine and accelerated movement to Windows without Mac-only metadata", () => {
  for (const [dx, dy] of [
    [0, -1],
    [0, -120],
    [45, 0],
    [-120, 120],
    [0, 0],
  ])
    assert.deepEqual(inputAction({ type: "scroll", dx, dy }), {
      type: "scroll",
      dx,
      dy,
    });
  // Fractions of a pixel reach the helper (it keeps what doesn't make a
  // whole wheel unit for the next step).
  assert.match(
    source,
    /'scroll'\s*\{\[ReachDesktopInput\]::Scroll\(\[double\]\$p\.dx,\[double\]\$p\.dy\)\}/,
  );
  assert.match(
    source,
    /SetThreadDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/,
    "coordinates use physical display pixels",
  );
});

// Run the production C# pointer/scroll/typing implementation in Windows' own
// compiler, replacing input emissions, the window under a point, process
// integrity levels and the tick clock with recordings. This never posts
// input or moves the Windows desktop cursor.
test(
  "Windows native input preserves small wheel deltas, both axes, drag pairing, typed characters, administrator windows and multi-display click coordinates",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    let code = source.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)[1];
    const swap = (from, to) => {
      assert.ok(code.includes(from), from);
      code = code.replace(from, to);
    };
    swap(
      "public class ReachDesktopInput {",
      `public class ReachDesktopInput {
 public static System.Collections.Generic.List<string> Events=new System.Collections.Generic.List<string>();
 public static System.Collections.Generic.List<uint> Times=new System.Collections.Generic.List<uint>();
 public static uint Clock=1000;
 public static IntPtr Pointed=IntPtr.Zero,Foreground=IntPtr.Zero;public static string Looked="";
 public static System.Collections.Generic.Dictionary<uint,int> Levels=new System.Collections.Generic.Dictionary<uint,int>();`,
    );
    swap('[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);',
      'public static bool SetCursorPos(int x,int y){Events.Add("point:"+x+","+y);return true;}');
    swap('[DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra);',
      'static void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra){Events.Add("mouse:"+flags+":"+data);}');
    swap('[DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);',
      'public static void keybd_event(byte key,byte scan,uint flags,UIntPtr extra){Events.Add("keybd:"+key+":"+flags);}');
    swap('[DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);',
      'public static uint SendCount=uint.MaxValue;static uint SendInput(uint count,Input[] inputs,int size){uint sent=Math.Min(count,SendCount);for(int i=0;i<sent;i++){if(inputs[i].type==1)Events.Add("key:"+inputs[i].u.key.vk+":"+inputs[i].u.key.scan+":"+inputs[i].u.key.flags);else{Events.Add("mouse:"+inputs[i].u.mouse.flags+":0");Times.Add(inputs[i].u.mouse.time);}}return sent;}');
    swap('[DllImport("kernel32.dll")] static extern uint GetTickCount();', "static uint GetTickCount(){return Clock;}");
    swap('[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);', "static int GetSystemMetrics(int index){return 4;}");
    swap('[DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint mapType);', "static uint MapVirtualKey(uint code,uint mapType){return code+100;}");
    // Windows: the one under a point, the one in front, and their processes'
    // integrity levels, set by the script below (this process is 1).
    swap('[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();', "public static IntPtr GetForegroundWindow(){return Foreground;}");
    swap('[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);',
      "public static uint GetWindowThreadProcessId(IntPtr window,out uint process){process=(uint)window.ToInt64();return 1;}");
    swap('[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Spot point);', 'static IntPtr WindowFromPoint(Spot point){Looked=point.x+","+point.y;return Pointed;}');
    swap('[DllImport("user32.dll")] static extern bool GetCursorPos(out Spot point);', "static bool GetCursorPos(out Spot point){point=new Spot{x=5,y=6};return true;}");
    swap('[DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();', "static uint GetCurrentProcessId(){return 1;}");
    swap("static int Level(uint pid){", "static int Level(uint pid){if(Levels.ContainsKey(pid))return Levels[pid];");
    code = code.replace(/static Timer timer=new Timer\([^\n]+\);/, ""); // No asynchronous watchdog in the fixture.
    const pointer = source.match(
      /\{(\$b=\$screen\.Bounds;\[ReachDesktopInput\]::Mouse\([^\n]+)\}/,
    )[1];
    const click = source.match(/'click' \{([^\r\n]+)\}\r?\n/)[1];
    const scroll = source.match(/'scroll' \{([^\r\n]+)\}\r?\n/)[1];
    // What Characters must send for each UTF-16 unit: the unit itself, down
    // and up, KEYEVENTF_UNICODE; a line break and a tab as their own keys.
    const unicode = (text) => text.split("").flatMap((u) => [`key:0:${u.charCodeAt(0)}:4`, `key:0:${u.charCodeAt(0)}:6`]);
    const press = (vk) => [`key:${vk}:${vk + 100}:0`, `key:${vk}:${vk + 100}:2`];
    const typed = "caf\u00e9 na\u00efve \u00fc \u2013 \u201cok\u201d \u2019 \u{1F600} \u2713";
    // Into the script as \\uXXXX escapes: PowerShell ends a quoted string at
    // a curly quote too.
    const escaped = typed.split("").map((u) => (u < "\x80" ? u : `\\u${u.charCodeAt(0).toString(16).padStart(4, "0")}`)).join("");
    const script = `
$ErrorActionPreference='Stop'
Add-Type @'
${code}
'@
function Check($expected) {
 $actual=[ReachDesktopInput]::Events -join '|'
 if($actual -ne $expected){throw "Expected $expected; got $actual"}
 [ReachDesktopInput]::Events.Clear()
}
function Refused($action,$words) {
 $e=$null;try{& $action}catch{$e=$_.Exception;while($e -and $e -isnot [ReachRefusal]){$e=$e.InnerException}}
 if(!$e -or $e.Message -ne $words){throw "Expected the refusal: $words"}
}
[ReachDesktopInput]::Levels[[uint32]1]=8192
# Pixels in, wheel units out (2.4 a pixel); what's short of a unit waits
# for the next step, the other way starts afresh.
[ReachDesktopInput]::Scroll(25,-60)
Check 'mouse:2048:-144|mouse:4096:-60'
[ReachDesktopInput]::Scroll(-1,1)
Check 'mouse:2048:2|mouse:4096:2'
[ReachDesktopInput]::Scroll(0,0)
Check ''
[ReachDesktopInput]::Scroll(0,0.3)
Check 'mouse:2048:1'
[ReachDesktopInput]::Scroll(0,0.3)
Check ''
[ReachDesktopInput]::Scroll(0,-0.3)
Check ''
$p=[pscustomobject]@{type='scroll';dx=0;dy=-0.3}
${scroll}
Check 'mouse:2048:-1'
[ReachDesktopInput]::Scroll(0,50)
Check 'mouse:2048:120'
[ReachDesktopInput]::Mouse('down',100,200,$false,1)
[ReachDesktopInput]::Mouse('move',320,40,$false,1)
[ReachDesktopInput]::Mouse('up',360,10,$false,1)
Check 'point:100,200|mouse:2:0|point:320,40|point:360,10|mouse:4:0'
[ReachDesktopInput]::Release()
Check ''
[ReachDesktopInput]::Mouse('down',100,200,$true,1)
[ReachDesktopInput]::Release()
Check 'point:100,200|mouse:8:0|mouse:16:0'
[ReachDesktopInput]::Mouse('click',700,900,$false,2)
Check 'point:700,900|mouse:2:0|mouse:4:0|mouse:2:0|mouse:4:0'
[ReachDesktopInput]::Times.Clear()
if([Runtime.InteropServices.Marshal]::SizeOf([type][ReachDesktopInput+Input]) -ne $(if([IntPtr]::Size -eq 8){40}else{28})){throw 'Wrong SendInput struct size'}
if([ReachDesktopInput]::Click(100,200,$false,1,7,1,0,0) -ne 1){throw 'First tap is not a single click'}
[ReachDesktopInput]::Clock=1700
if([ReachDesktopInput]::Click(101,201,$false,1,7,2,0,0) -ne 2){throw 'Second tap did not complete the double-click'}
Check 'point:100,200|mouse:2:0|mouse:4:0|point:101,201|mouse:2:0|mouse:4:0'
if([ReachDesktopInput]::Times.Count -ne 4){throw 'Double-tapping must emit exactly two physical clicks'}
$times=[ReachDesktopInput]::Times
if($times[0] -ne 1000 -or $times[2] -le $times[0] -or $times[2]-$times[0] -ge 700){throw 'Network delay leaked into the double-click timing'}
if([ReachDesktopInput]::Click(110,205,$false,1,7,2,0,0) -ne 1){throw 'Completed pair was reused'}
Check 'point:110,205|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(100,200,$false,1,70,1,0,0)
if([ReachDesktopInput]::Click(110,205,$false,1,70,2,0,0) -ne 1){throw 'Nearby different targets were merged'}
if([ReachDesktopInput]::ClickX -ne 110 -or [ReachDesktopInput]::ClickY -ne 205){throw 'Second click moved to the first point'}
Check 'point:100,200|mouse:2:0|mouse:4:0|point:110,205|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(100,200,$false,1,8,1,0,0)
[ReachDesktopInput]::ForgetClick()
if([ReachDesktopInput]::Click(150,250,$false,1,8,2,0,0) -ne 1){throw 'Canceled pair was reused'}
Check 'point:100,200|mouse:2:0|mouse:4:0|point:150,250|mouse:2:0|mouse:4:0'
# A finger's drift: within the phone's pairing radius (pair), the second
# tap lands on the first one's point and completes the double-click;
# beyond it, or without it past Windows' own 4 px, two single clicks.
[void][ReachDesktopInput]::Click(300,300,$false,1,11,1,0,0)
if([ReachDesktopInput]::Click(307,304,$false,1,11,2,8,8) -ne 2){throw 'A 7 px finger drift within the pairing radius was two single clicks'}
if([ReachDesktopInput]::ClickX -ne 300 -or [ReachDesktopInput]::ClickY -ne 300){throw 'The paired second click did not land on the first point'}
Check 'point:300,300|mouse:2:0|mouse:4:0|point:300,300|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(300,300,$false,1,12,1,0,0)
if([ReachDesktopInput]::Click(309,300,$false,1,12,2,8,8) -ne 1){throw 'A tap beyond the pairing radius was merged'}
Check 'point:300,300|mouse:2:0|mouse:4:0|point:309,300|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(300,300,$false,1,13,1,0,0)
if([ReachDesktopInput]::Click(303,300,$false,1,13,2,0,0) -ne 1){throw 'Without a pairing radius, 3 px is past Windows own rectangle'}
Check 'point:300,300|mouse:2:0|mouse:4:0|point:303,300|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(300,300,$false,1,14,1,0,0)
if([ReachDesktopInput]::Click(299,293,$false,1,14,2,2.5,8) -ne 2){throw 'Each axis takes the wider of the two tolerances'}
Check 'point:300,300|mouse:2:0|mouse:4:0|point:300,300|mouse:2:0|mouse:4:0'
# The dispatcher turns the phone's pair (shares of the display) into pixels.
$screen=@{Bounds=@{X=0;Y=0;Width=1000;Height=500}}
$result=@{}
$p=[pscustomobject]@{type='click';x=(300/999);y=(300/499);button='left';count=1;clickId=15;clickState=1}
${click}
$p=[pscustomobject]@{type='click';x=(306/999);y=(305/499);button='left';count=1;clickId=15;clickState=2;pair=[pscustomobject]@{x=0.008;y=0.012}}
${click}
if($result.clickState -ne 2 -or !$result.retargeted -or [Math]::Abs($result.point.x*999-300) -gt 1e-6 -or [Math]::Abs($result.point.y*499-300) -gt 1e-6){throw "The paired click did not land on the first point: $($result | ConvertTo-Json -Compress)"}
Check 'point:300,300|mouse:2:0|mouse:4:0|point:300,300|mouse:2:0|mouse:4:0'
# Typing: the characters themselves; a line break (\\n, \\r\\n) a plain
# Return, never Ctrl+Enter; a tab Tab; backspaces Backspace, all SendInput.
[ReachDesktopInput]::Type([Regex]::Unescape('${escaped}'))
Check '${unicode(typed).join("|")}'
[ReachDesktopInput]::Type("first line\`nsecond line")
Check '${[...unicode("first line"), ...press(13), ...unicode("second line")].join("|")}'
[ReachDesktopInput]::Type("a\`r\`nb\`tc")
Check '${[...unicode("a"), ...press(13), ...unicode("b"), ...press(9), ...unicode("c")].join("|")}'
[ReachDesktopInput]::Back(2)
Check '${[...press(8), ...press(8)].join("|")}'
[ReachDesktopInput]::SendCount=1
Refused {[ReachDesktopInput]::Type('q')} 'Windows refused the typing.'
Check 'key:0:113:4'
[ReachDesktopInput]::SendCount=[uint32]::MaxValue
# A window run as administrator (a higher integrity level) is refused,
# with why, before anything is sent; a letting-go always goes.
[ReachDesktopInput]::Pointed=[IntPtr]77;[ReachDesktopInput]::Levels[[uint32]77]=12288
$admin="That window runs as administrator. Windows doesn't let Reach control it."
Refused {[void][ReachDesktopInput]::Click(10,20,$false,1,0,1,0,0)} $admin
if([ReachDesktopInput]::Looked -ne '10,20'){throw 'The click checked another point'}
Refused {[ReachDesktopInput]::Mouse('down',10,20,$false,1)} $admin
Refused {[ReachDesktopInput]::Scroll(0,10)} $admin
if([ReachDesktopInput]::Looked -ne '5,6'){throw 'The scroll did not check the window under the pointer'}
Check ''
[ReachDesktopInput]::Pointed=[IntPtr]::Zero
[ReachDesktopInput]::Mouse('down',1,1,$false,1)
[ReachDesktopInput]::Pointed=[IntPtr]77
[ReachDesktopInput]::Mouse('up',2,2,$false,1)
Check 'point:1,1|mouse:2:0|point:2,2|mouse:4:0'
[ReachDesktopInput]::Foreground=[IntPtr]77
$front="The window in front runs as administrator. Windows doesn't let Reach type into it."
Refused {[ReachDesktopInput]::Type('a')} $front
Refused {[ReachDesktopInput]::Back(1)} $front
Refused {[ReachDesktopInput]::Key(65,$true)} $front
[ReachDesktopInput]::Key(65,$false)
Check 'keybd:65:2'
# The same level, or one that can't be read, is left to Windows.
[ReachDesktopInput]::Levels[[uint32]77]=8192
[ReachDesktopInput]::Type('a')
[ReachDesktopInput]::Levels[[uint32]77]=-1
[void][ReachDesktopInput]::Click(10,20,$false,1,0,1,0,0)
Check 'key:0:97:4|key:0:97:6|point:10,20|mouse:2:0|mouse:4:0'
[ReachDesktopInput]::Pointed=[IntPtr]::Zero;[ReachDesktopInput]::Foreground=[IntPtr]::Zero
[ReachDesktopInput]::SendCount=1
$refused=$false
try{[void][ReachDesktopInput]::Click(350,300,$false,1,9,1,0,0)}catch{$refused=$true}
if(!$refused){throw 'A partial click was acknowledged'}
Check 'point:350,300|mouse:2:0|mouse:4:0'
[ReachDesktopInput]::Release()
Check ''
[ReachDesktopInput]::SendCount=[uint32]::MaxValue
$screen=@{Bounds=@{X=-1440;Y=120;Width=1440;Height=900}}
foreach($case in @(
 @{x=0.0;y=0.0;expected='-1440,120'},
 @{x=1.0;y=1.0;expected='-1,1019'},
 @{x=0.5;y=0.5;expected='-720,570'}
)) {
 $p=[pscustomobject]@{type='click';x=$case.x;y=$case.y;button='left';count=1}
 ${pointer}
 Check "point:$($case.expected)|mouse:2:0|mouse:4:0"
}
Write-Output 'Windows pointer and scroll sequences passed'
`;
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: 45000, windowsHide: true, maxBuffer: 65536 },
    );
    assert.match(stdout, /Windows pointer and scroll sequences passed/);
  },
);

// A password manager's copy stays the owner's on Windows too (parity audit
// #13): what an app asked Windows to keep out of clipboard history and
// monitors (ExcludeClipboardContentFromMonitorProcessing, or
// CanIncludeInClipboardHistory 0) is refused to anyone else, in the Mac's
// words; ordinary text, or a copy allowed in history, still reads. The real
// helper (desktop-input.ps1, -STA as Reach starts it) and the real clipboard
// of a Windows runner's desktop, so only with REACH_TEST_WINDOWS_DESKTOP.
test(
  "on a real Windows desktop a concealed clipboard copy reads only for the owner; ordinary text reads for anyone",
  { skip: process.platform !== "win32" || process.env.REACH_TEST_WINDOWS_DESKTOP !== "1", timeout: 180000 },
  async () => {
    const helper = spawn("powershell.exe", powershellFile(fileURLToPath(new URL("../scripts/native/desktop-input.ps1", import.meta.url)), ["primary"], { sta: true }), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const answers = [];
    helper.stdout.on("data", (b) => {
      out += b;
      let at;
      while ((at = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, at).trim();
        out = out.slice(at + 1);
        if (line.startsWith("{")) answers.push(JSON.parse(line));
      }
    });
    const ask = async (action) => {
      const before = answers.length;
      helper.stdin.write(`${JSON.stringify(action)}\n`);
      for (const end = Date.now() + 60000; answers.length === before; ) {
        if (Date.now() > end) throw Error(`no answer to ${action.type}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return answers[before];
    };
    // The clipboard set as a password manager sets it, by another process.
    const copy = async (marks) => {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
$data=New-Object System.Windows.Forms.DataObject
$data.SetText('hunter2-secret')
${marks}
[System.Windows.Forms.Clipboard]::SetDataObject($data,$true)
`;
      await exec("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 60000, windowsHide: true });
    };
    const stream = (bytes) => `(New-Object System.IO.MemoryStream(,[byte[]](${bytes.join(",")})))`;
    try {
      await ask({ type: "heartbeat" });
      const hidden = "That's a hidden password; only the owner can copy it.";
      await copy(`$data.SetData('ExcludeClipboardContentFromMonitorProcessing',${stream([0, 0, 0, 0])})`);
      assert.deepEqual(await ask({ type: "clipboard-read", owner: false }), { error: hidden });
      assert.equal((await ask({ type: "clipboard-read" })).error, hidden, "no word from Reach is no owner");
      assert.equal((await ask({ type: "clipboard-read", owner: true })).text, "hunter2-secret");
      await copy(`$data.SetData('CanIncludeInClipboardHistory',${stream([0, 0, 0, 0])})`);
      assert.deepEqual(await ask({ type: "clipboard-read", owner: false }), { error: hidden });
      await copy(`$data.SetData('CanIncludeInClipboardHistory',${stream([1, 0, 0, 0])})`);
      assert.equal((await ask({ type: "clipboard-read", owner: false })).text, "hunter2-secret", "allowed in history: not hidden");
      await copy("");
      assert.equal((await ask({ type: "clipboard-read", owner: false })).text, "hunter2-secret");
    } finally {
      helper.stdin.end();
      helper.kill();
    }
  },
);
