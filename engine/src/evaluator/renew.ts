// Runs after an environment change (design 4.1 §6.5): reuse of declared runs,
// what `mp pm renew` must rerun, and the mechanical renewal of v51 5.3 with
// "closed" read as "declared".
//
// - Reuse: only a declared run is reused, for the same candidate content, the
//   same command and the same environment identity (`findReusableRun`). A
//   sampling run is never reused.
// - 4.1.2 (D-1, the honest record): after a change, a run recorded under another
//   identity still counts (semantics.ts evidenceApplicable); every read marks
//   it, and the labels resting on it, "older environment" (olderEnvironmentProof,
//   olderEnvironmentRun). Only an older run method invalidates (olderRunMethod).
// - Renewal stays the PM's explicit tool, never a ready step: `mp pm
//   renew` (package A3) reruns the declared commands of `renewalCandidates` on
//   clean checkouts of their candidates and records each new run with
//   `recordRenewedRun`. The new run must rerun the same candidate content, the
//   same full command and the same working directory (its `candidate`,
//   `command` and `cwd` fields equal the original's); then a renewal is recorded for every judgment whose rule holds
//   (both runs declared, every field the judgment uses equal, no timing,
//   statistical or external field), and the label comes back without a seat.
//   Every other judgment needs a new judgment of the same review position (a
//   Reviewer dispatch): `renewalCandidates` lists them under `reviews`.

import type { EvidenceId, JudgmentId } from '../common/ids.ts';
import { APPEND_KINDS, appendRecords, checkShape, appendFact, LedgerError, type Db, type WriteTx } from '../memory/index.ts';
import type { BaseRecord, EvidenceRecord } from '../common/records.ts';
import { ENV_LINE, recordedEnvironment } from './environment.ts';
import { renewalDecision, usesSampledFields } from './renewal.ts';
import { effectiveEvidence, positionState } from './semantics.ts';
import { rerunMismatch, RUN_FIELD, runCwdOf } from './runs.ts';
import { factRecord, StoredIndex } from './store.ts';

/**
 * A declared run that can stand for a new one (§6.5 reuse), or null: the same
 * candidate, command and working directory (`cwd`, normalized and relative to
 * the project; missing, on either side, is the root '.'), under the
 * environment identity.
 */
export function findReusableRun(
  db: Db,
  key: { readonly candidate: string; readonly command: string; readonly cwd?: string; readonly environment?: string },
): { readonly evidence: EvidenceId; readonly fields: Readonly<Record<string, string>> } | null {
  const env = key.environment ?? recordedEnvironment(db)?.identity ?? null;
  if (env === null) return null;
  const r = db
    .stmt(
      `SELECT evidence, fields FROM lbl_evidence WHERE candidate = ? AND command = ? AND env_snapshot = ? AND run_class = 'declared' AND env_line = ?
       AND COALESCE(json_extract(fields, '$.${RUN_FIELD.cwd}'), '.') = ?
       AND NOT EXISTS (SELECT 1 FROM lbl_revoked v WHERE v.evidence = lbl_evidence.evidence) ORDER BY rev DESC LIMIT 1`,
    )
    .get(key.candidate, key.command, env, ENV_LINE, key.cwd ?? '.') as { evidence: string; fields: string } | undefined;
  return r === undefined ? null : { evidence: r.evidence as EvidenceId, fields: JSON.parse(r.fields) as Record<string, string> };
}

/** One deciding judgment resting on a run recorded under another environment identity. */
export interface RenewalJudgment {
  readonly judgment: JudgmentId;
  readonly target: string;
  readonly review: string;
  /** The renewal rule can hold for it (declared run, no timing, statistical or external field); else a Reviewer judges again. */
  readonly renewable: boolean;
  readonly reason: string | null;
}

