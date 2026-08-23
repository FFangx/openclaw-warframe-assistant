# Contract tests for uninstall.ps1 — the safe uninstall lifecycle.
# Plain PowerShell assertions (no Pester dependency), mirroring the repo's
# no-framework test style; runs on Windows pwsh (CI: windows-latest).
#
# Locked contract:
#   1. Default scope = managed-marked content only: files listed in each tree's
#      .warframe-assistant-managed.json move to a recoverable backup under
#      .openclaw\warframe-assistant-uninstall-backups\; unmanaged files and
#      directories are never touched, never deleted.
#   2. The controlled AGENTS.md fragment is removed by BEGIN/END markers only;
#      all other AGENTS.md content is preserved verbatim.
#   3. Cron cleanup deletes jobs by EXACT declarationKey from
#      config/cron/reward-zh-ai.job.json only — prefix/pattern matches never run.
#   4. WFInfo is touched only with -RemoveWFInfo, only after the managed marker
#      (.openclaw-wfinfo-companion.json) validates, and only via a recoverable
#      move (no permanent deletion).
#   5. -WhatIf changes nothing anywhere (no backup dirs, no temp files).
#   6. The script refuses the repository root as a workspace.
#   7. Malicious manifests are refused before anything moves: relative escape
#      (..), absolute paths and empty entries throw and leave every file in place.
#   8. Backup directories are unique per run: reinstall + uninstall cycles never
#      reuse or overwrite an earlier backup.
#
# All tests run in GUID temp directories with a fake openclaw CLI; nothing here
# touches the real OpenClaw workspace, real cron store, or real WFInfo install.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repoRoot 'install.ps1'
$uninstaller = Join-Path $repoRoot 'uninstall.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('warframe-uninstall-test-' + [guid]::NewGuid().ToString('N'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$passed = 0

function Assert-True([string]$Message, [bool]$Condition) {
  if (-not $Condition) { throw $Message }
  $script:passed++
  Write-Host "PASS: $Message"
}

function Assert-Throws([string]$Message, [scriptblock]$Action, [string]$MessagePart) {
  try {
    & $Action
    throw "expected an error containing: $MessagePart"
  } catch {
    if ($_.Exception.Message -like "*$MessagePart*") { $script:passed++; Write-Host "PASS: $Message" }
    else { throw "unexpected error: $($_.Exception.Message)" }
  }
}

