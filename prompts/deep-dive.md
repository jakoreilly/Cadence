# Turning a Cadence report into a document

The generated report is a data surface. These are the prompts and the hard-won details for turning it
into something a person reads — either a **portfolio brief** covering every team, or a **deep dive**
on one.

> **This prompt is scoped to one report file.** If the question needs more than that — a real
> multi-day trend, checking a claim against `docs/decisions.md`, whether a finding is already sitting
> in the alert history, or an audit that draws on the raw snapshots, the docs, the config and the CLI
> together — use `full-depth.md` in this folder instead. It is an inventory of everything else
> available and the one rule that keeps it safe to combine with what is here.

> **These documents are always local HTML files in this repo.** Write them into `reports/`, next to
> the report they were derived from, and open them from disk. Do not publish them to an external host.

Worked examples in this folder, both from `report-2026-08-26-22-54.html`:

| File | Scope | Prompts applied |
|---|---|---|
| `brief-all-teams-2026-08-26.html` | All 4 teams | `exec` + `business` + `dev` + `talking` |
| `deep-dive-fcp-2026-08-26.html` | One team (fcp) | `team` |

---

## Start here: the report tells you what it wants

The report's own section **“Ask Claude to turn these numbers into the document you actually need”**
carries five ready-made prompts, embedded in `#to-brief` as `prompts[]`:

| id | Produces | Scope |
|---|---|---|
| `exec` | Executive summary, 3–4 paragraphs of prose for senior management | Portfolio |
| `business` | What each team is building, in business language | Portfolio |
| `dev` | Delivery practice, review culture, technical risk | Portfolio |
| `talking` | Conversations to have this week, with whom, with the evidence | Portfolio |
| `team` | Everything about a single team | One team |

**Read `prompts[]` before inventing a brief.** A `#team=<key>` fragment on the URL means the `team`
prompt for that key. No fragment, or “all teams”, means compose the four portfolio prompts into one
document rather than emitting four separate ones — they overlap heavily and read far better merged.

---

## Extraction — never Read the HTML file

The report is 3–4 MB and the two JSON payloads are each on a **single very long line** near the end.
A Read would blow context and still truncate. Use `sed` on the exact line, then slice with `node`.

```bash
R=reports/report-YYYY-MM-DD-HH-MM.html
grep -n 'to-brief\|to-data' "$R" | cut -c1-120        # find the two <script> line numbers

sed -n '<brief-line>p' "$R" | sed 's|^<script type="application/json" id="to-brief">||; s|</script>$||' > brief.json
sed -n '<data-line>p'  "$R" | sed 's|^<script type="application/json" id="to-data">||;  s|</script>$||' > data.json
```

`#to-brief` (~70 KB) has every headline figure for every team — **it is enough on its own for a
portfolio brief**. `#to-data` (~2 MB) has ticket-level detail; read it only for a single-team deep
dive, and only the sections you will actually quote.

```bash
# one team out of the big model
node -e 'const d=JSON.parse(require("fs").readFileSync("data.json","utf8"));
  require("fs").writeFileSync("team.json",JSON.stringify(d.teams.find(t=>t.key==="<key>"),null,1))'

# inspect section by section — never dump a whole team object
node -e 'const t=require("./team.json");
  ["flagged","attention","discussed","wip","subtasks","practice","review","roster",
   "quality","carryoverLeaders","outlook","trends","backlog","confluence","slowest","history"]
  .forEach(k=>{console.log("\n===== "+k+" =====");console.log(JSON.stringify(t[k],null,1))})' | head -400
```

Per-team keys in `#to-brief`: `key, board, boardId, projectKeys, gitlabGroups, confluenceSpaces,
confluencePageTitles, whyThisMapping, health, sprint, velocity, workMix, review, flow, epics,
backlog, people, composition, trouble, interventions`.

---

## The rules that travel with the data — keep every one

These are embedded in both JSON blocks. They are not style preferences; breaking one puts a provably
wrong number in a document that goes to the board.

- Every number must be **quoted** from the digest or the model. Never compute a new figure and present
  it as a measurement.
- Never quote `committedPoints`, `committedIssues` or `carriedOut` for a **closed** sprint. They count
  every issue that ever passed through that sprint. Accurate for the **active** sprint only.
- **Never compare story points between teams.** Estimation culture differs per board. p50/p90/committed
  are meaningful only against the same board's own past.
- Never build a per-person productivity ranking. The assignee field records who holds a ticket today,
  not who did the work. Describe a habit or a load, never a performance judgement.
- A null means **not measurable**. It never means zero.
- Lead time is created-to-resolved and includes backlog dwell. Do not call it cycle time.
- Review rates are over merge requests a **person** opened. Bot-authored MRs are excluded and counted
  separately; including them roughly quadruples the apparent unreviewed rate.
