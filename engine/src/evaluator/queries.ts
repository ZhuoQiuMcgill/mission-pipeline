// Queries the evaluator process answers on its socket (design 6.1 "读取").
//
// Every answer is taken from one published revision and carries it (core review
// r2 F5): map reads use the published snapshot; the continuation check and the
// deciding judgments (`deciding`, for delivery) read the incremental state only
// while it is at the published revision. While an update is between applying
// and publishing, such a query waits up to `waitMs` for the publication to
// settle and then answers at the new published revision, or fails with
// NOT_READY (retryable) — it never mixes a newer answer with an older revision
// number.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../common/hash.ts';
import type { Revision } from '../common/ids.ts';
import { RpcError, type RpcHandler } from '../common/rpc.ts';
import type { Evaluator } from './evaluator.ts';
import type { ContinuationRequest, DerivedState } from './semantics.ts';

export const DERIVED_MAPS = ['basis', 'evidenceApplicable', 'judgmentCurrent', 'positionInEffect', 'targets', 'fixes', 'ops'] as const;
export type DerivedMapName = (typeof DERIVED_MAPS)[number];

/**
 * A digest of every derived value (5.5 "全部派生值"): per map, a hash over its
 * entries in key order. Equal digests mean equal maps; a test compares the
 * process's published state with the full recomputation without shipping it.
 */
export function stateDigest(state: DerivedState): { readonly revision: number; readonly maps: Readonly<Record<DerivedMapName, string>> } {
  const maps = {} as Record<DerivedMapName, string>;
  for (const name of DERIVED_MAPS) {
    const m = state[name] as ReadonlyMap<string, unknown>;
    const keys = [...m.keys()].sort();
    const h = createHash('sha256');
    for (const k of keys) h.update(canonicalJson([k, m.get(k)])).update('\n');
    maps[name] = `${keys.length}:${h.digest('hex')}`;
  }
  return { revision: state.revision, maps };
}

function stringList(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new RpcError('BAD_REQUEST', `${key} must be a list of strings`);
  return v as string[];
}

function published(ev: Evaluator): DerivedState {
  const s = ev.state();
  if (!s) throw new RpcError('NOT_READY', 'no published revision yet');
  return s;
}

export interface QueryHandlerOptions {
  /** The ledger head, for the lag in `summary`. */
  readonly head: () => Revision;
  /** How long a continuation query waits for a publication in flight (default 1 s). */
  readonly waitMs?: number;
  /** Extra fields for `summary` (the memory pool, checkpoint state...). */
  readonly extra?: () => Record<string, unknown>;
}

/** Targets per `deciding` query (each answer carries its judgments and evidence records). */
export const MAX_DECIDING_TARGETS = 10_000;

export function evaluatorQueryHandler(ev: Evaluator, o: QueryHandlerOptions): RpcHandler {
  const waitMs = o.waitMs ?? 1000;
  /**
   * Read through the incremental state at the published revision: while an
   * update is between applying and publishing, wait for it (bounded), then
   * answer at the new published revision or fail with NOT_READY (retryable).
   */
  const atPublished = async <T>(read: () => T | null): Promise<T> => {
    let r = read();
    if (r === null && ev.state()) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([ev.settled(), new Promise<void>((res) => (timer = setTimeout(res, waitMs)))]);
      clearTimeout(timer);
      r = read();
    }
    if (r === null) throw new RpcError('NOT_READY', 'no published revision to answer at (an update is being published); retry');
    return r;
  };
  return async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'summary': {
        const s = ev.state();
        const head = o.head();
        return { revision: s?.revision ?? null, head, lag: s ? head - s.revision : null, targets: s?.targets.size ?? 0, ...(o.extra?.() ?? {}) };
      }
      case 'targets': {
        const ids = stringList(p, 'ids');
        const s = published(ev);
        return { revision: s.revision, states: Object.fromEntries(ids.map((i) => [i, s.targets.get(i) ?? null])) };
      }
      case 'ops': {
        const ids = stringList(p, 'ids');
        const s = published(ev);
        return { revision: s.revision, states: Object.fromEntries(ids.map((i) => [i, s.ops.get(i as never) ?? null])) };
      }
      case 'judgments': {
        const ids = stringList(p, 'ids');
        const s = published(ev);
        return { revision: s.revision, current: Object.fromEntries(ids.map((i) => [i, s.judgmentCurrent.get(i as never) ?? null])) };
      }
      case 'fixes': {
        const keys = stringList(p, 'keys');
        const s = published(ev);
        return { revision: s.revision, states: Object.fromEntries(keys.map((k) => [k, s.fixes.get(k) ?? null])) };
      }
      case 'digest':
        return stateDigest(published(ev));
      case 'continuation': {
        const req = p as unknown as ContinuationRequest;
        const r = await atPublished(() => ev.continuationAt(req));
        return { revision: r.revision, result: r.result };
      }
      case 'deciding': {
        // What decides each target's proof, at one published revision (delivery, 6.6).
        const targets = stringList(p, 'targets');
        if (targets.length > MAX_DECIDING_TARGETS) throw new RpcError('BAD_REQUEST', `at most ${MAX_DECIDING_TARGETS} targets per query`);
        const r = await atPublished(() => ev.decidingAt(targets));
        return { revision: r.revision, targets: Object.fromEntries(r.targets) };
      }
      default:
        throw new RpcError('BAD_REQUEST', `unknown method ${method}`);
    }
  };
}
