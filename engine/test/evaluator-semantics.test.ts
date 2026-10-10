// Reference semantics (design v30: 5.2–5.3, 5.6, 8.1, 10.1, 11.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Derivation, Index, fullCompute, type ContinuationRequest, type DerivedState, type ResolvedCommitted, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { revision, type Revision } from '../src/common/ids.ts';
import { encodeConstraintCheck, fixKey, reviewPosition } from '../src/common/records.ts';

/** A required review: just its kind (empty contract), or the kind with its contract. */
type Review = string | { review: string; basisLines?: string[]; reliesOn?: string[] };
const contract = (r: Review): Record<string, unknown> =>
  typeof r === 'string' ? { review: r, basisLines: [], reliesOn: [] } : { review: r.review, basisLines: r.basisLines ?? [], reliesOn: r.reliesOn ?? [] };

/** Tiny builder: records get consecutive revisions in the order they are added. */
class Log {
  readonly records: ResolvedCommitted[] = [];
  /** Paths of each object, and members of each unit, for constraint checks given as a bare version. */
  private readonly paths = new Map<string, string[]>();
  private readonly members = new Map<string, string[]>();
  add(r: Record<string, unknown>): Revision {
    const rev = revision(this.records.length + 1);
    this.records.push({ revision: rev, record: r as unknown as ResolvedRecord });
    return rev;
  }
  state(at?: Revision): DerivedState {
    return fullCompute(this.records, at ?? revision(this.records.length));
  }
  /** The program's continuation check (v32 5.2 part 5) against the current records. */
  continuation(
    req: Partial<Omit<ContinuationRequest, 'extends' | 'changedLines'>> & { extends: string; review: string; changedLines?: readonly string[] },
  ): ReturnType<Derivation['continuation']> {
    const ix = new Index();
    for (const c of this.records) ix.add(c);
    return new Derivation(ix).continuation({
      target: (ix.judgments.get(req.extends as never)?.rec.target as string | undefined) ?? '',
      changedLines: [],
      draft: { evidence: [], bases: [], constraints: [], reliesOn: [] },
      superseded: [],
      ...req,
    } as ContinuationRequest);
  }
  label(t: string, at?: Revision): string {
    return this.state(at).targets.get(t)?.label ?? 'missing';
  }
  basis(line: string, version: string, basisKind = 'requirement', scope: unknown = null): void {
    this.add({ kind: 'basis.version', basisKind, line, version, mission: 'm1', scope });
  }
  env(line: string, snapshot: string): void {
    this.add({ kind: 'env.snapshot', line, snapshot });
  }
  evidence(id: string, envLine = 'py', envSnapshot = 'py@1', fields: Record<string, string> = { exit: '0' }): void {
    this.add({ kind: 'evidence', evidence: id, envLine, envSnapshot, runClass: 'closed', fields });
  }
  object(id: string, o: { prereqs?: string[]; reviews?: Review[]; paths?: string[]; objectKind?: string; predecessor?: string } = {}): void {
    this.paths.set(id, o.paths ?? [`src/${id}.ts`]);
    this.add({
      kind: 'object.version',
      object: id,
      objectKind: o.objectKind ?? 'product',
      mission: 'm1',
      module: null,
      content: '0'.repeat(64),
      prerequisites: o.prereqs ?? [],
      scope: { paths: o.paths ?? [`src/${id}.ts`], taskType: 'construct' },
      reviews: (o.reviews ?? ['reviewer']).map(contract),
      ...(o.predecessor ? { predecessor: o.predecessor } : {}),
    });
  }
  targetPaths(t: string): string[] {
    return this.paths.get(t) ?? (this.members.get(t) ?? []).flatMap((m) => this.paths.get(m) ?? []);
  }
  unit(id: string, members: string[], reviews: Review[]): void {
    this.members.set(id, members);
    this.add({ kind: 'proof.unit', unit: id, members, reviews: reviews.map(contract) });
  }
  judge(
    id: string,
    target: string,
    verdict: 'pass' | 'fail' | 'undecided',
    o: {
      review?: string;
      executor?: string;
      evidence?: string[];
      bases?: string[];
      /** A bare version means "reviewed on all of the target's paths"; or give the paths reviewed (v33). */
      constraints?: (string | { version: string; paths: string[] })[];
      reliesOn?: string[];
      issues?: { issue: string; response: 'fixed' | 'not-fixed' | 'deferred' }[];
      revokes?: string | null;
      extends?: string | null;
      evidenceUse?: { fields: string[]; statisticalOrExternal: boolean };
      superseded?: { input: string; by: string }[];
    } = {},
  ): Revision {
    return this.add({
      kind: 'judgment',
      judgment: id,
      review: o.review ?? 'reviewer',
      executor: o.executor ?? o.review ?? 'reviewer',
      target,
      verdict,
      evidence: o.evidence ?? [],
      bases: o.bases ?? [],
      constraints: (o.constraints ?? []).map((c) =>
        encodeConstraintCheck(typeof c === 'string' ? { version: c, paths: this.targetPaths(target) } : c),
      ),
      reliesOn: o.reliesOn ?? [],
      issues: o.issues ?? [],
      revokes: o.revokes ?? null,
      extends: o.extends ?? null,
      evidenceUse: o.evidenceUse ?? { fields: ['exit'], statisticalOrExternal: false },
      superseded: o.superseded ?? [],
    });
  }
}

