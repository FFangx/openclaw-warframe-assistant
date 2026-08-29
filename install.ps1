[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Workspace = $(if ($env:OPENCLAW_WORKSPACE) { $env:OPENCLAW_WORKSPACE } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.openclaw\workspace' } else { '' }),
  [switch]$SkipAgents,
  [switch]$AgentsOnly,
  [switch]$RemoveAgents,
  [switch]$SkipPreflight,
  [switch]$SkipCron,
  [switch]$WithWFInfo,
  [string]$WFInfoInstallDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Workspace) { throw 'Cannot resolve OpenClaw workspace. Pass -Workspace explicitly.' }
if ($SkipAgents -and ($AgentsOnly -or $RemoveAgents)) { throw '-SkipAgents cannot be combined with -AgentsOnly or -RemoveAgents.' }
if ($AgentsOnly -and $RemoveAgents) { throw '-AgentsOnly cannot be combined with -RemoveAgents.' }
if ($AgentsOnly -and $WithWFInfo) { throw '-AgentsOnly cannot be combined with -WithWFInfo.' }

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspacePath = [IO.Path]::GetFullPath($Workspace)
$fragmentPath = Join-Path $repoRoot 'config\AGENTS.warframe.md'
$agentsPath = Join-Path $workspacePath 'AGENTS.md'
$beginMarker = '<!-- BEGIN openclaw-warframe-assistant -->'
$endMarker = '<!-- END openclaw-warframe-assistant -->'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifestName = '.warframe-assistant-managed.json'
$buildInfoName = '.warframe-assistant-build.json'

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

function Get-RelativePath([string]$Root, [string]$Path) {
  return $Path.Substring($Root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
}

function Get-ManagedFileList([string]$Source) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Install source does not exist: $Source" }
  return @(Get-ChildItem -LiteralPath $Source -Recurse -Force -File | Where-Object {
    $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
    $_.Name -notin @($manifestName, $buildInfoName)
  } | ForEach-Object {
    [pscustomobject]@{
      path = Get-RelativePath $Source $_.FullName
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    }
  } | Sort-Object path)
}

function Get-BuildInfo {
  $commit = 'unknown'
  $dirty = $false
  try {
    $commit = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
    $dirty = [bool](& git -C $repoRoot status --porcelain 2>$null)
  } catch { }
  $version = 'unknown'
  $versionPath = Join-Path $repoRoot 'VERSION'
  if (Test-Path -LiteralPath $versionPath -PathType Leaf) { $version = (Read-Utf8 $versionPath).Trim() }
  $contentLines = New-Object System.Collections.Generic.List[string]
  foreach ($tree in @('skill', 'extension')) {
    foreach ($file in (Get-ManagedFileList (Join-Path $repoRoot $tree))) { $contentLines.Add("$tree/$($file.path):$($file.sha256)") }
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $contentBytes = [Text.Encoding]::UTF8.GetBytes(($contentLines -join "`n"))
    $contentHash = ([BitConverter]::ToString($sha.ComputeHash($contentBytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
  return [ordered]@{
    schemaVersion = 1
    version = $version
    commit = $commit
    dirty = $dirty
    contentHash = $contentHash
    installedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Read-ManagedManifest([string]$Destination) {
  $path = Join-Path $Destination $manifestName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { return (Read-Utf8 $path | ConvertFrom-Json) }
  catch { throw "Managed manifest is invalid: $path" }
}

function Find-BootstrapLegacyFiles([string]$Destination, [string]$TreeName, [string[]]$CurrentPaths) {
  if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { return @() }
  $current = @{}; foreach ($path in $CurrentPaths) { $current[$path.ToLowerInvariant()] = $true }
  return @(Get-ChildItem -LiteralPath $Destination -Recurse -Force -File | Where-Object {
    $relative = Get-RelativePath $Destination $_.FullName
    if ($relative -match '^(node_modules|\.git)(/|$)' -or $_.Name -in @('package-lock.json', $manifestName, $buildInfoName)) { return $false }
    if ($current.ContainsKey($relative.ToLowerInvariant())) { return $false }
    return ($_.Name -like '*.bak' -or $_.Name -like '*.pre-*' -or
      $relative -match '^docs/' -or $relative -eq 'deal-tiers.txt' -or
      ($TreeName -eq 'skill' -and $relative -match '^scripts/.*\.(mjs|cjs|js)$') -or
      ($TreeName -eq 'extension' -and $relative -match '\.(mjs|cjs|js|ts)$'))
  } | ForEach-Object { Get-RelativePath $Destination $_.FullName })
}

function Sync-ManagedTree([string]$Source, [string]$Destination, [string]$TreeName, $BuildInfo) {
  $sourcePath = [IO.Path]::GetFullPath($Source)
  $destinationPath = [IO.Path]::GetFullPath($Destination)
  $destinationParent = Split-Path -Parent $destinationPath
  $stage = Join-Path $destinationParent ('.warframe-stage-' + $TreeName + '-' + [guid]::NewGuid().ToString('N'))
  $backupRoot = Join-Path $workspacePath ('.openclaw\warframe-assistant-deploy-backups\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + $TreeName)
  $files = Get-ManagedFileList $sourcePath
  $oldManifest = Read-ManagedManifest $destinationPath
  $oldPaths = @()
  if ($oldManifest -and $oldManifest.files) { $oldPaths = @($oldManifest.files | ForEach-Object { [string]$_.path }) }
  $currentPaths = @($files | ForEach-Object { [string]$_.path })
  $currentSet = @{}; foreach ($path in $currentPaths) { $currentSet[$path.ToLowerInvariant()] = $true }
  $stalePaths = @($oldPaths | Where-Object { -not $currentSet.ContainsKey($_.ToLowerInvariant()) })
  if (-not $oldManifest) { $stalePaths += Find-BootstrapLegacyFiles $destinationPath $TreeName $currentPaths }
  $stalePaths = @($stalePaths | Sort-Object -Unique)
  $replacedPaths = New-Object System.Collections.Generic.List[string]
  $createdPaths = New-Object System.Collections.Generic.List[string]
  $movedStalePaths = New-Object System.Collections.Generic.List[string]

  try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($file in $files) {
      $sourceFile = Join-Path $sourcePath ($file.path.Replace('/', '\'))
      $stageFile = Join-Path $stage ($file.path.Replace('/', '\'))
      $stageParent = Split-Path -Parent $stageFile
      if (-not (Test-Path -LiteralPath $stageParent)) { New-Item -ItemType Directory -Path $stageParent -Force | Out-Null }
      Copy-Item -LiteralPath $sourceFile -Destination $stageFile -Force
      $stageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stageFile).Hash.ToLowerInvariant()
      if ($stageHash -ne $file.sha256) { throw "Staging hash mismatch: $($file.path)" }
    }

    if (-not (Test-Path -LiteralPath $destinationPath)) { New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null }
    foreach ($relative in $stalePaths) {
      $target = [IO.Path]::GetFullPath((Join-Path $destinationPath ($relative.Replace('/', '\'))))
      if (-not $target.StartsWith($destinationPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe stale path: $relative" }
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $backup = Join-Path $backupRoot ('stale\' + $relative.Replace('/', '\'))
        $backupParent = Split-Path -Parent $backup
        if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
        Move-Item -LiteralPath $target -Destination $backup -Force
        $movedStalePaths.Add($relative)
      }
    }

    foreach ($file in $files) {
      $stageFile = Join-Path $stage ($file.path.Replace('/', '\'))
      $target = Join-Path $destinationPath ($file.path.Replace('/', '\'))
      $targetParent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
      $needsCopy = $true
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
        $needsCopy = $targetHash -ne $file.sha256
      }
      if ($needsCopy) {
        if (Test-Path -LiteralPath $target -PathType Leaf) {
          $backup = Join-Path $backupRoot ('replaced\' + $file.path.Replace('/', '\'))
          $backupParent = Split-Path -Parent $backup
          if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
          Copy-Item -LiteralPath $target -Destination $backup -Force
          $replacedPaths.Add($file.path)
        } else { $createdPaths.Add($file.path) }
        $tempTarget = Join-Path $targetParent ('.warframe-copy-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Copy-Item -LiteralPath $stageFile -Destination $tempTarget -Force
        Move-Item -LiteralPath $tempTarget -Destination $target -Force
      }
    }

    foreach ($file in $files) {
      $target = Join-Path $destinationPath ($file.path.Replace('/', '\'))
      if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Installed file missing: $($file.path)" }
      $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
      if ($targetHash -ne $file.sha256) { throw "Installed hash mismatch: $($file.path)" }
    }

    foreach ($metadataName in @($manifestName, $buildInfoName)) {
      $metadataPath = Join-Path $destinationPath $metadataName
      if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        $metadataBackup = Join-Path $backupRoot ('metadata\' + $metadataName)
        $metadataParent = Split-Path -Parent $metadataBackup
        if (-not (Test-Path -LiteralPath $metadataParent)) { New-Item -ItemType Directory -Path $metadataParent -Force | Out-Null }
        Copy-Item -LiteralPath $metadataPath -Destination $metadataBackup -Force
      }
    }
    $manifest = [ordered]@{ schemaVersion = 1; tree = $TreeName; build = $BuildInfo; files = $files }
    Write-Utf8Atomic (Join-Path $destinationPath $manifestName) (($manifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
    Write-Utf8Atomic (Join-Path $destinationPath $buildInfoName) (($BuildInfo | ConvertTo-Json -Depth 4) + [Environment]::NewLine)
    Write-Host "Verified $TreeName deployment: $($files.Count) managed files, $($stalePaths.Count) stale files quarantined."
    if ($stalePaths.Count -gt 0) { Write-Host "Recoverable backup: $backupRoot" }
  } catch {
    $originalError = $_
    foreach ($relative in $createdPaths) {
      $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
      if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    foreach ($relative in $replacedPaths) {
      $backup = Join-Path $backupRoot ('replaced\' + $relative.Replace('/', '\'))
      $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
      if (Test-Path -LiteralPath $backup -PathType Leaf) { Copy-Item -LiteralPath $backup -Destination $target -Force }
    }
    foreach ($relative in $movedStalePaths) {
      $backup = Join-Path $backupRoot ('stale\' + $relative.Replace('/', '\'))
      $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
      $targetParent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
      if (Test-Path -LiteralPath $backup -PathType Leaf) { Move-Item -LiteralPath $backup -Destination $target -Force }
    }
    foreach ($metadataName in @($manifestName, $buildInfoName)) {
      $metadataBackup = Join-Path $backupRoot ('metadata\' + $metadataName)
      $metadataPath = Join-Path $destinationPath $metadataName
      if (Test-Path -LiteralPath $metadataBackup -PathType Leaf) { Copy-Item -LiteralPath $metadataBackup -Destination $metadataPath -Force }
    }
    throw $originalError
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}

# ————————————————————————————————————————————————
# 每日「奖励译名 AI 查证」任务合同（config/cron/reward-zh-ai.job.json）
#
# 该任务是 agent 型 cron（查证需要网页搜索与判断）。本函数幂等安装/修复：
# 按 declarationKey 找现有任务，缺则创建、合同字段漂移则 edit 修复。
# 该任务只维护本地学习词典，必须强制 delivery=none；升级会清理旧 channel/to，
# 防止 agent 的计划、进度或最终摘要泄漏到 QQ。
# 只在「真实 OpenClaw 工作区」执行：工作区旁没有 openclaw.json（如安装器
# 生命周期测试的临时工作区）或 openclaw.cmd 不在 PATH 时直接跳过，
# 避免测试过程触碰真实 cron 存储。
# ————————————————————————————————————————————————
function Get-CliJson([string[]]$Arguments) {
  # openclaw.cmd 可能向 stderr 打良性配置警告（如允许列表提示）；PS5.1 + EAP=Stop 下
  # 原生 stderr 即使 2>$null 也会变成 NativeCommandError 中止流程（与 release.ps1 的
  # Invoke-Git 同款问题），故调用期间临时降级 EAP，成败以退出码为准，stderr 细节丢弃。
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $stdout = & openclaw.cmd @Arguments 2>$null
  } finally {
    $ErrorActionPreference = $previousEap
  }
  if ($LASTEXITCODE -ne 0) { throw "openclaw $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  $text = ($stdout -join "`n")
  $start = $text.IndexOfAny([char[]]('[', '{'))
  if ($start -lt 0) { throw "openclaw $($Arguments -join ' ') produced no JSON output" }
  return $text.Substring($start) | ConvertFrom-Json
}

function Get-JobField($Job, [string]$Camel, [string]$Snake) {
  if ($null -eq $Job) { return $null }
  $names = @($Job.PSObject.Properties.Name)
  if ($names -contains $Camel) { return $Job.$Camel }
  if ($names -contains $Snake) { return $Job.$Snake }
  return $null
}

function Ensure-RewardZhCronContract {
  if ($SkipCron) { Write-Host 'Skipping reward-zh AI cron contract (-SkipCron).'; return }
  $openClawJson = Join-Path (Split-Path -Parent $workspacePath) 'openclaw.json'
  if (-not (Test-Path -LiteralPath $openClawJson -PathType Leaf)) {
    Write-Host 'No openclaw.json beside the workspace; skipping cron contract (non-runtime workspace).'
    return
  }
  if (-not (Get-Command 'openclaw.cmd' -ErrorAction SilentlyContinue)) {
    Write-Host 'openclaw.cmd not found on PATH; skipping cron contract.'
    return
  }
  $jobPath = Join-Path $repoRoot 'config\cron\reward-zh-ai.job.json'
  if (-not (Test-Path -LiteralPath $jobPath -PathType Leaf)) { throw "Cron contract file missing: $jobPath" }
  $job = Read-Utf8 $jobPath | ConvertFrom-Json
  $declarationKey = [string]$job.declarationKey
  $scriptsDir = (Join-Path $workspacePath 'skills\warframe-assistant\scripts').Replace('\', '/')
  $expectedMessage = ([string]$job.payload.message).Replace('{{SKILL_SCRIPTS_DIR}}', $scriptsDir)
  if ($expectedMessage.Contains('{{')) { throw "Cron contract placeholders unresolved in: $jobPath" }
  $all = @()
  $jobs = Get-CliJson @('cron', 'list', '--json')
  try {
    if ($null -ne $jobs.jobs) { $all = @($jobs.jobs) }
  } catch { }
  if ($all.Count -eq 0 -and $jobs -is [System.Array]) { $all = @($jobs) }
  $existing = @($all | Where-Object { [string](Get-JobField $_ 'declarationKey' 'declaration_key') -eq $declarationKey })

  if ($existing.Count -eq 0) {
    $addArgs = @(
      'cron', 'add',
      '--declaration-key', $declarationKey,
      '--name', [string]$job.name,
      '--description', [string]$job.description,
      '--every', '24h', '--exact',
      '--session', [string]$job.sessionTarget,
      '--message', $expectedMessage,
      '--timeout-seconds', [string]$job.payload.timeoutSeconds,
      '--no-deliver',
      '--json'
    )
    if ($PSCmdlet.ShouldProcess($declarationKey, 'Create reward-zh AI cron job')) {
      Get-CliJson $addArgs | Out-Null
      Write-Host "Created cron job $declarationKey"
    }
    return
  }

  $jobId = [string](Get-JobField $existing[0] 'id' 'job_id')
  if (-not $jobId) { throw "Existing $declarationKey job has no id" }
  $current = Get-CliJson @('cron', 'get', $jobId)
  $patch = New-Object System.Collections.Generic.List[string]

  $enabled = Get-JobField $current 'enabled' 'enabled'
  if ($null -ne $enabled -and -not $enabled) { $patch.Add('--enable') }

  $schedule = Get-JobField $current 'schedule' 'schedule'
  $everyMs = 0
  if ($null -ne $schedule) {
    $everyValue = Get-JobField $schedule 'everyMs' 'every_ms'
    if ($null -ne $everyValue) { $everyMs = [int64]$everyValue }
  }
  if ($everyMs -ne 86400000) { $patch.Add('--every'); $patch.Add('24h'); $patch.Add('--exact') }

  $payload = Get-JobField $current 'payload' 'payload'
  $currentMessage = $null
  if ($null -ne $payload) { $currentMessage = [string](Get-JobField $payload 'message' 'message') }
  if ($null -eq $currentMessage -or $currentMessage -cne $expectedMessage) { $patch.Add('--message'); $patch.Add($expectedMessage) }

  if ([string](Get-JobField $current 'name' 'name') -cne [string]$job.name) { $patch.Add('--name'); $patch.Add([string]$job.name) }
  if ([string](Get-JobField $current 'description' 'description') -cne [string]$job.description) { $patch.Add('--description'); $patch.Add([string]$job.description) }
  if ([string](Get-JobField $current 'sessionTarget' 'session_target') -ne [string]$job.sessionTarget) { $patch.Add('--session'); $patch.Add([string]$job.sessionTarget) }

  # 纯后台维护任务永不投递；升级时清理历史 announce/channel/to 配置。
  $delivery = Get-JobField $current 'delivery' 'delivery'
  $deliveryMode = $null
  $deliveryTo = $null
  $deliveryChannel = $null
  $deliveryBestEffort = $false
  if ($null -ne $delivery) {
    $deliveryMode = [string](Get-JobField $delivery 'mode' 'mode')
    $deliveryTo = [string](Get-JobField $delivery 'to' 'to')
    $deliveryChannel = [string](Get-JobField $delivery 'channel' 'channel')
    $bestEffortValue = Get-JobField $delivery 'bestEffort' 'best_effort'
    if ($null -ne $bestEffortValue) { $deliveryBestEffort = [bool]$bestEffortValue }
  }
  if ($deliveryMode -ne 'none' -or $deliveryTo -or $deliveryChannel -or $deliveryBestEffort) {
    $patch.Add('--no-deliver'); $patch.Add('--clear-channel'); $patch.Add('--clear-to'); $patch.Add('--no-best-effort-deliver')
  }

  if ($patch.Count -gt 0) {
    if ($PSCmdlet.ShouldProcess($jobId, 'Repair reward-zh AI cron contract fields')) {
      $editArgs = @('cron', 'edit', $jobId) + @($patch)
      Get-CliJson $editArgs | Out-Null
      Write-Host "Repaired cron job $jobId ($declarationKey): $($patch -join ' ')"
    }
  } else {
    Write-Host "Reward-zh AI cron contract already current: $jobId"
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
  if (-not $SkipPreflight -and -not $WhatIfPreference) {
    & (Join-Path $repoRoot 'verify.ps1') -SourceOnly -SkipDoctor -SkipPluginDoctor -SkipInstallerTest
    if ($LASTEXITCODE -ne 0) { throw 'Preflight verification failed; deployment was not changed.' }
  }
  $buildInfo = Get-BuildInfo
  if ($PSCmdlet.ShouldProcess($skillTarget, 'Install or update and verify Warframe skill')) { Sync-ManagedTree (Join-Path $repoRoot 'skill') $skillTarget 'skill' $buildInfo }
  if ($PSCmdlet.ShouldProcess($extensionTarget, 'Install or update and verify Warframe plugin')) { Sync-ManagedTree (Join-Path $repoRoot 'extension') $extensionTarget 'extension' $buildInfo }
  if ($PSCmdlet.ShouldProcess($workspacePath, 'Ensure reward-zh AI cron contract')) { Ensure-RewardZhCronContract }
  if (-not $WhatIfPreference) { Write-Host "Skill and plugin synchronized to: $workspacePath" }
}

if (-not $SkipAgents) { Merge-AgentsBlock }
if ($WithWFInfo) {
  $wfInfoArgs = @()
  if ($WFInfoInstallDir) { $wfInfoArgs += @('-InstallDir', $WFInfoInstallDir) }
  if ($WhatIfPreference) { $wfInfoArgs += '-WhatIf' }
  & (Join-Path $repoRoot 'install-wfinfo.ps1') @wfInfoArgs
}
if ($WhatIfPreference) { Write-Host 'Preview complete. No files were changed.' }
else { Write-Host 'Install complete. Run: openclaw.cmd gateway restart' }
