# windows/uia-accelerator.ps1
#   Walk the UI Automation tree of the CURRENT interactive desktop and write JSON
#   to -Out. Must run IN the interactive session (a one-shot Scheduled Task), not
#   session 0, or it sees nothing. Self-contained, PS 5.1-safe.
param([string]$Out = "C:\Users\Public\cc-uia.json", [int]$MaxElements = 200, [string]$Find = "")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$list = New-Object System.Collections.ArrayList
foreach ($e in $els) {
  if ($list.Count -ge $MaxElements) { break }
  try {
    $name = $e.Current.Name
    if ($Find -and ($name -notlike "*$Find*")) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $type = ($e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    [void]$list.Add(@{
      name = $name; type = $type
      x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2)
    })
  } catch { }
}
$list | ConvertTo-Json -Compress | Set-Content -Path $Out -Encoding UTF8
