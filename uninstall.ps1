[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Workspace = $(if ($env:OPENCLAW_WORKSPACE) { $env:OPENCLAW_WORKSPACE } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.openclaw\workspace' } else { '' }),
  [string]$OpenClawCli = 'openclaw.cmd',
  [switch]$SkipAgents,
  [switch]$SkipCron,
  [switch]$RemoveWFInfo,
  [string]$WFInfoInstallDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'OpenClaw\WFInfo' } else { '' })
)

# Safe uninstall for the OpenClaw Warframe assistant.
#
# Design contract (locked by tests/uninstall.test.ps1):
#   1. Default scope is strictly limited to managed-marked content:
#      - skill/plugin files listed in each tree's .warframe-assistant-managed.json
#        (plus the manifest/build metadata themselves) are MOVED to a recoverable
#        backup under .openclaw\warframe-assistant-uninstall-backups\<timestamp>-<tree>-<uid>\;
#        each run gets its own uniquely named backup (never reused, never
#        overwritten); nothing is permanently deleted, and unmanaged files are
#        never touched.
#      - the controlled AGENTS.md fragment (BEGIN/END markers) is removed; all
#        other personal AGENTS.md content is preserved verbatim.
#   2. Cron cleanup only deletes jobs whose declarationKey EXACTLY equals the key
#      declared in config/cron/reward-zh-ai.job.json. Subscription/drops monitor
#      jobs carry per-target hashed keys and are user data: they are reported and
#      left in place, never matched by prefix or pattern.
#   3. WFInfo is only touched with the explicit -RemoveWFInfo switch, only after
#      verifying the managed marker (.openclaw-wfinfo-companion.json, id
#      wfinfo-openclaw-companion), and only by MOVING the whole install directory
#      to a recoverable <name>.uninstall-backup-<timestamp> sibling — never by
#      permanent deletion.
#   4. -WhatIf is supported end to end; with -WhatIf nothing is changed.
#   5. The script refuses to run against the repository root or a drive root, and
#      refuses to treat an unmanaged directory as a WFInfo install.
#
# User data that is deliberately NOT removed (reported in the summary): workspace
# state/ (subscriptions/weekly/drops), .cache/, deploy backups and the
# AGENTS.md.warframe-assistant.bak copy.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

if (-not $Workspace) { throw 'Cannot resolve OpenClaw workspace. Pass -Workspace explicitly.' }

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspacePath = [IO.Path]::GetFullPath($Workspace)
$workspaceRoot = [IO.Path]::GetPathRoot($workspacePath)
$fragmentPath = Join-Path $repoRoot 'config\AGENTS.warframe.md'
$agentsPath = Join-Path $workspacePath 'AGENTS.md'
$beginMarker = '<!-- BEGIN openclaw-warframe-assistant -->'
$endMarker = '<!-- END openclaw-warframe-assistant -->'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifestName = '.warframe-assistant-managed.json'
$buildInfoName = '.warframe-assistant-build.json'
$uninstallBackupRoot = Join-Path $workspacePath '.openclaw\warframe-assistant-uninstall-backups'

if ($workspacePath -eq $repoRoot) { throw 'Refusing to uninstall: -Workspace resolves to the repository root itself.' }
if ($workspacePath -eq $workspaceRoot -or -not (Split-Path -Leaf $workspacePath)) { throw "Unsafe uninstall workspace: $workspacePath" }

