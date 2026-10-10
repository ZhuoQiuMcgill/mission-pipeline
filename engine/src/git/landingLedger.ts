// The landing journal on the real ledger service, over IPC (6.6 step 7; 6.1).
//
// - Phases are persisted with recordLandingPhase BEFORE each phase starts, using
//   the ledger's names: authorized, admitted, pre-state, push, verify, then done
//   or refused. They only move forward.
// - The ledger returns only a landing's latest phase and its data, so every
//   phase's data carries forward what recovery needs: the request summary, the
//   push token, and the pre-landing state (stored in the content store, which is
//   written outside the service, 6.1; only its hash travels).
// - The landing is one external action: authorize() writes its intent, with the
//   delivery's identity in its details (review r1 #11: the ledger must check in
//   the same transaction that this delivery is the current one and not
//   withdrawn; see the report); the push process identity is recorded with
//   markIntentPendingVerify, and the intent is finished only with "executor
//   gone, outcome verified" (6.1).
// - Completion finishes the intent FIRST and records the terminal phase after
//   (review r1 #7): a crash in between leaves an unfinished landing whose
//   recovery completes it again (finishing an intent twice is harmless); a
//   terminal landing whose intent is still open (a record from before this
//   order) is closed by the recovery sweep.
// - 6.5: an attempt is counted as it enters the push stage, as a `loop.attempt`
//   of kind `landing-attempt` (the first + 3 per delivery); the ledger refuses an
//   exhausted loop (LOOP_EXHAUSTED, WI-08) and then nothing is pushed.
// - Space reminders become system alerts (category space-reminder, 3.9).
// - Exception notices become system alerts carrying their work instruction
//   (`wi`, design 3.11); the body holds the trigger facts and the default action.

import { canonicalJson, sha256 } from '../common/hash.ts';
import { id, type AlertId, type ContentHash, type Generation, type GitOid, type MissionId, type OpId } from '../common/ids.ts';
import type { ContentStore } from '../ledger/content.ts';
import { RemoteLedgerError, type LedgerClient } from '../ledger/ipc.ts';
import type { ScopeTag } from '../ledger/stops.ts';
import {
  recoverLanding,
  type PushStageEntry,
  type LandingAuthorization,
  type LandingDeps,
  type LandingJournal,
  type LandingJournalState,
  type LandingKey,
  type LandingNotice,
  type LandingPhase,
  type LandingReport,
  type LandingRequest,
  type PhaseRecord,
  type PreLandingState,
  type PushOutcome,
  type RecoveryResult,
} from './landing.ts';
import type { RepoLayout } from './objects.ts';
import { deliveryRef } from './refs.ts';
import type { TransformDescription } from './representation.ts';
import type { ProcessIdentity, UserGitEnvironment } from './safeGit.ts';
import type { WorktreeRecord } from './worktreeRecord.ts';

/** Ledger answers that are decisions (the landing does not happen), not failures to reach the ledger. */
const REFUSALS: ReadonlySet<string> = new Set(['STOPPED', 'DOMAIN_BUSY', 'RECOVERY_PAUSED', 'STALE_GENERATION', 'UNRECOGNIZED_LAUNCH', 'DELIVERY_NOT_CURRENT']);

const LEDGER_PHASE: Readonly<Record<LandingPhase, string>> = {
  authorize: 'authorized',
  admit: 'admitted',
  'record-pre-state': 'pre-state',
  push: 'push',
  verify: 'verify',
};
const ORDER: readonly string[] = ['authorized', 'admitted', 'pre-state', 'push', 'verify', 'done', 'refused'];

/** What recovery needs to rebuild the landing request, stored with every phase. */
export interface LandingRequestSummary {
  readonly mission: MissionId;
  readonly op: OpId;
  readonly repoPath: string;
  readonly targetBranch: string;
  readonly base: GitOid;
  readonly delivery: GitOid;
  /** The bound transform description, in the content store (7.1). */
  readonly description: ContentHash;
  /** The conflict domain the intent was authorized in. */
  readonly domain: string;
}

interface Carry {
  readonly request: LandingRequestSummary | null;
  readonly token?: string;
  readonly pre?: ContentHash;
  /** The fixed worktree set recorded before the push (6.6 v36). */
  readonly record?: ContentHash;
  readonly push?: PushOutcome | 'unknown';
  readonly report?: ContentHash;
}

/** One landing at a time per repository (6.6: delivery is an exclusive resource). */
export function landingDomain(repo: RepoLayout): string {
  return `landing:${repo.commonDir}`;
}

