[CmdletBinding()]
param(
  [string]$Workspace = $(if ($env:OPENCLAW_WORKSPACE) { $env:OPENCLAW_WORKSPACE } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.openclaw\workspace' } else { '' }),
  [switch]$SourceOnly,
  [switch]$SkipDoctor,
  [switch]$SkipPluginDoctor,
  [switch]$SkipGateway,
  [switch]$SkipInstallerTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestName = '.warframe-assistant-managed.json'
$buildInfoName = '.warframe-assistant-build.json'
$failures = New-Object System.Collections.Generic.List[string]

function Invoke-Checked([string]$Label, [scriptblock]$Action) {
  Write-Host "`n== $Label =="
  try {
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
    Write-Host "PASS: $Label"
  } catch {
    $script:failures.Add("$Label`: $($_.Exception.Message)")
    Write-Host "FAIL: $Label — $($_.Exception.Message)" -ForegroundColor Red
  }
}

function Get-RelativePath([string]$Root, [string]$Path) {
  return $Path.Substring($Root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
}

function Test-TreeParity([string]$Source, [string]$Destination, [string]$TreeName) {
  $sourcePath = [IO.Path]::GetFullPath($Source)
  $destinationPath = [IO.Path]::GetFullPath($Destination)
  $manifestPath = Join-Path $destinationPath $manifestName
  $buildPath = Join-Path $destinationPath $buildInfoName
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "$TreeName manifest missing: $manifestPath" }
  if (-not (Test-Path -LiteralPath $buildPath -PathType Leaf)) { throw "$TreeName build info missing: $buildPath" }
  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
  $manifestMap = @{}; foreach ($entry in $manifest.files) { $manifestMap[[string]$entry.path] = [string]$entry.sha256 }
  $sourceFiles = @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force -File | Where-Object {
    $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.Name -notin @($manifestName, $buildInfoName)
  })
  if ($sourceFiles.Count -ne $manifestMap.Count) { throw "$TreeName managed count differs: source=$($sourceFiles.Count), manifest=$($manifestMap.Count)" }
  foreach ($file in $sourceFiles) {
    $relative = Get-RelativePath $sourcePath $file.FullName
    if (-not $manifestMap.ContainsKey($relative)) { throw "$TreeName manifest omits: $relative" }
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "$TreeName runtime file missing: $relative" }
    $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
    if ($sourceHash -ne $targetHash -or $sourceHash -ne $manifestMap[$relative].ToLowerInvariant()) { throw "$TreeName hash mismatch: $relative" }
  }
  $build = Get-Content -Raw -Encoding UTF8 -LiteralPath $buildPath | ConvertFrom-Json
  Write-Host "$TreeName parity verified: $($sourceFiles.Count) files; commit=$($build.commit); dirty=$($build.dirty)"
}

