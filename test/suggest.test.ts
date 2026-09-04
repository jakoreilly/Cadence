import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardFacts,
  formatSuggestions,
  knownProjectKeys,
  namesMatch,
  normaliseName,
  scoreGroup,
  scoreGroups,
  type GroupActivity,
  type SuggestMergeRequest,
} from '../src/gitlab/suggest.js';
import { SCHEMA_VERSION, type IssueSnapshot, type JiraSnapshot, type TeamSnapshot } from '../src/types.js';

// ---------------------------------------------------------------------------
// Every value in this file is a shape observed on the real estate, not an
// invented one: the four configured boards and their project keys, the group
// paths, the automation account's two forms (username `bot`, display name
// "I'm a Bot"), and the shared groups that must NOT be proposed. The test that
// matters most is the last one - the whole thing scored end to end, reproducing
// the four mappings that were confirmed by hand in the third session.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-26T21:20:39.978Z');

function issue(key: string, assignee: string | undefined, over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key,
    id: key,
    issueType: 'Story',
    status: 'In Development',
    statusCategory: 'In Progress',
    created: '2026-06-01T09:00:00.000Z',
    updated: '2026-08-20T09:00:00.000Z',
    storyPoints: null,
    storyPointsField: null,
    flagged: false,
    labels: [],
    components: [],
    sprintIds: [1],
    links: [],
    inBacklog: false,
    ...(assignee ? { assignee: { accountId: `acc-${assignee}`, displayName: assignee } } : {}),
    ...over,
  };
}

function board(key: string, boardId: number, boardName: string, keys: string[], people: string[]): TeamSnapshot {
  const issues: IssueSnapshot[] = [];
  let n = 1000;
  for (const prefix of keys) {
    for (const person of people) issues.push(issue(`${prefix}-${n++}`, person));
    // A few unassigned and a few older items, which is what every real board
    // looks like and what makes the recent/all-time distinction bite.
    issues.push(issue(`${prefix}-${n++}`, undefined));
  }
  return {
    key,
    boardId,
    boardName,
    boardType: 'scrum',
    columns: [],
    sprints: [{ id: 1, name: `${key} active`, state: 'active' }],
    issues,
    epics: [],
    errors: [],
  };
}

// The four real boards, their real project keys, and the assignee names the
// live run of this command actually matched (docs/handover.md and the
// suggest-groups run of the eighth session). Sized so the evidence VOLUMES
// below can reproduce the live numbers, because the thresholds turn on absolute
// counts and a two-author fixture cannot exercise them.
const PANTHER = board('panther', 701, 'WEB Scrum', ['WEB'], ['Alex Doran', 'Andre Lima']);
const LOG = board('tran', 702, 'Logistics Scrum Board', ['LOG'], [
  'Nia Barrett',
  'Bruno Alves',
  'Nora Vance',
  'Rosa D Amico',
  'Priya Raman',
  'Marcus David Lowe',
]);
const ONB = board('fcp', 704, 'ONB Scrum', ['ONB'], [
  'Omar Haddad',
  'Sam Whelan',
  'Karim Fahmy',
  'Diogo Pires',
  'Tomas Reid',
]);
const PAY = board('fs', 705, 'PAY & CSP', ['PAY', 'CSP'], [
  'Hugo Costa',
  'Pablo Neves',
  'Cian Brady',
  'Arjun Mehta',
  'Ravi Kapoor',
  'Vikram Bose',
  'David Okafor',
  'Sasi Varma',
]);

const BOARDS = [
  boardFacts(PANTHER, ['web-storefront'], { now: NOW }),
  boardFacts(LOG, ['logistics-hub'], { now: NOW }),
  boardFacts(ONB, ['onboarding-hub'], { now: NOW }),
  boardFacts(PAY, ['payments-core'], { now: NOW }),
];

const JIRA: JiraSnapshot = {
  schemaVersion: SCHEMA_VERSION,
  source: 'jira',
  site: 'acme.atlassian.net',
  capturedAt: NOW.toISOString(),
  individualAttribution: true,
  fieldMap: { discoveredAt: NOW.toISOString(), sprint: 'customfield_10001', storyPoints: ['customfield_10006'] },
  teams: [PANTHER, LOG, ONB, PAY],
};

const KNOWN = knownProjectKeys(JIRA);
const BOTS = ['SonarQube', "I'm a Bot", 'bot'];

