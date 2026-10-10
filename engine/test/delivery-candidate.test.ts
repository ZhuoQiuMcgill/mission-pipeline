// Delivery candidate and proof check on real repositories (design 6.6 steps 3-4, 7.1).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { contentHash, type GitOid } from '../src/common/ids.ts';
import { sha256 } from '../src/common/hash.ts';
import { buildCandidate, checkCandidateProofs, type CandidateResult } from '../src/delivery/candidate.ts';
import { buildManifest, type DeliveryManifest } from '../src/delivery/manifest.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { AttributeEvaluator, readTransformDescription, transformDescriptionHash, type TransformDescription } from '../src/git/representation.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, type FileSpec, type Fixture } from './git-fixtures.test.ts';
import { FakeProofView, evi, obj, ov, productVersion, pu, unit } from './delivery-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('delivery-cand');
});
after(() => fx.cleanup());

const ident = { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000200 +0000' };
const BASE: Record<string, FileSpec> = {
  'a/x.ts': 'export const x = 1;\n',
  'a/other.ts': 'other 1\n',
  'b/y.ts': 'y 1\n',
  'b/gone.ts': 'to be deleted\n',
  'p/main.ts': 'main 1\n',
  'docs/readme.md': 'readme 1\n',
};

interface World {
  repo: string;
  layout: RepoLayout;
  M0: GitOid;
  d: TransformDescription;
  ev: AttributeEvaluator;
  view: FakeProofView;
}

let n = 0;
/** main at M0; three versions generated from M0 (parent M0, only their module's files differ), as the program produces them. */
async function world(): Promise<World> {
  const repo = initRepo(fx, `w${n++}`);
  const M0 = rawCommit(fx, repo, BASE, null, 'M0');
  checkoutMain(fx, repo, M0);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const dh = transformDescriptionHash(d);
  const CA1 = rawCommit(fx, repo, { ...BASE, 'a/x.ts': 'export const x = 2;\n' }, M0, 'A1');
  const { 'b/gone.ts': _gone, ...withoutGone } = BASE;
  const CB1 = rawCommit(fx, repo, { ...withoutGone, 'b/y.ts': 'y 2\n', 'b/new.ts': 'new\n' }, M0, 'B1');
  const CP1 = rawCommit(fx, repo, { ...BASE, 'p/main.ts': 'main 2\n' }, M0, 'P1');
  const view = new FakeProofView().add(
    await productVersion(fx.git, layout, { id: 'a1', module: 'a', writeScope: ['a/**'], commit: CA1, transform: dh }),
    await productVersion(fx.git, layout, { id: 'b1', module: 'b', writeScope: ['b/**'], commit: CB1, transform: dh }),
    await productVersion(fx.git, layout, { id: 'p1', module: 'p', writeScope: ['p/**'], commit: CP1, transform: dh, prerequisites: [obj('a1')] }),
  );
  // P1's Reviewer judgment rests on a run that read a/x.ts (A1's content) and p/main.ts.
  view.setEvidence(obj('p1'), [
    {
      evidence: evi('run-p1'),
      inputs: [
        { path: 'a/x.ts', sha256: sha256('export const x = 2;\n') },
        { path: 'p/main.ts', sha256: sha256('main 2\n') },
      ],
    },
  ]);
  const ev = await AttributeEvaluator.create(fx.git, layout, d, fx.root);
  return { repo, layout, M0, d, ev, view };
}

function manifestOf(w: World, ...selected: Parameters<typeof buildManifest>[1]): DeliveryManifest {
  const r = buildManifest(w.view, selected);
  assert.equal(r.kind, 'manifest', JSON.stringify(r));
  return (r as { manifest: DeliveryManifest }).manifest;
}

async function candidateOf(w: World, manifest: DeliveryManifest, base: GitOid): Promise<CandidateResult> {
  return buildCandidate({
    git: fx.git,
    repo: w.layout,
    manifest,
    base,
    attributes: w.ev,
    snapshotDir: join(fx.root, `cand-${n++}`),
    message: 'delivery\n',
    author: ident,
    committer: ident,
  });
}

function blob(w: World, rev: string, path: string): string {
  return fx.raw(['cat-file', 'blob', `${rev}:${path}`], w.repo);
}

test('each version brings its own changes onto the current main; what main did meanwhile survives; all proven', async () => {
  const w = await world();
  try {
    const M1 = rawCommit(fx, w.repo, { ...BASE, 'docs/readme.md': 'readme 2\n', 'top.txt': 'added on main\n' }, w.M0, 'M1');
    const c = await candidateOf(w, manifestOf(w, obj('p1'), obj('b1')), M1);
    assert.equal(c.kind, 'candidate');
    if (c.kind !== 'candidate') return;
    const k = c.candidate;
    assert.equal(fx.raw(['rev-parse', `${k.commit}^`], w.repo), M1, 'one parent: the base, so landing is a fast-forward');
    assert.equal(fx.raw(['rev-list', '--count', `${M1}..${k.commit}`], w.repo), '1');
    assert.equal(blob(w, k.commit, 'a/x.ts'), 'export const x = 2;', 'A1 entered as the prerequisite of P1');
    assert.equal(blob(w, k.commit, 'p/main.ts'), 'main 2');
    assert.equal(blob(w, k.commit, 'b/y.ts'), 'y 2');
    assert.equal(blob(w, k.commit, 'b/new.ts'), 'new');
    assert.equal(fx.rawStatus(['cat-file', '-e', `${k.commit}:b/gone.ts`], w.repo).code, 128, 'B1 deleted it');
    assert.equal(blob(w, k.commit, 'docs/readme.md'), 'readme 2', "main's own change survives");
    assert.equal(blob(w, k.commit, 'top.txt'), 'added on main');
    assert.deepEqual(k.changedPaths, ['a/x.ts', 'b/gone.ts', 'b/new.ts', 'b/y.ts', 'p/main.ts']);
    assert.equal(readFileSync(join(k.snapshotDir, 'p/main.ts'), 'utf8'), 'main 2\n', 'the canonical candidate is materialized');
    const proof = await checkCandidateProofs({ git: fx.git, repo: w.layout, view: w.view, manifest: manifestOf(w, obj('p1'), obj('b1')), candidate: k });
    assert.deepEqual(proof.notFullyProven, []);
    assert.deepEqual([...proof.proven].sort(), ['a1', 'b1', 'p1']);
  } finally {
    w.ev.dispose();
  }
});

test('a user commit on main touching another file of a selected module write scope: the object check catches it (6.6 step 4)', async () => {
  const w = await world();
  try {
    const M2 = rawCommit(fx, w.repo, { ...BASE, 'a/other.ts': 'other edited on main\n' }, w.M0, 'user edits a/other.ts');
    const manifest = manifestOf(w, obj('p1'), obj('b1'));
    const c = await candidateOf(w, manifest, M2);
    assert.equal(c.kind, 'candidate', 'no textual conflict: A1 never touched a/other.ts');
    if (c.kind !== 'candidate') return;
    assert.equal(blob(w, c.candidate.commit, 'a/other.ts'), 'other edited on main');
    const proof = await checkCandidateProofs({ git: fx.git, repo: w.layout, view: w.view, manifest, candidate: c.candidate });
    assert.deepEqual(proof.proven, ['b1']);
    const a1 = proof.notFullyProven.find((x) => x.id === 'a1');
    assert.deepEqual(a1?.reasons.map((r) => r.kind), ['content-changed'], 'A1 in the candidate is a new version: re-verify before delivering it as proven');
    // The data for the scheduler: record the new product version, then verify and review it again.
    assert.deepEqual(
      proof.needsReverification.map((x) => [x.id, x.source.commit, x.source.writeScope, x.source.transform]),
      [['a1', c.candidate.commit, ['a/**'], transformDescriptionHash(w.d)]],
    );
    const { writeScopeIdentityAt } = await import('../src/delivery/writeScope.ts');
    assert.equal(proof.needsReverification[0]?.content, await writeScopeIdentityAt(fx.git, w.layout, c.candidate.commit, ['a/**']));
    const p1 = proof.notFullyProven.find((x) => x.id === 'p1');
    assert.deepEqual(p1?.reasons.map((r) => (r.kind === 'prerequisite-mismatch' ? `${r.kind}:${r.prerequisite}` : r.kind)), ['prerequisite-mismatch:a1']);
  } finally {
    w.ev.dispose();
  }
});

test('both sides changed one path differently: a typed conflict for an integration task (6.6 step 3)', async () => {
  const w = await world();
  try {
    const M3 = rawCommit(fx, w.repo, { ...BASE, 'a/x.ts': 'export const x = 99;\n', 'b/gone.ts': 'edited, B1 deletes it\n' }, w.M0, 'conflicting');
    const c = await candidateOf(w, manifestOf(w, obj('a1'), obj('b1')), M3);
    assert.equal(c.kind, 'conflict');
    if (c.kind !== 'conflict') return;
    assert.deepEqual(c.conflicts.map((x) => [x.path, x.version, x.delivered === null ? 'deleted' : 'changed']), [
      ['a/x.ts', 'a1', 'changed'],
      ['b/gone.ts', 'b1', 'deleted'],
    ]);
    // The same change on both sides is not a conflict.
    const same = rawCommit(fx, w.repo, { ...BASE, 'a/x.ts': 'export const x = 2;\n' }, w.M0, 'same as A1');
    assert.equal((await candidateOf(w, manifestOf(w, obj('a1')), same)).kind, 'candidate');
  } finally {
    w.ev.dispose();
  }
});

test('evidence inputs must correspond to the candidate content; a version not proven at the revision is listed with its label', async () => {
  const w = await world();
  try {
    w.view.setEvidence(obj('b1'), [{ evidence: evi('run-b1'), inputs: [{ path: 'docs/readme.md', sha256: sha256('readme 1\n') }, { path: 'b/missing.ts', sha256: sha256('x') }] }]);
    w.view.setLabel(obj('p1'), 'not-fully-proven');
    const M4 = rawCommit(fx, w.repo, { ...BASE, 'docs/readme.md': 'readme changed on main\n' }, w.M0, 'docs');
    const manifest = manifestOf(w, obj('p1'), obj('b1'));
    const c = await candidateOf(w, manifest, M4);
    if (c.kind !== 'candidate') assert.fail(c.kind);
    const proof = await checkCandidateProofs({ git: fx.git, repo: w.layout, view: w.view, manifest, candidate: c.candidate });
    const b1 = proof.notFullyProven.find((x) => x.id === 'b1');
    assert.deepEqual(
      b1?.reasons.map((r) => (r.kind === 'evidence-input-mismatch' ? `${r.path}:${r.actual === null ? 'absent' : 'different'}` : r.kind)),
      ['docs/readme.md:different', 'b/missing.ts:absent'],
    );
    const p1 = proof.notFullyProven.find((x) => x.id === 'p1');
    assert.deepEqual(p1?.reasons, [{ kind: 'not-proven', label: 'not-fully-proven' }]);
    assert.deepEqual(proof.proven, ['a1']);
  } finally {
    w.ev.dispose();
  }
});

test('a version verified under another transform description cannot enter the candidate (7.1)', async () => {
  const w = await world();
  try {
    const a1 = w.view.object(ov('a1'));
    if (a1 === null || a1.tree === null) assert.fail('a1');
    w.view.add({ ...a1, tree: { ...a1.tree, transform: contentHash('1'.repeat(64)) } });
    const c = await candidateOf(w, manifestOf(w, obj('a1'), obj('b1')), w.M0);
    assert.equal(c.kind, 'description-mismatch');
    if (c.kind === 'description-mismatch') assert.deepEqual(c.versions, ['a1']);
  } finally {
    w.ev.dispose();
  }
});

test('proof units: members are not prerequisites of each other, and the unit evidence applies to every member (5.3)', async () => {
  const w = await world();
  try {
    const dh = transformDescriptionHash(w.d);
    const CX = rawCommit(fx, w.repo, { ...BASE, 'x/f.ts': 'x\n', 'y/f.ts': 'y 0\n' }, w.M0, 'X');
    const CY = rawCommit(fx, w.repo, { ...BASE, 'y/f.ts': 'y 1\n' }, w.M0, 'Y');
    w.view.add(
      await productVersion(fx.git, w.layout, { id: 'x1', module: 'x', writeScope: ['x/**'], commit: CX, transform: dh, prerequisites: [obj('y1')] }),
      await productVersion(fx.git, w.layout, { id: 'y1', module: 'y', writeScope: ['y/**'], commit: CY, transform: dh, prerequisites: [obj('x1')] }),
    );
    w.view.unit(pu('u1'), [ov('x1'), ov('y1')]);
    w.view.setEvidence(unit('u1'), [{ evidence: evi('run-u1'), inputs: [{ path: 'docs/readme.md', sha256: sha256('stale\n') }] }]);
    const M5 = rawCommit(fx, w.repo, { ...BASE, 'y/other.ts': 'user file in y\n' }, w.M0, 'user adds y/other.ts');
    const manifest = manifestOf(w, obj('x1'));
    assert.deepEqual(manifest.entries.map((e) => e.object.id), ['x1', 'y1']);
    const c = await candidateOf(w, manifest, M5);
    if (c.kind !== 'candidate') assert.fail(c.kind);
    const proof = await checkCandidateProofs({ git: fx.git, repo: w.layout, view: w.view, manifest, candidate: c.candidate });
    const kinds = (idv: string) => proof.notFullyProven.find((x) => x.id === idv)?.reasons.map((r) => r.kind);
    assert.deepEqual(kinds('y1'), ['content-changed', 'evidence-input-mismatch', 'unit-member-not-proven'], 'a new file in y/** changes y1');
    // x1 is not blamed for y1 as a prerequisite (members are not prerequisites of each other), only as its unit peer.
    assert.deepEqual(kinds('x1'), ['evidence-input-mismatch', 'unit-member-not-proven']);
  } finally {
    w.ev.dispose();
  }
});

// review r1 #5: the test above gave every member the unit's stale evidence, which hid that one failing member did not
// fail the others. These cases change one member or one prerequisite only.

/** x1 and y1 (a proof unit or not), z1 -> x1, w1 -> z1; built from M0 like the others. */
async function chain(w: World, asUnit: boolean): Promise<void> {
  const dh = transformDescriptionHash(w.d);
  const CX = rawCommit(fx, w.repo, { ...BASE, 'x/f.ts': 'x\n' }, w.M0, 'X');
  const CY = rawCommit(fx, w.repo, { ...BASE, 'y/f.ts': 'y 1\n' }, w.M0, 'Y');
  const CZ = rawCommit(fx, w.repo, { ...BASE, 'z/f.ts': 'z\n' }, w.M0, 'Z');
  const CW = rawCommit(fx, w.repo, { ...BASE, 'w/f.ts': 'w\n' }, w.M0, 'W');
  w.view.add(
    await productVersion(fx.git, w.layout, { id: 'x1', module: 'x', writeScope: ['x/**'], commit: CX, transform: dh, prerequisites: asUnit ? [] : [obj('y1')] }),
    await productVersion(fx.git, w.layout, { id: 'y1', module: 'y', writeScope: ['y/**'], commit: CY, transform: dh }),
    await productVersion(fx.git, w.layout, { id: 'z1', module: 'z', writeScope: ['z/**'], commit: CZ, transform: dh, prerequisites: [obj('x1')] }),
    await productVersion(fx.git, w.layout, { id: 'w1', module: 'w', writeScope: ['w/**'], commit: CW, transform: dh, prerequisites: [obj('z1')] }),
  );
  if (asUnit) w.view.unit(pu('u1'), [ov('x1'), ov('y1')]);
}

test('review r1 #5: one unit member changed on the candidate: every member of the unit and every dependant is not proven', async () => {
  const w = await world();
  try {
    await chain(w, true);
    // The user added a file to y/** on main: only y1's own content changes.
    const M = rawCommit(fx, w.repo, { ...BASE, 'y/other.ts': 'user file in y\n' }, w.M0, 'user adds y/other.ts');
    const manifest = manifestOf(w, obj('w1'));
    assert.deepEqual(manifest.entries.map((e) => e.object.id), ['w1', 'x1', 'y1', 'z1']);
    const c = await candidateOf(w, manifest, M);
    if (c.kind !== 'candidate') assert.fail(c.kind);
    const proof = await checkCandidateProofs({ git: fx.git, repo: w.layout, view: w.view, manifest, candidate: c.candidate });
    const reasons = (idv: string) => proof.notFullyProven.find((x) => x.id === idv)?.reasons;
    assert.deepEqual(proof.proven, [], 'nothing in this closure is proven');
    assert.deepEqual(reasons('y1')?.map((r) => r.kind), ['content-changed']);
    assert.deepEqual(reasons('x1'), [{ kind: 'unit-member-not-proven', unit: 'u1', member: 'y1' }], 'x1 fails with its unit');
    assert.deepEqual(reasons('z1'), [{ kind: 'prerequisite-not-proven', prerequisite: 'x1' }], 'z1 needs x1');
    assert.deepEqual(reasons('w1'), [{ kind: 'prerequisite-not-proven', prerequisite: 'z1' }], 'and w1 needs z1: transitively');
    assert.deepEqual(proof.needsReverification.map((r) => r.id), ['y1']);
  } finally {
    w.ev.dispose();
  }
});

test('review r1 #5: a prerequisite whose evidence no longer matches (its content unchanged) fails its dependants, transitively', async () => {
  const w = await world();
  try {
    await chain(w, false);
    // y1's deciding run read docs/readme.md, which main has changed: y1's own content is the same.
    w.view.setEvidence(obj('y1'), [{ evidence: evi('run-y1'), inputs: [{ path: 'docs/readme.md', sha256: sha256('readme 1\n') }] }]);
    const M = rawCommit(fx, w.repo, { ...BASE, 'docs/readme.md': 'readme 2\n' }, w.M0, 'docs');
    const manifest = manifestOf(w, obj('w1'));
    const c = await candidateOf(w, manifest, M);
    if (c.kind !== 'candidate') assert.fail(c.kind);
    const proof = await checkCandidateProofs({ git: fx.git, repo: w.layout, view: w.view, manifest, candidate: c.candidate });
    const reasons = (idv: string) => proof.notFullyProven.find((x) => x.id === idv)?.reasons;
    assert.deepEqual(reasons('y1')?.map((r) => r.kind), ['evidence-input-mismatch']);
    assert.deepEqual(reasons('x1'), [{ kind: 'prerequisite-not-proven', prerequisite: 'y1' }], 'its content identity did not change, its proof did');
    assert.deepEqual(reasons('z1'), [{ kind: 'prerequisite-not-proven', prerequisite: 'x1' }]);
    assert.deepEqual(reasons('w1'), [{ kind: 'prerequisite-not-proven', prerequisite: 'z1' }]);
    assert.deepEqual(proof.proven, []);
    assert.deepEqual(proof.needsReverification, [], 'no content changed: nothing to re-record');
  } finally {
    w.ev.dispose();
  }
});

test('run inputs come from the evidence convention input:<path> = sha256 (5.6, 7.2)', async () => {
  const { runInputsFromFields } = await import('../src/delivery/proofView.ts');
  const h = sha256('x\n');
  assert.deepEqual(runInputsFromFields({ 'exit': '0', 'input:src/b.ts': h, 'input:a.txt': h, 'test:t1': 'passed' }), [
    { path: 'a.txt', sha256: h },
    { path: 'src/b.ts', sha256: h },
  ]);
  assert.throws(() => runInputsFromFields({ 'input:a': 'not-a-hash' }), /sha256/);
});
