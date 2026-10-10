// Cleanup of finished launches (design v35 7.1, 6.3 rule 1, 6.4). Cleanup is progressing
// state per launch, separate from the immutable termination proof and from the final
// disposition: pending (resources left, only ever fewer) -> done.
//
//  - A pending cleanup is finished by the current scheduler once the launch's supervisor is
//    confirmed gone (pid + start time + boot id); before that the supervisor owns it.
//  - A launch with no cleanup state at all (its supervisor vanished before recording one) gets
//    the resources derivable from its launch id recorded as pending first, then the same.
//  - A state the supervisor could only write to its local file (the ledger was unavailable) is
//    carried into the ledger.
//  - Failures back off (bounded) and raise system alerts; one launch's cleanup never blocks
//    another's, nor any other work of the scheduler.
//
// The executor is an interface: ExecCleanupExecutor adapts src/exec/cleanup.ts
// (completeCleanup is idempotent and acts only inside the given roots and on the user's own
// unit cgroups).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LaunchId } from '../common/ids.ts';
import { existsSync } from 'node:fs';
import { cleanupPass, formatCleanupResource, parseCleanupResource, removeCleanupFile, scanCleanupFiles, type CleanupRefusal } from '../exec/cleanup.ts';
import { readPrepared } from './localState.ts';
import { unitHoldersPath } from '../exec/supervisor.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { Alerts } from './alerts.ts';
import { errorCode, isStale, isTransient, type SchedulerLedger } from './ledger.ts';
import { derivedUnitCgroupPath, unitNameOf } from './units.ts';

export interface CleanupExecutor {
  /** Releases what it can of `resources`; returns what is still left (a subset) and why each was not released. Idempotent. */
  complete(launch: LaunchId, resources: readonly string[]): Promise<{ left: string[]; refusals: readonly CleanupRefusal[] }>;
  /** Every resource a launch may have left, derived from its launch id (v35 7.1). */
  derive(launch: LaunchId): string[];
}

/** The op id of a cleanup transition: the same scheme as the supervisor's sink (src/exec/ledgerSink.ts). */
export function cleanupOp(launch: LaunchId, state: 'pending' | 'done', resources: readonly string[]): string {
  const h = createHash('sha256').update(JSON.stringify(resources)).digest('hex').slice(0, 24);
  return `cleanup:${launch}:${state}:${h}`;
}

interface SupervisorConfigCleanup {
  readonly fuseMounts?: readonly string[];
  readonly images?: readonly string[];
  readonly networkGrants?: readonly string[];
  readonly paths?: readonly string[];
}

/** Adapter over src/exec/cleanup.ts completeCleanup. */
export class ExecCleanupExecutor implements CleanupExecutor {
  private readonly stateDir: string;
  private readonly roots: readonly string[];

  /** `roots`: program-owned directories filesystem resources may lie under (scratch, state). */
  constructor(opts: { stateDir: string; roots?: readonly string[] }) {
    this.stateDir = opts.stateDir;
    this.roots = opts.roots ?? [];
  }

  private configCleanup(launch: LaunchId): SupervisorConfigCleanup {
    try {
      const cfg = JSON.parse(readFileSync(join(this.stateDir, 'configs', `${launch}.json`), 'utf8')) as { cleanup?: SupervisorConfigCleanup };
      return cfg.cleanup ?? {};
    } catch {
      return {};
    }
  }

  private launchRoots(launch: LaunchId): string[] {
    const c = this.configCleanup(launch);
    return [...(c.fuseMounts ?? []), ...(c.images ?? []), ...(c.networkGrants ?? []), ...(c.paths ?? [])];
  }

  async complete(launch: LaunchId, resources: readonly string[]): Promise<{ left: string[]; refusals: readonly CleanupRefusal[] }> {
    return cleanupPass(resources, { roots: [...this.roots, ...this.launchRoots(launch)] });
  }

