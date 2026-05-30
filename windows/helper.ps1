<#
  Claude-Control interactive-session helper.

  Runs INSIDE the logged-in user's desktop session (started by a logon Scheduled
  Task — see bootstrap.ps1) so it can see the real screen and inject input, which
  a session-0 SSH process cannot. Listens on 127.0.0.1:<Port> for newline-
  delimited JSON commands and replies with a single JSON line. Reached from the
  controller through the SSH connection (loopback only — never exposed).

  Uses ONLY OS-preinstalled facilities: PowerShell + .NET (System.Drawing,
  System.Windows.Forms, UIAutomation) + Win32 via P/Invoke. Nothing to install.

  Coordinate space: all x/y are pixels relative to the TOP-LEFT of the virtual
  screen (same origin as the screenshot), so ui_tree coordinates feed straight
  into click/move.
#>
param([int]$Port = 49705)

$ErrorActionPreference = 'Stop'
$Version = '0.1.0'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# --- Win32 input + DPI via P/Invoke -----------------------------------------
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CCInput {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] p, int cb);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);

    const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1;
    const uint MOUSEEVENTF_LEFTDOWN=0x02, MOUSEEVENTF_LEFTUP=0x04, MOUSEEVENTF_RIGHTDOWN=0x08, MOUSEEVENTF_RIGHTUP=0x10, MOUSEEVENTF_MIDDLEDOWN=0x20, MOUSEEVENTF_MIDDLEUP=0x40, MOUSEEVENTF_WHEEL=0x800;
    const uint KEYEVENTF_KEYUP=0x02, KEYEVENTF_UNICODE=0x04;

    public static void Dpi() { try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch {} } // PER_MONITOR_AWARE_V2

    static void Send(INPUT[] a){ SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
    static void Mouse(uint flags, uint data){ var i=new INPUT(); i.type=INPUT_MOUSE; i.U.mi.dwFlags=flags; i.U.mi.mouseData=data; Send(new INPUT[]{i}); }

    public static void Click(string button, bool dbl){
        uint dn, up;
        if (button=="right"){ dn=MOUSEEVENTF_RIGHTDOWN; up=MOUSEEVENTF_RIGHTUP; }
        else if (button=="middle"){ dn=MOUSEEVENTF_MIDDLEDOWN; up=MOUSEEVENTF_MIDDLEUP; }
        else { dn=MOUSEEVENTF_LEFTDOWN; up=MOUSEEVENTF_LEFTUP; }
        Mouse(dn,0); Mouse(up,0);
        if (dbl){ Mouse(dn,0); Mouse(up,0); }
    }
    public static void Wheel(int notches){ Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)(notches*120))); }

    public static void KeyVk(ushort vk, bool up){
        var i=new INPUT(); i.type=INPUT_KEYBOARD; i.U.ki.wVk=vk; i.U.ki.dwFlags = up?KEYEVENTF_KEYUP:0; Send(new INPUT[]{i});
    }
    public static void Unicode(char c){
        var d=new INPUT(); d.type=INPUT_KEYBOARD; d.U.ki.wScan=c; d.U.ki.dwFlags=KEYEVENTF_UNICODE;
        var u=new INPUT(); u.type=INPUT_KEYBOARD; u.U.ki.wScan=c; u.U.ki.dwFlags=KEYEVENTF_UNICODE|KEYEVENTF_KEYUP;
        Send(new INPUT[]{d,u});
    }
}
'@

[CCInput]::Dpi()

# --- geometry ----------------------------------------------------------------
function Get-VirtualScreen { [System.Windows.Forms.SystemInformation]::VirtualScreen }

# --- key name -> virtual-key code -------------------------------------------
$VK = @{
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B; 'space'=0x20;
  'backspace'=0x08; 'back'=0x08; 'delete'=0x2E; 'del'=0x2E; 'insert'=0x2D; 'home'=0x24;
  'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22; 'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27;
  'ctrl'=0x11; 'control'=0x11; 'shift'=0x10; 'alt'=0x12; 'win'=0x5B; 'windows'=0x5B; 'cmd'=0x5B;
  'f1'=0x70;'f2'=0x71;'f3'=0x72;'f4'=0x73;'f5'=0x74;'f6'=0x75;'f7'=0x76;'f8'=0x77;'f9'=0x78;'f10'=0x79;'f11'=0x7A;'f12'=0x7B;
}
function Resolve-Vk([string]$name) {
  $k = $name.ToLower()
  if ($VK.ContainsKey($k)) { return [uint16]$VK[$k] }
  if ($name.Length -eq 1) { return [uint16][byte][char]([string]$name).ToUpper()[0] }
  throw "unknown key '$name'"
}

