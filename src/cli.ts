#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import { loadConfig, loadFieldMap, saveFieldMap } from './config.js';
import { loadSecrets } from './secrets.js';
import { createJiraClient, DEFAULT_ATLASSIAN_IN_FLIGHT } from './jira/client.js';
import { discoverBoards, discoverFields } from './jira/discover.js';
import { changelogScope, issuesNeedingChangelog, keptFields } from './jira/changelog.js';
import { changelogTargets, fetchChangelogs } from './jira/changelogFetch.js';
import { appendChangelog, readChangelogStore } from './changelogStore.js';
import { collectTeam } from './jira/collect.js';
import { collectTeamMergeRequests, DEFAULT_REVIEW_CONCURRENCY } from './gitlab/collect.js';
import { collectTeamPullRequests } from './github/collect.js';
import { discoverGroups, formatGroups } from './gitlab/discover.js';
import {
  boardFacts,
  collectActivity,
  formatSuggestions,
  knownProjectKeys,
  scoreGroups,
} from './gitlab/suggest.js';
import { listSnapshotDates, readSnapshot, snapshotDate, snapshotDir, SnapshotExistsError, writeSnapshot } from './snapshot.js';
import { ConfigError } from './config.js';
import { assessSnapshot, formatQualityReport } from './quality.js';
import { DEFAULT_SPRINT_WINDOW, deriveTrends, formatTrends } from './derive.js';
import { deriveReview, formatReview } from './review.js';
import { activeLoad, backlogSummary, buildReport, carryoverLeaders, projectPrefixes, type ReportTeamInput } from './report/index.js';
import { attentionItems, practiceByPerson, slowestResolved, sprintOutlook, teamHealth } from './insights.js';
import { formatHistory, seriesByTeam, teamHistory, type TeamHistory } from './history.js';
import { loadProjectedDays } from './loadHistory.js';
import { epicRollups, estateEpics } from './epics.js';
import { estatePeople } from './people.js';
import { buildFeed } from './notify/feed.js';
import { diffInterventions } from './changes.js';
import { compositionBySprint, wipSummary } from './flow.js';
import { interventions } from './interventions.js';
import { blockerGraph, flaggedRegister, mostDiscussed, roster, subtaskStructure, taxonomy } from './taxonomy.js';
import { gitlabOriginFrom } from './links.js';
import { collectTeamContext, discoverSpaces, formatSpaceScores, projectKeysOf } from './confluence/collect.js';
import { SCHEMA_VERSION, type ConfluenceSnapshot, type GitLabSnapshot, type JiraSnapshot } from './types.js';
import { assessSchema, formatSchemaWarning } from './schema.js';
import { formatPlan, runAlerts } from './notify/index.js';
import { trustSystemCertificateAuthorities } from './tls.js';
import { droppedTeamsOnForce, mergeCollectedTeams } from './mergeTeams.js';
import { archiveProfile, formatArchiveResult } from './archive.js';
import { narrowOptional, narrowToTeam, numericFlag, parseArgs } from './args.js';
import { existsSync, writeFileSync } from 'node:fs';

const USAGE = `Usage: cadence <command> --profile <dir> [options]

  discover-fields             Resolve this site's custom field ids and cache them in the profile
  discover-boards [--project KEY]
                              List Agile boards, so teams[] can be filled in with real board ids
  discover-spaces [--team KEY]
                              Score every Confluence space by how often each board's project keys
                              appear in it, so teams[].confluenceSpaces can be filled in from
                              evidence rather than guessed. Needs a collected snapshot.
  discover-groups [--search TEXT] [--window N] [--members-only]
                              List GitLab groups the token can see, with recent MR activity,
                              so teams[].gitlabGroups can be filled in with real group paths
  suggest-groups [--window N] [--search TEXT] [--pages N] [--all] [--json]
                              Score every visible GitLab group against every configured board on
                              two axes - merge requests carrying a key that matches a real issue on
                              the board, and the share of the group's human MR authors who are
                              assignees on it - and show the evidence for each. Proposes only where
                              both axes agree, and names shared/infrastructure groups as such
                              rather than proposing them. Writes nothing. Needs a collected snapshot.
  collect [--date YYYY-MM-DD] [--no-gitlab|--no-github] [--gitlab-only|--github-only]
          [--no-review-detail] [--no-issue-detail] [--no-confluence] [--team KEY]
          [--no-changelog] [--no-bulk-changelog]
          [--force] [--review-concurrency N] [--jira-in-flight N]
                              Write today's immutable snapshot under --data (default ./data).
                              Reads GitLab merge requests, or GitHub pull requests when the
                              profile sets "forge": "github" (--no-github / --github-only are
                              accepted as aliases of the --*-gitlab flags either way).
                              Refuses to overwrite a jira.json that already exists for the day
                              unless --force; snapshots are the product and cannot be backfilled.
                              --no-issue-detail skips descriptions, comments and epic names, which
                              are what the report's hover cards and blocker scan are built on.
                              --review-concurrency sets how many merge requests have their review
                              detail fetched at once (default 6). It changes only how LONG the run
                              takes, never what it writes; 1 is the old strictly sequential pass.
                              --jira-in-flight is the ceiling on concurrent Atlassian requests
                              shared by every pass in the run - the board sweep, field discovery
                              and Confluence, which is the same host and the same rate limit
                              (default 4). 1 restores the strictly sequential Atlassian run.
                              --no-changelog skips the changelog delta (which only runs at all
                              once the profile has been through backfill-changelog);
                              --no-bulk-changelog keeps it but forces the one-request-per-issue
                              path instead of the bulk endpoint.
  backfill-changelog [--date YYYY-MM-DD] [--team KEY] [--window N] [--no-bulk-changelog] [--jira-in-flight N]
                              One-off: populate the Jira changelog store for the issues in the
                              last --window closed sprints (default ${DEFAULT_SPRINT_WINDOW}), plus every active
                              and future sprint. This is the ONLY thing here that can see before
                              the first snapshot - a changelog entry carries its own Jira
                              timestamp - so it is what makes work-start, and therefore true
                              cycle time, available retroactively. Stored once per board under
                              data/<profile>/changelog/<boardId>.json and appended to, never
                              restated. Fetches in bulk where the site supports it - roughly 19
                              requests where the per-issue path needs 1,892 - and falls back on
                              its own if it does not. Running it once is also what arms the
                              daily delta inside collect.
  quality [--date YYYY-MM-DD] [--stale-days N] [--team KEY] [--json]
                              Data-quality report for a collected snapshot
  trends [--date YYYY-MM-DD] [--window N] [--recent N] [--team KEY] [--json]
                              Per-sprint delivery metrics and empirical forecast
  review [--date YYYY-MM-DD] [--list N] [--team KEY] [--json]
                              Merge-request review latency - the only leading indicator here
  history [--team KEY] [--json]
                              Snapshot-to-snapshot metrics a single day cannot give: observed scope
                              churn, real burndown, and true cycle time. Needs two collected days.
  report [--date YYYY-MM-DD] [--out FILE] [--report-window N] [--no-embed-data]
         [--team KEY] [--stale-days N] [--window N]
                              Write a single self-contained HTML report (default ./report.html).
                              --team narrows the whole page to one board, which is the quick way to
                              hand somebody the section that concerns them and nothing else.
                              Embeds the full derived model as machine-readable JSON unless
                              --no-embed-data; the rendered page is truncated for readability.
  alert [--date YYYY-MM-DD] [--dry-run] [--slack] [--confluence] [--limit N] [--resend]
                              Send the ranked, evidence-carrying findings from "Act on this" to Slack
                              and/or a Confluence log page - but ONLY what is new or has got worse.
                              Novelty is decided by diffing the day's intervention feed against the
                              previous collected day's, each computed against its own capture time;
                              what has already been sent is recorded in <data>/<profile>/alert-state.json
                              so a restart or a second run in the day repeats nothing. The first run
                              records a baseline instead of firing everything standing.
                              --dry-run decides and prints, sends nothing, writes no state.
                              --resend ignores what has already been said and sends today's top
                              findings anyway - for the first run against a new channel.
  dates                       List collected snapshot dates for the profile
  archive [--older-than-days N] [--dry-run] [--json]
                              Compress snapshots older than N days (default 90) IN PLACE -
                              jira.json becomes jira.json.gz in the same dated folder. Nothing is
                              ever deleted or moved out of data/<profile>/<date>/, so every command
                              that reads history keeps seeing every day; only its size on disk
                              shrinks. --dry-run reports what would be compressed and touches nothing.

Options: --profile <dir> (required for all but --help), --data <dir> (default ./data)`;

