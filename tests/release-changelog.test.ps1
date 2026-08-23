# Contract tests for release-changelog.ps1 — the changelog transformation used by
# release.ps1. Plain PowerShell assertions (no Pester dependency), mirroring the
# repo's no-framework test style; runs on Windows pwsh (CI: windows-latest).
#
# These tests lock the structure contract that prevents re-creating the duplicate
# [Unreleased] / duplicate [1.0.0] sections the v1.0.0 release produced
# (2026-08-17): exactly one empty top-level [Unreleased] placeholder, exactly one
# non-empty pending "## [<version>]" section, a date stamped exactly once, and —
# for every semver version, historical ones included — at most one heading per
# version (bare or dated). The final test validates that the repo's actual
# VERSION and CHANGELOG.md convert cleanly right now without duplicates.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $repoRoot 'release-changelog.ps1')

$script:pass = 0
$script:fail = 0

function Assert-True([string]$Label, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) { Write-Host "PASS: $Label"; $script:pass++ }
  else { Write-Host "FAIL: $Label $Detail" -ForegroundColor Red; $script:fail++ }
}

function Assert-Throws([string]$Label, [scriptblock]$Action, [string]$MessagePart) {
  try {
    & $Action
    Write-Host "FAIL: $Label - expected an error containing: $MessagePart" -ForegroundColor Red
    $script:fail++
  } catch {
    if ($_.Exception.Message -like "*$MessagePart*") { Write-Host "PASS: $Label"; $script:pass++ }
    else { Write-Host "FAIL: $Label - unexpected error: $($_.Exception.Message)" -ForegroundColor Red; $script:fail++ }
  }
}

# --- canonical structure: empty [Unreleased] + pending [1.1.0] + released [1.0.0] ---
$canonical = @'
## [Unreleased]

## [1.1.0]

### 修复

- 示例条目。

## [1.0.0] - 2026-08-17

### 新增

- 历史条目。
'@
$result = ConvertTo-ReleasedChangelog -Text $canonical -ReleaseVersion '1.1.0' -Date '2026-08-28'
$resultLines = $result -split "`n"
Assert-True 'canonical: stamps the pending section with the release date' ($resultLines -contains '## [1.1.0] - 2026-08-28')
Assert-True 'canonical: removes the bare pending header' ($resultLines -notcontains '## [1.1.0]')
Assert-True 'canonical: keeps exactly one [Unreleased] placeholder' (@($resultLines -eq '## [Unreleased]').Count -eq 1)
Assert-True 'canonical: keeps the released history section' ($resultLines -contains '## [1.0.0] - 2026-08-17')
Assert-True 'canonical: keeps pending and history content' (($result -like '*示例条目。*') -and ($result -like '*历史条目。*'))
Assert-True 'canonical: [Unreleased] stays the top section' ($result.IndexOf('## [Unreleased]') -lt $result.IndexOf('## [1.1.0] - 2026-08-28'))

# --- CRLF input is normalized (files written by Windows editors) ---
$crlfResult = ConvertTo-ReleasedChangelog -Text $canonical.Replace("`n", "`r`n") -ReleaseVersion '1.1.0' -Date '2026-08-28'
Assert-True 'CRLF input is normalized before parsing' (-not ($crlfResult -match "`r"))

# --- version prefix must not collide (1.1.0 vs 1.10.0) ---
$prefixGuard = ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0]

### 修复

- 示例条目。

## [1.10.0] - 2026-08-17

### 新增

- 其他版本。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
Assert-True 'version matching does not collide with 1.10.0' ($prefixGuard.Contains('## [1.1.0] - 2026-08-28') -and $prefixGuard.Contains('## [1.10.0] - 2026-08-17'))

# --- structural guards: every failure mode that previously produced duplicates ---
Assert-Throws 'non-empty [Unreleased] is rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

### 新增

- 遗留条目。

## [1.1.0]

### 修复

- 示例条目。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'not empty'

Assert-Throws 'duplicate [Unreleased] sections are rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0]

