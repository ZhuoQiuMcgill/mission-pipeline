// The incremental evaluator equals the full recomputation (5.4, 5.5): random
// record sequences, applied in random batches, compared after every batch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullCompute, type DerivedState, type ResolvedCommitted, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { IncrementalDerivation } from '../src/evaluator/incremental.ts';
import { SnapshotMap } from '../src/evaluator/snapshot.ts';
import { revision, type Revision } from '../src/common/ids.ts';
import { encodeConstraintCheck } from '../src/common/records.ts';

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plain(s: DerivedState): Record<string, unknown> {
  return {
    basis: new Map(s.basis),
    evidenceApplicable: new Map(s.evidenceApplicable),
    judgmentCurrent: new Map(s.judgmentCurrent),
    positionInEffect: new Map(s.positionInEffect),
    targets: new Map(s.targets),
    fixes: new Map(s.fixes),
    ops: new Map(s.ops),
  };
}

/** A random but well-formed record stream over small id spaces, so that ids collide, cycle and refer forward. */
export function randomRecords(seed: number, count: number): ResolvedRecord[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const some = <T>(xs: readonly T[], p = 0.3): T[] => xs.filter(() => r() < p);
  const out: ResolvedRecord[] = [];
  const add = (x: Record<string, unknown>): void => void out.push(x as unknown as ResolvedRecord);

  const envLines = ['py', 'node'];
  const basisLines: Record<string, string> = { req1: 'requirement', req2: 'requirement', std: 'standard', auth: 'authorization', reqset: 'requirement-set' };
  const constraintLines = ['c1', 'c2'];
  const paths = ['src/a.ts', 'src/b.ts', 'lib/c.ts', 'plans/pm.md'];
  const scopes = [
    { paths: ['src/**'], taskTypes: [] },
    { paths: ['lib/**'], taskTypes: [] },
    { paths: ['**'], taskTypes: ['construct'] },
    { paths: ['plans/pm.md'], taskTypes: [] },
  ];
  const objectIds = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7'];
  const unitIds = ['U1', 'U2'];
  const reviewKinds = ['reviewer', 'sec', 'cal'];
  const issues = ['N1', 'N2'];

  const versions: Record<string, string[]> = {};
  const envSeq: Record<string, number> = { py: 1, node: 1 };
  const evidence: string[] = [];
  const objects: string[] = [];
  const units: string[] = [];
  const judgments: string[] = [];
  const ops: string[] = [];
  let n = 0;
  const newVersion = (line: string): string => {
    const list = (versions[line] ??= []);
    const v = `${line}.v${list.length + 1}`;
    list.push(v);
    return v;
  };
  const allVersions = (): string[] => [...Object.values(versions).flat(), 'ghost.v1'];
  const targets = (): string[] => [...objectIds, ...unitIds, 'GHOST'];

  for (const l of envLines) add({ kind: 'env.snapshot', line: l, snapshot: `${l}@1` });
  while (out.length < count) {
    n++;
    const k = r();
    if (k < 0.08) {
      const line = pick(Object.keys(basisLines));
      add({ kind: 'basis.version', basisKind: basisLines[line], line, version: newVersion(line), mission: 'm1', scope: null });
    } else if (k < 0.13) {
      const line = pick(constraintLines);
      add({ kind: 'basis.version', basisKind: 'constraint', line, version: newVersion(line), mission: 'm1', scope: r() < 0.6 ? pick(scopes) : null });
    } else if (k < 0.16) {
      add({ kind: 'constraint.scope', line: pick(constraintLines), scope: pick(scopes) });
    } else if (k < 0.18) {
      add({ kind: 'basis.withdrawn', line: pick([...Object.keys(basisLines), ...constraintLines]) });
    } else if (k < 0.22) {
      const l = pick(envLines);
      add({ kind: 'env.snapshot', line: l, snapshot: `${l}@${++envSeq[l]!}` });
    } else if (k < 0.32) {
      const l = pick(envLines);
      const id = `E${n}`;
      evidence.push(id);
      const snap = r() < 0.8 ? envSeq[l]! : Math.max(1, envSeq[l]! - 1);
      add({ kind: 'evidence', evidence: id, envLine: l, envSnapshot: `${l}@${snap}`, runClass: pick(['closed', 'closed', 'open']), fields: { exit: '0', 'test:t1': pick(['passed', 'passed', 'failed']), 'input:testfile:t.py': 'h1', 'input:runner:cfg': 'h1' } });
    } else if (k < 0.34 && evidence.length > 0) {
      add({ kind: 'evidence.revoked', evidence: pick(evidence) });
    } else if (k < 0.37 && judgments.length > 0 && evidence.length > 0) {
      add({ kind: 'evidence.renewal', judgment: pick(judgments), original: pick(evidence), replacement: pick(evidence) });
    } else if (k < 0.47) {
      const free = objectIds.filter((o) => !objects.includes(o));
      if (free.length === 0) continue;
      const id = pick(free);
      objects.push(id);
      const reviews = some(reviewKinds, 0.5);
      if (reviews.length === 0) reviews.push('reviewer');
      add({
        kind: 'object.version',
        object: id,
        objectKind: 'product',
        mission: 'm1',
        module: null,
        content: '0'.repeat(64),
        prerequisites: some(objectIds.filter((o) => o !== id), 0.15),
        scope: { paths: some(paths, 0.4).length ? some(paths, 0.4) : [pick(paths)], taskType: pick(['construct', 'plan']) },
        reviews: reviews.map((rv) => ({
          review: rv,
          basisLines: some(['req1', 'req2', 'std', 'reqset'], 0.15),
          reliesOn: some(targets().filter((t) => t !== id), 0.08),
        })),
      });
    } else if (k < 0.5) {
      const free = unitIds.filter((u) => !units.includes(u));
      if (free.length === 0) continue;
      const id = pick(free);
      units.push(id);
      add({ kind: 'proof.unit', unit: id, members: some(objectIds, 0.35), reviews: [{ review: 'integration', basisLines: [], reliesOn: [] }] });
    } else if (k < 0.78) {
      const id = `J${n}`;
      const target = r() < 0.85 ? pick(targets()) : pick(unitIds);
      const review = target.startsWith('U') && r() < 0.8 ? 'integration' : pick(reviewKinds);
      const prior = judgments.length > 0 && r() < 0.3 ? pick(judgments) : null;
      const cont = judgments.length > 0 && r() < 0.25 ? pick(judgments) : null;
      judgments.push(id);
      const vs = allVersions();
      add({
        kind: 'judgment',
        judgment: id,
        review,
        executor: r() < 0.15 ? 'auditor' : review,
        target,
        verdict: r() < 0.7 ? 'pass' : r() < 0.6 ? 'fail' : 'undecided',
        evidence: some(evidence, 0.2),
        bases: r() < 0.5 ? vs.filter((v) => r() < 0.6 && !v.startsWith('c')) : some(vs, 0.3),
        constraints: some(vs.filter((v) => v.startsWith('c')), 0.6).map((v) => encodeConstraintCheck({ version: v, paths: some(paths, 0.6) })),
        reliesOn: some(targets().filter((t) => t !== target), 0.1),
        issues: some(issues, 0.3).map((i) => ({ issue: i, response: pick(['fixed', 'fixed', 'not-fixed', 'deferred']) })),
        revokes: prior,
        // Continuations of an earlier judgment, carrying or dropping its inputs (v32 5.2 part 5).
        extends: cont,
        evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
        superseded: cont !== null && evidence.length > 1 && r() < 0.4 ? [{ input: pick(evidence), by: pick(evidence) }].filter((x) => x.input !== x.by) : [],
      });
    } else if (k < 0.82) {
      add({ kind: 'issue.coverage', issue: pick(issues), version: pick([...objectIds, 'GHOST']), evidence: evidence.length ? pick(evidence) : 'E-none', command: 'pytest', tests: ['t1'], inputs: r() < 0.5 ? ['testfile:t.py=h1', 'runner:cfg=h1'] : ['testfile:t.py=h2', 'runner:cfg=h1'] });
    } else if (k < 0.86) {
      const id = `D${n}`;
      ops.push(id);
      add({ kind: 'op.pending', op: id, opKind: pick(['delivery', 'legalization', 'stable-dispatch']), objects: some([...objectIds, ...unitIds], 0.3) });
    } else if (k < 0.89 && ops.length > 0) {
      add({ kind: 'op.executed', op: pick(ops), asOf: revision(Math.max(1, out.length - 2)) });
    } else if (k < 0.9) {
      add({ kind: 'issue', issue: pick(issues), module: null, observedOn: [] });
    }
  }
  return out;
}

