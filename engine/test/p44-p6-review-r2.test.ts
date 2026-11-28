// 4.4 package p6, review round 2: each finding with the case that showed it.
//   p6-1     every write of a constraint line (a new version, a scope, a withdrawal) acts on the version it read,
//            checked inside the write: also `mp pm constraint add` with the same text and a new scope, a new
//            version, and the PM's withdrawal
//   p6-r2-1  a grant that covers a reopen of a task with no Constructor shows the reopen's issue on its Reviewer's
//            card; a repair is not done when no claimed card of the accepted attempt carried its issue
//   p6-r2-3  a changed task is done when its last spec before the acceptance carries the repair, however often the
//            repair's spec was written

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { taskLineage } from '../src/flow/execution.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { taskCardHash, type DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { recordConstraint } from '../src/flow/requirements.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { detailedPlan, drive, happyScript, pmPlan, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmConstraint, pmRepair, pmWithdrawConstraint } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { repairReopensCarried } from '../src/seat/cards/dynamic.ts';
import { constraintsRead, repairsRead } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
type Append = (op: string, entries: unknown) => Promise<void>;
const SCOPE = { paths: ['**'], taskTypes: [] };

async function setup(plan: () => DetailedPlanDoc = () => detailedPlan(M)): Promise<{ ports: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.task) ? over[t.task]! : Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, plan))(t, s);
  return { ports, engine: new FlowEngine(ports), script };
}

/** Run `between` once, just before the first append whose op starts with `prefix` (another writer in between). */
function before(ledger: unknown, prefix: string, between: () => Promise<unknown>): void {
  const l = ledger as { append: Append };
  const orig = l.append.bind(l);
  let pending = true;
  l.append = async (op, entries) => {
    if (pending && op.startsWith(prefix)) { pending = false; await between(); }
    return orig(op, entries);
  };
}

function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const read = (ports: World, id: string) => ports.memory.read((db) => constraintsRead(db, ports.memory.data, 'm1', false)).constraints.find((c) => c.id === id);
const repairs = (ports: World) => ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')).repairs;

describe('p6-1: every write of a constraint line is checked inside the write against the version it read', () => {
  it('mp pm constraint add with the same text and a new scope, raced by a project-wide object replacement, narrows nothing', async () => {
    const { ports } = await setup();
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'x', kind: 'instruction', text: 'Prefer small functions.', scope: SCOPE });
    before(ports.ctx.ports().ledger, 'flow:constraint-scope:', () => recordConstraint(ports.ctx.ports(), { mission: 'project' as MissionId, constraint: 'x', kind: 'object', text: 'Every public function is documented.', scope: SCOPE }));
    await assert.rejects(pmConstraint(ports.ctx, { mission: 'project', constraint: 'x', kind: 'instruction', text: 'Prefer small functions.', scope: { ...SCOPE, tasks: ['impl'] }, missionScope: 'm1' }), /changed since it was read/);
    const now = read(ports, 'constraint.x');
    assert.equal(now?.kind, 'object', 'the object constraint stands');
    assert.equal(now?.address, null);
    assert.equal((await ports.ledger.events({ mission: 'm1' as MissionId, line: 'requirements', event: 'constraint-scope' })).length, 0, 'not narrowed to m1');
  });

  it('a new version raced by another writer\'s version is refused; run again, it is written', async () => {
    const { ports } = await setup();
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'v', kind: 'instruction', text: 'Text A.', scope: SCOPE });
    before(ports.ctx.ports().ledger, 'flow:constraint:project:constraint.v.v2', () => recordConstraint(ports.ctx.ports(), { mission: 'project' as MissionId, constraint: 'v', kind: 'object', text: 'Text C.', scope: SCOPE }));
    // the PM's text B was prepared against version 1; version 2 (C) is recorded first, so B as the next version is refused
    await assert.rejects(pmConstraint(ports.ctx, { mission: 'project', constraint: 'v', kind: 'instruction', text: 'Text B.', scope: SCOPE }), /changed since it was read/);
    assert.equal(read(ports, 'constraint.v')?.first, 'Text C.');
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'v', kind: 'instruction', text: 'Text B.', scope: SCOPE });
    assert.equal(read(ports, 'constraint.v')?.first, 'Text B.', 'the PM writes over it on the next run (R3)');
  });

  it('the PM\'s withdrawal raced by a new version withdraws nothing', async () => {
    const { ports } = await setup();
    const w = say(ports, 'Drop the commit-size rule.');
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'w', kind: 'instruction', text: 'Keep commits small.', scope: SCOPE });
    before(ports.ctx.ports().ledger, 'flow:constraint-withdraw:', () => recordConstraint(ports.ctx.ports(), { mission: 'project' as MissionId, constraint: 'w', kind: 'object', text: 'Every commit passes the linter.', scope: SCOPE }));
    await assert.rejects(pmWithdrawConstraint(ports.ctx, { constraint: 'w', words: w }), /changed since it was read/);
    assert.equal(read(ports, 'constraint.w')?.kind, 'object', 'the new version stands, not withdrawn');
  });
});

