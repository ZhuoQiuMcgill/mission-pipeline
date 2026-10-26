// An exploration's snapshot taken again (design 4.3, 7.2): the commit its seats read is fixed when it
// is defined, so code landed on the target branch afterwards (a tool the same mission builds for its
// explorations) would stay out of its reach. Two routes take it again (process/explorationSnapshot.ts):
//   a  the dispatch of its first step, when the branch moved since: the card names the new commit
//   b  nothing landed: the snapshot stays as it was, and nothing is recorded
//   c  once a step was dispatched, the dispatch takes nothing again, even when the branch moved
//   d  the PM's word on a started exploration (`mp pm resnapshot-exploration`): the next card (one
//      queued before it too) names the new commit; the evidence recorded before still counts and is
//      labelled "older environment"
//   e  its refusals, named, nothing written: settled, the branch at the snapshot, a dispatch in
//      flight, an exploration that does not exist; and the command's help and arguments
//   f  a ledger without resnapshot events reads and dispatches exactly as before
//
// Real process, real git (as process-exploration.test.ts).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { EvidenceId, MissionId } from '../src/common/ids.ts';
import { evidenceApplicable, Index } from '../src/evaluator/semantics.ts';
import { StoredIndex } from '../src/evaluator/store.ts';
import { cardAtClaim, evidenceSummary } from '../src/flow/exploration/cards.ts';
import { explorationState, recordExplorationRuling } from '../src/flow/exploration/flow.ts';
import { fold, olderSnapshotEvidence, RESNAPSHOTTED, type XEvent } from '../src/flow/exploration/machine.ts';
import { explorationLine } from '../src/flow/plandoc.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { flowEvents } from '../src/memory/index.ts';
import { pmDispatch, pmMission, pmNext, pmPlan, pmRelease, pmRequirement, pmResnapshotExploration, pmSay, type TaskSpecDoc } from '../src/process/index.ts';
import { dispatchView, recordEvidenceRequest, seatCheckout } from '../src/process/seat.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import { cli } from './cli-fixtures.ts';
import { sweepThenClean } from './exploration-exits.ts';
import { handBack, processProject, readAll, readyOf, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const X = 'X1';
const URL = 'https://docs.example.org/';
let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  if (q !== null) sweepThenClean([q]);
});

function fresh(): ProcessProject {
  p = processProject();
  return p;
}

