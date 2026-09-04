# Decisions

Recorded so they are not silently re-litigated. Each notes what was decided and
what it costs.

## A team is a Jira Agile board

Sprints belong to boards, so making a team a board means burndown, velocity and
carryover need no mapping layer at all, and board ids arrive free on the Sprint
field of any issue.

**Cost:** a board shared by two teams blends their numbers. The
`multiple-active-sprints` quality finding exists to detect exactly that, and the
fix is to split the board or add a second team entry.

Rejected: the `Team` custom field (`customfield_10500`) - it was null on every
issue sampled, so coverage cannot be relied on. Project-scoped teams - too
coarse, several teams share a project here.

## Only ORIGIN boards become teams, never mirror views

Several boards on this site are views over another board's sprints rather than
teams of their own. Board 703 `Fleet Scrum Board` shares 249 of 249 sprints
(100%) with board 702 `Logistics Scrum Board` and holds LOG-keyed issues;
board 706 `CSP Scrum` shares 27 of its 28 sprints (96%) with board 705.

Configuring both members of such a pair would double every metric they share -
velocity, carryover, forecast - while looking entirely plausible, because each
board reports self-consistent numbers.

The test is **`originBoardId` on the sprint object**, not sprint counts or
names: sprint 7001 reports `originBoardId 702`, so 702 is the team and 703 is
the view. Sprint-id overlap is what makes you go and look; `originBoardId` is
what settles it.

**Cost:** a genuine second team that legitimately shares a board's sprints
cannot be represented this way and would need the board split in Jira. The
existing `multiple-active-sprints` finding is the signal that this has happened.

## A reassuring verdict is withheld when its basis is missing

Board 705 has 149 of its 154 active-sprint issues carrying no estimate in either
point field. Its committed total is therefore 27 points - five issues' worth -
against a p90 of 104.8, and the arithmetically correct rendering of that is a
green "within band".

That cell would be the most misleading thing the tool produces: it says "this
team has spare capacity" when what it actually knows is "this team does not
estimate". So `loadVerdict` withholds the within-band verdict below two-thirds
estimate coverage and says **"not comparable"**, with the unestimated share
shown next to it.

Over-p90 is deliberately still reported in the same situation, because a partial
count that already exceeds the p90 is a valid **lower bound** - missing
estimates can only push it further over, never bring it back under.

**Cost:** a team that genuinely has a light sprint AND estimates poorly gets no
positive signal from this tool. That is the intended trade: the failure mode of
a false reassurance to senior management is much worse than the failure mode of
a withheld one.

## Per-person PRACTICE is reported; per-person PRODUCTIVITY is not

The manager asked to find "best performers and those which might need assistance
or guidance", explicitly for training rather than discipline. The tool answers
the second half directly and refuses the first half in the form it was asked,
for reasons that are about the data, not about squeamishness.

**What is reported, per person:**

- **Merged with no human review** - merge requests they opened that went in with
  no comment and no approval from anyone but themselves. A gap in company
  practice that one conversation fixes.
- **Reviews given** - distinct merge requests by *other* people they commented on
  or approved. The counterpart, and the habit worth spreading. Added in schema 3
  (`humanCommenters`), because counts alone could not name anyone.

Both are counts with visible denominators, both describe a habit rather than an
ability, and the two are always shown together - "merged unreviewed" alone reads
as a list of offenders, but beside "reviews given" it reads as what it is: who
has picked up the team's review habit and who has not been shown it yet.

**What is NOT reported: story points per person, or any ranking derived from
them.** Assignee is on every issue, so it could be computed trivially. It would
not survive being questioned:

- Estimation culture differs wildly by board. Board 705 leaves **97%** of its
  active sprint unestimated; board 702's p50 is 51 points against board 701's 28.
  Points-per-person compares estimating habits, not people.
- Points measure the **estimate**, not the difficulty, the value, or the mess
  that had to be cleared on the way.
- The person who spends a day unblocking two colleagues scores zero.
- It is the metric most likely to be gamed the moment it is known to exist,
  which would corrupt the estimates every other number here depends on.

