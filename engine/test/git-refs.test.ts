import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type MissionId, type OpId, type GitOid } from '../src/common/ids.ts';
import { discoverRepo, gitOid, type RepoLayout } from '../src/git/objects.ts';
import { spawn } from 'node:child_process';
import {
  asProgramRef,
  classifyProgramRef,
  createProgramRef,
  deliveryRef,
  programRef,
  readRefState,
  recoverProgramRef,
  removeStaleRefLock,
  type ProgramRefName,
} from '../src/git/refs.ts';
import { GitTimeoutError, identifyProcess, isProcessAlive, type ProcessIdentity } from '../src/git/safeGit.ts';
import { initRepo, makeFixture, rawCommit, writeExecutable, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
let repo: string;
let layout: RepoLayout;
let A: GitOid;
let B: GitOid;

before(async () => {
  fx = makeFixture('refs');
  repo = initRepo(fx);
  A = rawCommit(fx, repo, { 'f.txt': 'one\n' }, null, 'A');
  B = rawCommit(fx, repo, { 'f.txt': 'two\n' }, A, 'B');
  fx.raw(['update-ref', 'refs/heads/main', A], repo);
  layout = await discoverRepo(fx.git, repo);
});
after(() => fx.cleanup());

test('delivery refs live under refs/mission-pipeline/ with ids encoded into valid ref components', async () => {
  const name = deliveryRef(id<MissionId>('m:1'), id<OpId>('op.2..x'));
  assert.equal(name, 'refs/mission-pipeline/delivered/m%3A1/op%2E2%2E%2Ex');
  assert.equal(fx.rawStatus(['check-ref-format', name], repo).code, 0);
  assert.throws(() => asProgramRef('refs/heads/main'), /not a program ref/);
  assert.throws(() => asProgramRef('refs/mission-pipeline/a:b'), /encoded alphabet/);
  await assert.rejects(() => createProgramRef(fx.git, layout, 'refs/heads/sneaky' as ProgramRefName, B), /not a program ref/);
  assert.equal(fx.rawStatus(['rev-parse', '--verify', '-q', 'refs/heads/sneaky'], repo).code, 1);
});

test('create-only: created once; the same target again is already done; another target is reported, never overwritten', async () => {
  const name = deliveryRef(id<MissionId>('m1'), id<OpId>('op1'));
  const first = await createProgramRef(fx.git, layout, name, B);
  assert.equal(first.kind, 'created');
  const again = await createProgramRef(fx.git, layout, name, B);
  assert.equal(again.kind, 'exists-same');
  const other = await createProgramRef(fx.git, layout, name, A);
  assert.equal(other.kind, 'exists-different');
  assert.deepEqual(await readRefState(fx.git, layout, name), { kind: 'direct', oid: B });
  await assert.rejects(() => createProgramRef(fx.git, layout, programRef('x'), gitOid('f'.repeat(40))), /not a commit/);
});

test('recovery classification (6.1): ref == B is done, absent is not done, anything else is tampered', async () => {
  const done = programRef('delivered', 'm2', 'op-done');
  assert.equal((await createProgramRef(fx.git, layout, done, B)).kind, 'created');
  assert.deepEqual(await classifyProgramRef(fx.git, layout, done, B), { kind: 'done' });

  const absent = programRef('delivered', 'm2', 'op-absent');
  assert.deepEqual(await classifyProgramRef(fx.git, layout, absent, B), { kind: 'not-done', staleLock: null });

  const moved = programRef('delivered', 'm2', 'op-moved');
  assert.equal((await createProgramRef(fx.git, layout, moved, B)).kind, 'created');
  fx.raw(['update-ref', moved, A], repo); // someone outside the program changed it
  const t = await classifyProgramRef(fx.git, layout, moved, B);
  assert.equal(t.kind, 'tampered');
  assert.deepEqual(t.kind === 'tampered' ? t.state : null, { kind: 'direct', oid: A });

  const sym = programRef('delivered', 'm2', 'op-sym');
  fx.raw(['symbolic-ref', sym, 'refs/heads/main'], repo);
  const s = await classifyProgramRef(fx.git, layout, sym, B);
  assert.equal(s.kind, 'tampered');
  assert.deepEqual(s.kind === 'tampered' ? s.state : null, { kind: 'symbolic', target: 'refs/heads/main' });

  const broken = programRef('delivered', 'm2', 'op-broken');
  mkdirSync(join(layout.commonDir, 'refs/mission-pipeline/delivered/m2'), { recursive: true });
  writeFileSync(join(layout.commonDir, broken), 'not an object id\n');
  assert.equal((await classifyProgramRef(fx.git, layout, broken, B)).kind, 'tampered');
});

test('creation runs no hook: the program writer (files backend) writes exactly the object id, fsynced (core.fsync=committed semantics)', async () => {
  const mark = join(fx.root, 'reftx-mark');
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeExecutable(join(hooks, 'reference-transaction'), `#!/bin/sh\necho "$1" >> '${mark}'\n`);
  try {
    fx.raw(['update-ref', 'refs/control/x', A], repo); // control: raw git runs the hook
    assert.match(readFileSync(mark, 'utf8'), /committed/);
    writeFileSync(mark, '');
    const r = await createProgramRef(fx.git, layout, programRef('delivered', 'm3', 'op1'), B);
    assert.equal(r.kind, 'created');
    assert.equal(readFileSync(mark, 'utf8'), '', 'reference-transaction hook did not run');
    if (r.kind === 'created') {
      // Files backend: not `git update-ref` but the program's writer process (review r1 #2), run through SafeGit's
      // process machinery (deadline, identity); the ref file holds exactly the object id.
      assert.ok(r.result.argv.includes('mission-pipeline-ref-writer'), r.result.argv.join(' '));
      assert.equal(readFileSync(join(layout.commonDir, programRef('delivered', 'm3', 'op1')), 'utf8'), `${B}\n`);
    }
  } finally {
    writeFileSync(join(hooks, 'reference-transaction'), '');
  }
});

test('review r2 #3: a lock the program cannot prove it created is never removed, even with no writer of its own around', async () => {
  const name = programRef('delivered', 'm4', 'op1');
  mkdirSync(join(layout.commonDir, 'refs/mission-pipeline/delivered/m4'), { recursive: true });
  const lock = join(layout.commonDir, `${name}.lock`);
  writeFileSync(lock, '');
  const recordDir = join(fx.root, 'records-m4');
  const blocked = await createProgramRef(fx.git, layout, name, B, { intentToken: 'intent-m4', recordDir });
  assert.equal(blocked.kind, 'failed');
  const rec = await classifyProgramRef(fx.git, layout, name, B);
  assert.equal(rec.kind === 'not-done' ? rec.staleLock : null, lock);
  assert.equal(await removeStaleRefLock(fx.git, layout, name, null), false, 'no record: not provably the program\'s');
  assert.deepEqual(await recoverProgramRef(fx.git, layout, name, B, { token: 'intent-m4', writer: null, recordDir }), { kind: 'lock-not-ours', lock });
  assert.equal(existsSync(lock), true, 'kept');
  // Its owner removes it: the next attempt creates the ref.
  rmSync(lock);
  assert.equal((await createProgramRef(fx.git, layout, name, B, { intentToken: 'intent-m4', recordDir })).kind, 'created');
});

test('review r2 #3: an external git transaction holding the lock (prepared, not committed) keeps it, and its commit succeeds', async () => {
  const r = initRepo(fx, 'external-lock');
  const A2 = rawCommit(fx, r, { f: 'base\n' }, null);
  fx.raw(['update-ref', 'refs/heads/main', A2], r);
  const l = await discoverRepo(fx.git, r);
  const ref = programRef('delivered', 'm', 'foreign-owner');
  const ext = spawn('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', '--stdin'], { cwd: r, env: fx.env });
  let out = '';
  let err = '';
  const exited = new Promise<number | null>((res) => ext.on('close', res));
  ext.stderr.on('data', (d) => (err += d));
  const prepared = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`prepare timeout: ${out}${err}`)), 5000);
    ext.stdout.on('data', (d) => {
      out += d;
      if (out.includes('prepare: ok')) {
        clearTimeout(t);
        res();
      }
    });
  });
  ext.stdin.write(`start\ncreate ${ref} ${A2}\nprepare\n`);
  await prepared;
  const lock = join(l.commonDir, `${ref}.lock`);
  assert.equal(existsSync(lock), true);
  const token = 'intent-foreign';
  const recordDir = join(fx.root, 'records-foreign');
  let writer: ProcessIdentity | null = null;
  const first = await createProgramRef(fx.git, l, ref, A2, { intentToken: token, recordDir, onSpawn: (p) => (writer = p) });
  assert.equal(first.kind, 'failed');
  const recovered = await recoverProgramRef(fx.git, l, ref, A2, { token, writer, recordDir });
  assert.deepEqual(recovered, { kind: 'lock-not-ours', lock });
  assert.equal(ext.exitCode, null, 'the external git is still running');
  assert.equal(existsSync(lock), true, 'its lock was not removed');
  ext.stdin.end('commit\n');
  assert.equal(await exited, 0, `its commit succeeds: ${err}`);
  assert.equal(fx.raw(['rev-parse', ref], r), A2);
});

