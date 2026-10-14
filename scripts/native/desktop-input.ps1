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
public class ReachDesktopInput {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra);
 [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("kernel32.dll")] static extern uint GetTickCount();
 [StructLayout(LayoutKind.Sequential)] public struct MouseInput {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct Input {public uint type;public MouseInput mouse;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint mapType);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 // Navigation keys and the Windows key are "extended" keys. Without the flag,
 // arrows can arrive as numeric-keypad keys and Win shortcuts are ignored.
 static readonly byte[] extended={33,34,35,36,37,38,39,40,45,46,91,92};
 public static void Key(byte vk,bool down){ForgetClick();uint flags=(down?0u:2u)|(Array.IndexOf(extended,vk)>=0?1u:0u);keybd_event(vk,(byte)MapVirtualKey(vk,0),flags,UIntPtr.Zero);}
 static readonly object gate=new object(); static uint held=0; static DateTime last=DateTime.UtcNow;
 static long previousId=0;static int previousX,previousY;static uint previousTime;static DateTime previousAt;
 public static int ClickX,ClickY;
 static Timer timer=new Timer(_=> {lock(gate){if((DateTime.UtcNow-last).TotalSeconds>2)Release();}},null,500,500);
 public static void Touch(){lock(gate){last=DateTime.UtcNow;}}
 public static void ForgetClick(){lock(gate){previousId=0;}}
 public static void Release(){lock(gate){ForgetClick();if(held!=0)mouse_event(held,0,0,0,UIntPtr.Zero);held=0;}}
 public static void Mouse(string type,int x,int y,bool right,int count){lock(gate){
  if(type=="click"){Click(x,y,right,count,0,1);return;}
  Touch();SetCursorPos(x,y);uint down=right?8u:2u,up=right?16u:4u;
  if(type=="down"){Release();held=up;mouse_event(down,0,0,0,UIntPtr.Zero);}if(type=="up")Release();
 }}
 // SendInput timestamps tell Windows these are the two taps of one gesture,
 // even when network delivery separates them. Never replay the first click.
 // https://devblogs.microsoft.com/oldnewthing/20121101-00/?p=6193
 public static int Click(int x,int y,bool right,int count,long id,int state){lock(gate){
  Touch();bool continuing=!right && count==1 && state==2 && id>0 && id==previousId && (DateTime.UtcNow-previousAt).TotalSeconds<2
   && InDoubleClickRect(x,y);
  uint time=GetTickCount();if(time==0)time=1;
  if(continuing){time=unchecked(previousTime+Math.Max(1u,Math.Min(50u,GetDoubleClickTime()/2)));if(time==0)time=1;}
  Release();SetCursorPos(x,y);ClickX=x;ClickY=y;
  uint down=right?8u:2u,up=right?16u:4u;
  Input[] inputs=new Input[count*2];
  for(int i=0;i<count;i++){inputs[i*2].mouse.flags=down;inputs[i*2+1].mouse.flags=up;inputs[i*2].mouse.time=unchecked(time+(uint)(i*2));inputs[i*2+1].mouse.time=unchecked(time+(uint)(i*2+1));}
  held=up;
  try{if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)))!=(uint)inputs.Length)throw new InvalidOperationException("Windows refused the click");held=0;}
  catch{Release();throw;}
  if(!right && count==1 && state!=2 && id>0){previousId=id;previousX=x;previousY=y;previousTime=time;previousAt=DateTime.UtcNow;}
  return continuing?2:count;
 }}
 // Keep the actual second point. Windows applies its own spatial tolerance
 // and routes input to the window under that point, even for a rapid pair.
 // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getsystemmetrics
 static bool InDoubleClickRect(int x,int y){
  long dx=(long)x-previousX,dy=(long)y-previousY;
  int w=Math.Max(1,GetSystemMetrics(36)),h=Math.Max(1,GetSystemMetrics(37));
  return dx>=-(w/2) && dx<(w+1)/2 && dy>=-(h/2) && dy<(h+1)/2;
 }
 // dy and dx as a Mac takes them (positive: content moves down, right).
 // WHEEL agrees; HWHEEL is the other way round (positive scrolls right),
 // so dx is turned for it: a sideways swipe goes the same way on both.
 public static void Scroll(int x,int y){Touch();ForgetClick();if(y!=0)mouse_event(2048,0,0,y,UIntPtr.Zero);if(x!=0)mouse_event(4096,0,0,-x,UIntPtr.Zero);}
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
  AutomationElement root=AutomationElement.FromHandle(GetForegroundWindow());
  if(root==null)return "[]";
  Rect visible=Rect.Intersect(root.Current.BoundingRectangle,new Rect(x,y,width,height));
  if(visible.IsEmpty)return "[]";
  var queue=new Queue<AutomationElement>();queue.Enqueue(root);
  var result=new StringBuilder("[");int seen=0,found=0;
  var time=Stopwatch.StartNew();
  while(queue.Count>0 && seen++<2048 && found<64 && time.ElapsedMilliseconds<350){
   AutomationElement element=queue.Dequeue();
   try{
    var info=element.Current;Rect rect=info.BoundingRectangle;object pattern;
    if(info.IsOffscreen)continue;
    bool value=element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern);
    bool writable=value && !((ValuePattern)pattern).Current.IsReadOnly;
    bool editable=info.IsEnabled && info.IsKeyboardFocusable && (!value || writable)
     && (info.ControlType==ControlType.Edit || info.ControlType==ControlType.ComboBox || writable);
    Rect shown=Rect.Intersect(rect,visible);
    if(editable && !shown.IsEmpty && shown.Width>=8 && shown.Height>=8){
     // A covered field must not open the keyboard. Confirm the same live
     // control at its centre, as the Mac's scanner does, without reading text.
     AutomationElement hit=AutomationElement.FromPoint(new Point(shown.X+shown.Width/2,shown.Y+shown.Height/2));
     bool same=false;
     for(int depth=0;hit!=null && depth<5;depth++){
      if(element.Equals(hit)){same=true;break;}
      hit=TreeWalker.RawViewWalker.GetParent(hit);
     }
     if(same){
      shown.Inflate(-Math.Min(3,shown.Width/4),-Math.Min(3,shown.Height/4));
      if(found++>0)result.Append(',');
      result.Append("{\"x\":").Append(Number((shown.X-x)/width)).Append(",\"y\":").Append(Number((shown.Y-y)/height))
       .Append(",\"w\":").Append(Number(shown.Width/width)).Append(",\"h\":").Append(Number(shown.Height/height))
       .Append(",\"secure\":").Append(info.IsPassword?"true":"false").Append('}');
     }
    }
    for(AutomationElement child=TreeWalker.RawViewWalker.GetFirstChild(element);child!=null && queue.Count<2048;child=TreeWalker.RawViewWalker.GetNextSibling(child))queue.Enqueue(child);
   }catch{}
  }
  return result.Append(']').ToString();
 }
 static int Read(double x,double y){
  AutomationElement element=AutomationElement.FromPoint(new Point(x,y));
  for(int depth=0;element!=null && depth<4;depth++){
   var info=element.Current;var rect=info.BoundingRectangle;object value;
   bool hasValue=element.TryGetCurrentPattern(ValuePattern.Pattern,out value);
   bool writable=hasValue && !((ValuePattern)value).Current.IsReadOnly;
   bool editable=info.IsEnabled && info.IsKeyboardFocusable && !info.IsOffscreen
    && (!hasValue || writable) && (info.ControlType==ControlType.Edit || info.ControlType==ControlType.ComboBox || writable);
   if(editable && !rect.IsEmpty && rect.Width>0 && rect.Height>0
    && x>=rect.Left && x<=rect.Right && y>=rect.Top && y<=rect.Bottom)
    return info.IsPassword?3:1;
   element=TreeWalker.RawViewWalker.GetParent(element);
  }
  return 0;
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
function Get-ReachFocusedTextElement {
 $element=[System.Windows.Automation.AutomationElement]::FocusedElement
 for($depth=0;$element -and $depth -lt 4;$depth++) {
  $info=$element.Current;$pattern=$null
  $hasValue=$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)
  $writable=$hasValue -and !$pattern.Current.IsReadOnly
  if($info.IsEnabled -and $info.IsKeyboardFocusable -and !$info.IsOffscreen -and (!$hasValue -or $writable) -and ($info.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $info.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -or $writable)) {return $element}
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
   $b=$screen.Bounds;$rect=$info.BoundingRectangle
   $x=$b.X+$payload.x*($b.Width-1);$y=$b.Y+$payload.y*($b.Height-1)
   $editable=$editable -and $x -ge $rect.Left -and $x -le $rect.Right -and $y -ge $rect.Top -and $y -le $rect.Bottom
  }
  if(!$editable){throw 'Not an editable field'}
  $runtime=($element.GetRuntimeId() -join '-')
  if($runtime -ne $script:typingRuntime -or !$script:typingToken){$script:typingRuntime=$runtime;$script:typingToken=[Guid]::NewGuid().ToString()}
  return @{editable=$true;focus=$script:typingToken;secure=$info.IsPassword}
 } catch {$script:typingRuntime='';$script:typingToken='';return @{editable=$false}}
}
function Assert-ReachTypingTarget($token) {
 $element=Get-ReachFocusedTextElement
 if(!$token -or $token -ne $script:typingToken -or !$element -or ($element.GetRuntimeId() -join '-') -ne $script:typingRuntime){throw 'Typing target changed. Tap the field again.'}
}
function Send-ReachText($text) {
 foreach($c in $text.ToCharArray()){$s=[string]$c;if('+^%~()[]{}'.Contains($s)){$s='{'+$s+'}'};[System.Windows.Forms.SendKeys]::SendWait($s)}
}
try {
 while ($null -ne ($line=[Console]::ReadLine())) {
  try {
   [ReachDesktopInput]::Touch()
   $p=$line | ConvertFrom-Json
   $screen=if($Display -eq 'primary'){[System.Windows.Forms.Screen]::PrimaryScreen}else{[System.Windows.Forms.Screen]::AllScreens | Where-Object {($_.DeviceName -replace '^.*(DISPLAY[0-9]+)$','$1') -eq $Display} | Select-Object -First 1}
   if(!$screen){[ReachDesktopInput]::Release();throw 'Display disconnected. Select a display again.'}
   $result=@{ok=$true}
   if($p.focus){Assert-ReachTypingTarget $p.focus}
   if($p.type -in 'text','type-edit','menu','release'){[ReachDesktopInput]::ForgetClick()}
   switch ($p.type) {
    {$_ -in 'move','down','up'} {$b=$screen.Bounds;[ReachDesktopInput]::Mouse($p.type,[int]($b.X+$p.x*($b.Width-1)),[int]($b.Y+$p.y*($b.Height-1)),($p.button -eq 'right'),[int]$p.count)}
    'click' {$b=$screen.Bounds;$x=[int]($b.X+$p.x*($b.Width-1));$y=[int]($b.Y+$p.y*($b.Height-1));$result.clickState=[ReachDesktopInput]::Click($x,$y,($p.button -eq 'right'),[int]$p.count,[long]$p.clickId,[int]$p.clickState);$result.retargeted=([ReachDesktopInput]::ClickX -ne $x -or [ReachDesktopInput]::ClickY -ne $y);$result.point=@{x=([ReachDesktopInput]::ClickX-$b.X)/[Math]::Max(1,$b.Width-1);y=([ReachDesktopInput]::ClickY-$b.Y)/[Math]::Max(1,$b.Height-1)}}
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
    'type-edit' {if(!$p.focus -or $p.delete -lt 0 -or $p.delete -gt 256){throw 'Invalid typing edit'};for($i=0;$i -lt $p.delete;$i++){[System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')};Send-ReachText $p.text}
    'scroll' {[ReachDesktopInput]::Scroll([int]$p.dx,[int]$p.dy)}
    'release' {[ReachDesktopInput]::Release()}
    'heartbeat' {$b=$screen.Bounds;$c=[System.Windows.Forms.Cursor]::Position;$result.cursor=@{x=[Math]::Min(1,[Math]::Max(0,($c.X-$b.X)/[Math]::Max(1,$b.Width-1)));y=[Math]::Min(1,[Math]::Max(0,($c.Y-$b.Y)/[Math]::Max(1,$b.Height-1)))}}
    'selection-read' {
     $element=[System.Windows.Automation.AutomationElement]::FocusedElement
     if(!$element -or $element.Current.IsPassword){throw 'Select non-password text first'}
     $pattern=$null
     if(!$element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){throw 'This app does not expose selected text'}
     $text=(@($pattern.GetSelection() | ForEach-Object {$_.GetText(16385)}) -join '')
     if(!$text -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 16384){throw 'Select text up to 16 KiB'}
     $result.text=$text
    }
    'clipboard-read' {$text=[System.Windows.Forms.Clipboard]::GetText();if([Text.Encoding]::UTF8.GetByteCount($text) -gt 16384){throw 'Clipboard text exceeds 16 KiB.'};$result.text=$text}
    'clipboard-write' {if($p.text.Length){[System.Windows.Forms.Clipboard]::SetText($p.text)}else{[System.Windows.Forms.Clipboard]::Clear()}}
    'text' {Send-ReachText $p.text}
    'key' {
     $key=if($keys.ContainsKey($p.key)){$keys[$p.key]}elseif($p.key -match '^f([1-9]|1[0-2])$'){111+[int]$Matches[1]}elseif($p.key -match '^[a-z0-9]$'){[int][char]$p.key.ToUpper()}else{throw 'Unsupported key'}
     $pressed=@()
     try {foreach($m in $p.modifiers){$vk=$mods[$m];if(!$vk){throw 'Unsupported modifier'};[ReachDesktopInput]::Key([byte]$vk,$true);$pressed+=,$vk};[ReachDesktopInput]::Key([byte]$key,$true);[ReachDesktopInput]::Key([byte]$key,$false)}
     finally {[array]::Reverse($pressed);foreach($vk in $pressed){[ReachDesktopInput]::Key([byte]$vk,$false)}}
    }
    default {throw 'Unsupported input'}
   }
   [Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
  } catch {[ReachDesktopInput]::Release();[Console]::WriteLine((@{error='Desktop action failed. Check the selected display and keep Windows unlocked.'}|ConvertTo-Json -Compress))}
 }
} finally {[ReachDesktopInput]::Release()}
