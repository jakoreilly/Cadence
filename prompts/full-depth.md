# Full-depth: everything available, not just one report

`deep-dive.md` turns **one report file** into a document. It is
sufficient for almost everything, because a report's `#to-brief` and `#to-data`
already carry the whole derived model for the day it was generated.

Use **this** prompt instead when the question genuinely needs more than one
file can hold — a real multi-day trend, a claim that has to be checked against
a documented decision rather than re-derived, whether a finding is actually new
or already sitting in the alert history, or an audit of the estate rather than
a brief about it. It is an inventory of every source of information in this
repository, where each one lives, what it is for, and the one rule that keeps
all of them safe to combine: **raw data is read to check something, never to
compute something a CLI command already computes.**

> Same rule as `deep-dive.md`: any document produced from this stays a
> local HTML file in `reports/`, opened from disk. Do not publish it externally.

---

## The inventory

| Source | Where | What it is | How to read it |
|---|---|---|---|
| **The handover** | `docs/handover.md` | Everything established by live investigation: real field ids, how each team was mapped to its GitLab group and Confluence space **and the evidence for it**, every API/design GOTCHA paid for, session-by-session history. | Read in full before anything else. Never re-derive a fact recorded here - if the data in front of you seems to contradict it, that is a finding worth stating explicitly, not a reason to silently recompute. |
| **The decisions** | `docs/decisions.md` | The *why* behind every deliberate design choice - why there is no per-person productivity ranking, why review rates exclude bots, why a verdict is withheld when its basis is thin, why the report lands on a neutral overview rather than a chosen team. | Read before writing anything that touches a topic here. A document that reintroduces a per-person ranking, or compares story points across boards, has broken a rule that was decided on purpose, not one nobody thought of. |
| **Scheduling** | `docs/scheduling.md` | When collection runs, how long it takes, and the ~8-minute window each morning where a day has a `jira.json` and no `gitlab.json` yet. | Read before trusting the freshness of "today's" data - if the run started under 13 minutes ago, GitLab and review figures for it may simply not exist yet, which is different from them being zero. |
| **Profile config** | `profiles/<name>/config.json` | The team → board → GitLab group → Confluence space mapping, **with the evidence for each mapping written into every team's `description` field**. Also `reviewBotAccounts` (which GitLab accounts are automation, by both username and display name), `alerts` (destinations and thresholds), `individualAttribution`, `gitlabWindowDays`. | Read the `description` field before asserting *why* a group belongs to a team - the evidence (key-hit counts, matched authors) is already written there, from `suggest-groups`. Don't re-derive it by eyeballing raw merge requests. |
| **Field map** | `profiles/<name>/field-map.json` | Discovered custom field ids for this Jira site (Sprint, Story Points, Epic Link, Rank, Flagged), cached so they never need rediscovering. | Reference only - explains why a raw issue record has `customfield_10006` rather than a named field. |
| **Secrets** | `profiles/<name>/secrets.local.json` | Atlassian and GitLab credentials, and (once configured) a Slack token. | **Never read, print, or quote this file's contents**, for any purpose. It is gitignored and off-limits regardless of what the task asks for. |
| **Raw Jira snapshot** | `data/<profile>/<date>/jira.json` | Every issue on every configured board, on that one collected day - full detail (summary, description excerpt, comments where collected, links, sprint history), unbounded by anything a report chose to render. **~30 MB per day on this profile - see extraction below.** | Never `Read` directly. Slice narrowly with `node -e` (see below) to one team, one scope, or one field at a time. |
| **Raw GitLab snapshot** | `data/<profile>/<date>/gitlab.json` | Every merge request in the collection window, per team, with review detail (first human comment/approval, bot classification, reviewer counts). **~1.6 MB per day.** | Small enough to slice with the same `node -e` pattern; still narrow the query rather than dumping it whole. |
| **Raw Confluence snapshot** | `data/<profile>/<date>/context.json` | Space and page metadata (title, URL, last updated, why the page was pulled in) for each team, from `discover-spaces`/`collectTeamContext`. **~43 KB per day.** | Small enough to read directly if needed. |
| **Alert history** | `data/<profile>/alert-state.json` | What the alerting layer has already told the reader about, and when. **May not exist** - it is written only after a real (non-dry-run) `alert` run, and as of this writing no such run has happened on this profile. | If it exists: check an identity (`team\|kind\|issueKeys`, see `src/notify/digest.ts`) here before presenting a finding as newly discovered - it may already be a standing, previously-reported item. If it does not exist: say so; do not assume nothing has ever been flagged when the honest answer is "alerting has never been turned on for real". |
| **Generated reports** | `reports/report-*.html` | Every report ever written, each a point-in-time snapshot of the derived model for the day it names in its filename. | Multiple reports let you diff **derived** figures across days without recomputing them - e.g. compare two `#to-brief` extracts rather than re-deriving history from raw Jira snapshots yourself. |
| **Collection logs** | `logs/collect-<date>.log` | Timestamped lines from each day's scheduled run: partial-team errors, `collect end (exit N)`, and (once wired) the alert pass's own log lines. | Check when a day's freshness or completeness is in question - a team recorded with errors in `TeamSnapshot.errors` will show why here. |
| **The CLI, with `--json`** | `node dist/src/cli.js <command> --profile profiles/<name> --json` | The **deterministic derive layer itself** - `quality`, `trends`, `review`, `history`, `suggest-groups`, `discover-spaces`, `alert --dry-run` all emit structured JSON on demand, computed the same way the report computes it. | **This is how you get a computed figure that isn't already sitting in a report or the digest.** Never hand-roll the equivalent aggregation from raw snapshot JSON - see the central rule below. |