**Cost:** the tool cannot answer "who is my best developer". It answers "which
work needs help" (item-shaped, with the assignee shown so the manager knows who
to talk to) and "who needs showing how we review here". That is a deliberate
narrowing, and it is the honest extent of what a Jira and GitLab export can
support. This is the same reasoning as the per-person attribution decision below
- the concern there was that visible per-person metrics stop describing reality;
practice metrics are far more robust to that than output metrics.

## A verdict is withheld whenever its basis is missing

Applied in three places now, and it is the single rule that keeps this
defensible on a projector:

- **`loadVerdict`** withholds "within band" below two-thirds estimate coverage.
- **`sprintOutlook`** returns no landing verdict at all for a mostly-unestimated
  sprint, rather than projecting confidently from the estimated minority.
- **`teamHealth`** reports `unknown` per signal and never folds unknowns into an
  average.

The asymmetry is deliberate: the **warning** side is still reported when the
basis is partial, because a partial count that already exceeds the p90 is a
valid lower bound. Only the reassuring reading has to be earned.

There is also no single 0-100 health score. A composite invites an argument
about the weighting instead of about the work, and cannot be acted on; the
scorecard is five named signals, each with its own threshold, each explainable
by pointing at one row.

## Snapshots are immutable and dated, and `data/` is committed

The history is the product. Nothing else in the design can be reconstructed
after the fact, so a snapshot is written once per UTC day and never rewritten.

**Cost:** repository growth. One board of 1,225 issues is ~1.7 MB of JSON per
day, so ~600 MB/year for a single team. That is acceptable for a year or two and
then needs either compression, pruning of unchanged issues, or a move to object
storage. Revisit before adding the fifth team.

UTC, not local time, for the directory name: a run that straddles a DST change
or moves between machines would otherwise write two folders for one logical day,
and the gap only shows up later as a hole in a trend chart.

## Per-person attribution is ON

Decided by the manager who owns the tool, against the initial recommendation to
collect team-scoped data only.

The recommendation was to omit individual data entirely - not merely hide it -
because metrics that can be attributed to a person tend to stop describing
reality once they are visible upward. That concern is recorded here and not
raised again.

The mitigation actually built: `individualAttribution` is enforced at write time
in `toPerson`, so flipping it to `false` means no person-shaped field ever
reaches disk. Switching later needs a config change, not a rewrite - but it does
not retroactively clean snapshots already collected.

## Expectations are empirical, not declared

Forecasting will use a rolling median of the team's own last N sprints with a
p10/p90 band, rather than configured targets. Self-calibrating, honest about
variance, and nothing to negotiate.

**Cost:** it cannot tell you whether a team is hitting a commitment made to
someone else. If that becomes the question, a `expectations` block in the profile
config can be overlaid later - the snapshot schema does not need to change.

90 closed sprints exist on board 701, so there is ample history to calibrate
against from day one.

## Deterministic core, AI only at the edge

Nothing numeric involves a model. Every chart, threshold and finding is a pure
function of the snapshots, because the output has to survive being questioned by
senior management.

AI is reserved for four optional, cacheable jobs: classifying free-text work
type, comprehending Confluence prose, writing the exec narrative, and commenting
on anomalies the derive layer already found.

Note that `Emberwatch` shells out to the Claude Code CLI rather
than using an API key. That is fine for a scheduled job on a workstation and will
not work in CI - decide before the narrative layer is built.

## Field ids are discovered, never hardcoded

`discover-fields` resolves Sprint, Rank and Epic Link by their `schema.custom`
URI rather than by display name, because names are user-editable and localised.

