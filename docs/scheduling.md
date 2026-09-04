# Scheduling

## What is registered

Windows Task Scheduler task **`Cadence Daily Collect`**, running
[scripts/collect-daily.ps1](../scripts/collect-daily.ps1) daily at **07:00 local
time**. Since the ninth session that script also runs the **alert** pass, after a
successful collect - see "The alert pass" below.

```
Action     powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
           -WindowStyle Hidden -File scripts\collect-daily.ps1 -Profile acme
Trigger    Daily 07:00
Principal  current user, LogonType Interactive, RunLevel Limited
Settings   StartWhenAvailable, AllowStartIfOnBatteries,
           DontStopIfGoingOnBatteries, ExecutionTimeLimit 1h,
           MultipleInstances IgnoreNew
```

Verified end to end: `LastTaskResult 0`, snapshot written, log appended.

## How long it takes, and why that matters before 07:15

Measured on the 2026-08-27 run, four teams at schema 4:

| elapsed | what has happened |
|---|---|
| 00:00 | starts (07:00 local = 06:00 UTC, and the snapshot folder is the **UTC** date) |
| ~05:00 | `jira.json` written - 20,701 issues, four boards |
| ~05:00-12:00 | the GitLab pass, most of it review detail for ~1,142 merge requests |
| ~12:30 | `gitlab.json`, then `context.json` |
| ~13:00 | `collect end (exit 0)` |

**So between roughly 07:05 and 07:13 the day on disk has a complete `jira.json`
and no `gitlab.json` yet.** A `report` run in that window is not wrong - it says
"no GitLab snapshot" - but it silently drops every review metric for a day that
is about to have them. Wait for `collect end (exit 0)` in
`logs/collect-<date>.log`.

An absent `gitlab.json` is deliberately NOT treated as stale data by the
freshness check, precisely because this window is a legitimate state.

## The alert pass

After `collect ok`, the script runs `alert` and logs its output into the same
dated log. Three things about it are deliberate:

- **Only after a SUCCESSFUL collect.** On a failed collect the newest snapshot is
  yesterday's, so "is this new" would compare a day against itself - and on a day
  where the Jira half succeeded and GitLab did not, every review finding would
  read as cleared.
- **A failed alert does not fail the run.** The snapshot is the product and it is
  already safely on disk; a Slack outage must not make the day's collection show
  as failed in `LastTaskResult`. It logs `WARNING: alert exited N` instead.
- **Safe to leave on with no destination configured**, which is the state a fresh
  profile is in: it prints what it would have sent into the log and sends
  nothing. Pass `-SkipAlert` to turn it off entirely.

The state it keeps - `data/<profile>/alert-state.json` - is what stops a second
run in the same day repeating itself, so re-running the task by hand is safe.

## Cost

**Zero token spend.** The collector is plain Node making REST calls to Jira and
GitLab. No model is involved anywhere in collection, derivation or reporting.
The hand-off layer embeds prompts for a reader to run; nothing in the scheduled
job calls a model.

## Why these settings

**`LogonType Interactive`** avoids storing a password. The consequence is that
the task runs only while the user is logged on; combined with
`StartWhenAvailable` a missed 07:00 run fires shortly after the next logon, so a
day is skipped only if the machine is off for a whole day.

The alternative - `-LogonType Password` for "run whether logged on or not" -
needs the account password stored in the task, and `S4U` (no password, runs
logged off) is documented as local-resource-only, which is a poor fit for a job
whose entire purpose is outbound HTTPS. Switch to `Password` if a missed day
matters more than storing the credential.

**`MultipleInstances IgnoreNew`** - a run that somehow overlaps the next must not
double-write the same snapshot.

**`ExecutionTimeLimit 1h`** - collection takes ~18s interactively and ~2m under
the scheduler (tasks run at reduced priority). An hour is a generous hang guard.

**One instance per UTC day.** Re-running on the same day overwrites that day's
snapshot rather than creating a second one - a later run is simply a more
accurate reading of the same day.

## Credentials

`profiles/acme/secrets.local.json`, gitignored via `*.local.json`. The
scheduled task reads this file; it does not depend on environment variables or
on the `Emberwatch` repo, so the two are fully independent.

Rotate the Atlassian token there and nothing else needs changing.

The alert pass reads `slackToken` from the same file when Slack is enabled in
`config.alerts`. It is absent today, so the pass is print-only - see the alerting
section of the [README](../README.md).

## The script

Deliberately does **not** rebuild before running. A scheduled job that compiles
is a job that can start failing because of an unrelated source edit, so it runs
the built `dist/` output only and fails loudly if that is missing. Run
`npm run build` after changing any source.

Log retention prunes `logs/collect-*.log` older than 90 days. **Snapshots under
`data/` are never pruned by the script** - the history is the product, and a
scheduled job silently deleting it is the one failure that cannot be recovered
from.

### GOTCHA: Start-Process hangs under Task Scheduler

The first version invoked node via
`Start-Process -Wait -RedirectStandardOutput -RedirectStandardError`. That works
interactively but **hangs indefinitely** in Task Scheduler's hidden,
non-interactive session - observed as the task stuck at result `267009` ("still
running") with a live child node process and the log frozen after the start
line.

Calling the executable directly (`& $NodeExe $cli collect ...`) has no such
problem. Because the collector writes progress to stderr, `2>&1` is required to
capture it, and under PowerShell 5.1 that wraps every stderr line in an
`ErrorRecord` - which would abort the script under
`$ErrorActionPreference = 'Stop'`. Hence the temporary relaxation to `Continue`
and `.ToString()` to unwrap the records back into text.

## Operating it

```powershell
# Status and last result
Get-ScheduledTask -TaskName 'Cadence Daily Collect' | Get-ScheduledTaskInfo

# Run now
Start-ScheduledTask -TaskName 'Cadence Daily Collect'

# Today's log
Get-Content .\logs\collect-*.log -Tail 20

# Which days have been collected
node dist/src/cli.js dates --profile profiles/acme

# What the alert pass would send right now, without sending or recording it
node dist/src/cli.js alert --profile profiles/acme --dry-run

# Remove the schedule
Unregister-ScheduledTask -TaskName 'Cadence Daily Collect' -Confirm:$false
```

A failed run exits non-zero, so `LastTaskResult` is meaningful: `0` is success,
anything else means read the log.
