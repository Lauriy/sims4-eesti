<#
.SYNOPSIS
  Load Lauri's personal instructions into a repository without touching any
  tracked file.

.DESCRIPTION
  Some AI tools only read instruction files from inside the project (AGENTS.md,
  CLAUDE.md, .github/copilot-instructions.md). Writing those files normally means
  committing them, which interferes with other developers.

  This script instead creates them as *local* pointer files and registers each one
  in .git/info/exclude. That file is per-clone and untracked, so:
    - git never shows the files in status and never commits them,
    - .gitignore (which IS tracked) is not modified,
    - another developer's checkout is completely unaffected,
    - a file that is already tracked, or that this script did not create, is
      never touched.

  Each pointer file names where the actual rules live and carries a sentinel
  comment so -Undo can tell its own files apart from yours.

.PARAMETER RepoPath
  Repository to install into. Default: the current directory.

.PARAMETER RulesPath
  Where the rules live, as an absolute path or a repo-relative path.
  Default: agents/shared/lauri/rules inside the repo, falling back to
  $CanonicalRules (default: %USERPROFILE%\agents\shared\lauri\rules).

.PARAMETER Undo
  Remove the pointer files and exclude entries this script created.

.PARAMETER SyncGlobal
  Copy this project's rules and skills into the canonical directory
  (%USERPROFILE%\agents\shared\lauri by default, or -CanonicalRoot), which is what
  the user-level agent configurations point at. Reports exactly which files were
  added or updated, so a stale canonical copy is visible rather than assumed. Does
  not delete anything there.

.EXAMPLE
  pwsh -File install-project-instructions.ps1 -RepoPath C:\src\team-project

.EXAMPLE
  pwsh -File install-project-instructions.ps1 -Undo

.EXAMPLE
  pwsh -File install-project-instructions.ps1 -SyncGlobal
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoPath = (Get-Location).Path,
    [string]$RulesPath,
    [switch]$Undo,
    [switch]$SyncGlobal,
    [string]$CanonicalRoot = (Join-Path $env:USERPROFILE 'agents\shared\lauri')
)

$ErrorActionPreference = 'Stop'

$Sentinel = 'lauri-personal-instructions: managed file, safe to delete'
$ExcludeMarker = '# lauri personal instructions (managed by install-project-instructions.ps1)'
$Targets = @('AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md')
$CanonicalRules = Join-Path $CanonicalRoot 'rules'

function Invoke-Git {
    param([string[]]$GitArgs)
    # git writes expected non-zero exits (ls-files --error-unmatch) to stderr, and
    # PowerShell 5.1 turns a native command's stderr into a terminating error when
    # $ErrorActionPreference is 'Stop'. Relax it just for this call.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $output = & git -C $RepoPath @GitArgs 2>$null
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return @{ Ok = ($code -eq 0); Output = @($output) }
}

# --- locate the repository -------------------------------------------------
$repoCheck = Invoke-Git @('rev-parse', '--show-toplevel')
if (-not $repoCheck.Ok) {
    throw "Not a git repository: $RepoPath (this script relies on .git/info/exclude, which only exists in a repo)"
}
$RepoRoot = ($repoCheck.Output | Select-Object -First 1).Trim()
Write-Host "repository: $RepoRoot"

