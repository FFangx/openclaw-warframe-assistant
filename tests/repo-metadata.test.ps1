# Contract tests for repository release-readiness metadata: version unification,
# package manifests, standard MIT license, third-party asset documentation and
# governance files. Plain PowerShell assertions (no Pester dependency).
#
# Locks the v1.1 release-prep decisions:
#   - VERSION is the single source of truth; skill/package.json and
#     extension/package.json versions must equal it (the extension is private,
#     never published, and ships in lockstep with the repo release).
#   - skill/package.json carries MIT, no dead "main", sharp only as an optional
#     dependency, and a reproducible lockfile resolved against the official npm
#     registry.
#   - LICENSE is the standard MIT text GitHub recognizes (no appended clauses);
#     asset/data exclusions live in NOTICE.md / ASSET-LICENSES.md.
#   - LICENSES/ retains the full Apache-2.0 text for genesis-assets-derived
#     icons plus a provenance/verification note (upstream URL, no-NOTICE finding).
#   - DE game assets obtained through the AlecaFrame channel are retained under
#     the DE non-commercial fan-content terms and honestly channel-noted.
#   - img/ contains only the six reviewed README showcases; superseded card-*.png
#     screenshots do not return.
#   - Governance files exist and contain no personal contact identifiers
#     (no emails, no QQ numbers), no SLA promises, and no fixed disclosure window.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$repoRoot = Split-Path -Parent $PSScriptRoot
$passed = 0

function Assert-True([string]$Label, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) { Write-Host "PASS: $Label"; $script:passed++ }
  else { throw "FAIL: $Label $Detail" }
}

function Read-File([string]$Relative) {
  $path = Join-Path $repoRoot $Relative
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing file: $Relative" }
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
}

# --- version unification ---
$version = (Read-File 'VERSION').Trim()
Assert-True 'VERSION is valid semver' ($version -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')

$skillPkg = Read-File 'skill\package.json' | ConvertFrom-Json
Assert-True 'skill package version equals VERSION' ([string]$skillPkg.version -eq $version)
Assert-True 'skill package license is MIT' ([string]$skillPkg.license -eq 'MIT')
Assert-True 'skill package has no dead main field' ($null -eq $skillPkg.PSObject.Properties['main'])
Assert-True 'sharp is optional, not required' (
  -not ($skillPkg.PSObject.Properties['dependencies']) -and
  [string]$skillPkg.optionalDependencies.sharp -eq '^0.35.3')
Assert-True 'skill package is private (not published)' ([bool]$skillPkg.private -eq $true)

$extensionPkg = Read-File 'extension\package.json' | ConvertFrom-Json
Assert-True 'extension package version equals VERSION (ships in lockstep)' ([string]$extensionPkg.version -eq $version)
Assert-True 'extension package is private' ([bool]$extensionPkg.private -eq $true)

$lockfileText = Read-File 'skill\package-lock.json'
Assert-True 'lockfile is resolved against the official npm registry' (-not ($lockfileText -match 'npmmirror|registry\.npmjs\.cn'))
# Windows PowerShell 5.1 ConvertFrom-Json cannot parse package-lock v3 (its
# JavaScriptSerializer rejects the empty-string root key "packages": {""}),
# so the root version is read through Node, which the project already
# requires and which both CI hosts provide.
$lockfilePath = Join-Path $repoRoot 'skill\package-lock.json'
$lockRootVersion = & node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(p.packages[''].version))" $lockfilePath
if ($LASTEXITCODE -ne 0) { throw "node failed to read lockfile root version: $lockRootVersion" }
Assert-True 'lockfile root version equals VERSION' (([string]$lockRootVersion).Trim() -eq $version)

# --- license ---
$expectedMit = @'
MIT License

Copyright (c) 2026 FFangx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'@
Assert-True 'LICENSE is the standard MIT text' (((Read-File 'LICENSE').TrimEnd("`r", "`n")) -eq $expectedMit.TrimEnd("`r", "`n"))

$notice = Read-File 'NOTICE.md'
Assert-True 'NOTICE excludes assets from MIT scope' ($notice.Contains('不属于 MIT 授权范围'))
Assert-True 'NOTICE states the DE non-official/non-endorsed position' ($notice.Contains('非官方') -and $notice.Contains('未获其背书'))
Assert-True 'NOTICE cites the DE content policy (non-commercial)' ($notice.Contains('non-commercial') -and $notice.Contains('contentpolicy'))
Assert-True 'NOTICE keeps the WFInfo Apache-2.0 component boundary' ($notice.Contains('Apache License 2.0') -and $notice.Contains('FFangx/WFinfo'))
Assert-True 'NOTICE points to the retained Apache-2.0 text under LICENSES/' $notice.Contains('LICENSES/')
Assert-True 'NOTICE no longer blocks DE assets on the AlecaFrame channel' (-not $notice.Contains('阻塞'))
Assert-True 'NOTICE records the channel without claiming AlecaFrame authorization' ($notice.Contains('渠道') -and $notice.Contains('不主张'))

