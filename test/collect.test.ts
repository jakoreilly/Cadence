import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIssueDetail,
  extractSprints,
  mergeSprints,
  normaliseIssue,
  parseSprintValue,
  readStoryPoints,
  recentComments,
  toPerson,
} from '../src/jira/collect.js';
import type { EpicSnapshot, FieldMap, IssueSnapshot } from '../src/types.js';

// Field ids and value shapes below are the ones observed live on
// acme.atlassian.net (issue WEB-1387), not invented.
const MAP: FieldMap = {
  discoveredAt: '2026-08-26T00:00:00.000Z',
  sprint: 'customfield_10001',
  storyPoints: ['customfield_10006', 'customfield_11000'],
  epicLink: 'customfield_10002',
  rank: 'customfield_10000',
  flagged: 'customfield_10400',
  team: 'customfield_10500',
};

const REAL_SPRINT = {
  id: 6145,
  name: 'Panther services 55',
  state: 'active',
  boardId: 701,
  goal: 'Deliver next Services (PPUS / TEP Reader).\nRetail Prod Chat Clean-up.',
  startDate: '2026-08-26T10:17:42.427Z',
  endDate: '2026-09-08T23:00:00.000Z',
};

function rawIssue(overrides: Record<string, unknown> = {}): any {
  return {
    id: '135709',
    key: 'WEB-1387',
    fields: {
      issuetype: { name: 'Defect (Standalone)' },
      status: { name: 'Product Owner Review', statusCategory: { name: 'To Do' } },
      statuscategorychangedate: '2026-08-26T14:25:40.713+0100',
      priority: { name: 'Medium' },
      resolution: null,
      resolutiondate: null,
      created: '2026-08-26T14:25:40.240+0100',
      updated: '2026-08-26T14:25:40.387+0100',
      duedate: null,
      assignee: null,
      reporter: { accountId: 'acc-1001', displayName: 'Alex Doran', emailAddress: 'a.doran@acme.example' },
      creator: { accountId: 'acc-1001', displayName: 'Alex Doran', emailAddress: 'a.doran@acme.example' },
      labels: [],
      components: [],
      issuelinks: [],
      timeoriginalestimate: null,
      timespent: null,
      customfield_10001: [REAL_SPRINT],
      customfield_10006: null,
      customfield_11000: null,
      customfield_10000: '1|i04q7n:',
      customfield_10400: null,
      ...overrides,
    },
  };
}

test('parseSprintValue reads the object shape the API returns today', () => {
  const s = parseSprintValue(REAL_SPRINT);
  assert.equal(s?.id, 6145);
  assert.equal(s?.name, 'Panther services 55');
  assert.equal(s?.state, 'active');
  assert.equal(s?.startDate, '2026-08-26T10:17:42.427Z');
  assert.ok(s?.goal?.startsWith('Deliver next Services'));
});

test('parseSprintValue also reads the legacy GreenHopper toString shape', () => {
  const legacy =
    'com.atlassian.greenhopper.service.sprint.Sprint@1a2b3c[id=6145,rapidViewId=701,state=ACTIVE,' +
    'name=Panther services 55,goal=<null>,startDate=2026-08-26T10:17:42.427Z,endDate=2026-09-08T23:00:00.000Z]';
  const s = parseSprintValue(legacy);
  assert.equal(s?.id, 6145);
  assert.equal(s?.name, 'Panther services 55');
  assert.equal(s?.state, 'active');
  // "<null>" is GreenHopper's rendering of an absent value and must not survive
  // as the literal string "<null>" in a sprint goal.
  assert.equal(s?.goal, undefined);
});

test('parseSprintValue rejects values it cannot key on', () => {
  assert.equal(parseSprintValue(null), null);
  assert.equal(parseSprintValue({ name: 'no id' }), null);
  assert.equal(parseSprintValue('Sprint@1a2b[name=no id here]'), null);
});

test('readStoryPoints falls through to the second field', () => {
  assert.deepEqual(readStoryPoints({ customfield_10006: null, customfield_11000: 5 }, MAP.storyPoints), {
    points: 5,
    field: 'customfield_11000',
  });
  assert.deepEqual(readStoryPoints({ customfield_10006: 3, customfield_11000: 8 }, MAP.storyPoints), {
    points: 3,
    field: 'customfield_10006',
  });
});

