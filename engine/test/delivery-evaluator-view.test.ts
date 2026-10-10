// The DeliveryProofView adapter against the real system (design 6.1; 6.6 steps 1-4;
// 5.2-5.3): a real ledger service and a real evaluator process (EvaluatorSupervisor),
// with the delivery manifest and the proof check computed through the adapter.
// A scripted evaluator (the evaluator's own full computation at chosen revisions)
// drives the revision races and the inconsistency checks deterministically.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256 } from '../src/common/hash.ts';
import { id, revision, type GitOid, type OpId } from '../src/common/ids.ts';
import { EVALUATOR_INPUT_KINDS, type BaseRecord } from '../src/common/records.ts';
import { RpcClient, RpcError, RpcUnavailable } from '../src/common/rpc.ts';
import { buildCandidate, checkCandidateProofs } from '../src/delivery/candidate.ts';
import { deliver, type DeliveryRequest } from '../src/delivery/deliver.ts';
import {
  openEvaluatorDeliveryView,
  ViewInconsistent,
  ViewNotReady,
  ViewRevisionUnstable,
  type EvaluatorQueryPort,
  type EvaluatorViewOptions,
} from '../src/delivery/evaluatorView.ts';
import { deliveryRefDomain, LedgerDeliveryAuthority } from '../src/delivery/ledgerAuthority.ts';
import { buildManifest, type DeliveryManifest } from '../src/delivery/manifest.ts';
import type { DeliveryProofView } from '../src/delivery/proofView.ts';
import { inWriteScope, writeScopeDocument, writeScopeIdentity } from '../src/delivery/writeScope.ts';
import { resolveRecord } from '../src/evaluator/evaluator.ts';
import { Derivation, fullCompute, Index, type DerivedState } from '../src/evaluator/semantics.ts';
import { EvaluatorSupervisor } from '../src/evaluator/supervisor.ts';
import { discoverRepo, lsTree, type RepoLayout } from '../src/git/objects.ts';
import { deliveryRef } from '../src/git/refs.ts';
import { AttributeEvaluator, readTransformDescription, transformDescriptionHash, type TransformDescription } from '../src/git/representation.ts';
import type { ContentStore } from '../src/ledger/content.ts';
import { RemoteLedgerError } from '../src/ledger/ipc.ts';
import { readHead, readRecords, Store } from '../src/ledger/store.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, startLedger, type FileSpec, type Fixture, type LedgerHarness } from './git-fixtures.test.ts';
import { MISSION, StubChecks, TEST_DISK, obj, ov, unit } from './delivery-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('delivery-evview');
});
after(() => fx.cleanup());

