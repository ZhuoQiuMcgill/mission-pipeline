// 4.1.2 (D-1, the honest record): an environment change no longer invalidates proof. A run recorded
// under an older environment identity still counts (semantics.ts evidenceApplicable); what the
// reads show is the label "older environment" (renew.ts olderEnvironmentProof, olderEnvironmentRun:
// the one resolver). Here: the PM's notice, once per environment change, naming how many runs
// current proof rests on are from older environments (`mp pm next` no longer offers `mp pm renew`
// as a ready step; it stays the PM's explicit tool), the runs on a card as the seat reads them, and
// the PM's word that reopens a settled exploration whose executions ran in an older environment.

import { canonicalJson } from '../common/hash.ts';
import type { AlertId, ContentHash, EvidenceId, MissionId } from '../common/ids.ts';
import type { EvidenceRecord } from '../common/records.ts';
import { OLDER_ENVIRONMENT, olderEnvironmentProof, olderEnvironmentRun, recordedEnvironment } from '../evaluator/index.ts';
import { explorationLine } from '../flow/plandoc.ts';
import { EXPLORATION_REOPEN_REQUESTED } from '../flow/exploration/step.ts';
import { appendRecords, factById, flowEventExists, raiseAlert, type Db } from '../memory/index.ts';
import { advance } from './advance.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';

/** The notice category of an environment change under current proof. */
export const OLDER_ENVIRONMENT_NOTICE = 'environment-older-runs';

/**
 * Once per environment identity: when current proof rests on runs recorded under an older one, the
 * PM is told how many (they still count; nothing is rerun). Returns the count of such runs.
 */
export function noticeOlderEnvironment(ctx: ProcessContext): number {
  const older = ctx.memory.read((db) => olderEnvironmentProof(db));
  if (older.environment === null || older.runs.size === 0) return older.runs.size;
  const alert = `${OLDER_ENVIRONMENT_NOTICE}:${older.environment.slice(0, 32)}` as AlertId;
  const raised = ctx.memory.read((db) => Boolean(db.stmt("SELECT 1 FROM log WHERE kind = 'alert' AND json_extract(record, '$.alert') = ? LIMIT 1").get(alert)));
  if (raised) return older.runs.size;
  const body = {
    category: OLDER_ENVIRONMENT_NOTICE,
    trigger: `the environment identity changed: ${older.runs.size} run(s) that current proof rests on (${older.targets.size} object version(s), ${older.judgments} judgment(s)) were recorded under an older environment identity`,
    defaultAction: `they still count and every read shows them as "${OLDER_ENVIRONMENT}"; nothing was rerun. If the change matters for this work (for example a compiler or runtime version the tests depend on), \`mp pm renew\` reruns their declared commands under this environment; a judgment that cannot be renewed then needs a Reviewer`,
    detail: { environment: older.environment, runs: older.runs.size, targets: [...older.targets].slice(0, 50), judgments: older.judgments },
  };
  try {
    ctx.memory.write({ op: `notice:${alert}`, payload: { alert } }, (tx) => {
      if (tx.stmt("SELECT 1 FROM log WHERE kind = 'alert' AND json_extract(record, '$.alert') = ? LIMIT 1").get(alert)) return;
      raiseAlert(tx, { alert, category: OLDER_ENVIRONMENT_NOTICE, informational: true, body: tx.data.put(canonicalJson(body)) as never });
    });
  } catch {
    /* the notice is best effort; the reads still label every older run */
  }
  return older.runs.size;
}

/**
 * The card as the seat reads it (rendered at dispatch): each verification run recorded under an
 * older environment identity than the current one has "(older environment)" after its summary.
 * The card's fields (the task's spec) are not changed.
 */
export function cardForSeat<C extends { readonly seat: string } & Readonly<Record<string, unknown>>>(db: Db, card: C): C {
  const runs = card['verificationRuns'];
  if (!Array.isArray(runs) || runs.length === 0) return card;
  const current = recordedEnvironment(db)?.identity ?? null;
  if (current === null) return card;
  let changed = false;
  const shown = (runs as Array<{ evidence?: unknown; summary?: unknown }>).map((r) => {
    if (typeof r?.evidence !== 'string' || typeof r.summary !== 'string') return r;
    const rec = factById(db, 'evidence', r.evidence as EvidenceId)?.record as EvidenceRecord | undefined;
    if (rec === undefined || !olderEnvironmentRun(rec, current)) return r;
    changed = true;
    return { ...r, summary: `${r.summary} (${OLDER_ENVIRONMENT})` };
  });
  return changed ? ({ ...card, verificationRuns: shown } as C) : card;
}

/**
 * `mp pm reopen-exploration <mission> <exploration>` (4.1.2): the PM's word that a settled
 * exploration resting on evidence executions from an older environment is reopened under the
 * current one: those executions run again with the same request and the attacker re-checks the
 * same version (exploration step.ts rerunStale). Without it, the exploration is only noticed.
 * Recorded once per environment identity; the same word again is a no-op.
 */
export async function pmReopenExploration(ctx: ProcessContext, req: { readonly mission: string; readonly exploration: string; readonly words?: string | null }): Promise<{ readonly requested: boolean; readonly environment: string }> {
  const env = ctx.environment();
  const line = explorationLine(req.exploration);
  const mission = req.mission as MissionId;
  if (!ctx.memory.read((db) => Boolean(db.stmt("SELECT 1 FROM flow_events WHERE mission = ? AND line = ? AND event = 'defined' LIMIT 1").get(mission, line)))) {
    throw new ProcessError('NOT_ALLOWED', `mission ${req.mission} has no exploration ${req.exploration}`);
  }
  // the same word again is a no-op (a retried command replays the first write's receipt, so ask first)
  if (ctx.memory.read((db) => flowEventExists(db, { mission, line, event: EXPLORATION_REOPEN_REQUESTED, key: env.identity }))) return { requested: false, environment: env.identity };
  const requested = ctx.memory.write({ op: `reopen-exploration:${req.mission}:${req.exploration}:${env.identity}`, payload: { mission: req.mission, exploration: req.exploration, environment: env.identity, words: req.words ?? null }, command: 'reopen-exploration', filler: ctx.filler }, (tx) => {
    if (flowEventExists(tx, { mission, line, event: EXPLORATION_REOPEN_REQUESTED, key: env.identity })) return false;
    appendRecords(tx, [{ kind: 'flow.event', mission, line, event: EXPLORATION_REOPEN_REQUESTED, key: env.identity, body: tx.data.put(canonicalJson({ environment: env.identity, words: req.words ?? null, by: 'pm' })) as ContentHash }]);
    return true;
  });
  await advance(ctx, mission, { dispatch: null, task: null, step: `mp pm reopen-exploration ${req.mission} ${req.exploration}` });
  return { requested, environment: env.identity };
}
