// Code review r1, findings 1 and 2 (design 3.11 "不删除用户的数据", 6.4, 7.1 v35): cleanup deletes
// only what it registered, inside its roots, without following symbolic links, bound to the
// identity the resource had; it releases in dependency order (mount -> image -> paths) and keeps
// a resource listed (and so counted) while something still holds it.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { LaunchId } from '../src/common/ids.ts';
import { cleanupPass, completeCleanup, formatCleanupResource, identityAt, parseCleanupResource, processesHolding, recordIdentities, scanCleanupFiles, writeCleanupFile } from '../src/exec/cleanup.ts';
import type { DurableOps } from '../src/exec/durable.ts';
import { findFuse2fs } from '../src/exec/platform.ts';
import { createDiskImage, isMountPoint, mountDiskImage, unmountDiskImage } from '../src/exec/sandbox.ts';

const EXTRACTED_FUSE2FS = process.env['MP_TEST_FUSE2FS']; // an unpacked fuse2fs for machines without one on PATH
const fuse2fs = findFuse2fs() ?? findFuse2fs(EXTRACTED_FUSE2FS);
const fuseSkip = fuse2fs !== null && existsSync('/dev/fuse') ? false : 'needs fuse2fs and /dev/fuse';

const dirs: string[] = [];
const mounts: string[] = [];
const procs: ChildProcess[] = [];
function tmp(prefix = 'mp-cleanup-safety-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(async () => {
  for (const p of procs) p.kill('SIGKILL');
  for (const m of mounts) if (isMountPoint(m)) await unmountDiskImage(m).catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('finding 1: no deletion outside the roots, through a link, or of a replaced entry', () => {
  test("the reviewer's repro: a symlinked parent inside the root does not lead the deletion outside", async () => {
    const root = tmp();
    const allowed = join(root, 'allowed');
    const other = join(root, 'protected');
    mkdirSync(allowed);
    mkdirSync(other);
    writeFileSync(join(other, 'valuable'), 'protected');
    symlinkSync(other, join(allowed, 'link'));
    const r = `path:${join(allowed, 'link', 'valuable')}`;
    const pass = await cleanupPass([r], { roots: [allowed] });
    assert.equal(readFileSync(join(other, 'valuable'), 'utf8'), 'protected', 'the file outside the root survives');
    assert.deepEqual(pass.left, [r], 'the resource stays pending');
    assert.equal(pass.refusals[0]?.reason, 'path-changed');
    // and through a deeper chain, or a symlinked root's child
    mkdirSync(join(allowed, 'real'));
    symlinkSync(join(other), join(allowed, 'real', 'deeper'));
    assert.deepEqual(await completeCleanup([`path:${join(allowed, 'real', 'deeper', 'valuable')}`], { roots: [allowed] }), [`path:${join(allowed, 'real', 'deeper', 'valuable')}`]);
    assert.equal(existsSync(join(other, 'valuable')), true);
  });

  test('a root replaced by a symlink: the link itself goes, never its target; with an identity, nothing goes', async () => {
    const base = tmp();
    const target = join(base, 'home');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'k');
    const scratch = join(base, 'scratch');
    mkdirSync(scratch);
    const bound = recordIdentities([`path:${scratch}`], { roots: [scratch] });
    assert.match(bound[0] as string, /^path@\d+\.\d+:/);
    rmSync(scratch, { recursive: true });
    symlinkSync(target, scratch);
    const withId = await cleanupPass(bound, { roots: [scratch] });
    assert.deepEqual(withId.left, bound, 'identity-bound: refused');
    assert.equal(withId.refusals[0]?.reason, 'identity-mismatch');
    assert.equal(existsSync(scratch), true);
    const withoutId = await cleanupPass([`path:${scratch}`], { roots: [scratch] });
    assert.equal(withoutId.refusals[0]?.reason, 'identity-unknown', 'without an identity nothing is deleted (r2 finding 1)');
    assert.equal(existsSync(scratch), true);
    assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'k', 'its target is untouched');
  });

  test('a directory replaced by another one at the same path is not deleted (identity mismatch), and is reported', async () => {
    const root = tmp();
    const d = join(root, 'session');
    mkdirSync(d);
    const [bound] = recordIdentities([`path:${d}`], { roots: [root] });
    renameSync(d, join(root, 'moved'));
    mkdirSync(d);
    writeFileSync(join(d, 'somebody-elses'), 'x');
    const pass = await cleanupPass([bound as string], { roots: [root] });
    assert.deepEqual(pass.left, [bound]);
    assert.equal(pass.refusals[0]?.reason, 'identity-mismatch');
    assert.equal(readFileSync(join(d, 'somebody-elses'), 'utf8'), 'x');
    // listed twice (with and without identity, e.g. derived from the config): the identity binds both
    const both = await completeCleanup([`path:${d}`, bound as string], { roots: [root] });
    assert.equal(both.length, 2);
    assert.equal(existsSync(join(d, 'somebody-elses')), true);
  });

  test('inside a deleted tree, links are removed as links; files outside stay; the right identity deletes', async () => {
    const root = tmp();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'k');
    const d = join(root, 'scratch');
    mkdirSync(join(d, 'a', 'b'), { recursive: true });
    writeFileSync(join(d, 'a', 'b', 'f'), 'x');
    symlinkSync(outside, join(d, 'a', 'to-outside'));
    symlinkSync(join(outside, 'keep'), join(d, 'file-link'));
    const [bound] = recordIdentities([`path:${d}`], { roots: [d] });
    assert.deepEqual(await completeCleanup([bound as string], { roots: [d] }), []);
    assert.equal(existsSync(d), false);
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'k');
  });

  test('outside every root, or a root of "/": never touched', async () => {
    const inside = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const r = [`path:${join(outside, 'keep.txt')}`];
    assert.deepEqual(await completeCleanup(r, { roots: [inside, '/', ''] }), r);
    assert.equal(existsSync(join(outside, 'keep.txt')), true);
  });

  test('concurrent replacement: a directory flipping to a symlink during cleanup never exposes the outside', async () => {
    const root = tmp();
    const protectedDir = join(root, 'protected');
    mkdirSync(protectedDir);
    for (let i = 0; i < 20; i++) writeFileSync(join(protectedDir, `p${i}`), 'protected');
    const scratch = join(root, 'scratch');
    for (let round = 0; round < 25; round++) {
      mkdirSync(join(scratch, 'sub', 'deep'), { recursive: true });
      for (let i = 0; i < 30; i++) writeFileSync(join(scratch, 'sub', 'deep', `f${i}`), 'x');
      // the racer swaps scratch/sub with a symlink to the protected directory, back and forth
      const racer = spawn(
        '/bin/sh',
        ['-c', `i=0; while [ $i -lt 400 ]; do mv ${scratch}/sub ${scratch}/sub.real 2>/dev/null; ln -s ${protectedDir} ${scratch}/sub 2>/dev/null; rm -f ${scratch}/sub 2>/dev/null; mv ${scratch}/sub.real ${scratch}/sub 2>/dev/null; i=$((i+1)); done`],
        { stdio: 'ignore' },
      );
      procs.push(racer);
      const bound = recordIdentities([`path:${join(scratch, 'sub')}`, `path:${join(scratch, 'sub', 'deep')}`], { roots: [scratch] });
      for (let k = 0; k < 4; k++) await completeCleanup(bound, { roots: [scratch] });
      await new Promise<void>((r) => racer.once('exit', () => r()));
      rmSync(scratch, { recursive: true, force: true });
    }
    for (let i = 0; i < 20; i++) assert.equal(readFileSync(join(protectedDir, `p${i}`), 'utf8'), 'protected', `protected/p${i}`);
  });
});