test('killing ref creation at random points leaves the ref absent or complete, never partial (kill only; power loss is not simulated)', async (t) => {
  const outcomes = { created: 0, killedAbsent: 0, killedDone: 0, staleLocks: 0, unprovenLocks: 0 };
  for (let i = 0; i < 40; i++) {
    const name = programRef('delivered', 'm5', `op${i}`);
    const token = `intent-m5-op${i}`;
    let writer: ProcessIdentity | null = null; // what the intent would record (6.1)
    let res: Awaited<ReturnType<typeof createProgramRef>> | null = null;
    try {
      // Deadlines spread over the writer's whole run (about 0.1 s): kills during start-up and during the write.
      res = await createProgramRef(fx.git, layout, name, B, { timeoutMs: (i * 23) % 240, intentToken: token, recordDir: join(fx.root, 'records-m5'), onSpawn: (p) => (writer = p) });
    } catch (e) {
      assert.ok(e instanceof GitTimeoutError, String(e));
      await e.exited; // 6.1: verify only after the process has exited
    }
    if (res !== null) {
      assert.equal(res.kind, 'created');
      outcomes.created++;
      continue;
    }
    // The 6.1 table with the v34 row: a lock the killed writer recorded as its own is removed once it is gone;
    // one it died before recording is kept (review r2 #3: never removed without proof).
    const rec = await recoverProgramRef(fx.git, layout, name, B, { token, writer, recordDir: join(fx.root, 'records-m5') });
    assert.ok(rec.kind === 'done' || rec.kind === 'not-done' || rec.kind === 'lock-not-ours', `iteration ${i}: ${JSON.stringify(rec)}`);
    if (rec.kind === 'done') outcomes.killedDone++;
    else if (rec.kind === 'lock-not-ours') {
      outcomes.unprovenLocks++;
      continue;
    } else if (rec.kind === 'not-done') {
      outcomes.killedAbsent++;
      if (rec.removedLock !== null) outcomes.staleLocks++;
      assert.equal((await createProgramRef(fx.git, layout, name, B)).kind, 'created', 'a retry after re-authorization succeeds');
    }
    assert.equal(existsSync(join(layout.commonDir, `${name}.lock`)), false);
  }
  t.diagnostic(`outcomes: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.created + outcomes.killedAbsent + outcomes.killedDone + outcomes.unprovenLocks, 40);
  assert.ok(outcomes.killedAbsent + outcomes.killedDone > 0, `some creations were killed: ${JSON.stringify(outcomes)}`);
});

test('a lock whose writer still runs is never removed: wait, or end the writer and confirm (6.1 v34)', async () => {
  const name = programRef('delivered', 'm6', 'op1');
  mkdirSync(join(layout.commonDir, 'refs/mission-pipeline/delivered/m6'), { recursive: true });
  const lock = join(layout.commonDir, `${name}.lock`);
  writeFileSync(lock, '');
  // A stand-in writer carrying the intent token on its command line, like the real one does.
  const child = spawn('/bin/sh', ['-c', 'sleep 30', 'sh', '-c', 'mission-pipeline.intent=intent-m6-op1'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const writer = identifyProcess(child.pid as number);
  try {
    const waiting = await recoverProgramRef(fx.git, layout, name, B, { token: 'intent-m6-op1', writer: null }, { waitMs: 100 });
    assert.equal(waiting.kind, 'writer-running', 'found by its token even without a recorded identity');
    assert.equal(existsSync(lock), true, 'the lock stays while its writer runs');
    const killed = await recoverProgramRef(fx.git, layout, name, B, { token: 'intent-m6-op1', writer }, { kill: true });
    // Its writer is gone, but nothing proves the lock is the program's (review r2 #3): it stays.
    assert.deepEqual(killed, { kind: 'lock-not-ours', lock });
    assert.equal(isProcessAlive(writer), false);
    rmSync(lock); // its owner cleans it up
    assert.equal((await createProgramRef(fx.git, layout, name, B)).kind, 'created');
  } finally {
    child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------- review r1 #2: never through a link

test('review r1 #2: a dangling symref stored under the program name is never followed (files and reftable): no branch is created', async () => {
  for (const format of ['files', 'reftable'] as const) {
    const r = initRepo(fx, `dangling-${format}`, format === 'reftable' ? ['--ref-format=reftable'] : []);
    const c = rawCommit(fx, r, { 'f.txt': 'x\n' }, null, 'c');
    const l = await discoverRepo(fx.git, r);
    const name = deliveryRef(id<MissionId>('m'), id<OpId>('op'));
    fx.raw(['symbolic-ref', name, 'refs/heads/victim'], r);
    const res = await createProgramRef(fx.git, l, name, c);
    if (format === 'files') {
      assert.equal(res.kind, 'exists-different', `${format}: ${JSON.stringify(res)}`);
      assert.deepEqual(res.kind === 'exists-different' ? res.state : null, { kind: 'symbolic', target: 'refs/heads/victim' });
    } else {
      // v50: no program ref at all in a reftable repository.
      assert.equal(res.kind, 'unsupported-repository', `${format}: ${JSON.stringify(res)}`);
    }
    assert.equal(fx.rawStatus(['rev-parse', '--verify', '-q', 'refs/heads/victim'], r).code, 1, `${format}: refs/heads/victim was not created`);
    assert.equal((await classifyProgramRef(fx.git, l, name, c)).kind, 'tampered');
  }
});

test('v50: reftable or an extension the program does not understand: no program ref is created at all (WI-13)', async () => {
  const cases: { label: string; init: string[]; config?: [string, string][] }[] = [
    { label: 'reftable', init: ['--ref-format=reftable'] },
    { label: 'extensions.preciousObjects', init: [], config: [['core.repositoryformatversion', '1'], ['extensions.preciousObjects', 'true']] },
  ];
  let k = 0;
  for (const c of cases) {
    const r = initRepo(fx, `format-${k++}`, c.init);
    for (const [key, value] of c.config ?? []) fx.raw(['config', key, value], r);
    const commit = rawCommit(fx, r, { 'f.txt': 'x\n' }, null, 'c');
    const l = await discoverRepo(fx.git, r);
    const before = fx.raw(['for-each-ref', '--format=%(refname)'], r);
    const res = await createProgramRef(fx.git, l, deliveryRef(id<MissionId>('m'), id<OpId>('op')), commit);
    assert.equal(res.kind, 'unsupported-repository', `${c.label}: ${JSON.stringify(res)}`);
    assert.equal(res.kind === 'unsupported-repository' ? res.format : null, c.label === 'reftable' ? 'reftable' : 'unsupported');
    assert.equal(fx.raw(['for-each-ref', '--format=%(refname)'], r), before, `${c.label}: no ref was created`);
  }
  const { repositoryFormat } = await import('../src/git/repoFormat.ts');
  assert.deepEqual(await repositoryFormat(fx.git, layout), { kind: 'files' }, 'an ordinary repository');
});

test('review r1 #2: a symlinked namespace directory (refs/mission-pipeline -> heads, or deeper) refuses the write before anything starts', async () => {
  const cases: { label: string; plant: (common: string) => void; name: ProgramRefName; branch: string }[] = [
    { label: 'refs/mission-pipeline -> heads', plant: (g) => symlinkSync('heads', join(g, 'refs/mission-pipeline')), name: programRef('x'), branch: 'refs/heads/x' },
    {
      label: 'refs/mission-pipeline/delivered -> ../heads',
      plant: (g) => {
        mkdirSync(join(g, 'refs/mission-pipeline'), { recursive: true });
        symlinkSync('../heads', join(g, 'refs/mission-pipeline/delivered'));
      },
      name: deliveryRef(id<MissionId>('m'), id<OpId>('op')),
      branch: 'refs/heads/m/op',
    },
    {
      label: 'refs/mission-pipeline/delivered/m is a file',
      plant: (g) => {
        mkdirSync(join(g, 'refs/mission-pipeline/delivered'), { recursive: true });
        writeFileSync(join(g, 'refs/mission-pipeline/delivered/m'), 'not a directory\n');
      },
      name: deliveryRef(id<MissionId>('m'), id<OpId>('op')),
      branch: 'refs/heads/op',
    },
  ];
  let k = 0;
  for (const c of cases) {
    const r = initRepo(fx, `symlinked-ns-${k++}`);
    const commit = rawCommit(fx, r, { 'f.txt': 'x\n' }, null, 'c');
    const l = await discoverRepo(fx.git, r);
    c.plant(l.commonDir);
    const res = await createProgramRef(fx.git, l, c.name, commit);
    assert.equal(res.kind, 'unsafe-namespace', `${c.label}: ${JSON.stringify(res)}`);
    assert.equal(fx.rawStatus(['for-each-ref', 'refs/heads/'], r).stdout, '', `${c.label}: no branch was created`);
    assert.equal(fx.rawStatus(['rev-parse', '--verify', '-q', c.branch], r).code, 1);
    // Recovery never reads through the link either: the namespace itself is reported (WI-20).
    const cls = await classifyProgramRef(fx.git, l, c.name, commit);
    assert.equal(cls.kind, 'tampered', c.label);
    assert.equal(cls.kind === 'tampered' ? cls.state.kind : null, 'unsafe-namespace');
    // A lock is never removed through it.
    await assert.rejects(() => removeStaleRefLock(fx.git, l, c.name, null), /unsafe namespace/);
  }
});

function waitFile(path: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (existsSync(path)) resolve();
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${path}`));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

test('review r1 #2: a namespace directory swapped into refs/heads during the write: nothing is left there (before or after linking)', async () => {
  for (const at of ['after-lock', 'after-link'] as const) {
    const r = initRepo(fx, `race-${at}`);
    const commit = rawCommit(fx, r, { 'f.txt': 'x\n' }, null, 'c');
    fx.raw(['update-ref', 'refs/heads/main', commit], r);
    const l = await discoverRepo(fx.git, r);
    const name = deliveryRef(id<MissionId>('mrace'), id<OpId>('op'));
    const pause = join(fx.root, `pause-${at}`);
    const creating = createProgramRef(fx.git, l, name, commit, { testPause: { at: [at], file: pause } });
    await waitFile(`${pause}.paused-${at}`);
    // While the writer holds its descriptors: the mission's directory moves under refs/heads/ (and a fresh one takes its place).
    renameSync(join(l.commonDir, 'refs/mission-pipeline/delivered/mrace'), join(l.commonDir, 'refs/heads/mrace'));
    mkdirSync(join(l.commonDir, 'refs/mission-pipeline/delivered/mrace'));
    writeFileSync(`${pause}.go-${at}`, '');
    const res = await creating;
    assert.equal(res.kind, 'unsafe-namespace', `${at}: ${JSON.stringify(res)}`);
    assert.equal(res.kind === 'unsafe-namespace' ? res.removedOwnRef : null, at === 'after-link', `${at}: the writer removed the ref it had created`);
    assert.equal(fx.rawStatus(['rev-parse', '--verify', '-q', 'refs/heads/mrace/op'], r).code, 1, `${at}: no branch refs/heads/mrace/op`);
    assert.equal(existsSync(join(l.commonDir, 'refs/heads/mrace/op')), false);
    assert.equal(existsSync(join(l.commonDir, 'refs/heads/mrace/op.lock')), false, `${at}: its lock is gone too`);
    assert.equal(fx.raw(['rev-parse', 'refs/heads/main'], r), commit, 'the user branch is untouched');
  }
});

test('review r1 #2 (6.1 v34 rows): a writer killed while holding its lock, or after linking, recovers to absent-then-created, or done', async () => {
  for (const at of ['after-lock', 'after-link'] as const) {
    const name = programRef('delivered', 'm7', at);
    const token = `intent-m7-${at}`;
    const pause = join(fx.root, `kill-${at}`);
    let writer: ProcessIdentity | null = null;
    const recordDir = join(fx.root, 'records-m7');
    const res = await createProgramRef(fx.git, layout, name, B, { timeoutMs: 3_000, intentToken: token, recordDir, onSpawn: (p) => (writer = p), testPause: { at: [at], file: pause } }).catch((e: unknown) => e);
    assert.ok(res instanceof GitTimeoutError, String(res));
    await res.exited;
    assert.equal(existsSync(`${pause}.paused-${at}`), true, 'it was stopped at the point asked for, then killed');
    assert.equal(lstatSync(join(layout.commonDir, `${name}.lock`)).isFile(), true, 'the killed writer left its lock');
    const rec = await recoverProgramRef(fx.git, layout, name, B, { token, writer, recordDir });
    if (at === 'after-lock') {
      assert.deepEqual(rec, { kind: 'not-done', removedLock: join(layout.commonDir, `${name}.lock`) });
      assert.equal((await createProgramRef(fx.git, layout, name, B)).kind, 'created', 'after re-authorization, creation succeeds');
    } else {
      assert.deepEqual(rec, { kind: 'done' }, 'the ref was linked before the kill: done');
    }
    assert.equal(existsSync(join(layout.commonDir, `${name}.lock`)), false, 'the lock is gone once the writer is confirmed gone');
    assert.deepEqual(await readRefState(fx.git, layout, name), { kind: 'direct', oid: B });
  }
});

test('review r2 #2: the directory is moved into refs/heads between the last check and link(2), and the writer dies: recovery finds the ref there and reports it (never redone, never deleted)', async () => {
  const r = initRepo(fx, 'escape-crash');
  const A3 = rawCommit(fx, r, { f: 'base\n' }, null, 'base');
  const B3 = rawCommit(fx, r, { f: 'delivery\n' }, A3, 'delivery');
  fx.raw(['update-ref', 'refs/heads/main', A3], r);
  const l = await discoverRepo(fx.git, r);
  const name = programRef('delivered', 'm', 'op');
  const token = 'intent-escape';
  const recordDir = join(fx.root, 'records-escape');
  const pause = join(fx.root, 'pause-escape');
  let writer: ProcessIdentity | null = null;
  const creating = createProgramRef(fx.git, l, name, B3, {
    intentToken: token,
    recordDir,
    onSpawn: (p) => (writer = p),
    testPause: { at: ['before-link', 'after-link'], file: pause },
  });
  await waitFile(`${pause}.paused-before-link`);
  // Another process moves the writer's directory into refs/heads/ after its last check.
  renameSync(join(l.commonDir, 'refs/mission-pipeline/delivered/m'), join(l.commonDir, 'refs/heads/m'));
  mkdirSync(join(l.commonDir, 'refs/mission-pipeline/delivered/m'));
  writeFileSync(`${pause}.go-before-link`, '');
  await waitFile(`${pause}.paused-after-link`);
  // The writer dies right after linking: no after-check, no clean-up.
  process.kill((writer as ProcessIdentity | null)?.pid ?? -1, 'SIGKILL');
  const res = await creating;
  assert.equal(res.kind, 'failed');
  assert.equal(fx.raw(['rev-parse', 'refs/heads/m/op'], r), B3, 'the ref was linked outside the namespace');
  const rec = await recoverProgramRef(fx.git, l, name, B3, { token, writer, recordDir });
  assert.deepEqual(rec, { kind: 'escaped', paths: ['refs/heads/m/op'] });
  assert.equal(fx.raw(['rev-parse', 'refs/heads/m/op'], r), B3, 'not deleted: the user decides (WI-20)');
  assert.equal(fx.raw(['rev-parse', 'refs/heads/main'], r), A3);
});

test('review r2 #4: no hard links on the filesystem: no ref, no rename fallback; a name that appeared meanwhile is untouched', async () => {
  const r = initRepo(fx, 'no-links');
  const A4 = rawCommit(fx, r, { f: 'base\n' }, null, 'base');
  const B4 = rawCommit(fx, r, { f: 'delivery\n' }, A4, 'delivery');
  fx.raw(['update-ref', 'refs/heads/main', A4], r);
  const l = await discoverRepo(fx.git, r);
  const name = programRef('delivered', 'm', 'op');
  const pause = join(fx.root, 'pause-no-links');
  const creating = createProgramRef(fx.git, l, name, B4, { testFailLink: 'EPERM', testPause: { at: ['before-link'], file: pause } });
  await waitFile(`${pause}.paused-before-link`);
  // Another writer puts a ref under the name after the writer's last check.
  writeFileSync(join(l.commonDir, name), `${A4}\n`);
  writeFileSync(`${pause}.go-before-link`, '');
  const res = await creating;
  assert.equal(res.kind, 'unsupported-repository', JSON.stringify(res));
  assert.equal(res.kind === 'unsupported-repository' ? res.format : null, 'no-hard-links');
  assert.equal(readFileSync(join(l.commonDir, name), 'utf8'), `${A4}\n`, 'the external ref was not replaced');
  assert.equal(existsSync(join(l.commonDir, `${name}.lock`)), false, 'the writer removed its own lock');
});