function mr(title: string, branch: string, author: string, username?: string): SuggestMergeRequest {
  return { title, sourceBranch: branch, authorName: author, authorUsername: username ?? author.toLowerCase().replace(/\W+/g, '.') };
}

/** `n` merge requests, each carrying a real key from `team`, spread round-robin
 *  over `authors`. The live thresholds turn on absolute counts, so a fixture has
 *  to carry realistic VOLUME - the four confirmed mappings run from 2 to 36 key
 *  hits and 2 to 8 matched authors. */
function keyedMrs(team: TeamSnapshot, n: number, authors: string[], tag: string): SuggestMergeRequest[] {
  const keys = team.issues.map((i) => i.key);
  return Array.from({ length: n }, (_, i) =>
    mr(`${keys[i % keys.length]} ${tag} ${i}`, `feature/${tag}-${i}`, authors[i % authors.length]!),
  );
}

function group(fullPath: string, mergeRequests: SuggestMergeRequest[], over: Partial<GroupActivity> = {}): GroupActivity {
  return {
    id: 42,
    fullPath,
    name: fullPath,
    webUrl: `https://gitlab.example.com/groups/${fullPath}`,
    isMember: false,
    parentId: null,
    mergeRequests,
    truncated: false,
    ...over,
  };
}

// --- name matching ------------------------------------------------------------

test('normaliseName folds case, punctuation and accents', () => {
  assert.equal(normaliseName('  Alex   Doran '), 'alex doran');
  assert.equal(normaliseName('D’Amico, Rosa'), 'd amico rosa');
  assert.equal(normaliseName('Dorán'), 'doran');
});

test('namesMatch tolerates token order and a missing middle name', () => {
  assert.ok(namesMatch('Marcus David Lowe', 'Marcus David Lowe'));
  assert.ok(namesMatch('Lowe, Marcus David', 'Marcus David Lowe'));
  assert.ok(namesMatch('Marcus David Lowe', 'Marcus Lowe'));
});

// GOTCHA: one shared token is NOT a match, and this is not fussiness. The
// people axis is reported as a headcount share, so a single false match on a
// six-author group moves it by 17 points - enough to hand a shared
// infrastructure group a "propose" verdict it has not earned.
test('namesMatch refuses a single shared token', () => {
  assert.equal(namesMatch('Priya Raman', 'Priya Sethi'), false);
  assert.equal(namesMatch('Nora Vance', 'Nora'), false);
  assert.equal(namesMatch('', 'Nora Vance'), false);
});

// --- board facts --------------------------------------------------------------

test('boardFacts counts project keys from the ISSUES, not the board location', () => {
  const facts = boardFacts(PAY, ['payments-core'], { now: NOW });
  // Board 705 carries both PAY and CSP work; its location.projectKey would name
  // one of them at most (GOTCHA 18).
  assert.deepEqual(facts.projectKeys.sort(), ['CSP', 'PAY']);
});