# --- -SyncGlobal: refresh the canonical copy from this project --------------
if ($SyncGlobal) {
    $projectPersonal = Join-Path $RepoRoot 'agents/shared/lauri'
    $added = @()
    $updated = @()
    $unchanged = @()

    foreach ($sub in @('rules', 'skills')) {
        $source = Join-Path $projectPersonal $sub
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { continue }
        $destination = Join-Path $CanonicalRoot $sub
        foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
            $relative = $file.FullName.Substring($source.Length).TrimStart('\', '/')
            $target = Join-Path $destination $relative
            $targetDir = Split-Path -Parent $target
            $existed = Test-Path -LiteralPath $target
            $same = $existed -and ((Get-FileHash -LiteralPath $file.FullName).Hash -eq (Get-FileHash -LiteralPath $target).Hash)
            if ($same) { $unchanged += "$sub/$relative"; continue }
            if ($PSCmdlet.ShouldProcess($target, 'copy from project')) {
                if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
                    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
                }
                Copy-Item -LiteralPath $file.FullName -Destination $target -Force
            }
            if ($existed) { $updated += "$sub/$relative" } else { $added += "$sub/$relative" }
        }
    }

    Write-Host ''
    Write-Host "Synced into $CanonicalRoot"
    Write-Host "  added:     $($added.Count)"
    $added | ForEach-Object { Write-Host "    $_" }
    Write-Host "  updated:   $($updated.Count)"
    $updated | ForEach-Object { Write-Host "    $_" }
    Write-Host "  unchanged: $($unchanged.Count)"
    if ($added.Count -eq 0 -and $updated.Count -eq 0) {
        Write-Host '  (the canonical copy was already current)'
    }
    Write-Host ''
    Write-Host 'Nothing is deleted by this command; remove files from the canonical copy by hand.'
    exit 0
}

# --- resolve where the rules live -----------------------------------------
function Resolve-Rules {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    if ([System.IO.Path]::IsPathRooted($Candidate)) {
        if (Test-Path -LiteralPath $Candidate -PathType Container) { return $Candidate }
        return $null
    }
    $joined = Join-Path $RepoRoot $Candidate
    if (Test-Path -LiteralPath $joined -PathType Container) { return $joined }
    return $null
}

