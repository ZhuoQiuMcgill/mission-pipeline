// The delivery's ledger side on the real ledger service, over IPC (6.6 steps 6 and 8; 6.1; 6.5).
//
// - Creating the delivery ref is an external action: authorize() writes its
//   intent in the ref's conflict domain; the ref writer's identity is recorded
//   with markIntentPendingVerify as soon as it starts; the intent is finished
//   only with "executor gone, outcome verified". Every authorize() call is a
//   new attempt with its OWN intent id (review r1 #8): an id derived only from
//   mission, op and commit made a second call the idempotent replay of the
//   first, which skipped the stop check. A superseded or failed intent is
//   released before the next one is authorized, so the domain is never left
//   busy; one whose writer may still run is never released (review r1 #9).
// - The ref's authorization names its delivery (details.delivery: mission, op,
//   commit, base, ref, target branch, and the delivery record's content hash,
//   stored BEFORE authorizing): the ledger refuses a withdrawn or superseded
//   delivery in the transaction (DELIVERY_NOT_CURRENT, WI-06 class A) and keeps
//   it on the intent. Recovery after a crash between the ref and step 8 reads it
//   back (intentInfo(intent).delivery) and records the delivery from it.
// - Rebuilds are loop.attempt records (loop "delivery-rebuild") on the work
//   lineage, written BEFORE each rebuild runs; the ledger keeps their count and
//   the granted extras (loopState), and refuses a record on an exhausted loop
//   (LOOP_EXHAUSTED, WI-08), which the delivery treats as exhausted. The limit
//   is 3 plus the extras (6.5). Each rebuild's signature is its new base, so a
//   main that keeps moving is never taken for "no progress".
// - The finished delivery is recorded with recordDelivery (6.6 step 8): the
//   manifest goes to the content store, the record carries its hash.

import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256 } from '../common/hash.ts';
import { id, type AlertId, type GitOid, type Generation } from '../common/ids.ts';
import type { IntentDelivery } from '../common/records.ts';
import type { ContentStore } from '../ledger/content.ts';
import { RemoteLedgerError, type LedgerClient } from '../ledger/ipc.ts';
import type { ScopeTag } from '../ledger/stops.ts';
import type { RepoLayout } from '../git/objects.ts';
import type { ProgramRefName, RefRecoveryAction } from '../git/refs.ts';
import type { ProcessIdentity, SafeGit } from '../git/safeGit.ts';
import {
  DELIVERY_REBUILD_LIMIT,
  recoverDeliveryRef,
  type DeliveryAuthority,
  type DeliveryIntent,
  type DeliveryKey,
  type DeliveryNotice,
  type DeliveryRecord,
  type RebuildRecord,
} from './deliver.ts';

const REFUSALS: ReadonlySet<string> = new Set(['STOPPED', 'DOMAIN_BUSY', 'RECOVERY_PAUSED', 'STALE_GENERATION', 'UNRECOGNIZED_LAUNCH', 'DELIVERY_NOT_CURRENT']);

/** The idempotency key of a delivery's step-8 record (complete() and recovery write the same one). */
export function deliveryRecordOp(mission: string, op: string, commit: string): string {
  return `delivery-record:${sha256(`${mission}\0${op}\0${commit}`).slice(0, 32)}`;
}

/** One authorized-and-unfinished creation per delivery ref (6.1 conflict domain). */
export function deliveryRefDomain(repo: RepoLayout, ref: ProgramRefName): string {
  return `ref:${repo.commonDir}:${ref}`;
}

