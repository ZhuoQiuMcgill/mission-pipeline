// Seat cards (4.2, 8.1), the program's rules for a handed-back result (8.1) and the records a
// result becomes. Pure, no processes.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { validateRecord } from '../src/common/validate.ts';
import { cardTag, parseSeatCard, renderCard, renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import { memoryPorts } from './flow-memory-fixtures.ts';
import { citedEvidence, findingRecords, judgmentRecord, parseSeatResult, resultProblems, snapshotFiles, type ResultContext, type ReviewerResult } from '../src/seat/results.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-seat-card-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const H = (c: string): string => c.repeat(64);
const COMMIT = 'a'.repeat(40);
const COMMON = {
  format: 'mp41.seat-card.v1',
  task: 'T1',
  mission: 'M1',
  module: 'mod-a',
  capabilities: ['net'],
  duties: 'Implement the parser.',
  decisionQuotes: ['"keep it small"'],
  constraints: [{ id: 'K1', text: 'no new dependencies', kind: 'object' }],
  workspace: { snapshot: COMMIT, writablePaths: ['src'] },
};

function constructorCard(over: Record<string, unknown> = {}): ConstructorCard {
  return parseSeatCard({
    ...COMMON,
    seat: 'constructor',
    goal: 'Parse the header.',
    standards: [
      { id: 'S1', text: 'parses valid headers' },
      { id: 'S2', text: 'rejects bad ones' },
    ],
    requirementItems: [{ id: 'R1', text: 'header format v2' }],
    readableFiles: ['README'],
    interpreter: 'node 22',
    verificationCommands: [{ id: 'test', command: 'npm test' }],
    interfaces: { implements: [{ name: 'parse', definition: '(s: string) => Header' }], calls: [] },
    ...over,
  }) as ConstructorCard;
}

function reviewerCard(over: Record<string, unknown> = {}): ReviewerCard {
  return parseSeatCard({
    ...COMMON,
    seat: 'reviewer',
    workspace: { snapshot: COMMIT, writablePaths: [] },
    target: 'obj-v3',
    review: 'rev-1',
    standards: [
      { id: 'S1', text: 'parses valid headers' },
      { id: 'S2', text: 'rejects bad ones' },
    ],
    interfaces: [],
    candidate: { changedPaths: ['src/parse.ts'] },
    verificationRuns: [
      { evidence: 'E1', command: 'npm test', summary: '12 passed' },
      { evidence: 'E2', command: 'npm run lint', summary: 'clean' },
    ],
    declaredCommands: [{ id: 'test', command: 'npm test' }],
    selfReportedGaps: [{ id: 'G1', text: 'no fuzzing' }],
    openIssues: [{ issue: 'I7', text: 'crash on empty input' }],
    binding: {
      judgment: 'J1',
      bases: { hash: H('a'), count: 1 },
      constraints: { hash: H('b'), count: 1 },
      reliesOn: { hash: H('c'), count: 0 },
      revokes: null,
      extends: null,
      evidenceUse: { fields: ['passed'], statisticalOrExternal: false },
      superseded: [],
    },
    ...over,
  }) as ReviewerCard;
}

/** A candidate snapshot as the pointer checker sees it: src/parse.ts has 60 lines. */
const CTX: ResultContext = { snapshot: { lines: (p) => (p === 'src/parse.ts' ? 60 : null) } };

const goodReview = (): ReviewerResult => ({
  judgments: [
    { standard: 'S1', met: 'yes', reason: 'tests pass', evidence: ['evidence:E1'] },
    { standard: 'S2', met: 'no', reason: 'accepts junk', evidence: ['file:src/parse.ts:40', 'evidence:E1'] },
  ],
  gap_responses: [{ gap: 'G1', response: 'acceptable for now' }],
  issue_responses: [{ issue: 'I7', response: 'fixed', reason: 'guard added' }],
  findings: ['the error message leaks the path'],
  verdict: 'rework',
});

describe('seat cards', () => {
  test('a Constructor card parses and renders as its first message', () => {
    const c = constructorCard();
    const text = renderCard(c);
    for (const s of ['Parse the header.', '[S1] parses valid headers', '[R1] header format v2', '- src', '[test] npm test', 'parse: (s: string) => Header', '[K1] no new dependencies']) {
      assert.ok(text.includes(s), s);
    }
    // the whole card as the seat receives it (4.1 §5.2): its worktree, its commands, the hand-back files
    const whole = renderSeatCard(c, { dispatch: 'D-1' });
    for (const s of ['.mission-pipeline/worktrees/D-1/', 'mp seat D-1 handback', '.mission-pipeline/tmp/D-1/']) assert.ok(whole.includes(s), s);
    assert.deepEqual(cardTag(c), { mission: 'M1', capabilities: ['net'], module: 'mod-a' });
  });

  test('a Reviewer card renders every gap, issue and verification run to answer', () => {
    const text = renderCard(reviewerCard());
    for (const s of ['obj-v3', '[E1] npm test: 12 passed', '[G1] no fuzzing', '[I7] crash on empty input', '[test] npm test']) assert.ok(text.includes(s), s);
  });

  test('a Reviewer writes no file: scratch paths for its commands instead of writable paths', () => {
    const c = reviewerCard({ workspace: { snapshot: COMMIT, writablePaths: [], scratchPaths: ['.', 'build'] } });
    assert.deepEqual(c.workspace.scratchPaths, ['.', 'build']);
    assert.ok(renderCard(c).includes('Scratch paths'));
    assert.ok(!renderCard(reviewerCard()).includes('Scratch paths'), 'no scratch, no section');
    assert.throws(() => reviewerCard({ workspace: { snapshot: COMMIT, writablePaths: ['src'] } }), /no writable paths/);
  });

  test('malformed cards are refused', () => {
    assert.throws(() => constructorCard({ task: '../x' }));
    assert.throws(() => constructorCard({ standards: [] }));
    assert.throws(() => constructorCard({ workspace: { snapshot: '/tmp/snap', writablePaths: [] } }), /never a host path/);
    assert.throws(() => constructorCard({ format: 'mp4.seat-card.v1' }), 'a 4.0 card is not a 4.1 card');
    assert.throws(() => reviewerCard({ binding: { judgment: 'J1' } }));
    assert.throws(() => parseSeatCard({ ...COMMON, seat: 'architect' }));
  });
});

describe('handed-back results (8.1 program rules)', () => {
  test('Constructor: four notes; an unmet standard must be on the card', () => {
    const c = constructorCard();
    const ok = { done: 'implemented', unmet_standards: [{ standard: 'S2', why: 'needs a decision' }], unfixed_problems: [], decisions_needed: ['more memory?'] };
    assert.deepEqual(resultProblems(c, ok, CTX), []);
    assert.deepEqual(parseSeatResult(c, ok), { seat: 'constructor', result: ok });
    assert.match(resultProblems(c, { ...ok, unmet_standards: [{ standard: 'S9', why: 'x' }] }, CTX).join(), /S9/);
    assert.ok(resultProblems(c, { done: '' }, CTX).length > 0);
  });

  test('Reviewer: one judgment per standard, valid pointers, every gap and issue answered, pass only when all met', () => {
    const c = reviewerCard();
    assert.deepEqual(resultProblems(c, goodReview(), CTX), []);
    const bad = (f: (r: ReviewerResult) => ReviewerResult): string => resultProblems(c, f(goodReview()), CTX).join(' | ');
    assert.match(bad((r) => ({ ...r, judgments: r.judgments.slice(0, 1) })), /"S2" is not judged/);
    assert.match(bad((r) => ({ ...r, judgments: [...r.judgments, r.judgments[0]!] })), /judged 2 times/);
    assert.match(bad((r) => ({ ...r, judgments: [...r.judgments, { standard: 'S9', met: 'yes', reason: '', evidence: [] }] })), /"S9" is not a standard/);
    assert.match(bad((r) => ({ ...r, judgments: [{ ...r.judgments[0]!, evidence: ['evidence:E9'] }, r.judgments[1]!] })), /E9 is neither a verification run on the card nor a run you had mp rerun/);
    assert.match(bad((r) => ({ ...r, judgments: [{ ...r.judgments[0]!, evidence: ['see above'] }, r.judgments[1]!] })), /neither evidence/);
    assert.match(bad((r) => ({ ...r, gap_responses: [] })), /gap "G1" is not answered/);
    assert.match(bad((r) => ({ ...r, issue_responses: [] })), /issue "I7" has no response/);
    assert.match(bad((r) => ({ ...r, verdict: 'pass' })), /"pass" leaves a standard/);
  });

  test('finding 14: every judgment gives a reason and valid evidence pointers; empty or forged evidence is refused', () => {
    const c = reviewerCard();
    const allYes = (evidence: string[], reason = 'checked'): ReviewerResult => ({
      ...goodReview(),
      judgments: [
        { standard: 'S1', met: 'yes', reason, evidence },
        { standard: 'S2', met: 'yes', reason, evidence },
      ],
      verdict: 'pass',
    });
    const problems = (r: ReviewerResult): string => resultProblems(c, r, CTX).join(' | ');
    // the reviewer's repro: every standard "yes", no reason, no evidence -> accepted before; refused now
    assert.match(problems(allYes([], '')), /cite at least one evidence pointer/);
    assert.match(problems(allYes([], '')), /give the reason/);
    assert.match(problems(allYes(['file:src/nope.ts:1'])), /src\/nope\.ts is not a file of the candidate snapshot/);
    assert.match(problems(allYes(['file:src/parse.ts:61'])), /lines 61 are not inside src\/parse\.ts \(60 lines\)/);
    assert.match(problems(allYes(['file:src/parse.ts:0'])), /not inside/);
    assert.match(problems(allYes(['file:src/parse.ts:30-20'])), /not inside/);
    assert.match(problems(allYes(['file:../etc/passwd:1'])), /normalized path inside the snapshot/);
    assert.match(problems(allYes(['file:src/../../x:1'])), /normalized path inside the snapshot/);
    assert.match(problems(allYes(['file:.git/config:1'])), /normalized path inside the snapshot/);
    assert.match(problems(allYes(['evidence:E3'])), /E3 is neither a verification run on the card nor a run you had mp rerun/);
    assert.deepEqual(resultProblems(c, allYes(['file:src/parse.ts:1-60', 'evidence:E2']), CTX), []);
    assert.deepEqual(resultProblems(c, allYes(['file:src/parse.ts']), CTX), [], 'a whole-file pointer to an existing file');
  });

  test('finding 14: pointers are checked against the real snapshot without following links', () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'src'), { recursive: true });
    writeFileSync(join(snap, 'src', 'a.ts'), 'one\ntwo\nthree');
    writeFileSync(join(snap, 'src', 'empty.ts'), '');
    writeFileSync(join(root, 'outside.ts'), 'x\n'.repeat(100));
    symlinkSync(join(root, 'outside.ts'), join(snap, 'src', 'link.ts'));
    symlinkSync(root, join(snap, 'up'));
    const files = snapshotFiles(snap);
    assert.equal(files.lines('src/a.ts'), 3, 'a last line without a newline counts');
    assert.equal(files.lines('src/empty.ts'), 0);
    assert.equal(files.lines('src/link.ts'), null, 'a symlink is not a snapshot file');
    assert.equal(files.lines('up/outside.ts'), null, 'nor a path through a symlinked directory');
    assert.equal(files.lines('src'), null, 'nor a directory');
    assert.equal(files.lines('src/missing.ts'), null);
    const c = reviewerCard();
    const ctx: ResultContext = { snapshot: files };
    const r: ReviewerResult = { ...goodReview(), judgments: [
      { standard: 'S1', met: 'yes', reason: 'r', evidence: ['file:src/a.ts:3'] },
      { standard: 'S2', met: 'no', reason: 'r', evidence: ['file:up/outside.ts:50'] },
    ] };
    assert.match(resultProblems(c, r, ctx).join(' | '), /up\/outside\.ts is not a file of the candidate snapshot/);
    assert.match(resultProblems(c, { ...r, judgments: [r.judgments[0]!, { ...r.judgments[1]!, evidence: ['file:src/empty.ts:1'] }] }, ctx).join(), /not inside src\/empty\.ts \(0 lines\)/);
  });

  test('the judgment record carries the card binding, the verdict and the cited runs', () => {
    const c = reviewerCard();
    const r = goodReview();
    assert.deepEqual(citedEvidence(c, r), ['E1']);
    const rec = judgmentRecord(c, r, { hash: H('d'), count: 1 } as never);
    validateRecord(rec);
    assert.equal(rec.verdict, 'fail');
    assert.equal(rec.judgment, 'J1');
    assert.equal(rec.target, 'obj-v3');
    assert.deepEqual(rec.issues, [{ issue: 'I7', response: 'fixed' }]);
    assert.equal(judgmentRecord(c, { ...r, verdict: 'needs-decision' }, { hash: H('d'), count: 1 } as never).verdict, 'undecided');
  });

  test('findings become issue records whose id leads to the words', () => {
    const content = memoryPorts().ledger.content;
    const c = reviewerCard();
    const [rec] = findingRecords(c, goodReview(), content, 'D-1');
    assert.ok(rec !== undefined);
    validateRecord(rec);
    assert.match(rec.issue, /^finding:[0-9a-f]{64}$/);
    assert.equal(rec.text, rec.issue.slice('finding:'.length), 'the record names its text');
    const doc = JSON.parse(content.get(rec.issue.slice('finding:'.length))) as { text: string; target: string };
    assert.equal(doc.text, 'the error message leaks the path');
    assert.deepEqual(content.getList(rec.observedOn), ['obj-v3']);
    assert.equal(rec.module, 'mod-a');
    assert.deepEqual(findingRecords(c, { ...goodReview(), findings: [] }, content, 'D-1'), []);
  });
});
