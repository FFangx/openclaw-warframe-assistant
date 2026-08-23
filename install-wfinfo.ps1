[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'OpenClaw\WFInfo' } else { '' }),
  [string]$ManifestPath = (Join-Path $PSScriptRoot 'config\wfinfo-companion.json'),
  [string]$PackagePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

if (-not $InstallDir) { throw 'Cannot resolve WFInfo install directory. Pass -InstallDir explicitly.' }
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "WFInfo companion manifest missing: $ManifestPath" }

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestPath | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.id -ne 'wfinfo-openclaw-companion') { throw 'Unsupported WFInfo companion manifest.' }
if ([string]$manifest.downloadUrl -notmatch '^https://github\.com/FFangx/WFinfo/releases/download/') { throw 'WFInfo companion download URL is outside the approved repository.' }
if ([string]$manifest.packageSha256 -notmatch '^[0-9a-fA-F]{64}$' -or [string]$manifest.executableSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'WFInfo companion manifest contains an invalid SHA-256.' }

$target = [IO.Path]::GetFullPath($InstallDir)
$targetRoot = [IO.Path]::GetPathRoot($target)
if ($target -eq $targetRoot -or -not (Split-Path -Leaf $target)) { throw "Unsafe WFInfo install target: $target" }
$parent = Split-Path -Parent $target
$leaf = Split-Path -Leaf $target
$stage = Join-Path $parent ('.' + $leaf + '.stage-' + [guid]::NewGuid().ToString('N'))
$downloadedPackage = $null

function Get-LowerHash([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-PathInsideParent([string]$Path, [string]$ExpectedParent) {
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd('\') + '\'
  if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe managed path: $full" }
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

try {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null

  if ($PackagePath) {
    $package = [IO.Path]::GetFullPath($PackagePath)
    if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw "WFInfo package missing: $package" }
  } else {
    $downloadedPackage = Join-Path ([IO.Path]::GetTempPath()) ('wfinfo-openclaw-' + [guid]::NewGuid().ToString('N') + '.zip')
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$manifest.downloadUrl) -OutFile $downloadedPackage
    $package = $downloadedPackage
  }

  $packageHash = Get-LowerHash $package
  if ($packageHash -ne ([string]$manifest.packageSha256).ToLowerInvariant()) { throw "WFInfo package SHA-256 mismatch: expected=$($manifest.packageSha256) actual=$packageHash" }

  Assert-PathInsideParent $stage $parent
  New-Item -ItemType Directory -Path $stage | Out-Null
  Expand-Archive -LiteralPath $package -DestinationPath $stage -Force

  foreach ($relative in @($manifest.requiredFiles)) {
    $candidate = Join-Path $stage ([string]$relative).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "WFInfo package missing required file: $relative" }
  }

  $exe = Join-Path $stage ([string]$manifest.executable)
  $exeHash = Get-LowerHash $exe
  if ($exeHash -ne ([string]$manifest.executableSha256).ToLowerInvariant()) { throw "WFInfo executable SHA-256 mismatch: expected=$($manifest.executableSha256) actual=$exeHash" }
  $fileVersion = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
  if ([string]$fileVersion -ne [string]$manifest.fileVersion) { throw "WFInfo executable version mismatch: expected=$($manifest.fileVersion) actual=$fileVersion" }

  $marker = [ordered]@{
    schemaVersion = 1
    id = [string]$manifest.id
    version = [string]$manifest.version
    releaseTag = [string]$manifest.releaseTag
    repository = [string]$manifest.repository
    packageSha256 = $packageHash
    executableSha256 = $exeHash
    installedAt = [DateTime]::UtcNow.ToString('o')
  }
  [IO.File]::WriteAllText((Join-Path $stage '.openclaw-wfinfo-companion.json'), (($marker | ConvertTo-Json -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

  if (Test-Path -LiteralPath $target -PathType Container) {
    $existingMarker = Join-Path $target '.openclaw-wfinfo-companion.json'
    $existingExe = Join-Path $target ([string]$manifest.executable)
    if ((Test-Path -LiteralPath $existingMarker -PathType Leaf) -and (Test-Path -LiteralPath $existingExe -PathType Leaf)) {
      try {
        $installed = Get-Content -Raw -Encoding UTF8 -LiteralPath $existingMarker | ConvertFrom-Json
        if ([string]$installed.packageSha256 -eq $packageHash -and (Get-LowerHash $existingExe) -eq $exeHash) {
          Write-Host "WFInfo OpenClaw Companion already current: $target ($($manifest.version))"
          return
        }
      } catch { }
    }
    if (Test-WFInfoRunningFrom $target) { throw "WFInfo is running from $target. Close it before updating." }
  }

  if (-not $PSCmdlet.ShouldProcess($target, "Install WFInfo OpenClaw Companion $($manifest.version)")) { return }

  $backup = $null
  if (Test-Path -LiteralPath $target) {
    $backup = Join-Path $parent ($leaf + '.backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
    Assert-PathInsideParent $backup $parent
    if (Test-Path -LiteralPath $backup) { throw "WFInfo backup target already exists: $backup" }
    Move-Item -LiteralPath $target -Destination $backup
  }
  try {
    Move-Item -LiteralPath $stage -Destination $target
  } catch {
    if ($backup -and -not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target }
    throw
  }

  Write-Host "WFInfo OpenClaw Companion installed: $target"
  Write-Host "Version: $($manifest.version) · release: $($manifest.releaseTag)"
  if ($backup) { Write-Host "Previous install preserved at: $backup" }
} finally {
  if (Test-Path -LiteralPath $stage) {
    Assert-PathInsideParent $stage $parent
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
  if ($downloadedPackage -and (Test-Path -LiteralPath $downloadedPackage)) { Remove-Item -LiteralPath $downloadedPackage -Force }
}