/**
 * A realistic stream: most judgments are well formed (applicable evidence,
 * current bases covering the contract, current constraint versions, contract
 * objects relied on, negations revoked by name), so many targets are proven,
 * and then the world moves: environments, basis revisions, constraints and
 * scopes, revocations, renewals, withdrawals, units over prerequisite cycles,
 * issue responses and regression runs, operations.
 */
export function realisticRecords(seed: number, count: number): ResolvedRecord[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const some = <T>(xs: readonly T[], p: number): T[] => xs.filter(() => r() < p);
  const out: ResolvedRecord[] = [];
  const add = (x: Record<string, unknown>): void => void out.push(x as unknown as ResolvedRecord);

  const kinds: Record<string, string> = { req1: 'requirement', req2: 'requirement', std: 'standard', auth: 'authorization', reqset: 'requirement-set' };
  const latest: Record<string, string> = {};
  const vcount: Record<string, number> = {};
  const withdrawn = new Set<string>();
  const constraint: Record<string, { latest: string; scope: { paths: string[]; taskTypes: string[] } | null }> = {};
  const env: Record<string, number> = { py: 1, node: 1 };
  const ev: { id: string; line: string; snap: number; revoked: boolean }[] = [];
  type Obj = { id: string; scope: { paths: string[]; taskType: string }; reviews: { review: string; basisLines: string[]; reliesOn: string[] }[] };
  const objs: Obj[] = [];
  const units: { id: string; members: string[] }[] = [];
  const lastFail = new Map<string, string>();
  const judged: { id: string; evidence: string[] }[] = [];
  const pending: string[] = [];
  let n = 0;
  const scopes = [
    { paths: ['src/**'], taskTypes: [] },
    { paths: ['lib/**'], taskTypes: [] },
    { paths: ['plans/**'], taskTypes: ['plan'] },
    { paths: ['**'], taskTypes: [] },
  ];
  const paths = ['src/a.ts', 'src/b.ts', 'lib/c.ts', 'plans/pm.md'];

  const version = (line: string, basisKind: string, scope: unknown = null): void => {
    vcount[line] = (vcount[line] ?? 0) + 1;
    const v = `${line}.v${vcount[line]}`;
    latest[line] = v;
    if (basisKind === 'constraint') constraint[line] = { latest: v, scope: (scope as never) ?? constraint[line]?.scope ?? null };
    add({ kind: 'basis.version', basisKind, line, version: v, mission: 'm1', scope });
  };
  const freshEvidence = (line = pick(['py', 'node'])): string => {
    const id = `E${++n}`;
    ev.push({ id, line, snap: env[line]!, revoked: false });
    add({ kind: 'evidence', evidence: id, envLine: line, envSnapshot: `${line}@${env[line]}`, runClass: 'closed', fields: { exit: '0', 'test:t1': r() < 0.9 ? 'passed' : 'skipped', 'input:testfile:t.py': 'h1', 'input:runner:cfg': 'h1' } });
    return id;
  };
  const applies = (sc: { paths: string[]; taskTypes: string[] }, o: Obj): boolean =>
    (sc.taskTypes.length === 0 || sc.taskTypes.includes(o.scope.taskType)) &&
    sc.paths.some((pat) => o.scope.paths.some((p) => pat === '**' || (pat.endsWith('/**') ? p.startsWith(pat.slice(0, -2)) : pat === p)));
  const newObject = (id: string, prereqs: string[]): Obj => {
    const reviews = (r() < 0.3 ? ['reviewer', 'sec'] : ['reviewer']).map((rv) => ({
      review: rv,
      basisLines: some(['req1', 'req2', 'reqset'], 0.4).filter((l) => !withdrawn.has(l)),
      reliesOn: some(objs.map((o) => o.id), 0.12).slice(0, 2),
    }));
    const own = some(paths, 0.35);
    const o: Obj = { id, scope: { paths: own.length > 0 ? own : [pick(paths)], taskType: r() < 0.8 ? 'construct' : 'plan' }, reviews };
    add({ kind: 'object.version', object: id, objectKind: 'product', mission: 'm1', module: null, content: '0'.repeat(64), prerequisites: prereqs, scope: o.scope, reviews });
    objs.push(o);
    return o;
  };
  const judge = (target: string, review: string, contract: { basisLines: string[]; reliesOn: string[] } | null, o: Obj[] | null): void => {
    const id = `J${++n}`;
    const roll = r();
    const verdict = roll < 0.85 ? 'pass' : roll < 0.95 ? 'fail' : 'undecided';
    const pos = `${target}|${review}`;
    const good = r() < 0.9;
    const usable = ev.filter((e) => !e.revoked && e.snap === env[e.line]);
    const evidence = good ? [usable.length > 0 && r() < 0.5 ? pick(usable).id : freshEvidence()] : [pick(ev.length ? ev : [{ id: freshEvidence() } as never]).id];
    const lines = new Set<string>(['std', ...(contract?.basisLines ?? [])]);
    const bases = [...lines].filter((l) => latest[l] && (good || r() < 0.7)).map((l) => latest[l]!);
    const checked = Object.entries(constraint)
      .filter(([, c]) => c.scope && (o ?? []).some((x) => applies(c.scope!, x)))
      .filter(() => good || r() < 0.5)
      .map(([, c]) => {
        const all = (o ?? []).flatMap((x) => x.scope.paths);
        // Usually the whole object; sometimes only part of it, leaving gaps for later judgments to fill.
        const reviewed = r() < 0.8 ? all : all.filter(() => r() < 0.5);
        return encodeConstraintCheck({ version: c.latest, paths: reviewed });
      });
    const reliesOn = [...(contract?.reliesOn ?? []), ...(r() < 0.1 && objs.length ? [pick(objs).id] : [])].filter((x) => x !== target);
    const revokes = verdict === 'pass' && lastFail.has(pos) && r() < 0.9 ? lastFail.get(pos)! : null;
    const responses = r() < 0.2 ? [{ issue: pick(['N1', 'N2']), response: pick(['fixed', 'fixed', 'fixed', 'not-fixed', 'deferred']) }] : [];
    add({
      kind: 'judgment', judgment: id, review, executor: r() < 0.08 ? 'auditor' : review, target, verdict,
      evidence, bases, constraints: checked, reliesOn: [...new Set(reliesOn)], issues: responses, revokes, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
    });
    if (verdict === 'fail') lastFail.set(pos, id);
    else if (revokes) lastFail.delete(pos);
    judged.push({ id, evidence });
  };

  for (const l of Object.keys(kinds)) version(l, kinds[l]!);
  for (const l of ['py', 'node']) add({ kind: 'env.snapshot', line: l, snapshot: `${l}@1` });
  while (out.length < count) {
    const k = r();
    if (k < 0.16 && objs.length < 12) {
      const prereqs = some(objs.map((o) => o.id), 0.2).slice(0, 3);
      const o = newObject(`O${++n}`, prereqs);
      for (const c of o.reviews) judge(o.id, c.review, c, [o]);
    } else if (k < 0.2 && objs.length < 11) {
      // A prerequisite cycle closed by a proof unit.
      const a = `O${++n}`;
      const b = `O${++n}`;
      const oa = newObject(a, [b]);
      const ob = newObject(b, [a]);
      for (const c of oa.reviews) judge(a, c.review, c, [oa]);
      for (const c of ob.reviews) judge(b, c.review, c, [ob]);
      if (r() < 0.85) {
        const u = `U${++n}`;
        units.push({ id: u, members: [a, b] });
        add({ kind: 'proof.unit', unit: u, members: [a, b], reviews: [{ review: 'integration', basisLines: [], reliesOn: [] }] });
        judge(u, 'integration', { basisLines: [], reliesOn: [] }, [oa, ob]);
      }
    } else if (k < 0.45 && objs.length > 0) {
      const o = pick(objs);
      const c = pick(o.reviews);
      judge(o.id, c.review, c, [o]);
    } else if (k < 0.5 && units.length > 0) {
      const u = pick(units);
      judge(u.id, 'integration', { basisLines: [], reliesOn: [] }, objs.filter((o) => u.members.includes(o.id)));
    } else if (k < 0.56) {
      const l = pick(['py', 'node']);
      env[l]!++;
      add({ kind: 'env.snapshot', line: l, snapshot: `${l}@${env[l]}` });
      for (const j of judged) {
        if (r() < 0.5) continue;
        for (const e of j.evidence) {
          const rec = ev.find((x) => x.id === e);
          if (rec && rec.line === l && r() < 0.7) {
            const repl = freshEvidence(l);
            add({ kind: 'evidence.renewal', judgment: j.id, original: e, replacement: repl });
          }
        }
      }
    } else if (k < 0.62) {
      const l = pick(Object.keys(kinds));
      if (!withdrawn.has(l)) version(l, kinds[l]!);
    } else if (k < 0.66) {
      const l = pick(['c1', 'c2', 'c3']);
      version(l, 'constraint', r() < 0.5 || !constraint[l] ? pick(scopes) : null);
    } else if (k < 0.69 && Object.keys(constraint).length > 0) {
      const l = pick(Object.keys(constraint));
      const sc = pick(scopes);
      constraint[l]!.scope = sc;
      add({ kind: 'constraint.scope', line: l, scope: sc });
    } else if (k < 0.71 && ev.length > 0) {
      const e = pick(ev);
      e.revoked = true;
      add({ kind: 'evidence.revoked', evidence: e.id });
    } else if (k < 0.72) {
      const l = pick(['req1', 'req2', 'c1', 'c2', 'c3']);
      withdrawn.add(l);
      add({ kind: 'basis.withdrawn', line: l });
    } else if (k < 0.77 && objs.length > 0) {
      add({ kind: 'issue.coverage', issue: pick(['N1', 'N2']), version: pick(objs).id, evidence: r() < 0.8 ? freshEvidence() : pick(ev).id, command: 'pytest', tests: ['t1'], inputs: ['testfile:t.py=h1', 'runner:cfg=h1'] });
    } else if (k < 0.82 && objs.length > 0) {
      const op = `D${++n}`;
      pending.push(op);
      const listed = some([...objs.map((o) => o.id), ...units.map((u) => u.id)], 0.3);
      add({ kind: 'op.pending', op, opKind: pick(['delivery', 'legalization', 'stable-dispatch']), objects: listed.length ? listed : [pick(objs).id] });
    } else if (k < 0.86 && pending.length > 0) {
      add({ kind: 'op.executed', op: pick(pending), asOf: revision(out.length) });
    }
  }
  return out.slice(0, count);
}