$rules = Resolve-Rules $RulesPath
if (-not $rules) { $rules = Resolve-Rules 'agents/shared/lauri/rules' }
if (-not $rules) { $rules = Resolve-Rules $CanonicalRules }
if (-not $rules) {
    throw @"
Could not find the rules. Looked for:
  - `$RulesPath (if given)
  - $RepoRoot\agents\shared\lauri\rules
  - $CanonicalRules
Put the rules in one of those places, or pass -RulesPath.
"@
}
Write-Host "rules:      $rules"

# The path written into the pointer file: relative when the rules are inside the
# repo (so it stays valid if the repo moves), absolute otherwise.
$rulesInsideRepo = $rules.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)
$rulesReference = if ($rulesInsideRepo) {
    $rules.Substring($RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
} else {
    $rules
}

function Get-PointerContent {
    param([string]$SelfName)
    @"
<!-- $Sentinel -->
# Personal instructions (local to this clone, not part of the repository)

Working rules for this machine live in ``$rulesReference``.

- Read ``00-verification.md`` and ``03-dont-claim-unverified.md`` before claiming
  something works or reporting results.
- Each file starts with an ``Applies when:`` line - use it to decide whether the
  rest applies to the task at hand.

This file exists only in Lauri's checkout. It is listed in ``.git/info/exclude``
and must not be committed. Delete it, or re-run the installer with ``-Undo``.
"@
}

# --- the managed block in .git/info/exclude -------------------------------
$excludePath = Join-Path $RepoRoot '.git/info/exclude'
function Get-ManagedPaths {
    if (-not (Test-Path -LiteralPath $excludePath)) { return @() }
    $lines = Get-Content -LiteralPath $excludePath
    $result = @()
    $inBlock = $false
    foreach ($line in $lines) {
        if ($line -eq $ExcludeMarker) { $inBlock = $true; continue }
        if ($inBlock) {
            if ($line -match '^\s*$' -or $line -match '^\s*#') { continue }
            $result += $line.Trim()
        }
    }
    return $result
}

function Set-ManagedPaths {
    param([string[]]$Paths)
    $existing = if (Test-Path -LiteralPath $excludePath) { Get-Content -LiteralPath $excludePath } else { @() }
    # Drop any previous managed block.
    $kept = New-Object System.Collections.Generic.List[string]
    $inBlock = $false
    foreach ($line in $existing) {
        if ($line -eq $ExcludeMarker) { $inBlock = $true; continue }
        if ($inBlock) {
            if ($line -match '^\s*$' -or ($line -match '^\s*#')) { continue }
            continue
        }
        $kept.Add($line)
    }
    $content = New-Object System.Collections.Generic.List[string]
    $content.AddRange($kept)
    if ($Paths.Count -gt 0) {
        while ($content.Count -gt 0 -and $content[$content.Count - 1] -eq '') { $content.RemoveAt($content.Count - 1) }
        $content.Add('')
        $content.Add($ExcludeMarker)
        foreach ($p in $Paths) { $content.Add($p) }
    }
    $text = ($content -join "`n").TrimEnd() + "`n"
    if ($PSCmdlet.ShouldProcess($excludePath, 'update managed exclude block')) {
        Set-Content -LiteralPath $excludePath -Value $text -Encoding ascii -NoNewline
    }
}

function Test-Tracked {
    param([string]$RelativePath)
    $result = Invoke-Git @('ls-files', '--error-unmatch', '--', $RelativePath)
    return $result.Ok
}

$created = @()
$skipped = @()

if ($Undo) {
    foreach ($relative in $Targets) {
        $full = Join-Path $RepoRoot $relative
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $head = Get-Content -LiteralPath $full -TotalCount 5 -ErrorAction SilentlyContinue
        if ($head -match [regex]::Escape($Sentinel)) {
            if (Test-Tracked $relative) {
                # Someone committed it despite the exclude entry. Deleting a tracked
                # file is a repository change, so leave it and say so.
                $skipped += "$relative (has become tracked by git; remove it deliberately if you really want it gone)"
                continue
            }
            if ($PSCmdlet.ShouldProcess($full, 'delete managed pointer file')) {
                Remove-Item -LiteralPath $full -Force
                $created += "removed $relative"
                $directory = Split-Path -Parent $full
                if ($directory -and $directory -ne $RepoRoot -and (Test-Path -LiteralPath $directory) -and
                    -not (Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1)) {
                    Remove-Item -LiteralPath $directory -Force
                }
            }
        } else {
            $skipped += "$relative (not created by this script; left alone)"
        }
    }
    Set-ManagedPaths @()
    Write-Host ''
    Write-Host "Undo complete."
    $created | ForEach-Object { Write-Host "  $_" }
    $skipped | ForEach-Object { Write-Host "  kept: $_" }
    exit 0
}

foreach ($relative in $Targets) {
    $full = Join-Path $RepoRoot $relative
    if (Test-Tracked $relative) {
        $skipped += "$relative (tracked by git - this is somebody's committed file; not touching it)"
        continue
    }
    if (Test-Path -LiteralPath $full) {
        $head = Get-Content -LiteralPath $full -TotalCount 5 -ErrorAction SilentlyContinue
        if (-not ($head -match [regex]::Escape($Sentinel))) {
            $skipped += "$relative (exists and was not created by this script; not touching it)"
            continue
        }
    }
    $directory = Split-Path -Parent $full
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        if ($PSCmdlet.ShouldProcess($directory, 'create directory')) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
    }
    if ($PSCmdlet.ShouldProcess($full, 'write pointer file')) {
        Set-Content -LiteralPath $full -Value (Get-PointerContent $relative) -Encoding utf8
        $created += $relative
    }
}

$managed = @(Get-ManagedPaths)
$managed = @($managed + $created | Where-Object { $_ } | Sort-Object -Unique)
Set-ManagedPaths $managed

Write-Host ''
Write-Host "Created or refreshed:"
if ($created.Count -eq 0) { Write-Host '  (nothing)' } else { $created | ForEach-Object { Write-Host "  $_" } }
if ($skipped.Count -gt 0) {
    Write-Host "Left alone:"
    $skipped | ForEach-Object { Write-Host "  $_" }
}
Write-Host ''
Write-Host "Verify with:  git -C `"$RepoRoot`" status --short   (the files above must not appear)"
Write-Host "Undo with:    pwsh -File `"$PSCommandPath`" -RepoPath `"$RepoRoot`" -Undo"
