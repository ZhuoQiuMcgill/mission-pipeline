import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitOid, MissionId } from '../src/common/ids.ts';
import { landedVersions, type VersionLine } from '../src/delivery/candidate.ts';
import type { RepoLayout } from '../src/git/objects.ts';
import type { GitExec } from '../src/git/plainGit.ts';
import { recordDelivery, recordLandingPhase } from '../src/memory/index.ts';
import { memoryPorts } from './flow-memory-fixtures.ts';
import { ov } from './delivery-fixtures.test.ts';

const M = 'm1' as MissionId;
const base = 'b'.repeat(40) as GitOid;
const commit = 'c'.repeat(40) as GitOid;
const repo = { gitDir: '/unused', commonDir: '/unused' } as RepoLayout;

test('only a recorded completed ancestral landing skips versions, including earlier specs of the same task', async () => {
  const p = memoryPorts();
  const versions = new Map<string, VersionLine>([['v1', { id: 'v1', tree: null }], ['v2', { id: 'v2', tree: null }], ['v3', { id: 'v3', predecessor: 'v2', tree: null }]]);
  await p.ledger.append('test:products', { events: ['v1', 'v2', 'v3'].map((object, i) => ({ mission: M, line: 'task:impl', event: 'product', key: String(i + 1), body: { object, k: i + 1 } })) });
  p.memory.write({}, (tx) => recordDelivery(tx, { mission: M, delivery: 'one', base, commit, ref: 'refs/mission-pipeline/delivered/m1/one', manifest: tx.data.put(JSON.stringify({ version: 'mp41-delivery/1', entries: [{ id: 'v2' }] })) }));
  let code = 0;
  let calls = 0;
  const git = { async run(args: string[]) { calls++; assert.deepEqual(args.slice(2), ['merge-base', '--is-ancestor', commit, base]); return { code }; } } as unknown as GitExec;
  const read = () => landedVersions(git, repo, p.memory, base, (id) => versions.get(id) ?? null);
  assert.deepEqual([...await read()], [], 'an unlanded delivery is never already laid');
  assert.equal(calls, 0);
  p.memory.write({}, (tx) => recordLandingPhase(tx, { landing: 'test', intent: null, phase: 'done', data: { ref: commit } }));
  code = 1;
  assert.deepEqual([...await read()], [], 'landing outside base ancestry does not count');
  code = 128;
  assert.deepEqual([...await read()], [], 'missing local ancestry never authorizes skipping');
  code = 0;
  const laid = await read();
  assert.deepEqual([...laid].sort(), [ov('v1'), ov('v2')], 'v1 has no predecessor link across the changed spec; a future v3 is not skipped');
});

test('landed placements follow forward re-binds to a fixed point but exclude new work and changed placement', async () => {
  const p = memoryPorts();
  const placement = (n: number, scope = ['f'], origin = base) => ({ commit: n.toString(16).padStart(40, '0') as GitOid, origin, writeScope: scope });
  const a: VersionLine = { id: 'a', tree: placement(10) };
  const b: VersionLine = { id: 'b', tree: placement(11) };
  const versions = new Map<string, VersionLine>([
    ['a', a], ['b', b],
    ['a.b1', { ...a, id: 'a.b1', predecessor: 'a' }],
    ['a.b2', { ...a, id: 'a.b2', predecessor: 'a.b1' }],
    ['b.b1', { ...b, id: 'b.b1', predecessor: 'b' }],
    ['a.2', { id: 'a.2', tree: placement(12), predecessor: 'a' }],
    ['a.spec2', { id: 'a.spec2', tree: placement(13) }],
    ['a.scope', { id: 'a.scope', tree: placement(10, ['g']), predecessor: 'a' }],
    ['a.origin', { id: 'a.origin', tree: placement(10, ['f'], commit), predecessor: 'a' }],
    ['unlanded', { id: 'unlanded', tree: placement(14) }],
    ['unlanded.b1', { id: 'unlanded.b1', tree: placement(14), predecessor: 'unlanded' }],
    ['a.recorded', { ...a, id: 'a.recorded', predecessor: 'a' }],
  ]);
  const content = p.ledger.content.put('recorded re-bind');
  await p.ledger.append('test:rebind-without-flow-event', { records: [{
    kind: 'object.version', object: ov('a.recorded'), objectKind: 'product', mission: M, module: null,
    content, prerequisites: p.ledger.content.putList([]), scope: { paths: ['f'], taskType: 'implementation' }, reviews: [],
    source: { ...placement(10), transform: content }, predecessor: ov('a'),
  }] });
  // Out-of-order successors force the resolver to make another pass.
  await p.ledger.append('test:rebound-products', { events: ['a', 'b', 'a.b2', 'a.b1', 'b.b1', 'a.2', 'a.spec2', 'a.scope', 'a.origin', 'unlanded', 'unlanded.b1'].map((id, i) => ({ mission: M, line: `task:${id}`, event: id.includes('.b') ? 'rebind' : 'product', key: String(i), body: { object: id, product: id } })) });
  p.memory.write({}, (tx) => {
    recordDelivery(tx, { mission: M, delivery: 'stack', base, commit, ref: 'refs/mission-pipeline/delivered/m1/stack', manifest: tx.data.put(JSON.stringify({ version: 'mp41-delivery/1', entries: [{ id: 'a' }, { id: 'b' }] })) });
    recordLandingPhase(tx, { landing: 'stack', intent: null, phase: 'done', data: { ref: commit } });
  });
  const git = {
    async run() { return { code: 0 }; },
    async ok(_args: string[], opts: { input: string }) { return { stdout: Buffer.from(opts.input.trim().split('\n').map((id) => `${id} commit 100`).join('\n') + '\n') }; },
  } as unknown as GitExec;
  assert.deepEqual([...(await landedVersions(git, repo, p.memory, base, (id) => versions.get(id) ?? null))].sort(), ['a', 'a.b1', 'a.b2', 'a.recorded', 'b', 'b.b1']);
});
