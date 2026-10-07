Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ReachInput {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra);
}
'@
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
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
 [ReachInput]::mouse_event(2048,0,0,([int]$payload.delta * 120),[UIntPtr]::Zero)
} elseif ($payload.type -eq 'text') {
 foreach ($character in $payload.text.ToCharArray()) {
  $value = [string]$character
  if ('+^%~()[]{}'.Contains($value)) { $value = '{' + $value + '}' }
  [System.Windows.Forms.SendKeys]::SendWait($value)
 }
} elseif ($payload.type -eq 'key') {
 $keys = @{enter='{ENTER}';backspace='{BACKSPACE}';tab='{TAB}';escape='{ESC}';left='{LEFT}';right='{RIGHT}';up='{UP}';down='{DOWN}'}
 if (!$keys.ContainsKey($payload.key)) { throw 'Unsupported key' }
 [System.Windows.Forms.SendKeys]::SendWait($keys[$payload.key])
} else { throw 'Unsupported input' }