/** A delivery record as plain JSON (6.6 step 8), for the content store. */
export function deliveryRecordJson(r: DeliveryRecord): unknown {
  return {
    key: r.key,
    targetBranch: r.targetBranch,
    base: r.base,
    commit: r.commit,
    ref: r.ref,
    rebuilds: r.rebuilds,
    landed: r.landed,
    manifest: {
      revision: r.manifest.revision,
      selected: r.manifest.selected,
      entries: r.manifest.entries.map((e) => ({ object: e.object, unit: e.unit, label: e.label, requiredBy: e.requiredBy })),
      units: r.manifest.units,
      paths: [...r.manifest.paths.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    },
    proof: r.proof,
    checks: r.checks,
  };
}

export interface LedgerDeliveryAuthorityOptions {
  readonly client: LedgerClient;
  /** The ledger's content store (same root as the service's). */
  readonly content: ContentStore;
  readonly gen: Generation | null;
  readonly tag: ScopeTag;
  /** The work lineage the rebuild limit counts against (6.5). */
  readonly lineage: string;
  /** deliveryRefDomain(repo, ref). */
  readonly domain: string;
}

export class LedgerDeliveryAuthority implements DeliveryAuthority {
  private readonly o: LedgerDeliveryAuthorityOptions;
  private current: string | null = null;

  constructor(o: LedgerDeliveryAuthorityOptions) {
    this.o = o;
  }

  /** The current intent's id (null before authorization or after finishing). */
  get intent(): string | null {
    return this.current;
  }

  private async loop(): Promise<{ attempts: number; extra: number }> {
    return (await this.o.client.call('loopState', { lineage: this.o.lineage, loop: 'delivery-rebuild' })) as { attempts: number; extra: number };
  }

  async rebuildBudget(_key: DeliveryKey): Promise<{ readonly used: number; readonly limit: number }> {
    const l = await this.loop();
    return { used: l.attempts, limit: DELIVERY_REBUILD_LIMIT + l.extra };
  }

  async authorize(key: DeliveryKey, intent: DeliveryIntent): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    if (this.current !== null) throw new Error(`intent ${this.current} is still open: finish it before authorizing another`);
    // A new identity per attempt (review r1 #8): never the idempotent replay of an earlier authorization.
    const intentId = `delivery-${sha256(`${key.mission}\0${key.op}\0${intent.commit}`).slice(0, 24)}-${randomBytes(8).toString('hex')}`;
    // The record step 8 will write, stored before authorizing: the intent names it (recovery records it from there).
    const manifest = this.o.content.put(canonicalJson(deliveryRecordJson(intent.record)));
    try {
      await this.o.client.call('authorize', {
        op: `${intentId}:authorize`,
        gen: this.o.gen,
        launch: null,
        intent: intentId,
        kind: 'delivery-ref',
        domain: this.o.domain,
        tag: this.o.tag,
        details: {
          ref: intent.ref,
          commit: intent.commit,
          base: intent.base,
          token: intent.token,
          delivery: { mission: key.mission, op: key.op, commit: intent.commit, base: intent.base, ref: intent.ref, targetBranch: intent.record.targetBranch, manifest },
        },
      });
      this.current = intentId;
      return { ok: true };
    } catch (e) {
      if (e instanceof RemoteLedgerError && REFUSALS.has(e.code)) return { ok: false, reason: e.message };
      throw e;
    }
  }

  async recordRefWriter(_key: DeliveryKey, writer: ProcessIdentity): Promise<void> {
    if (this.current === null) throw new Error('no authorized intent to record a writer on');
    await this.o.client.call('markIntentPendingVerify', {
      intent: this.current,
      executor: { pid: writer.pid, startTime: writer.startTicks ?? '', bootId: writer.bootId },
    });
  }

  async finish(_key: DeliveryKey, outcome: 'failed'): Promise<void> {
    if (this.current === null) return;
    // deliver() calls this only after the writer (if any) exited and the ref was read back.
    await this.o.client.call('finishIntent', { intent: this.current, outcome, verified: { executorGone: true, outcomeVerified: true } });
    this.current = null;
  }

  async recordRebuild(key: DeliveryKey, signature: string): Promise<RebuildRecord> {
    try {
      await this.o.client.call('appendRecords', {
        // One record per rebuild: the op is unique, so a rebuild of another delivery onto the same base still counts.
        op: `${this.o.lineage}:delivery-rebuild:${sha256(`${key.mission}\0${key.op}\0${signature}`).slice(0, 16)}-${randomBytes(6).toString('hex')}`,
        gen: this.o.gen,
        records: [{ kind: 'loop.attempt', lineage: this.o.lineage, loop: 'delivery-rebuild', failureClass: null, signature }],
      });
    } catch (e) {
      // The ledger refuses a record on an exhausted loop in its transaction (6.5, WI-08): exhausted, not a failure.
      if (e instanceof RemoteLedgerError && e.code === 'LOOP_EXHAUSTED') return { kind: 'exhausted', detail: e.message };
      throw e;
    }
    return { kind: 'recorded', total: (await this.loop()).attempts };
  }

  async complete(key: DeliveryKey, record: DeliveryRecord): Promise<void> {
    // 6.6 step 8: the manifest in the content store, the record in the ledger; then the intent is done.
    const manifest = this.o.content.put(canonicalJson(deliveryRecordJson(record)));
    await this.o.client.call('recordDelivery', {
      op: deliveryRecordOp(key.mission, key.op, record.commit),
      mission: key.mission,
      delivery: key.op,
      commit: record.commit,
      base: record.base,
      ref: record.ref,
      manifest,
      target: record.targetBranch,
    });
    if (this.current === null) return;
    await this.o.client.call('finishIntent', { intent: this.current, outcome: 'done', verified: { executorGone: true, outcomeVerified: true } });
    this.current = null;
  }

  /** 3.11: a system alert carrying the work instruction; the body holds the trigger facts and the default action. */
  async notify(key: DeliveryKey, notice: DeliveryNotice): Promise<void> {
    const body = this.o.content.put(canonicalJson({ mission: key.mission, op: key.op, lineage: this.o.lineage, ...notice }));
    const h = sha256(`${key.mission}\0${key.op}\0${notice.wi}\0${body}`).slice(0, 24);
    await this.o.client.call('raiseAlert', { op: `delivery-notice:${h}`, alert: id<AlertId>(`${notice.wi.toLowerCase()}-${h}`), category: notice.category, wi: notice.wi, body });
  }
}

