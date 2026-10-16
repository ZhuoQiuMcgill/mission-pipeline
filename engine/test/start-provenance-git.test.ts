import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCandidate, checkCandidateProofs, startHolds } from '../src/delivery/candidate.ts';
import { buildManifest } from '../src/delivery/manifest.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { AttributeEvaluator, readTransformDescription, transformDescriptionHash } from '../src/git/representation.ts';
import { FakeProofView, obj, productVersion } from './delivery-fixtures.test.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit } from './git-fixtures.test.ts';

test('real trees: A1 start recorded as A2 fails delivery; fresh and continued A2 starts hold', async () => {
  const fx = makeFixture('start-holds');
  let attributes: AttributeEvaluator | undefined;
  try {
    const dir = initRepo(fx, 'repo');
    const baseFiles = { 'a/f': '0\n', 'b/f': '0\n' };
    const base = rawCommit(fx, dir, baseFiles, null, 'base');
    checkoutMain(fx, dir, base);
    const a1 = rawCommit(fx, dir, { ...baseFiles, 'a/f': '1\n' }, base, 'A1');
    const a2 = rawCommit(fx, dir, { ...baseFiles, 'a/f': '2\n' }, base, 'A2');
    const bad = rawCommit(fx, dir, { 'a/f': '1\n', 'b/f': 'B\n' }, a1, 'B from A1');
    const good = rawCommit(fx, dir, { 'a/f': '2\n', 'b/f': 'B\n' }, a2, 'B from A2');
    const next = rawCommit(fx, dir, { 'a/f': '2\n', 'b/f': 'B2\n' }, good, 'continue B');
    const repo = await discoverRepo(fx.git, dir);
    const description = await readTransformDescription(fx.git, repo);
    const transform = transformDescriptionHash(description);
    const product = (id: string, commit: typeof base, scope: string[], prerequisites = [] as ReturnType<typeof obj>[]) => productVersion(fx.git, repo, { id, module: id, commit, writeScope: scope, transform, prerequisites });
    const a = await product('a2', a2, ['a/**']);
    const b = await product('bad', bad, ['b/**'], [obj('a2')]);
    const g = await product('good', good, ['b/**'], [obj('a2')]);
    const view = new FakeProofView().add(a, b, g);
    assert.deepEqual(await startHolds(fx.git, repo, view, b), { holds: false, missing: [{ prerequisite: 'a2', path: 'a/f' }] });
    assert.deepEqual(await startHolds(fx.git, repo, view, g), { holds: true, missing: [] });
    const continued = { ...await product('next', next, ['b/**'], [obj('a2')]), predecessor: g.id };
    assert.deepEqual(await startHolds(fx.git, repo, view, continued), { holds: true, missing: [] });
    const built = buildManifest(view, [obj('bad')]);
    assert.equal(built.kind, 'manifest');
    if (built.kind !== 'manifest') return;
    attributes = await AttributeEvaluator.create(fx.git, repo, description, fx.root);
    const ident = { name: 'test', email: 'test@example.invalid', date: '1700000200 +0000' };
    const candidate = await buildCandidate({ git: fx.git, repo, manifest: built.manifest, base, attributes, snapshotDir: join(fx.root, 'candidate'), message: 'delivery', author: ident, committer: ident, versionOf: (id) => view.object(id) });
    assert.equal(candidate.kind, 'candidate');
    if (candidate.kind !== 'candidate') return;
    const proof = await checkCandidateProofs({ git: fx.git, repo, view, manifest: built.manifest, candidate: candidate.candidate });
    assert.deepEqual(proof.proven, ['a2']);
    assert.deepEqual(proof.notFullyProven, [{ id: 'bad', reasons: [{ kind: 'start-lacks-prerequisite', missing: [{ prerequisite: 'a2', path: 'a/f' }] }] }]);
  } finally {
    attributes?.dispose();
    fx.cleanup();
  }
});
