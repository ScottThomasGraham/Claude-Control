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

    // --- window management (for heavy multi-window apps) ---
    public struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);

    static string TitleOf(IntPtr h){ int n=GetWindowTextLength(h); if(n<=0) return ""; var sb=new System.Text.StringBuilder(n+1); GetWindowText(h,sb,sb.Capacity); return sb.ToString(); }

    public static System.Collections.Generic.List<object[]> ListWindows(){
        var list = new System.Collections.Generic.List<object[]>();
        EnumWindows((h,l)=>{
            if(IsWindowVisible(h)){ string t=TitleOf(h); if(t.Length>0){ RECT r; GetWindowRect(h, out r); list.Add(new object[]{ t, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top }); } }
            return true;
        }, IntPtr.Zero);
        return list;
    }
    public static bool Focus(string sub){
        IntPtr found = IntPtr.Zero; string lower = sub.ToLower();
        EnumWindows((h,l)=>{
            if(IsWindowVisible(h)){ string t=TitleOf(h); if(t.Length>0 && t.ToLower().Contains(lower)){ found=h; return false; } }
            return true;
        }, IntPtr.Zero);
        if(found != IntPtr.Zero){ ShowWindow(found, 9); SetForegroundWindow(found); return true; }
        return false;
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

function Invoke-ListWindows {
  $vs = Get-VirtualScreen
  $arr = New-Object System.Collections.ArrayList
  foreach ($w in [CCInput]::ListWindows()) {
    [void]$arr.Add(@{ title=$w[0]; x=[int]($w[1]-$vs.X); y=[int]($w[2]-$vs.Y); w=[int]$w[3]; h=[int]$w[4] })
  }
  @{ ok=$true; windows=$arr }
}

function Invoke-FocusWindow($title) { @{ ok=$true; found=[CCInput]::Focus([string]$title) } }

function Invoke-WaitIdle($timeoutMs, $settleMs) {
  if (-not $timeoutMs) { $timeoutMs = 60000 }
  if (-not $settleMs)  { $settleMs  = 1500 }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $sw  = [System.Diagnostics.Stopwatch]::StartNew()
  $last = $null; $stableSince = $null
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $shot  = Invoke-Screenshot
    $hash  = [BitConverter]::ToString($md5.ComputeHash([Convert]::FromBase64String($shot.png)))
    if ($hash -eq $last) {
      if ($stableSince -eq $null) { $stableSince = $sw.ElapsedMilliseconds }
      elseif (($sw.ElapsedMilliseconds - $stableSince) -ge $settleMs) { return @{ ok=$true; idle=$true } }
    } else { $last = $hash; $stableSince = $null }
    Start-Sleep -Milliseconds 400
  }
  @{ ok=$true; idle=$false }
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
    'list_windows' { Invoke-ListWindows }
    'focus_window' { Invoke-FocusWindow $cmd.title }
    'wait_idle'    { Invoke-WaitIdle $cmd.timeoutMs $cmd.settleMs }
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