/** A run `mp pm renew` reruns: its command on a clean checkout of its candidate, under the current identity. */
export interface RenewalCandidate {
  /** The run in force that needs a rerun. */
  readonly evidence: EvidenceId;
  /** The run's candidate (`fields.candidate`), or null when it did not record one. */
  readonly candidate: string | null;
  /** The run's command (`fields.command`), or null. */
  readonly command: string | null;
  /** The run's working directory (`fields.cwd`, relative to the project; '.' when it recorded none): the rerun runs there. */
  readonly cwd: string;
  /** The source commit of each product version a judgment on this run decides. */
  readonly commits: readonly string[];
  /** The identity it was recorded under. */
  readonly environment: string;
  readonly judgments: readonly RenewalJudgment[];
}

export interface RenewalCandidates {
  /** The current identity (null before the first observation). */
  readonly environment: string | null;
  /** Runs to rerun: at least one judgment on each can be renewed mechanically. */
  readonly candidates: readonly RenewalCandidate[];
  /** Judgments that need a new judgment of the same review position instead (a Reviewer dispatch). */
  readonly reviews: readonly RenewalJudgment[];
  /** Distinct candidates affected (`mp pm next`: "renew N candidates"). */
  readonly affected: number;
}

/** One run in force for deciding judgments, recorded under another environment identity than the current one. */
interface OlderRun {
  readonly evidence: EvidenceId;
  readonly environment: string;
  readonly judgments: readonly RenewalJudgment[];
  readonly commits: readonly string[];
}

/**
 * The one walk over runs from older environments (4.1.2: they still count; reads label them, and
 * `mp pm renew` may rerun them): every run on ENV_LINE recorded under an identity other than the
 * current one (and not revoked) that a deciding judgment's evidence in force is, with those
 * judgments. renewalCandidates and olderEnvironmentProof read it; nothing derives it another way.
 */
function olderRuns(db: Db): { readonly environment: string | null; readonly runs: readonly OlderRun[]; readonly ix: StoredIndex | null } {
  const env = recordedEnvironment(db)?.identity ?? null;
  if (env === null) return { environment: null, runs: [], ix: null };
  const ix = new StoredIndex(db);
  const rows = db
    .stmt('SELECT evidence, env_snapshot FROM lbl_evidence e WHERE env_line = ? AND env_snapshot <> ? AND NOT EXISTS (SELECT 1 FROM lbl_revoked v WHERE v.evidence = e.evidence) ORDER BY evidence')
    .all(ENV_LINE, env) as Array<{ evidence: EvidenceId; env_snapshot: string }>;
  const out: OlderRun[] = [];
  for (const run of rows) {
    const ev = ix.evidence.get(run.evidence)!;
    const judgments: RenewalJudgment[] = [];
    const commits = new Set<string>();
    for (const r of db.stmt("SELECT dst FROM lbl_edges WHERE src = ? AND dst >= 'j:' AND dst < 'j;'").all(`ev:${run.evidence}`) as Array<{ dst: string }>) {
      const info = ix.judgments.get(r.dst.slice(2) as JudgmentId);
      if (info === undefined) continue;
      const j = info.rec;
      const pos = positionState(ix, j.target, j.review);
      if (pos.state === 'none' || pos.by.rec.judgment !== j.judgment) continue;
      if (!j.evidence.some((e) => effectiveEvidence(ix, j, e as EvidenceId) === run.evidence)) continue;
      const sampled = usesSampledFields(j.evidenceUse);
      const reason = ev.runClass !== 'declared' ? `a ${ev.runClass} run is never renewed` : sampled !== null ? `${sampled.reason}${sampled.field ? ` (${sampled.field})` : ''}` : j.evidenceUse.fields.length === 0 ? 'no declared fields' : null;
      judgments.push({ judgment: j.judgment, target: j.target, review: j.review, renewable: reason === null, reason });
      const c = ix.objects.get(j.target as never)?.source?.commit;
      if (c !== undefined) commits.add(c);
    }
    if (judgments.length > 0) out.push({ evidence: run.evidence, environment: run.env_snapshot, judgments, commits: [...commits].sort() });
  }
  return { environment: env, runs: out, ix };
}