function Write-Utf8([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null

  # --- text guards: the safety properties must exist in the script itself ---
  $uninstallText = [IO.File]::ReadAllText($uninstaller, [Text.Encoding]::UTF8)
  Assert-True 'uninstall.ps1 reads the cron contract file' $uninstallText.Contains('config\cron\reward-zh-ai.job.json')
  Assert-True 'uninstall.ps1 matches declarationKey exactly (-ceq)' $uninstallText.Contains('-ceq $declarationKey')
  Assert-True 'uninstall.ps1 supports -RemoveWFInfo' $uninstallText.Contains('[switch]$RemoveWFInfo')
  Assert-True 'uninstall.ps1 validates the WFInfo managed marker' $uninstallText.Contains('.openclaw-wfinfo-companion.json')
  Assert-True 'uninstall.ps1 refuses unmanaged WFInfo directories' $uninstallText.Contains('refusing to remove unmanaged directory')
  Assert-True 'uninstall.ps1 uses ShouldProcess (WhatIf support)' $uninstallText.Contains('SupportsShouldProcess')
  $wfinfoFunction = $uninstallText.Substring($uninstallText.IndexOf('function Remove-WFInfoCompanion'))
  Assert-True 'WFInfo removal is a recoverable move, never a delete' ($wfinfoFunction.Contains('Move-Item') -and -not $wfinfoFunction.Contains('Remove-Item'))
  Assert-True 'uninstall.ps1 keeps recoverable backups' $uninstallText.Contains('warframe-assistant-uninstall-backups')

  # --- fixture workspace: install once (with AGENTS fragment) ---
  $ws = Join-Path $testRoot 'workspace'
  $wsParent = Split-Path -Parent $ws
  Write-Utf8 (Join-Path $ws 'AGENTS.md') "# 我的个人规则`n- 不要动我的笔记`n"
  & $installer -Workspace $ws -SkipPreflight -SkipCron
  if ($LASTEXITCODE -ne 0) { throw "fixture install failed: $LASTEXITCODE" }
  Assert-True 'fixture install created the managed skill manifest' (Test-Path -LiteralPath (Join-Path $ws 'skills\warframe-assistant\.warframe-assistant-managed.json') -PathType Leaf)
  Assert-True 'fixture install created the managed extension manifest' (Test-Path -LiteralPath (Join-Path $ws '.openclaw\extensions\warframe-fast-commands\.warframe-assistant-managed.json') -PathType Leaf)

  $skillDir = Join-Path $ws 'skills\warframe-assistant'
  $extensionDir = Join-Path $ws '.openclaw\extensions\warframe-fast-commands'
  $agentsPath = Join-Path $ws 'AGENTS.md'
  $backupsRoot = Join-Path $ws '.openclaw\warframe-assistant-uninstall-backups'

  # --- -WhatIf changes nothing ---
  & $uninstaller -Workspace $ws -WhatIf
  if ($LASTEXITCODE -ne 0) { throw "uninstall -WhatIf failed: $LASTEXITCODE" }
  Assert-True 'WhatIf keeps managed skill files in place' (Test-Path -LiteralPath (Join-Path $skillDir 'SKILL.md') -PathType Leaf)
  Assert-True 'WhatIf keeps the AGENTS fragment' ((Get-Content -Raw -Encoding UTF8 $agentsPath).Contains('BEGIN openclaw-warframe-assistant'))
  Assert-True 'WhatIf creates no backup' (-not (Test-Path -LiteralPath $backupsRoot))
  Assert-True 'WhatIf leaves no uninstall temp files' (@(Get-ChildItem -LiteralPath $ws -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.warframe-uninstall-*.tmp' }).Count -eq 0)

  # --- unmanaged user files inside the managed trees must survive ---
  Write-Utf8 (Join-Path $skillDir 'user-notes.txt') 'user data in skill dir'
  Write-Utf8 (Join-Path $extensionDir 'user-notes.txt') 'user data in extension dir'

  # --- default uninstall: managed content moves to backup, nothing is deleted ---
  & $uninstaller -Workspace $ws
  if ($LASTEXITCODE -ne 0) { throw "uninstall failed: $LASTEXITCODE" }
  Assert-True 'managed SKILL.md removed from runtime' (-not (Test-Path -LiteralPath (Join-Path $skillDir 'SKILL.md')))
  Assert-True 'managed script removed from runtime' (-not (Test-Path -LiteralPath (Join-Path $skillDir 'scripts\dispatch.mjs')))
  Assert-True 'managed asset removed from runtime' (-not (Test-Path -LiteralPath (Join-Path $skillDir 'assets\currency\platinum.png')))
  Assert-True 'unmanaged skill file survives' (Test-Path -LiteralPath (Join-Path $skillDir 'user-notes.txt') -PathType Leaf)
  Assert-True 'skill directory survives with user data' (Test-Path -LiteralPath $skillDir -PathType Container)
  Assert-True 'unmanaged extension file survives' (Test-Path -LiteralPath (Join-Path $extensionDir 'user-notes.txt') -PathType Leaf)
  Assert-True 'extension directory survives with user data' (Test-Path -LiteralPath $extensionDir -PathType Container)
  Assert-True 'AGENTS fragment removed' (-not (Get-Content -Raw -Encoding UTF8 $agentsPath).Contains('BEGIN openclaw-warframe-assistant'))
  Assert-True 'personal AGENTS content preserved verbatim' ((Get-Content -Raw -Encoding UTF8 $agentsPath).Contains('不要动我的笔记'))
  Assert-True 'AGENTS backup copy preserved' (Test-Path -LiteralPath (Join-Path $ws 'AGENTS.md.warframe-assistant.bak') -PathType Leaf)

  $backupDirs = @(Get-ChildItem -LiteralPath $backupsRoot -Directory -ErrorAction SilentlyContinue)
  Assert-True 'exactly two recoverable backups (skill + extension)' ($backupDirs.Count -eq 2)
  $skillBackup = @($backupDirs | Where-Object { $_.Name -like '*-skill-*' })[0]
  Assert-True 'backup contains managed SKILL.md' (Test-Path -LiteralPath (Join-Path $skillBackup.FullName 'SKILL.md') -PathType Leaf)
  Assert-True 'backup contains managed manifest metadata' (Test-Path -LiteralPath (Join-Path $skillBackup.FullName 'metadata\.warframe-assistant-managed.json') -PathType Leaf)
  Assert-True 'backup does not contain unmanaged user files' (-not (Test-Path -LiteralPath (Join-Path $skillBackup.FullName 'user-notes.txt')))

  # --- idempotent second run: exits cleanly, creates no new backup ---
  & $uninstaller -Workspace $ws
  if ($LASTEXITCODE -ne 0) { throw "second uninstall failed: $LASTEXITCODE" }
  $backupDirsAfter = @(Get-ChildItem -LiteralPath $backupsRoot -Directory -ErrorAction SilentlyContinue)
  Assert-True 'second uninstall creates no new backup' ($backupDirsAfter.Count -eq 2)

  # --- cron: exact declarationKey only, via fake CLI ---
  # (openclaw.json is created only now, so the default uninstall runs above never
  #  reached the cron gate; from here on only the fake CLI is ever invoked.)
  Write-Utf8 (Join-Path $wsParent 'openclaw.json') '{}'
  $fakeCli = Join-Path $testRoot 'fake-openclaw.cmd'
  $cronLog = Join-Path $testRoot 'cron-rm.log'
  [IO.File]::WriteAllText($fakeCli, @'
@echo off
if "%1"=="cron" if "%2"=="list" (
  echo [{"id":"job-a","declarationKey":"warframe-assistant:reward-zh-ai:default","enabled":true},{"id":"job-b","declarationKey":"warframe-assistant:subscriptions:qq:deadbeef","enabled":true},{"id":"job-c","declarationKey":"other:thing","enabled":true}]
  exit /b 0
)
if "%1"=="cron" if "%2"=="rm" (
  echo %3>>"%UNINSTALL_FAKE_LOG%"
  exit /b 0
)
exit /b 1
'@, $utf8NoBom)
  $env:UNINSTALL_FAKE_LOG = $cronLog

  & $uninstaller -Workspace $ws -SkipAgents -OpenClawCli $fakeCli -WhatIf
  if ($LASTEXITCODE -ne 0) { throw "cron WhatIf uninstall failed: $LASTEXITCODE" }
  Assert-True 'cron WhatIf removes nothing' (-not (Test-Path -LiteralPath $cronLog))

  & $uninstaller -Workspace $ws -SkipAgents -OpenClawCli $fakeCli
  if ($LASTEXITCODE -ne 0) { throw "cron uninstall failed: $LASTEXITCODE" }
  $rmLines = if (Test-Path -LiteralPath $cronLog) { @(Get-Content -LiteralPath $cronLog) } else { @() }
  Assert-True 'exact-key cron job removed exactly once' (@($rmLines | Where-Object { $_ -eq 'job-a' }).Count -eq 1)
  Assert-True 'hashed subscription cron job left in place (user data)' (@($rmLines | Where-Object { $_ -eq 'job-b' }).Count -eq 0)
  Assert-True 'unrelated cron job left in place' (@($rmLines | Where-Object { $_ -eq 'job-c' }).Count -eq 0)
  Remove-Item Env:\UNINSTALL_FAKE_LOG -ErrorAction SilentlyContinue

  # --- WFInfo: explicit switch + managed marker + recoverable move only ---
  $wfiManaged = Join-Path $testRoot 'WFInfo-installed'
  New-Item -ItemType Directory -Path $wfiManaged -Force | Out-Null
  Write-Utf8 (Join-Path $wfiManaged '.openclaw-wfinfo-companion.json') '{"schemaVersion":1,"id":"wfinfo-openclaw-companion","version":"9.8.2.1"}'
  Write-Utf8 (Join-Path $wfiManaged 'WFInfo.exe') 'fixture exe bytes'
  & $uninstaller -Workspace $ws -SkipAgents -SkipCron -RemoveWFInfo -WFInfoInstallDir $wfiManaged -WhatIf
  if ($LASTEXITCODE -ne 0) { throw "WFInfo WhatIf uninstall failed: $LASTEXITCODE" }
  Assert-True 'WFInfo WhatIf keeps the install in place' (Test-Path -LiteralPath (Join-Path $wfiManaged '.openclaw-wfinfo-companion.json') -PathType Leaf)
  Assert-True 'WFInfo WhatIf creates no backup' (@(Get-ChildItem -LiteralPath $testRoot -Directory -Filter 'WFInfo-installed.uninstall-backup-*').Count -eq 0)

  & $uninstaller -Workspace $ws -SkipAgents -SkipCron -RemoveWFInfo -WFInfoInstallDir $wfiManaged
  if ($LASTEXITCODE -ne 0) { throw "WFInfo uninstall failed: $LASTEXITCODE" }
  $wfiBackups = @(Get-ChildItem -LiteralPath $testRoot -Directory -Filter 'WFInfo-installed.uninstall-backup-*')
  Assert-True 'WFInfo install moved to recoverable backup' ($wfiBackups.Count -eq 1 -and -not (Test-Path -LiteralPath $wfiManaged))
  Assert-True 'WFInfo backup preserves marker and executable' (
    (Test-Path -LiteralPath (Join-Path $wfiBackups[0].FullName '.openclaw-wfinfo-companion.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $wfiBackups[0].FullName 'WFInfo.exe') -PathType Leaf))

  $wfiUnmanaged = Join-Path $testRoot 'WFInfo-unmanaged'
  New-Item -ItemType Directory -Path $wfiUnmanaged -Force | Out-Null
  Write-Utf8 (Join-Path $wfiUnmanaged 'random.exe') 'not ours'
  Assert-Throws 'unmanaged WFInfo directory is refused' {
    & $uninstaller -Workspace $ws -SkipAgents -SkipCron -RemoveWFInfo -WFInfoInstallDir $wfiUnmanaged
  } 'unmanaged'
  Assert-True 'refused WFInfo directory is untouched' (Test-Path -LiteralPath (Join-Path $wfiUnmanaged 'random.exe') -PathType Leaf)

  # --- workspace safety guard ---
  Assert-Throws 'repository root is refused as a workspace' {
    & $uninstaller -Workspace $repoRoot -SkipAgents -SkipCron
  } 'repository root'

  # --- manifest path traversal: malicious manifests are refused, nothing moves ---
  $evilWs = Join-Path $testRoot 'evil-workspace'
  $evilSkill = Join-Path $evilWs 'skills\warframe-assistant'
  New-Item -ItemType Directory -Path $evilSkill -Force | Out-Null
  Write-Utf8 (Join-Path $evilSkill 'stays.txt') 'inside the managed tree'
  $outsideVictim = Join-Path $testRoot 'outside-victim.txt'
  Write-Utf8 $outsideVictim 'do not touch'
  Write-Utf8 (Join-Path $evilSkill '.warframe-assistant-managed.json') '{"files":[{"path":"..\\..\\outside-victim.txt","sha256":"deadbeef"}]}'
  Assert-Throws 'traversal manifest (.. escape) is refused' {
    & $uninstaller -Workspace $evilWs -SkipAgents -SkipCron
  } 'Unsafe managed path'
  Assert-True 'traversal victim file outside the tree is untouched' (Test-Path -LiteralPath $outsideVictim -PathType Leaf)
  Assert-True 'traversal run moved nothing from the managed tree' (Test-Path -LiteralPath (Join-Path $evilSkill 'stays.txt') -PathType Leaf)
  Write-Utf8 (Join-Path $evilSkill '.warframe-assistant-managed.json') '{"files":[{"path":"C:\\Windows\\win.ini","sha256":"deadbeef"}]}'
  Assert-Throws 'absolute-path manifest entry is refused' {
    & $uninstaller -Workspace $evilWs -SkipAgents -SkipCron
  } 'Unsafe managed path'
  Write-Utf8 (Join-Path $evilSkill '.warframe-assistant-managed.json') '{"files":[{"path":"","sha256":"deadbeef"}]}'
  Assert-Throws 'empty manifest path is refused' {
    & $uninstaller -Workspace $evilWs -SkipAgents -SkipCron
  } 'empty path'

  # --- backup collision: consecutive install/uninstall cycles never reuse or overwrite a backup ---
  $ws2 = Join-Path $testRoot 'workspace-again'
  New-Item -ItemType Directory -Path $ws2 -Force | Out-Null
  Write-Utf8 (Join-Path $ws2 'AGENTS.md') "# 我的个人规则`n"
  & $installer -Workspace $ws2 -SkipPreflight -SkipCron
  if ($LASTEXITCODE -ne 0) { throw "re-fixture install failed: $LASTEXITCODE" }
  & $uninstaller -Workspace $ws2 -SkipAgents -SkipCron
  if ($LASTEXITCODE -ne 0) { throw "first re-fixture uninstall failed: $LASTEXITCODE" }
  $ws2BackupsRoot = Join-Path $ws2 '.openclaw\warframe-assistant-uninstall-backups'
  $firstSkillBackups = @(Get-ChildItem -LiteralPath $ws2BackupsRoot -Directory -Filter '*-skill-*')
  Assert-True 'first cycle produced exactly one skill backup' ($firstSkillBackups.Count -eq 1)
  & $installer -Workspace $ws2 -SkipPreflight -SkipCron
  if ($LASTEXITCODE -ne 0) { throw "reinstall failed: $LASTEXITCODE" }
  & $uninstaller -Workspace $ws2 -SkipAgents -SkipCron
  if ($LASTEXITCODE -ne 0) { throw "second uninstall failed: $LASTEXITCODE" }
  $allSkillBackups = @(Get-ChildItem -LiteralPath $ws2BackupsRoot -Directory -Filter '*-skill-*')
  Assert-True 'each uninstall run gets its own distinct backup directory' ($allSkillBackups.Count -eq 2)
  Assert-True 'backup directory names never collide across runs' ($allSkillBackups[0].Name -ne $allSkillBackups[1].Name)
  Assert-True 'both runs preserved SKILL.md in their own backups' (
    (Test-Path -LiteralPath (Join-Path $allSkillBackups[0].FullName 'SKILL.md') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $allSkillBackups[1].FullName 'SKILL.md') -PathType Leaf))

  # --- verify.ps1 wiring ---
  $verifyText = [IO.File]::ReadAllText((Join-Path $repoRoot 'verify.ps1'), [Text.Encoding]::UTF8)
  Assert-True 'verify.ps1 runs the uninstall contract tests' $verifyText.Contains('tests\uninstall.test.ps1')

  Write-Host "`nuninstall contract tests: $passed passed"
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "unsafe test cleanup target: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
