// Admission before dispatch (design 6.5; WI-10, WI-13) and the WI-03 overlap scan: machine
// admission from live readings (pure, with a probe), spend admission, the Git LFS check on a
// real repository, and external work overlapping an in-flight write scope.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { discoverRepo } from '../src/git/objects.ts';
import { encodeLfsPointer, lfsPointerFor } from '../src/git/lfs.ts';
import { AttributeEvaluator, readTransformDescription, storeLfsObject } from '../src/git/representation.ts';
import { MachineAdmission, spendAdmits, type MachineProbe } from '../src/scheduler/admission.ts';
import { inScope, overlappingPaths } from '../src/scheduler/external.ts';
import { gitLfsCheck } from '../src/scheduler/lfs.ts';
import { initRepo, makeFixture, rawCommit } from './git-fixtures.test.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, unitSkip, waitFor } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

function probe(memAvailable: number, free = 2 ** 30, used = 0): MachineProbe {
  return {
    read: () => ({ memTotalBytes: 2 * 2 ** 30, memAvailableBytes: memAvailable, cpus: 4, disks: [{ path: '/', totalBytes: 4 * 2 ** 30, freeBytes: free, totalInodes: 1e6, freeInodes: 1e6, blockBytes: 4096 }] }),
    unitMemory: () => used,
  };
}

const MiB = 1024 * 1024;

describe('machine admission (6.5)', () => {
  test('in flight + this peak + reserve <= free + what in-flight units use; a refusal waits unless beyond the machine', () => {
    const a = new MachineAdmission({ memoryReserveBytes: 100 * MiB, diskReserveBytes: 0, inodeReserve: 0 }, probe(500 * MiB));
    assert.deepEqual(a.check({ memoryBytes: 400 * MiB, diskBytes: 0, inodes: 0 }, []), { admitted: true });
    const wait = a.check({ memoryBytes: 300 * MiB, diskBytes: 0, inodes: 0 }, [{ demand: { memoryBytes: 200 * MiB, diskBytes: 0, inodes: 0 }, cgroup: null }]);
    assert.equal(wait.admitted, false);
    assert.equal(!wait.admitted && wait.decision, 'wait');
    const blocked = a.check({ memoryBytes: 3 * 2 ** 30, diskBytes: 0, inodes: 0 }, []);
    assert.equal(!blocked.admitted && blocked.decision, 'resource-blocked');
    // what an in-flight unit already uses is part of its reservation, not extra
    const used = new MachineAdmission({ memoryReserveBytes: 0, diskReserveBytes: 0, inodeReserve: 0 }, probe(100 * MiB, 2 ** 30, 150 * MiB));
    assert.deepEqual(used.check({ memoryBytes: 50 * MiB, diskBytes: 0, inodes: 0 }, [{ demand: { memoryBytes: 200 * MiB, diskBytes: 0, inodes: 0 }, cgroup: '/x' }]), { admitted: true });
  });

  test('spend: spent + in flight + estimate <= limit; unlimited always admits', () => {
    assert.equal(spendAdmits({ limit: null, spent: 1e12, inflight: 1e12 }, 1e12), true);
    assert.equal(spendAdmits({ limit: 1000, spent: 400, inflight: 300 }, 300), true);
    assert.equal(spendAdmits({ limit: 1000, spent: 400, inflight: 300 }, 301), false);
  });
});

describe('WI-03: external work overlapping an in-flight write scope', () => {
  test('patterns: exact path, dir/**, **', () => {
    assert.equal(inScope('src/a.ts', 'src/a.ts'), true);
    assert.equal(inScope('src/sub/b.ts', 'src/**'), true);
    assert.equal(inScope('srcx/b.ts', 'src/**'), false);
    assert.equal(inScope('anything', '**'), true);
    assert.deepEqual(overlappingPaths(['a/x', 'b/y', 'c'], ['a/**', 'c']), ['a/x', 'c']);
  });

  test('a scan finding overlap raises one WI-03 notice per finding, and does nothing else', async () => {
    const e = makeEnv('wi03');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, {
      externalWork: { scan: async () => [{ worktree: '/home/u/agent-wt', branch: 'agent/feature', paths: ['src/core/a.ts', 'docs/x.md'], source: 'codex worktree' }] },
    });
    try {
      await s.start({ startLoops: false });
      s.submit({ ...hostTask(e, { task: 'core' }), writeScope: ['src/core/**'] });
      s.submit({ ...hostTask(e, { task: 'ui' }), writeScope: ['src/ui/**'] });
      const found = await s.scanExternalWork();
      assert.equal(found.length, 1);
      assert.deepEqual(found[0]?.paths, ['src/core/a.ts']);
      assert.deepEqual(found[0]?.tasks, ['core']);
      await s.scanExternalWork();
      const notices = s.cp.alerts().filter((a) => a.category === 'external-work-overlap');
      assert.equal(notices.length, 1, 'one notice for the same finding');
      assert.equal(notices[0]?.wi, 'WI-03');
      assert.match(notices[0]?.defaultAction ?? '', /no merge, no adoption/);
      assert.deepEqual(s.tasks.all().map((t) => t.state), ['queued', 'queued'], 'nothing else changes');
    } finally {
      await s.close();
      await l.close();
    }
  });
});

const fx = makeFixture('sched-lfs');
after(() => fx.cleanup());

describe('WI-13: Git LFS objects must be local before dispatch (7.1 v34)', { skip: unitSkip, timeout: 120_000 }, () => {
  test('a task whose snapshot needs a missing LFS object is held, with a notice to fetch; it runs once the object is there; other work continues', async () => {
    const repo = initRepo(fx, 'lfs');
    const data = randomBytes(3000);
    const commit = rawCommit(fx, repo, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'big.bin': encodeLfsPointer(lfsPointerFor(data)) }, null, 'lfs');
    const layout = await discoverRepo(fx.git, repo);
    const attributes = await AttributeEvaluator.create(fx.git, layout, await readTransformDescription(fx.git, layout, fx.user), fx.root);
    const e = makeEnv('lfs');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, { lfsCheck: gitLfsCheck({ git: fx.git, repo: layout, attributes }) });
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'needs-lfs', snapshot: { repo, commit } }));
      const other = s.submit(hostTask(e, { task: 'plain' }));
      await waitFor(() => other.state === 'done', 30_000, 'other work continues');
      assert.equal(t.launches.length, 0, 'not dispatched');
      assert.match(t.note ?? '', /git lfs fetch/);
      const notice = s.cp.alerts().find((a) => a.category === 'lfs-objects-missing');
      assert.equal(notice?.wi, 'WI-13');
      // the user fetches the object
      const tmp = join(fx.root, 'obj');
      writeFileSync(tmp, data);
      storeLfsObject(layout.commonDir, tmp, lfsPointerFor(data));
      await waitFor(() => t.state === 'done', 30_000, 'dispatched once the object is local');
    } finally {
      attributes.dispose();
      await s.close();
      await l.close();
    }
  });
});