$assetLicenses = Read-File 'ASSET-LICENSES.md'
Assert-True 'ASSET-LICENSES covers DE fan-content terms' ($assetLicenses.Contains('非商业'))
Assert-True 'ASSET-LICENSES classifies unverifiable sources as blockers' ($assetLicenses.Contains('阻塞'))
Assert-True 'ASSET-LICENSES documents genesis-assets provenance' ($assetLicenses.Contains('genesis-assets') -and $assetLicenses.Contains('Apache-2.0'))
Assert-True 'ASSET-LICENSES flags AlecaFrame-extracted assets' ($assetLicenses.Contains('AlecaFrame'))
Assert-True 'ASSET-LICENSES keeps the channel != rights-source principle' $assetLicenses.Contains('取得渠道 ≠ 权利来源')
Assert-True 'ASSET-LICENSES confirms no non-DE evidence for the four DE asset groups' $assetLicenses.Contains('未发现任何「非 DE 素材」的证据')
Assert-True 'ASSET-LICENSES no longer lists release blockers for DE assets' (-not ($assetLicenses -match '发布前阻塞'))
$showcaseFiles = @(
  'showcase-fissure-speed.png', 'showcase-bounty-aya.png', 'showcase-open-relic.png',
  'showcase-ducat-600.png', 'showcase-weekly.png', 'showcase-my-rivens.png'
)
foreach ($name in $showcaseFiles) {
  Assert-True "ASSET-LICENSES documents current showcase: $name" $assetLicenses.Contains($name)
  Assert-True "current showcase exists: $name" (Test-Path -LiteralPath (Join-Path $repoRoot "img\$name") -PathType Leaf)
}
Assert-True 'superseded card screenshots are absent' (
  @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'img') -Filter 'card-*.png' -File).Count -eq 0)

# --- LICENSES/ retention for genesis-assets-derived icons ---
$apacheText = Read-File 'LICENSES\Apache-2.0.txt'
Assert-True 'LICENSES retains the full Apache-2.0 text' (
  $apacheText.Contains('Apache License') -and
  $apacheText.Contains('Version 2.0, January 2004') -and
  $apacheText.Contains('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION') -and
  $apacheText.Contains('END OF TERMS AND CONDITIONS'))
$genesisLicenses = Read-File 'LICENSES\genesis-assets.md'
Assert-True 'LICENSES provenance note cites the upstream repository' ($genesisLicenses.Contains('github.com/WFCD/genesis-assets') -and $genesisLicenses.Contains('Apache-2.0'))
Assert-True 'LICENSES provenance note records the upstream no-NOTICE finding' $genesisLicenses.Contains('NOTICE')

# --- governance files exist ---
foreach ($file in @(
    'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md', 'CODEOWNERS',
    '.github\dependabot.yml', '.github\PULL_REQUEST_TEMPLATE.md',
    '.github\ISSUE_TEMPLATE\bug_report.yml', '.github\ISSUE_TEMPLATE\feature_request.yml',
    '.github\ISSUE_TEMPLATE\config.yml')) {
  Assert-True "governance file exists: $file" (Test-Path -LiteralPath (Join-Path $repoRoot $file) -PathType Leaf)
}

# --- governance content: no SLA, no personal contact identifiers ---
$governanceTexts = @('SECURITY.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md') | ForEach-Object { Read-File $_ }
$joined = $governanceTexts -join "`n"
Assert-True 'governance files promise no SLA' ($joined.Contains('SLA') -and -not $joined.Contains('24 小时内'))
Assert-True 'governance files contain no email addresses' (-not ($joined -match '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'))
Assert-True 'SECURITY.md directs to private vulnerability reporting' ((Read-File 'SECURITY.md').Contains('Report a vulnerability'))
Assert-True 'SECURITY.md promises no fixed disclosure window' ((Read-File 'SECURITY.md').Contains('不承诺任何固定的披露时间窗口') -and -not (Read-File 'SECURITY.md').Contains('90 天'))
Assert-True 'SUPPORT.md links SECURITY.md' ((Read-File 'SUPPORT.md').Contains('SECURITY.md'))
Assert-True 'CODEOWNERS assigns the repository owner' ((Read-File 'CODEOWNERS').Contains('@FFangx'))

# --- docs version drift ---
$installDoc = Read-File 'INSTALL.md'
Assert-True 'INSTALL.md states the current version' ($installDoc.Contains("当前 ``$version``"))

# --- release workflow stays reviewable ---
$releaseScript = Read-File 'release.ps1'
Assert-True 'release script reads prepared VERSION instead of mutating it through a parameter' (
  -not $releaseScript.Contains('[string]$Version') -and
  $releaseScript.Contains('$releaseVersion = Get-Version'))
