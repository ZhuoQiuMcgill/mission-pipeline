// Ruling 2 with object-level git responses: no git process or projected trees.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../src/common/hash.ts';
import type { GitOid } from '../src/common/ids.ts';
import { checkCandidateProofs, type Candidate } from '../src/delivery/candidate.ts';
import { buildManifest, type DeliveryManifest } from '../src/delivery/manifest.ts';
import { writeScopeIdentity } from '../src/delivery/writeScope.ts';
import type { RepoLayout, TreeEntry } from '../src/git/objects.ts';
import type { GitExec } from '../src/git/plainGit.ts';
import { FakeProofView, evi, fakeObject, obj, ov, pu } from './delivery-fixtures.test.ts';

const oid = (n: number) => n.toString(16).padStart(40, '0') as GitOid;
const tree = (files: Record<string, number>): TreeEntry[] => Object.entries(files).map(([path, n]) => ({ path, mode: '100644', type: 'blob', oid: oid(n) }));
const repo: RepoLayout = { worktree: null, gitDir: '/unused', commonDir: '/unused', bare: true, objectFormat: 'sha1' };

async function proof(o: { final?: Record<string, number>; badTop?: boolean; unrelatedDeletion?: boolean; evidence?: boolean; topOnlyInput?: boolean; noShared?: boolean } = {}) {
  const a = tree({ f: 1, other: 3 });
  const b = tree({ f: o.noShared ? 1 : 0, other: 3, ...(o.topOnlyInput ? { g: 2 } : {}) });
  const final = tree(o.final ?? { f: o.noShared ? 1 : 0, other: 3, ...(o.topOnlyInput ? { g: 2 } : {}) });
  const trees = new Map([[oid(10), a], [oid(11), b], [oid(12), final]]);
  const git = { async ok(args: readonly string[]) {
    if (args.includes('--batch-check')) return { stdout: Buffer.from(`${oid(10)} commit 100\n`) };
    assert.ok(args.includes('ls-tree'), 'proof only reads actual trees');
    const entries = trees.get(args.at(-1) as GitOid);
    assert.ok(entries);
    return { stdout: Buffer.from(entries.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}\0`).join('')) };
  } } as unknown as GitExec;
  const version = (id: string, commit: GitOid, entries: TreeEntry[], prerequisites: ReturnType<typeof obj>[] = []) => {
    const scope = id === 'b' ? o.noShared ? ['g'] : ['f', ...(o.topOnlyInput ? ['g'] : [])] : ['f', 'other'];
    const v = fakeObject(id, { module: id, paths: scope, prerequisites });
    return { ...v, content: writeScopeIdentity(entries, scope), tree: { ...v.tree!, commit, origin: oid(10), writeScope: scope } };
  };
  const view = new FakeProofView().add(version('a', oid(10), a), version('b', oid(11), b, [obj('a')]));
  if (o.badTop) view.setLabel(obj('b'), 'unaccepted');
  if (o.evidence) {
    view.setEvidence(obj('a'), [{ evidence: evi('a-run'), inputs: [{ path: 'f', sha256: sha256('1') }] }]);
    view.setEvidence(obj('b'), [{ evidence: evi('b-run'), inputs: [{ path: 'f', sha256: sha256('0') }] }]);
  }
  if (o.topOnlyInput) view.setEvidence(obj('a'), [{ evidence: evi('a-run'), inputs: [{ path: 'f', sha256: sha256('1') }, { path: 'g', sha256: sha256('old') }] }]);
  const built = buildManifest(view, [obj('b')]);
  assert.equal(built.kind, 'manifest');
  const manifest = (built as { manifest: DeliveryManifest }).manifest;
  if (o.unrelatedDeletion) {
    // Reproduce an old manifest whose deletion was absent from its cached paths.
    const c = { ...version('c', oid(13), [], []), paths: [], content: writeScopeIdentity([], ['f']), tree: { ...view.object(ov('a'))!.tree!, commit: oid(13), writeScope: ['f'] } };
    trees.set(oid(13), []);
    view.add(c);
    (manifest.entries as unknown as Array<unknown>).push({ object: c, unit: null, label: 'proven', requiredBy: [], chain: [] });
  }
  const dir = mkdtempSync(join(tmpdir(), 'final-'));
  try {
    if (final.some((e) => e.path === 'f')) writeFileSync(join(dir, 'f'), String(o.final?.f ?? (o.noShared ? 1 : 0)));
    if (o.topOnlyInput) writeFileSync(join(dir, 'g'), 'new');
    // Deliberately poisoned overlay metadata: proof must never reconstruct from it.
    const candidate = { commit: oid(12), snapshotDir: dir, changedPaths: [], layers: [{ version: ov('a'), found: new Map() }, { version: ov('b'), found: new Map([['f', { mode: '100644', oid: oid(1) }]]) }] } as unknown as Candidate;
    return await checkCandidateProofs({ git, repo, view, manifest, candidate });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('A 0→1 / B 1→0: B delivers f and its integrated review; A owns its remaining paths', async () => {
  const p = await proof({ evidence: true });
  assert.deepEqual(p.proven, ['a', 'b']);
  assert.deepEqual(p.deliveredBy, [{ version: 'a', path: 'f', by: 'b' }]);
  assert.deepEqual(p.notFullyProven, []);
});

test('a change of the final tree fails the owner and cannot fall back to a lower version', async () => {
  const p = await proof({ final: { f: 9, other: 3 } });
  assert.deepEqual(p.proven, []);
  assert.ok(p.notFullyProven.find((v) => v.id === 'b')?.reasons.some((r) => r.kind === 'content-changed'));
  assert.ok(p.notFullyProven.find((v) => v.id === 'a')?.reasons.some((r) => r.kind === 'delivering-version-not-proven'));
});

test('an unproven top leaves the shared path unproven', async () => {
  const p = await proof({ badTop: true, evidence: true });
  assert.deepEqual(p.proven, []);
  assert.deepEqual(p.deliveredBy, [{ version: 'a', path: 'f', by: 'b' }]);
  assert.ok(p.notFullyProven.find((v) => v.id === 'a')?.reasons.some((r) => r.kind === 'delivering-version-not-proven' && r.path === 'f'));
});

for (const badTop of [false, true]) test(`an input outside A's write scope is checked on the final tree with B ${badTop ? 'unaccepted' : 'proven'}`, async () => {
  const p = await proof({ topOnlyInput: true, badTop });
  assert.ok(!p.proven.includes(ov('a')));
  const reasons = p.notFullyProven.find((v) => v.id === 'a')!.reasons;
  assert.ok(reasons.some((r) => r.kind === 'evidence-input-mismatch' && r.path === 'g'));
  // Both hashes differ from the final tree; only a reported handover can skip an input.
  for (const path of ['f', 'g']) {
    if (!reasons.some((r) => r.kind === 'evidence-input-mismatch' && r.path === path)) {
      assert.ok(p.deliveredBy?.some((d) => d.version === 'a' && d.path === path), `every skipped input (${path}) appears in deliveredBy`);
    }
  }
  assert.deepEqual(p.deliveredBy, [{ version: 'a', path: 'f', by: 'b' }]);
});

for (const badTop of [false, true]) test(`reviewer's disjoint f/g case: A's run input g fails with B ${badTop ? 'unaccepted' : 'proven'}`, async () => {
  const p = await proof({ topOnlyInput: true, noShared: true, badTop });
  assert.ok(!p.proven.includes(ov('a')));
  assert.ok(p.notFullyProven.find((v) => v.id === 'a')?.reasons.some((r) => r.kind === 'evidence-input-mismatch' && r.path === 'g'));
  assert.deepEqual(p.deliveredBy, [], 'no input can be silently handed over outside the write scope');
});

test('an unrelated deletion cannot be masked by removing a stack layer', async () => {
  const p = await proof({ unrelatedDeletion: true, final: { other: 3 } });
  assert.deepEqual(p.proven, ['c']);
  assert.ok(p.notFullyProven.some((v) => v.id === 'b' && v.reasons.some((r) => r.kind === 'content-changed')));
});

test('unrelated overlapping versions and mutually dependent overlapping unit members are incompatible', () => {
  const view = new FakeProofView().add(fakeObject('a', { paths: ['f'] }), fakeObject('b', { paths: ['f'] }));
  assert.equal(buildManifest(view, [obj('a'), obj('b')]).kind, 'incompatible');
  view.add(fakeObject('a', { paths: ['f'], prerequisites: [obj('b')] }), fakeObject('b', { paths: ['f'], prerequisites: [obj('a')] })).unit(pu('u'), [ov('a'), ov('b')]);
  assert.equal(buildManifest(view, [obj('a')]).kind, 'incompatible');
});

test('a lower version still checks its unshared paths on the final tree', async () => {
  const p = await proof({ final: { f: 0, other: 9 } });
  assert.deepEqual(p.proven, []);
  assert.ok(p.notFullyProven.some((v) => v.id === 'a' && v.reasons.some((r) => r.kind === 'content-changed')));
});


test('a delivery selecting A2 cannot prove B that was dispatched on A1', () => {
  const view = new FakeProofView().add(
    fakeObject('a1', { module: 'a', paths: ['a/f'] }),
    fakeObject('a2', { module: 'a', paths: ['a/f'] }),
    fakeObject('b', { paths: ['b/f'], prerequisites: [obj('a1')] }),
  );
  assert.equal(buildManifest(view, [obj('a2'), obj('b')]).kind, 'incompatible');
});
