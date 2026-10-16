// Copying and moving the folder (design 4.1 §3.3; §11.1, §11.6, §11.8,
// §11.15): every open compares the recorded place with the current one and,
// after a copy or a move, recovers under the maintenance lock: move pending,
// worktree repair (only with the repository inside the folder; otherwise git
// writes are held until the PM confirms), the chain verified, the state
// rebuilt, leaves and commits checked, move done. A crash at any step is
// finished by the next open; two processes opening at once end with one move.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, type MissionId } from '../src/common/ids.ts';
import {
  authorizeIntent,
  claimDispatch,
  initMemory,
  openMemory,
  queueTask,
  recordDelivery,
  setMission,
  STATE_TABLES,
  tryLock,
  type Memory,
} from '../src/memory/index.ts';
import { plainGit, type GitRunner } from '../src/memory/git.ts';
import { child, git, kinds, repo, tempDir, throwsCode } from './memory-fixtures.ts';
import { BASE, C1, domainWorkload } from './memory-workload.ts';

const M = id<MissionId>('m1');

function dump(m: Memory): Record<string, unknown[]> {
  return Object.fromEntries(STATE_TABLES.map((t) => [t, m.stmt(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...r }))]));
}

function moved(m: Memory): number {
  return kinds(m).filter((k) => k === 'memory.moved').length;
}