  derive(launch: LaunchId): string[] {
    const c = this.configCleanup(launch);
    const out = [
      formatCleanupResource({ kind: 'cgroup', path: derivedUnitCgroupPath(unitNameOf(launch)) }),
      ...(c.fuseMounts ?? []).map((path) => formatCleanupResource({ kind: 'mount', path })),
      ...(c.images ?? []).map((path) => formatCleanupResource({ kind: 'image', path })),
      ...(c.networkGrants ?? []).map((path) => formatCleanupResource({ kind: 'grant', path })),
      ...(c.paths ?? []).map((path) => formatCleanupResource({ kind: 'path', path })),
    ];
    try {
      const holders = JSON.parse(readFileSync(unitHoldersPath(this.stateDir, launch), 'utf8')) as unknown;
      if (Array.isArray(holders)) for (const h of holders) if (typeof h === 'string' && h.startsWith('holder:')) out.push(h);
    } catch {
      /* no holders registered */
    }
    for (const f of scanCleanupFiles(this.stateDir)) if (f.launch === launch) out.push(...f.resources);
    // a seat prepared at admission (seats.ts): its mount, image and directory, bound to their
    // identities when they were created (localState.ts)
    for (const r of readPrepared(this.stateDir)) if (r.launch === launch) out.push(...r.resources);
    return preferBound([...new Set(out)]);
  }
}

/**
 * An entry bound to its identity supersedes the unbound entry of the same kind and path (exec
 * cleanup never deletes an existing entry without a registered identity: identity-unknown).
 */
export function preferBound(resources: readonly string[]): string[] {
  const bound = new Set<string>();
  const parsed = resources.map((r) => {
    try {
      const c = parseCleanupResource(r);
      const key = 'path' in c ? `${c.kind}:${c.path}` : r;
      if ('identity' in c && c.identity !== undefined) bound.add(key);
      return { r, key, unbound: !('identity' in c) || c.identity === undefined };
    } catch {
      return { r, key: r, unbound: false };
    }
  });
  return parsed.filter((x) => !(x.unbound && bound.has(x.key))).map((x) => x.r);
}

export interface CleanupManagerOptions {
  readonly ledger: SchedulerLedger;
  readonly content: ContentStore;
  readonly executor: CleanupExecutor;
  readonly alerts: Alerts;
  readonly stateDir: string;
  /** Confirmed by (pid, start time, boot id), or by the transient service being inactive when no identity was written. */
  readonly supervisorGone: (launch: LaunchId) => Promise<boolean>;
  /** Launches this scheduler is dispatching right now (registered, unit not started yet). */
  readonly busy: (launch: LaunchId) => boolean;
  /** Called for a launch whose supervisor is still there while its cleanup waits (a stuck supervisor is ended there). */
  readonly lingering?: (launch: LaunchId) => Promise<void>;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Raise an alert after this many failed attempts, then every `alertEvery` attempts. */
  readonly alertAfter?: number;
  readonly alertEvery?: number;
  readonly now?: () => number;
}

export interface CleanupPassResult {
  readonly done: LaunchId[];
  readonly pending: LaunchId[];
  readonly skipped: LaunchId[];
}

export class CleanupManager {
  private readonly o: CleanupManagerOptions;
  private readonly backoff = new Map<LaunchId, { failures: number; nextAt: number }>();
  private readonly now: () => number;

