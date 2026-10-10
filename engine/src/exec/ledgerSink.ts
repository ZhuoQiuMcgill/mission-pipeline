// The supervisor's ProofSink backed by the ledger service (design 7.1 steps 2-4, v35 cleanup
// state, 6.5 settlement). Loaded inside the supervisor process by module path:
//   sink: { module: '<engine>/src/exec/ledgerSink.ts', options: { socketPath: '/run/.../ledger.sock' } }
//
// Mapping of ledger answers:
//  - registerProof ok ('new' | 'same')                   -> registered (duplicate on 'same')
//  - PROOF_UNKNOWN_LAUNCH / PROOF_MALFORMED / PROOF_CONFLICT -> rejected, deterministic
//  - every other error (STORAGE_FAULT, connection, timeout)        -> unavailable, retried
// System alerts (3.11) go to the ledger's raiseAlert with their WI; the body (trigger facts,
// default action taken) is stored in the content store first.

import { createHash } from 'node:crypto';
import type { LaunchId } from '../common/ids.ts';
import type { TerminationProofRecord } from '../common/records.ts';
import { ContentStore } from '../ledger/content.ts';
import { LedgerClient, RemoteLedgerError } from '../ledger/ipc.ts';
import { deliverToLedger, type ExecAlert } from './alerts.ts';
import type { ProofRejectionReason, ProofSink, ProofSubmitResult } from './proof.ts';

export interface LedgerSinkOptions {
  readonly socketPath: string;
  /** The ledger's content store root: cleanup resource lists are stored there before recordCleanup (v35). */
  readonly contentRoot?: string;
  readonly timeoutMs?: number;
}

/** The ledger's three deterministic proof rejections, each with its own code. */
const REJECTIONS: Readonly<Record<string, ProofRejectionReason>> = {
  PROOF_CONFLICT: 'conflicting-proof',
  PROOF_UNKNOWN_LAUNCH: 'launch-mismatch',
  PROOF_MALFORMED: 'malformed',
};

export function proofRejectionReason(code: string): ProofRejectionReason | null {
  return REJECTIONS[code] ?? null;
}

function opHash(x: unknown): string {
  return createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
}

export function createProofSink(options: LedgerSinkOptions): ProofSink {
  if (typeof options?.socketPath !== 'string') throw new TypeError('ledger sink needs options.socketPath');
  const client = new LedgerClient(options.socketPath, options.timeoutMs ?? 10_000);
  const content = options.contentRoot !== undefined ? new ContentStore(options.contentRoot) : null;
  return {
    async submit(proof: TerminationProofRecord): Promise<ProofSubmitResult> {
      try {
        const r = (await client.call('registerProof', proof)) as { registered: 'new' | 'same' };
        return { kind: 'registered', ack: `termination-proof:${proof.launch}`, duplicate: r.registered === 'same' };
      } catch (e) {
        const reason = e instanceof RemoteLedgerError ? proofRejectionReason(e.code) : null;
        if (reason !== null) return { kind: 'rejected', reason, detail: (e as Error).message };
        return { kind: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
      }
    },

    async recordCleanup(launch: LaunchId, state: 'pending' | 'done', resources: readonly string[]): Promise<'recorded' | 'unavailable'> {
      if (content === null) return 'unavailable';
      try {
        // the list lives in the content store; the op id is derived from the content, so a
        // retry returns the original result and each transition (pending -> fewer -> done)
        // is its own operation
        const list = content.putList(resources);
        await client.call('recordCleanup', { op: `cleanup:${launch}:${state}:${opHash(resources)}`, launch, state, resources: list });
        return 'recorded';
      } catch (e) {
        // the ledger already has a later state (done, or fewer resources): nothing to record
        if (e instanceof RemoteLedgerError && e.code === 'CLEANUP_REGRESSION' && /already done/.test(e.message)) return 'recorded';
        return 'unavailable';
      }
    },

    async raiseAlert(alert: ExecAlert): Promise<'delivered' | 'unavailable'> {
      if (content === null) return 'unavailable';
      try {
        await deliverToLedger(client, content, 'exec', alert);
        return 'delivered';
      } catch {
        return 'unavailable';
      }
    },

    async settleOpenSpend(launch: LaunchId): Promise<'settled' | 'unavailable'> {
      try {
        await client.call('settleLaunchAtReservation', { op: `settle-at-reservation:${launch}`, launch });
        return 'settled';
      } catch {
        return 'unavailable';
      }
    },

    close(): void {
      client.close();
    },
  };
}