/** A proven product P with one evidence E on env py@1 and one requirement basis. */
function provenProduct(): Log {
  const L = new Log();
  L.env('py', 'py@1');
  L.basis('req', 'req.v1');
  L.basis('std', 'std.v1', 'standard');
  L.evidence('E1');
  L.object('P');
  L.judge('J1', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'] });
  return L;
}

test('a passed, current, fresh object is proven', () => {
  assert.equal(provenProduct().label('P'), 'proven');
});

test('evidence invalidation reaches the product: an environment change makes it not fully proven (5.2)', () => {
  const L = provenProduct();
  L.env('py', 'py@2');
  const s = L.state();
  assert.equal(s.evidenceApplicable.get('E1' as never), false);
  assert.equal(s.judgmentCurrent.get('J1' as never), false);
  assert.equal(L.label('P'), 'not-fully-proven');
});

test('mechanical renewal restores the judgment after an environment change (5.3)', () => {
  const L = provenProduct();
  L.env('py', 'py@2');
  L.evidence('E2', 'py', 'py@2');
  L.add({ kind: 'evidence.renewal', judgment: 'J1', original: 'E1', replacement: 'E2' });
  assert.equal(L.label('P'), 'proven');
});

test('a negation is not revived by an older pass when its evidence later needs a rerun (5.3)', () => {
  const L = provenProduct();
  L.evidence('E9');
  L.judge('J2', 'P', 'fail', { evidence: ['E9'] });
  L.add({ kind: 'evidence.revoked', evidence: 'E9' });
  assert.equal(L.label('P'), 'negated');
});

test('revoking a negation needs the same review kind naming it (8.1)', () => {
  const L = provenProduct();
  L.judge('J2', 'P', 'fail');
  L.judge('J3', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'] });
  assert.equal(L.label('P'), 'negated', 'a pass that does not name the negation does not revoke it');
  L.judge('J4', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'], revokes: 'J2' });
  assert.equal(L.label('P'), 'proven');
});

test('multiple required reviews: order of arrival does not change the conclusion (8.1)', () => {
  const build = (securityFirst: boolean): Log => {
    const L = new Log();
    L.env('py', 'py@1');
    L.evidence('E1');
    L.object('P', { reviews: ['reviewer', 'reviewer:security'] });
    const sec = (): void => void L.judge('S1', 'P', 'fail', { review: 'reviewer:security' });
    const rev = (): void => void L.judge('R1', 'P', 'pass', { evidence: ['E1'] });
    if (securityFirst) {
      sec();
      rev();
    } else {
      rev();
      sec();
    }
    return L;
  };
  assert.equal(build(true).label('P'), 'negated');
  assert.equal(build(false).label('P'), 'negated');
  const only = new Log();
  only.env('py', 'py@1');
  only.evidence('E1');
  only.object('P', { reviews: ['reviewer', 'reviewer:security'] });
  only.judge('R1', 'P', 'pass', { evidence: ['E1'] });
  assert.equal(only.label('P'), 'unaccepted', 'a missing required review leaves the object unaccepted');
});

test('basis revised → not fully proven; basis withdrawn → basis-withdrawn label (5.2, 5.3)', () => {
  const L = provenProduct();
  L.basis('req', 'req.v2');
  assert.equal(L.label('P'), 'not-fully-proven');
  L.add({ kind: 'basis.withdrawn', line: 'req' });
  assert.equal(L.label('P'), 'basis-withdrawn');
});

test('a revised requirement: a new review against the new version restores proof, the object is unchanged (v29 5.2)', () => {
  const L = provenProduct();
  L.basis('req', 'req.v2');
  assert.equal(L.label('P'), 'not-fully-proven');
  L.judge('J2', 'P', 'pass', { evidence: ['E1'], bases: ['req.v2', 'std.v1'] });
  assert.equal(L.label('P'), 'proven');
});

test('a standard change makes the judgment not current (5.2)', () => {
  const L = provenProduct();
  L.basis('std', 'std.v2', 'standard');
  assert.equal(L.label('P'), 'not-fully-proven');
});

test('prerequisites: an unproven prerequisite makes the dependent not fully proven (5.2)', () => {
  const L = provenProduct();
  L.object('Q', { prereqs: ['P'] });
  L.judge('JQ', 'Q', 'pass', { evidence: ['E1'] });
  assert.equal(L.label('Q'), 'proven');
  L.env('py', 'py@2');
  assert.equal(L.label('Q'), 'not-fully-proven');
});

test('authorization change propagates through the plan object to the plan that relies on it (v30 5.2)', () => {
  const L = new Log();
  L.basis('auth', 'auth.v1', 'authorization');
  L.object('PM', { objectKind: 'plan', reviews: [{ review: 'calibrator-1', basisLines: ['auth'] }] });
  L.judge('C1', 'PM', 'pass', { review: 'calibrator-1', bases: ['auth.v1'] });
  L.object('D', { objectKind: 'plan', reviews: [{ review: 'feasibility', reliesOn: ['PM'] }] });
  L.judge('F1', 'D', 'pass', { review: 'feasibility', reliesOn: ['PM'] });
  assert.equal(L.label('D'), 'proven');
  L.basis('auth', 'auth.v2', 'authorization');
  const s = L.state();
  assert.equal(s.positionInEffect.get(reviewPosition('PM', 'calibrator-1')), false);
  assert.equal(L.label('PM'), 'not-fully-proven');
  assert.equal(s.judgmentCurrent.get('F1' as never), false);
  assert.equal(L.label('D'), 'not-fully-proven');
});

test('revoking a pass is a new negation on the same position: the object and its dependents change together (v30 5.2)', () => {
  const L = new Log();
  L.object('PM', { reviews: ['calibrator-1'] });
  L.judge('C1', 'PM', 'pass', { review: 'calibrator-1' });
  L.object('D', { reviews: [{ review: 'feasibility', reliesOn: ['PM'] }] });
  L.judge('F1', 'D', 'pass', { review: 'feasibility', reliesOn: ['PM'] });
  assert.equal(L.label('PM'), 'proven');
  assert.equal(L.label('D'), 'proven');
  L.judge('C2', 'PM', 'fail', { review: 'calibrator-1' });
  assert.equal(L.state().judgmentCurrent.get('C1' as never), true, 'C1 itself is still current');
  assert.equal(L.label('PM'), 'negated', 'the object follows its position');
  assert.equal(L.state().judgmentCurrent.get('F1' as never), false, 'F1 relies on PM being proven');
  assert.equal(L.label('D'), 'not-fully-proven', 'and so does the dependent');
});

test('constraints: new or widened degrades, a re-review restores; withdrawal or narrowing does not degrade (v30 5.2)', () => {
  const L = new Log();
  L.basis('c-types', 'c-types.v1', 'constraint', { paths: ['src/**'], taskTypes: [] });
  L.object('P', { paths: ['src/a.ts'] });
  L.judge('J', 'P', 'pass', { constraints: ['c-types.v1'] });
  assert.equal(L.label('P'), 'proven');
  // A new constraint that applies to P.
  L.basis('c-docs', 'c-docs.v1', 'constraint', { paths: ['src/**'], taskTypes: [] });
  assert.equal(L.label('P'), 'not-fully-proven');
  // The bytes already satisfy it: a re-review against both restores proof, no new object.
  L.judge('J2', 'P', 'pass', { constraints: ['c-types.v1', 'c-docs.v1'] });
  assert.equal(L.label('P'), 'proven');
  // Withdrawing a constraint never degrades (judgments do not check constraint validity).
  L.add({ kind: 'basis.withdrawn', line: 'c-docs' });
  assert.equal(L.label('P'), 'proven');
  // A constraint for another directory, then its scope widened to cover P.
  L.basis('c-lint', 'c-lint.v1', 'constraint', { paths: ['lib/**'], taskTypes: [] });
  assert.equal(L.label('P'), 'proven');
  L.basis('c-lint', 'c-lint.v2', 'constraint', { paths: ['lib/**', 'src/**'], taskTypes: [] });
  assert.equal(L.label('P'), 'not-fully-proven');
  // Narrowing a checked constraint so it no longer applies keeps coverage.
  const M = new Log();
  M.basis('c', 'c.v1', 'constraint', { paths: ['src/**'], taskTypes: [] });
  M.object('P', { paths: ['src/a.ts'] });
  M.judge('J', 'P', 'pass', { constraints: ['c.v1'] });
  M.basis('c', 'c.v2', 'constraint', { paths: ['lib/**'], taskTypes: [] });
  assert.equal(M.label('P'), 'proven');
});

test('v33: widening a constraint inside one object degrades it until the new path is reviewed', () => {
  const L = new Log();
  L.basis('c', 'c.v1', 'constraint', { paths: ['src/a.ts'], taskTypes: [] });
  L.object('P', { paths: ['src/a.ts', 'src/b.ts'] });
  L.judge('J', 'P', 'pass', { constraints: [{ version: 'c.v1', paths: ['src/a.ts'] }] });
  assert.equal(L.label('P'), 'proven', 'the check covered the whole required range');
  L.add({ kind: 'constraint.scope', line: 'c', scope: { paths: ['src/a.ts', 'src/b.ts'], taskTypes: [] } });
  assert.equal(L.label('P'), 'not-fully-proven', 'src/b.ts is now required and was never reviewed against c.v1');
  L.judge('J2', 'P', 'pass', { constraints: [{ version: 'c.v1', paths: ['src/b.ts'] }] });
  assert.equal(L.label('P'), 'not-fully-proven', 'J2 replaced J as the deciding judgment; its check alone does not cover src/a.ts');
  L.judge('J3', 'P', 'pass', { constraints: [{ version: 'c.v1', paths: ['src/a.ts', 'src/b.ts'] }] });
  assert.equal(L.label('P'), 'proven');
});

test('v33: moving a constraint to another path, same content version, degrades; narrowing keeps proof', () => {
  const L = new Log();
  L.basis('c', 'c.v1', 'constraint', { paths: ['src/a.ts'], taskTypes: [] });
  L.object('P', { paths: ['src/a.ts', 'src/b.ts'] });
  L.judge('J', 'P', 'pass', { constraints: [{ version: 'c.v1', paths: ['src/a.ts'] }] });
  L.add({ kind: 'constraint.scope', line: 'c', scope: { paths: ['src/b.ts'], taskTypes: [] } });
  assert.equal(L.label('P'), 'not-fully-proven');
  const M = new Log();
  M.basis('c', 'c.v1', 'constraint', { paths: ['src/**'], taskTypes: [] });
  M.object('P', { paths: ['src/a.ts', 'src/b.ts'] });
  M.judge('J', 'P', 'pass', { constraints: ['c.v1'] });
  M.add({ kind: 'constraint.scope', line: 'c', scope: { paths: ['src/a.ts'], taskTypes: [] } });
  assert.equal(M.label('P'), 'proven');
});

test('v33: several deciding judgments cover a constraint together (union over positions)', () => {
  const L = new Log();
  L.basis('c', 'c.v1', 'constraint', { paths: ['src/**'], taskTypes: [] });
  L.object('P', { paths: ['src/a.ts', 'src/b.ts'], reviews: ['reviewer', 'sec'] });
  L.judge('R', 'P', 'pass', { constraints: [{ version: 'c.v1', paths: ['src/a.ts'] }] });
  L.judge('S', 'P', 'pass', { review: 'sec', constraints: [{ version: 'c.v1', paths: ['src/b.ts'] }] });
  assert.equal(L.label('P'), 'proven');
  L.judge('S2', 'P', 'pass', { review: 'sec' });
  assert.equal(L.label('P'), 'not-fully-proven', 'the new deciding judgment on sec reviewed nothing against c');
});

test('v33 continuation: inherited checks keep their reviewed paths; a widened scope still needs review', () => {
  const L = new Log();
  L.basis('reqB', 'reqB.v1');
  L.basis('c', 'c.v1', 'constraint', { paths: ['plans/a.md'], taskTypes: [] });
  const contract = { review: 'calibrator-1', basisLines: ['reqB'] };
  L.object('M1', { objectKind: 'plan', reviews: [contract], paths: ['plans/a.md', 'plans/b.md'] });
  L.judge('C1', 'M1', 'pass', { review: 'calibrator-1', bases: ['reqB.v1'], constraints: [{ version: 'c.v1', paths: ['plans/a.md'] }] });
  L.basis('reqB', 'reqB.v2');
  L.object('M2', { objectKind: 'plan', reviews: [contract], paths: ['plans/a.md', 'plans/b.md'], predecessor: 'M1' });
  L.add({ kind: 'constraint.scope', line: 'c', scope: { paths: ['plans/**'], taskTypes: [] } });
  const res = L.continuation({ extends: 'C1', target: 'M2', review: 'calibrator-1', changedLines: ['reqB'], draft: { evidence: [], bases: ['reqB.v2'], constraints: [], reliesOn: [] } });
  assert.ok(res.ok);
  if (!res.ok) return;
  L.add({
    kind: 'judgment', judgment: 'C2', review: 'calibrator-1', executor: 'calibrator-1', target: 'M2', verdict: 'pass',
    evidence: res.merged.evidence, bases: res.merged.bases, constraints: res.merged.constraints, reliesOn: res.merged.reliesOn,
    issues: [], revokes: null, extends: 'C1', evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
  });
  assert.equal(L.label('M2'), 'not-fully-proven', 'plans/b.md was never reviewed against c.v1');
});

test('a scope change alone keeps the content version: narrowing and re-widening a checked constraint keeps coverage (v30 5.2, 9.5)', () => {
  const L = new Log();
  L.basis('c', 'c.v1', 'constraint', { paths: ['src/**'], taskTypes: [] });
  L.object('P', { paths: ['src/a.ts'] });
  L.judge('J', 'P', 'pass', { constraints: ['c.v1'] });
  L.add({ kind: 'constraint.scope', line: 'c', scope: { paths: ['lib/**'], taskTypes: [] } });
  assert.equal(L.label('P'), 'proven', 'narrowed away');
  L.add({ kind: 'constraint.scope', line: 'c', scope: { paths: ['src/**', 'lib/**'], taskTypes: [] } });
  assert.equal(L.label('P'), 'proven', 'widened back: the content P was checked against is unchanged');
  // An unchecked constraint widened onto P by a scope record degrades P.
  L.basis('d', 'd.v1', 'constraint', { paths: ['lib/**'], taskTypes: [] });
  assert.equal(L.label('P'), 'proven');
  L.add({ kind: 'constraint.scope', line: 'd', scope: { paths: ['lib/**', 'src/**'], taskTypes: [] } });
  assert.equal(L.label('P'), 'not-fully-proven');
  // A content change after a scope change keeps the changed scope.
  L.judge('J2', 'P', 'pass', { constraints: ['c.v1', 'd.v1'] });
  assert.equal(L.label('P'), 'proven');
  L.basis('d', 'd.v2', 'constraint', null);
  assert.equal(L.label('P'), 'not-fully-proven', 'd.v2 still applies to src/** and was not checked');
});

test('proof units: members do not count each other; a member is no better than its unit (5.3)', () => {
  const L = new Log();
  L.object('A', { prereqs: ['B'] });
  L.object('B', { prereqs: ['A'] });
  L.judge('JA', 'A', 'pass');
  L.judge('JB', 'B', 'pass');
  assert.equal(L.label('A'), 'not-fully-proven', 'an undeclared cycle is never proven');
  L.unit('U', ['A', 'B'], ['integration']);
  assert.equal(L.label('A'), 'unaccepted', 'the unit has not been judged');
  L.judge('JU', 'U', 'pass', { review: 'integration' });
  assert.equal(L.label('A'), 'proven');
  assert.equal(L.label('B'), 'proven');
  L.judge('JU2', 'U', 'fail', { review: 'integration' });
  assert.equal(L.label('A'), 'negated', 'the unit is judged and withdrawn as a whole');
});

test('fix validity is per version and follows the version label (5.6)', () => {
  const L = provenProduct();
  L.add({ kind: 'issue', issue: 'N', module: null, observedOn: ['P0'] });
  L.evidence('R1', 'py', 'py@1', { exit: '0', 'test:t1': 'passed', 'input:testfile:t/test_a.py': 'h1', 'input:runner:pytest.ini': 'h2' });
  L.add({ kind: 'issue.coverage', issue: 'N', version: 'P', evidence: 'R1', command: 'pytest -k t1', tests: ['t1'], inputs: ['testfile:t/test_a.py=h1', 'runner:pytest.ini=h2'] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'fixed');
  L.basis('req', 'req.v2');
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'fixed-not-fully-proven');
  assert.equal(L.state().fixes.get(fixKey('N', 'P2')), undefined, 'a version without a coverage proof has no fix entry');
});

test('fix state comes from the deciding judgments: a re-review reopens an issue the regression run still covers (v30 5.6)', () => {
  const L = provenProduct();
  L.add({ kind: 'issue', issue: 'N', module: null, observedOn: ['P0'] });
  L.evidence('R1', 'py', 'py@1', { exit: '0', 'test:t1': 'passed', 'input:testfile:t/test_a.py': 'h1', 'input:runner:pytest.ini': 'h2' });
  L.add({ kind: 'issue.coverage', issue: 'N', version: 'P', evidence: 'R1', command: 'pytest -k t1', tests: ['t1'], inputs: ['testfile:t/test_a.py=h1', 'runner:pytest.ini=h2'] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'fixed');
  L.judge('J2', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'], issues: [{ issue: 'N', response: 'not-fixed' }] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'unfixed', 'not-fixed wins over the regression run');
  L.judge('J3', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'], issues: [{ issue: 'N', response: 'deferred' }] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'unfixed', 'deferred too');
});

test('a superseded "fixed" response no longer counts; only the deciding judgment does (v30 5.6)', () => {
  const L = provenProduct();
  L.add({ kind: 'issue', issue: 'N', module: null, observedOn: ['P0'] });
  L.judge('J2', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'], issues: [{ issue: 'N', response: 'fixed' }] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'fixed');
  L.judge('J3', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), undefined, 'no deciding response and no regression run: no coverage proof');
  L.judge('J4', 'P', 'pass', { evidence: ['E1'], bases: ['req.v1', 'std.v1'], issues: [{ issue: 'N', response: 'fixed' }] });
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'fixed');
  L.basis('std', 'std.v2', 'standard');
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'unfixed', 'a "fixed" response from a judgment that is no longer current is not a coverage proof');
});

test('operation nodes: all objects proven, and an executed operation keeps tracking them (6.1)', () => {
  const L = provenProduct();
  L.add({ kind: 'op.pending', op: 'D1', opKind: 'delivery', objects: ['P'], scope: { mission: 'm1' as never, capabilities: [] } });
  const r = L.add({ kind: 'op.executed', op: 'D1', asOf: revision(7) });
  assert.deepEqual(L.state().ops.get('D1' as never), { kind: 'delivery', allProven: true, executedAsOf: 7 });
  L.env('py', 'py@2');
  assert.equal(L.state().ops.get('D1' as never)?.allProven, false);
  assert.equal(L.state(r).ops.get('D1' as never)?.allProven, true, 'the state at an earlier revision is unchanged');
});

test('Auditor: backfill fills a review position (boundary or ordinary node); the chain seal is only downstream (v30 5.2, 11)', () => {
  const L = new Log();
  // A migrated boundary node whose only required review is the Auditor's.
  L.object('B', { reviews: ['auditor'] });
  assert.equal(L.label('B'), 'unaccepted');
  L.judge('A1', 'B', 'pass', { review: 'auditor', executor: 'auditor' });
  assert.equal(L.label('B'), 'proven', 'the backfill does not depend on B being proven');
  // An ordinary node closed with risk, missing its Reviewer: the backfill fills that position.
  L.object('P');
  assert.equal(L.label('P'), 'unaccepted');
  L.judge('A2', 'P', 'pass', { review: 'reviewer', executor: 'auditor' });
  assert.equal(L.label('P'), 'proven');
  L.add({ kind: 'op.pending', op: 'SEAL', opKind: 'legalization', objects: ['B', 'P'], scope: { mission: 'm1' as never, capabilities: [] } });
  assert.equal(L.state().ops.get('SEAL' as never)?.allProven, true);
});

test('an Auditor backfill is held to the position contract: it cannot drop a basis line or a relied-on object (v30 5.2)', () => {
  const L = new Log();
  L.basis('req', 'req.v1');
  L.object('PLAN', { objectKind: 'plan', reviews: ['calibrator-2'] });
  L.judge('C2', 'PLAN', 'pass', { review: 'calibrator-2' });
  L.object('P', { reviews: [{ review: 'reviewer', basisLines: ['req'], reliesOn: ['PLAN'] }] });
  L.judge('A1', 'P', 'pass', { review: 'reviewer', executor: 'auditor', reliesOn: ['PLAN'] });
  assert.equal(L.state().judgmentCurrent.get('A1' as never), false, 'no version of the contract basis line "req"');
  assert.equal(L.label('P'), 'not-fully-proven');
  L.judge('A2', 'P', 'pass', { review: 'reviewer', executor: 'auditor', bases: ['req.v1'] });
  assert.equal(L.state().judgmentCurrent.get('A2' as never), false, 'does not rely on the contract object PLAN');
  L.judge('A3', 'P', 'pass', { review: 'reviewer', executor: 'auditor', bases: ['req.v1'], reliesOn: ['PLAN'] });
  assert.equal(L.label('P'), 'proven');
  // The contract's object still counts after the backfill: PLAN degrading reaches P.
  L.judge('C3', 'PLAN', 'fail', { review: 'calibrator-2' });
  assert.equal(L.label('P'), 'not-fully-proven');
});

test('a judgment may rely on more objects than its contract names; each must be proven (v30 5.2)', () => {
  const L = new Log();
  L.object('X', { reviews: ['r'] });
  L.object('P');
  L.judge('J', 'P', 'pass', { reliesOn: ['X'] });
  assert.equal(L.label('P'), 'not-fully-proven', 'X is unaccepted');
  L.judge('JX', 'X', 'pass', { review: 'r' });
  assert.equal(L.label('P'), 'proven');
});

test('the plan review chain degrades together: Calibrator ① negated → PM plan → detailed plan → product (v30 5.2)', () => {
  const L = new Log();
  L.object('PM', { objectKind: 'plan', reviews: ['calibrator-1'], paths: ['plans/pm.md'] });
  L.judge('C1', 'PM', 'pass', { review: 'calibrator-1' });
  L.object('DP', { objectKind: 'plan', reviews: [{ review: 'calibrator-2', reliesOn: ['PM'] }], paths: ['plans/detail.md'] });
  L.judge('C2', 'DP', 'pass', { review: 'calibrator-2', reliesOn: ['PM'] });
  L.object('P', { reviews: [{ review: 'reviewer', reliesOn: ['DP'] }] });
  L.judge('R', 'P', 'pass', { reliesOn: ['DP'] });
  assert.equal(L.label('P'), 'proven');
  L.judge('C1x', 'PM', 'fail', { review: 'calibrator-1' });
  const s = L.state();
  assert.equal(L.label('PM'), 'negated');
  assert.equal(s.judgmentCurrent.get('C2' as never), false);
  assert.equal(L.label('DP'), 'not-fully-proven');
  assert.equal(s.judgmentCurrent.get('R' as never), false);
  assert.equal(L.label('P'), 'not-fully-proven');
});

test('a constraint added upstream reaches downstream through object reliance, not through a bare position (v30 5.2)', () => {
  const L = new Log();
  L.object('PM', { objectKind: 'plan', reviews: ['calibrator-1'], paths: ['plans/pm.md'] });
  L.judge('C1', 'PM', 'pass', { review: 'calibrator-1' });
  L.object('DP', { objectKind: 'plan', reviews: [{ review: 'calibrator-2', reliesOn: ['PM'] }], paths: ['plans/detail.md'] });
  L.judge('C2', 'DP', 'pass', { review: 'calibrator-2', reliesOn: ['PM'] });
  assert.equal(L.label('DP'), 'proven');
  L.basis('c-plan', 'c-plan.v1', 'constraint', { paths: ['plans/pm.md'], taskTypes: [] });
  const s = L.state();
  assert.equal(s.positionInEffect.get(reviewPosition('PM', 'calibrator-1')), true, 'the position itself is still in effect');
  assert.equal(L.label('PM'), 'not-fully-proven', 'but PM lacks coverage');
  assert.equal(L.label('DP'), 'not-fully-proven', 'so DP degrades with it');
  L.judge('C1b', 'PM', 'pass', { review: 'calibrator-1', constraints: ['c-plan.v1'] });
  assert.equal(L.label('DP'), 'proven', 'a coverage re-review of PM restores both');
});

test('an Auditor backfill cannot revoke a negation (v30 5.2)', () => {
  const L = new Log();
  L.object('P', { reviews: ['reviewer', 'reviewer:security'] });
  L.judge('R1', 'P', 'pass');
  L.judge('S1', 'P', 'fail', { review: 'reviewer:security' });
  L.judge('A1', 'P', 'pass', { review: 'reviewer:security', executor: 'auditor', revokes: 'S1' });
  assert.equal(L.label('P'), 'negated');
  L.judge('S2', 'P', 'pass', { review: 'reviewer:security', revokes: 'S1' });
  assert.equal(L.label('P'), 'proven', 'the same review kind can revoke it');
});

test('objects re-wired into a cycle by a later judgment are not proven (v30 5.2 least fixed point)', () => {
  const L = new Log();
  L.object('M', { reviews: ['calibrator-1'] });
  L.object('D', { reviews: ['feasibility'] });
  L.judge('C1', 'M', 'pass', { review: 'calibrator-1' });
  L.judge('F', 'D', 'pass', { review: 'feasibility', reliesOn: ['M'] });
  assert.equal(L.label('D'), 'proven');
  // A re-ruling on M now relies on D: M's judgment needs D proven, D's judgment needs M proven.
  L.judge('C2', 'M', 'pass', { review: 'calibrator-1', reliesOn: ['D'] });
  const s = L.state();
  assert.equal(s.positionInEffect.get(reviewPosition('M', 'calibrator-1')), false);
  assert.equal(s.positionInEffect.get(reviewPosition('D', 'feasibility')), false);
  assert.equal(L.label('M'), 'not-fully-proven');
  assert.equal(L.label('D'), 'not-fully-proven');
});

test('a dependency cycle through judgments and objects is never proven, nor is anything relying on it', () => {
  const L = new Log();
  L.object('X', { reviews: ['r'] });
  L.object('Y', { reviews: ['r'] });
  L.judge('JX', 'X', 'pass', { review: 'r', reliesOn: ['Y'] });
  L.judge('JY', 'Y', 'pass', { review: 'r', reliesOn: ['X'] });
  L.object('Z', { reviews: ['r'] });
  L.judge('JZ', 'Z', 'pass', { review: 'r', reliesOn: ['X'] });
  const s = L.state();
  assert.equal(s.positionInEffect.get(reviewPosition('X', 'r')), false);
  assert.equal(L.label('X'), 'not-fully-proven');
  assert.equal(L.label('Y'), 'not-fully-proven');
  assert.equal(L.label('Z'), 'not-fully-proven');
});

test('the result does not depend on the order targets are evaluated in (least fixed point is unique)', () => {
  const build = (order: 'xy' | 'yx'): Log => {
    const L = new Log();
    const objs = order === 'xy' ? ['X', 'Y'] : ['Y', 'X'];
    for (const o of objs) L.object(o, { reviews: ['r'] });
    L.object('W', { reviews: ['r'] });
    L.judge('JW', 'W', 'pass', { review: 'r' });
    L.judge('JX', 'X', 'pass', { review: 'r', reliesOn: ['W', 'Y'] });
    L.judge('JY', 'Y', 'pass', { review: 'r', reliesOn: ['X'] });
    return L;
  };
  const a = build('xy').state();
  const b = build('yx').state();
  for (const t of ['W', 'X', 'Y']) assert.deepEqual(a.targets.get(t), b.targets.get(t), t);
  assert.equal(a.targets.get('W')?.label, 'proven');
});

test('v31: an unchanged plan part keeps its basis through a continuation judgment; revising it degrades the new plan and its dependents (5.2 part 5)', () => {
  const L = new Log();
  // Requirement items A1, B1 and the mission's requirement set, one line each.
  L.basis('reqA', 'reqA.v1');
  L.basis('reqB', 'reqB.v1');
  L.basis('reqset', 'reqset.v1', 'requirement-set');
  const contract = { review: 'calibrator-1', basisLines: ['reqset'] };
  L.object('M1', { objectKind: 'plan', reviews: [contract], paths: ['plans/pm.md'] });
  L.judge('C1', 'M1', 'pass', { review: 'calibrator-1', bases: ['reqset.v1', 'reqA.v1', 'reqB.v1'] });
  assert.equal(L.label('M1'), 'proven');
  // The next batch changes only part B: B1 → B2, a new requirement-set version and plan M2.
  L.basis('reqB', 'reqB.v2');
  L.basis('reqset', 'reqset.v2', 'requirement-set');
  L.object('M2', { objectKind: 'plan', reviews: [contract], paths: ['plans/pm.md'], predecessor: 'M1' });
  L.judge('C2', 'M2', 'pass', { review: 'calibrator-1', bases: ['reqset.v2', 'reqA.v1', 'reqB.v2'], extends: 'C1' });
  L.object('DP', { objectKind: 'plan', reviews: [{ review: 'calibrator-2', reliesOn: ['M2'] }], paths: ['plans/detail.md'] });
  L.judge('K2', 'DP', 'pass', { review: 'calibrator-2', reliesOn: ['M2'] });
  L.object('P', { reviews: [{ review: 'reviewer', reliesOn: ['DP'] }] });
  L.judge('R', 'P', 'pass', { reliesOn: ['DP'] });
  assert.equal(L.label('P'), 'proven');
  // The retained part A's basis is revised: A1 → A2 (and so the requirement set).
  L.basis('reqA', 'reqA.v2');
  L.basis('reqset', 'reqset.v3', 'requirement-set');
  assert.equal(L.label('M2'), 'not-fully-proven');
  assert.equal(L.label('DP'), 'not-fully-proven');
  assert.equal(L.label('P'), 'not-fully-proven');
  // A continuation judgment that reviews only A2 restores all three; P's own judgment is untouched.
  L.judge('C3', 'M2', 'pass', { review: 'calibrator-1', bases: ['reqset.v3', 'reqA.v2', 'reqB.v2'], extends: 'C2' });
  assert.equal(L.label('M2'), 'proven');
  assert.equal(L.label('DP'), 'proven');
  assert.equal(L.label('P'), 'proven');
});

test('v31: the seal depends on the chain acceptance object; revoking only the chain evidence drops the seal (11.1)', () => {
  const L = provenProduct();
  L.object('Q', { prereqs: ['P'] });
  L.judge('JQ', 'Q', 'pass', { evidence: ['E1'] });
  L.basis('reqset', 'reqset.v1', 'requirement-set');
  L.evidence('SEAM');
  L.object('CHAIN', {
    objectKind: 'chain-acceptance',
    reviews: [{ review: 'auditor-chain', basisLines: ['reqset'], reliesOn: ['P', 'Q'] }],
    paths: ['chain/Q'],
  });
  L.judge('AC', 'CHAIN', 'pass', { review: 'auditor-chain', executor: 'auditor', evidence: ['SEAM'], bases: ['reqset.v1'], reliesOn: ['P', 'Q'] });
  L.add({ kind: 'op.pending', op: 'SEAL', opKind: 'legalization', objects: ['CHAIN'], scope: { mission: 'm1' as never, capabilities: [] } });
  assert.equal(L.state().ops.get('SEAL' as never)?.allProven, true);
  L.add({ kind: 'evidence.revoked', evidence: 'SEAM' });
  const s = L.state();
  assert.equal(s.targets.get('P')?.label, 'proven', 'the chain nodes are still proven');
  assert.equal(s.targets.get('Q')?.label, 'proven');
  assert.equal(s.targets.get('CHAIN')?.label, 'not-fully-proven');
  assert.equal(s.ops.get('SEAL' as never)?.allProven, false);
});

test('v31 5.6 order: a negated version is unfixed even when the negating judgment says the issue is fixed', () => {
  const L = provenProduct();
  L.add({ kind: 'issue', issue: 'N', module: null, observedOn: ['P0'] });
  L.judge('J2', 'P', 'fail', { evidence: ['E1'], bases: ['req.v1', 'std.v1'], issues: [{ issue: 'N', response: 'fixed' }] });
  assert.equal(L.label('P'), 'negated');
  assert.equal(L.state().fixes.get(fixKey('N', 'P')), 'unfixed');
});

test('v32: a product whose own judgment binds the revised item does not recover with the plan; one that depends only through the plan does (5.2 part 5)', () => {
  const L = new Log();
  L.basis('reqA', 'reqA.v1');
  L.basis('reqset', 'reqset.v1', 'requirement-set');
  const contract = { review: 'calibrator-1', basisLines: ['reqset'] };
  L.object('M', { objectKind: 'plan', reviews: [contract], paths: ['plans/pm.md'] });
  L.judge('C1', 'M', 'pass', { review: 'calibrator-1', bases: ['reqset.v1', 'reqA.v1'] });
  L.object('DP', { objectKind: 'plan', reviews: [{ review: 'calibrator-2', reliesOn: ['M'] }], paths: ['plans/detail.md'] });
  L.judge('K', 'DP', 'pass', { review: 'calibrator-2', reliesOn: ['M'] });
  L.object('PI', { reviews: [{ review: 'reviewer', reliesOn: ['DP'] }] });
  L.judge('RI', 'PI', 'pass', { reliesOn: ['DP'] });
  L.object('PD', { reviews: [{ review: 'reviewer', basisLines: ['reqA'], reliesOn: ['DP'] }] });
  L.judge('RD', 'PD', 'pass', { reliesOn: ['DP'], bases: ['reqA.v1'] });
  assert.equal(L.label('PD'), 'proven');
  L.basis('reqA', 'reqA.v2');
  L.basis('reqset', 'reqset.v2', 'requirement-set');
  L.judge('C2', 'M', 'pass', { review: 'calibrator-1', bases: ['reqset.v2', 'reqA.v2'], extends: 'C1' });
  assert.equal(L.label('M'), 'proven');
  assert.equal(L.label('PI'), 'proven', 'indirect dependents recover');
  assert.equal(L.label('PD'), 'not-fully-proven', 'a judgment bound to reqA.v1 needs its own re-review');
  L.judge('RD2', 'PD', 'pass', { reliesOn: ['DP'], bases: ['reqA.v2'] });
  assert.equal(L.label('PD'), 'proven');
});

test('v32 continuation: inherits the retained evidence; revoking it later degrades the new version (5.2 part 5)', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.basis('reqA', 'reqA.v1');
  L.basis('reqB', 'reqB.v1');
  L.evidence('EA');
  L.evidence('EB');
  const contract = { review: 'feasibility', basisLines: ['reqA', 'reqB'] };
  L.object('D1', { objectKind: 'plan', reviews: [contract], paths: ['plans/d.md'] });
  L.judge('F1', 'D1', 'pass', { review: 'feasibility', evidence: ['EA', 'EB'], bases: ['reqA.v1', 'reqB.v1'] });
  // Only part B changes: B1 → B2 and a new version D2; the seat reviews B with new evidence EB2 replacing EB.
  L.basis('reqB', 'reqB.v2');
  L.evidence('EB2');
  L.object('D2', { objectKind: 'plan', reviews: [contract], paths: ['plans/d.md'], predecessor: 'D1' });
  const res = L.continuation({
    extends: 'F1',
    target: 'D2',
    review: 'feasibility',
    changedLines: ['reqB'],
    draft: { evidence: ['EB2'], bases: ['reqB.v2'], constraints: [], reliesOn: [] },
    superseded: [{ input: 'EB', by: 'EB2' }],
  });
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.deepEqual(res.merged.evidence, ['EA', 'EB2'], 'EA is inherited, EB is replaced');
  assert.deepEqual(res.merged.bases, ['reqA.v1', 'reqB.v2']);
  L.judge('F2', 'D2', 'pass', { review: 'feasibility', ...res.merged, extends: 'F1', superseded: [{ input: 'EB', by: 'EB2' }] });
  // Without declaring the replacement, the continuation drops an input of F1 and is not current (core review r1 #12).
  L.judge('F3', 'D2', 'pass', { review: 'feasibility', evidence: ['EB2'], bases: ['reqA.v1', 'reqB.v2'], extends: 'F1' });
  assert.equal(L.state().judgmentCurrent.get('F3' as never), false);
  L.judge('F4', 'D2', 'pass', { review: 'feasibility', ...res.merged, extends: 'F1', superseded: [{ input: 'EB', by: 'EB2' }] });
  assert.equal(L.label('D2'), 'proven');
  L.add({ kind: 'evidence.revoked', evidence: 'EA' });
  assert.equal(L.label('D2'), 'not-fully-proven', 'the retained part\'s evidence still counts');
});

test('v32 continuation refusals: not current outside the changes, not deciding, replacement missing, invalid inherited input', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.basis('reqA', 'reqA.v1');
  L.basis('reqB', 'reqB.v1');
  L.evidence('EA');
  const contract = { review: 'calibrator-1', basisLines: ['reqA', 'reqB'] };
  L.object('M1', { objectKind: 'plan', reviews: [contract], paths: ['plans/pm.md'] });
  L.judge('C1', 'M1', 'pass', { review: 'calibrator-1', evidence: ['EA'], bases: ['reqA.v1', 'reqB.v1'] });
  L.basis('reqB', 'reqB.v2');
  assert.equal(L.continuation({ extends: 'C1', review: 'calibrator-1', changedLines: ['reqB'] }).ok, true);
  // reqA also changed but the batch does not cover it: J0 is not current outside the changes.
  L.basis('reqA', 'reqA.v2');
  assert.deepEqual(L.continuation({ extends: 'C1', review: 'calibrator-1', changedLines: ['reqB'] }), { ok: false, reason: 'not-current-outside-changes' });
  assert.equal(L.continuation({ extends: 'C1', review: 'calibrator-1', changedLines: ['reqA', 'reqB'] }).ok, true);
  // A superseded input needs its replacement in the draft.
  assert.deepEqual(
    L.continuation({ extends: 'C1', review: 'calibrator-1', changedLines: ['reqA', 'reqB'], superseded: [{ input: 'EA', by: 'EZ' }] }),
    { ok: false, reason: 'replacement-missing' },
  );
  // The retained evidence is revoked: J0 is not current, so the batch must be reviewed in full.
  L.add({ kind: 'evidence.revoked', evidence: 'EA' });
  assert.deepEqual(L.continuation({ extends: 'C1', review: 'calibrator-1', changedLines: ['reqA', 'reqB'] }), { ok: false, reason: 'not-current-outside-changes' });
  // A judgment that no longer decides its position cannot be continued.
  L.judge('C1x', 'M1', 'fail', { review: 'calibrator-1' });
  assert.deepEqual(L.continuation({ extends: 'C1', review: 'calibrator-1', changedLines: ['reqA', 'reqB'] }), { ok: false, reason: 'not-deciding-pass' });
  assert.deepEqual(L.continuation({ extends: 'C1', review: 'feasibility' }), { ok: false, reason: 'different-review' });
});

test('a proof unit is proven, negated or withdrawn as a whole; an operation on it is not all proven (5.3, core review r1 #13)', () => {
  const L = new Log();
  L.object('A', { prereqs: ['B'] });
  L.object('B', { prereqs: ['A'] });
  L.unit('U', ['A', 'B'], ['integration']);
  L.judge('JA', 'A', 'pass');
  L.judge('JB', 'B', 'pass');
  L.judge('JU', 'U', 'pass', { review: 'integration' });
  L.add({ kind: 'op.pending', op: 'DU', opKind: 'delivery', objects: ['U'], scope: { mission: 'm1' as never, capabilities: [] } });
  L.add({ kind: 'op.pending', op: 'DB', opKind: 'delivery', objects: ['B'], scope: { mission: 'm1' as never, capabilities: [] } });
  assert.equal(L.label('B'), 'proven');
  assert.equal(L.state().ops.get('DU' as never)?.allProven, true);
  L.judge('JA2', 'A', 'fail');
  const s = L.state();
  assert.equal(s.targets.get('A')?.label, 'negated');
  assert.equal(s.targets.get('U')?.label, 'negated', 'a member negated negates the unit');
  assert.equal(s.targets.get('B')?.label, 'negated', 'and every other member');
  assert.equal(s.ops.get('DU' as never)?.allProven, false);
  assert.equal(s.ops.get('DB' as never)?.allProven, false, 'selecting one member does not escape its unit');
});

test('renewal is honoured only when the 5.3 rule holds for the judgment\'s declared evidence use (core review r1 #10)', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.evidence('E1', 'py', 'py@1', { exit: '0', out: 'h' });
  L.object('P');
  L.judge('J', 'P', 'pass', { evidence: ['E1'], evidenceUse: { fields: ['exit', 'out'], statisticalOrExternal: false } });
  L.env('py', 'py@2');
  // A replacement whose used field differs does not renew.
  L.evidence('E2', 'py', 'py@2', { exit: '1', out: 'h' });
  L.add({ kind: 'evidence.renewal', judgment: 'J', original: 'E1', replacement: 'E2' });
  assert.equal(L.label('P'), 'not-fully-proven');
  // An open run does not renew.
  L.add({ kind: 'evidence', evidence: 'E3', envLine: 'py', envSnapshot: 'py@2', runClass: 'open', fields: { exit: '0', out: 'h' } });
  L.add({ kind: 'evidence.renewal', judgment: 'J', original: 'E1', replacement: 'E3' });
  assert.equal(L.label('P'), 'not-fully-proven');
  // A closed run with equal used fields renews (an unused field may differ).
  L.evidence('E4', 'py', 'py@2', { exit: '0', out: 'h', ms: '99' });
  L.add({ kind: 'evidence.renewal', judgment: 'J', original: 'E1', replacement: 'E4' });
  assert.equal(L.label('P'), 'proven');
});

test('a regression run counts only when closed, applicable, every registered test passed and the inputs unchanged (5.6, core review r1 #11)', () => {
  const build = (fields: Record<string, string>, runClass = 'closed'): string => {
    const L = provenProduct();
    L.add({ kind: 'evidence', evidence: 'R', envLine: 'py', envSnapshot: 'py@1', runClass, fields });
    L.add({ kind: 'issue.coverage', issue: 'N', version: 'P', evidence: 'R', command: 'pytest', tests: ['t1', 't2'], inputs: ['testfile:t/a.py=h1', 'runner:cfg=h2'] });
    return L.state().fixes.get(fixKey('N', 'P'))!;
  };
  const ok = { exit: '0', 'test:t1': 'passed', 'test:t2': 'passed', 'input:testfile:t/a.py': 'h1', 'input:runner:cfg': 'h2' };
  assert.equal(build(ok), 'fixed');
  assert.equal(build(ok, 'open'), 'unfixed');
  assert.equal(build({ ...ok, 'test:t2': 'skipped' }), 'unfixed');
  const { 'test:t2': _t2, ...missing } = ok;
  assert.equal(build(missing), 'unfixed');
  assert.equal(build({ ...ok, 'input:runner:cfg': 'other' }), 'unfixed');
});

test('basis withdrawn outranks unaccepted even when not every position has passed (5.3, core review r1 #21)', () => {
  const L = new Log();
  L.basis('auth', 'auth.v1', 'authorization');
  L.object('P', { reviews: ['reviewer', 'sec'] });
  L.judge('R', 'P', 'pass', { bases: ['auth.v1'] });
  assert.equal(L.label('P'), 'unaccepted');
  L.add({ kind: 'basis.withdrawn', line: 'auth' });
  assert.equal(L.label('P'), 'basis-withdrawn');
});

test('published states are immutable: values cannot be changed through a snapshot (core review r1 #9)', () => {
  const s = provenProduct().state();
  const p = s.targets.get('P')!;
  assert.throws(() => {
    (p as { label: string }).label = 'negated';
  }, TypeError);
  assert.equal(s.targets.get('P')?.label, 'proven');
});

// ---------------------------------------------------------------- core review r2: F4, F8, F9

test('F4: a continuation on an unrelated object is not current; one on the successor is', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.evidence('E1');
  L.object('X');
  L.judge('J0', 'X', 'pass', { evidence: ['E1'] });
  L.object('Y'); // unrelated: not X, and its predecessor is not X
  L.judge('K', 'Y', 'pass', { evidence: ['E1'], extends: 'J0' });
  assert.equal(L.state().judgmentCurrent.get('K' as never), false);
  assert.equal(L.label('Y'), 'not-fully-proven');
  assert.deepEqual(L.continuation({ extends: 'J0', target: 'Y', review: 'reviewer' }), { ok: false, reason: 'different-line' });
  // The successor of X may continue J0.
  L.object('X2', { predecessor: 'X' });
  assert.equal(L.continuation({ extends: 'J0', target: 'X2', review: 'reviewer' }).ok, true);
  L.judge('K2', 'X2', 'pass', { evidence: ['E1'], extends: 'J0' });
  assert.equal(L.state().judgmentCurrent.get('K2' as never), true);
  assert.equal(L.label('X2'), 'proven');
});

