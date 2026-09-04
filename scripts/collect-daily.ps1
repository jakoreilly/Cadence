<#
.SYNOPSIS
  Daily snapshot collection, for Windows Task Scheduler.

.DESCRIPTION
  Self-contained: resolves its own repo root, reads credentials from the
  profile's secrets.local.json, appends to a dated log, and exits non-zero on
  failure so Task Scheduler's "Last Run Result" is meaningful.

  Deliberately does NOT rebuild. A scheduled job that compiles is a scheduled
  job that can start failing because of an unrelated source edit; it runs the
  committed dist/ output only, and refuses to run if that is missing.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'acme',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [int]$RetentionDays = 90,
  # The alert pass runs after a SUCCESSFUL collect. It is safe to leave on with
  # no destination configured - it prints what it would send into this log and
  # sends nothing - which is deliberately the state a fresh profile is in.
  [switch]$SkipAlert
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root from this script's own location rather than the working
# directory - Task Scheduler does not guarantee any particular cwd.
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

$logDir = Join-Path $repoRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$logFile = Join-Path $logDir "collect-$stamp.log"

function Write-Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
  Add-Content -Path $logFile -Value $line -Encoding utf8
  Write-Output $line
}

$exitCode = 0
try {
  Write-Log "=== collect start (profile=$Profile, host=$env:COMPUTERNAME) ==="

  $cli = Join-Path $repoRoot 'dist\src\cli.js'
  if (-not (Test-Path $cli)) {
    throw "Missing $cli - run 'npm run build' once before scheduling."
  }
  if (-not (Test-Path $NodeExe)) {
    throw "Node not found at $NodeExe - pass -NodeExe with the correct path."
  }

  $profileDir = Join-Path $repoRoot "profiles\$Profile"
  if (-not (Test-Path (Join-Path $profileDir 'secrets.local.json'))) {
    throw "No secrets.local.json in $profileDir"
  }

  # GOTCHA: do NOT invoke node via Start-Process -Wait with
  # -RedirectStandardOutput/-RedirectStandardError here. It works when run
  # interactively but HANGS INDEFINITELY under Task Scheduler's hidden,
  # non-interactive session (observed: task stuck at result 267009 "still
  # running" with the child node process alive and the log frozen after the
  # start line). Calling the executable directly has no such problem.
  #
  # The collector writes progress to stderr, so 2>&1 is needed to capture it.
  # Under PS 5.1 that wraps each stderr line in an ErrorRecord, which would
  # abort the script while $ErrorActionPreference is 'Stop' - hence the
  # temporary relaxation, and .ToString() to unwrap the records into text.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $NodeExe $cli collect --profile $profileDir 2>&1 | ForEach-Object { $_.ToString() }
  $nodeExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP

  foreach ($line in $output) { if ($line -ne '') { Write-Log $line } }

  if ($nodeExit -ne 0) { throw "collect exited $nodeExit" }
  Write-Log "collect ok"

  # The alert pass, only after a successful collect. Running it on a failed
  # collect would decide "is this new" by comparing the newest snapshot against
  # itself, which is not wrong so much as pointless - and on a day where the
  # Jira half succeeded and GitLab did not, it would raise every review finding
  # as cleared.
  if (-not $SkipAlert) {
    Write-Log "=== alert start ==="
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $alertOut = & $NodeExe $cli alert --profile $profileDir 2>&1 | ForEach-Object { $_.ToString() }
    $alertExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    foreach ($line in $alertOut) { if ($line -ne '') { Write-Log $line } }
    # A failed alert does NOT fail the run. The snapshot is the product and it is
    # already safely on disk; a Slack outage must not make the day's collection
    # read as failed in Task Scheduler's Last Run Result.
    if ($alertExit -ne 0) { Write-Log "WARNING: alert exited $alertExit - the snapshot is unaffected" }
    Write-Log "=== alert end (exit $alertExit) ==="
  }

  # Log retention only. Snapshots under data/ are NEVER pruned here - the
  # history is the product, and a scheduled job silently deleting it is the one
  # failure mode that cannot be recovered from.
  Get-ChildItem $logDir -Filter 'collect-*.log' |
    Where-Object { $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddDays(-$RetentionDays) } |
    ForEach-Object { Write-Log "pruning old log $($_.Name)"; Remove-Item $_.FullName -Force }
}
catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  $exitCode = 1
}

Write-Log "=== collect end (exit $exitCode) ==="
exit $exitCode