function check(seed: number, count: number, maxBatch: number, gen = randomRecords): void {
  const records = gen(seed, count).map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record }));
  const r = rng(seed ^ 0x5bd1e995);
  const inc = new IncrementalDerivation();
  let i = 0;
  while (i < records.length) {
    const size = 1 + Math.floor(r() * maxBatch);
    const batch = records.slice(i, i + size);
    i += batch.length;
    const at: Revision = batch[batch.length - 1]!.revision;
    const got = inc.apply(batch, at).state;
    const want = fullCompute(records, at);
    try {
      assert.deepEqual(plain(got), plain(want));
    } catch (e) {
      throw new Error(`seed ${seed}: mismatch at revision ${at}\n${(e as Error).message.slice(0, 4000)}`);
    }
  }
}

test('incremental equals full recomputation: 300 random streams, one record per update', () => {
  for (let seed = 1; seed <= 300; seed++) check(seed, 80, 1);
});

test('incremental equals full recomputation: 300 random streams, random batch sizes', () => {
  for (let seed = 1001; seed <= 1300; seed++) check(seed, 120, 12);
});

test('incremental equals full recomputation: 300 realistic streams, one record per update', () => {
  for (let seed = 2001; seed <= 2300; seed++) check(seed, 150, 1, realisticRecords);
});