# --- command handlers --------------------------------------------------------
function Invoke-Screenshot {
  $vs = Get-VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  @{ ok=$true; png=[Convert]::ToBase64String($ms.ToArray()); width=$vs.Width; height=$vs.Height }
}

function Invoke-Move($x,$y) { $vs=Get-VirtualScreen; [CCInput]::SetCursorPos([int]$x+$vs.X,[int]$y+$vs.Y) | Out-Null; @{ok=$true} }
function Invoke-Click($x,$y,$button,$double) {
  $vs=Get-VirtualScreen; [CCInput]::SetCursorPos([int]$x+$vs.X,[int]$y+$vs.Y) | Out-Null
  Start-Sleep -Milliseconds 20
  [CCInput]::Click([string]$button, [bool]$double); @{ok=$true}
}
function Invoke-Scroll($amount) { [CCInput]::Wheel([int]$amount); @{ok=$true} }

function Invoke-Type($text) {
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq "`n") { [CCInput]::KeyVk(0x0D,$false); [CCInput]::KeyVk(0x0D,$true) }
    else { [CCInput]::Unicode($ch) }
  }
  @{ok=$true; typed=$text.Length}
}

function Invoke-Keys($chord) {
  $parts = $chord -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $vks = $parts | ForEach-Object { Resolve-Vk $_ }
  foreach ($vk in $vks) { [CCInput]::KeyVk($vk,$false) }     # press in order
  [array]::Reverse($vks)
  foreach ($vk in $vks) { [CCInput]::KeyVk($vk,$true) }      # release in reverse
  @{ok=$true; chord=$chord}
}

function Get-Elements([int]$max, [string]$nameFilter) {
  $vs = Get-VirtualScreen
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $out = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $seen = 0
  while ($queue.Count -gt 0 -and $out.Count -lt $max -and $seen -lt 5000) {
    $el = $queue.Dequeue(); $seen++
    try {
      $r = $el.Current.BoundingRectangle
      $name = $el.Current.Name
      if ($r.Width -gt 0 -and $r.Height -gt 0) {
        $include = $true
        if ($nameFilter) { $include = ($name -and $name.ToLower().Contains($nameFilter.ToLower())) }
        if ($include) {
          [void]$out.Add(@{
            type   = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.',''
            name   = $name
            x      = [int]($r.X + $r.Width/2 - $vs.X)
            y      = [int]($r.Y + $r.Height/2 - $vs.Y)
            w      = [int]$r.Width
            h      = [int]$r.Height
          })
        }
      }
      $child = $walker.GetFirstChild($el)
      while ($child -ne $null) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    } catch { }
  }
  ,$out
}

function Handle([string]$line) {
  $cmd = $line | ConvertFrom-Json
  switch ($cmd.op) {
    'ping'       { @{ ok=$true; version=$Version } }
    'screenshot' { Invoke-Screenshot }
    'move'       { Invoke-Move $cmd.x $cmd.y }
    'click'      { Invoke-Click $cmd.x $cmd.y $cmd.button $cmd.double }
    'scroll'     { Invoke-Scroll $cmd.amount }
    'type'       { Invoke-Type $cmd.text }
    'keys'       { Invoke-Keys $cmd.chord }
    'uia_tree'   { @{ ok=$true; elements = (Get-Elements ([int]$cmd.maxElements) $null) } }
    'uia_find'   { @{ ok=$true; matches  = (Get-Elements 1000 ([string]$cmd.text)) } }
    default      { @{ ok=$false; error="unknown op '$($cmd.op)'" } }
  }
}

# --- listener loop -----------------------------------------------------------
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = New-Object IO.StreamReader($stream)
      $writer = New-Object IO.StreamWriter($stream); $writer.AutoFlush = $true
      $line = $reader.ReadLine()
      if ($line) {
        $resp = try { Handle $line } catch { @{ ok=$false; error="$($_.Exception.Message)" } }
        $writer.WriteLine(($resp | ConvertTo-Json -Compress -Depth 8))
      }
    } catch {
    } finally { $client.Close() }
  }
} finally { $listener.Stop() }
