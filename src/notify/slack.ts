import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../config.js';
import type { Secrets } from '../types.js';

// ---------------------------------------------------------------------------
// Slack, ported from Emberwatch/src/notify/slack.ts - the same
// posting contract, the same GOTCHAs, and the same channel-id cache file, so a
// workstation that already runs that tool behaves identically here.
//
// The one thing NOT ported is its AI path: that repo shells out to the Claude
// Code CLI, which is fine on a workstation and broken under Task Scheduler. This
// tool has no model in the path at all, and the alerting layer must not be the
// place that changes.
// ---------------------------------------------------------------------------

export function requireSlackToken(secrets: Secrets, profileDir: string): string {
  if (secrets.slackToken) return secrets.slackToken;
  throw new ConfigError(
    `Slack is enabled but no token is configured. Add "slackToken" to ${join(profileDir, 'secrets.local.json')} ` +
      `(or set SLACK_TOKEN). A user token (xoxp-) or bot token (xoxb-) with chat:write scope works; ` +
      `this tool only ever reads the token for the profile it was given.`,
  );
}

async function slackApi(method: string, token: string, body: unknown): Promise<Record<string, any>> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as Record<string, any>;
  if (!data.ok) throw new Error(`Slack API ${method} failed: ${data.error}`);
  return data;
}

export async function resolveChannelId(profileDir: string, channelName: string, token: string): Promise<string> {
  const cachePath = join(profileDir, 'channel-cache.json');
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const cached = cache[channelName];
  if (cached) return cached;

  const bareName = channelName.replace(/^#/, '');
  let cursor = '';
  for (;;) {
    const url = new URL('https://slack.com/api/conversations.list');
    url.searchParams.set('types', 'public_channel,private_channel');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const data = (await resp.json()) as Record<string, any>;
    if (!data.ok) throw new Error(`Slack conversations.list failed: ${data.error}`);
    const match = (data.channels as Array<{ name: string; id: string }>).find((c) => c.name === bareName);
    if (match) {
      cache[channelName] = match.id;
      writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
      return match.id;
    }
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  throw new ConfigError(`Could not find the Slack channel "${channelName}" - check config.alerts.slack.channel`);
}

// GOTCHA (ported, and it bites harder here): chat.postMessage rejects a body over
// ~4000 characters with `msg_too_long` rather than truncating it. An intervention
// carries what/why/action plus a verbatim comment quote plus its basis note, so a
// single alert can pass that on a bad day. Split on line boundaries so the
// mrkdwn (bold labels, links) survives the cut; a single line longer than the
// budget is hard-split, since there is nothing better to break on.
const SLACK_MAX_CHARS = 3800;

export function chunkForSlack(text: string, maxChars = SLACK_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let remaining = line;
    while (remaining.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }
    const candidate = current ? `${current}\n${remaining}` : remaining;
    if (candidate.length > maxChars) {
      chunks.push(current);
      current = remaining;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

/** Posts `text` to the channel and each reply into that message's thread, so the
 *  channel sees one status line and the findings stay one click away.
 *  Returns the parent message's ts. */
export async function postToSlack(
  profileDir: string,
  channelName: string,
  token: string,
  text: string,
  threadReplies: string[] = [],
): Promise<string> {
  const channelId = await resolveChannelId(profileDir, channelName, token);
  await slackApi('conversations.join', token, { channel: channelId }).catch(() => {});
  const parent = await slackApi('chat.postMessage', token, { channel: channelId, text });
  // GOTCHA (ported): a reply is threaded by `thread_ts`, which is the PARENT's
  // `ts` - not the channel's, and not the reply's own. Posting them in sequence
  // rather than in parallel is deliberate: Slack orders replies by arrival, so
  // concurrent posts can interleave a multi-part message out of order.
  for (const reply of threadReplies) {
    for (const chunk of chunkForSlack(reply)) {
      await slackApi('chat.postMessage', token, { channel: channelId, text: chunk, thread_ts: parent.ts });
    }
  }
  return String(parent.ts);
}
