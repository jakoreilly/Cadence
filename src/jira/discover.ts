import type { FieldMap } from '../types.js';
import type { JiraClient } from './client.js';

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
}

/** Custom-field type suffixes that identify each well-known field by BEHAVIOUR
 *  rather than by display name. Names are user-editable and localised; the
 *  schema.custom URI is not. */
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const RANK_SCHEMA = 'com.pyxis.greenhopper.jira:gh-lexo-rank';
const EPIC_LINK_SCHEMA = 'com.pyxis.greenhopper.jira:gh-epic-link';

export function buildFieldMap(fields: JiraField[], now: string): FieldMap {
  const bySchema = (suffix: string) => fields.find((f) => f.schema?.custom === suffix)?.id;

  // Story points have NO distinguishing schema URI - both candidates are plain
  // number fields - so name matching is unavoidable here. acme has
  // two ("Story Points" = customfield_10006, "Story point estimate" =
  // customfield_11000) and different projects populate different ones, so this
  // deliberately collects ALL matches rather than the first.
  const storyPoints = fields
    .filter((f) => f.custom && f.schema?.type === 'number' && /story\s*point/i.test(f.name))
    .map((f) => f.id)
    .sort();

  const flagged = fields.find((f) => f.custom && /^flagged$/i.test(f.name))?.id;
  const team = fields.find((f) => f.custom && /^team$/i.test(f.name))?.id;

  const sprint = bySchema(SPRINT_SCHEMA);
  if (!sprint) {
    throw new Error(
      'No Sprint field found on this site. Either Jira Software is not enabled, or the API token lacks ' +
        'permission to see it - a token that can read issues but not boards produces exactly this.',
    );
  }

  return {
    discoveredAt: now,
    sprint,
    storyPoints,
    epicLink: bySchema(EPIC_LINK_SCHEMA),
    rank: bySchema(RANK_SCHEMA),
    flagged,
    team,
  };
}

export async function discoverFields(client: JiraClient, now: string): Promise<FieldMap> {
  const fields: JiraField[] = await client.get('/rest/api/3/field');
  return buildFieldMap(fields, now);
}

export interface DiscoveredBoard {
  id: number;
  name: string;
  type: string;
  projectKey?: string;
  projectName?: string;
}

export async function discoverBoards(client: JiraClient, projectKeyOrId?: string): Promise<DiscoveredBoard[]> {
  const q = projectKeyOrId ? `?projectKeyOrId=${encodeURIComponent(projectKeyOrId)}` : '';
  const boards = await client.paginate(`/rest/agile/1.0/board${q}`, 'values');
  return boards.map((b: any) => ({
    id: b.id,
    name: b.name,
    type: b.type,
    projectKey: b.location?.projectKey,
    projectName: b.location?.projectName,
  }));
}