/** Ids for one landing attempt of a delivery: a new attempt (after a refusal or an interruption) gets new ones. */
export function landingIdentity(key: LandingKey, attempt: number): { readonly landing: string; readonly intent: string } {
  const h = sha256(`${key.mission}\0${key.op}\0${attempt}`).slice(0, 32);
  return { landing: `landing-${h}`, intent: `landing-intent-${h}` };
}

export function summarizeLandingRequest(req: LandingRequest, content: ContentStore, domain: string): LandingRequestSummary {
  return {
    mission: req.key.mission,
    op: req.key.op,
    repoPath: req.repoPath,
    targetBranch: req.targetBranch,
    base: req.base,
    delivery: req.delivery,
    description: content.put(canonicalJson(req.description)),
    domain,
  };
}

export interface LedgerLandingJournalOptions {
  readonly client: LedgerClient;
  /** The ledger's content store (same root as the service's). */
  readonly content: ContentStore;
  /** The scheduler generation, or null for the CLI. */
  readonly gen: Generation | null;
  readonly landing: string;
  readonly intent: string;
  readonly tag: ScopeTag;
  readonly request: LandingRequestSummary;
  /** The work lineage the landing attempts count against (6.5); default `delivery:<mission>/<op>`. */
  readonly lineage?: string;
}

/** The lineage a delivery's landing attempts are counted on, unless the caller names another (6.5: per delivery). */
export function deliveryLineage(key: LandingKey): string {
  return `delivery:${key.mission}/${key.op}`;
}

export class LedgerLandingJournal implements LandingJournal {
  readonly landing: string;
  readonly intent: string;
  private readonly o: LedgerLandingJournalOptions;
  private carry: Carry;

  constructor(o: LedgerLandingJournalOptions) {
    this.o = o;
    this.landing = o.landing;
    this.intent = o.intent;
    this.carry = { request: o.request };
  }

