<#
  Claude-Control -- TIA Portal Openness accelerator (OPTIONAL).

  An OPTIONAL fast-path for driving TIA Portal via Siemens' official Openness API
  (Siemens.Engineering.dll). It is NOT required: the universal visual layer
  (helper.ps1) drives TIA -- and any other program -- purely visually. This script
  only adds a scriptable API path for the PLC/project operations Openness exposes.

  Contract: invoked over SSH as
      powershell ... -File tia-openness.ps1 -Op <name> -ArgsB64 <base64-utf8-json>
  and prints EXACTLY ONE JSON line: { "ok": true, ... } or { "ok": false, "error": ... }.

  Runs headless (plain SSH session) -- it attaches to a running TIA Portal via the
  Openness API; whether a non-interactive session can attach to a GUI instance is
  validated in Phase 0 on the real engineering box. `status` is always safe and
  reports found:false when Openness is not installed (e.g. on the Mini).

  Uses ONLY what ships with TIA + .NET. Nothing is installed.

  PS 5.1 safety: generic GetService<T> is invoked via reflection (MakeGenericMethod),
  and object graphs are projected to plain strings/ints before ConvertTo-Json so no
  live Openness object is ever serialized.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Op,
  [string]$ArgsB64 = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-Args {
  if (-not $ArgsB64) { return [pscustomobject]@{} }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64))
  if (-not $json.Trim()) { return [pscustomobject]@{} }
  return ($json | ConvertFrom-Json)
}

# --- locate + load Siemens.Engineering.dll ----------------------------------
# Returns @{ dir; dll; version } or $null (no throw) so `status` can report cleanly.
function Find-OpennessDll {
  if ($env:CC_OPENNESS_DLL -and (Test-Path $env:CC_OPENNESS_DLL)) {
    return @{ dll = $env:CC_OPENNESS_DLL; dir = (Split-Path $env:CC_OPENNESS_DLL); version = 'env' }
  }
  $base = 'HKLM:\SOFTWARE\Siemens\Automation\Openness'
  if (-not (Test-Path $base)) { return $null }
  # Version subkeys look like '17.0','18.0','19.0' -- prefer the highest.
  $versions = Get-ChildItem $base -ErrorAction SilentlyContinue |
    Sort-Object { try { [double]$_.PSChildName } catch { 0 } } -Descending
  foreach ($v in $versions) {
    $apiRoot = Join-Path $v.PSPath 'PublicAPI'
    if (-not (Test-Path $apiRoot)) { continue }
    foreach ($api in (Get-ChildItem $apiRoot -ErrorAction SilentlyContinue)) {
      $props = Get-ItemProperty $api.PSPath -ErrorAction SilentlyContinue
      foreach ($p in $props.PSObject.Properties) {
        if ($p.Name -like 'Siemens.Engineering*' -and "$($p.Value)" -like '*Siemens.Engineering.dll') {
          if (Test-Path $p.Value) {
            return @{ dll = $p.Value; dir = (Split-Path $p.Value); version = $v.PSChildName }
          }
        }
      }
    }
  }
  return $null
}

$script:OpennessDir = $null
function Load-Openness {
  $found = Find-OpennessDll
  if (-not $found) { throw "Openness not found -- TIA Portal / the Openness option does not appear to be installed on this machine." }
  $script:OpennessDir = $found.dir
  $resolver = [ResolveEventHandler] {
    param($sender, $e)
    $name = (New-Object Reflection.AssemblyName($e.Name)).Name
    $candidate = Join-Path $script:OpennessDir ($name + '.dll')
    if (Test-Path $candidate) { return [Reflection.Assembly]::LoadFrom($candidate) }
    return $null
  }
  [AppDomain]::CurrentDomain.add_AssemblyResolve($resolver)
  [Reflection.Assembly]::LoadFrom($found.dll) | Out-Null
  return $found
}

# Invoke a generic GetService<T> via reflection (PS 5.1 has no $o.GetService[T]() syntax).
function Get-Svc($obj, [string]$typeFullName) {
  if ($null -eq $obj) { return $null }
  $svcType = [Siemens.Engineering.IEngineeringServiceProvider].Assembly.GetType($typeFullName)
  if ($null -eq $svcType) { return $null }
  $m = [Siemens.Engineering.IEngineeringServiceProvider].GetMethod('GetService')
  if ($null -eq $m) { return $null }
  try { return $m.MakeGenericMethod($svcType).Invoke($obj, $null) } catch { return $null }
}

# --- portal / project --------------------------------------------------------
function Get-RunningTiaProcesses {
  $procs = [Siemens.Engineering.TiaPortal]::GetProcesses()
  return $procs
}