// GOTCHA: an all-time assignee list on a long-lived board is most of the
// department, so a group of strangers can score highly against it. The basis
// switches to `recent` where there are enough recently-active people to divide
// by, and the output has to SAY which basis it used.
test('boardFacts scopes assignees to recent activity where it can', () => {
  const busy = board('busy', 1, 'Busy', ['BSY'], ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six']);
  const facts = boardFacts(busy, [], { now: NOW });
  assert.equal(facts.assigneeBasis, 'recent');
  assert.equal(facts.assigneeCount, 6);

  // Same board, every issue untouched for a year: nothing recent to divide by,
  // so it falls back and says so rather than reporting an empty people axis.
  const stale: TeamSnapshot = { ...busy, issues: busy.issues.map((i) => ({ ...i, updated: '2025-01-01T00:00:00.000Z' })) };
  const staleFacts = boardFacts(stale, [], { now: NOW });
  assert.equal(staleFacts.assigneeBasis, 'all');
  assert.equal(staleFacts.assigneeCount, 6);
});

// --- the key axis -------------------------------------------------------------

test('key hits count merge requests, not keys', () => {
  const keys = [...PANTHER.issues.map((i) => i.key)];
  const s = scoreGroup(
    group('web-storefront', [mr(`${keys[0]} ${keys[1]} ${keys[2]} batch fix`, 'feature/batch', 'Alex Doran')]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  const panther = s.scores.find((x) => x.team === 'panther')!;
  assert.equal(panther.keyHits, 1, 'one merge request is one piece of evidence, not three');
});

// GOTCHA 7: V2-3 is a syntactically valid Jira key, and branch names on this
// instance also yield UTF, CVE and ISO. Only project keys present in the
// snapshot survive.
test('keys that are not projects on this site are discarded', () => {
  const s = scoreGroup(
    group('noise', [
      mr('Bump to UTF-8 and fix CVE-2026-1 per ISO-27001', 'chore/V2-3', 'Someone Else'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.deepEqual(s.prefixes, []);
  assert.equal(s.verdict, 'none');
});

// GOTCHA 15, and the ORDER of the reading is the point: a zero key count is
// evidence of the WRONG BOARD at least as much as it is evidence about branch
// naming. This is the logistics-hub/WEB case that was misread once.
test('a zero key count against the leading board names the projects it DOES carry', () => {
  const tranKeys = LOG.issues.filter((i) => i.assignee).map((i) => i.key);
  // Author matches panther (Ricardo is a board-701 assignee), but every issue
  // key in the group belongs to LOG. Scored against panther alone this would
  // read as "this group does not use issue keys".
  // ONE board configured, which is the state the estate was actually in when
  // this was misread: only board 701 existed in the profile, `logistics-hub` was
  // mapped to it, and its zero WEB hits were written up as a branch-naming
  // problem. The note has to name LOG and send the reader to the mapping.
  const s = scoreGroup(
    group('logistics-hub', [
      mr(`${tranKeys[0]} fix`, 'feature/tran-a', 'Andre Lima'),
      mr(`${tranKeys[1]} fix`, 'feature/tran-b', 'Andre Lima'),
    ]),
    [BOARDS[0]!],
    { known: KNOWN, botAccounts: BOTS },
  );
  const panther = s.scores.find((x) => x.team === 'panther')!;
  assert.equal(panther.keyHits, 0);
  assert.equal(panther.matchedAuthors.length, 1, 'Ricardo is a board-701 assignee, which is why this looked plausible');
  const note = s.notes.join(' ');
  assert.match(note, /LOG \(2\)/);
  assert.match(note, /Check the mapping first/);
  // And the finding that makes team five cheap: real key-tagged work against a
  // project with no board configured is a candidate TEAM, not a bad mapping.
  assert.match(note, /a team nobody has added yet/);

  // Add the LOG board and the same evidence resolves itself - which is the
  // corrected GOTCHA 15 in one assertion.
  const withTran = scoreGroup(
    group('logistics-hub', [
      mr(`${tranKeys[0]} fix`, 'feature/tran-a', 'Andre Lima'),
      mr(`${tranKeys[1]} fix`, 'feature/tran-b', 'Andre Lima'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(withTran.best!.team, 'tran');
  assert.equal(withTran.best!.keyHits, 2);
});

// --- the people axis ----------------------------------------------------------

// GOTCHA 14/20 applied to the mapping: the automation account authors more
// merge requests than any person here and is an assignee on no board, so
// leaving it in the denominator drags the share down by however much CI runs in
// that group. Both of its forms have to be caught - username `bot`, display
// name "I'm a Bot".
test('automation authors are excluded from the denominator, by either form', () => {
  const keys = PANTHER.issues.map((i) => i.key);
  const s = scoreGroup(
    group('web-storefront', [
      mr(`${keys[0]} real work`, 'feature/a', 'Alex Doran'),
      mr('Bump dependency', 'renovate/x', 'SonarQube', 'SonarQube'),
      mr('Fix analyser finding', 'sonar/y', "I'm a Bot", 'bot'),
      mr('Another analyser finding', 'sonar/z', 'Someone Undeclared', 'bot'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.deepEqual(s.humanAuthors, ['Alex Doran']);
  assert.equal(s.automationAuthors.length, 3);
  const panther = s.scores.find((x) => x.team === 'panther')!;
  assert.equal(panther.humanAuthors, 1);
  assert.equal(panther.authorShare, 1);
});

test('an author who opened forty merge requests counts once', () => {
  const keys = PANTHER.issues.map((i) => i.key);
  const s = scoreGroup(
    group('web-storefront', Array.from({ length: 40 }, (_, i) => mr(`${keys[0]} part ${i}`, 'f/a', 'Alex Doran'))),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(s.humanAuthors.length, 1);
  assert.equal(s.mergeRequestCount, 40);
});

// --- verdicts -----------------------------------------------------------------

// onboarding-hub as the live run measured it: 21 key hits, 5 of 7 human authors, one
// automation account excluded.
test('strong key evidence with the people agreeing is proposed', () => {
  const s = scoreGroup(
    group('onboarding-hub', [
      ...keyedMrs(ONB, 21, ['Omar Haddad', 'Sam Whelan', 'Karim Fahmy', 'Diogo Pires', 'Tomas Reid'], 'fcp'),
      mr('PayGateway integration', 'feature/paygateway', 'David Okafor'),
      mr('Shared tooling', 'chore/tooling', 'Somebody Unknown'),
      mr('chore: bump', 'chore/bump', 'SonarQube', 'SonarQube'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(s.verdict, 'propose');
  assert.equal(s.best!.team, 'fcp');
  assert.equal(s.best!.keyHits, 21);
  assert.equal(s.best!.matchedAuthors.length, 5);
  assert.equal(s.best!.humanAuthors, 7);
  assert.match(s.notes.join(' '), /the issue keys carry it/);
  assert.match(s.notes.join(' '), /Already configured for fcp, and the evidence still agrees/);
});

// logistics-hub as the live run measured it, and the case the thresholds exist
// for: only 2 key hits - fewer than `gateway-common`, which must NOT be proposed -
// but 6 of 8 authors, so the PEOPLE carry it. A rule keyed on key hits alone
// would reject the best-documented mapping on the estate.
test('strong people evidence with one key hit is proposed', () => {
  const s = scoreGroup(
    group('logistics-hub', [
      ...keyedMrs(LOG, 2, ['Nia Barrett', 'Nora Vance'], 'tran'),
      ...['Bruno Alves', 'Rosa D Amico', 'Priya Raman', 'Marcus David Lowe'].map((a, i) =>
        mr(`untagged work ${i}`, `feature/no-key-${i}`, a),
      ),
      mr('outside work a', 'feature/x', 'Contractor One'),
      mr('outside work b', 'feature/y', 'Contractor Two'),
      mr('chore: bump', 'chore/bump', "I'm a Bot", 'bot'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(s.verdict, 'propose');
  assert.equal(s.best!.team, 'tran');
  assert.equal(s.best!.keyHits, 2);
  assert.equal(s.best!.matchedAuthors.length, 6);
  assert.equal(s.best!.humanAuthors, 8);
  assert.match(s.notes.join(' '), /the people carry it/);
});

// GOTCHA: the case that changed the thresholds. `gateway-common` is named in
// docs/handover.md as a shared group that must never be proposed, and the first
// cut proposed it for panther on 3 merge requests, 1 key hit and 2 of 2 authors
// - a 100% share that is one person agreeing with themselves. One axis has to
// clear an absolute bar, not just a percentage.
test('a tiny group with a 100% author share is not proposed', () => {
  const s = scoreGroup(
    group('gateway-common', [
      mr(`${PANTHER.issues[0]!.key} gateway`, 'feature/ret', 'Andre Lima'),
      mr('gateway tidy', 'chore/tidy', 'Alex Doran'),
      mr('gateway readme', 'docs/readme', 'Andre Lima'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(s.best!.team, 'panther');
  assert.equal(s.best!.authorShare, 1, 'both authors are board-701 assignees, which is why it looked convincing');
  assert.equal(s.verdict, 'possible');
  const note = s.notes.join(' ');
  assert.match(note, /too thin to propose/);
  assert.match(note, /one or two people agreeing with themselves/);
});

// The rejection that matters. `Acme`, `shared-platform`, `smt`
// and `gateway-common` all match one or two people on several boards at once, and
// configuring one against a team would attribute four teams' work to whichever
// board edged it. Breadth without depth is not a team.
test('a group matching several boards weakly is called shared, not proposed', () => {
  const s = scoreGroup(
    group('shared-platform', [
      // One person per board plus a stranger, which is what the live run found:
      // 5 human authors, 2 matched on fcp, 2 on panther, 1 on fs, 1 on tran.
      mr('Shared logging library', 'chore/logging', 'Andre Lima'),
      mr('Shared auth library', 'chore/auth', 'Nia Barrett'),
      mr('Shared metrics', 'chore/metrics', 'David Okafor'),
      mr('Shared config', 'chore/config', 'Omar Haddad'),
      mr('Shared docs', 'docs/readme', 'Somebody Else'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(s.verdict, 'shared');
  const note = s.notes.join(' ');
  assert.match(note, /shape of a shared or infrastructure group/);
  assert.match(note, /Do NOT configure it against a team/);
});

test('the axes disagreeing is a lead, never a mapping', () => {
  const tranKeys = LOG.issues.map((i) => i.key);
  const s = scoreGroup(
    group('mixed', [
      // Keys say tran; every human author is a panther assignee.
      mr(`${tranKeys[0]} fix`, 'feature/a', 'Alex Doran'),
      mr(`${tranKeys[1]} fix`, 'feature/b', 'Andre Lima'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.equal(s.verdict, 'possible');
  assert.match(s.notes.join(' '), /axes DISAGREE/);
});

test('a group already configured for a different team is flagged loudly', () => {
  const fcpKeys = ONB.issues.map((i) => i.key);
  const s = scoreGroup(
    // `payments-core` is configured for fs, but here it looks like fcp.
    group('payments-core', [
      mr(`${fcpKeys[0]} a`, 'f/a', 'Tomas Reid'),
      mr(`${fcpKeys[1]} b`, 'f/b', 'Anu Mathew'),
    ]),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.match(s.notes.join(' '), /already configured for fs, but the evidence now points at fcp/);
});

test('a group with no merge requests in the window is not a team', () => {
  const s = scoreGroup(group('dormant', []), BOARDS, { known: KNOWN, botAccounts: BOTS });
  assert.equal(s.verdict, 'none');
  assert.match(s.notes.join(' '), /nothing to score/);
});

test('a group whose merge requests could not be read reports the error, not a zero', () => {
  const s = scoreGroup(group('forbidden', [], { error: 'GitLab 403 on /groups/forbidden/merge_requests' }), BOARDS, {
    known: KNOWN,
  });
  assert.equal(s.verdict, 'none');
  assert.match(s.notes.join(' '), /could not be read/);
});

test('a truncated window says every count is a lower bound', () => {
  const keys = ONB.issues.map((i) => i.key);
  const s = scoreGroup(
    group(
      'onboarding-hub',
      [mr(`${keys[0]} a`, 'f/a', 'Tomas Reid'), mr(`${keys[1]} b`, 'f/b', 'Anu Mathew')],
      { truncated: true },
    ),
    BOARDS,
    { known: KNOWN, botAccounts: BOTS },
  );
  assert.match(s.notes.join(' '), /LOWER bound/);
});

// --- the whole thing ----------------------------------------------------------

// The recipe reproduced: four groups, four boards, scored in one pass, with two
// shared groups mixed in. This is the third session's hand-run as a regression
// test, and it is the reason the command can be trusted with team five.
test('the four real mappings come back, and the shared groups do not', () => {
  const activity: GroupActivity[] = [
    // Volumes and author counts as the live run measured them.
    group('web-storefront', [
      ...keyedMrs(PANTHER, 11, ['Alex Doran', 'Andre Lima'], 'ret'),
      mr('Bump dependency', 'renovate/dep', 'SonarQube', 'SonarQube'),
    ]),
    group('logistics-hub', [
      ...keyedMrs(LOG, 2, ['Nia Barrett', 'Nora Vance'], 'tran'),
      ...['Bruno Alves', 'Rosa D Amico', 'Priya Raman', 'Marcus David Lowe'].map((a, i) =>
        mr(`untagged ${i}`, `feature/nokey-${i}`, a),
      ),
      mr('outside a', 'feature/x', 'Contractor One'),
      mr('outside b', 'feature/y', 'Contractor Two'),
    ]),
    group('onboarding-hub', [
      ...keyedMrs(ONB, 21, ['Omar Haddad', 'Sam Whelan', 'Karim Fahmy', 'Diogo Pires', 'Tomas Reid'], 'fcp'),
      mr('PayGateway', 'feature/paygateway', 'David Okafor'),
      mr('Tooling', 'chore/tooling', 'Somebody Unknown'),
    ]),
    group('payments-core', [
      ...keyedMrs(
        PAY,
        36,
        ['Hugo Costa', 'Pablo Neves', 'Cian Brady', 'Arjun Mehta', 'Ravi Kapoor', 'Vikram Bose', 'David Okafor', 'Sasi Varma'],
        'fs',
      ),
      ...['Outsider One', 'Outsider Two', 'Outsider Three'].map((a, i) => mr(`misc ${i}`, `chore/misc-${i}`, a)),
    ]),
    // The subgroups. Each carries a slice of its parent's merge requests,
    // because that is what GitLab returns - the parent listing INCLUDES these.
    group('onboarding-hub/v2', keyedMrs(ONB, 21, ['Omar Haddad', 'Sam Whelan', 'Karim Fahmy', 'Diogo Pires', 'Tomas Reid'], 'fcp')),
    group('payments-core/gpg', keyedMrs(PAY, 9, ['Cian Brady', 'Arjun Mehta', 'David Okafor', 'Sasi Varma'], 'fs')),
    group('payments-core/gpg/tests', keyedMrs(PAY, 6, ['Cian Brady', 'Arjun Mehta', 'David Okafor'], 'fs')),
    // The shared groups, which look like a little of everything.
    group('shared-platform', [
      mr('Shared logging', 'chore/log', 'Andre Lima'),
      mr('Shared auth', 'chore/auth', 'Nia Barrett'),
      mr('Shared metrics', 'chore/metrics', 'David Okafor'),
      mr('Shared config', 'chore/config', 'Omar Haddad'),
      mr('Shared docs', 'docs/x', 'Somebody Else'),
    ]),
    group('gateway-common', [
      mr(`${PANTHER.issues[0]!.key} gateway`, 'feature/ret', 'Andre Lima'),
      mr('gateway tidy', 'chore/tidy', 'Alex Doran'),
      mr('gateway readme', 'docs/readme', 'Andre Lima'),
    ]),
  ];

  const scored = scoreGroups(activity, BOARDS, { known: KNOWN, botAccounts: BOTS });
  // Exactly the four mappings, and not one more: a subgroup of a proposed
  // parent is the SAME merge requests counted again, and the live run produced
  // nineteen proposals before they were collapsed.
  const proposed = new Map(
    scored.filter((s) => s.verdict === 'propose' && !s.coveredBy).map((s) => [s.group.fullPath, s.best!.team]),
  );
  assert.deepEqual(
    [...proposed.entries()].sort(),
    [
      ['logistics-hub', 'tran'],
      ['onboarding-hub', 'fcp'],
      ['payments-core', 'fs'],
      ['web-storefront', 'panther'],
    ],
  );

  // The subgroups still carry their evidence, and each names the NEAREST
  // proposed ancestor rather than the top of the tree.
  assert.equal(scored.find((s) => s.group.fullPath === 'onboarding-hub/v2')!.coveredBy, 'onboarding-hub');
  assert.equal(scored.find((s) => s.group.fullPath === 'payments-core/gpg')!.coveredBy, 'payments-core');
  assert.equal(scored.find((s) => s.group.fullPath === 'payments-core/gpg/tests')!.coveredBy, 'payments-core/gpg');

  const csi = scored.find((x) => x.group.fullPath === 'shared-platform')!;
  assert.equal(csi.verdict, 'shared', 'shared infrastructure must not be proposed against a team');
  // gateway-common is named in the handover as a group that must not be proposed. It
  // is too small to judge either way, and "possible" says exactly that.
  assert.equal(scored.find((x) => x.group.fullPath === 'gateway-common')!.verdict, 'possible');

  // Proposals sort first, and covered subgroups after the parent that covers
  // them, so the reader meets the four answers before the restatements.
  assert.equal(scored[0]!.verdict, 'propose');
  assert.equal(scored[0]!.coveredBy, null);

  const text = formatSuggestions(scored, BOARDS, { windowDays: 30 });
  assert.match(text, /PROPOSED - both axes agree/);
  assert.match(text, /SHARED \/ INFRASTRUCTURE/);
  assert.match(text, /panther <- web-storefront/);
  // The evidence is on the page, not just the conclusion.
  assert.match(text, /issue keys seen: WEB/);
  assert.match(text, /Nothing here has been written to the profile/);
  // And the membership footnote, which is GOTCHA 16 - the failure that hid the
  // correct group entirely.
  assert.match(text, /a manager is often not a member/);
});