/** Every collected day for a profile, as per-team series.
 *
 *  GOTCHA: a date whose jira.json is missing is skipped, not treated as an empty
 *  board. `collect --gitlab-only` writes no jira.json of its own and a failed
 *  Jira run leaves the day without one; reading either as "zero issues" would
 *  invent a total wipe of the sprint followed by a total re-add on the next day,
 *  which is the single loudest false finding this command could produce. */
function loadHistories(
  dataDir: string,
  profileName: string,
  teamKey?: string,
  /** Ignore collected days AFTER this one.
   *
   *  GOTCHA: `report --date X` pins every other panel to that snapshot - `asOf`
   *  is its own `capturedAt`, so nothing else on the page re-ages - and the
   *  history panels were reading the whole of `data/` regardless. Regenerating
   *  a report for an earlier day therefore mixed in observations recorded
   *  AFTER it: caught live the morning the eighth day landed, when
   *  `report --date 2026-09-01` reported "7 day-to-day comparisons" for a
   *  snapshot that only had six behind it, and would have drawn a burndown
   *  point past the date on its own masthead. A report that describes a
   *  snapshot must not be able to see the future of that snapshot.
   *
   *  `notify/feed.ts` has always bounded its history for the same reason,
   *  recorded there: an alert feed built from days the reader could not have
   *  known about is not comparable with the previous day's. Undefined means "all
   *  collected days", which is what the `history` command wants - it has no
   *  --date and its whole subject is the full series. */
  upToDate?: string,
): TeamHistory[] {
  // Every collected day, projected down to the ten fields the history metrics
  // read and cached in that reduced form - see loadHistory.ts for why neither
  // "cache the whole parse" nor "re-parse every time" is the right answer.
  const series = seriesByTeam(loadProjectedDays(dataDir, profileName, upToDate));
  const out: TeamHistory[] = [];
  for (const [key, days] of series) {
    if (teamKey && key !== teamKey) continue;
    out.push(teamHistory(days));
  }
  return out.sort((a, b) => a.team.localeCompare(b.team));
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return;
  }

  // Must happen before any network call. The internal GitLab is signed by an
  // internal CA that Windows trusts and Node does not - see src/tls.ts.
  const trust = trustSystemCertificateAuthorities();
  if (!trust.applied) console.error(`warning: could not load the system trust store - ${trust.reason}`);

  const profileDir = resolve(flags.profile ?? process.cwd());
  const profileName = basename(profileDir);
  const dataDir = resolve(flags.data ?? 'data');
  const now = new Date();

  switch (command) {
    case 'discover-fields': {
      const client = createJiraClient(loadSecrets(profileDir));
      const map = await discoverFields(client, now.toISOString());
      saveFieldMap(profileDir, map);
      console.log(JSON.stringify(map, null, 2));
      if (map.storyPoints.length === 0) {
        console.error('\nWARNING: no story-point field found. Velocity metrics will be unavailable.');
      } else if (map.storyPoints.length > 1) {
        console.error(
          `\nNote: ${map.storyPoints.length} story-point fields exist on this site (${map.storyPoints.join(', ')}). ` +
            `All are read, in that order.`,
        );
      }
      return;
    }

    case 'discover-boards': {
      const client = createJiraClient(loadSecrets(profileDir));
      const boards = await discoverBoards(client, flags.project);
      for (const b of boards) {
        console.log(
          `${String(b.id).padStart(6)}  ${(b.type ?? '?').padEnd(7)}  ${(b.projectKey ?? '-').padEnd(8)}  ${b.name}`,
        );
      }
      console.error(`\n${boards.length} board(s).`);
      return;
    }

    case 'discover-groups': {
      if (loadConfig(profileDir).forge === 'github') {
        throw new Error(
          'discover-groups is GitLab-only. GitHub identifies repos as plain owner/repo with no nested groups - ' +
            'list them directly in teams[].githubRepos in the profile config.',
        );
      }
      const secrets = loadSecrets(profileDir);
      if (!secrets.gitlabBaseUrl || !secrets.gitlabToken) {
        throw new Error('discover-groups needs gitlabBaseUrl and gitlabToken in secrets.local.json (or GITLAB_BASE_URL / GITLAB_TOKEN)');
      }
      // Default to the profile's own collection window so the activity column
      // answers the question that actually matters: would configuring this group
      // put anything in tomorrow's snapshot?
      const windowDays = numericFlag(flags, 'window', loadConfig(profileDir).gitlabWindowDays);
      const groups = await discoverGroups(secrets, {
        windowDays,
        search: flags.search,
        membersOnly: flags['members-only'] === 'true',
      });
      console.log(formatGroups(groups, windowDays));
      const active = groups.filter((g) => (g.recentMergeRequests?.count ?? 0) > 0).length;
      console.error(`\n${groups.length} group(s) visible, ${active} with merge requests in the last ${windowDays} days.`);
      console.error('Put the paths of the active ones into teams[].gitlabGroups in the profile config.');
      return;
    }

    case 'suggest-groups': {
      const config = loadConfig(profileDir);
      if (config.forge === 'github') {
        throw new Error(
          'suggest-groups is GitLab-only. GitHub repos are plain owner/repo - list the ones each team owns ' +
            'directly in teams[].githubRepos in the profile config.',
        );
      }
      const secrets = loadSecrets(profileDir);
      if (!secrets.gitlabBaseUrl || !secrets.gitlabToken) {
        throw new Error('suggest-groups needs gitlabBaseUrl and gitlabToken in secrets.local.json (or GITLAB_BASE_URL / GITLAB_TOKEN)');
      }
      const dates = listSnapshotDates(dataDir, profileName);
      const date = flags.date ?? dates[dates.length - 1];
      if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      const jira = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
      if (!jira) throw new Error(`No jira.json in snapshot ${date}`);

      // GOTCHA: the mapping needs assignee NAMES, and a snapshot collected with
      // individualAttribution off does not have them - `toPerson` drops person
      // data at WRITE time, by design (docs/decisions.md), so it cannot be
      // recovered here. The issue-key axis still works, which is worth saying
      // rather than silently reporting "0 authors matched" on every group as
      // though nobody on the estate worked on anything.
      if (!jira.individualAttribution) {
        console.error(
          'NOTE: this snapshot was collected with individualAttribution off, so it carries no assignee names. ' +
            'The people axis will be empty for every group and only the issue-key axis is usable.',
        );
      }

      const windowDays = numericFlag(flags, 'window', config.gitlabWindowDays);
      const configured = config.teams.filter((t) => t.enabled);
      const boards = jira.teams
        .map((t) => {
          const cfg = configured.find((c) => c.key === t.key);
          return boardFacts(t, cfg?.gitlabGroups ?? [], { now: new Date(jira.capturedAt) });
        })
        // A board with no issues in the snapshot cannot be scored against, and
        // including it would print four empty columns per group.
        .filter((b) => b.issueKeys.size > 0);
      if (boards.length === 0) throw new Error(`No board in snapshot ${date} carries any issues to score against`);

      const groups = await discoverGroups(secrets, { search: flags.search });
      console.error(
        `${groups.length} visible group(s); reading up to ${windowDays} days of merge requests from each.`,
      );
      const activity = await collectActivity(secrets, groups, {
        windowDays,
        maxPages: numericFlag(flags, 'pages', 2),
        onProgress: (fullPath, i) => {
          if (i % 10 === 0) console.error(`  ...${i}/${groups.length} (${fullPath})`);
        },
      });

      const suggestions = scoreGroups(activity, boards, {
        botAccounts: config.reviewBotAccounts,
        known: knownProjectKeys(jira),
      });

      if (flags.json === 'true') {
        console.log(JSON.stringify({ profile: profileName, date, windowDays, boards: boards.map((b) => ({ ...b, issueKeys: b.issueKeys.size, assignees: b.assignees.size })), suggestions }, null, 2));
      } else {
        console.log(formatSuggestions(suggestions, boards, { windowDays, showAll: flags.all === 'true' }));
      }
      return;
    }

    case 'discover-spaces': {
      const config = loadConfig(profileDir);
      const secrets = loadSecrets(profileDir);
      const dates = listSnapshotDates(dataDir, profileName);
      const date = flags.date ?? dates[dates.length - 1];
      if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      const jira = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
      if (!jira) throw new Error(`No jira.json in snapshot ${date}`);

      // Per TEAM, not site-wide. A space that scores against several teams at
      // once is a shared/company space rather than a team's home, and that only
      // shows up when the scores are kept apart - it is the same discrimination
      // that kept `Acme` and `shared-platform` out of the
      // GitLab mapping (docs/handover.md).
      for (const team of config.teams.filter((t) => t.enabled && (!flags.team || t.key === flags.team))) {
        const snap = jira.teams.find((t) => t.key === team.key);
        const keys = snap ? projectKeysOf(snap).slice(0, 2) : [];
        console.log(`\n${team.key}  board ${team.boardId}  project keys: ${keys.join(', ') || '(none - board not in this snapshot)'}`);
        if (keys.length === 0) continue;
        const scores = await discoverSpaces(secrets, keys);
        console.log(formatSpaceScores(scores));
      }
      return;
    }

    case 'backfill-changelog': {
      const config = loadConfig(profileDir);
      const window = numericFlag(flags, 'window', DEFAULT_SPRINT_WINDOW);
      const date = flags.date ?? snapshotDate(now);
      const jiraSnap = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
      if (!jiraSnap) throw new Error(`No jira.json in snapshot ${date} - run "collect" first`);

      const client = createJiraClient(loadSecrets(profileDir), {
        maxInFlight: numericFlag(flags, 'jira-in-flight', DEFAULT_ATLASSIAN_IN_FLIGHT),
      });
      const map = loadFieldMap(profileDir);
      if (!map) throw new Error('No field-map.json in profile - run "discover-fields" first');
      const kept = keptFields(map);

      const teams = config.teams.filter((t) => t.enabled && (!flags.team || t.key === flags.team));
      if (teams.length === 0) throw new Error('No enabled teams matched');

      for (const team of teams) {
        const snap = jiraSnap.teams.find((t) => t.key === team.key);
        if (!snap) continue;

        console.error(`jira: ${team.key} (board ${team.boardId}) backfilling changelog ... `);
        const store = readChangelogStore(dataDir, profileName, team.boardId, team.key);
        const scoped = changelogScope(snap, window);
        const needed = issuesNeedingChangelog(scoped, store.seen);
        console.error(`${scoped.length} in-scope issues, ${needed.length} needing a fetch`);

        const result = await fetchChangelogs(
          client,
          changelogTargets(scoped, needed),
          kept,
          config.individualAttribution,
          {
            allowBulk: flags['no-bulk-changelog'] !== 'true',
            onProgress: (read, total) => {
              if (read === total || read % 100 === 0) process.stderr.write(`\r  ${team.key}: ${read}/${total} issues ... `);
            },
          },
        );
        if (needed.length > 0) process.stderr.write('\n');
        for (const e of result.errors) console.error(`  ${e}`);

        if (result.issuesRead > 0) {
          const appended = appendChangelog(dataDir, profileName, store, result.entries, result.seenUpdates, now);
          console.error(
            `read ${result.issuesRead} issue(s) in ${result.requests} request(s) (${result.mode}), ` +
              `added ${appended.added} new entries (${appended.total} total in store)`,
          );
        } else {
          console.error(`added 0 new entries (${store.entries.length} total in store)`);
        }
      }
      return;
    }

    case 'collect': {
      const config = loadConfig(profileDir);
      const secrets = loadSecrets(profileDir);
      const date = flags.date ?? snapshotDate(now);
      const dir = snapshotDir(dataDir, profileName, date);

      // ONE client for the whole run, and every Atlassian pass below takes it -
      // field discovery, the board sweep, the changelog delta, and Confluence
      // via its `gate`. Three clients each keeping their own polite number of
      // requests in flight is three times that number in flight against one
      // rate limit, and nothing in the code would have said so. See the header
      // of jira/client.ts.
      const jiraClient = createJiraClient(secrets, {
        maxInFlight: numericFlag(flags, 'jira-in-flight', DEFAULT_ATLASSIAN_IN_FLIGHT),
      });

      let map = loadFieldMap(profileDir);
      if (!map && flags['gitlab-only'] !== 'true') {
        // Discovering on demand rather than erroring: a first run should just
        // work, and the map is cached so this happens once.
        console.error('No field-map.json in profile - discovering field ids now.');
        map = await discoverFields(jiraClient, now.toISOString());
        saveFieldMap(profileDir, map);
      }

      const teams = config.teams.filter((t) => t.enabled && (!flags.team || t.key === flags.team));
      if (teams.length === 0) throw new Error('No enabled teams matched');

      // --gitlab-only re-collects merge requests against an EXISTING jira.json
      // for the same day. Snapshots are meant to be written once per UTC day
      // (docs/decisions.md), and writeSnapshot does not enforce that, so adding
      // GitLab to a day that already has Jira must not silently restate the Jira
      // half - the whole point of the history is that it was not edited later.
      // `--github-only` is the same operation for a GitHub profile: re-collect
      // only the merge/pull-request half against an existing jira.json.
      const gitlabOnly = flags['gitlab-only'] === 'true' || flags['github-only'] === 'true';
      const force = flags.force === 'true';

      // Checked BEFORE the sweep, not after. writeSnapshot enforces this too,
      // but discovering it there means finding out that the day is already
      // collected only after a four-minute Jira crawl and a full GitLab review
      // pass have already run.
      if (!gitlabOnly && !force && readSnapshot(dataDir, profileName, date, 'jira') !== null) {
        throw new SnapshotExistsError(
          `Snapshot ${date} already has a jira.json. Snapshots are immutable - the history is the product ` +
            `and a day cannot be restated without losing what it recorded.
` +
            `  - to add or refresh only the GitLab half:  --gitlab-only
` +
            `  - to collect a different day:              --date YYYY-MM-DD
` +
            `  - to genuinely overwrite it:               --force`,
        );
      }

      // GOTCHA: --force plus --team is the one combination that DELETES history
      // rather than restating it. `teams` is narrowed by --team, so the run
      // writes a jira.json holding that team alone and the other three teams'
      // record of the day is gone - and unlike the GitLab and Confluence halves
      // below, the Jira half cannot carry the missing teams forward, because a
      // team collected yesterday folded into today's file under today's
      // capturedAt is a false observation, which is worse than a missing one.
      // A missing team on a day is already handled properly downstream (see
      // seriesByTeam), so the right move is to refuse rather than to invent.
      if (!gitlabOnly && force) {
        const existingJira = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
        const collecting = new Set(teams.map((t) => t.key));
        const dropped = droppedTeamsOnForce((existingJira?.teams ?? []).map((t) => t.key), collecting);
        if (dropped.length > 0) {
          throw new Error(
            `--force would rewrite snapshot ${date} with ${teams.length} team(s) and DELETE the already-collected ` +
              `record of ${dropped.join(', ')} for that day. Snapshots cannot be backfilled.
` +
              `  - to re-collect the whole day:            drop --team
` +
              `  - to re-collect one team on a fresh day:  --date YYYY-MM-DD`,
          );
        }
      }

      let jira: JiraSnapshot;

      if (gitlabOnly) {
        const existing = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
        if (!existing) throw new Error(`--gitlab-only needs an existing jira.json in snapshot ${date}`);
        jira = existing;
        console.error(`jira: reusing the existing snapshot for ${date} (${jira.teams.length} team(s), not re-collected)`);
      } else {
        jira = await collectJira();
      }

      async function collectJira(): Promise<JiraSnapshot> {
        if (!map) throw new Error('No field map in the profile - run "discover-fields" first');
        const client = jiraClient;
        const snapshot: JiraSnapshot = {
          schemaVersion: SCHEMA_VERSION,
          source: 'jira',
          site: config.site,
          capturedAt: now.toISOString(),
          individualAttribution: config.individualAttribution,
          fieldMap: map,
          teams: [],
        };

        // Sequential on purpose. Jira Cloud rate-limits a parallel board sweep
        // readily, and a collection run has no deadline - it is a scheduled job.
        for (const team of teams) {
          process.stderr.write(`jira: ${team.key} (board ${team.boardId}) ... `);
          const snap = await collectTeam(client, team, map, {
            keepIndividuals: config.individualAttribution,
            // Descriptions, comments and epic names. Bounded to the active
            // sprint plus the top of the backlog - see collectTeam - so it adds
            // a handful of paginated calls per board, not a sweep.
            withDetail: flags['no-issue-detail'] !== 'true',
          });
          snapshot.teams.push(snap);
          console.error(
            `${snap.issues.length} issues, ${snap.sprints.length} sprints` +
              `${snap.errors.length ? `, ${snap.errors.length} error(s)` : ''}`,
          );
        }
        console.error(`wrote ${writeSnapshot(dir, 'jira', snapshot, { force: true })}`);
        return snapshot;
      }

      // Project keys actually present in the Jira snapshot for this day. This is
      // what makes MR-to-issue correlation trustworthy: without it a version
      // string like "V2-3" in an MR title parses as a Jira key.
      //
      // How much this yields varies by group, and that is itself the finding:
      // 19 of 79 human-authored merge requests in web-storefront carry a
      // WEB key; 0 of 332 in logistics-hub carry any key at all. See
      // docs/decisions.md.
      const knownProjectKeys = new Set<string>();
      for (const t of jira.teams) {
        for (const i of t.issues) knownProjectKeys.add(i.key.slice(0, i.key.lastIndexOf('-')));
      }

      // The merge/pull-request half. Which forge it reads is config.forge; both
      // collectors return the same shape into the same `gitlab.json` slot, so
      // everything below (merge-with-existing, writeSnapshot, and every
      // downstream reader) is forge-agnostic. `--no-gitlab` / `--no-github` and
      // `--gitlab-only` / `--github-only` are accepted as aliases either way.
      const forge = config.forge;
      const teamHasForgeRepos = (t: (typeof teams)[number]) =>
        forge === 'github' ? (t.githubRepos?.length ?? 0) > 0 : t.gitlabGroups.length > 0;
      const noForge = flags['no-gitlab'] === 'true' || flags['no-github'] === 'true';
      const wantGitlab = !noForge && teams.some(teamHasForgeRepos);
      const haveForgeCreds =
        forge === 'github' ? Boolean(secrets.githubToken) : Boolean(secrets.gitlabBaseUrl && secrets.gitlabToken);
      if (wantGitlab && haveForgeCreds) {
        const gitlab: GitLabSnapshot = {
          schemaVersion: SCHEMA_VERSION,
          source: forge,
          capturedAt: now.toISOString(),
          windowDays: config.gitlabWindowDays,
          individualAttribution: config.individualAttribution,
          teams: [],
        };
        for (const team of teams) {
          if (!teamHasForgeRepos(team)) continue;
          process.stderr.write(`${forge}: ${team.key} ... `);
          // Review detail is on by default: it is the only LEADING indicator
          // the tool produces, and it is the whole reason this half is
          // collected. --no-review-detail exists for a quick re-collection.
          const withReviewDetail = flags['no-review-detail'] !== 'true';
          const collectForge = forge === 'github' ? collectTeamPullRequests : collectTeamMergeRequests;
          const { mergeRequests, errors } = await collectForge(secrets, team, {
            windowDays: config.gitlabWindowDays,
            keepIndividuals: config.individualAttribution,
            now,
            knownProjectKeys,
            botAccounts: config.reviewBotAccounts,
            withReviewDetail,
            // The snapshot does not depend on this - see reviewConcurrency in
            // gitlab/collect.ts - so it is a throughput dial and nothing else.
            // 1 restores the strictly sequential behaviour.
            reviewConcurrency: numericFlag(flags, 'review-concurrency', DEFAULT_REVIEW_CONCURRENCY),
            onProgress: (done, total) => {
              if (done === total || done % 25 === 0) process.stderr.write(`\r  ${forge}: ${team.key} review detail ${done}/${total} ... `);
            },
          });
          const repos = forge === 'github' ? team.githubRepos ?? [] : team.gitlabGroups;
          gitlab.teams.push({ key: team.key, groups: repos, mergeRequests, errors });
          console.error(`${mergeRequests.length} ${forge === 'github' ? 'PRs' : 'MRs'}${errors.length ? `, ${errors.length} error(s)` : ''}`);
        }

        // GOTCHA: the GitLab half needs the same care --gitlab-only takes over
        // the Jira half. `teams` is narrowed by --team, so writing `gitlab` as
        // collected would replace a four-team gitlab.json with a one-team one
        // and delete that day's merge requests for the other three. Snapshots
        // are the product and cannot be backfilled (docs/decisions.md), so any
        // team present on disk but NOT re-collected in this run is carried
        // forward untouched rather than dropped - see mergeTeams.ts.
        const existingGitlab = readSnapshot<GitLabSnapshot>(dataDir, profileName, date, 'gitlab');
        const merged = mergeCollectedTeams(gitlab.teams, existingGitlab?.teams);
        gitlab.teams = merged.teams;
        for (const key of merged.carriedForward) {
          console.error(`gitlab: ${key} carried forward from the existing snapshot (not re-collected)`);
        }

        console.error(`wrote ${writeSnapshot(dir, 'gitlab', gitlab, { force: true })}`);
      } else if (wantGitlab) {
        console.error(
          forge === 'github'
            ? 'github: skipped - no githubToken in secrets'
            : 'gitlab: skipped - no gitlabBaseUrl/gitlabToken in secrets',
        );
      }

      // --- Confluence context ------------------------------------------------
      // Opt-in and last, because it is the least important of the three and the
      // most likely to be unconfigured: a failure here must never cost the day's
      // Jira and GitLab snapshots, which are already safely on disk by now.
      // Changelog delta pass: only after a successful Jira collection.
      //
      // Gated on the profile ALREADY having a changelog/ directory, i.e. only
      // after a deliberate `backfill-changelog`. A first fetch is thousands of
      // issues and is a decision; a daily top-up is the handful whose `updated`
      // moved, and that is what belongs on a scheduled run.
      //
      // One test, `=== 'true'`, which is the convention every other boolean flag
      // here follows (see parseArgs). Tested as a truthiness check instead,
      // `--no-changelog false` - which that convention reads as collect it -
      // would turn it off, because 'false' is a truthy string.
      const wantChangelog = flags['no-changelog'] !== 'true' && !gitlabOnly;
      if (wantChangelog && map && existsSync(join(dataDir, profileName, 'changelog'))) {
        const kept = keptFields(map);
        for (const team of teams) {
          const snap = jira.teams.find((t) => t.key === team.key);
          if (!snap) continue;
          const store = readChangelogStore(dataDir, profileName, team.boardId, team.key);
          const scoped = changelogScope(snap, DEFAULT_SPRINT_WINDOW);
          const needed = issuesNeedingChangelog(scoped, store.seen);
          if (needed.length === 0) {
            console.error(`changelog: ${team.key} - no issues need fetching`);
            continue;
          }
          process.stderr.write(`changelog: ${team.key} (${needed.length} of ${scoped.length} in-scope issues) ... `);
          const result = await fetchChangelogs(
            jiraClient,
            changelogTargets(scoped, needed),
            kept,
            config.individualAttribution,
            { allowBulk: flags['no-bulk-changelog'] !== 'true' },
          );
          if (result.issuesRead > 0) {
            const appended = appendChangelog(dataDir, profileName, store, result.entries, result.seenUpdates, now);
            console.error(
              `${result.requests} request(s) (${result.mode}), added ${appended.added} entries ` +
                `(${appended.total} total in store)`,
            );
          } else {
            console.error('nothing read');
          }
          for (const e of result.errors) console.error(`  ${e}`);
        }
      }

      if (config.confluence && flags['no-confluence'] !== 'true') {
        const context: ConfluenceSnapshot = {
          schemaVersion: SCHEMA_VERSION,
          source: 'confluence',
          capturedAt: now.toISOString(),
          site: config.site,
          teams: [],
        };
        for (const team of teams) {
          process.stderr.write(`confluence: ${team.key} ... `);
          try {
            const snap = jira.teams.find((t) => t.key === team.key);
            const result = await collectTeamContext(secrets, team, snap, { gate: jiraClient.gate });
            context.teams.push({ key: team.key, ...result });
            console.error(`${result.pages.length} page(s)${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
          } catch (err) {
            context.teams.push({ key: team.key, spaces: [], pages: [], errors: [(err as Error).message] });
            console.error(`failed: ${(err as Error).message}`);
          }
        }
        // Same carry-forward rule as the GitLab half: --team narrows `teams`,
        // and writing only what this run collected would delete the other teams'
        // context for the day.
        const existing = readSnapshot<ConfluenceSnapshot>(dataDir, profileName, date, 'context');
        context.teams = mergeCollectedTeams(context.teams, existing?.teams).teams;
        console.error(`wrote ${writeSnapshot(dir, 'context', context, { force: true })}`);
      }
      return;
    }

    case 'quality': {
      const dates = listSnapshotDates(dataDir, profileName);
      const date = flags.date ?? dates[dates.length - 1];
      if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      const raw = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
      if (!raw) throw new Error(`No jira.json in snapshot ${date}`);
      const snapshot = narrowToTeam(raw, flags.team, 'jira');

      const staleDays = numericFlag(flags, 'stale-days', 10);
      const results = assessSnapshot(snapshot, { staleDays, now: new Date(snapshot.capturedAt) });
      if (flags.json === 'true') {
        console.log(JSON.stringify({ date, capturedAt: snapshot.capturedAt, results }, null, 2));
      } else {
        console.log(`Data quality - ${snapshot.site} - snapshot ${date} (captured ${snapshot.capturedAt})`);
        console.log(formatQualityReport(results));
      }
      return;
    }

    case 'trends': {
      const dates = listSnapshotDates(dataDir, profileName);
      const date = flags.date ?? dates[dates.length - 1];
      if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      const rawTrends = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
      if (!rawTrends) throw new Error(`No jira.json in snapshot ${date}`);
      const snapshot = narrowToTeam(rawTrends, flags.team, 'jira');

      // 12 sprints is roughly six months at this site's two-week cadence -
      // recent enough to reflect the current team, long enough to be stable.
      const window = numericFlag(flags, 'window', DEFAULT_SPRINT_WINDOW);
      const recent = numericFlag(flags, 'recent', 10);
      const trends = deriveTrends(snapshot, window);
      if (flags.json === 'true') {
        console.log(JSON.stringify({ date, capturedAt: snapshot.capturedAt, window, trends }, null, 2));
      } else {
        console.log(`Delivery trends - ${snapshot.site} - snapshot ${date} - forecast window ${window} sprints`);
        console.log(formatTrends(trends, recent));
      }
      return;
    }

    case 'review': {
      const dates = listSnapshotDates(dataDir, profileName);
      const date = flags.date ?? dates[dates.length - 1];
      if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      const snapshot = readSnapshot<GitLabSnapshot>(dataDir, profileName, date, 'gitlab');
      if (!snapshot) {
        throw new Error(
          `No gitlab.json in snapshot ${date}. Either no team has gitlabGroups configured ` +
            `(run "discover-groups" to find them), or GitLab credentials were absent when it was collected.`,
        );
      }

      const metrics = deriveReview(narrowToTeam(snapshot, flags.team, 'gitlab'));
      if (flags.json === 'true') {
        console.log(JSON.stringify({ date, capturedAt: snapshot.capturedAt, windowDays: snapshot.windowDays, metrics }, null, 2));
      } else {
        console.log(
          `Merge-request review - snapshot ${date} (captured ${snapshot.capturedAt}, ${snapshot.windowDays}-day window)`,
        );
        console.log(formatReview(metrics, numericFlag(flags, 'list', 10)));
      }
      return;
    }

    case 'report': {
      const dates = listSnapshotDates(dataDir, profileName);
      const date = flags.date ?? dates[dates.length - 1];
      if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      const jiraAll = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
      if (!jiraAll) throw new Error(`No jira.json in snapshot ${date}`);
      // --team narrows the whole report to one board. The GitLab and Confluence
      // halves are narrowed too, or their panels would describe a team the rest
      // of the page is not about; both are keyed on the same team slug, and both
      // are allowed to be missing that team entirely (not every board has a
      // group or a space mapped), so they are filtered rather than asserted.
      const jira = narrowToTeam(jiraAll, flags.team, 'jira');
      const gitlabAll = readSnapshot<GitLabSnapshot>(dataDir, profileName, date, 'gitlab');
      const contextAll = readSnapshot<ConfluenceSnapshot>(dataDir, profileName, date, 'context');
      const gitlab = narrowOptional(gitlabAll, flags.team);
      const context = narrowOptional(contextAll, flags.team);

      // Before anything else: can the snapshot on disk answer what this build
      // asks of it? Printed here rather than only embedded in the HTML because
      // the person running the command is the only one who can fix it, and they
      // may never open the file they just generated. It does NOT abort - a
      // partial report is still worth having, as long as it says so.
      const schema = assessSchema({ jira, gitlab, context });
      for (const line of formatSchemaWarning(schema, profileDir)) console.error(line);

      // The profile's own notes on WHY each board and group were chosen. They
      // are the evidence behind the mapping and belong in front of the reader
      // rather than only in a config file - the report is read by people who
      // will reasonably ask "how do you know that group is this team".
      const reportConfig = loadConfig(profileDir);
      const teamConfig = new Map(reportConfig.teams.map((t) => [t.key, t]));

      // The roster only ever sees DISPLAY names - Person.displayName is all the
      // snapshot keeps for a commenter - so the bot list is matched on that
      // form. Both forms are in the profile for the reason recorded in
      // gitlab/collect.ts: the automation account here is username `bot` with
      // display name "I'm a Bot", and matching one form only put a robot in the
      // per-person table as somebody to have a training conversation with.
      const botNames = new Set(reportConfig.reviewBotAccounts.map((b) => b.toLowerCase()));
      const isAutomationAccount = (p: { displayName: string }): boolean =>
        botNames.has(p.displayName.trim().toLowerCase());

      const window = numericFlag(flags, 'window', DEFAULT_SPRINT_WINDOW);
      const staleDays = numericFlag(flags, 'stale-days', 10);
      // Lookback for "what took longest to get through". Defaults to the
      // GitLab collection window so both halves of the report describe the
      // same stretch of time.
      const reportWindow = numericFlag(flags, 'report-window', gitlab?.windowDays ?? 30);
      const trends = deriveTrends(jira, window);
      const quality = assessSnapshot(jira, { staleDays, now: new Date(jira.capturedAt) });
      const reviewByTeam = new Map((gitlab ? deriveReview(gitlab) : []).map((r) => [r.team, r]));

      // The snapshot's own capture time is the clock, not the wall clock: a
      // report generated days later must not re-age every ticket in it.
      const asOf = new Date(jira.capturedAt);
      const mrsByTeam = new Map((gitlab?.teams ?? []).map((t) => [t.key, t.mergeRequests]));

      // Snapshot-to-snapshot metrics, where enough days exist. A profile with
      // one collected day yields `days: 1` and the report says so, rather than
      // drawing an empty burndown that reads as a sprint with nothing in it.
      // Bounded at the report's own date: see the GOTCHA on loadHistories.
      const historyByTeam = new Map(loadHistories(dataDir, profileName, flags.team, date).map((h) => [h.team, h]));
      const contextByTeam = new Map((context?.teams ?? []).map((t) => [t.key, t]));

      // The GitLab host is recovered from the merge-request URLs already in the
      // snapshot rather than read from secrets, so regenerating an old report on
      // a machine with no credentials still produces working links. See links.ts.
      const gitlabOrigin = gitlabOriginFrom(
        (gitlab?.teams ?? []).flatMap((t) => t.mergeRequests.slice(0, 3).map((m) => m.webUrl)),
      );

      const teams: ReportTeamInput[] = jira.teams.map((t, i) => {
        const trend = trends[i]!;
        const qual = quality[i]!;
        const review = reviewByTeam.get(t.key);
        const load = activeLoad(t);
        const outlook = sprintOutlook(t, trend, asOf);
        const carry = qual.findings.find((f) => f.code === 'carried-three-plus-sprints');
        const wip = wipSummary(t, { now: asOf, staleDays });
        const epics = epicRollups(t, asOf);
        const history = historyByTeam.get(t.key) ?? null;
        const cfg = teamConfig.get(t.key);

        return {
          key: t.key,
          boardName: t.boardName,
          boardId: t.boardId,
          description: cfg?.description,
          gitlabGroups: cfg?.gitlabGroups,
          prefixes: projectPrefixes(t),
          sprintGoals: t.sprints
            .filter((sp) => sp.state === 'active')
            .map((sp) => ({ id: sp.id, name: sp.name, goal: sp.goal, startDate: sp.startDate, endDate: sp.endDate })),
          epics,
          wip,
          // 12 sprints of composition, matching the forecast window: the point
          // is to let a velocity trend be read against a headcount change over
          // exactly the stretch the forecast was calibrated on.
          composition: compositionBySprint(t, window),
          // The business-and-dev detail layer. `taxonomy` is computed over three
          // scopes rather than one because a categorical share is meaningless
          // without its scope: "62% bugs" over a board carrying a decade of
          // closed work is a statement about history, and the same figure over
          // the active sprint is a statement about this fortnight.
          taxonomy: taxonomy(t, 'active', asOf, reportWindow),
          taxonomyBacklog: taxonomy(t, 'backlog', asOf, reportWindow),
          taxonomyRecent: taxonomy(t, 'recent', asOf, reportWindow),
          subtasks: subtaskStructure(t),
          discussed: mostDiscussed(t, asOf),
          // Comment detail is collected only for OPEN work in an active sprint,
          // so the panel must say so - a "most discussed" table silently scoped
          // to 3% of the board would otherwise read as a ranking of everything.
          commentScope:
            'Comment threads are collected for open work in an active sprint only, so this ranks that work rather than the whole board.',
          flagged: flaggedRegister(t, asOf),
          blockers: blockerGraph(t),
          roster: roster(t, mrsByTeam.get(t.key) ?? [], {
            now: asOf,
            recentDays: reportWindow,
            isAutomation: isAutomationAccount,
            gitlabWindowDays: gitlab?.windowDays,
          }),
          confluence: contextByTeam.get(t.key),
          mergeRequests: mrsByTeam.get(t.key),
          interventions: interventions({
            team: t,
            trends: trend,
            outlook,
            review,
            wip,
            churn: history?.churn ?? null,
            now: asOf,
            staleDays,
          }),
          history,
          backlog: backlogSummary(t, asOf),
          // The board's own location.projectKey is NOT used: board 703 is
          // located in project OPS but every issue on it is LOG-keyed, so the
          // prefix is counted from the issues actually being reported on.
          prefix: projectPrefixes(t)[0]?.key ?? '—',
          trends: trend,
          quality: qual,
          activeLoad: load,
          carryoverLeaders: carryoverLeaders(t),
          review,
          attention: attentionItems(t, { now: asOf, staleDays }),
          practice: practiceByPerson(mrsByTeam.get(t.key) ?? []),
          outlook,
          health: teamHealth({
            unreviewedRate:
              review && review.mergedKnown > 0 ? review.mergedWithoutHumanReview / review.mergedKnown : null,
            carryoverRate: carry && carry.outOf ? carry.count / carry.outOf : null,
            unestimatedRate: load.issues > 0 ? load.unestimated / load.issues : null,
            relativeSpread: trend.pointsForecast.relativeSpread,
            outlook,
          }),
          slowest: slowestResolved(t, { now: asOf, withinDays: reportWindow, limit: 15 }),
        };
      });

      // What changed since the previous collected day.
      //
      // GOTCHA: BOTH days are built through `buildFeed`, including today's, and
      // the obvious shortcut of diffing the `interventions` already computed for
      // the panels above is wrong in a way that only shows up on live data.
      // Those are built with the report's per-kind cap of 8 so a page stays
      // readable, and comparing a capped list against a capped list makes an
      // item look new the moment something above it drops out. buildFeed uses a
      // cap of 50 on both sides, which is what makes the two days comparable.
      //
      // Neither call re-reads the snapshots from disk - readSnapshot and the
      // history projections are both cached - so this is the derivation cost
      // twice over and no I/O.
      const previousDate = dates.filter((d) => d < date).pop() ?? null;
      const feedToday = buildFeed({ dataDir, profileName, date, staleDays, window });
      const feedPrevious = previousDate
        ? buildFeed({ dataDir, profileName, date: previousDate, staleDays, window })
        : null;
      // GOTCHA: `jira`/`gitlab` above were already narrowed by narrowToTeam at
      // the top of this case, but buildFeed reads the snapshots from disk itself
      // and is NOT narrowed. So --team has to be applied HERE, or a report about
      // one board opens with a panel reporting changes on three others.
      const flatten = (f: NonNullable<typeof feedToday>) => ({
        date: f.date,
        capturedAt: f.capturedAt,
        interventions: f.teams
          .filter((t) => !flags.team || t.team === flags.team)
          .flatMap((t) => t.interventions),
      });
      const changes = feedToday
        ? diffInterventions(flatten(feedToday), feedPrevious ? flatten(feedPrevious) : null)
        : undefined;

      // The two estate-wide rollups. Both are pure functions over what the
      // per-team loop above already computed - no snapshot is re-read and
      // nothing is re-derived.
      //
      // GOTCHA: the merge requests are handed over as ONE FLAT LIST from every
      // mapped group and deduped by id inside estatePeople, rather than summed
      // out of the per-team rosters. Two boards mapped to one group would
      // otherwise double every person's authored count, and it would double it
      // quietly - the figure stays plausible, which is the worst way for a
      // number to be wrong.
      //
      // No `flags.team` filter here, unlike `flatten` above: `gitlab` is already
      // the narrowed snapshot (narrowOptional, top of this case).
      const people = estatePeople({
        teams: teams.map((t) => ({ key: t.key, roster: t.roster })),
        mergeRequests: (gitlab?.teams ?? []).flatMap((t) => t.mergeRequests),
        recentDays: reportWindow,
        gitlabWindowDays: gitlab?.windowDays,
        reviewerIdentitiesUnknown: teams.some((t) => t.practice.reviewerIdentitiesUnknown),
      });
      const estateEpicRollup = estateEpics(teams.map((t) => ({ key: t.key, epics: t.epics })));

      const html = buildReport({
        site: jira.site,
        generatedAt: now.toISOString(),
        jiraDate: date,
        jiraCapturedAt: jira.capturedAt,
        gitlabDate: gitlab ? date : undefined,
        gitlabCapturedAt: gitlab?.capturedAt,
        gitlabOrigin,
        windowDays: reportWindow,
        teams,
        changes,
        people,
        estateEpics: estateEpicRollup,
        // The full derived model is embedded as machine-readable JSON by
        // default: the rendered page is necessarily truncated, and on a file://
        // page there is nowhere else to get the rest. --no-embed-data drops it
        // for a smaller file.
        embedData: flags['no-embed-data'] !== 'true',
        schema,
        // Names the artefact honestly in the report's copy: a GitHub profile's
        // `gitlab.json` carries source: 'github', and "pull request" is what the
        // reader is looking at. The derive layer stays forge-agnostic; only the
        // wording changes. See RenderContext.forge / nouns() in report/panels.ts.
        forge: gitlab?.source ?? 'gitlab',
      });

      const outPath = resolve(flags.out ?? 'report.html');
      writeFileSync(outPath, html, 'utf8');
      console.error(
        schema.stale
          ? `wrote ${outPath} - WITH a stale-data banner at the top of the page (see the warning above)`
          : `wrote ${outPath}`,
      );
      return;
    }

    case 'history': {
      const histories = loadHistories(dataDir, profileName, flags.team);
      if (histories.length === 0) {
        throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);
      }
      if (flags.json === 'true') {
        console.log(JSON.stringify({ profile: profileName, histories }, null, 2));
      } else {
        console.log(`Snapshot-to-snapshot metrics - ${profileName}`);
        console.log(formatHistory(histories));
      }
      return;
    }

    case 'alert': {
      const alertConfig = loadConfig(profileDir);
      const wantsSlack = flags.slack === 'true' ? true : undefined;
      const wantsConfluence = flags.confluence === 'true' ? true : undefined;
      // Secrets are loaded even for a dry run, because the failure worth finding
      // out about before 07:00 is the one where the destination is configured
      // and the credential is not.
      const alertSecrets = loadSecrets(profileDir);

      const result = await runAlerts({
        dataDir,
        profileDir,
        profileName,
        config: alertConfig,
        secrets: alertSecrets,
        date: flags.date,
        staleDays: numericFlag(flags, 'stale-days', 10),
        window: numericFlag(flags, 'window', DEFAULT_SPRINT_WINDOW),
        limit: flags.limit === undefined ? undefined : numericFlag(flags, 'limit', 8),
        dryRun: flags['dry-run'] === 'true',
        resend: flags.resend === 'true',
        slack: wantsSlack,
        confluence: wantsConfluence,
      });

      if (flags.json === 'true') {
        console.log(JSON.stringify({ profile: profileName, plan: result.plan }, null, 2));
      } else {
        for (const line of formatPlan(result.plan)) console.log(line);
      }

      if (flags['dry-run'] === 'true') {
        console.error('');
        console.error('  --dry-run: nothing was sent and alert-state.json was not written, so this run can be repeated.');
      } else {
        if (result.slackTs) console.error(`posted to Slack (${alertConfig.alerts.slack?.channel}), thread ${result.slackTs}`);
        if (result.confluencePage) console.error(`appended to the Confluence page "${result.confluencePage}"`);
        if (!result.slackTs && !result.confluencePage) {
          console.error(
            'no destination is enabled, so this run only printed. Set config.alerts.slack.enabled or ' +
              'config.alerts.confluence.enabled in the profile, or pass --slack / --confluence.',
          );
        }
        if (result.statePath) console.error(`state: ${result.statePath}`);
      }
      return;
    }

    case 'dates': {
      const dates = listSnapshotDates(dataDir, profileName);
      if (dates.length === 0) console.error(`No snapshots under ${dataDir}/${profileName}`);
      for (const d of dates) console.log(d);
      return;
    }

    case 'archive': {
      // 90 days by default: long enough that every command which reasons over
      // recent history (trends' 12-sprint window, review's 30-day window)
      // never touches a compressed day in ordinary use, short enough that the
      // uncompressed tail does not grow forever either.
      const olderThanDays = numericFlag(flags, 'older-than-days', 90);
      const dryRun = flags['dry-run'] === 'true';
      const result = archiveProfile(dataDir, profileName, { olderThanDays, now, dryRun });
      if (flags.json === 'true') {
        console.log(JSON.stringify({ profile: profileName, dryRun, result }, null, 2));
      } else {
        console.log(`Archiving ${profileName} - nothing is ever deleted, only compressed in place.`);
        for (const line of formatArchiveResult(result, dryRun)) console.log(line);
        if (dryRun) console.error('\n  --dry-run: nothing on disk was touched.');
      }
      return;
    }

    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  // An expected, user-facing condition - a bad flag, a missing profile, a day
  // that is already collected - is an instruction to the reader, not a defect.
  // Printing a stack trace above it buries the one line that says what to do.
  // Anything else keeps its stack, because anything else is a bug.
  const expected = err instanceof ConfigError || err instanceof SnapshotExistsError;
  console.error(expected ? err.message : (err.stack ?? err.message));
  process.exitCode = 1;
});