/** The executor identity the ledger recorded on an intent (6.1), as a process identity. */
export async function intentExecutor(client: LedgerClient, intent: string): Promise<ProcessIdentity | null> {
  const info = (await client.call('intentInfo', { intent })) as { executor: { pid: number; startTime: string; bootId: string } | null } | null;
  const e = info?.executor ?? null;
  return e === null ? null : { pid: e.pid, bootId: e.bootId, startTicks: e.startTime === '' ? null : e.startTime };
}

/**
 * Recovery of a delivery ref whose creation did not report back (6.1), with the
 * writer identity the ledger recorded on the intent (by pid, start time and boot
 * id) in addition to the token on the writer's command line.
 */
export async function recoverDeliveryRefFromLedger(
  git: SafeGit,
  repo: RepoLayout,
  client: LedgerClient,
  key: DeliveryKey,
  intent: string,
  commit: GitOid,
  opts: { readonly waitMs?: number; readonly kill?: boolean; readonly recordDir?: string } = {},
): Promise<RefRecoveryAction> {
  return recoverDeliveryRef(git, repo, key, { commit, writer: await intentExecutor(client, intent), ...(opts.recordDir !== undefined ? { recordDir: opts.recordDir } : {}) }, opts);
}

/**
 * 6.1 recovery of a delivery-ref intent from the ledger alone, e.g. after a
 * crash between creating the ref and recording step 8: the delivery the intent
 * was authorized for (intentInfo(intent).delivery) gives the ref, the commit, the
 * target branch and the record's content. Once every writer is confirmed gone:
 * - the ref points to the delivery commit -> recordDelivery from that record
 *   (the same op complete() uses), then the intent done;
 * - absent -> the intent failed (deliver again: it re-authorizes);
 * - tampered or escaped -> the intent failed; the caller reports WI-20;
 * - a writer still running, or a lock that is not provably the program's -> the
 *   intent stays pending (WI-14).
 */
export async function settleDeliveryIntent(
  git: SafeGit,
  repo: RepoLayout,
  client: LedgerClient,
  intent: string,
  opts: { readonly waitMs?: number; readonly kill?: boolean; readonly recordDir?: string } = {},
): Promise<{ readonly action: RefRecoveryAction; readonly recorded: boolean }> {
  const info = (await client.call('intentInfo', { intent })) as {
    state: string;
    executor: { pid: number; startTime: string; bootId: string } | null;
    delivery: IntentDelivery | null;
  } | null;
  if (info === null || info.delivery === null) throw new Error(`intent ${intent} names no delivery: it cannot be recovered from the ledger`);
  const d = info.delivery;
  const key: DeliveryKey = { mission: d.mission, op: d.op as DeliveryKey['op'] };
  const writer = info.executor === null ? null : { pid: info.executor.pid, bootId: info.executor.bootId, startTicks: info.executor.startTime === '' ? null : info.executor.startTime };
  const action = await recoverDeliveryRef(git, repo, key, { commit: d.commit as GitOid, writer, ...(opts.recordDir !== undefined ? { recordDir: opts.recordDir } : {}) }, opts);
  const open = info.state === 'authorized' || info.state === 'pending_verify';
  if (action.kind === 'writer-running' || action.kind === 'lock-not-ours') return { action, recorded: false };
  let recorded = false;
  if (action.kind === 'done' && d.manifest !== null) {
    await client.call('recordDelivery', {
      op: deliveryRecordOp(d.mission, d.op, d.commit),
      mission: d.mission,
      delivery: d.op,
      commit: d.commit,
      base: d.base,
      ref: d.ref,
      manifest: d.manifest,
      target: d.targetBranch,
    });
    recorded = true;
  }
  if (open) {
    await client.call('finishIntent', { intent, outcome: action.kind === 'done' ? 'done' : 'failed', verified: { executorGone: true, outcomeVerified: true } });
  }
  return { action, recorded };
}