- Where a figure has a caveat in the digest, carry the caveat into the sentence. Do not strip it to
  make the sentence read better.

**What *is* comparable across teams:** percentages and hours — an unreviewed merge is an unreviewed
merge anywhere, and approval→merge latency does not depend on estimation culture. Say so explicitly in
the document, because the reader has just been told points are not comparable and will otherwise
distrust the whole table. This distinction is where most of the portfolio brief's findings came from.

---

## The prompt — portfolio brief (all teams)

> Turn `reports/report-YYYY-MM-DD-HH-MM.html` into a portfolio brief covering every team. Extract
> `#to-brief` as above; you should not need `#to-data` at all.
>
> Keep all eight rules that travel with the data. Compose these four sections rather than emitting the
> report's four portfolio prompts separately:
>
> 1. **The summary** (`exec`) — 3–4 short paragraphs of prose somebody could read aloud. Lead with the
>    single most important thing across all teams, not a team-by-team walk. Explain every term in the
>    sentence you use it — assume the reader does not know what a p90 or a carryover is. End with the
>    two or three things you would ask for. No bullet lists of metrics.
> 2. **Portfolio at a glance** (`exec`) — the comparison table, immediately followed by a caveat making
>    clear it is N separate stories side by side and not a ranking. Then the cross-cutting patterns.
> 3. **What each team is building** (`business`) — business terms, from `epics`, `sprint.goals`,
>    `confluencePageTitles` and `whyThisMapping`. Where the evidence does not support a claim, say the
>    documentation does not make it clear rather than inferring. Finish with where two teams appear to
>    be working on the same thing.
> 4. **Engineering practice** (`dev`) — review culture, flow, technical risk. **Be direct about which
>    teams are healthy; a brief that finds everything alarming is not useful.**
> 5. **Team by team** — one compact block per team: health signal row, active sprint position, what is
>    in its way, one thing worth reading. Link to a deep dive if one exists.
> 6. **Conversations to have this week** (`talking`) — merge every team's `interventions[]` into one
>    ordered list. Write them as things to **say**, to a named person, with the figure to cite and the
>    question to ask. Order by what goes wrong soonest if nothing happens. Where the data shows a
>    symptom and not a cause, say explicitly that the move is to ask rather than tell.
>
> Finish with a provenance footer restating snapshot dates and every limit above.

## The prompt — single-team deep dive

> Same extraction, plus that team's entry in `#to-data`. Structure:
>
> 1. **What this team builds** — board/GitLab/Confluence mapping and why it holds, epics in flight, the
>    sprint goal quoted verbatim.
> 2. **How it is delivering** — active-sprint position, the team's own velocity percentiles, work mix,
>    code-review practice.
> 3. **What is in its way** — carryover, stale in-progress, column shape, flags, stalled parents, backlog.
> 4. **Who is on it** — load and habit, composition change, what people are arguing about in comments.
> 5. **What to do this week** — `interventions[]` as conversations, ordered.

## Output requirements (both)

Load the `artifact-design` skill for the design pass. Then:

- Write a **complete document**: `<!doctype html>`, `<html lang="en">`, `<head>` with charset and
  viewport, `<body>`. It must open correctly from a `file://` path with no wrapper.
- Self-contained: no build step, no local asset files. Google Fonts may be linked; give every face a
  real fallback stack so the page still reads offline.
- Theme-aware the same way the generated reports are: full light palette on bare `:root`, dark
  overrides under `@media (prefers-color-scheme: dark)` guarded with `:root:not([data-theme="light"])`,
  and again under `:root[data-theme="dark"]`. Paint `body`'s background from a token.
- File name: `brief-all-teams-<YYYY-MM-DD>.html` or `deep-dive-<team>-<YYYY-MM-DD>.html`.

---

## Lessons learned

### Process

**Never Read the HTML file.** 3.9 MB on one-line JSON payloads. `sed -n 'Np'` plus `node -e` costs a
few KB instead of a few MB. This is the single biggest cost decision in the whole task.

**Write a whole document, not an artifact fragment.** The first pass was authored for a publishing
wrapper — no doctype, no `<head>`, no `<body>` — and had to be patched to open from `file://`.

**Heredocs have a length limit here.** `cat > file <<'EOF'` with a full HTML page hit
`ENAMETOOLONG: uv_spawn` on Windows. Use the Write tool for anything page-sized; keep Bash for
extraction and inspection.

**Verify every range before writing it.** `slowest[]` was inspected five rows deep and its fifteen-row
range was nearly stated from the visible five (1,948 d) instead of the real last row (1,421 d). Check
`arr[arr.length-1]`, not `arr[4]`.

**Reconcile column sums against the totals.** `flow.totalInProgress` excludes the leading To Do-style
column: panther 4+5+48 = 57 in progress while `perColumn` sums to 73; fs 7+44+35+13 = 99 while
`perColumn` sums to 138. State the right one or the sentence is wrong.

