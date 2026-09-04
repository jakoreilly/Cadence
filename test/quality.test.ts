import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSprintOf, assessTeam, isDone } from '../src/quality.js';
import type { IssueSnapshot, TeamSnapshot } from '../src/types.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1',
    id: '1',
    issueType: 'Story',
    status: 'In Progress',
    statusCategory: 'In Progress',
    created: '2026-08-20T09:00:00.000Z',
    updated: '2026-08-31T09:00:00.000Z',
    storyPoints: 3,
    storyPointsField: 'customfield_10006',
    flagged: false,
    labels: [],
    components: [],
    sprintIds: [6145],
    links: [],
    inBacklog: false,
    assignee: { accountId: 'a', displayName: 'Dev One' },
    ...over,
  };
}

function team(issues: IssueSnapshot[], over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    key: 'panther',
    boardId: 701,
    boardName: 'Panther',
    boardType: 'scrum',
    columns: [{ name: 'In Progress', statusIds: ['3'] }],
    sprints: [
      {
        id: 6145,
        name: 'Panther services 55',
        state: 'active',
        goal: 'Deliver PPUS',
        startDate: '2026-08-26T10:17:42.427Z',
        endDate: '2026-09-08T23:00:00.000Z',
      },
    ],
    issues,
    errors: [],
    ...over,
  };
}

const OPTS = { staleDays: 10, now: NOW };
const codes = (t: TeamSnapshot) => assessTeam(t, OPTS).findings.map((f) => f.code);

test('isDone uses the status category, not the status name', () => {
  // The live example: a status called "Product Owner Review" is categorised To Do.
  assert.equal(isDone(issue({ status: 'Product Owner Review', statusCategory: 'To Do' })), false);
  assert.equal(isDone(issue({ status: 'Closed - Wont Fix', statusCategory: 'Done' })), true);
});

test('a clean team produces no findings', () => {
  assert.deepEqual(codes(team([issue()])), []);
});

test('unestimated open work in the active sprint is a high finding with a rate', () => {
  const result = assessTeam(team([issue({ storyPoints: null, storyPointsField: null }), issue({ key: 'WEB-2' })]), OPTS);
  const f = result.findings.find((x) => x.code === 'unestimated-in-sprint');
  assert.equal(f?.severity, 'high');
  assert.equal(f?.count, 1);
  assert.equal(f?.outOf, 2);
  assert.deepEqual(f?.examples, ['WEB-1']);
});

test('done issues are excluded from the open-work denominators', () => {
  const result = assessTeam(
    team([
      issue({ key: 'WEB-1', statusCategory: 'Done', storyPoints: null, storyPointsField: null }),
      issue({ key: 'WEB-2' }),
    ]),
    OPTS,
  );
  // The unestimated issue is Done, so it is neither counted nor in the denominator.
  assert.equal(result.findings.find((x) => x.code === 'unestimated-in-sprint'), undefined);
  assert.equal(result.counts.inActiveSprint, 2);
});

test('stale in-progress work is detected only for the In Progress category', () => {
  const stale = { key: 'WEB-9', updated: '2026-08-01T09:00:00.000Z' };
  assert.ok(codes(team([issue(stale)])).includes('stale-in-progress'));
  // Same age, but sitting in To Do - not started, so not stalled.
  assert.ok(!codes(team([issue({ ...stale, statusCategory: 'To Do' })])).includes('stale-in-progress'));
});

test('three-sprint carryover is flagged but two sprints is not', () => {
  assert.ok(codes(team([issue({ sprintIds: [6100, 6120, 6145] })])).includes('carried-three-plus-sprints'));
  assert.ok(!codes(team([issue({ sprintIds: [6120, 6145] })])).includes('carried-three-plus-sprints'));
});

test('story points split across both fields is reported', () => {
  const t = team([issue({ key: 'WEB-1' }), issue({ key: 'WEB-2', storyPointsField: 'customfield_11000' })]);
  const f = assessTeam(t, OPTS).findings.find((x) => x.code === 'story-points-split-across-fields');
  assert.equal(f?.severity, 'high');
  assert.ok(f?.detail.includes('customfield_10006'));
  assert.ok(f?.detail.includes('customfield_11000'));
});