Story points are the exception: both candidate fields are plain number fields
with no distinguishing schema, so name matching is unavoidable. **All** matches
are collected rather than the first, because this site has two
(`customfield_10006` "Story Points" and `customfield_11000` "Story point
estimate") and board 701 populates both - 668 issues in one, 22 in the other.
Reading only one would silently under-report velocity.

## Team-to-GitLab-group mapping is DERIVED, never requested

The manager who owns this tool does not know which GitLab groups belong to which
team. Finding that out is one of the reasons the tool exists. So the mapping is
something the tool works out and evidences, not an input it demands.

It was derived for board 701 like this, and the recipe generalises:

1. Expand the board name. `WEB Scrum` is what everyone calls the Storefront
   initiative; Jira's own project record for key WEB was never renamed and
   still reads Checkout Legacy.
2. Cross-match **Jira assignee display names to GitLab MR author display names**.
   This is only possible because `individualAttribution` is on - one of the
   concrete benefits of that decision.
3. Confirm the people exist in GitLab (`/users?search=`) before concluding their
   work is absent.
4. Search **all visible groups**, not just ones the token owner belongs to.

Applied to board 701 this moved the scope from `logistics-hub` (2 of 12 authors on
the board, 0 issue-key hits) to `web-storefront` (both top human authors
on the board, 13 issue-key hits). The reported "merged with no human review" went
from 15% to **58%** - same tool, same day, correct scope.

**Cost:** the mapping is evidence, not proof, and it needs re-checking when teams
move.

**It is a command now** - `suggest-groups`, eighth session - and it still writes
nothing. That is deliberate and worth stating as its own decision: the command
scores, ranks and shows its working, and a person reads the evidence and edits
the profile. Auto-writing a mapping would put a threshold in charge of which
team's name appears above every review metric in the report, and the thresholds
are hand-picked (see below). Run live against 70 groups it proposed exactly the
four mappings already configured and nothing else.

## Jira correlation works, but only as well as branch naming does

Measured per group, not assumed for the instance. In `web-storefront`,
13 of 55 human-authored merge requests carried a WEB key matching a board-701
issue.

**A zero here was misread once, and the correction is the durable lesson.** This
section originally recorded "0 of 230 merge requests in `logistics-hub` carried any
Jira key" and read that as a branch-naming problem. It was not: `logistics-hub` was
being tested against **WEB** keys, because it was then wrongly mapped to board
701. Tested against **LOG** keys - its actual board, 702 - it yields real hits.
So a zero key count is evidence that the group is mapped to the **wrong board**
at least as much as it is evidence about branch naming, and it must be checked
in that order. `suggest-groups` prints that diagnostic in exactly that order,
naming the project keys the group's merge requests *do* carry and which board
each belongs to (GOTCHA 15 in the handover).

So merge-request metrics are scoped to **GitLab groups**, and per-issue or
per-sprint attribution is offered only to the extent the keys are actually there.
`review --json` reports `withIssueKey` so the coverage is visible rather than
assumed, and low coverage reads as a finding about branch-naming discipline - a
process fix, not a code one - rather than as a broken tool.

## Review metrics exclude bot-authored merge requests from the denominator

The automated reviewer on this instance both opens merge requests and reviews
them. Left in the denominator it reported 248 of 460 merged with no human review
- 54%. But 221 of those 248 were opened by the bot: dependency bumps and
mechanical analyser fixes nobody intended a person to read. Over merge requests a
person opened, the same measurement is 27 of 225 - **12%**.

Both numbers are arithmetically correct. Only one of them answers "how well does
this team review its work", and the other would not have survived the first
question in a management meeting. So every rate in `src/review.ts` uses
human-authored merge requests, and the automation count is reported alongside
rather than silently dropped.

**Cost:** it depends entirely on `reviewBotAccounts` being right. GitLab's own
`bot` flag is undefined on these accounts, so there is no automatic check - a new
CI account that nobody adds to the list quietly re-inflates the number. Worth a
`quality` finding: an author with a high merge-without-review rate and no human
comments anywhere is probably automation.

## Human review means a comment or an approval, not an assignment

An assigned reviewer is an intention; a comment or an approval is an act. On this
instance 0 of 24 consecutively merged merge requests had a reviewer assigned at
all, so a metric keyed on assignment would report zero review everywhere and be
useless. Approval alone is a thin review, but it is a person taking
responsibility, and excluding it would overstate the problem in the other
direction.

## The OS trust store is unioned into Node's, not switched off

The internal GitLab presents only its leaf certificate, signed by an internal CA
that Windows trusts and Node does not. The obvious fix,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, disables certificate verification for the whole
process - including the Atlassian calls - and would accept an intercepted
connection silently.

Instead `src/tls.ts` adds the machine's trust store to Node's default roots at
startup. This is strictly additive: it can only make more chains verifiable,
never fewer, and verification stays on.

**Cost:** it needs Node 22.15+ for `tls.setDefaultCACertificates`. On anything
older the tool warns and points at `--use-system-ca` or `NODE_EXTRA_CA_CERTS`
rather than failing. Doing it in-process rather than via a flag is deliberate: the
daily run is launched by Task Scheduler, and a flag that has to be threaded
through the scheduled action is a flag that gets lost - and its absence looks
exactly like a network outage.

## MR-to-issue correlation needs the known project keys

Jira's own `Development` field (`customfield_10900`) was empty on every issue
sampled, so merge requests are correlated to issues by parsing keys out of the
title and branch name.

The key pattern alone cannot be made safe: `V2-3` in "bump to V2-3" is a version
string, but it is also a syntactically valid Jira key, because Jira permits
two-character keys containing digits. No regex separates them. So the collector
passes the set of project keys actually present in the Jira snapshot it just
collected, and everything else is discarded.

## A model may DESCRIBE the numbers and must never COMPUTE one

The seventh session added a hand-off layer (`src/report/briefing.ts`): the report
embeds a compact digest of the derived model plus five ready-made prompts, and a
banner telling the reader to paste one into Claude.

This is deliberately **not** "adding AI to the tool". Nothing in the pipeline
calls a model, a daily run still costs zero tokens, and every figure in the
report is still computed by a pure function from a dated snapshot. What changed
is that the report now hands a reader everything needed to ask for the
*narrative* — what a workstream is for, what a comment thread is really about,
what to say in Thursday's steering committee — which is the one thing the
deterministic layers genuinely cannot produce, because that context is not in
Jira.

**The boundary is the decision.** A model describing a number that the tool
computed is a summary. A model computing a number is an unfalsifiable claim
wearing a summary's clothes, and this report is read by people whose job is to
question it.

Three mechanisms enforce it:

- The digest carries only figures the derive/insights/review/history/taxonomy
  layers already produced, each with its caveat attached.
- The trustworthiness rules are duplicated **into the prompt text itself**, not
  merely referenced from the JSON. The prompt gets pasted into a chat window on
  its own; a guardrail that only exists in a block the reader did not paste is
  not a guardrail.
- The rules name the specific traps rather than gesturing at care: never quote
  `committedPoints` for a closed sprint, never compare story points across
  boards, never rank people, a null means not-measurable and never zero.

**Cost:** the prompts are a maintenance surface. If a metric's basis changes and
the prompt text is not updated, the guardrail goes stale silently. That is
accepted because the alternative — a reader pasting the raw report into a model
with no rules at all — is strictly worse and was already happening.

## The digest honours `--no-embed-data`, because small is not the same as safe

The briefing digest is ~70 KB against ~2.1 MB for the full model, and the first
implementation shipped it unconditionally on the reasoning that it is small and
is the whole point of the feature.

That was wrong and was corrected before it shipped. The digest is smaller but it
is **not less sensitive**: it carries people's names, their current load, who
reviews whose work, and verbatim comment text. Somebody passing
`--no-embed-data` before emailing the file to a wider audience asked for that
data to be *out of the file*, not to be *smaller*. Both islands are now
suppressed together, and the banner renders a short "no data is embedded" note
instead of five buttons that would silently do nothing.

The general rule this instance of: **a size optimisation is not a privacy
control, and a flag means what its user thought it meant.**

## A mapping proposal needs one axis STRONG, not two axes positive

`suggest-groups` scores a group against a board on two axes - merge requests
carrying a key that matches a real issue on the board, and the share of the
group's human MR authors who are assignees on it - and proposes only where both
agree. The threshold shape is the decision, and it was forced by the data:

| team | group | key hits | matched authors |
|---|---|---|---|
| `fs` | `payments-core` | 36 | 8 of 11 (73%) |
| `fcp` | `onboarding-hub` | 21 | 5 of 7 (71%) |
| `panther` | `web-storefront` | 11 | 2 of 2 (100%) |
| `tran` | `logistics-hub` | **2** | **6 of 8 (75%)** |

All four are confirmed correct by hand. `logistics-hub` - the best-evidenced
mapping on the estate - has **two** key hits, which is fewer than `gateway-common`,
a shared group that must never be proposed. So a bar on key hits alone rejects
the best mapping, and a bar on percentages alone accepts the worst: `gateway-common`
scores a 100% author share because it has two authors and both work on WEB.

So: one axis must clear an **absolute** bar (5+ key hits, or 3+ matched authors)
while the other is merely present, and the two must point at the same board.

**Cost:** the numbers 5 and 3 are hand-picked. They are calibrated so that
nothing rejected by hand can be proposed and nothing confirmed by hand is
rejected, which is the best available basis, but it is four data points. This is
recorded as an open item rather than presented as tuning, and it is one more
reason the command proposes and never writes.

## A group matching several boards weakly is a rejection, not a weak proposal

Shared infrastructure is only visible from the cross-board view, which is why
every group is scored against every board in one pass rather than per team.
`shared-platform` looks like a plausible home for any single team
tested against it on its own; scored against all four it matches one or two
people on each of them and no board's key evidence stands out. That shape -
breadth without depth - is reported as SHARED with an explicit "do not configure
this against a team", because configuring it would attribute four teams' work to
whichever board happened to edge it and move every one of that team's review
rates.

The same discrimination kept `PB - Shared Board` out of the Confluence mapping
(it scored highest for `fs` and also scored for `tran` and `fcp`), so this is one
rule applied in two places rather than a GitLab special case.

## A plain load lands on the neutral overview, not on an accidentally-chosen team

Opening a freshly generated report used to open one team's tab immediately and
rewrite the URL to match, and the team it picked was whichever project prefix
sorted first alphabetically (`LOG < ONB < PAY < WEB`) - an artefact of
`groupByPrefix`, not a judgement about which team needed looking at. Reported
live as "why is `#team=tran` baked into the browser".

Two real defaults were considered:

- **Default to the worst-health team**, reusing the triage banner's own
  ordering (poor > watch > unknown > good, most act-now items first). Matches
  the tool's own priority - "where do I need to look" - and needs no extra
  click on the common case.
- **Land on the neutral overview**, opening no team tab until the reader picks
  one. The report already has team-neutral content above the tabs - Act on
  this, the triage banner, the portfolio table - so this treats that as the
  real landing page rather than something the reader has to scroll past to
  reach it.

**The neutral landing page was chosen.** A default that opens the worst team
is still a default the tool asserted on the reader's behalf, and the estate
overview it would bypass is exactly the page built to answer "where do I look
first" without picking one team over the others. A `#team=<key>` link - typed,
bookmarked, or shared - still opens straight to that team, and an unrecognised
key in the hash still falls back to the first tab rather than showing nothing,
because that reader arrived with a specific intent a stale link failed to
serve.

**Cost:** the estate view is one extra look before a specific team's detail,
even for the reader who always goes straight to the same board. If that turns
out to cost more clicks than the old default saved, the worst-health default
is one line to build - `triageBanner`'s sort in `src/report/index.ts` is
already shaped for it - and is recorded here as the alternative that was
seriously on the table, not dismissed.

## An alert answers "what changed", and the report stays the whole picture

The intervention feed carries 37 findings above the `this-week` floor across the
four teams on any given day, and most of them are the same findings as
yesterday. An alert layer that sent them would be muted inside a week, and the
one act-now item that appeared this morning would be muted with it.

So `alert` sends only what is **new**, what has got **worse**, or what was
present yesterday and never actually reported. Everything else is counted in the
status line and not repeated. The full standing list stays where it has always
been: the "Act on this" panel of the report.

**Two sources answer two different questions, and both are needed.**

- **"Is this new?"** - by diffing today's derived feed against the previous
  collected day's. This is the honest answer, because two immutable snapshots
  exist to compare and neither can be restated after the fact.
- **"Have we already said it?"** - by a state file. No snapshot records that a
  message was sent.

The diff alone re-posts everything the second time the command runs in a day.
The state alone cannot tell a first run from a quiet day, and cannot see that a
threshold crossed yesterday and still crossed today is not news.

**Cost:** the state file is mutable, which is the first mutable artifact in a
tool built on immutable ones. It is kept beside the snapshots (`<data>/<profile>/
alert-state.json`) rather than in the profile, because it describes a particular
collected series rather than the site's configuration - point `--data` elsewhere
and the alert history goes with the snapshots it was derived from. Deleting it
re-seeds; nothing else breaks.

**Amended: the report now answers "what changed" too, and does not need the
alert path switched on to do it.**

The reasoning above is about what an alert may SEND. It is right, and it is
unchanged. But the comparison it rests on - today's derived feed against the
previous collected day's, each computed against its own capture time - is a
fact about two immutable snapshots, and it was only ever reachable through a
channel that has to be configured, enabled and read somewhere else. On a profile
with no Slack token, the answer was computed every run and thrown away.

So `diffInterventions` (src/changes.ts) is that same comparison with none of the
sending decisions attached: no allowlist, no severity floor, no per-run cap, no
state file. The report has room for a legend, which is the only reason the alert
path needs an allowlist at all.

The two are still different questions and both are still needed. The panel
answers "is this new?" from the snapshots. The alert additionally answers "have
we already said it?" from its state file, and nothing here changes that.

## The first alert run records a baseline instead of firing everything standing

With no state file, every one of those 37 standing findings looks new. Sending
37 messages is the fastest possible way to have the channel muted before the
feature has ever been useful, and none of those 37 is actually news - they are
all already in the report.

So a first run records them all, sends one summary line saying so, and starts
alerting properly from the next run. `--resend` is the deliberate escape hatch
for "put today's top findings in the channel now", and it labels them
`re-sent on request` rather than claiming they were never reported.

**Cost:** a genuinely urgent finding that exists on the day the feature is
switched on is not raised by that first run. That is the intended trade - it is
visible in the report, and `--resend` exists - and it is much better than the
alternative failure, which is a channel that has learned to ignore this tool.

## The alertable kinds are an ALLOWLIST

A message has no room for a trustworthiness legend, and the handover's rule -
never promote a WEAK or UNUSABLE figure into a summary without fixing its basis
first - has no teeth if any new intervention kind is alertable by default.

`ALERTABLE_KINDS` in `src/notify/digest.ts` is therefore explicit, and a new kind
has to be added to it deliberately. Excluded today:
`comments-not-collected` (a coverage gap, not a finding - it travels as the run's
freshness line), `no-goal` and `wip-overload` (both real, both worth raising at
planning, neither worth an out-of-band interruption).

**Cost:** a kind added to `interventions.ts` and not to the allowlist is silently
un-alertable. That is the right direction to fail in, and `test/notify.test.ts`
asserts the current contents so the list cannot drift unnoticed.

## The basis is IN the message, not in the report the message links to

The same rule as the briefing digest, applied to a smaller and more dangerous
surface. A Slack message gets forwarded on its own, with no page to scroll and no
legend underneath, and the sentence being defended against is a real one: "fs is
at 97% unestimated" becoming "fs has no capacity left".

So each alert carries the basis notes that apply to *its* figures - estimate
coverage for anything quoting points, the human-authored denominator for a review
rate, the wall-clock interval for a churn figure - and says what the number is
*not*, in the same breath as what it is.

Attaching all of them to every message was rejected: four notes on every alert is
boilerplate, and boilerplate is not read, which fails exactly the same way as
having no caveat at all. `KIND_CAVEATS` maps kind to the notes that apply.

## Nothing in the alert path creates a page, and nothing in it computes a number

Two refusals in the same decision.

The Confluence writer appends to a page whose id is configured. It does not
create the page, and it does not go looking for one: a tool that invents pages in
a shared wiki is a tool nobody trusts with credentials. (It will build the log
TABLE inside a page that has none, because pointing the profile at a fresh empty
page is the natural first step and "your page has no `<tbody>`" is a poor answer
to it.)

And the notify layer formats and routes; it never calculates. Every figure in an
outgoing message is a string the derive layer already produced. That is pinned
mechanically rather than by good intentions: `test/notify.test.ts` asserts that
**every digit in a rendered alert body appears in the intervention text it came
from**, so arithmetic introduced into the formatter fails the build.

## The schema STAMP and the field COVERAGE are checked separately

A snapshot's declared `schemaVersion` says which code wrote it. It does not say
what that code was asked to collect: `collect --no-issue-detail` writes a
snapshot stamped at the current version carrying none of that version's content.
Since the failure being defended against is a report that looks finished while
109 panels say "not collected", a stamp check alone reproduces the bug it was
added to catch.

So `assessSchema` asks both questions and reports them as different problems with
different fixes - re-collect, versus drop a `--no-...` flag.

**Cost:** the coverage check has to know where each field is expected, and that
knowledge duplicates the collector's own scoping rules. Comments are gathered for
active-sprint work only, so the check counts against active-sprint work only; if
the collector's scope changes and this does not, the check either goes quiet or
cries wolf. `test/schema.test.ts` pins the scoping, and `SCHEMA_HISTORY` is
pinned to `SCHEMA_VERSION` so a version bump with no description fails the build.

## The roster is a contact sheet, not a scorecard

`taxonomy.roster` reports, per person: open issues held, open issues in an active
sprint, points, flagged items, recently resolved, recently raised, merge requests
authored, and reviews given.

That is a lot of per-person columns for a codebase that explicitly refuses to
measure per-person productivity (see "Per-person PRACTICE is reported;
per-person PRODUCTIVITY is not"). The distinction is that these columns answer
**"whose ticket is this, and where else do they work"** — the question a manager
asks twenty times a week and currently answers by interrupting somebody.

Why it cannot be read as performance, stated on the panel itself rather than
only here:

- Jira's assignee field records who holds a ticket **today**, not who did the
  work. "Resolved" credits whoever holds it now.
- Merge-request counts vary by an order of magnitude between a team that squashes
  and one that does not.
- The person who spends a day unblocking two colleagues scores zero on every
  column.

So the columns are reliable for *finding people* and unreliable for *ranking*
them, and the panel says exactly that in its footnote. Sorting is offered on
every column because withholding it would not stop anyone drawing the wrong
conclusion — stating the reason plainly, next to the numbers, has a better chance.

**Related:** Jira and GitLab identities are joined by display name, because the
two systems share no id on this instance. Somebody who spells their name
differently in each appears as two rows, labelled "Jira only" and "GitLab only".
That is reported honestly rather than resolved by fuzzy matching, which would
silently merge two real people who happen to share a surname.

## GitLab and GitHub share one snapshot shape, not one code path

The review half can read GitLab merge requests or GitHub pull requests, chosen
per profile with `"forge"`. The two APIs are genuinely different - GitHub has no
nested groups, paginates by `Link` header, and models state as `open`/`closed`
plus a separate `merged_at` - so there are two collectors (`src/gitlab/collect.ts`,
`src/github/collect.ts`), not one with branches inside it.

What they share is the **output**: both emit the same `MergeRequestSnapshot` /
`ReviewSignals` into the same `gitlab.json` slot, and `normaliseGithubPr` maps a
merged PR onto GitLab's `state: 'merged'` string on the way out. So `review.ts`,
`history`, the report and `alert` have no `if (github)` anywhere - they read
`mergeRequests` and do not know which host produced them. The snapshot file keeps
the name `gitlab.json` regardless of forge, on purpose: renaming it per forge
would fork the schema and every reader for a cosmetic gain.

**GitHub bot detection is not configuration-only.** GitLab's `reviewBotAccounts`
list exists because a self-managed CI account is indistinguishable from a person
in the API. GitHub exposes `user.type === "Bot"` and a `[bot]` login suffix, so
`dependabot[bot]` and friends are caught with no config; the list is kept only
for service accounts someone created as an ordinary user.

**`discover-groups` / `suggest-groups` stay GitLab-only.** They exist because a
GitLab group is a variable-depth path you have to discover and map to a board.
GitHub repos are flat `owner/repo` - you already know them - so those commands
refuse on a `forge: github` profile and point at `teams[].githubRepos` instead.
