import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Secrets } from './types.js';
import { ConfigError } from './config.js';

// Same contract as Emberwatch: env vars win over the gitignored
// file, so a scheduled run can supply credentials without a file on disk.
export function loadSecrets(profileDir: string): Secrets {
  const path = join(profileDir, 'secrets.local.json');
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};

  const atlassianBaseUrl = process.env.ATLASSIAN_BASE_URL ?? file.atlassianBaseUrl;
  const atlassianEmail = process.env.ATLASSIAN_EMAIL ?? file.atlassianEmail;
  const atlassianApiToken = process.env.ATLASSIAN_API_TOKEN ?? file.atlassianApiToken;

  if (!atlassianBaseUrl || !atlassianEmail || !atlassianApiToken) {
    throw new ConfigError(
      `Missing Atlassian credentials: set atlassianBaseUrl/atlassianEmail/atlassianApiToken in ${path} ` +
        `(or ATLASSIAN_BASE_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN)`,
    );
  }

  return {
    atlassianBaseUrl,
    atlassianEmail,
    atlassianApiToken,
    // Validated lazily where used - a Jira-only collection run is legitimate.
    gitlabBaseUrl: process.env.GITLAB_BASE_URL ?? file.gitlabBaseUrl,
    gitlabToken: process.env.GITLAB_TOKEN ?? file.gitlabToken,
    // Validated lazily in github/collect.ts: only a `forge: github` collection
    // reads it. githubBaseUrl is for GitHub Enterprise Server only.
    githubToken: process.env.GITHUB_TOKEN ?? file.githubToken,
    githubBaseUrl: process.env.GITHUB_BASE_URL ?? file.githubBaseUrl,
    // Validated lazily in notify/slack.ts: only `alert` with Slack enabled needs
    // it, and every other command must keep working without it.
    slackToken: process.env.SLACK_TOKEN ?? file.slackToken,
  };
}