const ident = { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000500 +0000' };
const BASE: Record<string, FileSpec> = { 'a/x.ts': 'x 1\n', 'b/y.ts': 'y 1\n', 'c/z.ts': 'z 1\n', 'd/w.ts': 'w 1\n', 'docs/readme.md': 'readme 1\n' };
let n = 0;

// ---------------------------------------------------------------- the repository

interface World {
  repo: string;
  layout: RepoLayout;
  M0: GitOid;
  d: TransformDescription;
  dh: ReturnType<typeof transformDescriptionHash>;
  /** One generated commit per module, each from M0 changing only that module's file. */
  C: Record<'a' | 'b' | 'c' | 'd', GitOid>;
}

async function world(): Promise<World> {
  const repo = initRepo(fx, `w${n++}`);
  const M0 = rawCommit(fx, repo, BASE, null, 'M0');
  checkoutMain(fx, repo, M0);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const c = (path: string, text: string) => rawCommit(fx, repo, { ...BASE, [path]: text }, M0, path);
  return {
    repo,
    layout,
    M0,
    d,
    dh: transformDescriptionHash(d),
    C: { a: c('a/x.ts', 'x 2\n'), b: c('b/y.ts', 'y 2\n'), c: c('c/z.ts', 'z 2\n'), d: c('d/w.ts', 'w 2\n') },
  };
}

// ---------------------------------------------------------------- records, as the program writes them

/** A product version from a generated commit: content = the write-scope identity, its document stored first (writeScope.ts). */
async function product(
  h: LedgerHarness,
  w: World,
  o: { id: string; module: string; scope: string[]; commit: GitOid; prerequisites?: string[]; reviews?: string[]; placed?: boolean },
): Promise<BaseRecord> {
  const entries = await lsTree(fx.git, w.layout, o.commit, { recursive: true });
  const content = h.content.put(writeScopeDocument(entries, o.scope));
  assert.equal(content, writeScopeIdentity(entries, o.scope), 'the stored document hashes to the identity');
  return {
    kind: 'object.version',
    object: o.id,
    objectKind: 'product',
    mission: MISSION,
    module: o.module,
    content,
    prerequisites: h.content.putList(o.prerequisites ?? []),
    scope: { paths: entries.filter((e) => e.type !== 'tree' && inWriteScope(o.scope, e.path)).map((e) => e.path), taskType: 'construct' },
    reviews: (o.reviews ?? ['reviewer']).map((review) => ({ review, basisLines: [], reliesOn: [] })),
    ...(o.placed === false ? {} : { source: { commit: o.commit, writeScope: o.scope, transform: w.dh } }),
  } as unknown as BaseRecord;
}

function judgment(
  h: LedgerHarness,
  o: { id: string; target: string; review?: string; verdict?: 'pass' | 'fail' | 'undecided'; evidence?: string[]; revokes?: string; executor?: string },
): BaseRecord {
  const L = (xs: string[]) => h.content.putList(xs);
  return {
    kind: 'judgment',
    judgment: o.id,
    review: o.review ?? 'reviewer',
    executor: o.executor ?? 'reviewer',
    target: o.target,
    verdict: o.verdict ?? 'pass',
    evidence: L(o.evidence ?? []),
    bases: L([]),
    constraints: L([]),
    reliesOn: L([]),
    issues: [],
    revokes: o.revokes ?? null,
    extends: null,
    evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
    superseded: [],
  } as unknown as BaseRecord;
}

function proofUnit(h: LedgerHarness, u: string, members: string[], reviews = ['integration']): BaseRecord {
  return { kind: 'proof.unit', unit: u, members: h.content.putList(members), reviews: reviews.map((review) => ({ review, basisLines: [], reliesOn: [] })) } as unknown as BaseRecord;
}

/** A closed run in environment snapshot `snap`; `inputs` are the files it read, by content (7.2: fields["input:<path>"] = sha256). */
function run(e: string, snap: string, inputs: Record<string, string>, exit = '0'): BaseRecord {
  const fields: Record<string, string> = { exit };
  for (const [p, text] of Object.entries(inputs)) fields[`input:${p}`] = sha256(text);
  return { kind: 'evidence', evidence: e, envLine: 'py', envSnapshot: snap, runClass: 'closed', fields } as unknown as BaseRecord;
}

const env = (snap: string): BaseRecord => ({ kind: 'env.snapshot', line: 'py', snapshot: snap }) as unknown as BaseRecord;
const renewal = (j: string, original: string, replacement: string): BaseRecord => ({ kind: 'evidence.renewal', judgment: j, original, replacement }) as unknown as BaseRecord;

let ops = 0;
async function append(h: LedgerHarness, records: BaseRecord[]): Promise<void> {
  await h.client.call('appendRecords', { op: `seed-${++ops}`, gen: h.gen, records });
}

/** a1 -> b1; c1 <-> d1 as proof unit u1. a1's Reviewer judgment rests on run E1, which read a/x.ts, b/y.ts and docs/readme.md. */
async function seedGraph(h: LedgerHarness, w: World): Promise<void> {
  await append(h, [
    env('py@1'),
    run('E1', 'py@1', { 'a/x.ts': 'x 2\n', 'b/y.ts': 'y 2\n', 'docs/readme.md': 'readme 1\n' }),
    await product(h, w, { id: 'a1', module: 'a', scope: ['a/**'], commit: w.C.a, prerequisites: ['b1'] }),
    await product(h, w, { id: 'b1', module: 'b', scope: ['b/**'], commit: w.C.b }),
    await product(h, w, { id: 'c1', module: 'c', scope: ['c/**'], commit: w.C.c, prerequisites: ['d1'] }),
    await product(h, w, { id: 'd1', module: 'd', scope: ['d/**'], commit: w.C.d, prerequisites: ['c1'] }),
    proofUnit(h, 'u1', ['c1', 'd1']),
    judgment(h, { id: 'Ja1', target: 'a1', evidence: ['E1'] }),
    judgment(h, { id: 'Jb1', target: 'b1' }),
    judgment(h, { id: 'Jc1', target: 'c1' }),
    judgment(h, { id: 'Jd1', target: 'd1' }),
    judgment(h, { id: 'Ju1', target: 'u1', review: 'integration' }),
  ]);
}

// ---------------------------------------------------------------- a real ledger and a real evaluator process

interface System {
  readonly h: LedgerHarness;
  readonly query: RpcClient;
  /** Waits until the evaluator has published the ledger head; returns that revision. */
  published(): Promise<number>;
  view(selected: EvaluatorViewOptions['selected'], evaluator?: EvaluatorQueryPort): ReturnType<typeof openEvaluatorDeliveryView>;
  close(): Promise<void>;
}

async function system(): Promise<System> {
  const root = join(fx.root, `sys${n++}`);
  const h = await startLedger(root);
  const evSock = join(root, 'ev.sock');
  const sup = new EvaluatorSupervisor({
    worker: {
      dbPath: h.paths.db,
      contentRoot: h.paths.content,
      ledgerSocket: h.socket,
      querySocket: evSock,
      checkpointPath: join(root, 'ev.checkpoint'),
      gen: Number(h.gen),
      pollMs: 20,
      checkpointEvery: 1,
      faultInjection: false,
    },
    ledger: {
      recordEvaluatorFailure: () => h.svc.recordEvaluatorFailure(),
      evaluatorHealth: async () => h.svc.evaluatorHealth(),
      setEvaluatorFault: (r) => h.svc.setEvaluatorFault(r),
      raiseAlert: (r) => h.svc.raiseAlert(r),
      putContent: (t) => h.svc.content.put(t),
    },
    deadlineMs: 30_000,
    heapMb: 256,
  });
  const failures: string[] = [];
  sup.on('failure', (f: { cause: string; stderr: string }) => failures.push(`${f.cause}: ${f.stderr}`));
  await sup.start();
  const query = new RpcClient(evSock, 10_000);
  return {
    h,
    query,
    async published(): Promise<number> {
      const end = Date.now() + 30_000;
      for (;;) {
        const head = readHead(h.paths.db);
        try {
          const s = (await query.call('summary')) as { revision: number | null };
          if (s.revision === head) return head;
        } catch (e) {
          if (!(e instanceof RpcUnavailable)) throw e; // the socket appears once the worker is ready
        }
        if (failures.length > 0) throw new Error(`the evaluator failed: ${failures.join('; ')}`);
        if (Date.now() > end) throw new Error('the evaluator did not publish the head');
        await sleep(25);
      }
    },
    view(selected, evaluator = query) {
      return openEvaluatorDeliveryView({ dbPath: h.paths.db, content: h.content, evaluator, selected });
    },
    async close(): Promise<void> {
      query.close();
      await sup.stop();
      await h.close();
    },
  };
}

function resolvedUpTo(db: string, content: ContentStore, at: number) {
  return readRecords(db, revision(0), revision(at))
    .filter((c) => EVALUATOR_INPUT_KINDS.has(c.record.kind))
    .map((c) => ({ revision: c.revision, record: resolveRecord(c.record, content) }));
}

function manifestOf(view: DeliveryProofView, ...selected: Parameters<typeof buildManifest>[1]): DeliveryManifest {
  const r = buildManifest(view, selected);
  assert.equal(r.kind, 'manifest', JSON.stringify(r));
  return (r as { manifest: DeliveryManifest }).manifest;
}

async function candidateOn(w: World, manifest: DeliveryManifest, base: GitOid) {
  const attributes = await AttributeEvaluator.create(fx.git, w.layout, w.d, fx.root);
  try {
    const c = await buildCandidate({
      git: fx.git,
      repo: w.layout,
      manifest,
      base,
      attributes,
      snapshotDir: join(fx.root, `cand-${n++}`),
      message: 'delivery\n',
      author: ident,
      committer: ident,
    });
    assert.equal(c.kind, 'candidate', JSON.stringify(c));
    return (c as Extract<typeof c, { kind: 'candidate' }>).candidate;
  } finally {
    attributes.dispose();
  }
}

// ---------------------------------------------------------------- tests on the real evaluator

test('manifest and proof check through the adapter: one published revision, labels from the evaluator, runs from the records (6.6 steps 1-4)', async () => {
  const s = await system();
  try {
    const w = await world();
    await seedGraph(s.h, w);
    const R = await s.published();
    const view = await s.view([obj('a1'), obj('c1')]);
    assert.equal(view.revision, R, 'the view is read at the published revision');

    const manifest = manifestOf(view, obj('a1'), obj('c1'));
    assert.equal(manifest.revision, R);
    assert.deepEqual(
      manifest.entries.map((e) => [e.object.id, e.unit, e.label]),
      [
        ['a1', null, 'proven'],
        ['b1', null, 'proven'],
        ['c1', 'u1', 'proven'],
        ['d1', 'u1', 'proven'],
      ],
    );
    assert.deepEqual(manifest.units, [{ unit: 'u1', members: ['c1', 'd1'], label: 'proven' }]);
    assert.deepEqual([...manifest.paths.entries()].sort(), [
      ['a/x.ts', 'a1'],
      ['b/y.ts', 'b1'],
      ['c/z.ts', 'c1'],
      ['d/w.ts', 'd1'],
    ]);
    // Object versions come back as recorded, tagged prerequisites and tree placement included.
    const a1 = view.object(ov('a1'));
    assert.deepEqual(a1?.prerequisites, [obj('b1')]);
    assert.deepEqual(a1?.tree, { commit: w.C.a, writeScope: ['a/**'], transform: w.dh });
    assert.equal(a1?.content, writeScopeIdentity(await lsTree(fx.git, w.layout, w.C.a, { recursive: true }), ['a/**']));
    // The deciding judgment's run, with its file inputs.
    assert.deepEqual(view.decidingEvidence(obj('a1')), [
      {
        evidence: 'E1',
        inputs: [
          { path: 'a/x.ts', sha256: sha256('x 2\n') },
          { path: 'b/y.ts', sha256: sha256('y 2\n') },
          { path: 'docs/readme.md', sha256: sha256('readme 1\n') },
        ],
      },
    ]);
    assert.deepEqual(view.decidingEvidence(unit('u1')), []);
    // Every label equals the evaluator's own full recomputation at R.
    const want = fullCompute(resolvedUpTo(s.h.paths.db, s.h.content, R), revision(R));
    for (const t of [obj('a1'), obj('b1'), obj('c1'), obj('d1'), unit('u1')]) assert.equal(view.label(t), want.targets.get(t.id)?.label, t.id);

    // The candidate on main: everything proven as of R.
    const c0 = await candidateOn(w, manifest, w.M0);
    const p0 = await checkCandidateProofs({ git: fx.git, repo: w.layout, view, manifest, candidate: c0 });
    assert.deepEqual(p0.proven, ['a1', 'b1', 'c1', 'd1']);
    assert.deepEqual(p0.notFullyProven, []);
    // Main moved: the run a1 rests on read docs/readme.md, which differs on the new base.
    const M1 = rawCommit(fx, w.repo, { ...BASE, 'docs/readme.md': 'readme 2\n' }, w.M0, 'M1');
    const c1 = await candidateOn(w, manifest, M1);
    const p1 = await checkCandidateProofs({ git: fx.git, repo: w.layout, view, manifest, candidate: c1 });
    assert.deepEqual(p1.proven, ['b1', 'c1', 'd1']);
    assert.deepEqual(p1.notFullyProven, [
      {
        id: 'a1',
        reasons: [{ kind: 'evidence-input-mismatch', evidence: 'E1', path: 'docs/readme.md', expected: sha256('readme 1\n'), actual: sha256('readme 2\n') }],
      },
    ]);
  } finally {
    await s.close();
  }
});

test('negation, revocation and renewal decide which runs the proof rests on, as the evaluator decides them (5.2, 5.3)', async () => {
  const s = await system();
  try {
    const w = await world();
    const h = s.h;
    const b1 = obj('b1');
    const state = async () => {
      await s.published();
      const v = await s.view([b1]);
      return { label: v.label(b1), runs: v.decidingEvidence(b1).map((e) => [e.evidence, e.inputs.map((i) => i.path)]) };
    };
    await append(h, [
      env('py@1'),
      run('E2', 'py@1', { 'b/y.ts': 'y 2\n', 'docs/readme.md': 'readme 1\n' }),
      await product(h, w, { id: 'b1', module: 'b', scope: ['b/**'], commit: w.C.b }),
      judgment(h, { id: 'Jb1', target: 'b1', evidence: ['E2'] }),
    ]);
    assert.deepEqual(await state(), { label: 'proven', runs: [['E2', ['b/y.ts', 'docs/readme.md']]] });
    // A negation decides the position: no deciding runs.
    await append(h, [judgment(h, { id: 'Jb2', target: 'b1', verdict: 'fail' })]);
    assert.deepEqual(await state(), { label: 'negated', runs: [] });
    // An Auditor pass naming the negation does not revoke it (v29 5.2).
    await append(h, [judgment(h, { id: 'Jb3', target: 'b1', executor: 'auditor', revokes: 'Jb2', evidence: ['E2'] })]);
    assert.deepEqual(await state(), { label: 'negated', runs: [] });
    // A Reviewer pass naming it does; its own run is what the proof now rests on.
    await append(h, [run('E3', 'py@1', { 'b/y.ts': 'y 2\n' }), judgment(h, { id: 'Jb4', target: 'b1', revokes: 'Jb2', evidence: ['E3'] })]);
    assert.deepEqual(await state(), { label: 'proven', runs: [['E3', ['b/y.ts']]] });
    // A new environment snapshot: the run no longer applies.
    await append(h, [env('py@2')]);
    assert.deepEqual(await state(), { label: 'not-fully-proven', runs: [['E3', ['b/y.ts']]] });
    // A valid renewal (every declared field equal): the replacement run and ITS inputs.
    await append(h, [run('E4', 'py@2', { 'b/y.ts': 'y 2\n', 'b/fixture.json': '{}\n' }), renewal('Jb4', 'E3', 'E4')]);
    assert.deepEqual(await state(), { label: 'proven', runs: [['E4', ['b/fixture.json', 'b/y.ts']]] });
    // An invalid renewal (the declared field differs) is refused by the ledger now (RENEWAL_REFUSED, core r3 F14);
    // the proof keeps resting on E4.
    await append(h, [run('E5', 'py@2', { 'b/y.ts': 'y 3\n' }, '1')]);
    await assert.rejects(append(h, [renewal('Jb4', 'E4', 'E5')]), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'RENEWAL_REFUSED');
    assert.deepEqual(await state(), { label: 'proven', runs: [['E4', ['b/fixture.json', 'b/y.ts']]] });
  } finally {
    await s.close();
  }
});

test('a publication between two answers: the view starts over at the new revision and never mixes revisions (6.1)', async () => {
  const s = await system();
  try {
    const w = await world();
    await append(s.h, [await product(s.h, w, { id: 'b1', module: 'b', scope: ['b/**'], commit: w.C.b }), judgment(s.h, { id: 'Jb1', target: 'b1' })]);
    const R0 = await s.published();
    const log: string[] = [];
    let raced = false;
    const racing: EvaluatorQueryPort = {
      async call(method, params) {
        if (method === 'deciding' && !raced) {
          raced = true;
          // The negation is committed and published after the view read the records at R0.
          await append(s.h, [judgment(s.h, { id: 'Jb2', target: 'b1', verdict: 'fail' })]);
          await s.published();
        }
        const r = (await s.query.call(method, params)) as { revision: number };
        log.push(`${method}@${r.revision === R0 ? 'R0' : 'R1'}`);
        return r;
      },
    };
    const view = await s.view([obj('b1')], racing);
    assert.ok(view.revision > R0);
    assert.deepEqual(log, ['summary@R0', 'deciding@R1', 'deciding@R1'], 'read again at R1');
    assert.equal(view.label(obj('b1')), 'negated');
    assert.deepEqual(view.decidingEvidence(obj('b1')), [], 'the records at R1 are the ones the view answers from');
  } finally {
    await s.close();
  }
});

test('deliver end to end through the adapter and the ledger authority: the recorded manifest names its revision (6.6 steps 1-8)', async () => {
  const s = await system();
  try {
    const w = await world();
    await seedGraph(s.h, w);
    const R = await s.published();
    const view = await s.view([obj('a1'), obj('c1')]);
    const req: DeliveryRequest = {
      key: { mission: MISSION, op: id<OpId>('op-evview') },
      repoPath: w.repo,
      targetBranch: 'main',
      selected: [obj('a1'), obj('c1')],
      description: w.d,
      closingChecks: [{ id: 'tests', command: ['npm', 'test'] }],
      author: ident,
      committer: ident,
    };
    const authority = new LedgerDeliveryAuthority({
      client: s.h.client,
      content: s.h.content,
      gen: s.h.gen,
      tag: { mission: MISSION, capabilities: [] },
      lineage: 'lineage-evview',
      domain: deliveryRefDomain(w.layout, deliveryRef(req.key.mission, req.key.op)),
    });
    const r = await deliver(req, { git: fx.git, view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK });
    assert.equal(r.kind, 'delivered', JSON.stringify(r));
    if (r.kind !== 'delivered') return;
    assert.equal(r.record.manifest.revision, R);
    assert.deepEqual(r.record.proof.proven, ['a1', 'b1', 'c1', 'd1']);
    const recorded = readRecords(s.h.paths.db, revision(0)).filter((c) => c.record.kind === 'delivery.recorded');
    assert.equal(recorded.length, 1);
    const stored = JSON.parse(s.h.content.get((recorded[0]?.record as unknown as { manifest: never }).manifest).toString()) as {
      manifest: { revision: number; entries: { object: { id: string }; label: string }[] };
    };
    assert.equal(stored.manifest.revision, R);
    assert.deepEqual(
      stored.manifest.entries.map((e) => [e.object.id, e.label]),
      [
        ['a1', 'proven'],
        ['b1', 'proven'],
        ['c1', 'proven'],
        ['d1', 'proven'],
      ],
    );
    // The delivered tree holds every version's files.
    for (const [path, text] of [
      ['a/x.ts', 'x 2'],
      ['b/y.ts', 'y 2'],
      ['c/z.ts', 'z 2'],
      ['d/w.ts', 'w 2'],
    ] as const) {
      assert.equal(fx.raw(['cat-file', 'blob', `${r.record.commit}:${path}`], w.repo), text);
    }
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- a scripted evaluator (its own full computation)

/**
 * Answers like the evaluator's query socket, computed with the evaluator's
 * fullCompute at the revision `at(method, call)` chooses (null: not ready).
 * `edit` may falsify an answer to test the cross-checks.
 */
class ScriptedEvaluator implements EvaluatorQueryPort {
  readonly log: string[] = [];
  /** Targets per deciding query, in order. */
  readonly batches: number[] = [];
  private readonly cache = new Map<number, DerivedState>();
  private readonly h: LedgerHarness;
  private readonly at: (method: string, call: number) => number | null;
  private readonly edit: (method: string, answer: Record<string, unknown>) => Record<string, unknown>;
  constructor(
    h: LedgerHarness,
    at: (method: string, call: number) => number | null,
    edit: (method: string, answer: Record<string, unknown>) => Record<string, unknown> = (_m, a) => a,
  ) {
    this.h = h;
    this.at = at;
    this.edit = edit;
  }
  private readonly derivations = new Map<number, Derivation>();
  private state(at: number): DerivedState {
    let s = this.cache.get(at);
    if (s === undefined) {
      s = fullCompute(resolvedUpTo(this.h.paths.db, this.h.content, at), revision(at));
      this.cache.set(at, s);
    }
    return s;
  }
  /** The evaluator's own `deciding` derivation over the records at `at`. */
  private derivation(at: number): Derivation {
    let d = this.derivations.get(at);
    if (d === undefined) {
      const ix = new Index();
      for (const c of resolvedUpTo(this.h.paths.db, this.h.content, at)) ix.add(c);
      d = new Derivation(ix);
      this.derivations.set(at, d);
    }
    return d;
  }
  async call(method: string, params: unknown = {}): Promise<unknown> {
    const at = this.at(method, this.log.length);
    this.log.push(`${method}@${at}`);
    const head = readHead(this.h.paths.db);
    if (at === null) {
      if (method === 'summary') return { revision: null, head, lag: null, targets: 0 };
      throw new RpcError('NOT_READY', 'no published revision yet');
    }
    const s = this.state(at);
    const ids = ((params as { ids?: string[] }).ids ?? []) as string[];
    let answer: Record<string, unknown>;
    if (method === 'summary') answer = { revision: at, head, lag: head - at, targets: s.targets.size };
    else if (method === 'targets') answer = { revision: at, states: Object.fromEntries(ids.map((i) => [i, s.targets.get(i) ?? null])) };
    else if (method === 'judgments') answer = { revision: at, current: Object.fromEntries(ids.map((i) => [i, s.judgmentCurrent.get(i as never) ?? null])) };
    else if (method === 'deciding') {
      const targets = ((params as { targets?: string[] }).targets ?? []) as string[];
      this.batches.push(targets.length);
      const d = this.derivation(at);
      answer = { revision: at, targets: Object.fromEntries(targets.map((t) => [t, d.deciding(t)])) };
    } else throw new RpcError('BAD_REQUEST', `unknown method ${method}`);
    return JSON.parse(JSON.stringify(this.edit(method, answer))) as unknown;
  }
}

/** A ledger with b1 proven at R1 (deciding judgment Jb1 resting on E1) and negated by Jb2 at R2. */
async function ledgerWithHistory(): Promise<{ h: LedgerHarness; w: World; R1: number; R2: number; open: (ev: EvaluatorQueryPort, selected?: EvaluatorViewOptions['selected'], attempts?: number) => ReturnType<typeof openEvaluatorDeliveryView> }> {
  const h = await startLedger(join(fx.root, `ledger${n++}`));
  const w = await world();
  await append(h, [env('py@1'), run('E1', 'py@1', { 'b/y.ts': 'y 2\n' }), await product(h, w, { id: 'b1', module: 'b', scope: ['b/**'], commit: w.C.b }), judgment(h, { id: 'Jb1', target: 'b1', evidence: ['E1'] })]);
  const R1 = readHead(h.paths.db);
  await append(h, [judgment(h, { id: 'Jb2', target: 'b1', verdict: 'fail' })]);
  const R2 = readHead(h.paths.db);
  return {
    h,
    w,
    R1,
    R2,
    open: (ev, selected = [obj('b1')], attempts) => openEvaluatorDeliveryView({ dbPath: h.paths.db, content: h.content, evaluator: ev, selected, attempts }),
  };
}

test('an evaluator restarted from an older checkpoint: the view follows it back and answers from the older records only (6.1)', async () => {
  const L = await ledgerWithHistory();
  try {
    const ev = new ScriptedEvaluator(L.h, (m) => (m === 'summary' ? L.R2 : L.R1));
    const view = await L.open(ev);
    assert.equal(view.revision, L.R1);
    assert.deepEqual(ev.log, [`summary@${L.R2}`, `deciding@${L.R1}`, `deciding@${L.R1}`]);
    assert.equal(view.label(obj('b1')), 'proven');
    assert.deepEqual(view.decidingEvidence(obj('b1')), [{ evidence: 'E1', inputs: [{ path: 'b/y.ts', sha256: sha256('y 2\n') }] }]);
  } finally {
    await L.h.close();
  }
});

test('a revision that never settles, an evaluator that is not ready, a database that is not the evaluator\'s: typed errors, no view', async () => {
  const L = await ledgerWithHistory();
  try {
    // Alternating publications: give up after the attempts, naming every revision seen.
    const flip = new ScriptedEvaluator(L.h, (_m, call) => (call % 2 === 0 ? L.R2 : L.R1));
    await assert.rejects(L.open(flip, [obj('b1')], 3), (e: unknown) => {
      assert.ok(e instanceof ViewRevisionUnstable);
      assert.deepEqual(e.revisions, [L.R2, L.R1, L.R2, L.R1]);
      return true;
    });
    // Nothing published yet; or a restart between two answers.
    await assert.rejects(L.open(new ScriptedEvaluator(L.h, () => null)), ViewNotReady);
    const restarting = new ScriptedEvaluator(L.h, (m) => (m === 'summary' ? L.R2 : null));
    await assert.rejects(L.open(restarting), ViewNotReady);
    // NOT_READY is retryable (the evaluator already waited, bounded): asked again within the attempts, then given up.
    assert.equal(restarting.log.filter((x) => x.startsWith('deciding')).length, 5);
    // Not ready once (a publication in flight past its bounded wait), then answering: the view opens.
    const once = new ScriptedEvaluator(L.h, (m, call) => (m === 'deciding' && call === 1 ? null : L.R2));
    assert.equal((await L.open(once)).label(obj('b1')), 'negated');
    // The evaluator is ahead of this database: it reads another one.
    await assert.rejects(L.open(new ScriptedEvaluator(L.h, () => L.R2 + 5)), (e: unknown) => e instanceof ViewInconsistent && /ends at revision/.test(e.message));
  } finally {
    await L.h.close();
  }
});

test('answers that contradict the records at the same revision, or themselves, are refused, not trusted (6.1)', async () => {
  const L = await ledgerWithHistory();
  try {
    type Answer = Record<string, unknown> & { targets: Record<string, Record<string, unknown> | null> };
    const editing = (at: number, f: (b1: Record<string, unknown>) => Record<string, unknown> | null) =>
      new ScriptedEvaluator(L.h, () => at, (m, a) => (m === 'deciding' ? { ...a, targets: { ...(a as Answer).targets, b1: f((a as Answer).targets.b1 as Record<string, unknown>) } } : a));
    // At R2 a failing position negates b1; an evaluator claiming "passed" for it contradicts its own positions.
    await assert.rejects(
      L.open(editing(L.R2, (b) => ({ ...b, conclusion: 'passed', inEffect: true, label: 'proven' }))),
      (e: unknown) => e instanceof ViewInconsistent && e.target === 'b1' && /concludes passed, its positions give negated/.test(e.message),
    );
    // At R1 the deciding judgment Jb1 is current; an evaluator saying otherwise contradicts its own "in effect".
    await assert.rejects(
      L.open(editing(L.R1, (b) => ({ ...b, deciding: (b.deciding as Record<string, unknown>[]).map((d) => ({ ...d, current: false })) }))),
      (e: unknown) => e instanceof ViewInconsistent && e.target === 'b1' && /in effect/.test(e.message),
    );
    // Deciding judgments that are not the passing positions' judgments.
    await assert.rejects(
      L.open(editing(L.R1, (b) => ({ ...b, deciding: [] }))),
      (e: unknown) => e instanceof ViewInconsistent && /not the judgments its passing positions name/.test(e.message),
    );
    // Review positions other than the recorded contract (another database), or another kind of target.
    await assert.rejects(
      L.open(editing(L.R1, (b) => ({ ...b, positions: [{ review: 'auditor', state: 'pass', by: 'Jb1' }] }))),
      (e: unknown) => e instanceof ViewInconsistent && /the records require \[reviewer\]/.test(e.message),
    );
    await assert.rejects(L.open(editing(L.R1, (b) => ({ ...b, kind: 'unit' }))), (e: unknown) => e instanceof ViewInconsistent && /answers for unit/.test(e.message));
    // A target the records have but the evaluator does not know.
    await assert.rejects(L.open(editing(L.R1, () => null)), (e: unknown) => e instanceof ViewInconsistent && /publishes no state/.test(e.message));
    // The honest evaluator at the same revisions is accepted.
    assert.equal((await L.open(new ScriptedEvaluator(L.h, () => L.R2))).label(obj('b1')), 'negated');
    assert.equal((await L.open(new ScriptedEvaluator(L.h, () => L.R1))).label(obj('b1')), 'proven');
  } finally {
    await L.h.close();
  }
});

test('coordinator r3 #14: an invalid newest renewal of an evidence no longer hides an older valid one (the view reads the evaluator\'s decision)', async () => {
  const L = await ledgerWithHistory();
  try {
    const h = L.h;
    await append(h, [
      await product(h, L.w, { id: 'r1', module: 'r', scope: ['c/**'], commit: L.w.C.c }),
      run('E7', 'py@1', { 'c/z.ts': 'z 2\n' }),
      judgment(h, { id: 'Jr1', target: 'r1', evidence: ['E7'] }),
      env('py@2'),
      // A valid renewal of E7 (every declared field equal) in the new snapshot...
      run('E8', 'py@2', { 'c/z.ts': 'z 2\n', 'c/fixture.json': '{}\n' }),
      renewal('Jr1', 'E7', 'E8'),
      // ...then a run that is not a valid renewal of E7 (exit differs).
      run('E9', 'py@2', { 'c/z.ts': 'z 9\n' }, '1'),
    ]);
    // The ledger refuses that renewal now; a ledger written before it did holds it: appended to the log directly.
    await assert.rejects(append(h, [renewal('Jr1', 'E7', 'E9')]), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'RENEWAL_REFUSED');
    const old = new Store(h.paths.db);
    try {
      old.appendRecord(renewal('Jr1', 'E7', 'E9'), null, Date.now());
    } finally {
      old.close();
    }
    const at = readHead(h.paths.db);
    assert.equal(readRecords(h.paths.db, revision(at - 1), revision(at))[0]?.record.kind, 'evidence.renewal', 'the newest record is the invalid renewal');
    const view = await L.open(new ScriptedEvaluator(h, () => at), [obj('r1')]);
    assert.equal(view.label(obj('r1')), 'proven', 'the valid renewal keeps the proof in force');
    assert.deepEqual(
      view.decidingEvidence(obj('r1')).map((e) => [e.evidence, e.inputs.map((i) => i.path)]),
      [['E8', ['c/fixture.json', 'c/z.ts']]],
      'the run in force is the valid E8 (the old ported rule fell back to E7 behind the invalid E9)',
    );
  } finally {
    await L.h.close();
  }
});

test('deciding answers are fetched in batches of at most 10,000 targets, all at one revision', async () => {
  const L = await ledgerWithHistory();
  try {
    const h = L.h;
    const many: BaseRecord[] = [];
    const prereqs: string[] = [];
    const planContent = h.content.put('a plan\n');
    for (let i = 0; i < 10_050; i++) {
      many.push({
        kind: 'object.version',
        object: `p${i}`,
        objectKind: 'plan',
        mission: MISSION,
        module: null,
        content: planContent,
        prerequisites: h.content.putList([]),
        scope: { paths: [], taskType: 'construct' },
        reviews: [],
      } as unknown as BaseRecord);
      prereqs.push(`p${i}`);
    }
    for (let i = 0; i < many.length; i += 1_000) await append(h, many.slice(i, i + 1_000));
    await append(h, [{ ...(await product(h, L.w, { id: 'top', module: 't', scope: ['a/**'], commit: L.w.C.a })), prerequisites: h.content.putList(prereqs) } as unknown as BaseRecord]);
    const at = readHead(h.paths.db);
    const ev = new ScriptedEvaluator(h, () => at);
    const view = await L.open(ev, [obj('top')]);
    assert.deepEqual(ev.batches, [10_000, 51], 'two batches, the first full');
    assert.equal(view.label(obj('p10049')), 'unaccepted');
    assert.equal(view.revision, at);
  } finally {
    await L.h.close();
  }
});

test('scope of a view: targets outside the closure are refused, unknown ones are not proven, unplaced products and id collisions are refused', async () => {
  const L = await ledgerWithHistory();
  try {
    const h = L.h;
    await append(h, [
      await product(h, L.w, { id: 'a1', module: 'a', scope: ['a/**'], commit: L.w.C.a }),
      judgment(h, { id: 'Ja1', target: 'a1' }),
      await product(h, L.w, { id: 'p0', module: 'p', scope: ['c/**'], commit: L.w.C.c, placed: false }),
      judgment(h, { id: 'Jp0', target: 'p0' }),
    ]);
    const at = readHead(h.paths.db);
    const honest = () => new ScriptedEvaluator(h, () => at);
    const view = await L.open(honest(), [obj('b1')]);
    assert.throws(() => view.label(obj('a1')), RangeError, 'a1 exists but is not in the closure of b1');
    assert.throws(() => view.decidingEvidence(obj('a1')), RangeError);
    assert.equal(view.label(obj('nope')), 'unaccepted');
    assert.deepEqual(buildManifest(await L.open(honest(), [obj('nope')]), [obj('nope')]), { kind: 'unknown', missing: [obj('nope')] });
    // 5.1: a product version is a content hash AND a commit; one without a tree placement cannot be delivered.
    assert.deepEqual(buildManifest(await L.open(honest(), [obj('p0')]), [obj('p0')]), { kind: 'unplaced', versions: ['p0'] });
    // An object version and a proof unit under one id: the ledger refuses it (one id space, FACT_CONFLICT), so no view
    // ever meets it (the view's own check stays as a defence).
    const dupObject = await product(h, L.w, { id: 'dup', module: 'd', scope: ['d/**'], commit: L.w.C.d });
    await assert.rejects(append(h, [dupObject, proofUnit(h, 'dup', ['b1'])]), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'FACT_CONFLICT');
    await append(h, [dupObject]);
    await assert.rejects(append(h, [proofUnit(h, 'dup', ['b1'])]), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'FACT_CONFLICT' && /share one id space/.test(e.message));
  } finally {
    await L.h.close();
  }
});
