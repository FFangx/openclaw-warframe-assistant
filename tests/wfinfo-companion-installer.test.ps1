$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repoRoot 'install-wfinfo.ps1'
$productionManifestPath = Join-Path $repoRoot 'config\wfinfo-companion.json'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('wfinfo-companion-test-' + [guid]::NewGuid().ToString('N'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:passed++
  Write-Host "PASS: $Message"
}

function Write-Utf8([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function New-FixturePackage([string]$Source, [string]$ZipPath, [string]$RevisionText) {
  if (Test-Path -LiteralPath $Source) { Remove-Item -LiteralPath $Source -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $Source 'licenses') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\where.exe') -Destination (Join-Path $Source 'WFInfo.exe')
  Write-Utf8 (Join-Path $Source 'LICENSE.txt') 'Apache-2.0 fixture'
  Write-Utf8 (Join-Path $Source 'OPENCLAW-NOTICE.txt') 'fixture notice'
  Write-Utf8 (Join-Path $Source 'MODIFICATIONS.md') $RevisionText
  Write-Utf8 (Join-Path $Source 'THIRD-PARTY-NOTICES.txt') 'fixture third-party notices'
  Write-Utf8 (Join-Path $Source 'licenses\ProDotNetZip-LICENSE.txt') 'fixture ProDotNetZip license'
  Write-Utf8 (Join-Path $Source 'licenses\WebView2-LICENSE.txt') 'fixture WebView2 license'
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $ZipPath
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  $productionManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $productionManifestPath | ConvertFrom-Json
  Assert-True ([int]$productionManifest.schemaVersion -eq 1) 'production manifest schema is 1'
  Assert-True ([string]$productionManifest.releaseTag -eq 'openclaw-v9.8.2.1') 'production manifest pins the companion release tag'
  Assert-True ([string]$productionManifest.downloadUrl -eq 'https://github.com/FFangx/WFinfo/releases/download/openclaw-v9.8.2.1/WFInfo.zip') 'production manifest pins an immutable release URL'
  Assert-True ([string]$productionManifest.packageSha256 -match '^[0-9a-f]{64}$') 'production manifest pins package SHA-256'
  Assert-True ([string]$productionManifest.executableSha256 -match '^[0-9a-f]{64}$') 'production manifest pins executable SHA-256'
  $doctorText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'skill\scripts\doctor.mjs')
  Assert-True ($doctorText.Contains("version: '$($productionManifest.version)'")) 'doctor expects the pinned companion version'
  Assert-True ($doctorText.Contains("executableSha256: '$($productionManifest.executableSha256)'")) 'doctor expects the pinned executable hash'
  $rootInstallerText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'install.ps1')
  Assert-True ($rootInstallerText.Contains('[switch]$WithWFInfo')) 'root installer exposes the WFInfo opt-in switch'
  Assert-True ($rootInstallerText.Contains("Join-Path `$repoRoot 'install-wfinfo.ps1'")) 'root installer delegates to the companion installer'

  $source = Join-Path $testRoot 'package-source'
  $zip = Join-Path $testRoot 'WFInfo-fixture.zip'
  $manifestPath = Join-Path $testRoot 'manifest.json'
  $target = Join-Path $testRoot 'installed\WFInfo'
  New-FixturePackage $source $zip 'revision one'

  $fixtureExe = Join-Path $source 'WFInfo.exe'
  $fixtureVersion = (Get-Item -LiteralPath $fixtureExe).VersionInfo.FileVersion
  $fixtureManifest = [ordered]@{
    schemaVersion = 1
    id = 'wfinfo-openclaw-companion'
    version = $fixtureVersion
    releaseTag = 'openclaw-test'
    repository = 'FFangx/WFinfo'
    downloadUrl = 'https://github.com/FFangx/WFinfo/releases/download/openclaw-test/WFInfo.zip'
    packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    executable = 'WFInfo.exe'
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureExe).Hash.ToLowerInvariant()
    fileVersion = $fixtureVersion
    requiredFiles = @('WFInfo.exe','LICENSE.txt','OPENCLAW-NOTICE.txt','MODIFICATIONS.md','THIRD-PARTY-NOTICES.txt','licenses/ProDotNetZip-LICENSE.txt','licenses/WebView2-LICENSE.txt')
  }
  Write-Utf8 $manifestPath (($fixtureManifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)

  & $installer -InstallDir $target -ManifestPath $manifestPath -PackagePath $zip
  Assert-True (Test-Path -LiteralPath (Join-Path $target 'WFInfo.exe') -PathType Leaf) 'fixture install writes WFInfo.exe'
  Assert-True (Test-Path -LiteralPath (Join-Path $target 'LICENSE.txt') -PathType Leaf) 'fixture install preserves Apache license'
  Assert-True (Test-Path -LiteralPath (Join-Path $target '.openclaw-wfinfo-companion.json') -PathType Leaf) 'fixture install writes managed marker'
  Assert-True ((Get-Content -Raw -Encoding UTF8 (Join-Path $target 'MODIFICATIONS.md')) -eq 'revision one') 'fixture install content matches package'

  & $installer -InstallDir $target -ManifestPath $manifestPath -PackagePath $zip
  $backupBeforeUpgrade = @(Get-ChildItem -LiteralPath (Split-Path -Parent $target) -Directory -Filter 'WFInfo.backup-*' -ErrorAction SilentlyContinue)
  Assert-True ($backupBeforeUpgrade.Count -eq 0) 'idempotent reinstall creates no backup'

  $badManifest = $fixtureManifest | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  $badManifest.packageSha256 = ('0' * 64)
  Write-Utf8 $manifestPath (($badManifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
  $hashRejected = $false
  try { & $installer -InstallDir $target -ManifestPath $manifestPath -PackagePath $zip } catch { $hashRejected = $_.Exception.Message -match 'SHA-256 mismatch' }
  Assert-True $hashRejected 'package hash mismatch is rejected'
  Assert-True ((Get-Content -Raw -Encoding UTF8 (Join-Path $target 'MODIFICATIONS.md')) -eq 'revision one') 'failed validation leaves installed files unchanged'

  New-FixturePackage $source $zip 'revision two'
  $fixtureManifest.packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  $fixtureManifest.executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source 'WFInfo.exe')).Hash.ToLowerInvariant()
  Write-Utf8 $manifestPath (($fixtureManifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
  & $installer -InstallDir $target -ManifestPath $manifestPath -PackagePath $zip
  Assert-True ((Get-Content -Raw -Encoding UTF8 (Join-Path $target 'MODIFICATIONS.md')) -eq 'revision two') 'validated upgrade replaces target content'
  $backups = @(Get-ChildItem -LiteralPath (Split-Path -Parent $target) -Directory -Filter 'WFInfo.backup-*')
  Assert-True ($backups.Count -eq 1) 'validated upgrade preserves one recoverable backup'
  Assert-True ((Get-Content -Raw -Encoding UTF8 (Join-Path $backups[0].FullName 'MODIFICATIONS.md')) -eq 'revision one') 'backup preserves previous install bytes'

  Write-Host "WFInfo companion installer contract tests: $passed passed"
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "unsafe test cleanup target: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