# Attach to a running TIA (default) or, with -Start, launch one with UI.
function Get-Portal([bool]$start) {
  $procs = Get-RunningTiaProcesses
  if ($procs -and $procs.Count -gt 0) { return $procs[0].Attach() }
  if ($start) { return New-Object Siemens.Engineering.TiaPortal([Siemens.Engineering.TiaPortalMode]::WithUserInterface) }
  throw "No running TIA Portal to attach to. Open TIA Portal on the box (or pass start=true)."
}

function Get-OpenProject($portal, [string]$path) {
  $proj = $null
  if ($portal.Projects.Count -gt 0) { $proj = $portal.Projects[0] }
  if (-not $proj -and $path) { $proj = $portal.Projects.Open([IO.FileInfo]$path) }
  if (-not $proj) { throw "No project open in TIA, and no project path provided." }
  return $proj
}

function Get-AllDeviceItems($device) {
  $acc = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  foreach ($it in $device.DeviceItems) { $stack.Push($it) }
  while ($stack.Count -gt 0) {
    $it = $stack.Pop(); [void]$acc.Add($it)
    foreach ($c in $it.DeviceItems) { $stack.Push($c) }
  }
  return $acc
}

# Returns ArrayList of @{ device; name; plc=<live PlcSoftware> }.
function Get-PlcSoftwares($project) {
  $list = New-Object System.Collections.ArrayList
  foreach ($device in $project.Devices) {
    foreach ($di in (Get-AllDeviceItems $device)) {
      $sc = Get-Svc $di 'Siemens.Engineering.HW.Features.SoftwareContainer'
      if ($sc -and $sc.Software -and $sc.Software.GetType().FullName -eq 'Siemens.Engineering.SW.PlcSoftware') {
        [void]$list.Add(@{ device = $device.Name; name = $sc.Software.Name; plc = $sc.Software })
      }
    }
  }
  return $list
}

# Pick a PLC by name (substring, case-insensitive) or the only one if name omitted.
function Select-Plc($project, [string]$name) {
  $all = Get-PlcSoftwares $project
  if ($all.Count -eq 0) { throw "No PLC software found in the project." }
  if ($name) {
    foreach ($e in $all) { if ($e.name.ToLower().Contains($name.ToLower())) { return $e } }
    throw "No PLC matching '$name'. Available: $(($all | ForEach-Object { $_.name }) -join ', ')"
  }
  if ($all.Count -gt 1) {
    throw "Multiple PLCs ($(($all | ForEach-Object { $_.name }) -join ', ')) -- pass plc=<name>."
  }
  return $all[0]
}

function Get-AllBlocks($plc) {
  $acc = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($plc.BlockGroup)
  while ($stack.Count -gt 0) {
    $g = $stack.Pop()
    foreach ($b in $g.Blocks) { [void]$acc.Add($b) }
    foreach ($sub in $g.Groups) { $stack.Push($sub) }
  }
  return $acc
}

# --- operations --------------------------------------------------------------
function Op-Status {
  $found = Find-OpennessDll
  $res = [ordered]@{ ok = $true; openness_found = [bool]$found }
  if ($found) {
    $res.openness_version = $found.version
    $res.openness_dll = $found.dll
    try {
      Load-Openness | Out-Null
      $procs = Get-RunningTiaProcesses
      $res.running_tia = @($procs | ForEach-Object { $_.Id })
      $res.running_count = @($procs).Count
    } catch {
      $res.attach_error = "$($_.Exception.Message)"
    }
  }
  # group membership (informational; the operator must be in 'Siemens TIA Openness')
  try {
    $groups = ([Security.Principal.WindowsIdentity]::GetCurrent()).Groups |
      ForEach-Object { try { $_.Translate([Security.Principal.NTAccount]).Value } catch { $null } }
    $res.in_openness_group = [bool]($groups | Where-Object { $_ -like '*Siemens TIA Openness*' })
  } catch { $res.in_openness_group = $null }
  return $res
}

function Op-OpenProject($a) {
  Load-Openness | Out-Null
  $portal = Get-Portal ([bool]$a.start)
  $proj = Get-OpenProject $portal $a.path
  $plcs = Get-PlcSoftwares $proj
  return @{ ok = $true; project = $proj.Name; path = "$($proj.Path)"; plcs = @($plcs | ForEach-Object { $_.name }) }
}

function Op-ListDevices($a) {
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $devs = @($proj.Devices | ForEach-Object { $_.Name })
  $plcs = @((Get-PlcSoftwares $proj) | ForEach-Object { @{ device = $_.device; plc = $_.name } })
  return @{ ok = $true; project = $proj.Name; devices = $devs; plc_software = $plcs }
}

function Op-ListBlocks($a) {
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $sel = Select-Plc $proj $a.plc
  $blocks = @((Get-AllBlocks $sel.plc) | ForEach-Object {
    @{ name = $_.Name; kind = $_.GetType().Name; number = (try { [int]$_.Number } catch { $null }) }
  })
  return @{ ok = $true; plc = $sel.name; count = $blocks.Count; blocks = $blocks }
}