/** A mission that explores with a probe tool (the tests land it on the target branch, as a delivery would): X1 is defined once Calibrator ① passes (its author step queued). The user's words entry. */
async function startExploration(pp: ProcessProject): Promise<string> {
  const ctx = pp.ctx;
  pmMission(ctx, M);
  const w = pmSay(ctx, 'Build a probe tool, then find a cache design with no obvious logical hole using it. The details are yours to decide.').words;
  await pmRequirement(ctx, { mission: M, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  await pmPlan(ctx, {
    mission: M,
    words: [w],
    plan: {
      format: 'mp4.pm-plan.v1',
      mission: M,
      round: 1,
      order: 'free',
      elements: [
        {
          id: 'x',
          kind: 'exploration',
          text: 'Design the cache with the probe tool',
          provenance: { by: 'user', words: w, quote: 'find a cache design' },
          exploration: {
            id: X,
            deliverable: 'a cache design',
            fuzzyGoal: { quote: 'no obvious logical hole', words: w },
            attackScope: ['internal contradiction'],
            decision: { id: 'D1', type: 'structure' },
            budget: { rounds: 3, micros: null },
            stop: '',
            research: false,
            readingNetwork: [URL],
          },
          after: [],
          items: [],
        },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
  return w;
}

/** A commit on the target branch (main), as a landing leaves it: its head. */
function land(pp: ProcessProject, rel: string, text: string): string {
  write(pp.dir, rel, text);
  pp.git('add', '--', rel);
  pp.git('commit', '-q', '-m', `add ${rel}`);
  return pp.git('rev-parse', 'main');
}

const state = (pp: ProcessProject) => explorationState(pp.ctx.ports(), M, X);
const submit = (artifact: string) => ({ step: 'submit', message: 'a version', artifact, dispositions: [], directionQuestions: [], attempts: [] });
const resnapshots = (pp: ProcessProject): number => pp.ctx.memory.read((db) => flowEvents(db, { mission: M, line: explorationLine(X), event: RESNAPSHOTTED }).length);

/** The author's first step asks for a reading (the Reader's step is queued). */
async function askReading(pp: ProcessProject): Promise<void> {
  const a = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'researcher-author')).step);
  readAll(pp.ctx, a.dispatch);
  const asked = await recordEvidenceRequest(pp.ctx, a.dispatch, { request: { executor: 'reading', steps: [`Read ${URL}limits`], data: '', measure: ['documented limit'], assertions: [] }, notes: 'need the documented limit' });
  assert.equal(asked.kind, 'recorded', JSON.stringify(asked));
}

/** The Reader's hand-back: the page read, its claim citing the address. */
const reading = (c: { steps: string[]; measure: string[] }) => ({
  steps: c.steps.map((_, i) => ({ step: i + 1, done: 'yes', note: 'read the page' })),
  measurements: c.measure.map((m) => ({ measure: m, value: '64', source: `url:${URL}limits the passage states 64` })),
  assertions: [],
  observations: '',
});

/** The author asks for a reading; the Reader reads the page; the author submits v1 (the crititor's step is queued). The reading's evidence id. */
async function readingThenVersion(pp: ProcessProject): Promise<string> {
  const ctx = pp.ctx;
  await askReading(pp);
  await step(ctx, 'researcher-reader', reading);
  let evidence = '';
  await step(ctx, 'researcher-author', (c: AuthorCard) => {
    evidence = c.evidence[0]!.id;
    return submit('v1: an LRU cache sized to the documented limit');
  });
  return evidence;
}

describe('an exploration reads code landed after it was defined (its snapshot taken again)', () => {
  it('a: a commit landed after the definition: its first step\'s dispatch takes the snapshot again, and every card from then on names it', async () => {
    const pp = fresh();
    await startExploration(pp);
    const before = (await state(pp)).defined!;
    assert.equal(before.snapshot.commit, pp.git('rev-parse', 'main'));
    const head = land(pp, 'tools/probe.js', "console.log('probe: ok');\n");
    const r = await readyOf(pp.ctx, 'researcher-author');
    assert.equal((await state(pp)).defined!.snapshot.commit, before.snapshot.commit, 'mp pm next takes nothing again: only the dispatch does');
    const d = pmDispatch(pp.ctx, r.step);
    const card = dispatchView(pp.ctx, d.dispatch).card as unknown as AuthorCard;
    assert.equal(card.workspace.snapshot, head);
    assert.match(d.card, new RegExp(`commit ${head}`));
    const co = await seatCheckout(pp.ctx, d.dispatch);
    assert.equal(co.commit, head);
    assert.ok(existsSync(join(co.path, 'tools', 'probe.js')), 'the seat reads the tool that landed');
    const s = await state(pp);
    assert.deepEqual([s.defined!.snapshot, s.defined!.envLine], [{ path: head, commit: head }, before.envLine]);
    assert.notEqual(s.defined!.envSnapshot, before.envSnapshot);
    assert.deepEqual(
      s.resnapshots.map((b) => [b.n, b.by, b.step, b.words, b.previous, b.snapshot.commit]),
      [[1, 'dispatch', r.step, null, { commit: before.snapshot.commit, envSnapshot: before.envSnapshot }, head]],
    );
    // the exploration's evidence environment moved with it: a new env.snapshot on its env line
    const env = (await pp.ctx.ports().ledger.records(['env.snapshot'])).map((c) => c.record).filter((x) => x.line === before.envLine);
    assert.deepEqual(env.map((x) => x.snapshot), [before.envSnapshot, s.defined!.envSnapshot]);
    // the next card is built from the state: it names the new commit too, and nothing is taken again
    readAll(pp.ctx, d.dispatch);
    assert.equal((await handBack(pp.ctx, d.dispatch, submit('v1: an LRU cache'))).kind, 'recorded');
    const cr = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'crititor')).step);
    assert.equal((dispatchView(pp.ctx, cr.dispatch).card as unknown as CrititorCard).workspace.snapshot, head);
    assert.equal(resnapshots(pp), 1);
  });

  it('b: nothing landed: the first step reads the snapshot of the definition, and nothing is recorded', async () => {
    const pp = fresh();
    await startExploration(pp);
    const before = (await state(pp)).defined!;
    const d = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'researcher-author')).step);
    assert.equal((dispatchView(pp.ctx, d.dispatch).card as unknown as AuthorCard).workspace.snapshot, before.snapshot.commit);
    const s = await state(pp);
    assert.deepEqual(s.defined, before);
    assert.deepEqual(s.resnapshots, []);
    assert.equal(resnapshots(pp), 0);
  });

  it('c: once a step was dispatched, a dispatch takes nothing again, even when the branch moved', async () => {
    const pp = fresh();
    await startExploration(pp);
    const before = (await state(pp)).defined!;
    // the first dispatch ends without a hand-back; the step is ready again
    const first = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'researcher-author')).step);
    await pmRelease(pp.ctx, first.dispatch, 'ended');
    land(pp, 'tools/probe.js', "console.log('probe: ok');\n");
    const again = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'researcher-author')).step);
    assert.equal((dispatchView(pp.ctx, again.dispatch).card as unknown as AuthorCard).workspace.snapshot, before.snapshot.commit);
    readAll(pp.ctx, again.dispatch);
    assert.equal((await handBack(pp.ctx, again.dispatch, submit('v1'))).kind, 'recorded');
    land(pp, 'tools/probe2.js', "console.log('probe 2: ok');\n");
    const cr = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'crititor')).step);
    assert.equal((dispatchView(pp.ctx, cr.dispatch).card as unknown as CrititorCard).workspace.snapshot, before.snapshot.commit);
    assert.deepEqual((await state(pp)).defined, before);
    assert.equal(resnapshots(pp), 0);
  });

  it('d: the PM\'s word on a started exploration: the next card names the new commit; the reading recorded before still counts, labelled "older environment"', async () => {
    const pp = fresh();
    const w = await startExploration(pp);
    const evidence = await readingThenVersion(pp);
    const before = await state(pp);
    const rec = (await pp.ctx.ports().ledger.records(['evidence'])).map((c) => c.record).find((x) => x.evidence === evidence)!;
    assert.deepEqual([rec.envLine, rec.envSnapshot], [before.defined!.envLine, before.defined!.envSnapshot], 'a reading is bound to the exploration\'s own line');
    // the crititor's step was queued with the old snapshot; a tool lands; the PM's word
    const queued = (await readyOf(pp.ctx, 'crititor')).step;
    const head = land(pp, 'tools/probe.js', "console.log('probe: ok');\n");
    const r = await pmResnapshotExploration(pp.ctx, { mission: M, exploration: X, words: w });
    assert.deepEqual(r, { snapshot: head, previous: before.defined!.snapshot.commit, n: 1, olderEvidence: [evidence] });
    const s = await state(pp);
    assert.equal(s.defined!.snapshot.commit, head);
    assert.deepEqual(s.resnapshots.map((b) => [b.by, b.words, b.step]), [['pm', w, null]]);
    // nothing runs again by itself: the same step is the one ready
    assert.deepEqual((await pmNext(pp.ctx)).ready.map((x) => x.step), [queued]);
    // the reading still counts (its line's snapshot moved on), and every read labels it
    pp.ctx.memory.read((db) => {
      const ix = new StoredIndex(db);
      assert.notEqual(ix.envCurrent.get(rec.envLine), rec.envSnapshot);
      assert.equal(evidenceApplicable(ix, evidence as EvidenceId), true);
    });
    assert.equal(olderSnapshotEvidence(s, evidence), true);
    const cr = pmDispatch(pp.ctx, queued);
    const card = dispatchView(pp.ctx, cr.dispatch).card as unknown as CrititorCard;
    assert.equal(card.workspace.snapshot, head, 'a card queued before the word reads the new snapshot');
    assert.match(card.evidence.find((e) => e.id === evidence)!.summary, / \(older environment\)$/);
    assert.match(cr.card, new RegExp(`commit ${head}`));
    const shown = await cli(pp.dir, ['read', 'show', 'exploration', `${M}/${X}`]);
    assert.equal(shown.code, 0, shown.err);
    assert.ok(shown.out.includes(`snapshot: ${head.slice(0, 12)}, taken again 1 time(s), last on the PM's word; evidence from an older snapshot, still counting (older environment): ${evidence}`), shown.out);
  });

  it('d: a blind card queued before the word: the Reader reads the new snapshot and its record is bound to it', async () => {
    const pp = fresh();
    const w = await startExploration(pp);
    await askReading(pp);
    const queued = (await readyOf(pp.ctx, 'researcher-reader')).step;
    const head = land(pp, 'tools/probe.js', "console.log('probe: ok');\n");
    assert.deepEqual((await pmResnapshotExploration(pp.ctx, { mission: M, exploration: X, words: w })).olderEvidence, []);
    const s = await state(pp);
    const rd = pmDispatch(pp.ctx, queued);
    const card = dispatchView(pp.ctx, rd.dispatch).card as unknown as { workspace: { snapshot: string }; evidence: { id: string; envLine: string; envSnapshot: string } };
    assert.equal(card.workspace.snapshot, head);
    assert.deepEqual([card.evidence.envLine, card.evidence.envSnapshot], [s.defined!.envLine, s.defined!.envSnapshot]);
    readAll(pp.ctx, rd.dispatch);
    assert.equal((await handBack(pp.ctx, rd.dispatch, reading(card as never))).kind, 'recorded');
    const rec = (await pp.ctx.ports().ledger.records(['evidence'])).map((c) => c.record).find((x) => x.evidence === card.evidence.id)!;
    assert.equal(rec.envSnapshot, s.defined!.envSnapshot);
    assert.equal(olderSnapshotEvidence(await state(pp), card.evidence.id), false);
  });

  it('e: refused, named, with nothing written: the branch at the snapshot, a dispatch in flight, settled, no such exploration', async () => {
    const pp = fresh();
    const w = await startExploration(pp);
    const refused = async (code: string): Promise<void> => {
      await assert.rejects(pmResnapshotExploration(pp.ctx, { mission: M, exploration: X, words: w }), (e: { code?: string }) => e.code === code);
      assert.equal(resnapshots(pp), 0);
    };
    await refused('SNAPSHOT_CURRENT');
    await assert.rejects(pmResnapshotExploration(pp.ctx, { mission: M, exploration: 'nope', words: w }), (e: { code?: string }) => e.code === 'NOT_ALLOWED');
    // a dispatch in flight: its seat would see the snapshot change under it
    const d = pmDispatch(pp.ctx, (await readyOf(pp.ctx, 'researcher-author')).step);
    land(pp, 'tools/probe.js', "console.log('probe: ok');\n");
    await refused('DISPATCH_IN_FLIGHT');
    // the CLI: the same refusal, its code in the --json answer; --words is required
    const c = await cli(pp.dir, ['pm', 'resnapshot-exploration', M, X, '--words', w, '--json']);
    assert.equal(c.code, 3, c.out);
    assert.equal(c.json.error.code, 'DISPATCH_IN_FLIGHT');
    assert.match(c.json.error.message, new RegExp(`${d.dispatch} in flight`));
    assert.equal((await cli(pp.dir, ['pm', 'resnapshot-exploration', M, X])).code, 64);
    await pmRelease(pp.ctx, d.dispatch, 'ended');
    // settled (the decision layer stopped it: no conclusion): reopen it, or a new exploration id
    await recordExplorationRuling(pp.ctx.ports(), M, X, { id: 'stop-x1', decision: 'stop', findings: [], text: 'the PM stops it', extraRounds: 0, by: 'pm' });
    await pmNext(pp.ctx);
    assert.notEqual((await state(pp)).settled, null);
    await refused('EXPLORATION_SETTLED');
    await assert.rejects(pmResnapshotExploration(pp.ctx, { mission: M, exploration: X, words: w }), /reopen-exploration .*new id/);
  });

  it('e: the command is listed in mp pm --help with its usage, and takes the snapshot again from the command line', async () => {
    const pp = fresh();
    const w = await startExploration(pp);
    const help = await cli(pp.dir, ['pm', '--help']);
    assert.match(help.out, /mp pm resnapshot-exploration/);
    const usage = await cli(pp.dir, ['pm', 'resnapshot-exploration', '--help']);
    assert.equal(usage.code, 0);
    assert.match(usage.out, /Usage: mp pm resnapshot-exploration <mission> <exploration> --words W-<n>/);
    // started: its first step was dispatched and handed back
    await step(pp.ctx, 'researcher-author', () => submit('v1'));
    const head = land(pp, 'tools/probe.js', "console.log('probe: ok');\n");
    const r = await cli(pp.dir, ['pm', 'resnapshot-exploration', M, X, '--words', w, '--json']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.json.result.mission, r.json.result.exploration, r.json.result.snapshot, r.json.result.n, r.json.result.olderEvidence], [M, X, head, 1, []]);
    const again = await cli(pp.dir, ['pm', 'resnapshot-exploration', M, X, '--words', w, '--json']);
    assert.equal(again.json.error.code, 'SNAPSHOT_CURRENT');
  });

  it('f: a ledger without resnapshot events reads and dispatches exactly as before', async () => {
    const pp = fresh();
    await startExploration(pp);
    const evidence = await readingThenVersion(pp);
    await step(pp.ctx, 'crititor', () => ({ findings: [], rechecks: [], settled: [], reply: 'nothing found' }));
    const events = pp.ctx.memory.read((db) => flowEvents(db, { mission: M, line: explorationLine(X), limit: 10_000 }));
    assert.ok(!events.some((e) => e.event === RESNAPSHOTTED));
    const xs: XEvent[] = events.map((e) => ({ event: e.event, key: e.key, body: JSON.parse(pp.ctx.memory.data.text(e.body)) }));
    const s = fold(xs);
    // the state holds the definition's snapshot as recorded
    assert.deepEqual(s.defined, xs.find((e) => e.event === 'defined')!.body);
    assert.deepEqual(s.resnapshots, []);
    assert.equal(olderSnapshotEvidence(s, evidence), false);
    for (const e of s.evidence.values()) assert.equal(evidenceSummary(s, e), e.summary);
    // every card queued is handed over unchanged (the same object), and every claim named the queued snapshot
    for (const q of s.tasks.values()) {
      const card = (JSON.parse(pp.ctx.memory.data.text(q.card)) as TaskSpecDoc['card']);
      assert.equal(cardAtClaim(s, card), card, q.task);
    }
    const claimed = pp.ctx.memory.read((db) => db.stmt("SELECT d.dispatch, t.card FROM dispatches d JOIN tasks t ON t.task = d.task").all() as Array<{ dispatch: string; card: string }>);
    let exploring = 0;
    for (const c of claimed) {
      const queuedCard = (JSON.parse(pp.ctx.memory.data.text(c.card)) as TaskSpecDoc).card as Record<string, unknown>;
      if (!/^researcher-|^crititor$|^stabilizer$|^constructor-experiment$/.test(String(queuedCard['seat']))) continue;
      exploring++;
      const card = dispatchView(pp.ctx, c.dispatch).card as Record<string, unknown>;
      assert.deepEqual(card['workspace'], queuedCard['workspace'], c.dispatch);
      if (card['seat'] !== 'crititor' && card['seat'] !== 'stabilizer') assert.deepEqual(card, queuedCard, `${c.dispatch}: the claim changed nothing`);
    }
    assert.ok(exploring >= 4, `${exploring} exploration dispatches checked`);
  });
});

