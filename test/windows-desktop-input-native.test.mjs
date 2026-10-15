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
  assert.doesNotMatch(source, /x=previousX|y=previousY/);
  assert.match(source, /GetSystemMetrics\(36\).*GetSystemMetrics\(37\)/);
  assert.match(source, /InDoubleClickRect\(x,y\)/);
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
  public int Runtime=42;
  public int[] GetRuntimeId(){return new int[]{Runtime};}
 }
 public class TreeWalker {
  public static readonly TreeWalker RawViewWalker=new TreeWalker();
  public AutomationElement GetParent(AutomationElement element){return element.Parent;}
 }
}
`;
    const focus = ["Get-ReachFocusedTextElement", "Get-ReachTextTarget", "Assert-ReachTypingTarget"]
      .map((name) => source.match(new RegExp(`function ${name}[^\\n]*\\n[\\s\\S]*?\\r?\\n}\\r?\\n`))[0]).join("\n");
    // This fixture replaces only the point-provider API. Field-tree scans use
    // the actual UI Automation provider in windows-desktop-e2e, so keep their
    // separate methods out of this intentionally small provider stub.
    const pointProbe = fieldProbe.replace(/ public static string Fields[\s\S]*?(?= static int Read\()/, "");
    const script = `
$ErrorActionPreference='Stop'
Add-Type @'
${pointProbe}
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
$refused=$false;try{Assert-ReachTypingTarget $target.focus}catch{$refused=$true}
Check $true $refused
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
// compiler, replacing input emissions and the tick clock with recordings. This
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
    const sendInput =
      '[DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);';
    assert.ok(code.includes(sendInput));
    code = code
      .replace(
        "public class ReachDesktopInput {",
        `public class ReachDesktopInput {
 public static System.Collections.Generic.List<string> Events=new System.Collections.Generic.List<string>();
 public static System.Collections.Generic.List<uint> Times=new System.Collections.Generic.List<uint>();
 public static uint Clock=1000;`,
      )
      .replace(
        cursor,
        'public static bool SetCursorPos(int x,int y){Events.Add("point:"+x+","+y);return true;}',
      )
      .replace(
        mouse,
        'static void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra){Events.Add("mouse:"+flags+":"+data);}',
      )
      .replace(
        sendInput,
        'public static uint SendCount=uint.MaxValue;static uint SendInput(uint count,Input[] inputs,int size){uint sent=Math.Min(count,SendCount);for(int i=0;i<sent;i++){Events.Add("mouse:"+inputs[i].mouse.flags+":0");Times.Add(inputs[i].mouse.time);}return sent;}',
      )
      .replace(
        '[DllImport("kernel32.dll")] static extern uint GetTickCount();',
        "static uint GetTickCount(){return Clock;}",
      )
      .replace(
        '[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);',
        "static int GetSystemMetrics(int index){return 4;}",
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
[ReachDesktopInput]::Times.Clear()
if([Runtime.InteropServices.Marshal]::SizeOf([type][ReachDesktopInput+Input]) -ne $(if([IntPtr]::Size -eq 8){40}else{28})){throw 'Wrong SendInput struct size'}
if([ReachDesktopInput]::Click(100,200,$false,1,7,1) -ne 1){throw 'First tap is not a single click'}
[ReachDesktopInput]::Clock=1700
if([ReachDesktopInput]::Click(101,201,$false,1,7,2) -ne 2){throw 'Second tap did not complete the double-click'}
Check 'point:100,200|mouse:2:0|mouse:4:0|point:101,201|mouse:2:0|mouse:4:0'
if([ReachDesktopInput]::Times.Count -ne 4){throw 'Double-tapping must emit exactly two physical clicks'}
$times=[ReachDesktopInput]::Times
if($times[0] -ne 1000 -or $times[2] -le $times[0] -or $times[2]-$times[0] -ge 700){throw 'Network delay leaked into the double-click timing'}
if([ReachDesktopInput]::Click(110,205,$false,1,7,2) -ne 1){throw 'Completed pair was reused'}
Check 'point:110,205|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(100,200,$false,1,70,1)
if([ReachDesktopInput]::Click(110,205,$false,1,70,2) -ne 1){throw 'Nearby different targets were merged'}
if([ReachDesktopInput]::ClickX -ne 110 -or [ReachDesktopInput]::ClickY -ne 205){throw 'Second click moved to the first point'}
Check 'point:100,200|mouse:2:0|mouse:4:0|point:110,205|mouse:2:0|mouse:4:0'
[void][ReachDesktopInput]::Click(100,200,$false,1,8,1)
[ReachDesktopInput]::ForgetClick()
if([ReachDesktopInput]::Click(150,250,$false,1,8,2) -ne 1){throw 'Canceled pair was reused'}
Check 'point:100,200|mouse:2:0|mouse:4:0|point:150,250|mouse:2:0|mouse:4:0'
[ReachDesktopInput]::SendCount=1
$refused=$false
try{[void][ReachDesktopInput]::Click(350,300,$false,1,9,1)}catch{$refused=$true}
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
