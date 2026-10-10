// Ledger service over its Unix socket (6.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { LedgerClient, LedgerUnavailable, RemoteLedgerError, serveLedger } from '../src/ledger/ipc.ts';
import { id, type LaunchId, type MissionId, type StopId } from '../src/common/ids.ts';

test('requests over the socket: results, typed errors, and a stop that refuses later authorizations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ipc-'));
  const svc = new LedgerService({ paths: ledgerPaths(join(dir, 'ledger'), join(dir, 'control')) });
  svc.open();
  const sockPath = join(dir, 'ledger.sock');
  const server = serveLedger(svc, sockPath);
  const client = new LedgerClient(sockPath, 5000);
  try {
    const gen = (await client.call('beginGeneration', {})) as number;
    assert.equal(gen, 1);
    const tag = { mission: id<MissionId>('m1'), capabilities: [] };
    await client.call('registerLaunch', { op: 'l1', gen: gen as never, launch: id<LaunchId>('L1'), tag });
    await client.call('stop', { stop: id<StopId>('s1'), scope: { kind: 'all' }, words: '停', at: 1 });
    await assert.rejects(
      client.call('authorize', { op: 'a', gen: gen as never, launch: null, intent: 'i', kind: 'x', domain: 'd', tag, details: {} }),
      (e: unknown) => e instanceof RemoteLedgerError && e.code === 'STOPPED',
    );
    await assert.rejects(
      client.call('nope' as never, {} as never),
      (e: unknown) => e instanceof RemoteLedgerError && e.code === 'BAD_REQUEST',
    );
  } finally {
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable service is reported as unavailable (retryable), not as a ledger decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ipc-'));
  const client = new LedgerClient(join(dir, 'missing.sock'), 1000);
  try {
    await assert.rejects(client.call('head', {}), (e: unknown) => e instanceof LedgerUnavailable);
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger service as its own process: heartbeat, requests, clean shutdown (6.1, 6.3)', async () => {
  const { fork } = await import('node:child_process');
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-main-'));
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({ root: join(dir, 'ledger'), controlPlane: join(dir, 'control'), socket: join(dir, 'ledger.sock'), heartbeatMs: 100 }));
  const child = fork(new URL('../src/ledger/main.ts', import.meta.url).pathname, [cfgPath], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (c) => reject(new Error(`exited ${c}`)));
    });
    const client = new LedgerClient(join(dir, 'ledger.sock'), 5000);
    assert.equal(await client.call('beginGeneration', {}), 1);
    assert.equal(await client.call('currentGeneration', {}), 1);
    assert.deepEqual(await client.call('openLaunches', {}), []);
    client.close();
    const hb = JSON.parse(readFileSync(join(dir, 'control', 'ledger.heartbeat'), 'utf8')) as { pid: number };
    assert.equal(hb.pid, child.pid);
    const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.ok(existsSync(join(dir, 'ledger', 'ledger.sqlite')));
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger service process picks up a stop sent as files while it runs; dispatch in scope is refused within 2 s (core review r2 F2)', async () => {
  const { fork } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { sendStop } = await import('../src/ledger/stops.ts');
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-stopwatch-'));
  const cfgPath = join(dir, 'cfg.json');
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  writeFileSync(cfgPath, JSON.stringify({ root: paths.root, controlPlane: paths.controlPlane, socket: join(dir, 'ledger.sock'), heartbeatMs: 200 }));
  const child = fork(new URL('../src/ledger/main.ts', import.meta.url).pathname, [cfgPath], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const client = new LedgerClient(join(dir, 'ledger.sock'), 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (c) => reject(new Error(`exited ${c}`)));
    });
    const gen = (await client.call('beginGeneration', {})) as number;
    const tag = { mission: id<MissionId>('m1'), capabilities: ['net'] };
    await client.call('registerLaunch', { op: 'before', gen: gen as never, launch: id<LaunchId>('L0'), tag });
    const t0 = Date.now();
    const sent = sendStop(paths, { stop: id<StopId>('file-stop'), scope: { kind: 'mission', mission: id<MissionId>('m1') }, words: '停', at: Date.now() });
    assert.equal(sent.spooled, true);
    for (;;) {
      if (((await client.call('activeStopIds', {})) as string[]).includes('file-stop')) break;
      assert.ok(Date.now() - t0 < 2000, 'the running service did not commit the stop within 2 s');
      await new Promise((r) => setTimeout(r, 20));
    }
    await assert.rejects(
      client.call('registerLaunch', { op: 'after', gen: gen as never, launch: id<LaunchId>('L1'), tag }),
      (e: unknown) => e instanceof RemoteLedgerError && e.code === 'STOPPED',
    );
    assert.ok(Date.now() - t0 < 2000, `refused ${Date.now() - t0} ms after the stop was sent`);
  } finally {
    client.close();
    const exited = new Promise((r) => child.once('exit', r));
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