describe('the evaluator: a record on an exploration\'s line bound to an earlier snapshot still counts; any other line\'s rule is unchanged', () => {
  it('an exploration line after a resnapshot; a line of another kind after a change', () => {
    const ix = new Index();
    let rev = 0;
    const add = (r: Record<string, unknown>): void => {
      ix.add({ revision: ++rev, record: r } as never);
    };
    add({ kind: 'env.snapshot', line: 'xpenv.m1.X1', snapshot: 'xpenv.m1.X1.aaaa' });
    add({ kind: 'evidence', evidence: 'R1', envLine: 'xpenv.m1.X1', envSnapshot: 'xpenv.m1.X1.aaaa', runClass: 'sampling', fields: { status: 'completed' } });
    add({ kind: 'evidence', evidence: 'R0', envLine: 'xpenv.m1.X1', envSnapshot: 'xpenv.m1.X1.never', runClass: 'sampling', fields: { status: 'completed' } });
    add({ kind: 'env.snapshot', line: 'py', snapshot: 'py@1' });
    add({ kind: 'evidence', evidence: 'P1', envLine: 'py', envSnapshot: 'py@1', runClass: 'declared', fields: { exit: '0' } });
    assert.deepEqual(['R1', 'R0', 'P1'].map((e) => evidenceApplicable(ix, e as EvidenceId)), [true, false, true]);
    add({ kind: 'env.snapshot', line: 'xpenv.m1.X1', snapshot: 'xpenv.m1.X1.bbbb' });
    add({ kind: 'env.snapshot', line: 'py', snapshot: 'py@2' });
    // R1 still counts (a snapshot its line had); R0 never was one; P1 needs a rerun as before (5.2)
    assert.deepEqual(['R1', 'R0', 'P1'].map((e) => evidenceApplicable(ix, e as EvidenceId)), [true, false, false]);
  });
});
