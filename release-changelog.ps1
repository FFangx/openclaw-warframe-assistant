# Changelog transformation shared by release.ps1 and tests/release-changelog.test.ps1.
#
# Convention (Keep a Changelog + versioned pending section):
#   ## [Unreleased]           # canonical EMPTY placeholder, must stay the top section
#   ## [1.1.0]                # pending release section; new entries go here
#   ## [1.0.0] - 2026-08-17   # released sections carry a date
#
# On release, ConvertTo-ReleasedChangelog stamps the release date onto the pending
# section matching the version being released and leaves the [Unreleased]
# placeholder untouched. It refuses to run whenever the file could end up with
# duplicate or misattributed sections: the 2026-08-17 v1.0.0 release produced two
# [Unreleased] and two [1.0.0] sections, and these guards exist so that structure
# cannot be re-created. Beyond the target version, every semver level-2 heading —
# bare "## [X.Y.Z]" or dated "## [X.Y.Z] - yyyy-mm-dd", historical versions
# included — must appear at most once.

function ConvertTo-ReleasedChangelog {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$ReleaseVersion,
    [string]$Date = (Get-Date).ToString('yyyy-MM-dd')
  )
  $normalized = $Text.Replace("`r`n", "`n")
  # Note: `-split "`n", -1` (max=-1) silently fails to split under PowerShell 7.x
  # (returns the whole text as one part) while it works under Windows PowerShell
  # 5.1; the default -split form behaves identically in both, so it is used here.
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.AddRange([string[]]($normalized -split "`n"))

  $unreleasedIndexes = New-Object 'System.Collections.Generic.List[int]'
  $pendingIndexes = New-Object 'System.Collections.Generic.List[int]'
  $datedIndexes = New-Object 'System.Collections.Generic.List[int]'
  $escaped = [regex]::Escape($ReleaseVersion)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq '## [Unreleased]') { $unreleasedIndexes.Add($i) }
    elseif ($lines[$i] -eq "## [$ReleaseVersion]") { $pendingIndexes.Add($i) }
    elseif ($lines[$i] -match "^## \[$escaped\] - ") { $datedIndexes.Add($i) }
  }

  if ($unreleasedIndexes.Count -ne 1) { throw "CHANGELOG.md must contain exactly one [Unreleased] placeholder section (found $($unreleasedIndexes.Count))." }
  if ($datedIndexes.Count -gt 0) { throw "CHANGELOG.md already contains a released '## [$ReleaseVersion] - ' section; refusing to stamp it twice." }
  if ($pendingIndexes.Count -ne 1) { throw "CHANGELOG.md must contain exactly one pending '## [$ReleaseVersion]' section (found $($pendingIndexes.Count)); add it before releasing." }

  # Every semver version heading — bare or dated, for any version, not just the
  # target — must appear at most once. A same-version bare+dated pair is the
  # duplicate shape the v1.0.0 release produced (two [1.0.0] sections), so it is
  # rejected for historical versions too, not only for the version being stamped.
  $seenVersions = @{}
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $m = [regex]::Match($lines[$i], '^## \[([^\]]+)\]')
    if (-not $m.Success) { continue }
    $token = $m.Groups[1].Value
    if ($token -eq 'Unreleased' -or $token -notmatch '^\d+\.\d+\.\d+$') { continue }
    if ($seenVersions.ContainsKey($token)) {
      throw "CHANGELOG.md contains duplicate '## [$token]' headings; each version section must appear exactly once."
    }
    $seenVersions[$token] = $true
  }

  $unreleasedIndex = $unreleasedIndexes[0]
  $pendingIndex = $pendingIndexes[0]

  # [Unreleased] must stay the top section (canonical placeholder position).
  $firstHeader = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^## ') { $firstHeader = $i; break }
  }
  if ($firstHeader -ne $unreleasedIndex) { throw 'CHANGELOG.md must start with the [Unreleased] placeholder section.' }

  # The [Unreleased] placeholder must stay empty: entries belong under the pending
  # version section. A non-empty placeholder would strand entries without a date,
  # and the old folding logic re-created duplicate version sections around it.
  $hasEntries = $false
  for ($i = $unreleasedIndex + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^## ') { break }
    if ($lines[$i].Trim()) { $hasEntries = $true; break }
  }
  if ($hasEntries) { throw 'The [Unreleased] section is not empty; move its entries under the pending "## [<version>]" section.' }

  # The pending section must be non-empty so a release never ships a blank changelog.
  $hasEntries = $false
  for ($i = $pendingIndex + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^## ') { break }
    if ($lines[$i].Trim()) { $hasEntries = $true; break }
  }
  if (-not $hasEntries) { throw "The pending '## [$ReleaseVersion]' section is empty; add changelog entries before releasing." }

  $lines[$pendingIndex] = "## [$ReleaseVersion] - $Date"
  $result = ($lines -join "`n")
  if ($normalized.EndsWith("`n")) { $result += "`n" }
  return $result
}
