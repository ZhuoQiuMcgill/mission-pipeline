// Flow methods on the scheduler's RPC (design 11.1): the flows run in the scheduler process
// (composeFlow, attachFlow), so the PM's requests that need the flows' scheduler port go here.
//
//   legalizationRequest { mission, endpoint, words, legalization? }
//     The user asked for a legalization: requestLegalization computes the backfill plan (it
//     needs a snapshot of the chain, from this scheduler) and records it; nothing starts until
//     the user starts it. Without `legalization`, the id is derived from the mission, the
//     endpoint and the user's words, so the same request again is the same legalization
//     (idempotent); once that one has ended, the next free id is used (a new legalization).
//     Answers { legalization, plan, started, result } (result: the outcome and its WI when the
//     plan was refused at once, WI-25).

import { createHash } from 'node:crypto';
import type { MissionId } from '../common/ids.ts';
import { RpcError } from '../common/rpc.ts';
import { legalizationState, requestLegalization } from '../flow/audit/index.ts';
import type { FlowPorts } from '../flow/ports.ts';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,60}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

export interface LegalizationAnswer {
  readonly legalization: string;
  readonly plan: unknown;
  readonly started: boolean;
  readonly result: { readonly outcome: string; readonly wi: string | null; readonly why: string; readonly nodes: readonly string[] } | null;
}

function str(p: Record<string, unknown>, k: string, re: RegExp | null = null): string {
  const v = p[k];
  if (typeof v !== 'string' || v.trim() === '' || (re !== null && !re.test(v))) throw new RpcError('BAD_REQUEST', `${k} must be ${re === null ? 'a non-empty string' : `a string matching ${re}`}`);
  return v;
}

async function answer(ports: FlowPorts, mission: MissionId, legalization: string): Promise<LegalizationAnswer> {
  const s = await legalizationState(ports, mission, legalization);
  return { legalization, plan: s.plan, started: s.started, result: s.result === null ? null : { outcome: s.result.outcome, wi: s.result.wi, why: s.result.why, nodes: s.result.nodes } };
}

/** The flow methods; `ports` is null when this scheduler runs without the flows. Returns undefined for other methods. */
export function flowRpc(ports: () => FlowPorts | null): (method: string, params: unknown) => Promise<unknown> | undefined {
  return (method, params) => {
    if (method !== 'legalizationRequest') return undefined;
    return (async () => {
      const p = ports();
      if (p === null) throw new RpcError('FLOW_UNAVAILABLE', 'this scheduler runs without the flows (no flow project is configured): legalization needs them');
      const q = (params ?? {}) as Record<string, unknown>;
      const mission = str(q, 'mission', ID) as MissionId;
      const endpoint = str(q, 'endpoint', ID);
      const words = str(q, 'words');
      let legalization: string;
      if (q['legalization'] !== undefined) legalization = str(q, 'legalization', SAFE);
      else {
        const base = `L${createHash('sha256').update(`${mission}\0${endpoint}\0${words}`).digest('hex').slice(0, 16)}`;
        legalization = base;
        // an identical request is the same legalization; once it has ended, the next one is new
        for (let n = 2; (await legalizationState(p, mission, legalization)).result !== null; n++) legalization = `${base}-${n}`;
      }
      try {
        await requestLegalization(p, { legalization, mission, endpoint, words, chainEvidence: [], capabilities: [] });
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw new RpcError('REFUSED', (e as Error).message);
      }
      return answer(p, mission, legalization);
    })();
  };
}