function Op-ListTags($a) {
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $sel = Select-Plc $proj $a.plc
  $tables = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($sel.plc.TagTableGroup)
  while ($stack.Count -gt 0) {
    $g = $stack.Pop()
    foreach ($t in $g.TagTables) {
      [void]$tables.Add(@{ table = $t.Name; tags = @($t.Tags | ForEach-Object { @{ name = $_.Name; address = "$($_.LogicalAddress)"; type = "$($_.DataTypeName)" } }) })
    }
    foreach ($sub in $g.Groups) { $stack.Push($sub) }
  }
  return @{ ok = $true; plc = $sel.name; tag_tables = $tables }
}

function Op-ExportBlock($a) {
  if (-not $a.block) { throw "export_block requires block=<name>" }
  if (-not $a.file)  { throw "export_block requires file=<C:/...xml> (target path on the remote box)" }
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $sel = Select-Plc $proj $a.plc
  $target = $null
  foreach ($b in (Get-AllBlocks $sel.plc)) { if ($b.Name -eq $a.block) { $target = $b; break } }
  if (-not $target) { throw "Block '$($a.block)' not found on PLC '$($sel.name)'." }
  $opts = [Siemens.Engineering.ExportOptions]::WithDefaults
  $fi = [IO.FileInfo]$a.file
  if ($fi.Exists) { $fi.Delete() }
  $target.Export($fi, $opts)
  return @{ ok = $true; block = $a.block; exported_to = $a.file }
}

function Op-ImportBlock($a) {
  if (-not $a.file) { throw "import_block requires file=<C:/...xml> (source path on the remote box)" }
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $sel = Select-Plc $proj $a.plc
  $opts = [Siemens.Engineering.ImportOptions]::Override
  $imported = $sel.plc.BlockGroup.Blocks.Import([IO.FileInfo]$a.file, $opts)
  return @{ ok = $true; imported = @($imported | ForEach-Object { $_.Name }) }
}

function Op-Compile($a) {
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $sel = Select-Plc $proj $a.plc
  $compiler = Get-Svc $sel.plc 'Siemens.Engineering.Compiler'
  if (-not $compiler) { throw "Could not obtain the Compiler service for PLC '$($sel.name)'." }
  $result = $compiler.Compile()
  $msgs = New-Object System.Collections.ArrayList
  try { foreach ($m in $result.Messages) { [void]$msgs.Add(@{ state = "$($m.State)"; desc = (Clean "$($m.Description)") }) } } catch {}
  return @{ ok = $true; plc = $sel.name; state = "$($result.State)"; errors = [int]$result.ErrorCount; warnings = [int]$result.WarningCount; messages = $msgs }
}

# GATED: writing to a live PLC is hard-to-reverse and touches real hardware.
# Requires confirm=true AND station=<name>. The live download path itself is
# intentionally NOT executed until validated against the real box (Phase 3) -- we
# will not auto-answer hardware prompts through an unverified code path. This op
# verifies the download provider is reachable and reports readiness.
function Op-Download($a) {
  if (-not $a.confirm) { throw "download is gated: pass confirm=true AND station=<name>. It writes to real hardware." }
  if (-not $a.station) { throw "download requires station=<name> (explicit target)." }
  Load-Openness | Out-Null
  $proj = Get-OpenProject (Get-Portal $false) $a.path
  $sel = Select-Plc $proj $a.plc
  $dl = Get-Svc $sel.plc 'Siemens.Engineering.Download.DownloadProvider'
  $ready = [bool]$dl
  return @{
    ok = $true; plc = $sel.name; station = "$($a.station)"; provider_ready = $ready
    executed = $false
    note = "Download provider reachable=$ready. Live download is deferred to Phase-3 validation on the real box; this build does not push to hardware through an unverified path."
  }
}

function Clean([string]$s) { if (-not $s) { return $s }; return ($s -replace '[\x00-\x1F]', ' ') }

# --- dispatch ----------------------------------------------------------------
try {
  $a = Read-Args
  switch ($Op) {
    'status'        { $out = Op-Status }
    'open_project'  { $out = Op-OpenProject $a }
    'list_devices'  { $out = Op-ListDevices $a }
    'list_blocks'   { $out = Op-ListBlocks $a }
    'list_tags'     { $out = Op-ListTags $a }
    'export_block'  { $out = Op-ExportBlock $a }
    'import_block'  { $out = Op-ImportBlock $a }
    'compile'       { $out = Op-Compile $a }
    'download'      { $out = Op-Download $a }
    default         { $out = @{ ok = $false; error = "unknown op '$Op'" } }
  }
} catch {
  $out = @{ ok = $false; error = "$($_.Exception.Message)" }
}
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 6))