test('readStoryPoints treats zero as a real estimate, not as absent', () => {
  // A zero-point spike is a legitimate estimate. Truthiness checks report it as
  // unestimated, which would inflate the data-quality finding count.
  assert.deepEqual(readStoryPoints({ customfield_10006: 0 }, MAP.storyPoints), {
    points: 0,
    field: 'customfield_10006',
  });
});

test('readStoryPoints reports null when neither field holds a number', () => {
  assert.deepEqual(readStoryPoints({ customfield_10006: null, customfield_11000: null }, MAP.storyPoints), {
    points: null,
    field: null,
  });
});

test('normaliseIssue keeps status name and category separately', () => {
  const i = normaliseIssue(rawIssue(), MAP, { keepIndividuals: true, backlogKeys: new Set() });
  assert.equal(i.status, 'Product Owner Review');
  // The whole point: this custom status is categorised To Do, so any metric that
  // guessed from the name would classify it as review/in-progress work.
  assert.equal(i.statusCategory, 'To Do');
  assert.deepEqual(i.sprintIds, [6145]);
  assert.equal(i.storyPoints, null);
  assert.equal(i.storyPointsField, null);
  assert.equal(i.flagged, false);
  assert.equal(i.inBacklog, false);
});

test('normaliseIssue treats an empty Flagged array as not blocked', () => {
  const empty = normaliseIssue(rawIssue({ customfield_10400: [] }), MAP, {
    keepIndividuals: true,
    backlogKeys: new Set(),
  });
  assert.equal(empty.flagged, false);
  const flagged = normaliseIssue(rawIssue({ customfield_10400: [{ value: 'Impediment' }] }), MAP, {
    keepIndividuals: true,
    backlogKeys: new Set(),
  });
  assert.equal(flagged.flagged, true);
});

test('normaliseIssue drops every person when attribution is off', () => {
  const raw = rawIssue({
    assignee: { accountId: 'a1', displayName: 'Someone', emailAddress: 's@acme.example' },
  });
  const i = normaliseIssue(raw, MAP, { keepIndividuals: false, backlogKeys: new Set() });
  assert.equal(i.assignee, undefined);
  assert.equal(i.reporter, undefined);
  assert.equal(i.creator, undefined);
  // Nothing person-shaped may survive serialisation, or the "not collected"
  // guarantee is only a display convention.
  assert.ok(!JSON.stringify(i).includes('acme.example'));
});

test('normaliseIssue records backlog membership from the board backlog set', () => {
  const i = normaliseIssue(rawIssue(), MAP, { keepIndividuals: true, backlogKeys: new Set(['WEB-1387']) });
  assert.equal(i.inBacklog, true);
});

test('normaliseIssue flattens both directions of an issue link', () => {
  const raw = rawIssue({
    issuelinks: [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'WEB-99' } },
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'WEB-1' } },
    ],
  });
  const i = normaliseIssue(raw, MAP, { keepIndividuals: true, backlogKeys: new Set() });
  assert.deepEqual(i.links, [
    { type: 'blocks', direction: 'outward', key: 'WEB-99' },
    { type: 'is blocked by', direction: 'inward', key: 'WEB-1' },
  ]);
});

test('normaliseIssue sorts sprintIds chronologically', () => {
  // The real order Jira returned for WEB-1180: insertion order, with the
  // currently active sprint (6145) sitting second rather than last.
  const raw = rawIssue({
    customfield_10001: [5462, 6145, 5840, 5566, 5976, 5636, 5738].map((id) => ({
      id,
      name: `s${id}`,
      state: id === 6145 ? 'active' : 'closed',
    })),
  });
  const i = normaliseIssue(raw, MAP, { keepIndividuals: true, backlogKeys: new Set() });
  assert.deepEqual(i.sprintIds, [5462, 5566, 5636, 5738, 5840, 5976, 6145]);
});

test('extractSprints handles a single non-array sprint value', () => {
  assert.deepEqual(extractSprints({ fields: { customfield_10001: REAL_SPRINT } }, MAP).map((s) => s.id), [6145]);
  assert.deepEqual(extractSprints({ fields: { customfield_10001: null } }, MAP), []);
});

