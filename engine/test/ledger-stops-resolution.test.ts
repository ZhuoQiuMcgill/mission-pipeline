// Stops the ledger released or narrowed stop counting for the spool readers that decide without the ledger
// (the unit supervisor's stop watcher, the seat host's heartbeat, the watchdog): resolution markers in the
// control plane, written after the commit and reconciled at the ledger's start (e2e: after `mp stop-release`
// every new unit in the released scope was still killed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerService, ledgerPaths, type LedgerPaths } from '../src/ledger/service.ts';
import { readStopResolution, resolutionsDir, sendStop, stagedStopsInForce, stopCovers, writeStopResolution, type StopPaths } from '../src/ledger/stops.ts';
import { id, type MissionId, type StopId } from '../src/common/ids.ts';
import { killQuietly } from './ledger-stops-fixtures.ts';

const M1 = id<MissionId>('m1');
const M2 = id<MissionId>('m2');
const tag = (mission: MissionId) => ({ mission, capabilities: [] as string[] });

function world(): { dir: string; paths: LedgerPaths; open: () => LedgerService; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-res-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'cp'));
  let svc: LedgerService | null = null;
  return {
    dir,
    paths,
    open: () => {
      svc?.close();
      svc = new LedgerService({ paths, bootId: () => 'boot-res', watchStops: false });
      svc.open();
      return svc;
    },
    cleanup: () => {
      try {
        svc?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The supervisor's and the host's view (the spool only), and the watchdog's (with the inbox). */
function views(paths: LedgerPaths): Record<'supervisor' | 'host' | 'watchdog', StopPaths> {
  return {
    supervisor: { inbox: join(paths.controlPlane, '.no-inbox'), controlPlane: paths.controlPlane },
    host: { inbox: join(paths.controlPlane, 'stops', '.no-inbox'), controlPlane: paths.controlPlane },
    watchdog: { inbox: paths.inbox, controlPlane: paths.controlPlane },
  };
}

function covers(p: StopPaths, mission: MissionId): string[] {
  return stagedStopsInForce(p)
    .filter((r) => stopCovers(r.scope, tag(mission)))
    .map((r) => r.stop);
}

function send(paths: LedgerPaths, stop: string, scope: Parameters<typeof sendStop>[1]['scope'], pids: number[]): void {
  const out = sendStop(paths, { stop: id<StopId>(stop), scope, words: '停', at: Date.now() });
  if (out.writerPid !== undefined) pids.push(out.writerPid);
}

test('stop → commit → release: the supervisor, the host and the watchdog no longer count it; an active committed stop still covers', async () => {
  const w = world();
  const pids: number[] = [];
  try {
    const svc = w.open();
    send(w.paths, 'S-released', { kind: 'mission', mission: M1 }, pids);
    send(w.paths, 'S-active', { kind: 'mission', mission: M2 }, pids);
    await svc.drainStops();
    assert.deepEqual(svc.activeStops().map((s) => s.stop).sort(), ['S-active', 'S-released']);
    for (const v of Object.values(views(w.paths))) assert.deepEqual([covers(v, M1), covers(v, M2)], [['S-released'], ['S-active']], 'committed and active: still covers');
    assert.deepEqual(await svc.releaseStop(id<StopId>('S-released')), { released: true });
    assert.equal(readStopResolution(w.paths.controlPlane, 'S-released')?.state, 'released');
    for (const [name, v] of Object.entries(views(w.paths))) {
      assert.deepEqual(covers(v, M1), [], `${name}: a released stop no longer covers`);
      assert.deepEqual(covers(v, M2), ['S-active'], `${name}: the active stop still covers`);
    }
  } finally {
    killQuietly(pids);
    w.cleanup();
  }
});

test('a crash after the release commit but before the marker: the stop still covers (over-stop) until the ledger’s start reconciles it', async () => {
  const w = world();
  const pids: number[] = [];
  try {
    let svc = w.open();
    send(w.paths, 'S1', { kind: 'all' }, pids);
    await svc.drainStops();
    // The release commits, and the process dies before the marker is written: the same state as a missing marker.
    await svc.releaseStop(id<StopId>('S1'));
    rmSync(join(resolutionsDir(w.paths.controlPlane), 'S1.json'));
    for (const v of Object.values(views(w.paths))) assert.deepEqual(covers(v, M1), ['S1'], 'never under-stops: still counted');
    svc = w.open();
    assert.equal(svc.stopState(id<StopId>('S1')), 'released');
    assert.equal(readStopResolution(w.paths.controlPlane, 'S1')?.state, 'released', 'written at the start');
    for (const v of Object.values(views(w.paths))) assert.deepEqual(covers(v, M1), []);
  } finally {
    killQuietly(pids);
    w.cleanup();
  }
});

test('a narrowed stop covers only its new scope; once the narrower one is released, neither covers', async () => {
  const w = world();
  const pids: number[] = [];
  try {
    const svc = w.open();
    send(w.paths, 'S-all', { kind: 'all' }, pids);
    await svc.drainStops();
    await svc.narrowStop({ old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m1'), scope: { kind: 'mission', mission: M1 }, words: '只停 m1', at: Date.now() } });
    const m = readStopResolution(w.paths.controlPlane, 'S-all');
    assert.deepEqual([m?.state, m?.to, m?.scope], ['narrowed', 'S-m1', { kind: 'mission', mission: M1 }]);
    for (const v of Object.values(views(w.paths))) {
      assert.deepEqual(covers(v, M1), ['S-all'], 'the staged request covers by its new scope');
      assert.deepEqual(covers(v, M2), [], 'and no longer outside it');
    }
    await svc.releaseStop(id<StopId>('S-m1'));
    for (const v of Object.values(views(w.paths))) assert.deepEqual(covers(v, M1), [], 'the end of the chain is released');
  } finally {
    killQuietly(pids);
    w.cleanup();
  }
});

test('a narrowing marker without the new scope keeps the old, wider scope (conservative); the CLI’s narrowing (new stop, then release) works too', async () => {
  const w = world();
  const pids: number[] = [];
  try {
    const svc = w.open();
    send(w.paths, 'S-a', { kind: 'all' }, pids);
    await svc.drainStops();
    writeStopResolution(w.paths.controlPlane, { stop: 'S-a', state: 'narrowed', at: 1 });
    assert.deepEqual(covers(views(w.paths).supervisor, M2), ['S-a']);
    // The CLI: the narrower stop through the entry, committed, then the old one released.
    send(w.paths, 'S-b', { kind: 'all' }, pids);
    await svc.drainStops();
    send(w.paths, 'S-b-m1', { kind: 'mission', mission: M1 }, pids);
    await svc.drainStops();
    await svc.releaseStop(id<StopId>('S-b'));
    assert.deepEqual(covers(views(w.paths).host, M1).sort(), ['S-a', 'S-b-m1']);
    assert.deepEqual(covers(views(w.paths).host, M2), ['S-a']);
    assert.ok(existsSync(join(resolutionsDir(w.paths.controlPlane), 'S-b.json')));
  } finally {
    killQuietly(pids);
    w.cleanup();
  }
});
