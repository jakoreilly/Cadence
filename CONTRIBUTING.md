# Contributing

## Run it

```sh
git clone https://github.com/jakoreilly/Cadence && cd Cadence
npm install && npm run build

# See the full report with no Jira/GitLab credentials at all:
node scripts/build-fixture.mjs
node dist/src/cli.js report --profile profiles/fixture --out sample.html
```

```sh
npm run lint    # eslint src
npm run build   # tsc
npm test        # node --test, 263+ tests, no network
```

Node 22 or 24 (CI matrix). Everything is tested against value shapes observed
live on a real Jira/GitLab instance - see the fixture and test comments before
inventing a new one.

## The rules this project actually has

**Deterministic core, AI only at the edge.** Nothing that produces a number,
threshold or finding may involve a model - the whole point is that the output
survives being questioned by senior management. `report`'s embedded briefing
digest and prompts are the only place a model is invited in, and only to
narrate figures the derive layer already computed, never to compute them. See
[docs/decisions.md](docs/decisions.md#deterministic-core-ai-only-at-the-edge).

**Field ids are discovered, never hardcoded.** `discover-fields` resolves
Sprint/Rank/Epic Link by schema URI because display names are user-editable
and localised. If you're tempted to hardcode a `customfield_NNNNN`, don't -
it will be wrong on the next Jira site someone points this at.

**Status names never drive logic.** Every metric keys on `statusCategory`
(`To Do` / `In Progress` / `Done`), never on the literal status string. Real
sites have four different "Done" statuses and a "Product Owner Review" that
Jira categorises as *To Do* - see the README section on this before adding
anything that switches on `status`.

**A verdict is withheld when its basis is missing**, never guessed. If you add
a new computed figure, decide up front what happens when the underlying data
is mostly absent - "not comparable" or "not measured yet" beats a confident
number quietly built from 3% coverage. See
[docs/decisions.md](docs/decisions.md#a-verdict-is-withheld-whenever-its-basis-is-missing).

**No per-person productivity metric, ever.** Per-person *practice* (merged
without review, reviews given) is reported with visible denominators. Points,
throughput or any ranking derived from story points per person is not, and a
PR that adds one will be asked to read
[docs/decisions.md](docs/decisions.md#per-person-practice-is-reported-per-person-productivity-is-not)
first.

**Individual attribution is enforced at write time.** `individualAttribution:
false` in a profile means no person-shaped field reaches disk, not just that
it's hidden later. If you add a new field carrying a name, gate it through the
same switch in `toPerson` - don't add a second place person data can leak from.

**Chart.js may draw, never compute.** Every number a chart plots must also be
written out as text in the same HTML, so a blocked inline script degrades the
report to readable tables, not blank panels.

## Adding a data-quality finding or a review metric

Say what it costs before you add it. Every existing finding and the trends
table's Sound/Weak/Unusable labels exist because someone asked "what happens
when the data behind this is thin" and wrote the answer down in
[docs/decisions.md](docs/decisions.md). A new finding without that paragraph
is half-finished.

## Style

Match what's there: 2-space indent, TypeScript strict mode, no framework, no
runtime dependency beyond the vendored Chart.js. Prefer a plain function over
a class. Comments say *why*, and name the bug or the live gotcha that forced
the decision - a comment describing what the next line does is noise.

## Tests

Value shapes in test fixtures are calibrated against real observed data
(field ids, status vocabularies, the shape of a bulk changelog response), not
invented ones - see the comment at the top of `test/collect.test.ts` and
`test/schema.test.ts`. If you're adding a normaliser, prefer a fixture shaped
like something Jira or GitLab actually returns over a minimal synthetic one.

## Pull requests

Say what changed and why, grouped by intent rather than file by file, and call
out anything with a data-trust or privacy consequence. If you touched a
decision recorded in `docs/decisions.md`, say so explicitly rather than
letting the diff speak for itself.