test('incremental equals full recomputation: 300 realistic streams, random batch sizes', () => {
  for (let seed = 3001; seed <= 3300; seed++) check(seed, 200, 15, realisticRecords);
});

test('snapshot maps: random changes match a plain map, and an older snapshot never changes', () => {
  const r = rng(7);
  let snap = SnapshotMap.empty<number, number>();
  const model = new Map<number, number>();
  const history: { snap: SnapshotMap<number, number>; copy: Map<number, number> }[] = [];
  for (let step = 0; step < 2000; step++) {
    const changes = new Map<number, number | undefined>();
    const n = 1 + Math.floor(r() * (step % 50 === 0 ? 400 : 5));
    for (let k = 0; k < n; k++) {
      const key = Math.floor(r() * 500);
      if (r() < 0.25) changes.set(key, undefined);
      else changes.set(key, Math.floor(r() * 1e6));
    }
    snap = snap.with(changes);
    for (const [k, v] of changes) {
      if (v === undefined) model.delete(k);
      else model.set(k, v);
    }
    if (step % 97 === 0) history.push({ snap, copy: new Map(model) });
    assert.equal(snap.size, model.size);
  }
  assert.deepEqual(new Map(snap), model);
  for (const h of history) assert.deepEqual(new Map(h.snap), h.copy);
  assert.ok(snap.depth() <= 2 * Math.ceil(Math.log2(model.size + 2)) + 2, `depth ${snap.depth()}`);
});

