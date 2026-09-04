## What this changes

<!-- One or two sentences. If it fixes an issue, "Fixes #123". -->

## Why

<!-- The problem, not the patch. -->

## Testing

- [ ] `npm run build && npm test` passes (263+ tests, no network)
- [ ] `npm run lint` passes
- [ ] New behaviour has a test, or this changes no behaviour

<!-- Anything checked by hand against a real Jira/GitLab/GitHub instance is
     worth a line here - most of this codebase's gotchas were found that way. -->

## Checklist

- [ ] Nothing that computes a number, threshold or finding calls a model (see `docs/decisions.md`)
- [ ] No new per-person metric derived from story points (see `docs/decisions.md`)
- [ ] Field ids are discovered, not hardcoded, if this touches Jira collection
- [ ] No tokens, real hostnames, real board/project identifiers, or real names in the diff