  constructor(o: CleanupManagerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  failures(launch: LaunchId): number {
    return this.backoff.get(launch)?.failures ?? 0;
  }

  private due(launch: LaunchId): boolean {
    const b = this.backoff.get(launch);
    return b === undefined || this.now() >= b.nextAt;
  }

  private async failed(launch: LaunchId, left: readonly string[], why: string): Promise<void> {
    const b = this.backoff.get(launch) ?? { failures: 0, nextAt: 0 };
    b.failures++;
    const delay = Math.min((this.o.initialBackoffMs ?? 1_000) * 2 ** (b.failures - 1), this.o.maxBackoffMs ?? 60_000);
    b.nextAt = this.now() + delay;
    this.backoff.set(launch, b);
    const after = this.o.alertAfter ?? 3;
    const every = this.o.alertEvery ?? 10;
    if (b.failures === after || (b.failures > after && (b.failures - after) % every === 0)) {
      await this.o.alerts.raise({
        category: 'cleanup-failing',
        wi: 'WI-14',
        key: `${launch}:${b.failures}`,
        trigger: `the cleanup of ${launch} failed ${b.failures} times (v35 7.1)`,
        defaultAction: `retrying with back-off (next in ${delay} ms); its resources stay counted; other work and admission continue`,
        detail: { launch, failures: b.failures, left, why, nextRetryInMs: delay },
      });
    }
  }

  private async record(launch: LaunchId, state: 'pending' | 'done', resources: readonly string[]): Promise<'pending' | 'done'> {
    const list = this.o.content.putList([...resources]);
    try {
      return (await this.o.ledger.recordCleanup(cleanupOp(launch, state, resources), launch, state, list)).state;
    } catch (e) {
      if (errorCode(e) === 'CLEANUP_REGRESSION' && /already done/.test((e as Error).message)) return 'done';
      throw e;
    }
  }

  /** One pass over every launch whose cleanup is not done. Never throws for one launch's failure. */
  async pass(): Promise<CleanupPassResult> {
    const done: LaunchId[] = [];
    const pending: LaunchId[] = [];
    const skipped: LaunchId[] = [];

    // 1. local cleanup states the supervisor could not record in the ledger
    for (const f of scanCleanupFiles(this.o.stateDir)) {
      if (f.recorded && f.state === 'done') continue;
      if (this.o.busy(f.launch) || !(await this.o.supervisorGone(f.launch))) continue;
      try {
        const cur = await this.o.ledger.cleanupState(f.launch);
        if (cur === 'done') {
          removeCleanupFile(this.o.stateDir, f.launch);
        } else if (f.state === 'done') {
          await this.record(f.launch, 'done', []);
          removeCleanupFile(this.o.stateDir, f.launch);
        } else if (cur === null) {
          await this.record(f.launch, 'pending', f.resources);
          removeCleanupFile(this.o.stateDir, f.launch);
        }
        // pending in both: the ledger's list is authoritative; step 3 finishes it.
      } catch (e) {
        if (isStale(e)) throw e;
        if (!isTransient(e) && errorCode(e) !== 'UNKNOWN_LAUNCH') throw e;
      }
    }

    // 2. launches with no cleanup state at all: derive their resources from the launch id
    for (const launch of await this.o.ledger.launchesWithoutCleanup()) {
      if (this.o.busy(launch)) {
        skipped.push(launch);
        continue;
      }
      if (!(await this.o.supervisorGone(launch))) {
        await this.o.lingering?.(launch);
        skipped.push(launch);
        continue;
      }
      await this.record(launch, 'pending', this.o.executor.derive(launch));
    }

    // 3. pending cleanups, once their supervisor is confirmed gone
    for (const p of await this.o.ledger.pendingCleanups()) {
      if (!this.due(p.launch) || this.o.busy(p.launch)) {
        skipped.push(p.launch);
        continue;
      }
      if (!(await this.o.supervisorGone(p.launch))) {
        await this.o.lingering?.(p.launch);
        skipped.push(p.launch);
        continue;
      }
      let left: string[];
      try {
        const r = await this.o.executor.complete(p.launch, p.resources);
        left = r.left;
        // a resource that is no longer what was registered, or that was never registered with
        // its identity, is never touched (WI-20)
        for (const x of r.refusals.filter((f) => f.reason === 'identity-mismatch' || f.reason === 'identity-unknown')) {
          await this.o.alerts.raise({
            category: x.reason === 'identity-unknown' ? 'cleanup-identity-unknown' : 'cleanup-identity-mismatch',
            wi: 'WI-20',
            key: `${p.launch}:${x.resource}`,
            trigger: `cleanup of ${p.launch}: ${x.detail}`,
            defaultAction:
              x.reason === 'identity-unknown'
                ? 'refused: the entry exists but was never registered with its identity, so it may not be the unit\'s; it is not removed; it stays pending and counted; other cleanup and work go on'
                : 'refused: the entry is not removed (it is not the one the unit left); it stays pending and counted; other cleanup and work go on',
            detail: { launch: p.launch, resource: x.resource, detail: x.detail },
          });
        }
      } catch (e) {
        await this.failed(p.launch, p.resources, (e as Error).message);
        pending.push(p.launch);
        continue;
      }
      if (left.length === 0) {
        await this.record(p.launch, 'done', []);
        this.backoff.delete(p.launch);
        done.push(p.launch);
        continue;
      }
      if (left.length < p.resources.length) await this.record(p.launch, 'pending', left);
      await this.failed(p.launch, left, 'resources could not be released');
      pending.push(p.launch);
    }
    return { done, pending, skipped };
  }
}