/** Apply one record per update and compare with the full recomputation after each. */
function checkSequence(name: string, recs: Record<string, unknown>[]): void {
  const rc = recs.map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record: record as unknown as ResolvedRecord }));
  const inc = new IncrementalDerivation();
  for (let i = 0; i < rc.length; i++) {
    const at = revision(i + 1);
    const got = inc.apply([rc[i]!], at).state;
    assert.deepEqual(plain(got), plain(fullCompute(rc, at)), `${name}: revision ${at}`);
  }
}

const obj = (o: string, prereqs: string[] = []): Record<string, unknown> => ({
  kind: 'object.version', object: o, objectKind: 'product', mission: 'm1', module: null, content: '0'.repeat(64), prerequisites: prereqs,
  scope: { paths: [`src/${o}.ts`], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
});
const jdg = (j: string, target: string, evidence: string[], more: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'judgment', judgment: j, review: 'reviewer', executor: 'reviewer', target, verdict: 'pass', evidence, bases: [], constraints: [], reliesOn: [],
  issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [], ...more,
});
const evid = (e: string, snap = 'py@1'): Record<string, unknown> => ({ kind: 'evidence', evidence: e, envLine: 'py', envSnapshot: snap, runClass: 'closed', fields: { exit: '0' } });

test('continuations: a continuation recorded before the judgment it continues is re-checked when that judgment arrives', () => {
  checkSequence('late J0', [
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@1' },
    evid('E1'),
    obj('P'),
    obj('Q'),
    jdg('K', 'Q', ['E1'], { extends: 'J0' }),
    jdg('J0', 'Q', ['E1']),
  ]);
});