/**
 * What `mp pm renew` must rerun (§6.5): every run in force for a deciding
 * judgment that was recorded under an environment identity other than the
 * current one (and is not revoked), grouped by run. 4.1.2: those runs still
 * count; renew is the PM's explicit tool, never a ready step.
 */
export function renewalCandidates(db: Db): RenewalCandidates {
  const older = olderRuns(db);
  const ix = older.ix;
  if (older.environment === null || ix === null) return { environment: null, candidates: [], reviews: [], affected: 0 };
  const candidates: RenewalCandidate[] = [];
  const reviews: RenewalJudgment[] = [];
  const affected = new Set<string>();
  for (const run of older.runs) {
    for (const j of run.judgments) if (!j.renewable) reviews.push(j);
    if (!run.judgments.some((j) => j.renewable)) continue;
    const ev = ix.evidence.get(run.evidence)!;
    const candidate = Object.hasOwn(ev.fields, 'candidate') ? ev.fields['candidate']! : null;
    candidates.push({
      evidence: run.evidence,
      candidate,
      command: Object.hasOwn(ev.fields, 'command') ? ev.fields['command']! : null,
      cwd: runCwdOf(ev.fields),
      commits: run.commits,
      environment: run.environment,
      judgments: run.judgments,
    });
    affected.add(candidate ?? (run.commits.length > 0 ? run.commits.join(',') : run.evidence));
  }
  return { environment: older.environment, candidates, reviews, affected: affected.size };
}

/**
 * 4.1.2 (D-1, the honest record): what current proof rests on runs from an older environment —
 * the runs, and the targets (object versions, proof units) whose deciding judgments rest on them.
 * They still count; every read that shows such a label or run marks it "older environment".
 */
export function olderEnvironmentProof(db: Db): { readonly environment: string | null; readonly runs: ReadonlySet<string>; readonly targets: ReadonlySet<string>; readonly judgments: number } {
  const older = olderRuns(db);
  const targets = new Set<string>();
  const judgments = new Set<string>();
  for (const r of older.runs) for (const j of r.judgments) {
    targets.add(j.target);
    judgments.add(j.judgment);
  }
  return { environment: older.environment, runs: new Set(older.runs.map((r) => r.evidence as string)), targets, judgments: judgments.size };
}

/** 4.1.2: whether one run was recorded under an older environment identity than `current` (a read labels it "older environment"). */
export function olderEnvironmentRun(rec: { readonly envLine: string; readonly envSnapshot: string }, current: string | null): boolean {
  return current !== null && rec.envLine === ENV_LINE && rec.envSnapshot !== current;
}

/** The label a read shows for a run or a label resting on runs from an older environment. */
export const OLDER_ENVIRONMENT = 'older environment';

export type RenewalOutcome = { readonly renewed: true } | { readonly renewed: false; readonly reason: string; readonly field?: string };

/** Proposal, pending ruling: renewal edges advance in log order, so no chain can return to an ancestor. */
export function replacementFollowsOriginal(db: Db, original: EvidenceId, replacement: EvidenceId): boolean {
  const ix = new StoredIndex(db);
  const a = ix.evidenceRev.get(original);
  const b = ix.evidenceRev.get(replacement);
  return a !== undefined && b !== undefined && b > a;
}

/**
 * Inside a write: record that `replacement` stands for `original` in
 * `judgment` (v51 5.3 with "declared"), when the rule holds; otherwise nothing
 * is written and the reason comes back (the judgment needs a new review).
 */