/** An original project with a repository, its memory and a varied workload; copies of it go next to it. */
function original(): { base: string; dir: string; snapshot: Record<string, unknown[]>; copy: (name: string) => string; cleanup: () => void } {
  const base = tempDir('mp-move-');
  const dir = join(base, 'original');
  mkdirSync(dir);
  repo(dir);
  initMemory(dir);
  const m = openMemory(dir);
  domainWorkload(m);
  const snapshot = dump(m);
  m.close();
  return {
    base,
    dir,
    snapshot,
    copy: (name) => {
      const to = join(base, name);
      cpSync(dir, to, { recursive: true });
      return to;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('a copied folder recovers on open: one move event with its findings, the state rebuilt; the original is untouched', () => {
  const o = original();
  try {
    const to = o.copy('copy-1');
    const m = openMemory(to);
    try {
      const st = m.status();
      assert.equal(st.place.path, realpathSync(to));
      assert.equal(st.movePending, null);
      assert.equal(moved(m), 1);
      const f = st.lastMove!.findings;
      assert.equal(st.lastMove!.from.path, realpathSync(o.dir));
      assert.deepEqual(f.chain, { ok: true, lastValid: f.chain.lastValid, brokenAt: null, reason: null });
      assert.deepEqual(f.git, { kind: 'repaired', worktrees: 0 });
      assert.ok(f.leaves.checked >= 3 && f.leaves.missingCount === 0 && f.leaves.editedCount === 0, JSON.stringify(f.leaves));
      // The workload's delivery names commits this repository does not have: shown, not refused.
      assert.deepEqual(f.commits.unreachable, [C1, BASE].sort());
      assert.deepEqual(f.layout, []);
      const after = dump(m);
      for (const t of STATE_TABLES) assert.deepEqual(after[t], o.snapshot[t], t);
      assert.equal(st.gitHold, null);
      m.write({}, (tx) => setMission(tx, id<MissionId>('m3'), 'open'));
      // A second open finds nothing to do.
      m.close();
      const again = openMemory(to);
      assert.equal(moved(again), 1);
      again.close();
    } finally {
      m.close();
    }
    const orig = openMemory(o.dir);
    assert.equal(moved(orig), 0, 'the original never moved');
    orig.close();
  } finally {
    o.cleanup();
  }
});

test('the checks after a move: a leaf edited by hand, a leaf missing and a commit missing an object are shown; the memory keeps working', () => {
  const base = tempDir('mp-move-checks-');
  try {
    const dir = join(base, 'p');
    mkdirSync(dir);
    const head = repo(dir);
    initMemory(dir);
    const m0 = openMemory(dir);
    const refs = m0.write({ op: 'leaves', payload: 1 }, (tx) => ({
      plan: tx.leaves.writeDocument('missions/m1/plans/plan-v1.md', '# plan\n'),
      card: tx.leaves.writeDocument('missions/m1/dispatches/D-1/card.md', '# card\n'),
      entry: tx.leaves.appendEntry('constraints.md', 'C-1'),
    }));
    m0.write({ op: 'del', payload: 1 }, (tx) => recordDelivery(tx, { mission: M, delivery: 'op-1', commit: head, base: head, ref: 'refs/mission-pipeline/delivered/m1/op-1', manifest: m0.data.put('manifest') }));
    m0.close();
    const to = join(base, 'copy');
    cpSync(dir, to, { recursive: true });
    writeFileSync(join(to, '.mission-pipeline', 'missions', 'm1', 'plans', 'plan-v1.md'), '# plan, edited by hand\n');
    unlinkSync(join(to, '.mission-pipeline', 'missions', 'm1', 'dispatches', 'D-1', 'card.md'));
    // The copy lacks the blob of file.txt: the commit is there, its closure is not.
    const blob = git(to, 'rev-parse', 'HEAD:file.txt');
    unlinkSync(join(to, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const m = openMemory(to);
    try {
      const f = m.status().lastMove!.findings;
      assert.deepEqual(f.leaves.edited, [refs.plan.leaf]);
      assert.deepEqual(f.leaves.missing, [refs.card.leaf]);
      assert.deepEqual(f.commits.unreachable, [head]);
      assert.equal(m.readLeaf(refs.entry.leaf)?.status, 'ok');
      m.write({}, (tx) => setMission(tx, M, 'open'));
    } finally {
      m.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('worktrees under the folder follow the copy (git worktree repair, the common directory inside the folder)', () => {
  const base = tempDir('mp-move-wt-');
  try {
    const dir = join(base, 'p');
    mkdirSync(dir);
    repo(dir);
    initMemory(dir);
    git(dir, 'worktree', 'add', '-q', '-b', 'd1', join('.mission-pipeline', 'worktrees', 'D-1'));
    const to = join(base, 'copy');
    cpSync(dir, to, { recursive: true });
    const wt = join(to, '.mission-pipeline', 'worktrees', 'D-1');
    // Before the open, the copy's worktree still belongs to the original's repository.
    assert.equal(realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(dir, '.git')));
    const m = openMemory(to);
    try {
      assert.deepEqual(m.status().lastMove!.findings.git, { kind: 'repaired', worktrees: 1 });
      assert.equal(realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(to, '.git')));
      assert.match(git(to, 'worktree', 'list', '--porcelain'), new RegExp(realpathSync(wt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      // The original's worktree still belongs to the original.
      assert.equal(realpathSync(git(join(dir, '.mission-pipeline', 'worktrees', 'D-1'), 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(dir, '.git')));
    } finally {
      m.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the common git directory outside the folder: init warns; after a copy nothing is repaired and git writes are held until the PM confirms', () => {
  const base = tempDir('mp-move-outside-');
  try {
    const main = join(base, 'main');
    mkdirSync(main);
    repo(main);
    const proj = join(base, 'proj');
    git(main, 'worktree', 'add', '-q', '-b', 'proj', proj);
    const r = initMemory(proj);
    assert.equal(r.created, true, 'initialized anyway');
    assert.ok(r.layout.commonDirOutside);
    assert.match(r.layout.warnings.join('\n'), /lies outside the project folder: a copy of the folder carries the memory but not the code/);
    const before = git(main, 'worktree', 'list', '--porcelain');
    const to = join(base, 'proj-copy');
    cpSync(proj, to, { recursive: true });
    const m = openMemory(to);
    try {
      const st = m.status();
      assert.equal(st.lastMove!.findings.git.kind, 'held');
      assert.match(st.gitHold!.reason, /lies outside the folder/);
      assert.equal(git(main, 'worktree', 'list', '--porcelain'), before, 'the shared repository was not rewritten');
      const card = m.data.put('spec');
      m.write({ op: 'q', payload: 1 }, (tx) => {
        setMission(tx, M, 'open');
        queueTask(tx, { task: 'T1', lineage: 'L1', mission: M, card });
        queueTask(tx, { task: 'T2', lineage: 'L2', mission: M, card });
      });
      throwsCode(() => m.write({ op: 'd1', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor', worktree: true })), 'GIT_WRITES_HELD', /confirms under the copy\/move WI/);
      m.write({ op: 'd2', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' }));
      throwsCode(
        () => m.write({ op: 'l', payload: 1 }, (tx) => authorizeIntent(tx, { intent: 'land-1', kind: 'landing', domain: 'landing:x', tag: { mission: M, capabilities: [] }, details: { delivery: { mission: M, op: 'o', commit: C1, base: BASE } } })),
        'GIT_WRITES_HELD',
      );
      assert.deepEqual(m.confirmCopyInUse({ op: 'confirm-1', words: 'W-3', filler: { harness: 'codex', model: null } }), { released: true });
      assert.equal(m.gitHold(), null);
      m.write({ op: 'd1b', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor', worktree: true }));
      assert.ok(kinds(m).includes('memory.git-confirmed'));
    } finally {
      m.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a repository with alternates (a shared clone): init warns and still initializes', () => {
  const base = tempDir('mp-move-alt-');
  try {
    const src = join(base, 'src');
    mkdirSync(src);
    repo(src);
    const shared = join(base, 'shared');
    git(base, 'clone', '-q', '--shared', src, shared);
    const r = initMemory(shared);
    assert.equal(r.created, true);
    assert.ok(r.layout.alternates.length === 1);
    assert.match(r.layout.warnings.join('\n'), /alternates/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a crash after any step of the recovery: the next open finishes it, with one move event and the right state', async () => {
  const o = original();
  try {
    for (const step of [1, 2, 3, 4, 5, 6]) {
      const to = o.copy(`crash-${step}`);
      const c = child({ action: 'open', project: to, crashAfterStep: step });
      assert.equal(await c.exit, -1, `killed after step ${step}`);
      const m = openMemory(to);
      try {
        const st = m.status();
        assert.equal(st.movePending, null, `step ${step}`);
        assert.equal(st.place.path, realpathSync(to));
        assert.equal(moved(m), 1, `one move event after a crash at step ${step}`);
        const after = dump(m);
        for (const t of STATE_TABLES) assert.deepEqual(after[t], o.snapshot[t], `${t} after a crash at step ${step}`);
      } finally {
        m.close();
      }
    }
  } finally {
    o.cleanup();
  }
});

test('two processes opening a moved folder at once: one recovers, the other waits; a caller that cannot wait gets MOVING', async () => {
  const o = original();
  try {
    const to = o.copy('twice');
    const a = child({ action: 'open', project: to, sleepAtStep: { step: 2, ms: 600 } });
    const b = child({ action: 'open', project: to, sleepAtStep: { step: 2, ms: 600 } });
    assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
    const [la, lb] = await Promise.all([a.line, b.line]);
    assert.equal(JSON.parse(la).place.path, JSON.parse(lb).place.path);
    const m = openMemory(to);
    assert.equal(moved(m), 1);
    m.close();
    // The maintenance lock held elsewhere: a short busy limit ends in MOVING.
    const to2 = o.copy('locked');
    const held = tryLock(join(to2, '.mission-pipeline', 'locks'), 'maintenance');
    assert.ok(held !== null);
    try {
      throwsCode(() => openMemory(to2, { busyTimeoutMs: 200 }), 'MOVING', /retry/);
    } finally {
      held.release();
    }
    const m2 = openMemory(to2);
    assert.equal(moved(m2), 1);
    m2.close();
  } finally {
    o.cleanup();
  }
});

test('a copy whose event chain is broken: the move is finished, every write is refused, the PM continues from the last valid event', () => {
  const o = original();
  try {
    const to = o.copy('broken');
    const db = new DatabaseSync(join(to, '.mission-pipeline', 'memory.db'));
    db.prepare("UPDATE log SET record = replace(record, 'build the login page', 'something else') WHERE kind = 'user.words'").run();
    db.close();
    const m = openMemory(to);
    try {
      const st = m.status();
      assert.equal(st.place.path, realpathSync(to));
      assert.equal(st.lastMove!.findings.chain.ok, false);
      assert.equal(moved(m), 0, 'nothing is appended to a broken chain');
      const broken = st.chainBroken!;
      throwsCode(() => m.write({}, (tx) => setMission(tx, M, 'open')), 'CHAIN_BROKEN', new RegExp(`last valid event is ${broken.lastValid}`));
      const out = m.continueFromLastValid();
      assert.equal(out.lastValid, broken.lastValid);
      assert.ok(out.removed > 0);
      m.write({}, (tx) => setMission(tx, M, 'open'));
      assert.equal(m.verifyChain().ok, true);
    } finally {
      m.close();
    }
  } finally {
    o.cleanup();
  }
});

test('the same path on another machine (WSL and Windows on one folder) is a move too', () => {
  const o = original();
  try {
    const m = openMemory(o.dir, { machine: 'other-host/win32/x64' });
    try {
      const st = m.status();
      assert.equal(st.place.machine, 'other-host/win32/x64');
      assert.notEqual(st.lastMove!.from.machine, 'other-host/win32/x64');
      assert.equal(moved(m), 1);
    } finally {
      m.close();
    }
    assert.ok(readFileSync(join(o.dir, '.mission-pipeline', 'memory.db')).length > 0);
  } finally {
    o.cleanup();
  }
});

test('real copied worktrees are directly repaired when an old-git runner returns zero without fixing either link', () => {
  const base = tempDir('mp-old-repair-');
  try {
    const original = join(base, 'original');
    const copied = join(base, 'copy');
    mkdirSync(original);
    repo(original);
    initMemory(original);
    // Include a normal project worktree outside mp's own worktrees directory.
    for (const path of [join('.mission-pipeline', 'worktrees', 'D-1'), 'other-worktree']) git(original, 'worktree', 'add', '-q', '--detach', path);
    cpSync(original, copied, { recursive: true });
    const plain = plainGit();
    const oldGit: GitRunner = (args, opts) => args[0] === 'worktree' && args[1] === 'repair' ? { code: 0, stdout: '', stderr: '' } : plain(args, opts);
    const m = openMemory(copied, { git: oldGit });
    try {
      assert.equal(m.status().gitHold, null);
      assert.equal(m.status().movePending, null);
      assert.deepEqual(m.status().lastMove!.findings.git, { kind: 'repaired', worktrees: 2 });
      for (const path of [join('.mission-pipeline', 'worktrees', 'D-1'), 'other-worktree']) {
        const wt = join(copied, path);
        assert.equal(realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(copied, '.git')));
        assert.equal(git(wt, 'status', '--porcelain'), '');
        assert.equal(realpathSync(git(join(original, path), 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(original, '.git')));
      }
    } finally { m.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a copy skips a deleted unpruned registration, reports it and verifies the live worktree', () => {
  const base = tempDir('mp-prunable-');
  try {
    const original = join(base, 'original');
    const copied = join(base, 'copy');
    mkdirSync(original);
    repo(original);
    initMemory(original);
    for (const name of ['deleted', 'live']) git(original, 'worktree', 'add', '-q', '--detach', name);
    rmSync(join(original, 'deleted'), { recursive: true });
    assert.match(git(original, 'worktree', 'list', '--porcelain'), /prunable/);
    cpSync(original, copied, { recursive: true });
    const m = openMemory(copied);
    try {
      const status = m.status();
      assert.equal(status.gitHold, null);
      assert.equal(status.movePending, null);
      assert.deepEqual(status.lastMove!.findings.git, { kind: 'repaired', worktrees: 1 });
      assert.ok(status.lastMove!.findings.layout.some((finding) => finding.includes('prunable') && finding.includes(join(copied, 'deleted'))));
      const live = join(copied, 'live');
      const admin = git(live, 'rev-parse', '--absolute-git-dir');
      assert.equal(realpathSync(git(live, 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(copied, '.git')));
      assert.equal(readFileSync(join(live, '.git'), 'utf8').trim(), `gitdir: ${admin}`);
      assert.equal(readFileSync(join(admin, 'gitdir'), 'utf8').trim(), join(live, '.git'));
      assert.ok(git(copied, 'worktree', 'list', '--porcelain').includes(`worktree ${live}`));
      assert.equal(git(live, 'status', '--porcelain'), '');
    } finally { m.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