test('continuations: a renewal of the continued judgment recorded after the continuation is re-checked, and incremental equals full', () => {
  checkSequence('renewal of J0', [
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@1' },
    evid('E1'),
    obj('Q'),
    jdg('J0', 'Q', ['E1']),
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@2' },
    evid('E2', 'py@2'),
    jdg('K', 'Q', ['E2'], { extends: 'J0' }),
    { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E2' },
  ]);
});

test('snapshot maps cannot be changed at run time: no size write, no reachable layers, frozen instances (core review r2 F6)', () => {
  const a = SnapshotMap.empty<string, { v: number }>().with(new Map([['x', Object.freeze({ v: 1 })]]));
  const b = a.with(new Map([['y', Object.freeze({ v: 2 })]]));
  assert.throws(() => {
    (a as unknown as { size: number }).size = 99;
  }, TypeError);
  assert.equal(Object.isFrozen(a), true);
  assert.deepEqual(Object.keys(a), [], 'no enumerable state to reach');
  assert.equal((a as unknown as Record<string, unknown>).layers, undefined);
  assert.throws(() => {
    (a as unknown as Record<string, unknown>).layers = [];
  }, TypeError);
  assert.deepEqual([...a.keys()], ['x']);
  assert.deepEqual([...b.keys()].sort(), ['x', 'y']);
});

// ---------------------------------------------------------------- core review r2: F3, F4, F19

test('F3: ids containing "@" and "|" never collide in fix keys or review positions; incremental equals full', async () => {
  const { fixKey, reviewPosition } = await import('../src/common/records.ts');
  // The old encodings joined with a separator: ("N@P", "Q") and ("N", "P@Q") both gave "N@P@Q".
  assert.notEqual(fixKey('N@P', 'Q'), fixKey('N', 'P@Q'));
  assert.notEqual(reviewPosition('A|r', 'x'), reviewPosition('A', 'r|x'));
  const fields = { exit: '0', 'test:t1': 'passed', 'input:testfile:t.py': 'h1', 'input:runner:cfg': 'h1' };
  const cov = (issue: string, version: string): Record<string, unknown> => ({
    kind: 'issue.coverage', issue, version, evidence: 'E1', command: 'pytest', tests: ['t1'], inputs: ['testfile:t.py=h1', 'runner:cfg=h1'],
  });
  const rec: Record<string, unknown>[] = [
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@1' },
    { kind: 'evidence', evidence: 'E1', envLine: 'py', envSnapshot: 'py@1', runClass: 'closed', fields },
    obj('Q'),
    obj('P@Q'),
    jdg('JQ', 'Q', ['E1']),
    jdg('JPQ', 'P@Q', ['E1']),
    cov('N@P', 'Q'),
    cov('N', 'P@Q'),
    // Only Q changes: its issue reopens, the other version's does not.
    jdg('JQ2', 'Q', ['E1'], { verdict: 'fail' }),
    // Review positions whose old encodings collide: (A|r, x) and (A, r|x).
    { ...obj('A|r'), reviews: [{ review: 'x', basisLines: [], reliesOn: [] }] },
    { ...obj('A'), reviews: [{ review: 'r|x', basisLines: [], reliesOn: [] }] },
    jdg('JA1', 'A|r', ['E1'], { review: 'x', executor: 'x' }),
    jdg('JA2', 'A', ['E1'], { review: 'r|x', executor: 'r|x', verdict: 'fail' }),
  ];
  checkSequence('F3 collisions', rec);
  const rc = rec.map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record: record as unknown as ResolvedRecord }));
  const s = fullCompute(rc, revision(rc.length));
  assert.equal(s.fixes.get(fixKey('N@P', 'Q')), 'unfixed');
  assert.equal(s.fixes.get(fixKey('N', 'P@Q')), 'fixed');
  assert.equal(s.positionInEffect.get(reviewPosition('A|r', 'x')), true);
  assert.equal(s.positionInEffect.get(reviewPosition('A', 'r|x')), false);
});

