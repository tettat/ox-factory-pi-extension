param(
  [Parameter(Mandatory = $true)][string]$WorkersDir,
  [string]$FactoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$projectsFile = Join-Path $WorkersDir 'projects.jsonl'
$outputFile = Join-Path $WorkersDir 'cache\project-git-activity.json'
$projects = @{}

function Ensure-Project([string]$id) {
  if (-not $projects.ContainsKey($id)) {
    $projects[$id] = [ordered]@{ paths = [System.Collections.Generic.HashSet[string]]::new() }
  }
  return $projects[$id]
}

if (Test-Path -LiteralPath $projectsFile) {
  foreach ($line in Get-Content -LiteralPath $projectsFile) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    $projectId = [string]$event.projectId
    if (-not $projectId) { continue }
    $project = Ensure-Project $projectId
    if ($event.type -eq 'project:upsert') {
      foreach ($link in @($event.patch.links)) {
        if ($link.type -ne 'repo') { continue }
        $ref = [string]$link.ref
        if (-not $ref -or $ref -match '^https?://') { continue }
        $path = if ([IO.Path]::IsPathRooted($ref)) { $ref } else { Join-Path $FactoryRoot $ref }
        [void]$project.paths.Add([IO.Path]::GetFullPath($path))
      }
    } elseif ($event.type -eq 'project:worktree:set') {
      $ref = [string]$event.worktree.path
      if ($ref) {
        $path = if ([IO.Path]::IsPathRooted($ref)) { $ref } else { Join-Path $FactoryRoot $ref }
        [void]$project.paths.Add([IO.Path]::GetFullPath($path))
      }
    }
  }
}

function Git-Lines([string]$repo, [string[]]$arguments) {
  try { return @(& git -C $repo @arguments 2>$null) } catch { return @() }
}

function Git-One([string]$repo, [string[]]$arguments) {
  return [string](Git-Lines $repo $arguments | Select-Object -First 1)
}

function Commit-Records([string]$repo, [string[]]$refs, [string]$since) {
  $records = @()
  foreach ($line in Git-Lines $repo (@('log') + $refs + @("--since=$since", '--format=%H%x1f%as%x1f%an%x1f%ae'))) {
    $parts = ([string]$line).Split([char]0x1f)
    if ($parts.Count -ge 4) {
      $records += [ordered]@{ hash = $parts[0]; date = $parts[1]; author = $parts[2]; email = $parts[3] }
    }
  }
  return $records
}

$resultProjects = [ordered]@{}
$since = (Get-Date).ToUniversalTime().AddDays(-371).ToString('yyyy-MM-ddTHH:mm:ssZ')
foreach ($entry in $projects.GetEnumerator()) {
  $repos = @()
  $localCommits = @()
  $mainlineCommits = @()
  foreach ($path in $entry.Value.paths) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { continue }
    $root = Git-One $path @('rev-parse', '--show-toplevel')
    if (-not $root) { continue }
    $defaultRef = Git-One $path @('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    if (-not $defaultRef) {
      foreach ($candidate in @('origin/main', 'origin/master', 'main', 'master', 'HEAD')) {
        if (Git-One $path @('rev-parse', '--verify', $candidate)) { $defaultRef = $candidate; break }
      }
    }
    $status = @(Git-Lines $path @('status', '--porcelain'))
    $upstream = Git-One $path @('rev-parse', '--abbrev-ref', '@{upstream}')
    $ahead = 0; $behind = 0
    if ($upstream) {
      $counts = (Git-One $path @('rev-list', '--left-right', '--count', "$upstream...HEAD")) -split '\s+'
      if ($counts.Count -ge 2) { $behind = [int]$counts[0]; $ahead = [int]$counts[1] }
    }
    $last = (Git-One $path @('log', '-1', '--format=%H%x1f%aI%x1f%an%x1f%s')).Split([char]0x1f)
    $repos += [ordered]@{
      path = $root; branch = Git-One $path @('branch', '--show-current'); head = Git-One $path @('rev-parse', '--short=10', 'HEAD')
      dirty = $status.Count; upstream = $(if ($upstream) { $upstream } else { $null }); ahead = $ahead; behind = $behind
      remoteUrl = Git-One $path @('remote', 'get-url', 'origin'); defaultRef = $defaultRef
      lastCommit = $(if ($last.Count -ge 4) { [ordered]@{ hash=$last[0]; at=$last[1]; author=$last[2]; subject=$last[3] } } else { $null })
    }
    $localCommits += Commit-Records $path @('--branches') $since
    $mainlineCommits += Commit-Records $path @($defaultRef) $since
  }
  $resultProjects[$entry.Key] = [ordered]@{ repositories = $repos; localCommits = $localCommits; mainlineCommits = $mainlineCommits }
}

$parent = Split-Path -Parent $outputFile
New-Item -ItemType Directory -Force -Path $parent | Out-Null
[ordered]@{ generatedAt = (Get-Date).ToUniversalTime().ToString('o'); projects = $resultProjects } |
  ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputFile -Encoding utf8
Write-Output "Project Git activity refreshed: $outputFile"