test('mergeSprints lets board data win but keeps issue-only sprints', () => {
  const fromIssues = [
    { id: 6145, name: 'stale name', state: 'active' },
    { id: 6000, name: 'deleted from board', state: 'closed' },
  ];
  const fromBoard = [{ id: 6145, name: 'Panther services 55', state: 'active', goal: 'g' }];
  const merged = mergeSprints(fromBoard, fromIssues);
  assert.deepEqual(merged.map((s) => s.id), [6000, 6145]);
  assert.equal(merged[1]?.name, 'Panther services 55');
  assert.equal(merged[1]?.goal, 'g');
  // An issue referencing a sprint the board no longer lists must still resolve,
  // otherwise its sprintIds point at nothing.
  assert.equal(merged[0]?.name, 'deleted from board');
});

// --- detail merge: not-collected must never render as collected-and-empty ----

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1225', id: '1', issueType: 'Story', status: 'To Do', statusCategory: 'To Do',
    created: '2026-01-05T09:00:00.000+0000', updated: '2026-08-20T09:00:00.000+0000',
    storyPoints: null, storyPointsField: null, flagged: false, labels: [], components: [],
    sprintIds: [], links: [], inBacklog: true, ...over,
  };
}

const NO_EPICS = new Map<string, EpicSnapshot>();

test('a detail payload with no comment half leaves comments NOT COLLECTED', () => {
  // The backlog leg of the detail pass fetches fields=summary,description with
  // no `comment`, so it has nothing to say about the thread. Writing [] and 0
  // there claimed 400 backlog tickets on the 2026-08-28 snapshot had been read
  // and found silent.
  const detail = new Map([['WEB-1225', { description: 'a description' }]]);
  const [out] = applyIssueDetail([issue()], detail, NO_EPICS);
  assert.equal(out?.description, 'a description');
  assert.equal(out?.comments, undefined);
  assert.equal(out?.commentCount, undefined);
});

test('a detail payload that DID read the thread and found none records that', () => {
  const detail = new Map([['WEB-1225', { comments: [], commentTotal: 0 }]]);
  const [out] = applyIssueDetail([issue()], detail, NO_EPICS);
  assert.deepEqual(out?.comments, []);
  assert.equal(out?.commentCount, 0);
});

// This is the ordering contract every consumer of `IssueSnapshot.comments`
// depends on, and until now nothing pinned it. Jira's `comment` field returns
// comments OLDEST first; the collector keeps the last COMMENTS_PER_ISSUE and
// reverses them, so what lands in the snapshot is NEWEST FIRST. Verified against
// every multi-comment issue in data/acme/2026-09-01.
//
// blockerInComments (interventions.ts) walks forward expecting the newest first,
// attentionItems reads comments[0] as the latest, and mostDiscussed read the
// LAST element and mislabelled the oldest kept comment as `latestComment`. A
// silent flip here breaks all three in different directions, so it is asserted
// on the collector rather than left as a comment in three consumers.
test('recentComments returns the thread NEWEST first, with the untruncated total', () => {
  const field = {
    total: 27,
    comments: [
      { id: '1', created: '2026-08-01T09:00:00.000+0100', body: 'picked this up' },
      { id: '2', created: '2026-08-14T09:00:00.000+0100', body: 'still digging' },
      { id: '3', created: '2026-08-20T09:00:00.000+0100', body: 'waiting on the platform team' },
      { id: '4', created: '2026-08-29T09:00:00.000+0100', body: 'blocked, chased twice' },
    ],
  };
  const { comments, total } = recentComments(field, true);

  // The three NEWEST, newest first - not the three oldest, which on a
  // long-running ticket are the ones that say "picked this up".
  assert.deepEqual(comments.map((c) => c.id), ['4', '3', '2']);
  assert.equal(comments[0]?.body, 'blocked, chased twice');
  // `total` is the whole thread, so the UI can say "3 of 27".
  assert.equal(total, 27);
});

test('toPerson omits an absent email rather than emitting null', () => {
  assert.deepEqual(toPerson({ accountId: 'a', displayName: 'B' }, true), {
    accountId: 'a',
    displayName: 'B',
    email: undefined,
  });
  assert.equal(toPerson(null, true), undefined);
});
