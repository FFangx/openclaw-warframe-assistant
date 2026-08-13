[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Workspace = $(if ($env:OPENCLAW_WORKSPACE) { $env:OPENCLAW_WORKSPACE } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.openclaw\workspace' } else { '' }),
  [switch]$SkipAgents,
  [switch]$AgentsOnly,
  [switch]$RemoveAgents,
  [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Workspace) { throw 'Cannot resolve OpenClaw workspace. Pass -Workspace explicitly.' }
if ($SkipAgents -and ($AgentsOnly -or $RemoveAgents)) { throw '-SkipAgents cannot be combined with -AgentsOnly or -RemoveAgents.' }
if ($AgentsOnly -and $RemoveAgents) { throw '-AgentsOnly cannot be combined with -RemoveAgents.' }

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspacePath = [IO.Path]::GetFullPath($Workspace)
$fragmentPath = Join-Path $repoRoot 'config\AGENTS.warframe.md'
$agentsPath = Join-Path $workspacePath 'AGENTS.md'
$beginMarker = '<!-- BEGIN openclaw-warframe-assistant -->'
$endMarker = '<!-- END openclaw-warframe-assistant -->'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifestName = '.warframe-assistant-managed.json'
$buildInfoName = '.warframe-assistant-build.json'

function Read-Utf8([string]$Path) {
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-Utf8Atomic([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $temp = Join-Path $parent ('.warframe-install-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temp, $Content, $utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Get-RelativePath([string]$Root, [string]$Path) {
  return $Path.Substring($Root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
}

function Get-ManagedFileList([string]$Source) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Install source does not exist: $Source" }
  return @(Get-ChildItem -LiteralPath $Source -Recurse -Force -File | Where-Object {
    $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
    $_.Name -notin @($manifestName, $buildInfoName)
  } | ForEach-Object {
    [pscustomobject]@{
      path = Get-RelativePath $Source $_.FullName
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    }
  } | Sort-Object path)
}

function Get-BuildInfo {
  $commit = 'unknown'
  $dirty = $false
  try {
    $commit = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
    $dirty = [bool](& git -C $repoRoot status --porcelain 2>$null)
  } catch { }
  $contentLines = New-Object System.Collections.Generic.List[string]
  foreach ($tree in @('skill', 'extension')) {
    foreach ($file in (Get-ManagedFileList (Join-Path $repoRoot $tree))) { $contentLines.Add("$tree/$($file.path):$($file.sha256)") }
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $contentBytes = [Text.Encoding]::UTF8.GetBytes(($contentLines -join "`n"))
    $contentHash = ([BitConverter]::ToString($sha.ComputeHash($contentBytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
  return [ordered]@{
    schemaVersion = 1
    commit = $commit
    dirty = $dirty
    contentHash = $contentHash
    installedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Read-ManagedManifest([string]$Destination) {
  $path = Join-Path $Destination $manifestName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { return (Read-Utf8 $path | ConvertFrom-Json) }
  catch { throw "Managed manifest is invalid: $path" }
}

function Find-BootstrapLegacyFiles([string]$Destination, [string]$TreeName, [string[]]$CurrentPaths) {
  if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { return @() }
  $current = @{}; foreach ($path in $CurrentPaths) { $current[$path.ToLowerInvariant()] = $true }
  return @(Get-ChildItem -LiteralPath $Destination -Recurse -Force -File | Where-Object {
    $relative = Get-RelativePath $Destination $_.FullName
    if ($relative -match '^(node_modules|\.git)(/|$)' -or $_.Name -in @('package-lock.json', $manifestName, $buildInfoName)) { return $false }
    if ($current.ContainsKey($relative.ToLowerInvariant())) { return $false }
    return ($_.Name -like '*.bak' -or $_.Name -like '*.pre-*' -or
      $relative -match '^docs/' -or $relative -eq 'deal-tiers.txt' -or
      ($TreeName -eq 'skill' -and $relative -match '^scripts/.*\.(mjs|cjs|js)$') -or
      ($TreeName -eq 'extension' -and $relative -match '\.(mjs|cjs|js|ts)$'))
  } | ForEach-Object { Get-RelativePath $Destination $_.FullName })
}

function Sync-ManagedTree([string]$Source, [string]$Destination, [string]$TreeName, $BuildInfo) {
  $sourcePath = [IO.Path]::GetFullPath($Source)
  $destinationPath = [IO.Path]::GetFullPath($Destination)
  $destinationParent = Split-Path -Parent $destinationPath
  $stage = Join-Path $destinationParent ('.warframe-stage-' + $TreeName + '-' + [guid]::NewGuid().ToString('N'))
  $backupRoot = Join-Path $workspacePath ('.openclaw\warframe-assistant-deploy-backups\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + $TreeName)
  $files = Get-ManagedFileList $sourcePath
  $oldManifest = Read-ManagedManifest $destinationPath
  $oldPaths = @()
  if ($oldManifest -and $oldManifest.files) { $oldPaths = @($oldManifest.files | ForEach-Object { [string]$_.path }) }
  $currentPaths = @($files | ForEach-Object { [string]$_.path })
  $currentSet = @{}; foreach ($path in $currentPaths) { $currentSet[$path.ToLowerInvariant()] = $true }
  $stalePaths = @($oldPaths | Where-Object { -not $currentSet.ContainsKey($_.ToLowerInvariant()) })
  if (-not $oldManifest) { $stalePaths += Find-BootstrapLegacyFiles $destinationPath $TreeName $currentPaths }
  $stalePaths = @($stalePaths | Sort-Object -Unique)
  $replacedPaths = New-Object System.Collections.Generic.List[string]
  $createdPaths = New-Object System.Collections.Generic.List[string]
  $movedStalePaths = New-Object System.Collections.Generic.List[string]

  try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($file in $files) {
      $sourceFile = Join-Path $sourcePath ($file.path.Replace('/', '\'))
      $stageFile = Join-Path $stage ($file.path.Replace('/', '\'))
      $stageParent = Split-Path -Parent $stageFile
      if (-not (Test-Path -LiteralPath $stageParent)) { New-Item -ItemType Directory -Path $stageParent -Force | Out-Null }
      Copy-Item -LiteralPath $sourceFile -Destination $stageFile -Force
      $stageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stageFile).Hash.ToLowerInvariant()
      if ($stageHash -ne $file.sha256) { throw "Staging hash mismatch: $($file.path)" }
    }

    if (-not (Test-Path -LiteralPath $destinationPath)) { New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null }
    foreach ($relative in $stalePaths) {
      $target = [IO.Path]::GetFullPath((Join-Path $destinationPath ($relative.Replace('/', '\'))))
      if (-not $target.StartsWith($destinationPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe stale path: $relative" }
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $backup = Join-Path $backupRoot ('stale\' + $relative.Replace('/', '\'))
        $backupParent = Split-Path -Parent $backup
        if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
        Move-Item -LiteralPath $target -Destination $backup -Force
        $movedStalePaths.Add($relative)
      }
    }

    foreach ($file in $files) {
      $stageFile = Join-Path $stage ($file.path.Replace('/', '\'))
      $target = Join-Path $destinationPath ($file.path.Replace('/', '\'))
      $targetParent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
      $needsCopy = $true
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
        $needsCopy = $targetHash -ne $file.sha256
      }
      if ($needsCopy) {
        if (Test-Path -LiteralPath $target -PathType Leaf) {
          $backup = Join-Path $backupRoot ('replaced\' + $file.path.Replace('/', '\'))
          $backupParent = Split-Path -Parent $backup
          if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
          Copy-Item -LiteralPath $target -Destination $backup -Force
          $replacedPaths.Add($file.path)
        } else { $createdPaths.Add($file.path) }
        $tempTarget = Join-Path $targetParent ('.warframe-copy-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Copy-Item -LiteralPath $stageFile -Destination $tempTarget -Force
        Move-Item -LiteralPath $tempTarget -Destination $target -Force
      }
    }

    foreach ($file in $files) {
      $target = Join-Path $destinationPath ($file.path.Replace('/', '\'))
      if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Installed file missing: $($file.path)" }
      $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
      if ($targetHash -ne $file.sha256) { throw "Installed hash mismatch: $($file.path)" }
    }

    foreach ($metadataName in @($manifestName, $buildInfoName)) {
      $metadataPath = Join-Path $destinationPath $metadataName
      if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        $metadataBackup = Join-Path $backupRoot ('metadata\' + $metadataName)
        $metadataParent = Split-Path -Parent $metadataBackup
        if (-not (Test-Path -LiteralPath $metadataParent)) { New-Item -ItemType Directory -Path $metadataParent -Force | Out-Null }
        Copy-Item -LiteralPath $metadataPath -Destination $metadataBackup -Force
      }
    }
    $manifest = [ordered]@{ schemaVersion = 1; tree = $TreeName; build = $BuildInfo; files = $files }
    Write-Utf8Atomic (Join-Path $destinationPath $manifestName) (($manifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
    Write-Utf8Atomic (Join-Path $destinationPath $buildInfoName) (($BuildInfo | ConvertTo-Json -Depth 4) + [Environment]::NewLine)
    Write-Host "Verified $TreeName deployment: $($files.Count) managed files, $($stalePaths.Count) stale files quarantined."
    if ($stalePaths.Count -gt 0) { Write-Host "Recoverable backup: $backupRoot" }
  } catch {
    $originalError = $_
    foreach ($relative in $createdPaths) {
      $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
      if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    foreach ($relative in $replacedPaths) {
      $backup = Join-Path $backupRoot ('replaced\' + $relative.Replace('/', '\'))
      $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
      if (Test-Path -LiteralPath $backup -PathType Leaf) { Copy-Item -LiteralPath $backup -Destination $target -Force }
    }
    foreach ($relative in $movedStalePaths) {
      $backup = Join-Path $backupRoot ('stale\' + $relative.Replace('/', '\'))
      $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
      $targetParent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
      if (Test-Path -LiteralPath $backup -PathType Leaf) { Move-Item -LiteralPath $backup -Destination $target -Force }
    }
    foreach ($metadataName in @($manifestName, $buildInfoName)) {
      $metadataBackup = Join-Path $backupRoot ('metadata\' + $metadataName)
      $metadataPath = Join-Path $destinationPath $metadataName
      if (Test-Path -LiteralPath $metadataBackup -PathType Leaf) { Copy-Item -LiteralPath $metadataBackup -Destination $metadataPath -Force }
    }
    throw $originalError
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}

function Merge-AgentsBlock([switch]$Remove) {
  if (-not (Test-Path -LiteralPath $fragmentPath -PathType Leaf)) { throw "AGENTS fragment does not exist: $fragmentPath" }
  $fragment = (Read-Utf8 $fragmentPath).Trim()
  if (-not ($fragment.Contains($beginMarker) -and $fragment.Contains($endMarker))) { throw 'AGENTS fragment is missing managed markers.' }
  $current = if (Test-Path -LiteralPath $agentsPath -PathType Leaf) { Read-Utf8 $agentsPath } else { '' }
  $pattern = [regex]::Escape($beginMarker) + '(?s:.*?)' + [regex]::Escape($endMarker)
  $hasBlock = [regex]::IsMatch($current, $pattern)

  if ($Remove) {
    if (-not $hasBlock) { Write-Host 'No managed Warframe block found in AGENTS.md.'; return }
    $updated = [regex]::Replace($current, $pattern, '').TrimEnd() + [Environment]::NewLine
    $action = 'Remove managed Warframe safety block'
  } elseif ($hasBlock) {
    $updated = [regex]::Replace($current, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $fragment })
    $action = 'Update managed Warframe safety block'
  } else {
    $prefix = $current.TrimEnd()
    $updated = $(if ($prefix) { $prefix + [Environment]::NewLine + [Environment]::NewLine } else { '' }) + $fragment + [Environment]::NewLine
    $action = 'Append managed Warframe safety block'
  }

  if ($updated -ceq $current) { Write-Host 'The managed Warframe block is already current.'; return }
  if ($PSCmdlet.ShouldProcess($agentsPath, $action)) {
    if (Test-Path -LiteralPath $agentsPath -PathType Leaf) { Copy-Item -LiteralPath $agentsPath -Destination "$agentsPath.warframe-assistant.bak" -Force }
    Write-Utf8Atomic $agentsPath $updated
    Write-Host "$action`: $agentsPath"
  }
}

if ($RemoveAgents) {
  Merge-AgentsBlock -Remove
  return
}

if (-not $AgentsOnly) {
  $skillTarget = Join-Path $workspacePath 'skills\warframe-assistant'
  $extensionTarget = Join-Path $workspacePath '.openclaw\extensions\warframe-fast-commands'
  if (-not $SkipPreflight -and -not $WhatIfPreference) {
    & (Join-Path $repoRoot 'verify.ps1') -SourceOnly -SkipDoctor -SkipPluginDoctor -SkipInstallerTest
    if ($LASTEXITCODE -ne 0) { throw 'Preflight verification failed; deployment was not changed.' }
  }
  $buildInfo = Get-BuildInfo
  if ($PSCmdlet.ShouldProcess($skillTarget, 'Install or update and verify Warframe skill')) { Sync-ManagedTree (Join-Path $repoRoot 'skill') $skillTarget 'skill' $buildInfo }
  if ($PSCmdlet.ShouldProcess($extensionTarget, 'Install or update and verify Warframe plugin')) { Sync-ManagedTree (Join-Path $repoRoot 'extension') $extensionTarget 'extension' $buildInfo }
  if (-not $WhatIfPreference) { Write-Host "Skill and plugin synchronized to: $workspacePath" }
}

if (-not $SkipAgents) { Merge-AgentsBlock }
if ($WhatIfPreference) { Write-Host 'Preview complete. No files were changed.' }
else { Write-Host 'Install complete. Run: openclaw.cmd gateway restart' }
