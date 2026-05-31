<#
  Claude-Control target provisioning — the ONE manual step.

  Run ONCE in an ELEVATED PowerShell on the Windows machine you want to control.
  It opens the door the controller needs and nothing more: enables the OpenSSH
  server, authorizes your Claude-Control public key, and allows inbound SSH on
  all firewall profiles. Idempotent — safe to re-run.

  You normally don't type this by hand: `node scripts/setup.mjs provision-cmd`
  on the Mac prints a one-line command (with your key already injected) to paste.

  Manual form:
    powershell -NoProfile -ExecutionPolicy Bypass -File provision.ps1 -PubKey "ssh-ed25519 AAAA... claude-control@mac"
#>
param(
  [Parameter(Mandatory = $true)][string]$PubKey
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "[claude-control] $m" }

if (-not ($PubKey -match '^ssh-(ed25519|rsa) ')) {
  throw "PubKey does not look like an OpenSSH public key (expected 'ssh-ed25519 ...' or 'ssh-rsa ...')."
}

# Must be elevated (authorizing keys + firewall + services all need admin).
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) { throw "Run this in an ELEVATED PowerShell (Run as administrator)." }

# 1) OpenSSH server capability
$cap = Get-WindowsCapability -Online -Name OpenSSH.Server* | Select-Object -First 1
if ($cap.State -ne 'Installed') {
  Step "installing OpenSSH.Server (may take a minute)..."
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
} else { Step "OpenSSH.Server already installed" }

# 2) service: automatic + running
Set-Service sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
Step "sshd running (Automatic)"

# 3) default shell = PowerShell (so the controller gets PowerShell over SSH)
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
  -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null

# 4) firewall: allow inbound TCP/22 on ALL profiles. The capability's own rule is
#    often Private-only, which silently blocks a Tailscale/VPN (Public) interface.
if (-not (Get-NetFirewallRule -Name 'sshd-claude-control' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'sshd-claude-control' -DisplayName 'OpenSSH Server (Claude-Control, all profiles)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any | Out-Null
}
Step "firewall: inbound TCP/22 allowed on all profiles"

# 5) authorize the public key (admin accounts use the shared administrators file)
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
$dir = Split-Path $f -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$existing = if (Test-Path $f) { Get-Content $f -ErrorAction SilentlyContinue } else { @() }
if ($existing -notcontains $PubKey) {
  Add-Content -Path $f -Value $PubKey
  Step "authorized key added"
} else { Step "key already authorized" }
# correct ACLs (OpenSSH refuses the file otherwise)
icacls.exe $f /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

# 6) report what the operator needs to read back to the Mac
$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
        Select-Object -ExpandProperty IPAddress) -join ', '
Write-Host ""
Write-Host "===================== CLAUDE-CONTROL: READY =====================" -ForegroundColor Green
Write-Host "  username : $env:USERNAME"
Write-Host "  computer : $env:COMPUTERNAME"
Write-Host "  IPv4     : $ips"
Write-Host "  (If you use Tailscale, prefer its 100.x.y.z address.)"
Write-Host "  Tell these to Claude on the Mac to finish setup."
Write-Host "=================================================================" -ForegroundColor Green