export function recordRenewal(tx: WriteTx, req: { readonly judgment: JudgmentId; readonly original: EvidenceId; readonly replacement: EvidenceId }): RenewalOutcome {
  const ix = new StoredIndex(tx);
  const j = ix.judgments.get(req.judgment);
  const a = ix.evidence.get(req.original);
  const b = ix.evidence.get(req.replacement);
  if (j === undefined || a === undefined || b === undefined) return { renewed: false, reason: 'the judgment and both runs must be recorded first' };
  if (!replacementFollowsOriginal(tx, req.original, req.replacement)) return { renewed: false, reason: 'the replacement must be recorded after the evidence it replaces' };
  const current = recordedEnvironment(tx)?.identity ?? null;
  if (b.envLine === ENV_LINE && b.envSnapshot !== current) return { renewed: false, reason: 'the new run was not recorded under the current environment identity' };
  // §6.5: the new run reran the same candidate content and the same full command; only then the 5.3 field rule.
  const notRerun = rerunMismatch(a.fields, b.fields, true);
  if (notRerun !== null) return { renewed: false, reason: notRerun };
  const d = renewalDecision(a as EvidenceRecord, b as EvidenceRecord, j.rec.evidenceUse);
  if (!d.renew) return { renewed: false, reason: d.reason, ...(d.field !== undefined ? { field: d.field } : {}) };
  const rec: BaseRecord = { kind: 'evidence.renewal', judgment: req.judgment, original: req.original, replacement: req.replacement };
  checkShape(rec, APPEND_KINDS, 'recordRenewal');
  appendFact(tx, rec);
  return { renewed: true };
}

/**
 * Inside a write (`mp pm renew`, package A3): record the rerun of `original`
 * (a declared run under the current identity) and a renewal for every judgment
 * whose evidence in force is `original` and whose rule holds. The others are
 * returned: they need a Reviewer.
 */
export function recordRenewedRun(
  tx: WriteTx,
  req: { readonly original: EvidenceId; readonly run: EvidenceRecord },
): { readonly evidence: EvidenceId; readonly renewed: readonly JudgmentId[]; readonly refused: ReadonlyArray<{ readonly judgment: JudgmentId; readonly reason: string; readonly field?: string }> } {
  const run = req.run;
  if (run.runClass !== 'declared') throw new LedgerError('BAD_REQUEST', `a renewal rerun is a declared run (4.1 §6.5), not a ${run.runClass} run`);
  const current = recordedEnvironment(tx)?.identity ?? null;
  if (run.envLine !== ENV_LINE || run.envSnapshot !== current) throw new LedgerError('BAD_REQUEST', `a renewal rerun is recorded under the current environment identity (${current ?? 'none observed'})`);
  if (run.evidence === req.original) throw new LedgerError('BAD_REQUEST', 'the rerun needs its own run id');
  const original = factRecord<EvidenceRecord>(tx, 'evidence', req.original);
  if (original === null) throw new LedgerError('BAD_REQUEST', `run ${req.original} is not recorded`);
  const notRerun = rerunMismatch(original.rec.fields, run.fields, true);
  if (notRerun !== null) throw new LedgerError('BAD_REQUEST', `run ${run.evidence} cannot renew ${req.original}: ${notRerun} (4.1 §6.5)`);
  appendRecords(tx, [run]);
  const ix = new StoredIndex(tx);
  const renewed: JudgmentId[] = [];
  const refused: Array<{ judgment: JudgmentId; reason: string; field?: string }> = [];
  const judgments = (tx.stmt("SELECT dst FROM lbl_edges WHERE src = ? AND dst >= 'j:' AND dst < 'j;'").all(`ev:${req.original}`) as Array<{ dst: string }>).map((r) => r.dst.slice(2) as JudgmentId);
  for (const jid of judgments) {
    const info = ix.judgments.get(jid);
    if (info === undefined || !info.rec.evidence.some((e) => effectiveEvidence(ix, info.rec, e as EvidenceId) === req.original)) continue;
    const out = recordRenewal(tx, { judgment: jid, original: req.original, replacement: run.evidence });
    if (out.renewed) renewed.push(jid);
    else refused.push({ judgment: jid, reason: out.reason, ...(out.field !== undefined ? { field: out.field } : {}) });
  }
  return { evidence: run.evidence, renewed, refused };
}