describe('p6-r2-1: a reopen granted on a task with no Constructor', () => {
  // iface, impl, and integ: an integration task with nothing to write (no Constructor; its Reviewer judges the combination)
  const plan = (): DetailedPlanDoc => { const p = detailedPlan(M); return { ...p, tasks: [...p.tasks, { ...p.tasks[1]!, id: 'integ', kind: 'integration' as const, module: null, writeScope: [], implements: [], calls: [], dependsOn: ['impl'], provenance: { planElements: ['e1', 'e2'] } }] }; };
  const issue = 'compare the header rows of both parsers';

  it('its Reviewer\'s card shows the reopen\'s issue, and the repair is done once that attempt passes; a claimed card without the issue would not count', async () => {
    const { ports, engine, script } = await setup(plan);
    await drive(engine, ports.scheduler, script());
    assert.ok(!ports.scheduler.tasks.has('con.m1.integ.1'), 'no Constructor');
    // integ's rework loop is used up (2 of 2)
    for (const n of [1, 2]) await ports.ledger.loopAttempt({ op: `test:integ-rework:${n}`, lineage: taskLineage(M, 'integ'), loop: 'rework', signature: `used-${n}` });
    const w2 = say(ports, 'The combined output loses a header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'The combined output loses a header row', about: 'integ' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'integ', issue }], add: [], note: 'integ judges the combination.' } }), secretary: () => null }));
    const exh = (await ports.ledger.events<EscalationBody>({ mission: M, line: 'secretary', event: 'escalation' })).map((e) => e.body).find((e) => e.source === 'loop-exhausted' && e.subject === 'task:integ');
    assert.ok(exh !== undefined, 'the reopen met the used-up loop');
    const w3 = say(ports, 'Grant one more attempt.');
    await answerEscalation(ports, { mission: M, escalation: exh.id, option: 'grant', grantExtra: 1, instructions: 'Check the headers.', words: `Grant one more attempt. (${w3})` });
    await drive(engine, ports.scheduler, script());
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.integ.2');
    assert.ok(rev.duties.includes(issue), rev.duties);
    assert.match(rev.duties, /This attempt was granted for a reopen \(repair R-1\)/);
    const r = repairs(ports)[0]!;
    assert.match(r.reopened[0]?.state ?? '', /^reopened at attempt 2; accepted at attempt 2 \([^)]+\)$/);
    assert.equal(r.done, true);
    // the same records with a claimed card that did not show the issue (an attempt built before this fix): not carried
    const line = await ports.ledger.events({ mission: M, line: 'task:integ' });
    const secretaryLine = await ports.ledger.events({ mission: M, line: 'secretary' });
    const shown = repairReopensCarried('m1', 'integ', line, secretaryLine, { issue: () => issue, cards: () => [rev.duties] });
    const hidden = repairReopensCarried('m1', 'integ', line, secretaryLine, { issue: () => issue, cards: () => ['Judge the candidate of task integ.'] });
    assert.deepEqual([shown.map((c) => c.attempt), hidden.length], [[2], 0]);
  });
});

describe('p6-r2-3: the repair\'s spec written twice', () => {
  it('a pass restores the old card and a later pass writes the repair\'s card again: accepted under the second, the changed task is done', async () => {
    const plan = () => { const p = detailedPlan(M, { extraTask: true }); return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, verificationCommands: [{ id: 'lint', command: 'npm run lint' }] } : t)) }; };
    const { ports, engine, script } = await setup(plan);
    await drive(engine, ports.scheduler, script({ 'rev.m1.docs.1': () => null }));
    const w2 = say(ports, 'The docs should live in the README, not in a folder of their own.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'The docs should live in the README', about: 'docs' });
    await drive(engine, ports.scheduler, script({
      'architect-repair': (t) => { const docs = (t.card as unknown as ArchitectRepairCard).plan.tasks.find((x) => x.id === 'docs')!; return { handBack: { reopen: [], add: [], change: [{ ...docs, writeScope: ['README.md'] }], note: 'the README' } }; },
      'con.m1.docs.2': () => null,
    }));
    const specs = await ports.ledger.events<{ repair?: string }>({ mission: M, line: 'task:docs', event: 'spec' });
    assert.equal(specs.at(-1)?.body.repair, 'R-1');
    // a pass that read the plan before the repair restores the old card
    const dplan = (await planInEffect(flowCtx(ports, M)))!.eff.dplan;
    const oldCard = plan().tasks.find((t) => t.id === 'docs')!;
    await ports.ledger.append('test:old-card-again', { events: [{ mission: M, line: 'task:docs', event: 'spec', key: `${dplan}#${specs.length + 1}`, body: { dplan, hash: taskCardHash(oldCard) } }] });
    // a fresh pass writes the repair's card again; the task is accepted under it
    await drive(engine, ports.scheduler, script());
    const after = await ports.ledger.events<{ repair?: string }>({ mission: M, line: 'task:docs', event: 'spec' });
    assert.deepEqual(after.map((e) => e.body.repair ?? null), [null, 'R-1', null, 'R-1'], 'the repair\'s spec is written twice');
    const r = repairs(ports)[0]!;
    assert.equal(r.changed[0]?.done, true, r.changed[0]?.state);
    assert.equal(r.done, true);
  });
});