Assert-True 'release docs require a prepared metadata commit' (
  $installDoc.Contains('版本准备') -and
  $installDoc.Contains('release.ps1 -DryRun') -and
  $installDoc.Contains('release.ps1 -Push') -and
  -not $installDoc.Contains('-Version X.Y.Z'))

# --- uninstall lifecycle is documented ---
$readme = Read-File 'README.md'
$englishReadme = Read-File 'README.en.md'
Assert-True 'Chinese README links the English overview' ($readme.Contains('[English](README.en.md)'))
Assert-True 'English README links the Chinese canonical documentation' (
  $englishReadme.Contains('[简体中文](README.md)') -and
  $englishReadme.Contains('This project is built for Simplified Chinese-speaking players'))
Assert-True 'README documents the uninstall lifecycle' ($readme.Contains('uninstall.ps1'))
Assert-True 'README does not hard-code an obsolete current version' (-not ($readme -match '当前 `\d+\.\d+\.\d+`'))
Assert-True 'README distinguishes Market v2 live data from v1 closed statistics' (
  $readme.Contains('warframe.market v2 商品/订单与 v1 历史成交统计') -and
  $readme.Contains('v1 历史成交统计'))
Assert-True 'README documents the shared user-facing error contract' (
  $readme.Contains('403/404/429') -and
  $readme.Contains('来源暂不可用') -and
  $readme.Contains('下一步命令') -and
  $readme.Contains('缓存结果不会冒充实时结果'))
Assert-True 'README does not claim one valuation basis for every non-wm workflow' (
  -not $readme.Contains('非 `wm` 估值统一') -and
  $readme.Contains('奸商商品路线则明确使用当前稳健低值作为决策价'))

# --- public runtime source disclosure ---
# Scan production URL literals only. QQ delivery endpoints and the repository URL used in
# User-Agent identification are transports/metadata rather than Warframe query sources.
# Every other host must first be classified here, then disclosed in both README and NOTICE.
$sourceDisclosure = @{
  'api.warframe.com'       = @{ Readme = 'DE 官方端点'; Notice = 'api.warframe.com' }
  'www-static.warframe.com'= @{ Readme = 'DE 官方端点'; Notice = 'www-static.warframe.com' }
  'api.warframestat.us'    = @{ Readme = 'api.warframestat.us'; Notice = 'api.warframestat.us' }
  'drops.warframestat.us'  = @{ Readme = 'api.warframestat.us'; Notice = 'drops.warframestat.us' }
  'api.warframe.market'    = @{ Readme = 'warframe.market'; Notice = 'api.warframe.market' }
  'warframe.market'        = @{ Readme = 'warframe.market'; Notice = 'warframe.market 静态资源' }
  'ws.warframe.market'     = @{ Readme = 'WebSocket'; Notice = 'ws.warframe.market' }
  'browse.wf'              = @{ Readme = 'browse.wf 社区镜像'; Notice = 'browse.wf' }
  'oracle.browse.wf'       = @{ Readme = 'browse.wf 社区镜像'; Notice = 'oracle.browse.wf' }
  'cdn.alecaframe.com'     = @{ Readme = 'cdn.alecaframe.com'; Notice = 'cdn.alecaframe.com' }
  'relics.run'             = @{ Readme = 'relics.run'; Notice = 'relics.run' }
  'raw.githubusercontent.com' = @{ Readme = 'raw.githubusercontent.com'; Notice = 'raw.githubusercontent.com' }
}
$nonDataHosts = @('api.sgroup.qq.com', 'bots.qq.com', 'github.com')
$productionFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'skill\scripts') -Recurse -File -Include '*.mjs', '*.cjs' |
    Where-Object { $_.Name -notmatch '\.test\.' }
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'extension') -Recurse -File -Include '*.mjs', '*.cjs' |
    Where-Object { $_.Name -notmatch '\.test\.' }
)
$runtimeHosts = @($productionFiles | ForEach-Object {
  [regex]::Matches((Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8), '(?:https?|wss)://([A-Za-z0-9.-]+)') |
    ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() }
} | Sort-Object -Unique)
foreach ($hostName in $runtimeHosts) {
  if ($nonDataHosts -contains $hostName) { continue }
  Assert-True "runtime source host is classified: $hostName" $sourceDisclosure.ContainsKey($hostName)
  if ($sourceDisclosure.ContainsKey($hostName)) {
    Assert-True "README discloses runtime source host: $hostName" $readme.Contains($sourceDisclosure[$hostName].Readme)
    Assert-True "NOTICE discloses runtime source host: $hostName" $notice.Contains($sourceDisclosure[$hostName].Notice)
  }
}

Write-Host "`nrepo metadata contract tests: $passed passed"