function Test-InstallerLifecycle {
  $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('warframe-install-test-' + [guid]::NewGuid().ToString('N'))
  try {
    & (Join-Path $repoRoot 'install.ps1') -Workspace $testRoot -SkipAgents -SkipPreflight
    if ($LASTEXITCODE -ne 0) { throw "initial install failed: $LASTEXITCODE" }
    $skillTarget = Join-Path $testRoot 'skills\warframe-assistant'
    $staleRelative = 'scripts/obsolete-managed-test.mjs'
    $stalePath = Join-Path $skillTarget ($staleRelative.Replace('/', '\'))
    [IO.File]::WriteAllText($stalePath, 'export const obsolete = true;', [Text.UTF8Encoding]::new($false))
    $manifestPath = Join-Path $skillTarget $manifestName
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    $manifest.files = @($manifest.files) + [pscustomobject]@{ path = $staleRelative; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stalePath).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    & (Join-Path $repoRoot 'install.ps1') -Workspace $testRoot -SkipAgents -SkipPreflight
    if ($LASTEXITCODE -ne 0) { throw "upgrade install failed: $LASTEXITCODE" }
    if (Test-Path -LiteralPath $stalePath) { throw 'stale managed file was not removed from runtime' }
    $backup = Get-ChildItem -LiteralPath (Join-Path $testRoot '.openclaw\warframe-assistant-deploy-backups') -Recurse -File -Filter 'obsolete-managed-test.mjs' -ErrorAction SilentlyContinue
    if (-not $backup) { throw 'stale managed file was not preserved in recoverable backup' }
    Test-TreeParity (Join-Path $repoRoot 'skill') $skillTarget 'skill'
    Test-TreeParity (Join-Path $repoRoot 'extension') (Join-Path $testRoot '.openclaw\extensions\warframe-fast-commands') 'extension'
  } finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  }
}

Invoke-Checked 'source skill tests' {
  Push-Location (Join-Path $repoRoot 'skill')
  try { & node --test scripts/*.test.mjs } finally { Pop-Location }
}
Invoke-Checked 'source extension contract tests' {
  Push-Location (Join-Path $repoRoot 'extension')
  try { & node --test *.test.mjs } finally { Pop-Location }
}
if (-not $SkipInstallerTest) { Invoke-Checked 'installer lifecycle and stale-file quarantine' { Test-InstallerLifecycle } }

if (-not $SourceOnly) {
  if (-not $Workspace) { $failures.Add('runtime verification: workspace cannot be resolved') }
  else {
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $skillTarget = Join-Path $workspacePath 'skills\warframe-assistant'
    $extensionTarget = Join-Path $workspacePath '.openclaw\extensions\warframe-fast-commands'
    Invoke-Checked 'source/runtime managed-file parity' {
      Test-TreeParity (Join-Path $repoRoot 'skill') $skillTarget 'skill'
      Test-TreeParity (Join-Path $repoRoot 'extension') $extensionTarget 'extension'
      $skillBuild = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $skillTarget $buildInfoName) | ConvertFrom-Json
      $extensionBuild = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $extensionTarget $buildInfoName) | ConvertFrom-Json
      if ($skillBuild.commit -ne $extensionBuild.commit -or $skillBuild.dirty -ne $extensionBuild.dirty -or $skillBuild.contentHash -ne $extensionBuild.contentHash) { throw 'skill and extension build IDs differ' }
    }
    Invoke-Checked 'runtime tests from current source manifest' {
      $skillTests = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'skill\scripts') -File -Filter '*.test.mjs' | ForEach-Object { Join-Path $skillTarget ('scripts\' + $_.Name) })
      $extensionTests = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'extension') -File -Filter '*.test.mjs' | ForEach-Object { Join-Path $extensionTarget $_.Name })
      & node --test @skillTests @extensionTests
    }
    Invoke-Checked 'runtime deterministic entry smoke test' {
      $dispatch = Join-Path $skillTarget 'scripts\dispatch.mjs'
      $catalog = & node $dispatch list
      if ($LASTEXITCODE -ne 0) { throw 'dispatch list failed' }
      $catalogData = ($catalog -join "`n") | ConvertFrom-Json
      if (@($catalogData).Count -lt 20 -or -not (@($catalogData).kind -contains 'help') -or -not (@($catalogData).kind -contains 'market')) { throw 'dispatch list did not return the expected command catalog' }
      $helpData = $null
      $helpError = $null
      foreach ($attempt in 1..2) {
        $help = & node $dispatch run 'help' 2>&1
        $helpExit = $LASTEXITCODE
        if ($helpExit -eq 0) {
          try { $helpData = ($help -join "`n") | ConvertFrom-Json } catch { $helpError = $_.Exception.Message }
          if ($helpData -and $helpData.ok -and $helpData.handled -and $helpData.mediaUrl -and (Test-Path -LiteralPath $helpData.mediaUrl -PathType Leaf)) { break }
        } else { $helpError = ($help -join "`n") }
        if ($attempt -lt 2) { Start-Sleep -Milliseconds 250 }
      }
      if (-not $helpData -or -not $helpData.ok -or -not $helpData.handled -or -not $helpData.mediaUrl -or -not (Test-Path -LiteralPath $helpData.mediaUrl -PathType Leaf)) { throw "help command did not render a verifiable card result: $helpError" }
      Write-Host 'dispatch catalog and help-card rendering are healthy'
    }
    if (-not $SkipDoctor) { Invoke-Checked 'runtime environment doctor' { & node (Join-Path $skillTarget 'scripts\doctor.mjs') } }
    if (-not $SkipPluginDoctor) { Invoke-Checked 'OpenClaw plugin doctor' { & openclaw.cmd plugins doctor } }
    if (-not $SkipGateway) { Invoke-Checked 'OpenClaw Gateway status' { & openclaw.cmd gateway status } }
  }
}

Write-Host "`n════════ verification summary ════════"
if ($failures.Count -gt 0) {
  foreach ($failure in $failures) { Write-Host "- $failure" -ForegroundColor Red }
  exit 1
}
Write-Host 'All requested verification layers passed.' -ForegroundColor Green
exit 0
