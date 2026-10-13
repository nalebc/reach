import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inputAction } from "../server/desktop-protocol.mjs";
const exec = promisify(execFile);
const source = await fs.readFile(
  new URL("../scripts/native/desktop-input.ps1", import.meta.url),
  "utf8",
);
const fieldProbe = source.match(/-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const probeAction = source.match(/'probe'\s*\{([^\r\n]+)\}/)[1];

test("Windows implements the advertised field probe with a bounded read-only hit test and the same focus eligibility", () => {
  assert.match(fieldProbe, /AutomationElement\.FromPoint\(new Point\(x,y\)\)/);
  assert.match(fieldProbe, /worker\.Join\(250\)/);
  assert.match(fieldProbe, /worker!=null && worker\.IsAlive/);
  assert.match(fieldProbe, /depth<4/);
  assert.match(fieldProbe, /!info\.IsOffscreen/);
  assert.match(fieldProbe, /!hasValue \|\| writable/);
  assert.match(
    source,
    /!\$info\.IsOffscreen -and \(!\$hasValue -or \$writable\)/,
  );
  assert.doesNotMatch(
    fieldProbe,
    /\.SetFocus\(|\.Current\.Value\b|ReachDesktopInput|mouse_event/,
  );
  assert.doesNotMatch(probeAction, /Release\(|Mouse\(/);
  assert.match(probeAction, /\$b\.X\+\$p\.x\*\(\$b\.Width-1\)/);
});

// Compile the production C# probe and execute the production PowerShell
// dispatch/focus functions on Windows. Only the UI Automation provider is
// a stand-in; the live provider is covered by windows-desktop-e2e.test.mjs.
test(
  "Windows field detection rejects disabled, read-only, offscreen and out-of-bounds inputs without reading text or blocking clicks",
  {
    skip: process.platform !== "win32",
  },
  async () => {
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
  public static readonly ControlType Edit=new ControlType(),ComboBox=new ControlType(),Text=new ControlType();
 }
 public class ValuePattern {
  public static readonly object Pattern=new object();public ValueInfo Current=new ValueInfo();
  public class ValueInfo { public bool IsReadOnly;public string Value {get{throw new System.Exception("Text must never be read");}} }
 }
 public class FieldInfo {
  public bool IsEnabled=true,IsKeyboardFocusable=true,IsOffscreen=false,IsPassword=false;
  public ControlType ControlType=System.Windows.Automation.ControlType.Edit;public System.Windows.Rect BoundingRectangle=new System.Windows.Rect(-1200,50,300,40);
 }
 public class AutomationElement {
  public FieldInfo Current=new FieldInfo();public ValuePattern Value;public AutomationElement Parent;
  public static AutomationElement Hit,FocusedElement;public static int Delay,Calls;public static bool Refused;
  public static System.Windows.Point LastPoint;
  public static AutomationElement FromPoint(System.Windows.Point at){Calls++;LastPoint=at;
   if(Delay>0)System.Threading.Thread.Sleep(Delay);if(Refused)throw new System.Exception("Provider refused");return Hit;}
  public bool TryGetCurrentPattern(object pattern,out object value){value=Value;return Value!=null;}
  public int[] GetRuntimeId(){return new int[]{42};}
 }
 public class TreeWalker {
  public static readonly TreeWalker RawViewWalker=new TreeWalker();
  public AutomationElement GetParent(AutomationElement element){return element.Parent;}
 }
}
`;
    const focus = source.match(
      /function Get-ReachTextTarget\([\s\S]*?\r?\n}\r?\n/,
    )[0];
    const script = `
$ErrorActionPreference='Stop'
Add-Type @'
${fieldProbe}
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
$child.Current.IsKeyboardFocusable=$false;$child.Parent=$field
[System.Windows.Automation.AutomationElement]::Hit=$child
Check 1 ([ReachDesktopFieldProbe]::At(-1100,70))
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
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
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
  assert.match(
    source,
    /'scroll'\s*\{\[ReachDesktopInput\]::Scroll\(\[int\]\$p\.dx,\[int\]\$p\.dy\)\}/,
  );
  assert.match(
    source,
    /SetThreadDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/,
    "coordinates use physical display pixels",
  );
});

// Run the production C# pointer/scroll implementation in Windows' own
// compiler, replacing just the two input emissions with recordings. This
// never posts input or moves the Windows desktop cursor.
test(
  "Windows native input preserves small wheel deltas, both axes, drag pairing and multi-display click coordinates",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    let code = source.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)[1];
    const cursor =
      '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);';
    const mouse =
      '[DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra);';
    assert.ok(code.includes(cursor) && code.includes(mouse));
    code = code
      .replace(
        "public class ReachDesktopInput {",
        `public class ReachDesktopInput {
 public static System.Collections.Generic.List<string> Events=new System.Collections.Generic.List<string>();`,
      )
      .replace(
        cursor,
        'public static bool SetCursorPos(int x,int y){Events.Add("point:"+x+","+y);return true;}',
      )
      .replace(
        mouse,
        'static void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra){Events.Add("mouse:"+flags+":"+data);}',
      )
      .replace(/static Timer timer=new Timer\([^\n]+\);/, ""); // No asynchronous watchdog in the fixture.
    const pointer = source.match(
      /\{(\$b=\$screen\.Bounds;\[ReachDesktopInput\]::Mouse\([^\n]+)\}/,
    )[1];
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
[ReachDesktopInput]::Scroll(25,-60)
Check 'mouse:2048:-60|mouse:4096:-25'
[ReachDesktopInput]::Scroll(-1,1)
Check 'mouse:2048:1|mouse:4096:1'
[ReachDesktopInput]::Scroll(0,0)
Check ''
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
