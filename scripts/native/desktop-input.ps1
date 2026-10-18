param([string]$Display='primary')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
// A failure the phone shows as said (a typing target that moved, a window
// run as administrator); anything else is the general one (the loop's catch).
public class ReachRefusal : Exception {public ReachRefusal(string message):base(message){}}
public class ReachDesktopInput {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra);
 [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("kernel32.dll")] static extern uint GetTickCount();
 [StructLayout(LayoutKind.Sequential)] public struct MouseInput {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct KeyInput {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 // SendInput's INPUT: a type, then a mouse's or a key's fields in one union,
 // as Windows lays it out (40 bytes on 64-bit, 28 on 32-bit).
 [StructLayout(LayoutKind.Explicit)] public struct Device {[FieldOffset(0)] public MouseInput mouse;[FieldOffset(0)] public KeyInput key;}
 [StructLayout(LayoutKind.Sequential)] public struct Input {public uint type;public Device u;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint mapType);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Spot point);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out Spot point);
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
 [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 [StructLayout(LayoutKind.Sequential)] public struct Spot {public int x,y;}
 // Navigation keys and the Windows key are "extended" keys. Without the flag,
 // arrows can arrive as numeric-keypad keys and Win shortcuts are ignored.
 static readonly byte[] extended={33,34,35,36,37,38,39,40,45,46,91,92};
 public static void Key(byte vk,bool down){ForgetClick();if(down)Front(AdminTyping);uint flags=(down?0u:2u)|(Array.IndexOf(extended,vk)>=0?1u:0u);keybd_event(vk,(byte)MapVirtualKey(vk,0),flags,UIntPtr.Zero);}
 static readonly object gate=new object(); static uint held=0; static DateTime last=DateTime.UtcNow;
 static long previousId=0;static int previousX,previousY;static uint previousTime;static DateTime previousAt;
 public static int ClickX,ClickY;
 static Timer timer=new Timer(_=> {lock(gate){if((DateTime.UtcNow-last).TotalSeconds>2)Release();}},null,500,500);
 public static void Touch(){lock(gate){last=DateTime.UtcNow;}}
 public static void ForgetClick(){lock(gate){previousId=0;}}
 public static void Release(){lock(gate){ForgetClick();if(held!=0)mouse_event(held,0,0,0,UIntPtr.Zero);held=0;}}
 public static void Mouse(string type,int x,int y,bool right,int count){lock(gate){
  if(type=="click"){Click(x,y,right,count,0,1,0,0);return;}
  if(type=="down")Under(x,y);
  Touch();SetCursorPos(x,y);uint down=right?8u:2u,up=right?16u:4u;
  if(type=="down"){Release();held=up;mouse_event(down,0,0,0,UIntPtr.Zero);}if(type=="up")Release();
 }}
 // SendInput timestamps tell Windows these are the two taps of one gesture,
 // even when network delivery separates them. Never replay the first click.
 // https://devblogs.microsoft.com/oldnewthing/20121101-00/?p=6193
 // pairX, pairY: the phone's own pairing radius in pixels (0: none sent).
 public static int Click(int x,int y,bool right,int count,long id,int state,double pairX,double pairY){lock(gate){
  Touch();bool continuing=!right && count==1 && state==2 && id>0 && id==previousId && (DateTime.UtcNow-previousAt).TotalSeconds<2
   && InDoubleClickRect(x,y,pairX,pairY);
  // A finger's second tap, paired by the phone, lands on the first one's
  // point: Windows' own rectangle (a few pixels) is smaller than a finger's
  // drift, and only the same point makes it the same target's double-click.
  if(continuing && (pairX>0 || pairY>0)){x=previousX;y=previousY;}
  Under(x,y);
  uint time=GetTickCount();if(time==0)time=1;
  if(continuing){time=unchecked(previousTime+Math.Max(1u,Math.Min(50u,GetDoubleClickTime()/2)));if(time==0)time=1;}
  Release();SetCursorPos(x,y);ClickX=x;ClickY=y;
  uint down=right?8u:2u,up=right?16u:4u;
  Input[] inputs=new Input[count*2];
  for(int i=0;i<count;i++){inputs[i*2].u.mouse.flags=down;inputs[i*2+1].u.mouse.flags=up;inputs[i*2].u.mouse.time=unchecked(time+(uint)(i*2));inputs[i*2+1].u.mouse.time=unchecked(time+(uint)(i*2+1));}
  held=up;
  try{if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)))!=(uint)inputs.Length)throw new ReachRefusal("Windows refused the click.");held=0;}
  catch{Release();throw;}
  if(!right && count==1 && state!=2 && id>0){previousId=id;previousX=x;previousY=y;previousTime=time;previousAt=DateTime.UtcNow;}
  return continuing?2:count;
 }}
 // Windows' own tolerance (SM_CXDOUBLECLK, SM_CYDOUBLECLK), or the phone's
 // pairing radius where that is wider: each axis on its own. Without it,
 // each tap keeps its own point and Windows routes it to the window there.
 // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getsystemmetrics
 static bool InDoubleClickRect(int x,int y,double pairX,double pairY){
  long dx=(long)x-previousX,dy=(long)y-previousY;
  int w=Math.Max(1,GetSystemMetrics(36)),h=Math.Max(1,GetSystemMetrics(37));
  return (dx>=-(w/2) && dx<(w+1)/2 || Math.Abs(dx)<=pairX) && (dy>=-(h/2) && dy<(h+1)/2 || Math.Abs(dy)<=pairY);
 }
 // dy and dx as a Mac takes them: pixels (positive: content moves down,
 // right). A wheel notch is 120 and scrolls three lines, about 50 px: 2.4 a
 // pixel, so a swipe goes as far as on a Mac (pixels as notches went 2.4
 // times shorter, and old apps dropped the small ones). What doesn't make a
 // whole unit yet waits for the next step, so a slow swipe still scrolls; a
 // swipe back starts afresh. WHEEL agrees; HWHEEL is the other way round
 // (positive scrolls right), so dx is turned for it: a sideways swipe goes
 // the same way on both.
 const double WheelPerPixel=2.4;
 static double restX,restY;
 public static void Scroll(double x,double y){Touch();ForgetClick();Spot at;if(GetCursorPos(out at))Under(at.x,at.y);int wy=Wheel(y,ref restY),wx=Wheel(x,ref restX);if(wy!=0)mouse_event(2048,0,0,wy,UIntPtr.Zero);if(wx!=0)mouse_event(4096,0,0,-wx,UIntPtr.Zero);}
 static int Wheel(double pixels,ref double rest){if(pixels==0)return 0;if(Math.Sign(pixels)!=Math.Sign(rest))rest=0;rest+=pixels*WheelPerPixel;int whole=(int)rest;rest-=whole;return whole;}
 // Typed text as its own characters (KEYEVENTF_UNICODE: UTF-16 units, both
 // halves of an emoji in one batch), never as the layout's keys (SendKeys):
 // a dead key (^ ` ~ and the accents of French, German, Spanish and US
 // International layouts) can't swallow the next letter, AltGr can't arrive
 // as Ctrl+Alt, nothing waits per letter. A line break (\n, \r\n, \r) is a
 // plain Return and a tab is Tab: through the layout (VkKeyScan) a line
 // break was Ctrl+Enter, which sends mail and posts messages. As input.ps1 types.
 public static void Type(string text){Front(AdminTyping);Characters(text);}
 public static void Back(int count){Front(AdminTyping);Press(8,count);}
 static void Characters(string text){
  for(int i=0;i<text.Length;i++){
   char c=text[i];
   if(c=='\r' || c=='\n'){if(c=='\r' && i+1<text.Length && text[i+1]=='\n')i++;Press(13,1);continue;}
   if(c=='\t'){Press(9,1);continue;}
   int width=char.IsHighSurrogate(c) && i+1<text.Length && char.IsLowSurrogate(text[i+1])?2:1;
   var batch=new Input[width*2];
   for(int k=0;k<width;k++){batch[k*2]=KeyEvent(0,text[i+k],4);batch[k*2+1]=KeyEvent(0,text[i+k],6);}
   Send(batch);i+=width-1;
  }
 }
 static void Press(ushort vk,int count){var batch=new Input[count*2];ushort scan=(ushort)MapVirtualKey(vk,0);for(int i=0;i<count;i++){batch[i*2]=KeyEvent(vk,scan,0);batch[i*2+1]=KeyEvent(vk,scan,2);}Send(batch);}
 static Input KeyEvent(ushort vk,ushort scan,uint flags){var input=new Input{type=1};input.u.key.vk=vk;input.u.key.scan=scan;input.u.key.flags=flags;return input;}
 static void Send(Input[] batch){if(batch.Length>0 && SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(Input)))!=(uint)batch.Length)throw new ReachRefusal("Windows refused the typing.");}
 // Windows keeps a program's clicks and keys out of a window that runs at a
 // higher integrity level than its own (one run as administrator: UIPI),
 // and says nothing: mouse_event and keybd_event can't tell, nor can
 // SendInput's count. So the window a click lands on, or the one in front
 // for keys, is checked first, and the phone hears why. A level that can't
 // be read is left to Windows, as before.
 const string AdminClick="That window runs as administrator. Windows doesn't let Reach control it.";
 const string AdminTyping="The window in front runs as administrator. Windows doesn't let Reach type into it.";
 static int own=-2;
 static void Allowed(IntPtr window,string reason){if(window==IntPtr.Zero)return;if(own==-2)own=Level(GetCurrentProcessId());uint pid;GetWindowThreadProcessId(window,out pid);if(own>=0 && pid!=0 && Level(pid)>own)throw new ReachRefusal(reason);}
 static void Under(int x,int y){Allowed(WindowFromPoint(new Spot{x=x,y=y}),AdminClick);}
 static void Front(string reason){Allowed(GetForegroundWindow(),reason);}
 // A process's integrity level, its token's mandatory label (0x2000 medium,
 // 0x3000 high, 0x4000 system), or -1 when it can't be read (agent-desktop.cs IntegrityOf).
 static int Level(uint pid){
  IntPtr process=OpenProcess(0x1000,false,pid),token;if(process==IntPtr.Zero)return -1;
  try{
   if(!OpenProcessToken(process,8,out token))return -1;
   try{
    int size;GetTokenInformation(token,25,IntPtr.Zero,0,out size);if(size<=0 || size>4096)return -1;
    IntPtr buffer=Marshal.AllocHGlobal(size);
    try{
     if(!GetTokenInformation(token,25,buffer,size,out size))return -1;
     IntPtr sid=Marshal.ReadIntPtr(buffer);if(sid==IntPtr.Zero || !IsValidSid(sid))return -1;
     int count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));return count<1?-1:Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
    }finally{Marshal.FreeHGlobal(buffer);}
   }finally{CloseHandle(token);}
  }finally{CloseHandle(process);}
 }
}
'@
# A look at the field under a finger never focuses it or reads its text.
# A slow UI Automation provider cannot delay the click behind the probe:
# allow one background look, bounded to 250 ms, without piling up workers.
Add-Type -ReferencedAssemblies @([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Point].Assembly.Location,[System.Diagnostics.Stopwatch].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Collections.Generic;
using System.Globalization;
using System.Diagnostics;
using System.Text;
public class ReachDesktopFieldProbe {
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Spot point);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr window,StringBuilder name,int size);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Box box);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Spot point);
 [StructLayout(LayoutKind.Sequential)] struct Spot {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct Box {public int left,top,right,bottom;}
 static readonly object gate=new object(); static Thread worker; static volatile bool warm;
 // UI Automation's first call in a process starts its client (seconds on a
 // cold PC): started with the helper, so a finger's first look isn't the
 // one that pays for it. Each look's thread uses the helper's DPI awareness
 // (per-monitor v2), so its points are the same pixels as the click's.
 public static void Warm(){var t=new Thread(()=>{try{SetThreadDpiAwarenessContext(new IntPtr(-4));AutomationElement.FromPoint(new Point(0,0));}catch{}warm=true;});t.IsBackground=true;t.SetApartmentState(ApartmentState.MTA);t.Start();}
 public static int At(double x,double y){lock(gate){
  if(worker!=null && worker.IsAlive)return 0;
  int result=0;
  worker=new Thread(()=>{try{SetThreadDpiAwarenessContext(new IntPtr(-4));result=Read(x,y);warm=true;}catch{}});
  worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();
  return worker.Join(warm?250:1000)?result:0;
 }}
 public static string Fields(int x,int y,int width,int height){lock(gate){
  if(worker!=null && worker.IsAlive)return "[]";
  string result="[]";
  worker=new Thread(()=>{try{SetThreadDpiAwarenessContext(new IntPtr(-4));result=ReadFields(x,y,width,height);warm=true;}catch{}});
  worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();
  return worker.Join(warm?500:1500)?result:"[]";
 }}
 static string Number(double value){return value.ToString("0.####",CultureInfo.InvariantCulture);}
 static string ReadFields(int x,int y,int width,int height){
  if(width<=0 || height<=0)return "[]";
  IntPtr front=GetForegroundWindow();
  AutomationElement root=AutomationElement.FromHandle(front);
  if(root==null)return "[]";
  Rect visible=Rect.Intersect(root.Current.BoundingRectangle,new Rect(x,y,width,height));
  if(visible.IsEmpty)return "[]";
  var result=new StringBuilder("[");int seen=0,found=0;
  // A console in front: its text area is its one field, where nothing covers it.
  Rect console;
  if(ConsoleArea(front,out console)){
   Rect area=Rect.Intersect(console,visible);
   if(!area.IsEmpty && area.Width>=8 && area.Height>=8 && GetAncestor(WindowFromPoint(new Spot{x=(int)(area.X+area.Width/2),y=(int)(area.Y+area.Height/2)}),2)==front)
    Append(result,found++,area,x,y,width,height,false);
   return result.Append(']').ToString();
  }
  var queue=new Queue<AutomationElement>();queue.Enqueue(root);
  var time=Stopwatch.StartNew();
  while(queue.Count>0 && seen++<2048 && found<64 && time.ElapsedMilliseconds<350){
   AutomationElement element=queue.Dequeue();
   try{
    var info=element.Current;
    if(info.IsOffscreen)continue;
    Rect shown=Rect.Intersect(info.BoundingRectangle,visible);
    if(!shown.IsEmpty && shown.Width>=8 && shown.Height>=8 && Editable(element)){
     // A covered field must not open the keyboard. Confirm the same live
     // control at its centre, as the Mac's scanner does, without reading text.
     AutomationElement hit=AutomationElement.FromPoint(new Point(shown.X+shown.Width/2,shown.Y+shown.Height/2));
     bool same=false;
     for(int depth=0;hit!=null && depth<5;depth++){
      if(element.Equals(hit)){same=true;break;}
      hit=TreeWalker.RawViewWalker.GetParent(hit);
     }
     if(same)Append(result,found++,shown,x,y,width,height,info.IsPassword);
    }
    for(AutomationElement child=TreeWalker.RawViewWalker.GetFirstChild(element);child!=null && queue.Count<2048;child=TreeWalker.RawViewWalker.GetNextSibling(child))queue.Enqueue(child);
   }catch{}
  }
  return result.Append(']').ToString();
 }
 static void Append(StringBuilder result,int index,Rect shown,int x,int y,int width,int height,bool secure){
  shown.Inflate(-Math.Min(3,shown.Width/4),-Math.Min(3,shown.Height/4));
  if(index>0)result.Append(',');
  result.Append("{\"x\":").Append(Number((shown.X-x)/width)).Append(",\"y\":").Append(Number((shown.Y-y)/height))
   .Append(",\"w\":").Append(Number(shown.Width/width)).Append(",\"h\":").Append(Number(shown.Height/height))
   .Append(",\"secure\":").Append(secure?"true":"false").Append('}');
 }
 static int Read(double x,double y){
  if(ConsoleAt(x,y))return 1;
  AutomationElement element=AutomationElement.FromPoint(new Point(x,y));
  for(int depth=0;element!=null && depth<4;depth++){
   var info=element.Current;var rect=info.BoundingRectangle;
   if(Editable(element) && !rect.IsEmpty && rect.Width>0 && rect.Height>0
    && x>=rect.Left && x<=rect.Right && y>=rect.Top && y<=rect.Bottom)
    return info.IsPassword?3:1;
   element=TreeWalker.RawViewWalker.GetParent(element);
  }
  return 0;
 }
 // What takes typing, for the probe, the field map and the focus check
 // alike: enabled, on screen, focusable and not read-only; an edit box or a
 // combo box, anything whose value can be written, a document whose text
 // can be changed (a rich text box, Word), or Windows Terminal's text area
 // (TermControl). Never every pane: a read-only value is never a field.
 // Never reads the text.
 public static bool Editable(AutomationElement element){
  var info=element.Current;object pattern;
  if(!info.IsEnabled || info.IsOffscreen || !info.IsKeyboardFocusable)return false;
  if(info.ClassName=="TermControl")return true;
  if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return !((ValuePattern)pattern).Current.IsReadOnly;
  if(info.ControlType==ControlType.Edit || info.ControlType==ControlType.ComboBox)return true;
  return info.ControlType==ControlType.Document && element.TryGetCurrentPattern(TextPattern.Pattern,out pattern) && Changeable((TextPattern)pattern);
 }
 // A document's own word on its text: changeable when it says so, or says
 // nothing; a web page says read-only (or mixed, around its own fields).
 static bool Changeable(TextPattern text){
  object readOnly=text.DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
  return readOnly==AutomationElement.NotSupported || (readOnly is bool && !(bool)readOnly);
 }
 // A console (conhost) takes typing anywhere in its text area, as a Mac's
 // Terminal does, though its own UI Automation text says it can't be
 // focused: its window's client area (no title bar, no scroll bar), in the
 // screen's pixels. Windows Terminal's is its TermControl (Editable).
 static bool ConsoleArea(IntPtr window,out Rect area){
  area=new Rect(0,0,0,0);Box box;Spot at=new Spot();
  if(window==IntPtr.Zero || ClassOf(window)!="ConsoleWindowClass" || !GetClientRect(window,out box) || box.right<=0 || box.bottom<=0 || !ClientToScreen(window,ref at))return false;
  area=new Rect(at.x,at.y,box.right,box.bottom);return true;
 }
 static bool ConsoleAt(double x,double y){
  Rect area;
  return ConsoleArea(GetAncestor(WindowFromPoint(new Spot{x=(int)Math.Floor(x),y=(int)Math.Floor(y)}),2),out area)
   && x>=area.Left && x<area.Right && y>=area.Top && y<area.Bottom;
 }
 static string ClassOf(IntPtr window){var name=new StringBuilder(260);int length=GetClassNameW(window,name,name.Capacity);return length>0?name.ToString(0,length):"";}
 // The console in front, if one is: the typing target the probe found there.
 public static IntPtr FrontConsole(){Rect area;IntPtr window=GetForegroundWindow();return ConsoleArea(window,out area)?window:IntPtr.Zero;}
 // Whether a tap at this point is on the typing target: a console's text
 // area, any other element's own rectangle.
 public static bool Inside(AutomationElement element,double x,double y){
  Rect rect;
  if(!ConsoleArea(new IntPtr(element.Current.NativeWindowHandle),out rect))rect=element.Current.BoundingRectangle;
  return x>=rect.Left && x<=rect.Right && y>=rect.Top && y<=rect.Bottom;
 }
}
'@
[ReachDesktopInput]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
[ReachDesktopFieldProbe]::Warm()
# The display list: asked as -Display list. A bare --list never reached
# $Display (PowerShell reads a leading dash as a parameter name), so the
# helper waited for input and the screen never loaded (Oct 12).
if ($Display -eq 'list' -or $Display -eq '--list' -or $args -contains '--list') {
 $screens=@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{id=($_.DeviceName -replace '^.*(DISPLAY[0-9]+)$','$1');name=$_.DeviceName;primary=$_.Primary;width=$_.Bounds.Width;height=$_.Bounds.Height;x=$_.Bounds.X;y=$_.Bounds.Y} })
 ConvertTo-Json -InputObject $screens -Compress;exit
}
$keys=@{enter=13;backspace=8;tab=9;escape=27;left=37;up=38;right=39;down=40;delete=46;home=36;end=35;pageup=33;pagedown=34;space=32}
$mods=@{meta=91;alt=18;control=17;shift=16}
$typingToken=''
$typingRuntime=''
# A failure the phone shows as said (ReachRefusal); see the loop's catch.
function Stop-Reach($message) {throw (New-Object ReachRefusal $message)}
# The field the keyboard types into: what the probe and the field map call
# a field (ReachDesktopFieldProbe::Editable), or the console in front.
function Get-ReachFocusedTextElement {
 $console=[ReachDesktopFieldProbe]::FrontConsole()
 if($console -ne [IntPtr]::Zero){return [System.Windows.Automation.AutomationElement]::FromHandle($console)}
 $element=[System.Windows.Automation.AutomationElement]::FocusedElement
 for($depth=0;$element -and $depth -lt 4;$depth++) {
  if([ReachDesktopFieldProbe]::Editable($element)) {return $element}
  $element=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
 }
 return $null
}
function Get-ReachTextTarget($payload,$screen) {
 try {
  $element=Get-ReachFocusedTextElement
  if(!$element){throw 'No focused element'}
  $info=$element.Current
  $editable=$true
  if($payload.PSObject.Properties.Name -contains 'x') {
   $b=$screen.Bounds
   $x=$b.X+$payload.x*($b.Width-1);$y=$b.Y+$payload.y*($b.Height-1)
   $editable=$editable -and [ReachDesktopFieldProbe]::Inside($element,$x,$y)
  }
  if(!$editable){throw 'Not an editable field'}
  $runtime=($element.GetRuntimeId() -join '-')
  if($runtime -ne $script:typingRuntime -or !$script:typingToken){$script:typingRuntime=$runtime;$script:typingToken=[Guid]::NewGuid().ToString()}
  return @{editable=$true;focus=$script:typingToken;secure=$info.IsPassword}
 } catch {$script:typingRuntime='';$script:typingToken='';return @{editable=$false}}
}
function Assert-ReachTypingTarget($token) {
 $element=Get-ReachFocusedTextElement
 if(!$token -or $token -ne $script:typingToken -or !$element -or ($element.GetRuntimeId() -join '-') -ne $script:typingRuntime){Stop-Reach 'Typing target changed. Tap the field again.'}
}
# Whether the clipboard holds a copy its app asked Windows to keep private:
# ExcludeClipboardContentFromMonitorProcessing, or CanIncludeInClipboardHistory
# set to 0 (what password managers set). One that can't be read counts as private.
function Test-ReachConcealedClipboard {
 $data=[System.Windows.Forms.Clipboard]::GetDataObject()
 if(!$data){return $false}
 $formats=@($data.GetFormats($false))
 if($formats -contains 'ExcludeClipboardContentFromMonitorProcessing'){return $true}
 if($formats -contains 'CanIncludeInClipboardHistory'){
  $value=$data.GetData('CanIncludeInClipboardHistory',$false)
  if($value -is [System.IO.MemoryStream]){$bytes=$value.ToArray();return !($bytes.Length -ge 4 -and [BitConverter]::ToInt32($bytes,0) -ne 0)}
  return $true
 }
 return $false
}
# Typed as the characters themselves, a line break as Return (ReachDesktopInput::Type).
function Send-ReachText($text) {[ReachDesktopInput]::Type([string]$text)}
# The server's JSON lines are UTF-8, both ways. [Console]'s own reader and
# writer take the console's code page (437, 850...): "caf\u00e9" arrived as
# "caf\u251c\u2310", and copied text went back as wrong (Oct 18, a real
# Windows runner).
$utf8=New-Object System.Text.UTF8Encoding($false)
$reader=New-Object System.IO.StreamReader([Console]::OpenStandardInput(),$utf8)
$writer=New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(),$utf8)
$writer.AutoFlush=$true
try {
 while ($null -ne ($line=$reader.ReadLine())) {
  try {
   [ReachDesktopInput]::Touch()
   $p=$line | ConvertFrom-Json
   $screen=if($Display -eq 'primary'){[System.Windows.Forms.Screen]::PrimaryScreen}else{[System.Windows.Forms.Screen]::AllScreens | Where-Object {($_.DeviceName -replace '^.*(DISPLAY[0-9]+)$','$1') -eq $Display} | Select-Object -First 1}
   if(!$screen){[ReachDesktopInput]::Release();Stop-Reach 'Display disconnected. Select a display again.'}
   $result=@{ok=$true}
   if($p.focus){Assert-ReachTypingTarget $p.focus}
   if($p.type -in 'text','type-edit','menu','release'){[ReachDesktopInput]::ForgetClick()}
   switch ($p.type) {
    {$_ -in 'move','down','up'} {$b=$screen.Bounds;[ReachDesktopInput]::Mouse($p.type,[int]($b.X+$p.x*($b.Width-1)),[int]($b.Y+$p.y*($b.Height-1)),($p.button -eq 'right'),[int]$p.count)}
    'click' {$b=$screen.Bounds;$x=[int]($b.X+$p.x*($b.Width-1));$y=[int]($b.Y+$p.y*($b.Height-1));$result.clickState=[ReachDesktopInput]::Click($x,$y,($p.button -eq 'right'),[int]$p.count,[long]$p.clickId,[int]$p.clickState,[double]$p.pair.x*[Math]::Max(0,$b.Width-1),[double]$p.pair.y*[Math]::Max(0,$b.Height-1));$result.retargeted=([ReachDesktopInput]::ClickX -ne $x -or [ReachDesktopInput]::ClickY -ne $y);$result.point=@{x=([ReachDesktopInput]::ClickX-$b.X)/[Math]::Max(1,$b.Width-1);y=([ReachDesktopInput]::ClickY-$b.Y)/[Math]::Max(1,$b.Height-1)}}
    'focus' {$result.target=Get-ReachTextTarget $p $screen}
    'probe' {$b=$screen.Bounds;$field=[ReachDesktopFieldProbe]::At([int]($b.X+$p.x*($b.Width-1)),[int]($b.Y+$p.y*($b.Height-1)));$result.field=($field -band 1) -ne 0;$result.secure=($field -band 2) -ne 0}
    'fields' {
     $b=$screen.Bounds
     $found=ConvertFrom-Json -InputObject ([ReachDesktopFieldProbe]::Fields($b.X,$b.Y,$b.Width,$b.Height))
     # Windows PowerShell can retain ConvertFrom-Json's array as one pipeline
     # object with value/Count properties. Enumerate it explicitly so the phone
     # receives rectangles, including the empty and single-field cases.
     $result.fields=@(foreach($field in $found){@{x=[double]$field.x;y=[double]$field.y;w=[double]$field.w;h=[double]$field.h;secure=[bool]$field.secure}})
    }
    'context' {
     # The app in front, for context shortcuts. Never reads window content.
     $owner=[uint32]0;[void][ReachDesktopInput]::GetWindowThreadProcessId([ReachDesktopInput]::GetForegroundWindow(),[ref]$owner)
     $proc=Get-Process -Id $owner -ErrorAction SilentlyContinue
     $result.app=if($proc){@{name=$(if($proc.Description){$proc.Description}else{$proc.ProcessName});bundle=$proc.ProcessName.ToLower()}}else{$null}
     $result.items=@()
    }
    'type-edit' {if(!$p.focus -or $p.delete -lt 0 -or $p.delete -gt 256){Stop-Reach 'Invalid typing edit.'};[ReachDesktopInput]::Back([int]$p.delete);Send-ReachText $p.text}
    'scroll' {[ReachDesktopInput]::Scroll([double]$p.dx,[double]$p.dy)}
    'release' {[ReachDesktopInput]::Release()}
    'heartbeat' {$b=$screen.Bounds;$c=[System.Windows.Forms.Cursor]::Position;$result.cursor=@{x=[Math]::Min(1,[Math]::Max(0,($c.X-$b.X)/[Math]::Max(1,$b.Width-1)));y=[Math]::Min(1,[Math]::Max(0,($c.Y-$b.Y)/[Math]::Max(1,$b.Height-1)))}}
    'selection-read' {
     $element=[System.Windows.Automation.AutomationElement]::FocusedElement
     if(!$element -or $element.Current.IsPassword){Stop-Reach 'Select non-password text on your PC first.'}
     $pattern=$null
     if(!$element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){Stop-Reach 'This app does not expose selected text. Use Ctrl+C on the PC, then open Clipboard in Screen options.'}
     $text=(@($pattern.GetSelection() | ForEach-Object {$_.GetText(16385)}) -join '')
     if(!$text -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 16384){Stop-Reach 'Select text up to 16 KiB.'}
     $result.text=$text
    }
    'clipboard-read' {
     # A password manager marks what it copies to be kept out of clipboard
     # history and monitors: only the owner takes that off the PC, as only
     # the owner takes a Mac's concealed copy (desktop-input.swift; parity
     # audit #13). The phone can't say who asks: Reach does ($p.owner).
     if($p.owner -ne $true -and (Test-ReachConcealedClipboard)){$result=@{error="That's a hidden password; only the owner can copy it."}}
     else {$text=[System.Windows.Forms.Clipboard]::GetText();if([Text.Encoding]::UTF8.GetByteCount($text) -gt 16384){Stop-Reach 'Clipboard text exceeds 16 KiB.'};$result.text=$text}
    }
    'clipboard-write' {if($p.text.Length){[System.Windows.Forms.Clipboard]::SetText($p.text)}else{[System.Windows.Forms.Clipboard]::Clear()}}
    'text' {Send-ReachText $p.text}
    'key' {
     $key=if($keys.ContainsKey($p.key)){$keys[$p.key]}elseif($p.key -match '^f([1-9]|1[0-2])$'){111+[int]$Matches[1]}elseif($p.key -match '^[a-z0-9]$'){[int][char]$p.key.ToUpper()}else{Stop-Reach 'Unsupported key'}
     $pressed=@()
     try {foreach($m in $p.modifiers){$vk=$mods[$m];if(!$vk){Stop-Reach 'Unsupported modifier'};[ReachDesktopInput]::Key([byte]$vk,$true);$pressed+=,$vk};[ReachDesktopInput]::Key([byte]$key,$true);[ReachDesktopInput]::Key([byte]$key,$false)}
     finally {[array]::Reverse($pressed);foreach($vk in $pressed){[ReachDesktopInput]::Key([byte]$vk,$false)}}
    }
    default {Stop-Reach 'Unsupported input'}
   }
   $writer.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
  } catch {
   # What Reach knows how to say (a ReachRefusal, from here or from C#), else the general failure.
   [ReachDesktopInput]::Release();$e=$_.Exception;while($e -and $e -isnot [ReachRefusal]){$e=$e.InnerException}
   $writer.WriteLine((@{error=$(if($e){$e.Message}else{'Desktop action failed. Check the selected display and keep Windows unlocked.'})}|ConvertTo-Json -Compress))
  }
 }
} finally {[ReachDesktopInput]::Release()}
