// The control-plane database opened by several processes at the same moment (e2e on the release candidate:
// "[probe] database is locked" at engine start, the watchdog restarted the probe, the PM got WI-22).
// Switching a new file to WAL needs a lock SQLite does not wait for through busy_timeout; openControlDb
// retries it for a bounded time. A broken database still fails, and a probe on one still exits and reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { controlDbPath, isBusyError, openControlDb } from '../src/ledger/controlState.ts';
import { installInbox } from '../src/ledger/inbox.ts';
import { readProbeHeartbeat } from '../src/ledger/probe.ts';
import { ENGINE_SRC, script, until } from './ledger-stops-fixtures.ts';

const NODE = [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning'] as const;

function run(file: string, args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } {
  const child = spawn(NODE[0], [...NODE.slice(1), file, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
  return { child, done: new Promise((r) => child.once('exit', (code) => r({ code, stderr }))) };
}

test('openers that start at the same instant on a new control database all succeed (the WAL switch is retried, not fatal)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-race-'));
  try {
    // Each child waits for a common instant, then opens the database the way every opener does; writers then take the lock repeatedly.
    const child = script(
      dir,
      'opener.ts',
      `import { ControlState } from '@src/ledger/controlState.ts';
const [cp, at, mode] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
while (Date.now() < at) {}
const c = new ControlState(cp);
if (mode === 'writer') for (let i = 0; i < 40; i++) c.registerEntry('e' + process.pid + '-' + i, 'boot', 's', process.pid, Date.now());
c.close();
`,
    );
    let failures: string[] = [];
    for (let round = 0; round < 12; round++) {
      const cp = join(dir, `cp-${round}`);
      const at = Date.now() + 2_500;
      const kids = ['probe', 'probe', 'writer', 'writer'].map((m) => run(child, [cp, String(at), m]));
      const outs = await Promise.all(kids.map((k) => k.done));
      failures = failures.concat(outs.filter((o) => o.code !== 0).map((o) => o.stderr.trim()));
    }
    assert.deepEqual(failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both probes and a concurrent writer started together on a fresh control plane, many times: no probe exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-race-'));
  const live: ChildProcess[] = [];
  try {
    const primary = join(dir, 'primary.inbox');
    const backup = join(dir, 'backup.inbox');
    installInbox(primary, 'primary', { slots: 34 });
    installInbox(backup, 'backup', { slots: 34 });
    const writer = script(
      dir,
      'writer.ts',
      `import { ControlState } from '@src/ledger/controlState.ts';
const cp = process.argv[2];
const end = Date.now() + 3000;
let i = 0;
while (Date.now() < end) { const c = new ControlState(cp); c.registerEntry('w' + i, 'boot', 's', process.pid, Date.now()); c.endEntry('w' + i++, Date.now()); c.close(); }
`,
    );
    for (let round = 0; round < 6; round++) {
      const cp = join(dir, `cp-${round}`);
      mkdirSync(cp);
      const probes = (['primary', 'backup'] as const).map((inbox) => {
        const cfg = join(dir, `probe-${round}-${inbox}.json`);
        writeFileSync(cfg, JSON.stringify({ inbox, file: inbox === 'primary' ? primary : backup, other: inbox === 'primary' ? 'backup' : 'primary', controlPlane: cp, boot: `boot-${round}`, intervalMs: 50, staleMs: 10_000 }));
        return run(join(ENGINE_SRC, 'ledger', 'probe-main.ts'), [cfg]);
      });
      const w = run(writer, [cp]);
      live.push(...probes.map((p) => p.child), w.child);
      await until(() => probes.some((p) => p.child.exitCode !== null) || (readProbeHeartbeat(cp, 'primary') !== null && readProbeHeartbeat(cp, 'backup') !== null), 30_000, 'both probes running');
      assert.deepEqual((await w.done).code, 0, 'the writer finished');
      for (const p of probes) assert.equal(p.child.exitCode, null, `a probe exited: ${await Promise.race([p.done.then((d) => d.stderr), Promise.resolve('')])}`);
      for (const p of probes) p.child.kill('SIGKILL');
      await Promise.all(probes.map((p) => p.done));
    }
  } finally {
    for (const c of live) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely broken control database still fails: openControlDb throws at once, and a probe on it exits and reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-race-'));
  try {
    const cp = join(dir, 'cp');
    mkdirSync(cp);
    writeFileSync(controlDbPath(cp), Buffer.alloc(8192, 0x5a));
    const t0 = Date.now();
    assert.throws(() => openControlDb(controlDbPath(cp)), (e: unknown) => !isBusyError(e) && /not a database/i.test((e as Error).message));
    assert.ok(Date.now() - t0 < 2_000, 'no retry for a failure that is not a lock');
    const primary = join(dir, 'primary.inbox');
    installInbox(primary, 'primary', { slots: 34 });
    const cfg = join(dir, 'probe.json');
    writeFileSync(cfg, JSON.stringify({ inbox: 'primary', file: primary, other: null, controlPlane: cp, boot: 'boot-x', intervalMs: 50 }));
    const out = await run(join(ENGINE_SRC, 'ledger', 'probe-main.ts'), [cfg]).done;
    assert.equal(out.code, 1);
    assert.match(out.stderr, /\[probe\] .*not a database/i);
    // A lock held beyond the bound is a failure too (here a 100 ms bound; the reader waits busy_timeout once).
    const fresh = join(dir, 'held.sqlite');
    const holder = new DatabaseSync(fresh);
    holder.exec('CREATE TABLE t (x); BEGIN EXCLUSIVE; INSERT INTO t VALUES (1)');
    try {
      assert.throws(() => openControlDb(fresh, 100), (e: unknown) => isBusyError(e));
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
