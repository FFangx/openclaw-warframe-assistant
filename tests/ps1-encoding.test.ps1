# Contract test: every .ps1 file in the repository must be UTF-8 with BOM.
# Plain PowerShell assertions (no Pester dependency).
#
# Why this matters (2026-08-23 rehearsal, Windows PowerShell 5.1 on a
# zh-CN / ACP=936 machine):
#   - BOM-less UTF-8 .ps1 files are decoded by PowerShell 5.1 with the system
#     ANSI codepage (e.g. 936, 932). Multi-byte decodes swallow ASCII bytes —
#     quotes, parentheses and even CR/LF — that follow non-ASCII text, which
#     either breaks parsing outright or silently merges code lines into a
#     comment and changes runtime behavior (real case: uninstall.ps1's
#     "$stamp = ..." assignment disappeared, exploding on first use).
#   - PowerShell 7 (and CI hosts on en-US / CP1252) never reproduce this:
#     the decode accepts every byte single-handedly, so a green PS7 CI does
#     not prove stock-Windows installability.
#   - The fix must live in the repository bytes: a UTF-8 BOM forces PS5.1 to
#     decode as UTF-8 regardless of the machine codepage.
# This check is byte-level, so it runs identically under PS5.1 and PS7 and on
# any locale, and it fails the first .ps1 committed without a BOM.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$passed = 0

function Assert-True([string]$Label, [bool]$Condition) {
  if (-not $Condition) { throw $Label }
  $script:passed++
  Write-Host "PASS: $Label"
}

# Only repository-authored scripts are checked: third-party shims under
# node_modules (e.g. semver.ps1 created by npm ci) are not ours and must not
# fail the contract.
$files = @(Get-ChildItem -LiteralPath $repoRoot -Recurse -Filter '*.ps1' -File | Where-Object {
  $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.FullName -notmatch '[\\/]\.git[\\/]'
})
Assert-True "repo contains at least one ps1 file (found $($files.Count))" ($files.Count -gt 0)

$missing = @()
foreach ($file in $files) {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if (-not $hasBom) {
    $missing += $file.FullName.Substring($repoRoot.Length + 1).Replace('\', '/')
  }
}

if ($missing.Count -gt 0) {
  throw "missing UTF-8 BOM on $($missing.Count) ps1 file(s): $($missing -join ', ') — Windows PowerShell 5.1 on multi-byte ANSI codepages will misparse them; add the BOM (EF BB BF)."
}

Write-Host "ps1 encoding contract: $($files.Count) ps1 files carry UTF-8 BOM (PowerShell 5.1-safe on any codepage)"