test('F4: an accepted continuation is judged by the records of its own time; later renewals and negations of J0 do not change it (incremental equals full)', () => {
  const recs: Record<string, unknown>[] = [
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@1' },
    evid('E1'),
    evid('E2'),
    obj('M1'),
    jdg('J0', 'M1', ['E1']),
    { ...obj('M2'), predecessor: 'M1' },
    jdg('K', 'M2', ['E2'], { extends: 'J0', superseded: [{ input: 'E1', by: 'E2' }] }),
    obj('Y'),
    jdg('KY', 'Y', ['E2'], { extends: 'J0', superseded: [{ input: 'E1', by: 'E2' }] }), // unrelated object
    evid('E3'),
    { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E3' },
    jdg('J0n', 'M1', ['E3'], { verdict: 'fail' }),
    { ...obj('M3'), predecessor: 'M1' },
    jdg('K3', 'M3', ['E3'], { extends: 'J0' }), // J0 no longer decides its position
    { kind: 'evidence.revoked', evidence: 'E1' },
  ];
  checkSequence('F4 continuation time', recs);
  const rc = recs.map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record: record as unknown as ResolvedRecord }));
  const s = fullCompute(rc, revision(rc.length));
  assert.equal(s.judgmentCurrent.get('K' as never), true);
  assert.equal(s.targets.get('M2')?.label, 'proven');
  assert.equal(s.judgmentCurrent.get('KY' as never), false);
  assert.equal(s.judgmentCurrent.get('K3' as never), false);
});

/** A cycle: A's judgment relies on B, B's judgment relies on A. */
function cycleRecords(): Record<string, unknown>[] {
  return [
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@1' },
    evid('E1'),
    obj('A'),
    obj('B'),
    obj('C'),
    jdg('JC', 'C', ['E1']),
    jdg('JA', 'A', ['E1'], { reliesOn: ['B'] }),
    jdg('JB', 'B', ['E1'], { reliesOn: ['A'] }), // closes the cycle
  ];
}