### 修复

- 示例条目。

## [Unreleased]

- 旧残留。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'exactly one'

Assert-Throws 'missing pending section is rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.0.0] - 2026-08-17

### 新增

- 历史条目。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'exactly one pending'

Assert-Throws 'duplicate pending sections are rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0]

- 一。

## [1.1.0]

- 二。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'exactly one pending'

Assert-Throws 'already-released version is rejected (no double stamping)' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0] - 2026-08-17

### 修复

- 示例条目。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'refusing to stamp it twice'

Assert-Throws 'duplicate dated historical sections are rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0]

### 修复

- 示例条目。

## [1.0.0] - 2026-08-17

### 新增

- 历史条目一。

## [1.0.0] - 2026-08-17

- 历史条目二。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'duplicate'

Assert-Throws 'same version as bare and dated headings is rejected (historical version)' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0]

### 修复

- 示例条目。

## [1.0.0]

- 裸标题。

## [1.0.0] - 2026-08-17

- 带日期标题。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'duplicate'

Assert-Throws 'empty pending section is rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [Unreleased]

## [1.1.0]

## [1.0.0] - 2026-08-17

### 新增

- 历史条目。
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'is empty'

Assert-Throws '[Unreleased] not at the top is rejected' {
  ConvertTo-ReleasedChangelog -Text (@'
## [1.1.0]

### 修复

- 示例条目。

## [Unreleased]
'@) -ReleaseVersion '1.1.0' -Date '2026-08-28'
} 'must start'

# --- real repo state: accept a valid pending release or an already stamped release ---
$realVersion = ([IO.File]::ReadAllText((Join-Path $repoRoot 'VERSION'), [Text.Encoding]::UTF8)).Trim()
$realChangelog = [IO.File]::ReadAllText((Join-Path $repoRoot 'CHANGELOG.md'), [Text.Encoding]::UTF8)
$realLines = $realChangelog.Replace("`r`n", "`n") -split "`n"
$escapedRealVersion = [regex]::Escape($realVersion)
$realPending = @($realLines -eq "## [$realVersion]")
$realReleased = @($realLines | Where-Object { $_ -match "^## \[$escapedRealVersion\] - \d{4}-\d{2}-\d{2}$" })
Assert-True 'real repo files: current version is pending or released exactly once' (($realPending.Count + $realReleased.Count) -eq 1)

$realResultLines = $realLines
if ($realPending.Count -eq 1) {
  $realConverted = $null
  $realError = ''
  try {
    $realConverted = ConvertTo-ReleasedChangelog -Text $realChangelog -ReleaseVersion $realVersion -Date '2026-08-28'
  } catch { $realError = $_.Exception.Message }
  Assert-True 'real repo files: pending state converts cleanly' ($null -ne $realConverted) $realError
  if ($null -ne $realConverted) { $realResultLines = $realConverted -split "`n" }
} else {
  Assert-True 'real repo files: released state carries an ISO date' ($realReleased.Count -eq 1)
}
Assert-True 'real repo files: exactly one [Unreleased] placeholder remains' (@($realResultLines -eq '## [Unreleased]').Count -eq 1)
$firstRealHeader = @($realResultLines | Where-Object { $_ -match '^## ' } | Select-Object -First 1)
Assert-True 'real repo files: [Unreleased] stays the top section' ($firstRealHeader.Count -eq 1 -and $firstRealHeader[0] -eq '## [Unreleased]')
$realDupes = @($realResultLines | ForEach-Object {
  $m = [regex]::Match($_, '^## \[([^\]]+)\]')
  if ($m.Success) { $m.Groups[1].Value }
} | Where-Object { $_ -ne 'Unreleased' -and $_ -match '^\d+\.\d+\.\d+$' } | Group-Object | Where-Object { $_.Count -gt 1 })
Assert-True 'real repo files: no duplicate semver headings' ($realDupes.Count -eq 0)

Write-Host "`nrelease-changelog contract tests: $($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
