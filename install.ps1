[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Workspace = $(if ($env:OPENCLAW_WORKSPACE) { $env:OPENCLAW_WORKSPACE } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.openclaw\workspace' } else { '' }),
  [switch]$SkipAgents,
  [switch]$AgentsOnly,
  [switch]$RemoveAgents
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Workspace) { throw 'Cannot resolve OpenClaw workspace. Pass -Workspace explicitly.' }
if ($SkipAgents -and ($AgentsOnly -or $RemoveAgents)) { throw '-SkipAgents cannot be combined with -AgentsOnly or -RemoveAgents.' }
if ($AgentsOnly -and $RemoveAgents) { throw '-AgentsOnly cannot be combined with -RemoveAgents.' }

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspacePath = [IO.Path]::GetFullPath($Workspace)
$fragmentPath = Join-Path $repoRoot 'config\AGENTS.warframe.md'
$agentsPath = Join-Path $workspacePath 'AGENTS.md'
$beginMarker = '<!-- BEGIN openclaw-warframe-assistant -->'
$endMarker = '<!-- END openclaw-warframe-assistant -->'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$Path) {
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-Utf8Atomic([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $temp = Join-Path $parent ('.warframe-install-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temp, $Content, $utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Copy-Tree([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Install source does not exist: $Source" }
  if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Merge-AgentsBlock([switch]$Remove) {
  if (-not (Test-Path -LiteralPath $fragmentPath -PathType Leaf)) { throw "AGENTS fragment does not exist: $fragmentPath" }
  $fragment = (Read-Utf8 $fragmentPath).Trim()
  if (-not ($fragment.Contains($beginMarker) -and $fragment.Contains($endMarker))) { throw 'AGENTS fragment is missing managed markers.' }
  $current = if (Test-Path -LiteralPath $agentsPath -PathType Leaf) { Read-Utf8 $agentsPath } else { '' }
  $pattern = [regex]::Escape($beginMarker) + '(?s:.*?)' + [regex]::Escape($endMarker)
  $hasBlock = [regex]::IsMatch($current, $pattern)

  if ($Remove) {
    if (-not $hasBlock) { Write-Host 'No managed Warframe block found in AGENTS.md.'; return }
    $updated = [regex]::Replace($current, $pattern, '').TrimEnd() + [Environment]::NewLine
    $action = 'Remove managed Warframe safety block'
  } elseif ($hasBlock) {
    $updated = [regex]::Replace($current, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $fragment })
    $action = 'Update managed Warframe safety block'
  } else {
    $prefix = $current.TrimEnd()
    $updated = $(if ($prefix) { $prefix + [Environment]::NewLine + [Environment]::NewLine } else { '' }) + $fragment + [Environment]::NewLine
    $action = 'Append managed Warframe safety block'
  }

  if ($updated -ceq $current) { Write-Host 'The managed Warframe block is already current.'; return }
  if ($PSCmdlet.ShouldProcess($agentsPath, $action)) {
    if (Test-Path -LiteralPath $agentsPath -PathType Leaf) { Copy-Item -LiteralPath $agentsPath -Destination "$agentsPath.warframe-assistant.bak" -Force }
    Write-Utf8Atomic $agentsPath $updated
    Write-Host "$action`: $agentsPath"
  }
}

if ($RemoveAgents) {
  Merge-AgentsBlock -Remove
  return
}

if (-not $AgentsOnly) {
  $skillTarget = Join-Path $workspacePath 'skills\warframe-assistant'
  $extensionTarget = Join-Path $workspacePath '.openclaw\extensions\warframe-fast-commands'
  if ($PSCmdlet.ShouldProcess($skillTarget, 'Install or update Warframe skill')) { Copy-Tree (Join-Path $repoRoot 'skill') $skillTarget }
  if ($PSCmdlet.ShouldProcess($extensionTarget, 'Install or update Warframe plugin')) { Copy-Tree (Join-Path $repoRoot 'extension') $extensionTarget }
  Write-Host "Skill and plugin synchronized to: $workspacePath"
}

if (-not $SkipAgents) { Merge-AgentsBlock }
Write-Host 'Install complete. Run: openclaw gateway restart'