function Read-Utf8([string]$Path) {
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-Utf8Atomic([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $temp = Join-Path $parent ('.warframe-uninstall-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temp, $Content, $utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Assert-SafeManagedTarget([string]$DestinationPath, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative)) { throw 'Managed manifest contains an empty path.' }
  if ($Relative -match '^[a-zA-Z]:|^\\\\|^\.\.([/\\]|$)|[/\\]\.\.([/\\]|$)') { throw "Unsafe managed path in manifest: $Relative" }
  $target = [IO.Path]::GetFullPath((Join-Path $DestinationPath ($Relative.Replace('/', '\'))))
  $prefix = $DestinationPath.TrimEnd('\') + '\'
  if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe managed path: $Relative" }
  return $target
}

function Move-ManagedTreeToBackup([string]$Destination, [string]$TreeName) {
  $destinationPath = [IO.Path]::GetFullPath($Destination)
  if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
    Write-Host "${TreeName}: no install found at $destinationPath; nothing to remove."
    return
  }
  $manifestPath = Join-Path $destinationPath $manifestName
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Write-Host "${TreeName}: no managed manifest at $manifestPath; leaving directory untouched (unmanaged content)."
    return
  }
  $manifest = Read-Utf8 $manifestPath | ConvertFrom-Json
  $files = @($manifest.files)
  # 每次运行生成独立备份目录：时间戳+树名+GUID 短尾；若仍与既有目录碰撞（用户手工创建等），
  # 递增数字后缀直到空闲。备份目录一旦确定即不复用，Move-Item 不使用 -Force，
  # 同秒重跑/重装再卸载永远不会静默覆盖旧备份。
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
  $backupBase = $stamp + '-' + $TreeName
  $backupRoot = Join-Path $uninstallBackupRoot ($backupBase + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $collision = 1
  while (Test-Path -LiteralPath $backupRoot) {
    $backupRoot = Join-Path $uninstallBackupRoot ($backupBase + '-' + $collision)
    $collision++
  }
  $moved = 0

  foreach ($entry in $files) {
    $target = Assert-SafeManagedTarget $destinationPath ([string]$entry.path)
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
    if (-not $PSCmdlet.ShouldProcess($target, "Move managed $TreeName file to recoverable uninstall backup")) { continue }
    $backup = Join-Path $backupRoot ([string]$entry.path).Replace('/', '\')
    $backupParent = Split-Path -Parent $backup
    if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
    Move-Item -LiteralPath $target -Destination $backup
    $moved++
  }
  foreach ($metadataName in @($manifestName, $buildInfoName)) {
    $metadataPath = Join-Path $destinationPath $metadataName
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { continue }
    if (-not $PSCmdlet.ShouldProcess($metadataPath, "Move managed $TreeName metadata to recoverable uninstall backup")) { continue }
    $backup = Join-Path $backupRoot ('metadata\' + $metadataName)
    $backupParent = Split-Path -Parent $backup
    if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
    Move-Item -LiteralPath $metadataPath -Destination $backup
  }

  $remaining = @(Get-ChildItem -LiteralPath $destinationPath -Recurse -Force -File -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0 -and $moved -gt 0) {
    if ($PSCmdlet.ShouldProcess($destinationPath, "Remove now-empty $TreeName directory")) {
      Remove-Item -LiteralPath $destinationPath -Recurse -Force
      Write-Host "${TreeName}: removed now-empty directory $destinationPath"
    }
  } elseif ($remaining.Count -gt 0) {
    Write-Host "${TreeName}: kept $destinationPath with $($remaining.Count) unmanaged file(s) (user data); directory not removed."
  }
  Write-Host "${TreeName}: moved $moved managed file(s) to recoverable backup: $backupRoot"
}

function Remove-AgentsFragment {
  if ($SkipAgents) { Write-Host 'AGENTS.md: skipping managed fragment removal (-SkipAgents).'; return }
  if (-not (Test-Path -LiteralPath $fragmentPath -PathType Leaf)) { throw "AGENTS fragment does not exist: $fragmentPath" }
  if (-not (Test-Path -LiteralPath $agentsPath -PathType Leaf)) { Write-Host 'AGENTS.md: no workspace AGENTS.md; nothing to remove.'; return }
  $fragment = (Read-Utf8 $fragmentPath).Trim()
  if (-not ($fragment.Contains($beginMarker) -and $fragment.Contains($endMarker))) { throw 'AGENTS fragment is missing managed markers.' }
  $current = Read-Utf8 $agentsPath
  $pattern = [regex]::Escape($beginMarker) + '(?s:.*?)' + [regex]::Escape($endMarker)
  if (-not [regex]::IsMatch($current, $pattern)) { Write-Host 'AGENTS.md: no managed Warframe block found; nothing to remove.'; return }
  $updated = [regex]::Replace($current, $pattern, '').TrimEnd() + [Environment]::NewLine
  if ($PSCmdlet.ShouldProcess($agentsPath, 'Remove managed Warframe safety block from AGENTS.md')) {
    Write-Utf8Atomic $agentsPath $updated
    Write-Host "AGENTS.md: managed Warframe block removed; other content preserved. Backup copy AGENTS.md.warframe-assistant.bak left in place."
  }
}

function Invoke-Cli([string[]]$Arguments) {
  # openclaw CLI 的良性 stderr 警告在 PS5.1 + EAP=Stop 下会变成 NativeCommandError
  # （即使 2>$null）；调用期间临时降级 EAP，成败以退出码为准（与 release.ps1 同模式）。
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $stdout = & $OpenClawCli @Arguments 2>$null
  } finally {
    $ErrorActionPreference = $previousEap
  }
  if ($LASTEXITCODE -ne 0) { throw "$OpenClawCli $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  return $stdout
}

function Get-CliJson([string[]]$Arguments) {
  $stdout = Invoke-Cli $Arguments
  $text = ($stdout -join "`n")
  $start = $text.IndexOfAny([char[]]('[', '{'))
  if ($start -lt 0) { throw "$OpenClawCli $($Arguments -join ' ') produced no JSON output" }
  return $text.Substring($start) | ConvertFrom-Json
}

function Get-JobField($Job, [string]$Camel, [string]$Snake) {
  if ($null -eq $Job) { return $null }
  $names = @($Job.PSObject.Properties.Name)
  if ($names -contains $Camel) { return $Job.$Camel }
  if ($names -contains $Snake) { return $Job.$Snake }
  return $null
}

function Remove-ManagedCrons {
  if ($SkipCron) { Write-Host 'cron: skipping contract job removal (-SkipCron).'; return }
  $openClawJson = Join-Path (Split-Path -Parent $workspacePath) 'openclaw.json'
  if (-not (Test-Path -LiteralPath $openClawJson -PathType Leaf)) {
    Write-Host 'cron: no openclaw.json beside the workspace; skipping cron contract removal (non-runtime workspace).'
    return
  }
  if (-not (Get-Command $OpenClawCli -ErrorAction SilentlyContinue)) {
    Write-Host "cron: OpenClaw CLI not found ($OpenClawCli); skipping cron contract removal."
    return
  }
  $jobContractPath = Join-Path $repoRoot 'config\cron\reward-zh-ai.job.json'
  if (-not (Test-Path -LiteralPath $jobContractPath -PathType Leaf)) { throw "Cron contract file missing: $jobContractPath" }
  $contract = Read-Utf8 $jobContractPath | ConvertFrom-Json
  $declarationKey = [string]$contract.declarationKey
  if (-not $declarationKey) { throw "Cron contract has no declarationKey: $jobContractPath" }

  $jobs = Get-CliJson @('cron', 'list', '--json')
  $all = @()
  try { if ($null -ne $jobs.jobs) { $all = @($jobs.jobs) } } catch { }
  if ($all.Count -eq 0 -and $jobs -is [System.Array]) { $all = @($jobs) }
  # 精确匹配：只有 declarationKey 与合同逐字节相等的任务才会被删除；不做前缀/模式匹配。
  $targets = @($all | Where-Object { [string](Get-JobField $_ 'declarationKey' 'declaration_key') -ceq $declarationKey })
  if ($targets.Count -eq 0) {
    Write-Host "cron: no job with declarationKey '$declarationKey' found; nothing to remove."
    return
  }
  foreach ($job in $targets) {
    $jobId = [string](Get-JobField $job 'id' 'job_id')
    if (-not $jobId) { throw "Managed cron job ($declarationKey) has no id; refusing to guess." }
    if ($PSCmdlet.ShouldProcess($jobId, "Remove managed cron job (exact declarationKey $declarationKey)")) {
      Invoke-Cli @('cron', 'rm', $jobId) | Out-Null
      Write-Host "cron: removed job $jobId (declarationKey $declarationKey)"
    }
  }
}

function Test-WFInfoRunningFrom([string]$Directory) {
  foreach ($process in @(Get-Process -Name 'WFInfo' -ErrorAction SilentlyContinue)) {
    try {
      $processPath = [IO.Path]::GetFullPath($process.MainModule.FileName)
      $directoryPrefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
      if ($processPath.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    } catch { }
  }
  return $false
}

function Remove-WFInfoCompanion {
  if (-not $RemoveWFInfo) { Write-Host 'WFInfo: skipped (pass -RemoveWFInfo to remove the companion install).'; return }
  if (-not $WFInfoInstallDir) { throw 'Cannot resolve WFInfo install directory. Pass -WFInfoInstallDir explicitly.' }
  $target = [IO.Path]::GetFullPath($WFInfoInstallDir)
  $targetRoot = [IO.Path]::GetPathRoot($target)
  if ($target -eq $targetRoot -or -not (Split-Path -Leaf $target)) { throw "Unsafe WFInfo install target: $target" }
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    Write-Host "WFInfo: install directory not found: $target; nothing to remove."
    return
  }
  $markerPath = Join-Path $target '.openclaw-wfinfo-companion.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "WFInfo: refusing to remove unmanaged directory (no managed marker .openclaw-wfinfo-companion.json): $target"
  }
  $marker = Read-Utf8 $markerPath | ConvertFrom-Json
  if ([string]$marker.id -ne 'wfinfo-openclaw-companion') {
    throw "WFInfo: refusing to remove unmanaged directory (marker id '$($marker.id)' is not wfinfo-openclaw-companion): $target"
  }
  if (Test-WFInfoRunningFrom $target) { throw "WFInfo is running from $target. Close it before uninstalling." }
  $parent = Split-Path -Parent $target
  $leaf = Split-Path -Leaf $target
  $backup = Join-Path $parent ($leaf + '.uninstall-backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
  if (Test-Path -LiteralPath $backup) { throw "WFInfo uninstall backup target already exists: $backup" }
  if ($PSCmdlet.ShouldProcess($target, "Move WFInfo OpenClaw Companion to recoverable backup $backup")) {
    Move-Item -LiteralPath $target -Destination $backup
    Write-Host "WFInfo: moved to recoverable backup (not deleted): $backup"
  }
}

Write-Host "== Uninstall preview: workspace $workspacePath =="
Move-ManagedTreeToBackup (Join-Path $workspacePath 'skills\warframe-assistant') 'skill'
Move-ManagedTreeToBackup (Join-Path $workspacePath '.openclaw\extensions\warframe-fast-commands') 'extension'
Remove-AgentsFragment
Remove-ManagedCrons
Remove-WFInfoCompanion

Write-Host "`n== Uninstall summary =="
Write-Host 'Managed skill/plugin files: moved to .openclaw\warframe-assistant-uninstall-backups\ (recoverable, never deleted).'
Write-Host 'Deliberately preserved (user data, not touched):'
foreach ($preserved in @(
    (Join-Path $workspacePath 'state'),
    (Join-Path $workspacePath '.cache'),
    (Join-Path $workspacePath '.openclaw\warframe-assistant-deploy-backups'),
    (Join-Path $workspacePath 'AGENTS.md.warframe-assistant.bak'))) {
  if (Test-Path -LiteralPath $preserved) { Write-Host "  - $preserved" }
}
Write-Host 'Subscription/drops monitor cron jobs (per-target hashed declarationKeys) are user data and were left in place.'
if ($WhatIfPreference) { Write-Host 'Preview complete (-WhatIf): nothing was changed.' }
else { Write-Host 'Uninstall complete. Recoverable backups are listed above; delete them only after you are sure.' }
