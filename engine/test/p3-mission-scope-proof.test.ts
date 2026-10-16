import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { encodeConstraintCheck } from '../src/common/records.ts';
import { validateRecord } from '../src/common/validate.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { currentConstraints } from '../src/flow/requirements.ts';
import { drive, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { pmConstraint, pmWithdrawConstraint } from '../src/process/pm.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { Mirror } from './labels-fixtures.ts';

it('a mission-scoped object constraint changes proof duties only in that mission; withdrawal leaves unrelated proof and work alone', async () => {
  const w = memoryPorts();say(w, SEED_TEXT);
  const engine=new FlowEngine(w);
  for (const mission of ['m1','m2'] as MissionId[]) {
    await seedMission(w,mission);await submitPmBatch(w,{mission,plan:pmPlan(mission),userWords:['W-1']});await drive(engine,w.scheduler,happyScript(mission));
  }
  const ids=['pmplan.m1.1','pmplan.m2.1'];
  assert.deepEqual((await w.evaluator.labels(ids)).labels,{'pmplan.m1.1':'proven','pmplan.m2.1':'proven'});
  await pmConstraint(w.ctx,{mission:'m1',constraint:'only-m1',kind:'object',text:'Local proof duty',missionScope:'m1',scope:{paths:['**'],taskTypes:[]}});
  const labels=(await w.evaluator.labels(ids)).labels;
  assert.notEqual(labels['pmplan.m1.1'],'proven');assert.equal(labels['pmplan.m2.1'],'proven');
  assert.equal((await currentConstraints(flowCtx(w,'m2' as MissionId))).length,1, 'the resolver returns all project constraints; consumers select by object mission');
  const acceptedBefore=(await w.ledger.events({mission:'m2' as MissionId,event:'accepted'})).length;
  await pmWithdrawConstraint(w.ctx,{constraint:'only-m1',words:'W-1'});
  assert.deepEqual((await w.evaluator.labels(ids)).labels,{'pmplan.m1.1':'proven','pmplan.m2.1':'proven'});
  assert.equal((await w.ledger.events({mission:'m2' as MissionId,event:'accepted'})).length,acceptedBefore);
});

it('proof-unit coverage uses each member mission and follows scope changes without changing constraint content', () => {
  const mirror = new Mirror(memoryPorts().memory);
  const review = (name: string) => ({ review: name, basisLines: [], reliesOn: [] });
  const judgment = (id: string, target: string, paths: string[] = []) => ({
    kind: 'judgment', judgment: id, target, review: target === 'U' ? 'integration' : 'reviewer',
    executor: 'reviewer', verdict: 'pass', evidence: [], bases: [],
    constraints: paths.length === 0 ? [] : [encodeConstraintCheck({ version: 'c.v1', paths })],
    reliesOn: [], issues: [], revokes: null, extends: null,
    evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [],
  });
  mirror.append([
    { kind: 'basis.version', basisKind: 'constraint', line: 'c', version: 'c.v1', mission: 'm1', scope: { mission: 'm1', paths: ['src/**'], taskTypes: [] } },
    ...['A', 'B'].map((id, index) => ({
      kind: 'object.version', object: id, objectKind: 'product', mission: `m${index + 1}`, module: null,
      content: '0'.repeat(64), prerequisites: [id === 'A' ? 'B' : 'A'],
      scope: { paths: [`src/${id}.ts`], taskType: 'construct' }, reviews: [review('reviewer')],
    })),
    { kind: 'proof.unit', unit: 'U', members: ['A', 'B'], reviews: [review('integration')] },
    judgment('JA', 'A', ['src/A.ts']), judgment('JB', 'B'), judgment('JU1', 'U'),
  ]);
  // Every state read compares the stored evaluator with the reference semantics.
  const labels = () => [...mirror.state().targets].map(([id, state]) => [id, state.label]).sort();
  const proven = [['A', 'proven'], ['B', 'proven'], ['U', 'proven']];
  const uncovered = [['A', 'not-fully-proven'], ['B', 'not-fully-proven'], ['U', 'not-fully-proven']];
  assert.deepEqual(labels(), proven, 'the m1 constraint does not require review of the m2 member');

  mirror.append([{ kind: 'constraint.scope', line: 'c', scope: { mission: 'm2', paths: ['src/**'], taskTypes: [] } }]);
  assert.deepEqual(labels(), uncovered, 'moving the scope to m2 requires review of B');
  mirror.append([judgment('JB2', 'B', ['src/B.ts'])]);
  assert.deepEqual(labels(), proven);
  mirror.append([judgment('JA2', 'A')]);
  assert.deepEqual(labels(), proven);

  mirror.append([{ kind: 'constraint.scope', line: 'c', scope: { paths: ['src/**'], taskTypes: [] } }]);
  assert.deepEqual(labels(), uncovered, 'omitting mission restores project-wide coverage duties');
  mirror.append([judgment('JA3', 'A', ['src/A.ts'])]);
  assert.deepEqual(labels(), proven);
});

it('constraint scope validation accepts project-wide and valid mission scopes and refuses malformed mission ids', () => {
  for (const scopeRecord of [false, true]) {
    const record = (scope: unknown) => scopeRecord
      ? { kind: 'constraint.scope', line: 'c', scope }
      : { kind: 'basis.version', basisKind: 'constraint', line: 'c', version: 'c.v1', mission: 'm1', scope };
    const scope = { paths: ['**'], taskTypes: [] };
    validateRecord(record(scope));
    validateRecord(record({ ...scope, mission: 'm2' }));
    for (const mission of [null, 1, '', 'm.2', 'm_2', '../m2']) {
      assert.throws(() => validateRecord(record({ ...scope, mission })), /scope.mission is not a mission id/);
    }
  }
});

it('the shared applicability predicate agrees with reference and stored coverage across mission, type and path scopes', async () => {
  const { constraintApplies } = await import('../src/memory/domain/constraints.ts');
  for (const mission of [undefined, 'm1', 'm2']) {
    const mirror = new Mirror(memoryPorts().memory);
    const scope = { paths: ['src/**'], taskTypes: ['code'], ...(mission === undefined ? {} : { mission }) };
    const candidates = [
      { id: 'A', mission: 'm1', scope: { paths: ['src/A.ts'], taskType: 'code' } },
      { id: 'B', mission: 'm2', scope: { paths: ['src/B.ts'], taskType: 'code' } },
      { id: 'C', mission: 'm1', scope: { paths: ['docs/C.md'], taskType: 'code' } },
      { id: 'D', mission: 'm2', scope: { paths: ['src/D.ts'], taskType: 'docs' } },
    ];
    mirror.append([
      { kind: 'basis.version', basisKind: 'constraint', line: 'c', version: 'c.v1', mission: 'm1', scope },
      ...candidates.flatMap((o) => [
        { kind: 'object.version', object: o.id, objectKind: 'product', mission: o.mission, module: null, content: '0'.repeat(64), prerequisites: [], scope: o.scope, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }] },
        { kind: 'judgment', judgment: `J${o.id}`, target: o.id, review: 'reviewer', executor: 'reviewer', verdict: 'pass', evidence: [], bases: [], constraints: [], reliesOn: [], issues: [], revokes: null, extends: null, evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [] },
      ]),
    ]);
    const state = mirror.state();
    for (const o of candidates) assert.equal(state.targets.get(o.id as never)!.label, constraintApplies({ scope }, o) ? 'not-fully-proven' : 'proven');
  }
});
