[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Version,
  [switch]$DryRun,
  [switch]$Push,
  [switch]$SkipVerify
)

# Release loop for the OpenClaw Warframe assistant.
#
#   .\release.ps1                # release the version recorded in .\VERSION
#   .\release.ps1 -Version 1.1.0 # bump VERSION to 1.1.0 and release it
#   .\release.ps1 -DryRun        # preview the release without changing anything
#   .\release.ps1 -Push          # also push main and the new tag to origin
#
# Gates (all must pass):
#   1. Clean work tree, on branch main, HEAD == origin/main.
#   2. Version is valid semver and the tag v<version> does not exist yet.
#   3. CHANGELOG.md has exactly one non-empty [Unreleased] section.
#   4. verify.ps1 -SourceOnly passes (source tests + installer lifecycle).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$versionPath = Join-Path $repoRoot 'VERSION'
$changelogPath = Join-Path $repoRoot 'CHANGELOG.md'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$Path) {
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-Utf8([string]$Path, [string]$Content) {
  $temp = Join-Path (Split-Path -Parent $Path) ('.release-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temp, $Content, $utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Invoke-Git([string[]]$Arguments) {
  return (& git -C $repoRoot @Arguments 2>&1) -join "`n"
}

function Get-Version {
  if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "Invalid semver: $Version" }
    return $Version
  }
  if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { throw 'VERSION file is missing. Create it or pass -Version.' }
  $fromFile = (Read-Utf8 $versionPath).Trim()
  if ($fromFile -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "VERSION file contains an invalid semver: $fromFile" }
  return $fromFile
}

function Get-ChangelogRelease([string]$ReleaseVersion) {
  $text = (Read-Utf8 $changelogPath).Replace("`r`n", "`n")
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.AddRange([string[]]($text -split "`n", -1))
  $unreleasedIndex = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq '## [Unreleased]') {
      if ($unreleasedIndex -ge 0) { throw 'CHANGELOG.md has more than one [Unreleased] section.' }
      $unreleasedIndex = $i
    }
  }
  if ($unreleasedIndex -lt 0) { throw 'CHANGELOG.md has no [Unreleased] section.' }
  $entries = New-Object System.Collections.Generic.List[string]
  for ($i = $unreleasedIndex + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^## ') { break }
    if ($lines[$i].Trim()) { $entries.Add($lines[$i]) }
  }
  if ($entries.Count -eq 0) { throw 'The [Unreleased] section is empty; add changelog entries before releasing.' }
  $date = (Get-Date).ToString('yyyy-MM-dd')
  $lines[$unreleasedIndex] = "## [$ReleaseVersion] - $date"
  $lines.Insert($unreleasedIndex + 1, '')
  $lines.Insert($unreleasedIndex + 2, '## [Unreleased]')
  $lines.Insert($unreleasedIndex + 3, '')
  return ($lines -join "`n")
}

function Test-Gates {
  if ($DryRun) {
    Write-Host 'DryRun: skipping repository up-to-date fetch.'
    $localMain = Invoke-Git @('rev-parse', 'main')
    $originMain = Invoke-Git @('rev-parse', 'origin/main')
    if ($localMain -ne $originMain) { throw "Local main ($localMain) differs from the locally known origin/main ($originMain); fetch first or release without -DryRun." }
  } else {
    Invoke-Git @('fetch', 'origin', '--prune') | Out-Null
    $localMain = Invoke-Git @('rev-parse', 'main')
    $originMain = Invoke-Git @('rev-parse', 'origin/main')
    if ($localMain -ne $originMain) { throw "main is not up to date with origin/main ($localMain vs $originMain)." }
  }
  $porcelain = Invoke-Git @('status', '--porcelain')
  if ($porcelain) { throw "Work tree is not clean:`n$porcelain" }
  $branch = Invoke-Git @('branch', '--show-current')
  if ($branch.Trim() -ne 'main') { throw "Release must run on branch main (current: $branch)." }
}

$releaseVersion = Get-Version
$tagName = "v$releaseVersion"

Write-Host "== Release preview: $tagName =="

if (-not $DryRun) { Test-Gates } else { try { Test-Gates } catch { Write-Host "DRYRUN GATE (ignored): $($_.Exception.Message)" -ForegroundColor Yellow } }

if ((Invoke-Git @('tag', '-l', $tagName)).Trim()) { throw "Tag $tagName already exists." }

if (-not $DryRun -and -not $SkipVerify) {
  Write-Host '== Verification gate: verify.ps1 -SourceOnly =='
  & (Join-Path $repoRoot 'verify.ps1') -SourceOnly
  if ($LASTEXITCODE -ne 0) { throw "Source verification failed with exit code $LASTEXITCODE." }
} elseif ($SkipVerify) {
  Write-Host 'Verification gate skipped (-SkipVerify).'
} else {
  Write-Host 'DryRun: verification gate skipped.'
}

$versionChanged = $false
if ($Version -and (Read-Utf8 $versionPath).Trim() -ne $Version) { $versionChanged = $true }

$newChangelog = Get-ChangelogRelease $releaseVersion

if ($DryRun) {
  Write-Host 'DryRun: nothing was written. Changelog header would become:'
  ($newChangelog -split "`n") | Select-Object -First 6 | ForEach-Object { Write-Host "  $_" }
  if ($versionChanged) { Write-Host "DryRun: VERSION would change to $releaseVersion" }
  Write-Host "DryRun: commit message: release v$releaseVersion"
  exit 0
}

Write-Utf8 $versionPath ($releaseVersion + "`n")
Write-Utf8 $changelogPath $newChangelog

Invoke-Git @('add', 'VERSION', 'CHANGELOG.md') | Out-Null
Invoke-Git @('commit', '-m', "release v$releaseVersion") | Out-Null
Invoke-Git @('tag', '-a', $tagName, '-m', "release v$releaseVersion") | Out-Null

Write-Host "Released $tagName ($releaseVersion) locally."
Write-Host (Invoke-Git @('log', '--oneline', '-1'))
Write-Host (Invoke-Git @('show', '--stat', '--oneline', $tagName))

if ($Push) {
  Invoke-Git @('push', 'origin', 'main') | Out-Null
  Invoke-Git @('push', 'origin', $tagName) | Out-Null
  Write-Host 'Pushed main and the release tag to origin.'
} else {
  Write-Host "Nothing was pushed. Review locally, then run: git push origin main; git push origin $tagName"
}