test('F4: a continuation of a pass that had been negated before it was recorded is not current', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.evidence('E1');
  L.object('X');
  L.judge('J0', 'X', 'pass', { evidence: ['E1'] });
  L.judge('J0n', 'X', 'fail', { evidence: ['E1'] }); // J0 no longer decides its position
  L.object('X2', { predecessor: 'X' });
  assert.deepEqual(L.continuation({ extends: 'J0', target: 'X2', review: 'reviewer' }), { ok: false, reason: 'not-deciding-pass' });
  L.judge('K', 'X2', 'pass', { evidence: ['E1'], extends: 'J0' });
  assert.equal(L.state().judgmentCurrent.get('K' as never), false);
  assert.equal(L.label('X2'), 'not-fully-proven');
  // The reviewer's combination: an unrelated object continuing a superseded pass on a negated target.
  L.object('Z');
  L.judge('KZ', 'Z', 'pass', { evidence: ['E1'], extends: 'J0' });
  assert.equal(L.state().judgmentCurrent.get('KZ' as never), false);
  assert.notEqual(L.label('Z'), 'proven');
});

test('F4: a later renewal or a later negation of J0 does not change an accepted continuation', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.evidence('E1');
  L.evidence('E2');
  L.object('M1');
  L.judge('J0', 'M1', 'pass', { evidence: ['E1'] });
  // J0 is current when the continuation is recorded; the seat re-ran the retained check (E2 replaces E1).
  L.object('M2', { predecessor: 'M1' });
  L.judge('K', 'M2', 'pass', { evidence: ['E2'], extends: 'J0', superseded: [{ input: 'E1', by: 'E2' }] });
  assert.equal(L.state().judgmentCurrent.get('K' as never), true);
  assert.equal(L.label('M2'), 'proven');
  // A later renewal of J0 (E1 -> E3): K's own evidence E2 still applies, K stays current.
  L.evidence('E3');
  L.add({ kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E3' });
  assert.equal(L.state().judgmentCurrent.get('K' as never), true);
  assert.equal(L.label('M2'), 'proven');
  // A later negation of J0: K was accepted when J0 decided its position; it stays current.
  L.judge('J0n', 'M1', 'fail', { evidence: ['E3'] });
  assert.equal(L.label('M1'), 'negated');
  assert.equal(L.state().judgmentCurrent.get('K' as never), true);
  // Revoking the input K superseded does not matter either.
  L.add({ kind: 'evidence.revoked', evidence: 'E1' });
  assert.equal(L.label('M2'), 'proven');
  // K's own conditions still count: revoking its own evidence degrades M2.
  L.add({ kind: 'evidence.revoked', evidence: 'E2' });
  assert.equal(L.label('M2'), 'not-fully-proven');
});

test('F4/r3 F1: a continuation recorded after an environment change made J0 not current is refused (the change is outside the batch)', () => {
  const L = new Log();
  L.env('py', 'py@1');
  L.evidence('E1');
  L.object('M1');
  L.judge('J0', 'M1', 'pass', { evidence: ['E1'] });
  L.env('py', 'py@2');
  L.evidence('E2', 'py', 'py@2');
  L.object('M2', { predecessor: 'M1' });
  assert.deepEqual(L.continuation({ extends: 'J0', target: 'M2', review: 'reviewer', draft: { evidence: ['E2'], bases: [], constraints: [], reliesOn: [] }, superseded: [{ input: 'E1', by: 'E2' }] }), { ok: false, reason: 'not-current-outside-changes' });
  L.judge('K', 'M2', 'pass', { evidence: ['E2'], extends: 'J0', superseded: [{ input: 'E1', by: 'E2' }] });
  assert.equal(L.state().judgmentCurrent.get('K' as never), false, 'the program check and the derivation agree');
  assert.equal(L.label('M2'), 'not-fully-proven');
  // A full (non-continuation) judgment restores it.
  L.judge('K2', 'M2', 'pass', { evidence: ['E2'] });
  assert.equal(L.label('M2'), 'proven');
});

test('F8: the validator rejects non-concrete object scope paths', async () => {
  const { validateRecord } = await import('../src/common/validate.ts');
  const h = '0'.repeat(64);
  const rec = (paths: string[]): Record<string, unknown> => ({
    kind: 'object.version', object: 'P', objectKind: 'product', mission: 'm1', module: null, content: h,
    prerequisites: { hash: h, count: 0 }, scope: { paths, taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
  });
  assert.doesNotThrow(() => validateRecord(rec(['src/p.ts', 'secret/file.ts'])));
  for (const bad of [['secret/**'], ['src/*.ts'], ['**'], ['/etc/passwd'], ['a/../b.ts'], ['a//b.ts'], ['./a.ts']]) {
    assert.throws(() => validateRecord(rec(bad)), /concrete/, JSON.stringify(bad));
  }
});

test('F8: the evaluator refuses coverage for a non-concrete object path, so a constraint cannot disappear behind a glob', () => {
  const build = (objectPath: string): Log => {
    const L = new Log();
    L.env('py', 'py@1');
    L.evidence('E1');
    L.basis('sec', 'sec.v1', 'constraint', { paths: ['secret/file.ts'], taskTypes: [] });
    L.object('P', { paths: [objectPath] });
    // The judgment checked the constraint against the object's (claimed) paths.
    L.judge('J', 'P', 'pass', { evidence: ['E1'], constraints: [{ version: 'sec.v1', paths: [objectPath] }] });
    return L;
  };
  assert.equal(build('secret/file.ts').label('P'), 'proven', 'a concrete path reviewed against the constraint is covered');
  assert.equal(build('secret/**').label('P'), 'not-fully-proven', 'a glob path never counts as covered (core review r2 F8)');
  // Even with no constraint at all, a non-concrete path is never fresh.
  const L = new Log();
  L.env('py', 'py@1');
  L.evidence('E1');
  L.object('Q', { paths: ['lib/*'] });
  L.judge('JQ', 'Q', 'pass', { evidence: ['E1'] });
  assert.equal(L.label('Q'), 'not-fully-proven');
});

test('F9: an incomplete regression registration never fixes an issue mechanically', () => {
  const ok = { exit: '0', 'test:t1': 'passed', 'input:testfile:t/a.py': 'h1', 'input:runner:cfg': 'h2' };
  const build = (reg: { command?: string; tests?: string[]; inputs?: string[] }, fields: Record<string, string> = ok): string => {
    const L = provenProduct();
    L.add({ kind: 'evidence', evidence: 'R', envLine: 'py', envSnapshot: 'py@1', runClass: 'closed', fields });
    L.add({
      kind: 'issue.coverage', issue: 'N', version: 'P', evidence: 'R',
      command: reg.command ?? 'pytest -q', tests: reg.tests ?? ['t1'], inputs: reg.inputs ?? ['testfile:t/a.py=h1', 'runner:cfg=h2'],
    });
    return L.state().fixes.get(fixKey('N', 'P'))!;
  };
  assert.equal(build({}), 'fixed', 'a complete registration');
  // The reviewer's case: tests registered, no inputs at all, the test passed.
  assert.equal(build({ inputs: [] }), 'unfixed', 'no test file or runner hashes');
  assert.equal(build({ command: '' }), 'unfixed', 'no command');
  assert.equal(build({ inputs: ['testfile:t/a.py=h1'] }), 'unfixed', 'no runner configuration');
  assert.equal(build({ inputs: ['runner:cfg=h2'] }), 'unfixed', 'no test file');
  assert.equal(build({ tests: [] }), 'unfixed', 'no tests');
  // Fields are read as own properties only: an inherited "passed" does not count.
  const inherited = Object.assign(Object.create({ 'test:t1': 'passed' }) as Record<string, string>, { exit: '0', 'input:testfile:t/a.py': 'h1', 'input:runner:cfg': 'h2' });
  assert.equal(build({}, inherited), 'unfixed', 'an inherited test result');
  const inheritedInput = Object.assign(Object.create({ 'input:runner:cfg': 'h2' }) as Record<string, string>, { exit: '0', 'test:t1': 'passed', 'input:testfile:t/a.py': 'h1' });
  assert.equal(build({}, inheritedInput), 'unfixed', 'an inherited input hash');
});
