$ErrorActionPreference='Stop'
try {
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ReachInput {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra);
 [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint mapType);
 [StructLayout(LayoutKind.Sequential)] public struct MouseInput {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct KeyInput {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] public struct Device {[FieldOffset(0)] public MouseInput mouse;[FieldOffset(0)] public KeyInput key;}
 [StructLayout(LayoutKind.Sequential)] public struct Input {public uint type;public Device u;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
 // Typed as desktop-input.ps1 types: the characters themselves, a line
 // break as a plain Return and a tab as Tab, never the layout's keys.
 public static void Type(string text){Characters(text);}
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
 // Characters and Press build adjacent down/up pairs. A partial prefix can
 // leave only its final accepted down held. Release that event alone, with
 // its original Unicode/scan flags; never send the rest or unrelated keys.
 static bool ReleaseAcceptedDown(Input[] batch,uint sent){
  if(sent==0)return true;
  if(sent>batch.Length)return false;
  Input release=batch[(int)sent-1];
  if(release.type!=1 || (release.u.key.flags&2)!=0)return true;
  release.u.key.flags|=2;
  try{return SendInput(1,new Input[]{release},Marshal.SizeOf(typeof(Input)))==1;}catch{return false;}
 }
 static void Send(Input[] batch){
  if(batch.Length==0)return;
  uint sent;
  try{sent=SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(Input)));}
  catch(Exception error){throw new InvalidOperationException("Windows refused the typing; input delivery could not be confirmed.",error);}
  if(sent==(uint)batch.Length)return;
  bool released=ReleaseAcceptedDown(batch,sent);
  throw new InvalidOperationException(released?"Windows refused the typing.":"Windows refused the typing; a key release could not be confirmed.");
 }
}
'@
# UTF-8, as the server writes it (the console's own reader takes its code page).
$payload = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(),(New-Object System.Text.UTF8Encoding($false)))).ReadToEnd() | ConvertFrom-Json
if ($payload.type -eq 'click') {
 $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
 [ReachInput]::SetCursorPos([int]($bounds.Left + $payload.x * ($bounds.Width - 1)),[int]($bounds.Top + $payload.y * ($bounds.Height - 1))) | Out-Null
 $down = 2; $up = 4
 if ($payload.button -eq 'right') { $down = 8; $up = 16 }
 $count = 1
 if ($payload.count -eq 2) { $count = 2 }
 for ($i=0; $i -lt $count; $i++) {
  [ReachInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  [ReachInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
 }
} elseif ($payload.type -eq 'scroll') {
 # delta is whole steps (server/platform.mjs: -10 to 10), a wheel notch each.
 [ReachInput]::mouse_event(2048,0,0,([int]$payload.delta * 120),[UIntPtr]::Zero)
} elseif ($payload.type -eq 'text') {
 [ReachInput]::Type([string]$payload.text)
} elseif ($payload.type -eq 'key') {
 $keys = @{enter='{ENTER}';backspace='{BACKSPACE}';tab='{TAB}';escape='{ESC}';left='{LEFT}';right='{RIGHT}';up='{UP}';down='{DOWN}'}
 if (!$keys.ContainsKey($payload.key)) { throw 'Unsupported key' }
 [System.Windows.Forms.SendKeys]::SendWait($keys[$payload.key])
} else { throw 'Unsupported input' }
} catch {
 [Console]::Error.WriteLine($_.Exception.Message)
 exit 1
}