test('two active sprints on one board is a high finding', () => {
  const t = team([issue()], {
    sprints: [
      { id: 6145, name: 'Panther 55', state: 'active', goal: 'g', startDate: '2026-08-26T00:00:00.000Z' },
      { id: 6146, name: 'Other 12', state: 'active', goal: 'g', startDate: '2026-08-27T00:00:00.000Z' },
    ],
  });
  const f = assessTeam(t, OPTS).findings.find((x) => x.code === 'multiple-active-sprints');
  assert.equal(f?.severity, 'high');
  // The later-starting sprint is the one reported as active.
  assert.equal(activeSprintOf(t)?.id, 6146);
});

test('a missing sprint goal is reported', () => {
  const t = team([issue()], {
    sprints: [{ id: 6145, name: 'Panther 55', state: 'active', startDate: '2026-08-26T00:00:00.000Z' }],
  });
  const result = assessTeam(t, OPTS);
  assert.ok(result.findings.some((f) => f.code === 'sprint-goal-missing'));
  assert.equal(result.activeSprint?.hasGoal, false);
});

test('issues created after the sprint started are counted as approximate churn', () => {
  const t = team([issue({ key: 'WEB-1' }), issue({ key: 'WEB-2', created: '2026-08-28T09:00:00.000Z' })]);
  const f = assessTeam(t, OPTS).findings.find((x) => x.code === 'created-after-sprint-start');
  assert.equal(f?.count, 1);
  assert.deepEqual(f?.examples, ['WEB-2']);
  assert.ok(f?.detail.includes('approximate'));
});

test('a kanban board with no active sprint still reports counts and errors', () => {
  const t = team([issue({ sprintIds: [], inBacklog: true })], {
    boardType: 'kanban',
    sprints: [],
    errors: ['sprints: Jira API /rest/agile/1.0/board/701/sprint failed: 400 not a scrum board'],
  });
  const result = assessTeam(t, OPTS);
  assert.equal(result.activeSprint, undefined);
  assert.equal(result.counts.inActiveSprint, 0);
  assert.equal(result.counts.inBacklog, 1);
  assert.equal(result.collectionErrors.length, 1);
  // A board with no active sprint must not accrue sprint-scoped findings.
  assert.deepEqual(
    result.findings.map((f) => f.code).filter((c) => c.includes('sprint')),
    [],
  );
});

test('a Done issue with no resolution date is flagged, scoped to the whole board', () => {
  const t = team([
    issue({ key: 'WEB-1', statusCategory: 'Done', resolutionDate: undefined, sprintIds: [] }),
    issue({ key: 'WEB-2', statusCategory: 'Done', resolutionDate: '2026-08-30T09:00:00.000Z' }),
    issue({ key: 'WEB-3' }),
  ]);
  const f = assessTeam(t, OPTS).findings.find((x) => x.code === 'done-without-resolution-date');
  assert.equal(f?.count, 1);
  assert.equal(f?.outOf, 3);
  assert.deepEqual(f?.examples, ['WEB-1']);
});

test('a due date already past when the sprint started is flagged, but a future one is not', () => {
  const brokenAtPlanning = team([issue({ key: 'WEB-1', dueDate: '2026-08-01T00:00:00.000Z' })]);
  assert.ok(codes(brokenAtPlanning).includes('due-before-sprint-start'));

  const dueWithinSprint = team([issue({ key: 'WEB-2', dueDate: '2026-09-05T00:00:00.000Z' })]);
  assert.ok(!codes(dueWithinSprint).includes('due-before-sprint-start'));

  // Done work is out of the open-work denominator, same as every other
  // active-sprint finding here.
  const doneButOld = team([issue({ key: 'WEB-3', dueDate: '2026-08-01T00:00:00.000Z', statusCategory: 'Done', resolutionDate: '2026-08-27T00:00:00.000Z' })]);
  assert.ok(!codes(doneButOld).includes('due-before-sprint-start'));
});

test('a board that returned no columns is reported, unless collection errored', () => {
  assert.ok(codes(team([issue()], { columns: [] })).includes('no-board-columns'));
  // When the configuration call itself failed, the recorded error is the
  // finding - repeating it as a config problem would be misleading.
  assert.ok(!codes(team([issue()], { columns: [], errors: ['board configuration: 403'] })).includes('no-board-columns'));
});