  async authorize(key: LandingKey): Promise<LandingAuthorization> {
    try {
      await this.o.client.call('authorize', {
        op: `${this.landing}:authorize`,
        gen: this.o.gen,
        launch: null,
        intent: this.intent,
        kind: 'landing',
        domain: this.o.request.domain,
        tag: this.o.tag,
        // Review r1 #11: the delivery's identity, so the ledger can refuse a delivery that is not the current one.
        details: {
          landing: this.landing,
          mission: key.mission,
          op: key.op,
          request: this.o.request,
          delivery: {
            mission: key.mission,
            op: key.op,
            commit: this.o.request.delivery,
            base: this.o.request.base,
            ref: deliveryRef(key.mission, key.op),
            targetBranch: this.o.request.targetBranch,
          },
        },
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof RemoteLedgerError && REFUSALS.has(e.code)) return { ok: false, reason: e.message };
      throw e;
    }
  }

  private async record(phase: string, extra: Partial<Carry>): Promise<void> {
    this.carry = { ...this.carry, ...extra };
    await this.o.client.call('recordLandingPhase', { op: `${this.landing}:${phase}`, landing: this.landing, intent: this.intent, phase, data: this.carry });
  }

  async beginPhase(_key: LandingKey, rec: PhaseRecord): Promise<void> {
    if (rec.phase === 'push') {
      const pre = this.o.content.put(canonicalJson(rec.pre));
      const record = rec.record !== undefined ? { record: this.o.content.put(canonicalJson(rec.record)) } : {};
      await this.record('push', { token: rec.token, pre, ...record });
    } else if (rec.phase === 'verify') {
      await this.record('verify', { push: rec.push });
    } else {
      await this.record(LEDGER_PHASE[rec.phase], {});
    }
  }

  async enterPushStage(key: LandingKey, signature: string): Promise<PushStageEntry> {
    const lineage = this.o.lineage ?? deliveryLineage(key);
    try {
      await this.o.client.call('appendRecords', {
        op: `${this.landing}:landing-attempt`,
        gen: this.o.gen,
        // A signature unique to the attempt: entering the push stage is not a failure, so "no progress" never applies.
        records: [{ kind: 'loop.attempt', lineage, loop: 'landing-attempt', failureClass: null, signature: `${this.landing}:${signature}` }],
      });
    } catch (e) {
      if (e instanceof RemoteLedgerError && e.code === 'LOOP_EXHAUSTED') return { ok: false, reason: e.message };
      throw e;
    }
    const st = (await this.o.client.call('loopState', { lineage, loop: 'landing-attempt' })) as { attempts: number };
    return { ok: true, attempt: st.attempts };
  }

  async recordPushProcess(_key: LandingKey, p: ProcessIdentity): Promise<void> {
    await this.o.client.call('markIntentPendingVerify', { intent: this.intent, executor: { pid: p.pid, startTime: p.startTicks ?? '', bootId: p.bootId } });
  }

  /** 3.11 WI-10: space reminders carry their work instruction like every other alert. */
  async remind(key: LandingKey, message: string): Promise<void> {
    const body = this.o.content.put(
      canonicalJson({ landing: this.landing, mission: key.mission, op: key.op, wi: 'WI-10', trigger: message, defaultAction: 'a reminder only: nothing is blocked' }),
    );
    const h = sha256(`${this.landing}\0${message}`).slice(0, 24);
    await this.o.client.call('raiseAlert', { op: `${this.landing}:remind:${h}`, alert: id<AlertId>(`space-${h}`), category: 'space-reminder', wi: 'WI-10', body });
  }

  async notify(key: LandingKey, notice: LandingNotice): Promise<void> {
    const body = this.o.content.put(canonicalJson({ landing: this.landing, mission: key.mission, op: key.op, ...notice }));
    const h = sha256(`${this.landing}\0${notice.wi}\0${body}`).slice(0, 24);
    await this.o.client.call('raiseAlert', { op: `${this.landing}:notice:${h}`, alert: id<AlertId>(`${notice.wi.toLowerCase()}-${h}`), category: notice.category, wi: notice.wi, body });
  }

  async complete(_key: LandingKey, report: LandingReport): Promise<void> {
    if (report.kind === 'push-unconfirmed') return; // recovery verifies it later
    const reportHash = this.o.content.put(canonicalJson(report));
    // Review r1 #7: the intent first, the terminal phase after. The push process is gone (land() awaited it;
    // recovery confirmed it) and the result was verified; a refusal happened before any push.
    await finishLandingIntent(this.o.client, this.intent, report.kind === 'checked' && report.verification.landed ? 'done' : 'failed');
    await this.record(report.kind === 'checked' ? 'done' : 'refused', { report: reportHash });
  }

  async load(_key: LandingKey): Promise<LandingJournalState | null> {
    const st = (await this.o.client.call('landingState', { landing: this.landing })) as { phase: string; intent: string | null; data: Carry } | null;
    if (st === null) return null;
    this.carry = st.data;
    const reached = ORDER.indexOf(st.phase);
    const phases: PhaseRecord[] = [];
    const ended = st.phase === 'done' || st.phase === 'refused';
    for (const p of ['authorize', 'admit', 'record-pre-state'] as const) {
      if (ended || reached >= ORDER.indexOf(LEDGER_PHASE[p])) phases.push({ phase: p });
    }
    if (st.data.token !== undefined && st.data.pre !== undefined && (ended || reached >= ORDER.indexOf('push'))) {
      const pre = JSON.parse(this.o.content.get(st.data.pre).toString('utf8')) as PreLandingState;
      const record = st.data.record !== undefined ? (JSON.parse(this.o.content.get(st.data.record).toString('utf8')) as WorktreeRecord) : undefined;
      phases.push(record !== undefined ? { phase: 'push', pre, token: st.data.token, record } : { phase: 'push', pre, token: st.data.token });
    }
    if (st.data.push !== undefined) phases.push({ phase: 'verify', push: st.data.push });
    const report = ended && st.data.report !== undefined ? (JSON.parse(this.o.content.get(st.data.report).toString('utf8')) as LandingReport) : null;
    // The push process identity recorded on the intent (6.1); recovery also finds a stray push by its token.
    const info = (await this.o.client.call('intentInfo', { intent: this.intent })) as { executor: { pid: number; startTime: string; bootId: string } | null } | null;
    const e = info?.executor ?? null;
    const pushProcess: ProcessIdentity | null = e === null ? null : { pid: e.pid, bootId: e.bootId, startTicks: e.startTime === '' ? null : e.startTime };
    return { phases, pushProcess, report };
  }
}

export interface LedgerRecoveryDeps extends Omit<LandingDeps, 'journal'> {
  readonly client: LedgerClient;
  readonly content: ContentStore;
  readonly gen: Generation | null;
  /** The user's git environment (to read the actual transform description). */
  readonly user: UserGitEnvironment;
  readonly ledgerReserve: LandingRequest['ledger'];
}

/** Finishes a landing's intent if it is still open (idempotent). */
async function finishLandingIntent(client: LedgerClient, intent: string, outcome: 'done' | 'failed'): Promise<void> {
  const state = (await client.call('intentState', { intent })) as string | null;
  if (state === 'authorized' || state === 'pending_verify') {
    await client.call('finishIntent', { intent, outcome, verified: { executorGone: true, outcomeVerified: true } });
  }
}

export type LandingRecoveryOutcome =
  | RecoveryResult
  | { readonly kind: 'no-request' }
  /** A terminal landing whose intent was still open (review r1 #7): the intent is now finished. */
  | { readonly kind: 'intent-closed'; readonly intent: string }
  /** This landing's recovery failed; the others went on (review r1 #10). */
  | { readonly kind: 'error'; readonly message: string };

/**
 * Recovery of every landing the ledger lists as unfinished (6.6: once the push
 * phase began, verify first and never push again; before it, nothing outside the
 * ledger happened, so the landing is ended as interrupted and its intent
 * released), then the sweep of terminal landings whose intent is still open
 * (review r1 #7). One landing's failure never stops the others (review r1 #10).
 */
export async function recoverUnfinishedLandings(deps: LedgerRecoveryDeps): Promise<{ readonly landing: string; readonly result: LandingRecoveryOutcome }[]> {
  const list = (await deps.client.call('unfinishedLandings', {})) as Array<{ landing: string; phase: string; intent: string | null }>;
  const out: { landing: string; result: LandingRecoveryOutcome }[] = [];
  for (const u of list) {
    try {
      out.push({ landing: u.landing, result: await recoverOne(deps, u) });
    } catch (e) {
      out.push({ landing: u.landing, result: { kind: 'error', message: (e as Error).message } });
    }
  }
  // The sweep: landing intents still open although their landing has a terminal phase.
  const open = (await deps.client.call('openIntents', {})) as Array<{ intent: string; kind: string }>;
  for (const i of open) {
    if (i.kind !== 'landing' || !i.intent.startsWith('landing-intent-')) continue;
    const landing = `landing-${i.intent.slice('landing-intent-'.length)}`;
    try {
      const st = (await deps.client.call('landingState', { landing })) as { phase: string; intent: string | null; data: Carry } | null;
      if (st === null || (st.phase !== 'done' && st.phase !== 'refused') || st.intent !== i.intent) continue;
      let landed = false;
      if (st.data.report !== undefined) {
        const report = JSON.parse(deps.content.get(st.data.report).toString('utf8')) as LandingReport;
        landed = report.kind === 'checked' && report.verification.landed;
      }
      await finishLandingIntent(deps.client, i.intent, landed ? 'done' : 'failed');
      out.push({ landing, result: { kind: 'intent-closed', intent: i.intent } });
    } catch (e) {
      out.push({ landing, result: { kind: 'error', message: (e as Error).message } });
    }
  }
  return out;
}

async function recoverOne(deps: LedgerRecoveryDeps, u: { landing: string; phase: string; intent: string | null }): Promise<LandingRecoveryOutcome> {
  const st = (await deps.client.call('landingState', { landing: u.landing })) as { phase: string; intent: string | null; data: Carry } | null;
  const request = st?.data.request ?? null;
  if (st === null || request === null || u.intent === null) return { kind: 'no-request' };
  const description = JSON.parse(deps.content.get(request.description).toString('utf8')) as TransformDescription;
  const req: LandingRequest = {
    key: { mission: request.mission, op: request.op },
    repoPath: request.repoPath,
    targetBranch: request.targetBranch,
    base: request.base,
    delivery: request.delivery,
    description,
    user: deps.user,
    ledger: deps.ledgerReserve,
  };
  const journal = new LedgerLandingJournal({
    client: deps.client,
    content: deps.content,
    gen: deps.gen,
    landing: u.landing,
    intent: u.intent,
    tag: { mission: request.mission, capabilities: [] },
    request,
  });
  const result = await recoverLanding(req, { ...deps, journal });
  if (result.kind === 'not-started') {
    await journal.complete(req.key, {
      kind: 'not-auto-landed',
      reason: 'interrupted-before-push',
      wi: 'WI-06',
      detail: `the landing stopped at "${result.lastPhase}", before any push: nothing outside the ledger happened; land again to continue`,
      paths: [],
      manualCommands: [],
    });
  }
  if (result.kind === 'already-complete') {
    // A report exists but the phase is not terminal yet: the intent was finished, the terminal phase not recorded.
    await journal.complete(req.key, result.report);
  }
  return result;
}

/** 6.5: this delivery's landing attempts that entered the push stage, as the ledger counts them (for the PM's display). */
export async function landingAttempts(client: LedgerClient, lineage: string): Promise<{ readonly attempts: number; readonly allowed: number; readonly exhausted: boolean }> {
  const st = (await client.call('loopState', { lineage, loop: 'landing-attempt' })) as { attempts: number; allowed: number; exhausted: boolean };
  return { attempts: st.attempts, allowed: st.allowed, exhausted: st.exhausted };
}