describe('finding 2: dependency order; a held resource stays listed', () => {
  test('an image another process still holds open is kept (its space is not free yet)', async () => {
    const root = tmp();
    const image = join(root, 'unit.img');
    writeFileSync(image, Buffer.alloc(1 << 20, 0x7b));
    const holder = spawn('/bin/sh', ['-c', `exec 3<${image}; exec sleep 30`], { stdio: 'ignore' });
    procs.push(holder);
    const id = identityAt(image, [root]);
    assert.ok(id !== null);
    for (let i = 0; i < 50 && processesHolding(id).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(processesHolding(id).includes(holder.pid as number));
    const bound = recordIdentities([`image:${image}`], { roots: [root] });
    const pass = await cleanupPass(bound, { roots: [root], holderWaitMs: 200 });
    assert.deepEqual(pass.left, bound);
    assert.equal(pass.refusals[0]?.reason, 'busy');
    assert.equal(existsSync(image), true);
    holder.kill('SIGKILL');
    await new Promise<void>((r) => holder.once('exit', () => r()));
    assert.deepEqual(await completeCleanup(bound, { roots: [root] }), []);
    assert.equal(existsSync(image), false);
  });

  test('a directory holding a remaining resource waits for it', async () => {
    const root = tmp();
    const session = join(root, 'session');
    mkdirSync(session);
    const image = join(session, 'unit.img');
    writeFileSync(image, 'img');
    const fd = openSync(image, 'r');
    const bound = recordIdentities([`path:${session}`, `image:${image}`], { roots: [session] });
    try {
      const left = await completeCleanup(bound, { roots: [session], holderWaitMs: 200 });
      assert.deepEqual(left, bound);
      assert.equal(existsSync(image), true, 'the session directory was not deleted around the held image');
    } finally {
      closeSync(fd);
    }
    assert.deepEqual(await completeCleanup(bound, { roots: [session] }), []);
    assert.equal(existsSync(session), false);
  });

  test("the reviewer's repro, on a real FUSE mount: a busy unmount keeps the mount, the image and the directory", { skip: fuseSkip }, async () => {
    const root = tmp();
    const image = join(root, 'image');
    const mount = join(root, 'mount');
    mkdirSync(mount);
    mounts.push(mount);
    await createDiskImage({ path: image, bytes: 16 << 20, inodes: 64 });
    await mountDiskImage(image, mount, fuse2fs as string);
    writeFileSync(join(mount, 'inside'), 'data');
    const busy = spawn('sleep', ['60'], { cwd: mount, stdio: 'ignore' });
    procs.push(busy);
    const allocated = statSync(image).blocks * 512;
    const resources = recordIdentities([`mount:${mount}`, `image:${image}`, `path:${root}`], { roots: [root] });
    const pass = await cleanupPass(resources, { roots: [root] });
    assert.deepEqual(pass.left, resources, 'nothing is released while the mount is busy');
    assert.equal(isMountPoint(mount), true);
    assert.equal(existsSync(image), true, 'the image stays');
    assert.ok(statSync(image).blocks * 512 >= allocated, 'and keeps its space counted');
    assert.deepEqual(
      pass.refusals.map((r) => [r.resource.split(':')[0]?.split('@')[0], r.reason]),
      [
        ['mount', 'busy'],
        ['image', 'busy'],
        ['path', 'busy'],
      ],
    );
    busy.kill('SIGKILL');
    await new Promise<void>((r) => busy.once('exit', () => r()));
    let left = await completeCleanup(resources, { roots: [root] });
    assert.equal(isMountPoint(mount), false, 'once free: unmounted');
    if (left.length > 0) {
      // another namespace (a concurrently running sandbox holder) kept a copy of the FUSE mount,
      // so fuse2fs still holds the image: it stays pending, the directory with it; a unit's
      // fuse2fs ends with the unit's cgroup, this one was started by the test
      assert.deepEqual(left, resources.slice(1));
      assert.equal(existsSync(image), true);
      for (const pid of processesHolding(identityAt(image, [root]) as never)) process.kill(pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      left = await completeCleanup(resources, { roots: [root] });
    }
    assert.deepEqual(left, [], 'then the image, then the directory');
    assert.equal(existsSync(root), false);
  });

  test('a mount point inside a directory to delete (not listed) refuses the directory instead of descending', { skip: fuseSkip }, async () => {
    const root = tmp();
    const image = join(root, 'other.img');
    const mount = join(root, 'scratch', 'mnt');
    mkdirSync(mount, { recursive: true });
    mounts.push(mount);
    await createDiskImage({ path: image, bytes: 16 << 20, inodes: 64 });
    await mountDiskImage(image, mount, fuse2fs as string);
    writeFileSync(join(mount, 'precious'), 'p');
    const pass = await cleanupPass(recordIdentities([`path:${join(root, 'scratch')}`], { roots: [join(root, 'scratch')] }), { roots: [join(root, 'scratch')] });
    assert.equal(pass.refusals[0]?.reason, 'mount-inside');
    assert.equal(readFileSync(join(mount, 'precious'), 'utf8'), 'p');
    await unmountDiskImage(mount);
  });
});

describe('finding 12: cleanup state files are written into a durable directory chain', () => {
  test('the cleanup directory and its parent are synced before the file is renamed into it', () => {
    const state = join(tmp(), 'state');
    const log: string[] = [];
    const ops: DurableOps = {
      mkdir: (d) => {
        mkdirSync(d);
        log.push(`mkdir ${d}`);
      },
      fsyncDir: (d) => log.push(`fsync ${d}`),
      before: (step, p) => log.push(`${step} ${p}`),
    };
    writeCleanupFile(state, { format: 'mp4.unit-cleanup.v1', launch: 'L1' as LaunchId, state: 'pending', resources: [], recorded: false, at: 'now' }, ops);
    const cleanup = join(state, 'cleanup');
    const at = (line: string): number => {
      const i = log.indexOf(line);
      assert.ok(i >= 0, `${line} in\n${log.join('\n')}`);
      return i;
    };
    const rename = at(`rename ${join(cleanup, 'L1.json')}`);
    assert.ok(at(`mkdir ${state}`) < rename);
    assert.ok(at(`mkdir ${cleanup}`) < rename);
    assert.ok(log.lastIndexOf(`fsync ${state}`) < rename, 'the new cleanup/ entry in the state directory is durable first');
    assert.ok(log.indexOf(`fsync ${cleanup}`) < rename);
    assert.ok(log.lastIndexOf(`fsync ${cleanup}`) > rename, 'and the file name after the rename');
    assert.equal(scanCleanupFiles(state).length, 1);
  });

  test('resource strings round-trip with their identity; a bad identity is refused', () => {
    const r = parseCleanupResource('path@2049.131075:/tmp/x:y');
    assert.deepEqual(r, { kind: 'path', path: '/tmp/x:y', identity: { dev: '2049', ino: '131075' } });
    assert.equal(formatCleanupResource(r), 'path@2049.131075:/tmp/x:y');
    for (const bad of ['mount@1.2:/tmp/m', 'holder@1.2:1:2:ab', 'path@x.2:/tmp/a', 'path@1:/tmp/a', 'path:/tmp/a/']) assert.throws(() => parseCleanupResource(bad), bad);
  });
});
