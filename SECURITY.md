# Security

Cadence reads Jira and GitLab (or GitHub) with a read-only token, writes dated
snapshots to disk, and renders them into a report that can name individuals
and their review habits. There is no server, no hosted component and no
runtime network call outside collection itself. This document is about what
that data can do if handled carelessly, not about a service with a public
attack surface.

## Threat model

| Threat | Covered? | How |
|---|---|---|
| A leaked Atlassian/GitLab/GitHub/Slack token | **Partly** | Tokens live in `profiles/<name>/secrets.local.json`, gitignored via `*.local.json`, or in env vars - never in a committed config. Cadence never logs or prints a token. Rotation and scope are the token issuer's job; give the Atlassian token read-only access, GitLab `read_api`, GitHub `pull requests: read`. |
| The report leaking per-person data to the wrong audience | **Partly** | `individualAttribution` is enforced at **write** time in `toPerson` - off means no name-shaped field ever reaches a snapshot, so it cannot leak from the report either. On, the report and its embedded JSON both carry names; `--no-embed-data` drops the embedded copy but not the rendered tables. Treat a generated report as containing the same data as the profile's `individualAttribution` setting implies, and hand it out accordingly. |
| Findings about a named individual reaching a shared channel | **Yes, by contract** | `alert` is a discreet, personal review tool. Nothing is posted to Slack or Confluence unless `config.alerts.*.enabled` is explicitly set **and** the person running it decided to, that run, regardless of what was configured before. A past "yes, send it" is not standing authorization - see the README's Alerting section. |
| A self-hosted GitLab with an internal CA | **Yes** | Cadence unions the OS trust store into Node's default roots (`src/tls.ts`) rather than disabling certificate verification. Verification stays on for every request, Atlassian included; nothing is accepted merely because it presents *a* certificate. |
| Snapshot history on disk | **No sandboxing** | `data/<profile>/` is a directory of JSON on your filesystem with the same protection as the rest of your files, not encrypted at rest. With `individualAttribution` on, it is the durable copy of who did what. Protect the directory the way you'd protect an HR export, not a build cache. |
| A model reading collected data | **N/A by design** | Nothing that computes a figure, threshold or finding calls a model. The only place a model is invited in is narrating a report's own embedded digest, at the reader's initiative - see [docs/decisions.md](docs/decisions.md#deterministic-core-ai-only-at-the-edge). If you wire that up yourself, whatever you paste into the model sees exactly what's in that digest, including names if attribution is on. |

## Credentials

- `profiles/<name>/secrets.local.json` - gitignored via `*.local.json`, never
  committed. Copy `secrets.example.json` and fill it in, or skip the file
  entirely and use env vars (`ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`,
  `ATLASSIAN_API_TOKEN`, `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITHUB_TOKEN`,
  `GITHUB_BASE_URL`, `SLACK_TOKEN`) so a scheduled run needs no file on disk.
  Env vars win when both are present.
- Every token needs **read-only** scope. Nothing Cadence does writes back to
  Jira, GitLab, GitHub or Slack except posting an alert message, which is
  opt-in and explicit as above.
- `prompts/full-depth.md` and `prompts/deep-dive.md` instruct a model reading
  a generated report to never read, quote or reason about
  `secrets.local.json`. That's an instruction to the model, not an access
  control - the file's real protection is that it's gitignored and that
  Cadence itself never embeds its contents anywhere.

## Data at rest

| Path | Contents | Notes |
|---|---|---|
| `profiles/<name>/config.json` | teams, board ids, group mappings | non-secret, safe to commit |
| `profiles/<name>/secrets.local.json` | API tokens | gitignored, never commit |
| `data/<profile>/<date>/*.json` | collected snapshots | per-person data if `individualAttribution` is on; not gitignored in a real install because the history is the product |
| `data/<profile>/alert-state.json` | what has already been alerted on | non-secret |
| `reports/*.html` | rendered command centres | carries whatever the snapshots carry; gitignored in this template |

## Reporting a vulnerability

Open a private security advisory on the repository, or open an issue asking
for a private channel if advisories aren't available. Please don't open a
public issue that describes how to extract a token or personal data from a
real deployment.

Things that are **not** vulnerabilities, because they're the documented design:

- A token with read access can read everything that token's scope allows -
  that's the token issuer's access control, not Cadence's.
- With `individualAttribution` on, the snapshot and report contain names by
  design; turning it off is the mitigation, not a bug that it defaults on for
  a manager who explicitly asked for per-person practice metrics.
- `alert` sending nothing until Slack/Confluence are explicitly enabled is
  intentional, not a missing feature.
