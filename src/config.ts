import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertsConfig, Config, TeamConfig, FieldMap } from './types.js';

export class ConfigError extends Error {}

function assertString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new ConfigError(`${path} must be a non-empty string`);
  return v;
}

function assertTeam(v: any, i: number): TeamConfig {
  const path = `teams[${i}]`;
  const boardId = v?.boardId;
  if (typeof boardId !== 'number' || !Number.isInteger(boardId)) {
    throw new ConfigError(`${path}.boardId must be an integer Jira board id`);
  }
  const groups = v?.gitlabGroups ?? [];
  if (!Array.isArray(groups) || groups.some((g: unknown) => typeof g !== 'string')) {
    throw new ConfigError(`${path}.gitlabGroups must be an array of strings`);
  }
  const repos = v?.githubRepos;
  if (repos !== undefined && (!Array.isArray(repos) || repos.some((r: unknown) => typeof r !== 'string'))) {
    throw new ConfigError(`${path}.githubRepos must be an array of "owner/repo" strings`);
  }
  const spaces = v?.confluenceSpaces;
  if (spaces !== undefined && (!Array.isArray(spaces) || spaces.some((x: unknown) => typeof x !== 'string'))) {
    throw new ConfigError(`${path}.confluenceSpaces must be an array of Confluence space keys`);
  }
  return {
    key: assertString(v?.key, `${path}.key`),
    boardId,
    description: typeof v?.description === 'string' ? v.description : undefined,
    // Absent or true = enabled, matching the profile convention in
    // Emberwatch: only an explicit false turns a team off.
    enabled: v?.enabled !== false,
    gitlabGroups: groups,
    githubRepos: repos,
    confluenceSpaces: spaces,
  };
}

const SEVERITY_FLOORS = ['act-now', 'this-week', 'watch'] as const;

/** Alert routing, defaulted to "print, send nothing".
 *
 *  Every destination is opt-IN and each one is validated only when it is turned
 *  on: a profile that has never configured Slack must still be able to run
 *  `alert` and read what it would have said, because that is how anybody decides
 *  whether to turn it on. */
function assertAlerts(v: unknown): AlertsConfig {
  const raw = (v ?? {}) as Record<string, any>;
  const slack = raw.slack as Record<string, unknown> | undefined;
  const confluence = raw.confluence as Record<string, unknown> | undefined;

  if (slack?.enabled === true && typeof slack.channel !== 'string') {
    throw new ConfigError('config.alerts.slack.enabled is true but slack.channel is not set (e.g. "#delivery-review")');
  }
  if (confluence?.enabled === true && typeof confluence.pageId !== 'string') {
    throw new ConfigError(
      'config.alerts.confluence.enabled is true but confluence.pageId is not set. The id is in the page URL: ' +
        '/wiki/spaces/KEY/pages/<pageId>/Title',
    );
  }
  const floor = raw.minSeverity;
  if (floor !== undefined && !SEVERITY_FLOORS.includes(floor)) {
    throw new ConfigError(`config.alerts.minSeverity must be one of ${SEVERITY_FLOORS.join(', ')}, got "${floor}"`);
  }

  return {
    slack: slack ? { enabled: slack.enabled === true, channel: String(slack.channel ?? '') } : undefined,
    confluence: confluence
      ? { enabled: confluence.enabled === true, pageId: typeof confluence.pageId === 'string' ? confluence.pageId : undefined }
      : undefined,
    // `this-week` rather than `watch`: a `watch` item is by definition something
    // that is drifting, and an alert feed that fires on drift fires every day.
    minSeverity: floor ?? 'this-week',
    limit: typeof raw.limit === 'number' && raw.limit > 0 ? Math.floor(raw.limit) : 8,
  };
}

export function loadConfig(profileDir: string): Config {
  const path = join(profileDir, 'config.json');
  if (!existsSync(path)) throw new ConfigError(`No config.json in ${profileDir}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const teams: unknown = raw.teams;
  if (!Array.isArray(teams) || teams.length === 0) throw new ConfigError('config.teams must be a non-empty array');

  const keys = new Set<string>();
  const parsed = teams.map((t, i) => {
    const team = assertTeam(t, i);
    // A duplicate key would make two teams write over each other in every
    // snapshot and silently corrupt the whole time series - fail loudly.
    if (keys.has(team.key)) throw new ConfigError(`Duplicate team key "${team.key}"`);
    keys.add(team.key);
    return team;
  });

  return {
    site: assertString(raw.site, 'config.site'),
    teams: parsed,
    // Permissive with a default, matching the Emberwatch provider pattern: only
    // an explicit "github" selects GitHub; anything else (including a typo or a
    // missing key) is GitLab, which is what every existing profile expects.
    forge: raw.forge === 'github' ? 'github' : 'gitlab',
    gitlabWindowDays: typeof raw.gitlabWindowDays === 'number' && raw.gitlabWindowDays > 0 ? raw.gitlabWindowDays : 30,
    // Opt-IN. Absent means no per-person data is written, so a profile created
    // without thinking about it defaults to the privacy-preserving shape.
    individualAttribution: raw.individualAttribution === true,
    // Opt-IN, and additionally gated on at least one team naming a space: a
    // site-wide CQL sweep is the most expensive call this tool can make, and a
    // profile that has never heard of Confluence should not pay for it. Run
    // `discover-spaces` to find the spaces; it derives them from evidence rather
    // than asking the reader to already know.
    confluence:
      raw.confluence === true || parsed.some((t) => (t.confluenceSpaces?.length ?? 0) > 0),
    // Compared case-insensitively at use, because GitLab usernames are
    // case-preserving but not case-sensitive, and "SonarQube" gets typed into a
    // config file as "sonarqube" often enough to matter.
    alerts: assertAlerts(raw.alerts),
    reviewBotAccounts: Array.isArray(raw.reviewBotAccounts)
      ? raw.reviewBotAccounts.filter((b: unknown): b is string => typeof b === 'string' && b.length > 0)
      : [],
  };
}

const FIELD_MAP_FILE = 'field-map.json';

export function loadFieldMap(profileDir: string): FieldMap | null {
  const path = join(profileDir, FIELD_MAP_FILE);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as FieldMap;
  if (!raw.sprint || !Array.isArray(raw.storyPoints)) {
    throw new ConfigError(`${path} is malformed - delete it and re-run "discover"`);
  }
  return raw;
}

export function saveFieldMap(profileDir: string, map: FieldMap): void {
  writeFileSync(join(profileDir, FIELD_MAP_FILE), JSON.stringify(map, null, 2) + '\n', 'utf8');
}
