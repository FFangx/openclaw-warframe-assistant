# Contract tests for the deployable definition of the daily reward-zh AI verification task
# (config/cron/reward-zh-ai.job.json) and its install/verify wiring. Plain PowerShell
# assertions (no Pester dependency), mirroring the repo's no-framework test style.
#
# Background: the task was created manually in the runtime cron store on 2026-08-19, and the
# repo had no deployable definition — a fresh install or wiped OpenClaw would silently lose the
# daily learn/dismiss loop. These tests lock the contract so install.ps1 can create/repair it
# and verify.ps1 can check the runtime job, without ever touching the real cron store here.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$jobPath = Join-Path $repoRoot 'config\cron\reward-zh-ai.job.json'
$installPath = Join-Path $repoRoot 'install.ps1'
$verifyPath = Join-Path $repoRoot 'verify.ps1'

$script:pass = 0
$script:fail = 0

function Assert-True([string]$Label, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) { Write-Host "PASS: $Label"; $script:pass++ }
  else { Write-Host "FAIL: $Label $Detail" -ForegroundColor Red; $script:fail++ }
}

function Assert-Contains([string]$Label, [string]$Haystack, [string]$Needle) {
  Assert-True $Label ($Haystack.Contains($Needle)) "[missing: $Needle]"
}

# --- job definition file exists and parses ---
Assert-True 'job definition file exists' (Test-Path -LiteralPath $jobPath -PathType Leaf)
$job = $null
if (Test-Path -LiteralPath $jobPath -PathType Leaf) {
  try { $job = [IO.File]::ReadAllText($jobPath, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { Assert-True 'job definition parses as JSON' $false $_.Exception.Message }
}
if ($null -ne $job) {
  Assert-True 'declarationKey is stable' ([string]$job.declarationKey -eq 'warframe-assistant:reward-zh-ai:default')
  Assert-True 'name is set' ([string]$job.name -eq 'Warframe奖励译名AI查证')
  Assert-True 'description is set' ([string]$job.description -like '*reward-zh-inbox*')
  Assert-True 'enabled by default' ([bool]$job.enabled -eq $true)
  Assert-True 'schedule kind is every' ([string]$job.schedule.kind -eq 'every')
  Assert-True 'schedule is daily (86400000ms)' ([int64]$job.schedule.everyMs -eq 86400000)
  Assert-True 'schedule disables staggering' ([bool]$job.schedule.exact -eq $true)
  Assert-True 'session is isolated (never touches a QQ conversation)' ([string]$job.sessionTarget -eq 'isolated')
  Assert-True 'payload is agentTurn' ([string]$job.payload.kind -eq 'agentTurn')
  Assert-True 'agent timeout is at least 10 minutes' ([int]$job.payload.timeoutSeconds -ge 600)
  $message = [string]$job.payload.message
  Assert-Contains 'message: scripts dir placeholder' $message '{{SKILL_SCRIPTS_DIR}}'
  Assert-Contains 'message: points at the fallback script' $message 'reward-zh-fallback.mjs'
  Assert-Contains 'message: reads the inbox first' $message 'inbox'
  Assert-Contains 'message: learn contract' $message 'learn'
  Assert-Contains 'message: dismiss contract' $message 'dismiss'
  Assert-Contains 'message: empty-inbox NO_REPLY' $message 'NO_REPLY'
  Assert-Contains 'message: pure-Chinese requirement' $message '纯中文'
  Assert-Contains 'message: evidence sources only Market/huijiwiki' $message '灰机wiki'
  Assert-Contains 'message: learn ok:false contract (conflict/seed)' $message 'ok:false'
  Assert-Contains 'message: write failure keeps inbox for retry' $message '写入失败'
  Assert-True 'delivery is best-effort announce to owner placeholder' (
    [string]$job.delivery.mode -eq 'announce' -and
    [string]$job.delivery.channel -eq 'qqbot' -and
    [string]$job.delivery.to -eq '{{OWNER_C2C}}' -and
    [bool]$job.delivery.bestEffort -eq $true)
}

# --- install.ps1 wiring: idempotent create/repair, never runs in test workspaces ---
$installText = ''
if (Test-Path -LiteralPath $installPath -PathType Leaf) { $installText = [IO.File]::ReadAllText($installPath, [Text.Encoding]::UTF8) }
Assert-Contains 'install.ps1 references the job definition' $installText 'config\cron\reward-zh-ai.job.json'
Assert-Contains 'install.ps1 has the ensure function' $installText 'function Ensure-RewardZhCronContract'
Assert-Contains 'install.ps1 wires the ensure call' $installText 'Ensure-RewardZhCronContract'
Assert-Contains 'install.ps1 has -SkipCron opt-out' $installText '[switch]$SkipCron'
Assert-Contains 'install.ps1 guards non-runtime workspaces' $installText 'openclaw.json beside the workspace'
Assert-Contains 'install.ps1 preserves existing delivery targets' $installText '绝不改动用户既有的投递目标'
Assert-Contains 'install.ps1 uses declarationKey lookup' $installText 'declarationKey'

# --- verify.ps1 wiring: source contract test + read-only runtime check ---
$verifyText = ''
if (Test-Path -LiteralPath $verifyPath -PathType Leaf) { $verifyText = [IO.File]::ReadAllText($verifyPath, [Text.Encoding]::UTF8) }
Assert-Contains 'verify.ps1 runs the contract test' $verifyText 'tests\reward-zh-cron-contract.test.ps1'
Assert-Contains 'verify.ps1 has the runtime cron check' $verifyText 'runtime reward-zh AI cron contract'
Assert-Contains 'verify.ps1 lifecycle test skips cron' $verifyText '-SkipCron'

# --- runtime tests must never write to the real inbox (2026-08-21 pollution regression) ---
$auditTest = Join-Path $repoRoot 'skill\scripts\subscriptions-audit.test.mjs'
if (Test-Path -LiteralPath $auditTest -PathType Leaf) {
  $auditText = [IO.File]::ReadAllText($auditTest, [Text.Encoding]::UTF8)
  Assert-Contains 'audit test isolates WARFRAME_DATA_CACHE_DIR' $auditText 'WARFRAME_DATA_CACHE_DIR'
  Assert-Contains 'audit test uses a temp cache dir' $auditText 'mkdtemp'
}
$fallbackTest = Join-Path $repoRoot 'skill\scripts\reward-zh-fallback.test.mjs'
if (Test-Path -LiteralPath $fallbackTest -PathType Leaf) {
  $fallbackText = [IO.File]::ReadAllText($fallbackTest, [Text.Encoding]::UTF8)
  Assert-Contains 'fallback test isolates WARFRAME_DATA_CACHE_DIR' $fallbackText 'WARFRAME_DATA_CACHE_DIR'
}

Write-Host "`nreward-zh cron contract tests: $($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
