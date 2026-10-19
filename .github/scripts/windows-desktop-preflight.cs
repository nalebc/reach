// Disposable GitHub-hosted CI only. Never used by Reach or its installers.
// https://github.com/actions/runner-images/issues/14069
// https://github.com/electron/electron/pull/54535
// https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-privacy#disableprivacyexperience
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using Pt=System.Drawing.Point;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

public static class ReachCiDesktop {
delegate bool EnumProc(IntPtr window, IntPtr data);
[StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; public Point(int x, int y) { X=x; Y=y; } }
[StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
[StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort Key,Scan; public uint Flags,Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Explicit)] struct InputData { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyInput Key; }
[StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputData Data; }
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
[DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder value, int count);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder value, int count);
[DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
[DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
[DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint count);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder value);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
[DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
[DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out uint value, uint size, out uint needed);
[DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int kind, StringBuilder value, uint size, out uint needed);
[DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);

static string Windows, Sid;
static int Session;
static readonly List<object> Actions = new List<object>();
static string Stage = "guard";
static Dictionary<string,object> Map(params object[] pairs) {
  var result=new Dictionary<string,object>();
  for(int i=0;i<pairs.Length;i+=2) result[(string)pairs[i]]=pairs[i+1];
  return result;
}
sealed class Refusal : Exception { public Refusal(string code) : base(code) {} }
static void Require(bool ok, string reason) { if(!ok) throw new Refusal(reason); }
static void Checkpoint(string name) { try { Console.Error.WriteLine("REACH_CI_DESKTOP_STAGE:"+name); } catch {} }
static void Action(object value) { Require(Actions.Count<64,"action-budget"); Actions.Add(value); }
static string Class(IntPtr h) { var b=new StringBuilder(96); GetClassName(h,b,b.Capacity); return b.ToString(); }
static string ClassCategory(IntPtr h) {
  string value=Class(h);
  if(value=="Windows.UI.Core.CoreWindow") return "core-window";
  if(value=="#32770") return "dialog";
  if(value=="Progman" || value=="WorkerW") return "desktop";
  if(value=="Shell_TrayWnd" || value=="Shell_SecondaryTrayWnd") return "taskbar";
  if(value=="CASCADIA_HOSTING_WINDOW_CLASS" || value=="ConsoleWindowClass") return "terminal";
  return "other";
}
static string TitleCategory(IntPtr h) {
  var b=new StringBuilder(96); GetWindowText(h,b,b.Capacity); string t=b.ToString();
  if(t=="Start") return "start";
  if(t=="Choose privacy settings for your device") return "privacy-setup";
  if(t=="Performance Options" || t=="System Properties") return "performance-setup";
  return "other";
}
static bool Visible(IntPtr h) {
  int cloaked;
  return IsWindowVisible(h) && !IsIconic(h) && DwmGetWindowAttribute(h,14,out cloaked,4)==0 && cloaked==0;
}
static string Image(IntPtr process) {
  var b=new StringBuilder(1024); uint n=(uint)b.Capacity;
  return QueryFullProcessImageName(process,0,b,ref n) ? b.ToString() : null;
}
static bool Mine(IntPtr process) {
  IntPtr token;
  if(!OpenProcessToken(process,8,out token)) return false;
  try {
    uint session,needed;
    if(!GetTokenInformation(token,12,out session,4,out needed) || needed!=4 || session!=(uint)Session) return false;
    using(var identity=new WindowsIdentity(token)) return identity.User!=null && identity.User.Value==Sid;
  } finally { CloseHandle(token); }
}
static string BaseName(string value) {
  if(value==null) return "unknown";
  string name=System.IO.Path.GetFileName(value);
  return name.Length<=80 && System.Text.RegularExpressions.Regex.IsMatch(name,@"^[A-Za-z0-9._-]+$") ? name : "other";
}
static bool Known(string image, string kind) {
  string relative=kind=="oobe" ? @"System32\oobe\UserOOBEBroker.exe"
    : kind=="privacy" ? @"System32\WWAHost.exe"
    : kind=="performance" ? @"System32\SystemPropertiesPerformance.exe"
    : kind=="search" ? @"SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\SearchHost.exe"
    : @"SystemApps\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\StartMenuExperienceHost.exe";
  return String.Equals(image,System.IO.Path.Combine(Windows,relative),StringComparison.OrdinalIgnoreCase);
}
static IntPtr CheckedProcess(uint pid, string kind, bool terminate) {
  // One pinned process handle.
  IntPtr handle=OpenProcess(0x101000u | (terminate ? 1u : 0u),false,pid);
  if(handle==IntPtr.Zero) return IntPtr.Zero;
  if(Mine(handle) && Known(Image(handle),kind)) return handle;
  CloseHandle(handle); throw new Refusal("setup-process-identity");
}
static void Escape() {
  var down=new Input { Type=1,Data=new InputData { Key=new KeyInput { Key=0x1b } } };
  var up=new Input { Type=1,Data=new InputData { Key=new KeyInput { Key=0x1b,Flags=2 } } };
  Require(SendInput(2,new []{down,up},Marshal.SizeOf(typeof(Input)))==2,"escape-input");
}
static List<object> Snapshot() {
  var result=new List<object>();
  Require(EnumWindows(delegate(IntPtr h,IntPtr unused) {
    if(result.Count>=64 || !Visible(h)) return true;
    uint pid; GetWindowThreadProcessId(h,out pid);
    IntPtr p=OpenProcess(0x1000,false,pid);
    try { result.Add(Map("pid",pid,"image",p==IntPtr.Zero ? "unknown" : BaseName(Image(p)),
      "currentUserSession",p!=IntPtr.Zero && Mine(p),"classCategory",ClassCategory(h),"titleCategory",TitleCategory(h),
      "foreground",GetAncestor(GetForegroundWindow(),2)==h)); }
    finally { if(p!=IntPtr.Zero) CloseHandle(p); }
    return true;
  },IntPtr.Zero),"window-enumeration");
  return result;
}
static void StopPrivacy(string name, string kind) {
  foreach(var process in Process.GetProcessesByName(name)) using(process) {
    try { if(process.SessionId!=Session) continue; } catch(InvalidOperationException) { continue; }
    IntPtr handle=CheckedProcess((uint)process.Id,kind,true);
    if(handle==IntPtr.Zero) continue;
    try {
      if(WaitForSingleObject(handle,0)==0) continue;
      if(kind=="privacy") {
        // WWAHost can host other apps. Its path alone does not identify OOBE.
        var id=new StringBuilder(256); uint length=(uint)id.Capacity;
        int status=GetApplicationUserModelId(handle,ref length,id);
        if(WaitForSingleObject(handle,0)==0) continue;
        bool recognized=status==0 && id.ToString().StartsWith("Microsoft.Windows.CloudExperienceHost_cw5n1h2txyewy!",StringComparison.Ordinal);
        Action(Map("action","inspect-privacy-host","pid",process.Id,"appIdentityStatus",status,"recognized",recognized));
        Require(recognized,"privacy-host-app-identity");
      }
      Require(TerminateProcess(handle,0) || WaitForSingleObject(handle,0)==0,"privacy-stop");
      Require(WaitForSingleObject(handle,2000)==0,"privacy-exit");
      Action(Map("action","stop-known-privacy","image",name+".exe","pid",process.Id));
    } finally { CloseHandle(handle); }
  }
}
static int ClearWindows() {
  int remaining=0;
  var windows=new List<IntPtr>();
  Require(EnumWindows(delegate(IntPtr h,IntPtr unused) { if(Visible(h)) windows.Add(h); return true; },IntPtr.Zero),"window-enumeration");
  Require(windows.Count<=128,"window-budget");
  foreach(IntPtr h in windows) {
    string cls=Class(h),category=TitleCategory(h);
    uint pid; GetWindowThreadProcessId(h,out pid);
    string kind=category=="start" && cls=="Windows.UI.Core.CoreWindow" ? "start" : category=="performance-setup" && cls=="#32770" ? "performance" : null;
    if(kind==null) continue;
    IntPtr process=CheckedProcess(pid,kind,false);
    if(process==IntPtr.Zero) continue;
    try {
      uint current; GetWindowThreadProcessId(h,out current); Require(current==pid,"setup-window-changed");
      if(kind=="start") {
        SetForegroundWindow(h);
        Require(GetAncestor(GetForegroundWindow(),2)==h,"start-not-foreground");
        Escape();
      } else {
        UIntPtr ignored; SendMessageTimeout(h,0x10,UIntPtr.Zero,IntPtr.Zero,2,500,out ignored);
      }
      Action(Map("action",kind=="start" ? "escape-visible-start" : "close-known-dialog","pid",pid));
      remaining++;
    } finally { CloseHandle(process); }
  }
  return remaining;
}
static bool ClearLateStart(Form form,TextBox field,Point at) {
  IntPtr start=GetAncestor(WindowFromPoint(at),2),foreground=GetAncestor(GetForegroundWindow(),2);
  if(Class(start)!="Windows.UI.Core.CoreWindow" || TitleCategory(start)!="start") return false;
  uint pid,frontPid; GetWindowThreadProcessId(start,out pid); GetWindowThreadProcessId(foreground,out frontPid);
  IntPtr process=CheckedProcess(pid,"start",false),front=IntPtr.Zero;
  try {
    Require(process!=IntPtr.Zero,"late-start-process");
    front=CheckedProcess(frontPid,foreground==start ? "start" : "search",false);
    Require(front!=IntPtr.Zero && WaitForSingleObject(process,0)==258 && WaitForSingleObject(front,0)==258,"late-start-live");
    uint now,frontNow; GetWindowThreadProcessId(start,out now); GetWindowThreadProcessId(foreground,out frontNow);
    Require(now==pid && frontNow==frontPid && Visible(start) && Class(start)=="Windows.UI.Core.CoreWindow"
      && TitleCategory(start)=="start" && GetAncestor(WindowFromPoint(at),2)==start
      && GetAncestor(GetForegroundWindow(),2)==foreground && form.Visible && Visible(form.Handle)
      && field.Visible && IsWindowVisible(field.Handle) && field.PointToScreen(new Pt(20,12))==new Pt(at.X,at.Y),"late-start-changed");
    Escape();
    Action(Map("action","escape-late-start-search","pid",pid,"foregroundPid",frontPid)); return true;
  } finally { if(front!=IntPtr.Zero) CloseHandle(front); if(process!=IntPtr.Zero) CloseHandle(process); }
}
static void Await(Func<bool> check, int milliseconds, string reason) {
  var timer=Stopwatch.StartNew();
  do { Application.DoEvents(); if(check()) return; Thread.Sleep(10); } while(timer.ElapsedMilliseconds<milliseconds);
  throw new Refusal(reason);
}
static readonly string[] PrivacyKeys={
  @"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo|Enabled",
  @"Software\Microsoft\InputPersonalization|RestrictImplicitInkCollection",
  @"Software\Microsoft\InputPersonalization|RestrictImplicitTextCollection",
  @"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy|HasAccepted"
};
static Dictionary<string,object> PrivacyChoices() {
  var result=new Dictionary<string,object>();
  foreach(string spec in PrivacyKeys) {
    string[] parts=spec.Split('|');
    using(var key=Registry.CurrentUser.OpenSubKey(parts[0])) {
      object value=key==null ? null : key.GetValue(parts[1],null);
      Require(value==null || value is int,"privacy-choice-type");
      result[parts[1]]=value;
    }
  }
  return result;
}
static object SuppressPrivacy(RegistryKey root) {
  using(var key=root.CreateSubKey(@"SOFTWARE\Policies\Microsoft\Windows\OOBE")) {
    object before=key.GetValue("DisablePrivacyExperience",null);
    Require(before==null || before is int,"privacy-policy-type");
    key.SetValue("DisablePrivacyExperience",1,RegistryValueKind.DWord);
    Require((int)key.GetValue("DisablePrivacyExperience")==1,"privacy-policy-readback");
    return Map("before",before,"after",1);
  }
}
static int[] Box(Rectangle value) { return new []{value.X,value.Y,value.Width,value.Height}; }
static object NativeBox(IntPtr window) {
  Rect r;
  return window!=IntPtr.Zero && GetWindowRect(window,out r) ? new []{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top} : null;
}
static object ProbeWindow(IntPtr window, IntPtr form, IntPtr field) {
  if(window==IntPtr.Zero) return Map("role","none","pid",0);
  IntPtr root=GetAncestor(window,2); uint pid; GetWindowThreadProcessId(root,out pid);
  IntPtr process=OpenProcess(0x1000,false,pid);
  try { return Map("role",window==field ? "probe-field" : root==form ? "probe-form" : "other","pid",pid,
    "image",process==IntPtr.Zero ? "unknown" : BaseName(Image(process)),"currentUserSession",process!=IntPtr.Zero && Mine(process),
    "classCategory",ClassCategory(root),"titleCategory",TitleCategory(root)); }
  finally { if(process!=IntPtr.Zero) CloseHandle(process); }
}
static object ProbeState(Form form, TextBox field, Pt? target) {
  // Sanitized geometry only.
  try {
    IntPtr own=form.IsHandleCreated ? form.Handle : IntPtr.Zero;
    IntPtr input=field.IsHandleCreated ? field.Handle : IntPtr.Zero;
    Pt? current=input==IntPtr.Zero ? (Pt?)null : field.PointToScreen(new Pt(20,12));
    return Map("formVisible",form.Visible,"nativeVisible",own!=IntPtr.Zero && IsWindowVisible(own),
      "minimized",own!=IntPtr.Zero && IsIconic(own),"fieldVisible",field.Visible,"fieldFocused",field.Focused,
      "formBounds",Box(form.Bounds),"formClientSize",new []{form.ClientSize.Width,form.ClientSize.Height},
      "formNativeBounds",NativeBox(own),"fieldNativeBounds",NativeBox(input),"fieldClientSize",new []{field.ClientSize.Width,field.ClientSize.Height},
      "targetClient",new []{20,12},"targetScreen",target.HasValue ? new []{target.Value.X,target.Value.Y} : null,
      "currentTargetScreen",current.HasValue ? new []{current.Value.X,current.Value.Y} : null,
      "windowDpi",own==IntPtr.Zero ? 0u : GetDpiForWindow(own),"primaryScreen",Screen.PrimaryScreen==null ? null : Box(Screen.PrimaryScreen.Bounds),
      "virtualScreen",Box(SystemInformation.VirtualScreen),"foreground",ProbeWindow(GetForegroundWindow(),own,input),
      "hit",target.HasValue ? ProbeWindow(WindowFromPoint(new Point(target.Value.X,target.Value.Y)),own,input) : null);
  } catch { return Map("unavailable",true); }
}
static object Probe(Dictionary<string,object> report) {
  var evidence=Map("hitTest",false,"foregroundMatches",false,"clicks",0,"typed",false,"screenPixel",false);
  report["probe"]=evidence;
  IntPtr desktop=OpenInputDesktop(0,false,1);
  Require(desktop!=IntPtr.Zero,"input-desktop");
  try {
    var name=new StringBuilder(64); uint needed;
    Require(GetUserObjectInformation(desktop,2,name,128,out needed) && name.ToString()=="Default","input-desktop-name");
  } finally { CloseDesktop(desktop); }
  Pt original=Cursor.Position;
  using(var form=new Form()) using(var field=new TextBox()) {
    form.Text="Reach CI desktop readiness"; form.ClientSize=new Size(360,160);
    form.StartPosition=FormStartPosition.CenterScreen; form.FormBorderStyle=FormBorderStyle.FixedToolWindow;
    form.ShowInTaskbar=false; form.TopMost=true; form.BackColor=Color.FromArgb(240,130,30);
    field.Location=new Pt(20,20); field.Size=new Size(320,24); form.Controls.Add(field);
    int clicks=0; field.MouseDown+=delegate { clicks++; };
    Pt? target=null;
    try {
      IntPtr own=form.Handle;
      evidence["beforeShow"]=ProbeState(form,field,target);
      Checkpoint("probe-show");
      form.Show(); form.Activate();
      Checkpoint("probe-shown");
      Pt at=field.PointToScreen(new Pt(20,12));
      target=at; evidence["afterShow"]=ProbeState(form,field,target);
      // Restore only our HWND; no thread attachment or focus bypass.
      // https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow
      evidence["showNormalPreviouslyVisible"]=ShowWindow(own,1);
      Checkpoint("probe-activate");
      evidence["activationAccepted"]=SetForegroundWindow(own);
      Checkpoint("probe-activated");
      evidence["afterActivation"]=ProbeState(form,field,target);
      var until=Stopwatch.StartNew(); bool hit=false,foreground=false;
      Application.DoEvents();
      at=field.PointToScreen(new Pt(20,12)); target=at;
      evidence["afterLayout"]=ProbeState(form,field,target);
      int cleared=0; Checkpoint("probe-loop");
      while(until.ElapsedMilliseconds<5000) {
        Application.DoEvents();
        hit=WindowFromPoint(new Point(at.X,at.Y))==field.Handle;
        foreground=GetAncestor(GetForegroundWindow(),2)==form.Handle;
        if(hit) break;
        if(cleared<2) {
          evidence["beforeLateOverlay"+cleared]=ProbeState(form,field,target);
          if(ClearLateStart(form,field,new Point(at.X,at.Y))) {
            Application.DoEvents();
            evidence["afterLateOverlay"+cleared]=ProbeState(form,field,target); cleared++;
            ShowWindow(own,1); SetForegroundWindow(own); Application.DoEvents();
            at=field.PointToScreen(new Pt(20,12)); target=at;
          }
        }
        Thread.Sleep(50);
      }
      evidence["hitTest"]=hit; evidence["foregroundMatches"]=foreground; evidence["hitWaitMs"]=until.ElapsedMilliseconds;
      Require(hit,"probe-hit-test");
      Cursor.Position=at;
      Require(WindowFromPoint(new Point(at.X,at.Y))==field.Handle,"probe-hit-changed");
      var down=new Input { Type=0,Data=new InputData { Mouse=new MouseInput { Flags=2 } } };
      var up=new Input { Type=0,Data=new InputData { Mouse=new MouseInput { Flags=4 } } };
      Checkpoint("probe-click");
      Require(SendInput(2,new []{down,up},Marshal.SizeOf(typeof(Input)))==2,"probe-click-input");
      Await(delegate { return clicks==1 && field.Focused && GetAncestor(GetForegroundWindow(),2)==own; },2000,"probe-click-result");
      evidence["foregroundMatches"]=true; Checkpoint("probe-type");
      foreach(char letter in "reachci") {
        Require(GetAncestor(GetForegroundWindow(),2)==form.Handle,"probe-focus-changed");
        down=new Input { Type=1,Data=new InputData { Key=new KeyInput { Scan=letter,Flags=4 } } };
        up=new Input { Type=1,Data=new InputData { Key=new KeyInput { Scan=letter,Flags=6 } } };
        Require(SendInput(2,new []{down,up},Marshal.SizeOf(typeof(Input)))==2,"probe-key-input");
        Application.DoEvents();
      }
      Await(delegate { return field.Text=="reachci"; },2000,"probe-key-result");
      evidence["typed"]=true;
      Checkpoint("probe-pixel");
      Pt pixel=form.PointToScreen(new Pt(180,110));
      using(var frame=new Bitmap(1,1)) using(var g=Graphics.FromImage(frame)) {
        g.CopyFromScreen(pixel,Pt.Empty,new Size(1,1));
        Color color=frame.GetPixel(0,0);
        evidence["pixel"]=new int[]{color.R,color.G,color.B};
        Require(color.R>200 && color.G>80 && color.G<180 && color.B<80,"probe-screen-pixel");
      }
      evidence["screenPixel"]=true;
      return evidence;
    } finally {
      evidence["clicks"]=clicks; evidence["beforeDispose"]=ProbeState(form,field,target);
      form.Close(); Cursor.Position=original;
    }
  }
}
public static string Run() {
  Checkpoint("native-run");
  var report=Map("schema",1,"ready",false,"actions",Actions);
  var timer=Stopwatch.StartNew();
  try {
    Require(Environment.OSVersion.Platform==PlatformID.Win32NT && Environment.GetEnvironmentVariable("GITHUB_ACTIONS")=="true"
      && Environment.GetEnvironmentVariable("CI")=="true" && Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")=="github-hosted"
      && Environment.GetEnvironmentVariable("GITHUB_REPOSITORY")=="nalebc/reach" && Environment.GetEnvironmentVariable("REACH_CI_DESKTOP_PREFLIGHT")=="1","disposable-hosted-only");
    Windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    Sid=WindowsIdentity.GetCurrent().User.Value; Session=Process.GetCurrentProcess().SessionId;
    Require(Session!=0,"interactive-session");
    report["session"]=Session; report["before"]=Snapshot();
    Stage="privacy-policy"; var choices=PrivacyChoices(); report["privacyChoicesBefore"]=choices;
    report["privacyPolicy"]=Map("machine",SuppressPrivacy(Registry.LocalMachine),"user",SuppressPrivacy(Registry.CurrentUser));
    Stage="known-setup";
    Checkpoint("known-setup");
    int clear=0;
    while(timer.ElapsedMilliseconds<20000 && clear<3) {
      StopPrivacy("UserOOBEBroker","oobe"); StopPrivacy("WWAHost","privacy");
      clear=ClearWindows()==0 ? clear+1 : 0; Thread.Sleep(200);
    }
    Require(clear==3,"setup-remains");
    Stage="desktop-probe"; report["probe"]=Probe(report);
    Stage="verification"; var after=PrivacyChoices(); report["privacyChoicesAfter"]=after;
    foreach(var pair in choices) Require(Object.Equals(pair.Value,after[pair.Key]),"privacy-choice-changed");
    report["privacyChoicesPreserved"]=true;
    var final=Snapshot(); report["after"]=final;
    foreach(Dictionary<string,object> window in final) {
      string category=(string)window["titleCategory"];
      Require(category!="privacy-setup" && category!="performance-setup" && category!="start","setup-returned");
    }
    report["ready"]=true; report["stage"]="ready";
  } catch(Exception e) {
    report["stage"]=Stage;
    report["reason"]=e is Refusal ? e.Message : "native-"+e.GetType().Name;
    try { if(Sid!=null) report["after"]=Snapshot(); } catch { report["afterUnavailable"]=true; }
  }
  report["elapsedMs"]=timer.ElapsedMilliseconds;
  return new JavaScriptSerializer().Serialize(report);
}
}
