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
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint mapType);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 // Navigation keys and the Windows key are "extended" keys. Without the flag,
 // arrows can arrive as numeric-keypad keys and Win shortcuts are ignored.
 static readonly byte[] extended={33,34,35,36,37,38,39,40,45,46,91,92};
 public static void Key(byte vk,bool down){uint flags=(down?0u:2u)|(Array.IndexOf(extended,vk)>=0?1u:0u);keybd_event(vk,(byte)MapVirtualKey(vk,0),flags,UIntPtr.Zero);}
 static readonly object gate=new object(); static uint held=0; static DateTime last=DateTime.UtcNow;
 static Timer timer=new Timer(_=> {lock(gate){if((DateTime.UtcNow-last).TotalSeconds>2)Release();}},null,500,500);
 public static void Touch(){lock(gate){last=DateTime.UtcNow;}}
 public static void Release(){lock(gate){if(held!=0)mouse_event(held,0,0,0,UIntPtr.Zero);held=0;}}
 public static void Mouse(string type,int x,int y,bool right,int count){lock(gate){Touch();SetCursorPos(x,y);uint down=right?8u:2u,up=right?16u:4u;if(type=="down"){Release();held=up;mouse_event(down,0,0,0,UIntPtr.Zero);}if(type=="up")Release();if(type=="click"){Release();for(int i=0;i<count;i++){mouse_event(down,0,0,0,UIntPtr.Zero);mouse_event(up,0,0,0,UIntPtr.Zero);}}}}
 // dy and dx as a Mac takes them (positive: content moves down, right).
 // WHEEL agrees; HWHEEL is the other way round (positive scrolls right),
 // so dx is turned for it: a sideways swipe goes the same way on both.
 public static void Scroll(int x,int y){Touch();if(y!=0)mouse_event(2048,0,0,y,UIntPtr.Zero);if(x!=0)mouse_event(4096,0,0,-x,UIntPtr.Zero);}
}
'@
# A look at the field under a finger never focuses it or reads its text.
# A slow UI Automation provider cannot delay the click behind the probe:
# allow one background look, bounded to 250 ms, without piling up workers.
Add-Type -ReferencedAssemblies @([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Point].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
public class ReachDesktopFieldProbe {
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
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
function Get-ReachTextTarget($payload,$screen) {
 try {
  $element=[System.Windows.Automation.AutomationElement]::FocusedElement
  if(!$element){throw 'No focused element'}
  $info=$element.Current
  $pattern=$null
  $hasValue=$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)
  $writable=$hasValue -and !$pattern.Current.IsReadOnly
  $editable=$info.IsEnabled -and $info.IsKeyboardFocusable -and !$info.IsOffscreen -and (!$hasValue -or $writable) -and ($info.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $info.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -or $writable)
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
 $element=[System.Windows.Automation.AutomationElement]::FocusedElement
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
   switch ($p.type) {
    {$_ -in 'move','down','up','click'} {$b=$screen.Bounds;[ReachDesktopInput]::Mouse($p.type,[int]($b.X+$p.x*($b.Width-1)),[int]($b.Y+$p.y*($b.Height-1)),($p.button -eq 'right'),[int]$p.count)}
    'focus' {$result.target=Get-ReachTextTarget $p $screen}
    'probe' {$b=$screen.Bounds;$field=[ReachDesktopFieldProbe]::At(($b.X+$p.x*($b.Width-1)),($b.Y+$p.y*($b.Height-1)));$result.field=($field -band 1) -ne 0;$result.secure=($field -band 2) -ne 0}
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
   [Console]::WriteLine(($result | ConvertTo-Json -Compress))
  } catch {[ReachDesktopInput]::Release();[Console]::WriteLine((@{error='Desktop action failed. Check the selected display and keep Windows unlocked.'}|ConvertTo-Json -Compress))}
 }
} finally {[ReachDesktopInput]::Release()}
