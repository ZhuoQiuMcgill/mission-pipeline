// 4.1.3 (P4 item 5): constraints reach the seats they are written for.
//   1  a "**" instruction with no task types reaches a pathless task (#34, #42): constraintsForTask,
//      and the card of an integration task's Reviewer with an empty write scope; a narrower pattern
//      still needs an overlap; object constraints are unchanged
//   2  exploration cards keep the blind-executor rule: a blind executor gets only an instruction
//      naming its seat, even a "**" one with no task types does not reach it
//   3  `mp pm constraint add` refuses a pattern the matcher cannot read (#36), names the forms and the
//      nearest one, records nothing; it reports what the scope matches now, warns at 0, and says when
//      the same text only changed the scope
//   4  the label of an instruction on a card (#24): "Instruction (follow it; not a proof input)"
//   5  a constraint the field recorded with a pattern the matcher cannot read still reads; re-added
//      with the same id and text and a readable pattern, its scope changes and it reaches the cards

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { currentConstraints, recordConstraint, type ConstraintBody } from '../src/flow/requirements.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { constraintApplies, constraintPatternProblem } from '../src/memory/domain/constraints.ts';
import { pmConstraint, pmDispatch, pmNext, seatCard } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderCommon } from '../src/seat/cards/common.ts';
import { constraintsForExploration, constraintsForTask } from '../src/seat/cards/dynamic.ts';
import { cli } from './cli-fixtures.ts';
import { addDetailedPlan, CHECK_JS, handBack, processProject, readAll, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1';

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

const c = (line: string, kind: 'object' | 'instruction', scope: Partial<ConstraintBody['scope']> = {}): ConstraintBody => ({ line, version: `${line}.v1`, kind, text: line, scope: { paths: ['**'], taskTypes: [], ...scope } });
const lines = (xs: readonly { readonly line: string }[]): string[] => xs.map((x) => x.line);

describe('1: a "**" instruction reaches a pathless task', () => {
  it('constraintsForTask: every task in its mission scope, an empty write scope too; a narrower pattern needs an overlap; objects unchanged', () => {
    const all = [
      c('wide', 'instruction'),
      c('narrow', 'instruction', { paths: ['src/**'] }),
      c('other-mission', 'instruction', { mission: 'm2' }),
      c('typed', 'instruction', { taskTypes: ['implementation'] }),
      c('object-wide', 'object'),
    ];
    const integration = { kind: 'integration', writeScope: [] as string[] };
    assert.deepEqual(lines(constraintsForTask(all, integration, M)), ['wide'], 'the pathless integration task gets the "**" instruction, nothing else');
    assert.deepEqual(lines(constraintsForTask(all, { kind: 'implementation', writeScope: ['src/**'] }, M)), ['wide', 'narrow', 'typed', 'object-wide']);
    assert.deepEqual(lines(constraintsForTask(all, { kind: 'implementation', writeScope: ['docs/**'] }, M)), ['wide', 'typed', 'object-wide'], 'a narrower pattern needs an overlap');
    assert.deepEqual(lines(constraintsForTask(all, integration, 'm2')), ['wide', 'other-mission'], 'the mission scope still decides');
  });

  it("the card of an integration task's Reviewer with an empty write scope shows a mission-wide instruction", async () => {
    p = processProject();
    const plan = addDetailedPlan(M) as { tasks: unknown[] };
    plan.tasks.push({
      id: 'integ',
      kind: 'integration',
      module: null,
      goal: 'The add function as a whole',
      standards: [{ id: 'S1', text: 'add works as a whole' }],
      requirementItems: [`item.${M}.g1`],
      writeScope: [],
      readableFiles: ['README.md'],
      interpreter: 'node',
      verificationCommands: [],
      implements: [],
      calls: ['add'],
      dependsOn: ['impl'],
      exclusive: [],
      estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'a review' },
      provenance: { planElement: 'e1' },
    });
    await startAddMission(p.ctx, M);
    await pmConstraint(p.ctx, { mission: M, constraint: 'review-standard', kind: 'instruction', text: 'Judge substance; wording is a note', scope: { paths: ['**'], taskTypes: [] } });
    await step(p.ctx, 'calibrator-1', (card) => cal1Pass(card));
    await step(p.ctx, 'architect-decompose', () => plan);
    if ((await pmNext(p.ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(p.ctx, 'architect-feasibility', () => feasible());
    await step(p.ctx, 'calibrator-2', (card) => cal2Pass(card));
    const cs = (await pmNext(p.ctx)).ready.find((r) => r.kind === 'constructor')!;
    const d = pmDispatch(p.ctx, cs.step);
    write(`${p.dir}/${d.worktree!}`, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(`${p.dir}/${d.worktree!}`, 'src/check.js', CHECK_JS);
    const built = await handBack(p.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(built.kind, 'recorded');
    const ri = (await pmNext(p.ctx)).ready.find((r) => r.kind === 'reviewer' && r.step.includes('.impl.'))!;
    const rd = pmDispatch(p.ctx, ri.step);
    readAll(p.ctx, rd.dispatch);
    assert.match(seatCard(p.ctx, rd.dispatch).text, /Judge substance; wording is a note/);
    const pass = await handBack(p.ctx, rd.dispatch, reviewerPass(dispatchView(p.ctx, rd.dispatch).card as never));
    assert.ok(pass.kind === 'recorded' && pass.outcome === 'accepted', JSON.stringify(pass));
    const next = await pmNext(p.ctx);
    const ig = next.ready.find((r) => r.kind === 'reviewer' && r.step.includes('.integ.'));
    assert.ok(ig !== undefined, `the integration review is ready: ${next.ready.map((r) => r.step).join(', ')}; ${next.held.map((h) => h.why).join('; ')}; ${next.errors.join('; ')}`);
    const id = pmDispatch(p.ctx, ig.step);
    const card = dispatchView(p.ctx, id.dispatch).card as unknown as { constraints: Array<{ id: string; kind: string }> };
    assert.deepEqual(card.constraints.map((x) => x.id), ['constraint.review-standard'], 'the integration Reviewer gets the mission-wide instruction');
    assert.match(seatCard(p.ctx, id.dispatch).text, /\[constraint\.review-standard\] Instruction \(follow it; not a proof input\): Judge substance; wording is a note/);
  });
});

describe('2: exploration cards keep the blind-executor rule', () => {
  it('a "**" instruction reaches the seats that know the exploration, never a blind executor; one naming the seat does', () => {
    const all = [c('wide', 'instruction'), c('for-readers', 'instruction', { taskTypes: ['researcher-reader'] }), c('object-wide', 'object')];
    const ids = (seat: string) => constraintsForExploration(all, seat, M, 'X1').map((x) => x.id);
    assert.deepEqual(ids('researcher-author'), ['wide', 'object-wide']);
    assert.deepEqual(ids('researcher-interpreter'), ['wide', 'object-wide']);
    assert.deepEqual(ids('constructor-experiment'), [], 'a blind executor: no "**" instruction, no object constraint');
    assert.deepEqual(ids('researcher-reader'), ['for-readers']);
  });
});

describe('3: mp pm constraint add reads its patterns', () => {
  it('constraintPatternProblem: the three forms are read; any other is refused with the nearest form', () => {
    for (const ok of ['**', 'src/app.ts', 'docs/reports/**', 'pages/[id].tsx', 'a b/c.md']) assert.equal(constraintPatternProblem(ok), null, ok);
    const near = (x: string) => constraintPatternProblem(x)?.suggestion;
    assert.equal(near('docs/reports/Report_Batch_*'), 'docs/reports/**');
    assert.equal(near('src/*.ts'), 'src/**');
    assert.equal(near('*.md'), '**');
    assert.equal(near('**/x.md'), '**');
    assert.equal(near('docs/**/x.md'), 'docs/**');
    assert.equal(near('docs/'), 'docs/**');
    assert.equal(near('./src/app.ts'), 'src/app.ts');
    assert.equal(near('/src/**'), 'src/**');
    assert.equal(near('src\\app.ts'), 'src/app.ts');
    assert.equal(near(''), '**');
    // the nearest form is one the matcher reads, and it covers the path the pattern meant
    for (const x of ['docs/reports/Report_Batch_*', 'src/*.ts', 'docs/']) {
      const s = near(x)!;
      assert.equal(constraintPatternProblem(s), null, s);
    }
    const scope = { paths: ['docs/reports/**'], taskTypes: [] };
    assert.ok(constraintApplies({ scope }, { scope: { paths: ['docs/reports/Report_Batch_01.md'], taskType: 'implementation' }, mission: M }));
  });

  it('refused at once with the forms and the nearest one, nothing recorded; a valid one reports its reach, warns at 0, and names a scope-only change', async () => {
    p = processProject();
    await startAddMission(p.ctx, M);
    const bad = await cli(p.dir, ['pm', 'constraint', 'add', 'batch', '--kind', 'object', '--text', 'Check every batch report', '--paths', 'docs/reports/Report_Batch_*', '--json']);
    assert.equal(bad.code, 3, bad.out + bad.err);
    assert.match(bad.json.error.message, /"docs\/reports\/Report_Batch_\*": "Report_Batch_\*" is a wildcard/);
    assert.match(bad.json.error.message, /the nearest form is "docs\/reports\/\*\*"/);
    assert.match(bad.json.error.message, /"\*\*" \(every path\), an exact path such as "src\/app\.ts", or a folder and everything under it/);
    assert.match(bad.json.error.message, /Nothing was recorded/);
    const none = p.ctx.memory.read((db) => db.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'basis.version' AND json_extract(record, '$.line') = 'constraint.batch'").get() as { n: number });
    assert.equal(Number(none.n), 0);
    // a valid pattern that matches nothing now: recorded, with a warning
    const zero = await cli(p.dir, ['pm', 'constraint', 'add', 'batch', '--kind', 'object', '--text', 'Check every batch report', '--paths', 'docs/reports/**']);
    assert.equal(zero.code, 0, zero.err);
    assert.match(zero.out, /Its scope matches 0 current object versions and 0 tasks of the plans in effect now\./);
    assert.match(zero.out, /Warning: it matches nothing now/);
    // the same id and text with another scope: the version is kept, and the answer says the scope changed
    const wide = await cli(p.dir, ['pm', 'constraint', 'add', 'batch', '--kind', 'object', '--text', 'Check every batch report', '--paths', '**', '--json']);
    assert.equal(wide.code, 0, wide.err);
    assert.equal(wide.json.result.scopeChanged, true);
    assert.equal(wide.json.result.version, (await cli(p.dir, ['pm', 'constraint', 'add', 'batch', '--kind', 'object', '--text', 'Check every batch report', '--paths', '**', '--json'])).json.result.version);
  });

  it('the reach counts the tasks of the plan in effect and the current object versions the scope covers', async () => {
    p = processProject();
    await startAddMission(p.ctx, M);
    await step(p.ctx, 'calibrator-1', (card) => cal1Pass(card));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(p.ctx, 'calibrator-2', (card) => cal2Pass(card));
    const src = await pmConstraint(p.ctx, { mission: M, constraint: 'src-only', kind: 'instruction', text: 'Keep src pure', scope: { paths: ['src/**'], taskTypes: [] } });
    assert.deepEqual(src.reach.tasks, [`${M}/impl`]);
    const docs = await pmConstraint(p.ctx, { mission: M, constraint: 'docs-only', kind: 'instruction', text: 'Docs in English', scope: { paths: ['docs/**'], taskTypes: [] } });
    assert.deepEqual(docs.reach.tasks, []);
    const plans = await pmConstraint(p.ctx, { mission: M, constraint: 'every-object', kind: 'object', text: 'No secrets', scope: { paths: ['**'], taskTypes: [] } });
    assert.ok(plans.reach.objects > 0, 'the plans recorded so far are object versions the scope covers');
    assert.deepEqual(plans.reach.tasks, [`${M}/impl`]);
  });
});

describe('4: the label of an instruction', () => {
  it('"Instruction (follow it; not a proof input)" wherever a card renders constraints', () => {
    const text = renderCommon({ duties: '', constraints: [{ id: 'constraint.recount', kind: 'instruction', text: 'Report the recount too' }, { id: 'constraint.private', kind: 'object', text: 'No private data' }], decisionQuotes: [] });
    assert.ok(text.includes('- [constraint.recount] Instruction (follow it; not a proof input): Report the recount too'));
    assert.ok(text.includes('- [constraint.private] No private data'));
    assert.doesNotMatch(text, /context only/);
  });
});

describe('5: a constraint the field recorded with an unreadable pattern', () => {
  it('still reads (it matches nothing, as before); the same id and text with a readable pattern change its scope and reach the cards', async () => {
    p = processProject();
    await startAddMission(p.ctx, M);
    await step(p.ctx, 'calibrator-1', (card) => cal1Pass(card));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(p.ctx, 'calibrator-2', (card) => cal2Pass(card));
    // the field's `mp pm constraint add` recorded any pattern (flow/requirements.ts recordConstraint, no check)
    const v = await recordConstraint(p.ctx.ports(), { mission: M as MissionId, constraint: 'batch', kind: 'instruction', text: 'Check every batch report', scope: { paths: ['src/add*'], taskTypes: [] } });
    const before = (await currentConstraints(flowCtx(p.ctx.ports(), M as MissionId))).find((x) => x.line === 'constraint.batch')!;
    assert.deepEqual(before.scope.paths, ['src/add*']);
    assert.deepEqual(constraintsForTask([before], { kind: 'implementation', writeScope: ['src/add.js'] }, M).map((x) => x.line), [], 'it matches nothing, as before');
    const again = await pmConstraint(p.ctx, { mission: M, constraint: 'batch', kind: 'instruction', text: 'Check every batch report', scope: { paths: ['src/**'], taskTypes: [] } });
    assert.equal(again.version, v, 'the same text keeps its version');
    assert.equal(again.scopeChanged, true);
    assert.deepEqual(again.reach.tasks, [`${M}/impl`]);
  });
});
