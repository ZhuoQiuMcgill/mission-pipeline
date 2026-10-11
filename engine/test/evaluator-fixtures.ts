// Record streams for the label tests: random and realistic sequences of base
// records (resolved form: lists as arrays), shared by the in-memory incremental
// tests and the stored-label tests (5.4, 5.5; 4.1 §4.1).

import { revision } from '../src/common/ids.ts';
import { encodeConstraintCheck } from '../src/common/records.ts';
import type { ResolvedRecord } from '../src/evaluator/semantics.ts';

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
      add({ kind: 'evidence', evidence: id, envLine: l, envSnapshot: `${l}@${snap}`, runClass: pick(['declared', 'declared', 'other']), fields: { exit: '0', 'test:t1': pick(['passed', 'passed', 'failed']), 'input:testfile:t.py': 'h1', 'input:runner:cfg': 'h1' } });
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
    add({ kind: 'evidence', evidence: id, envLine: line, envSnapshot: `${line}@${env[line]}`, runClass: 'declared', fields: { exit: '0', 'test:t1': r() < 0.9 ? 'passed' : 'skipped', 'input:testfile:t.py': 'h1', 'input:runner:cfg': 'h1' } });
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
