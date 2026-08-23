# Environment smoke test for the OpenClaw Warframe assistant installer.
# Intended to run on a fresh Windows 10/11 machine (or a VM snapshot) to prove
# that a new user can install and use the assistant exactly per INSTALL.md.
# Safe by construction: installs into the given workspace only (default: a
# unique TEMP directory next to no openclaw.json, so the cron contract step
# skips), never touches the real OpenClaw workspace, never modifies the repo.
# Runs under Windows PowerShell 5.1 and 7. Exit code 0 = all PASS (WARN ok).
#
# Usage (Win10/11, PowerShell 5.1 or 7):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\env-smoke.ps1
# Optional:
#   -Repo "C:\path\to\repo"      use an existing clone instead of cloning
#   -Workspace "D:\smoke-ws"     install target (default: TEMP unique dir)
#   -GitUrl <url>                clone source (default: origin URL)
#   -SkipDoctor                  skip the environment doctor stage
param(
  [string]$GitUrl = 'https://github.com/FFangx/openclaw-warframe-assistant.git',
  [string]$Repo = '',
  [string]$Workspace = '',
  [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$script:results = New-Object System.Collections.Generic.List[string]
$script:warnings = New-Object System.Collections.Generic.List[string]
$script:failures = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Label) {
  Write-Host ""
  Write-Host "== $Label =="
}

function Record-Pass([string]$Label) { $script:results.Add($Label) }
function Record-Warn([string]$Label) { $script:warnings.Add($Label); Write-Host "WARN: $Label" -ForegroundColor Yellow }
function Record-Fail([string]$Label) { $script:failures.Add($Label); Write-Host "FAIL: $Label" -ForegroundColor Red }

function Invoke-Checked([string]$Label, [scriptblock]$Action, [bool]$WarnOnFailure = $false) {
  Write-Host "STEP: $Label"
  try {
    & $Action
    Record-Pass $Label
  } catch {
    if ($WarnOnFailure) { Record-Warn "$Label — $($_.Exception.Message)" }
    else { Record-Fail "$Label — $($_.Exception.Message)" }
  }
}

function Get-EdgeOrChrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

# ---------------------------------------------------------------- stage 0: toolchain
Write-Step "Stage 0: toolchain"
$psVersion = $PSVersionTable.PSVersion.ToString()
$nodeVersion = (& node --version 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { Record-Fail "node not found or failed (node --version)" }
else { Write-Host "node $nodeVersion"; $nodeMajor = [int](($nodeVersion.Trim().TrimStart('v') -split '\.')[0]); if ($nodeMajor -lt 20) { Record-Fail "node $nodeVersion is below the required 20+" } }
$gitVersion = (& git --version 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $gitVersion) { Record-Fail "git not found (git --version)" } else { Write-Host $gitVersion }
$browser = Get-EdgeOrChrome
if ($browser) { Write-Host "browser: $browser" } else { Record-Warn 'Edge/Chrome not found in standard paths; card rendering will fail until WARFRAME_BROWSER points at one' }
if ($script:failures.Count -gt 0) { throw 'toolchain prerequisites failed; see FAIL entries' }
Write-Host "PowerShell $psVersion / Node $nodeVersion / git $gitVersion"

# ---------------------------------------------------------------- stage 1: repo clone
Write-Step "Stage 1: repository"
$repoPath = ''
if ($Repo) {
  $repoPath = [IO.Path]::GetFullPath($Repo)
  if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'install.ps1') -PathType Leaf)) { throw "-Repo does not contain install.ps1: $repoPath" }
  Write-Host "using existing repo: $repoPath"
} else {
  $repoPath = Join-Path ([IO.Path]::GetTempPath()) ('wf-env-smoke-repo-' + [guid]::NewGuid().ToString('N'))
  Invoke-Checked "git clone $GitUrl -> $repoPath" {
    & git clone -q $GitUrl $repoPath
    if ($LASTEXITCODE -ne 0) { throw "git clone failed ($LASTEXITCODE)" }
  }
}

# ---------------------------------------------------------------- stage 2: new-user install
Write-Step "Stage 2: install.ps1 (new-user path, Windows PowerShell preflight)"
$workspacePath = $Workspace
if (-not $workspacePath) { $workspacePath = Join-Path ([IO.Path]::GetTempPath()) ('wf-env-smoke-ws-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null
Invoke-Checked "install.ps1 -Workspace $workspacePath" {
  & (Join-Path $repoPath 'install.ps1') -Workspace $workspacePath
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed ($LASTEXITCODE)" }
}

# ---------------------------------------------------------------- stage 3: full source verify
Write-Step 'Stage 3: verify.ps1 -SourceOnly'
Invoke-Checked 'verify.ps1 -SourceOnly (source tests + contracts + installer lifecycle)' {
  & (Join-Path $repoPath 'verify.ps1') -SourceOnly
  if ($LASTEXITCODE -ne 0) { throw "verify.ps1 -SourceOnly failed ($LASTEXITCODE)" }
}

# ---------------------------------------------------------------- stage 4: installed runtime smoke
Write-Step 'Stage 4: installed runtime smoke (deterministic entry + card render)'
$skillDir = Join-Path $workspacePath 'skills\warframe-assistant'
$dispatch = Join-Path $skillDir 'scripts\dispatch.mjs'
Invoke-Checked 'dispatch list (command catalog)' {
  & node $dispatch list | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "dispatch list failed ($LASTEXITCODE)" }
}
Invoke-Checked 'dispatch run help (help card rendered from installed skill)' {
  $raw = & node $dispatch run help 2>&1
  if ($LASTEXITCODE -ne 0) { throw "dispatch run help failed ($LASTEXITCODE)" }
  $json = ($raw -join "`n") | ConvertFrom-Json
  if (-not $json.ok -or -not $json.handled -or -not $json.mediaUrl) { throw 'help result did not carry ok/handled/mediaUrl' }
  if (-not (Test-Path -LiteralPath $json.mediaUrl -PathType Leaf)) { throw "help card file missing: $($json.mediaUrl)" }
  Write-Host "help card: $($json.mediaUrl)"
}

# ---------------------------------------------------------------- stage 5: environment doctor
if (-not $SkipDoctor) {
  Write-Step 'Stage 5: environment doctor (informational; WARN only)'
  $doctor = Join-Path $skillDir 'scripts\doctor.mjs'
  Invoke-Checked 'doctor.mjs' {
    & node $doctor
    if ($LASTEXITCODE -ne 0) { throw "doctor exited $LASTEXITCODE (check ❌ items: network/browser/AlecaFrame/OpenClaw are machine-specific)" }
  } $true
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "════════ env-smoke summary ════════"
Write-Host "OS          : $((Get-CimInstance Win32_OperatingSystem).Caption)"
Write-Host "PowerShell  : $psVersion"
Write-Host "Node        : $nodeVersion"
Write-Host "Repo        : $repoPath"
Write-Host "Workspace   : $workspacePath"
Write-Host "PASS        : $($script:results.Count)"
Write-Host "WARN        : $($script:warnings.Count)"
Write-Host "FAIL        : $($script:failures.Count)"
if ($script:warnings.Count -gt 0) { Write-Host 'Warnings:'; foreach ($w in $script:warnings) { Write-Host "  - $w" } }
if ($script:failures.Count -gt 0) { Write-Host 'Failures:'; foreach ($f in $script:failures) { Write-Host "  - $f" } }
if ($script:failures.Count -gt 0) { exit 1 }
Write-Host 'All smoke steps passed.' -ForegroundColor Green