**Validate the tags before calling it done.** A quick balance check over the finished file caught
nothing this time but costs seconds:
`node -e '…count open vs close per tag…'`.

### Reading the data

**Cross-check the digest against itself.** Contradictions are worth more than any single metric and
belong in the document rather than being silently resolved:

- fcp's `Predictability 84%` signal is toned *good* (“consistent enough to plan on the median”) while
  `velocity.note` on the same figure says “a high relativeSpread means the median is a poor planning
  number.” Quote both.
- fcp `roster.members` had **badr** and **Tomas Nolan** as Jira-only with 0 MRs and 0 reviews, while
  `practice.people` had **Badr Aldeen Shek Salim** (10 MRs, 30 reviews — joint top reviewer) and
  **Binson** (4 MRs). Unlinked Jira/GitLab identities. Look for this on every board.
- `composition.recentLeavers` listed Karim Fahmy, who holds fcp's only flagged ticket and merged 11 MRs
  in the window. Weak signal vs hard evidence — flag it to confirm, do not resolve it yourself.

**Join across teams — the digest never does.** The highest-value findings in the portfolio brief came
from comparing team objects that the report only ever renders separately:

- **People counted twice.** Declan Moore holds 12 open sprint items on panther *and* 14 on fs, and is
  named in the WIP-overload finding on both. Tomas Nolan: 26 on fs, 1 on fcp. David Okafor: 8 on
  fs, plus a flagged backlog item on fcp. Neither board's capacity picture knows about the other. Diff
  `people.heaviestLoads` and `flow.overloaded` across every team, every time.
- **An outlier only visible side by side.** fcp's approval→merge p50 is 181.8 h. The same step is 0.0 h
  on panther, 0.1 h on tran, 8.7 h on fs. That turns “fcp is slow to merge” into “fcp has one specific
  gate the sibling boards do not”, which is a different and far more actionable finding.
- **The same programme running on two boards.** Dependency-Track remediation is a named sprint goal and
  epic on fcp *and* an entire sprint plus 12 labelled items on fs, with no shared epic.
- **Uneven automation posture.** Bot-authored MRs: panther 251 vs 78 human, tran 267 vs 319, fcp 28 vs
  80, fs 0 vs 104. Both extremes deserve a deliberate decision.

**Collapse the alert spam into the real problem.** `interventions[]` is per-ticket and over-counts. On
fcp, `ONB-9395`/`9397`/`9398` are three children of one parent (`ONB-9394`), and `ONB-9333…9339` are six
sub-tasks of one story (`ONB-8908`) waiting on one unanswered comment. Nine alerts, two conversations.
Group by `subtasks.parents` and by shared idle-day counts.

**Look at the shape of an aggregate, not just its value.** fcp's “46% unestimated” reads as sloppiness
until `taxonomy.types` shows every Sub-task and every Bug carries zero points while Stories and Tasks
carry all 115. It is a rule, not a lapse — which changes the recommendation from “estimate better” to
“decide whether you forecast on points or issue count”.

**Read latency rows against each other.** First-review p50 3.7 h, approval→merge p50 181.8 h,
open→merge p50 217.4 h — together they say most of the wait is *after* sign-off. Individually they say
nothing.

**Negative `daysRemaining` is a finding, not a glitch.** fs showed `-8.9` across six concurrent sprints
with `elapsedFraction: 1`. The sprints had already ended and nobody had closed them.

**A low committed-points figure can mean the opposite of capacity.** fs shows 27 points committed —
lowest of four teams — because 97% of its work is unestimated and the figure counts only the estimated
3%. Say that in the same sentence as the number.

**Name what is healthy.** The `dev` prompt asks for it explicitly and it is what makes the rest
credible: three of four boards review properly, fcp has the fastest first-review time in the set, tran
has no stale item in any column, fs has the lowest carryover.

### Design

Both documents share one visual system deliberately, so they read as a set:

- **Type:** Literata (display/serif headings and pull figures), Public Sans (body), IBM Plex Mono
  (labels, ticket keys, all figures — with `font-variant-numeric: tabular-nums`).
- **Colour:** green-leaning neutrals; deep-teal accent `#1c5f57` light / `#69bdaf` dark, kept *separate*
  from the semantic good/watch/crit set so an accent never reads as a status.
- **Structure:** hairline 1px-gap grids rather than rounded cards; a repeated left-rule `.caveat` block
  as the one recurring device, because “this figure has a limit attached” is the truest recurring fact
  in the data. Ticket keys in mono are functional, not decorative — they are what gets pasted into Jira.
- Section numbering (One…Five) is legitimate here only because the structures above are a real reading
  order. Do not add numbering to content that is not a sequence.
