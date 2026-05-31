<#
  Claude-Control bootstrap (runs ON the Windows target, pushed there over SSH).

  Registers the interactive-session helper as a logon Scheduled Task (so it runs
  in the user's desktop session, where it can see the screen and inject input —
  a session-0 SSH process cannot), starts it, and optionally enables RDP for a
  human to watch. Idempotent: re-running re-registers cleanly.

  Uses only preinstalled facilities. Must run as an administrator.

    powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -HelperPort 49705 [-EnableRdp]
    powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Uninstall
#>
param(
  [int]$HelperPort = 49705,
  [switch]$EnableRdp,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'ClaudeControlHelper'
$HelperPs1 = 'C:\ProgramData\ClaudeControl\helper.ps1'

function Write-Line($m) { Write-Output $m }

if ($Uninstall) {
  try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Unregister-ScheduledTask -Confirm:$false; Write-Line "task removed" } catch { Write-Line "task not present" }
  try { Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.CommandLine -match 'helper.ps1' } | Stop-Process -Force } catch {}
  try { Remove-Item -Recurse -Force 'C:\ProgramData\ClaudeControl' -ErrorAction SilentlyContinue; Write-Line "files removed" } catch {}
  Write-Line "UNINSTALL OK"
  return
}

# 1) optionally enable RDP (so a human can watch via mstsc)
if ($EnableRdp) {
  Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
  try { Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' } catch {}
  Write-Line "RDP enabled"
}

# 2) figure out which interactive user the helper should run as.
#    Win32_ComputerSystem.UserName only reports the *console* session, so it is
#    empty when the user is logged in over RDP. Fall back to parsing `quser` for
#    any active interactive session, then to the SSH account. Whatever we find,
#    normalize a bare/workgroup name to COMPUTERNAME\user so it maps to a real
#    SID (a workgroup machine's USERDOMAIN is "WORKGROUP", which does NOT).
$consoleUser = $null
try { $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName } catch {}
if (-not $consoleUser) {
  try {
    # quser columns: USERNAME  SESSIONNAME  ID  STATE ...  (leading '>' = current)
    $line = (quser 2>$null) | Select-Object -Skip 1 |
      Where-Object { $_ -match '\bActive\b' } | Select-Object -First 1
    if (-not $line) { $line = (quser 2>$null) | Select-Object -Skip 1 | Select-Object -First 1 }
    if ($line) { $consoleUser = (($line -replace '^\s*>?\s*','') -split '\s+')[0] }
  } catch {}
}
if (-not $consoleUser) { $consoleUser = $env:USERNAME }
# normalize: strip any domain/workgroup prefix, then qualify with the computer name
$bareUser = ($consoleUser -split '\\')[-1]
$consoleUser = "$env:COMPUTERNAME\$bareUser"
Write-Line "helper will run as: $consoleUser"

# 3) (re)register the logon Scheduled Task in the interactive user's context
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
              -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$HelperPs1`" -Port $HelperPort"
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Write-Line "scheduled task '$TaskName' registered (port $HelperPort)"

# 4) start it now if someone is logged in (runs in their session)
try {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  $listening = (Get-NetTCPConnection -State Listen -LocalPort $HelperPort -ErrorAction SilentlyContinue) -ne $null
  if ($listening) { Write-Line "helper started and listening on 127.0.0.1:$HelperPort" }
  else { Write-Line "helper task started (may need an interactive logon to bind the port)" }
} catch {
  Write-Line "helper registered; will start at next interactive logon ($($_.Exception.Message))"
}

Write-Line "BOOTSTRAP OK"