test('F19: a judgment closing a dependency cycle reports exactly one new cycle, naming its judgments and targets; unchanged updates report none', () => {
  const rc = cycleRecords().map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record: record as unknown as ResolvedRecord }));
  const inc = new IncrementalDerivation();
  const found: Array<{ at: number; nodes: readonly string[] }> = [];
  for (let i = 0; i < rc.length; i++) {
    const rep = inc.apply([rc[i]!], rc[i]!.revision);
    for (const c of rep.newCycles) found.push({ at: i + 1, nodes: c.nodes });
  }
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0]!.at, rc.length, 'reported by the judgment that closes it');
  const nodes = found[0]!.nodes;
  assert.ok(nodes.includes('j:JA') && nodes.includes('j:JB'), JSON.stringify(nodes));
  assert.ok(nodes.includes('p:A') && nodes.includes('p:B'));
  assert.ok(!nodes.some((n) => n.endsWith(':C') || n === 'j:JC'), 'nodes off the cycle are not part of it');
  const id = inc.cycles()[0]!.id;
  // Later updates: unrelated ones, and environment changes that re-evaluate the cycle itself; no new cycle.
  const more: Record<string, unknown>[] = [
    obj('D'),
    jdg('JD', 'D', ['E1']),
    evid('E2'),
    { kind: 'evidence.revoked', evidence: 'E2' },
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@2' },
    { kind: 'env.snapshot', line: 'py', snapshot: 'py@1' },
  ];
  let rev = rc.length;
  for (const r of more) {
    rev++;
    const rep = inc.apply([{ revision: revision(rev), record: r as unknown as ResolvedRecord }], revision(rev));
    assert.deepEqual(rep.newCycles, [], `no new cycle at ${rev}`);
  }
  assert.deepEqual(inc.cycles().map((c) => c.id), [id], 'the cycle is still known by the same id');
  // A rebuild over the same records finds the same cycle (the id does not depend on evaluation order).
  const all = [...rc, ...more.map((r, i): ResolvedCommitted => ({ revision: revision(rc.length + i + 1), record: r as unknown as ResolvedRecord }))];
  const rebuilt = new IncrementalDerivation().apply(all, revision(all.length));
  assert.deepEqual(rebuilt.newCycles.map((c) => c.id), [id]);
  // Breaking the cycle (B re-judged without relying on A) removes it; closing it again reports it again.
  const brk = new IncrementalDerivation();
  brk.apply(all, revision(all.length));
  brk.apply([{ revision: revision(all.length + 1), record: jdg('JB2', 'B', ['E1']) as unknown as ResolvedRecord }], revision(all.length + 1));
  assert.deepEqual(brk.cycles(), []);
  const again = brk.apply([{ revision: revision(all.length + 2), record: jdg('JB3', 'B', ['E1'], { reliesOn: ['A'] }) as unknown as ResolvedRecord }], revision(all.length + 2));
  assert.equal(again.newCycles.length, 1);
  // A new deciding judgment that keeps relying on the other side closes a different cycle (other nodes): one new report.
  const swap = brk.apply([{ revision: revision(all.length + 3), record: jdg('JA2', 'A', ['E1'], { reliesOn: ['B'] }) as unknown as ResolvedRecord }], revision(all.length + 3));
  assert.equal(swap.newCycles.length, 1);
  assert.ok(swap.newCycles[0]!.nodes.includes('j:JA2') && !swap.newCycles[0]!.nodes.includes('j:JA'));
  assert.equal(brk.cycles().length, 1, 'the replaced cycle is gone');
});

test('F19: a prerequisite cycle without a proof unit is a cycle too; random streams agree with a full recomputation of cycles', () => {
  const inc = new IncrementalDerivation();
  const rc = [obj('U1', ['U2']), obj('U2', ['U1'])].map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record: record as unknown as ResolvedRecord }));
  assert.deepEqual(inc.apply([rc[0]!], revision(1)).newCycles, []);
  const rep = inc.apply([rc[1]!], revision(2));
  assert.equal(rep.newCycles.length, 1);
  assert.deepEqual([...rep.newCycles[0]!.nodes], ['f:U1', 'f:U2', 'p:U1', 'p:U2']);
  // Over random streams, the cycles the incremental evaluator keeps equal those of a rebuild at every step.
  for (let seed = 1; seed <= 60; seed++) {
    const recs = randomRecords(seed, 80).map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record }));
    const live = new IncrementalDerivation();
    for (let i = 0; i < recs.length; i++) {
      live.apply([recs[i]!], recs[i]!.revision);
      if (i % 10 !== 9 && i !== recs.length - 1) continue;
      const fresh = new IncrementalDerivation();
      fresh.apply(recs.slice(0, i + 1), recs[i]!.revision);
      assert.deepEqual(live.cycles().map((c) => c.id).sort(), fresh.cycles().map((c) => c.id).sort(), `seed ${seed} at ${i + 1}`);
    }
  }
});
