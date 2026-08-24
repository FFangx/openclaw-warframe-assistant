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

function Get-TestFiles([string]$Directory) {
  $files = @(Get-ChildItem -LiteralPath $Directory -File -Filter '*.test.mjs' |
      Sort-Object -Property FullName |
      ForEach-Object { $_.FullName })
  if ($files.Count -eq 0) { throw "No test files found in $Directory" }
  return $files
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
    & (Join-Path $repoRoot 'install.ps1') -Workspace $testRoot -SkipAgents -SkipPreflight -SkipCron
    if ($LASTEXITCODE -ne 0) { throw "initial install failed: $LASTEXITCODE" }
    $skillTarget = Join-Path $testRoot 'skills\warframe-assistant'
    $staleRelative = 'scripts/obsolete-managed-test.mjs'
    $stalePath = Join-Path $skillTarget ($staleRelative.Replace('/', '\'))
    [IO.File]::WriteAllText($stalePath, 'export const obsolete = true;', [Text.UTF8Encoding]::new($false))
    $manifestPath = Join-Path $skillTarget $manifestName
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    $manifest.files = @($manifest.files) + [pscustomobject]@{ path = $staleRelative; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stalePath).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    & (Join-Path $repoRoot 'install.ps1') -Workspace $testRoot -SkipAgents -SkipPreflight -SkipCron
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
  $tests = @(Get-TestFiles (Join-Path $repoRoot 'skill\scripts'))
  & node --test @tests
}
Invoke-Checked 'source extension contract tests' {
  $tests = @(Get-TestFiles (Join-Path $repoRoot 'extension'))
  & node --test @tests
}
Invoke-Checked 'command registry documentation contracts' {
  & node --test (Join-Path $repoRoot 'tools\generate-command-docs.test.mjs')
  if ($LASTEXITCODE -ne 0) { throw "command documentation tests failed: $LASTEXITCODE" }
  & node (Join-Path $repoRoot 'tools\generate-command-docs.mjs') --check
}
if (-not $SkipInstallerTest) { Invoke-Checked 'installer lifecycle and stale-file quarantine' { Test-InstallerLifecycle } }
Invoke-Checked 'release changelog contract tests' {
  & (Join-Path $repoRoot 'tests\release-changelog.test.ps1')
}
Invoke-Checked 'reward-zh daily task contract tests' {
  & (Join-Path $repoRoot 'tests\reward-zh-cron-contract.test.ps1')
}
Invoke-Checked 'WFInfo companion installer contract tests' {
  & (Join-Path $repoRoot 'tests\wfinfo-companion-installer.test.ps1')
}
Invoke-Checked 'uninstall lifecycle contract tests' {
  & (Join-Path $repoRoot 'tests\uninstall.test.ps1')
}
Invoke-Checked 'repo metadata contract tests' {
  & (Join-Path $repoRoot 'tests\repo-metadata.test.ps1')
}
Invoke-Checked 'powershell script encoding contract (UTF-8 BOM on every ps1)' {
  & (Join-Path $repoRoot 'tests\ps1-encoding.test.ps1')
}

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
      if ([string]$skillBuild.version -ne [string]$extensionBuild.version) { throw "skill and extension build versions differ: $($skillBuild.version) vs $($extensionBuild.version)" }
      $sourceVersionPath = Join-Path $repoRoot 'VERSION'
      if (Test-Path -LiteralPath $sourceVersionPath -PathType Leaf) {
        $sourceVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath $sourceVersionPath).Trim()
        if ([string]$skillBuild.version -ne $sourceVersion) { throw "runtime build version $($skillBuild.version) does not match source VERSION $sourceVersion; redeploy before verifying" }
      } else {
        throw 'source VERSION file is missing; create it before verifying a managed runtime'
      }
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
      $sectionHelp = & node $dispatch run '帮助 世界状态' 2>&1
      if ($LASTEXITCODE -ne 0) { throw "partition help command failed: $($sectionHelp -join "`n")" }
      $sectionData = ($sectionHelp -join "`n") | ConvertFrom-Json
      if (-not $sectionData.ok -or -not $sectionData.handled -or -not $sectionData.mediaUrl -or -not (Test-Path -LiteralPath $sectionData.mediaUrl -PathType Leaf)) { throw 'partition help did not render a verifiable card result' }
      if ([string]$sectionData.query -ne '世界状态') { throw "partition help query was not preserved: $($sectionData.query)" }
      Write-Host 'dispatch catalog, main help-card, and partition help-card rendering are healthy'
    }
    Invoke-Checked 'runtime reward-zh AI cron contract' {
      $jobsRaw = & openclaw.cmd cron list --json 2>&1
      if ($LASTEXITCODE -ne 0) { throw 'openclaw cron list failed' }
      $text = ($jobsRaw -join "`n")
      $start = $text.IndexOfAny([char[]]('[', '{'))
      if ($start -lt 0) { throw 'openclaw cron list produced no JSON' }
      $payload = $text.Substring($start) | ConvertFrom-Json
      $jobs = @()
      try { if ($null -ne $payload.jobs) { $jobs = @($payload.jobs) } } catch { }
      if ($jobs.Count -eq 0 -and $payload -is [System.Array]) { $jobs = @($payload) }
      $matched = @($jobs | Where-Object { [string]$_.declarationKey -eq 'warframe-assistant:reward-zh-ai:default' })
      if ($matched.Count -eq 0) { throw 'daily reward-zh AI cron job missing; run install.ps1 to apply config/cron/reward-zh-ai.job.json' }
      $entry = $matched[0]
      $entryProps = @($entry.PSObject.Properties.Name)
      $enabled = if ($entryProps -contains 'enabled') { [bool]$entry.enabled } else { $false }
      if (-not $enabled) { throw 'daily reward-zh AI cron job is disabled' }
      $scheduleObj = if ($entryProps -contains 'schedule') { $entry.schedule } else { $null }
      $everyMs = 0
      if ($null -ne $scheduleObj) {
        $scheduleProps = @($scheduleObj.PSObject.Properties.Name)
        if ($scheduleProps -contains 'everyMs') { $everyMs = [int64]$scheduleObj.everyMs }
        elseif ($scheduleProps -contains 'every_ms') { $everyMs = [int64]$scheduleObj.every_ms }
      }
      if ($everyMs -ne 86400000) { throw "daily reward-zh AI cron schedule is not daily (everyMs=$everyMs)" }
      $sessionTarget = if ($entryProps -contains 'sessionTarget') { [string]$entry.sessionTarget } else { '' }
      if ($sessionTarget -ne 'isolated') { throw 'daily reward-zh AI cron session target is not isolated' }
      Write-Host 'reward-zh AI cron contract verified: enabled, daily, isolated agent job'
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