---

## The one rule that makes combining all of this safe

**Raw snapshot JSON (`jira.json`, `gitlab.json`, `context.json`) is the *input*
to this tool's derive layer, never a substitute for it.** Every number this
project produces - a p50, a carryover rate, an unreviewed percentage, a
forecast - is computed by a pure function in `src/`, with a specific, often
non-obvious rule behind it (bot exclusion, scope-of-comment-collection,
closed-sprint carryover being provably wrong, and thirty-six more GOTCHAs in
the handover).

Reading raw JSON to **check a specific fact** - what a ticket's description
says, whether a merge request really has no reviewer, when a sprint's end date
actually was - is exactly what it is for. Reading raw JSON and then **counting,
averaging, or percentaging it yourself** silently reproduces work this tool
already does correctly, and has a real chance of reproducing it *wrong* -
which is precisely the failure mode the whole "no AI computes a number" design
exists to prevent. If a figure is not already in a report, a digest, or a
`--json` command's output, the fix is to run the command that produces it (or
say plainly that this tool does not currently compute it), never to derive it
by hand from the raw file.

---

## Extraction: the 30 MB file

`jira.json` for one day on this profile is larger than the entire generated
report. `Read` will blow context and likely truncate. Slice with `node -e`,
narrowing at every step:

```bash
# one team's issues out of a day's full snapshot
node -e 'const d=JSON.parse(require("fs").readFileSync("data/acme/2026-08-27/jira.json","utf8"));
  const t=d.teams.find(x=>x.key==="fcp");
  console.log(t.issues.length, "issues,", t.sprints.length, "sprints");
  require("fs").writeFileSync("team.json", JSON.stringify(t, null, 1))' 

# then narrow further - never dump team.json whole
node -e 'const t=require("./team.json");
  console.log(t.issues.filter(i=>i.flagged).map(i=>({key:i.key,summary:i.summary,updated:i.updated})))'
```

The same pattern works across **multiple days** for a real trend that
`history`/`trends` do not already expose in the shape you need - e.g. reading
`updated`/`statusCategoryChangedAt` on one ticket across every collected date
to see exactly when it moved. Still prefer `history --json` first; it already
does the day-pairing and censoring correctly (see GOTCHA 2 in the handover:
work already in progress on the first observed day is `censored`, not counted
from day one).

---

## Recommended order for a genuinely full-depth pass

1. **Read `docs/handover.md` and `docs/decisions.md` in full.** This is not
   optional context - it is the difference between a finding and a
   rediscovery, and between an insight and a documented decision being
   silently violated.
2. **Run `dates --profile profiles/<name>`** to know what days actually exist
   before assuming a trend question can be answered at all.
3. **Decide what's actually missing from a report or a `--json` command
   before touching raw JSON.** Most questions are already answered by
   `#to-brief`, `#to-data`, or one CLI command with `--json`. Reach for raw
   snapshots only for the remainder.
4. **Check `data/<profile>/alert-state.json`, if it exists**, before
   presenting anything as a fresh discovery - it may already be known and
   waiting on someone.
5. **Cross-reference `config.json`'s `description` fields** whenever a
   document is about to explain *why* a team maps to a GitLab group or
   Confluence space - that evidence already exists; don't re-derive it by
   eyeballing merge requests.
6. **Check `logs/collect-<date>.log`** whenever a day's completeness or
   freshness is load-bearing to a conclusion.
7. Only then, for whatever remains, slice raw snapshots as narrowly as
   possible, per the extraction pattern above.

---

## The rules that travel with the data

Everything in `deep-dive.md`'s "rules that travel with the data"
applies unchanged - quote, never compute; never quote closed-sprint
`committedPoints`/`carriedOut`; never compare story points across boards;
never build a per-person productivity ranking; a null means not measurable;
lead time is not cycle time; review rates exclude bot-authored merge requests;
carry every caveat into the sentence. Three more, specific to working this far
outside one report file:

- **A documented decision is not evidence to be weighed against the data - it
  is a constraint on what conclusion is allowed.** If raw data seems to argue
  for a per-person ranking, or for comparing two boards' story points directly,
  the answer is to say the tension exists, quoting `docs/decisions.md`'s
  reasoning - never to quietly produce the ranking or the comparison because
  the numbers were sitting right there.
- **An item already in `alert-state.json` is not a new finding.** Report it as
  standing, with when it was first raised, not as something just discovered.
- **`secrets.local.json` is never read, quoted, or reasoned about**, no matter
  what the task is. If a task seems to require it, that is a reason to stop and
  say so, not to proceed carefully.

## Output

Once everything has been gathered, hand off to `deep-dive.md`'s
**Output requirements** section verbatim for how to write the resulting
document - self-contained HTML, theme-aware, opens correctly from `file://`,
named `reports/<description>-<YYYY-MM-DD>.html`. This file is about what to
gather and how to keep it honest; that one is about how to present it.
