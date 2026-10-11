// Deliveries, external actions and landing phases (design 4.1 §6.7; 4.0 6.6
// steps 6-8, git review r1 #11), as functions inside the caller's write.
//
// - A delivery is recorded once (its commit, base, ref, manifest); it is never
//   re-pointed; the user may withdraw it, after which it is never current.
// - An external action (a landing, a delivery ref) is authorized as an intent
//   before git runs: at most one open intent per conflict domain; none inside
//   the scope of a stop; a landing only for the mission's current, not
//   withdrawn delivery; never while git writes are held after a move (§3.3).
//   The intent stays open until the program records its result; a retry of an
//   open intent is checked against stops and currency like a new one (§6.6).
//
// Dropped with the 4.0 runtime: the launch that owned an action (and its
// generation and scope fence), the executor identity and the "pending verify"
// state (4.1 recovers a landing under the landing lock and judges it by the
// target ref, §6.7).

import { canonicalJson } from '../../common/hash.ts';
import type { ContentHash, MissionId, Revision } from '../../common/ids.ts';
import type { IntentDelivery } from '../../common/records.ts';
import { LedgerError } from '../errors.ts';
import type { WriteTx } from '../memory.ts';
import { currentDelivery, deliveryInfo, intentInfo, laterDelivery, type IntentInfo } from '../queries.ts';
import type { ScopeTag } from '../stopTypes.ts';
import { assertGitWrites } from './work.ts';
import { assertNotStopped } from './stops.ts';

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DATA_HASH = /^[0-9a-f]{64}$/;
/** Landing phase data and action details are stored as data; their size is still bounded. */
const MAX_DETAILS_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

function isOid(x: unknown): x is string {
  return typeof x === 'string' && OID.test(x);
}

/** The intent kinds whose authorization checks the delivery (6.6 steps 6 and 7). */
export const DELIVERY_BOUND_KINDS: ReadonlySet<string> = new Set(['landing', 'delivery-ref']);

/**
 * 6.6 step 8: the delivery record (what was delivered, on which base, under
 * which ref, with its manifest; `target`: the target branch it was built for).
 * It becomes the mission's current delivery unless a later delivery of the
 * mission already exists. One record per delivery: the same delivery recorded
 * again with the same commit, base and ref returns the first record's
 * revision; with another, FACT_CONFLICT (a delivery ref is never re-pointed).
 */
export function recordDelivery(
  tx: WriteTx,
  req: { mission: MissionId; delivery: string; commit: string; base: string; ref: string; manifest: ContentHash; target?: string | null; description?: ContentHash | null },
): { revision: Revision } {
  const description = req.description ?? null;
  if (description !== null && (typeof description !== 'string' || !DATA_HASH.test(description))) throw new LedgerError('RECORD_INVALID', 'description is a data hash or null');
  if (typeof req.manifest !== 'string' || !DATA_HASH.test(req.manifest)) throw new LedgerError('RECORD_INVALID', 'manifest is a data hash');
  tx.data.get(req.manifest);
  if (description !== null) tx.data.get(description);
  if (!isOid(req.commit) || !isOid(req.base)) throw new LedgerError('RECORD_INVALID', 'commit and base must be git object ids');
  if (typeof req.ref !== 'string' || !req.ref.startsWith('refs/mission-pipeline/')) throw new LedgerError('RECORD_INVALID', 'delivery refs live under refs/mission-pipeline/');
  if (typeof req.mission !== 'string' || typeof req.delivery !== 'string' || req.delivery === '') throw new LedgerError('RECORD_INVALID', 'a delivery record names its mission and delivery');
  const target = req.target ?? null;
  if (target !== null && (typeof target !== 'string' || target === '')) throw new LedgerError('RECORD_INVALID', 'target is a branch name or null');
  const own = deliveryInfo(tx, req.mission, req.delivery);
  if (own !== null && own.recordedRev !== null) {
    if (own.commit === req.commit && own.base === req.base && own.ref === req.ref) return { revision: own.recordedRev };
    throw new LedgerError('FACT_CONFLICT', `delivery ${req.delivery} of mission ${req.mission} is recorded with commit ${own.commit}, base ${own.base}, ref ${own.ref}; a delivery is never re-pointed`);
  }
  return {
    revision: tx.append({
      kind: 'delivery.recorded',
      mission: req.mission,
      delivery: req.delivery,
      commit: req.commit,
      base: req.base,
      ref: req.ref,
      manifest: req.manifest,
      ...(target !== null ? { target } : {}),
      ...(description !== null ? { description } : {}),
    }),
  };
}

/**
 * The user withdrew a delivery: it is never current again, so no landing or
 * ref creation of it is authorized (DELIVERY_NOT_CURRENT). Unknown deliveries
 * are refused (BAD_REQUEST); an already withdrawn one is left as is.
 */
export function withdrawDelivery(tx: WriteTx, req: { mission: MissionId; delivery: string; reason: string }): { revision: Revision | null } {
  if (typeof req.reason !== 'string' || req.reason === '' || Buffer.byteLength(req.reason, 'utf8') > 4096) throw new LedgerError('BAD_REQUEST', 'a withdrawal carries a reason of 1 to 4096 bytes');
  const own = deliveryInfo(tx, req.mission, req.delivery);
  if (own === null) throw new LedgerError('BAD_REQUEST', `mission ${req.mission} has no delivery ${req.delivery}`);
  if (own.state === 'withdrawn') return { revision: null };
  return { revision: tx.append({ kind: 'delivery.withdrawn', mission: req.mission, delivery: req.delivery, reason: req.reason }) };
}

// ---------------------------------------------------------------- external actions

interface DeliveryClaimFields {
  readonly mission: MissionId;
  readonly op: string;
  readonly commit: string;
  readonly base: string;
  readonly ref: string | null;
  readonly targetBranch: string | null;
  readonly manifest: ContentHash | null;
  readonly description: ContentHash | null;
}

type DeliveryClaim = { readonly kind: 'none' } | { readonly kind: 'missing' } | { readonly kind: 'claim'; readonly d: DeliveryClaimFields };

/**
 * The delivery a landing or delivery-ref action names in `details.delivery`:
 * { mission, op, commit, base, ref?, targetBranch? (or target), manifest? }.
 * A malformed one is a caller defect (BAD_REQUEST); an absent one is refused
 * after the stop check (DELIVERY_NOT_CURRENT).
 */
function deliveryClaim(kind: string, details: unknown): DeliveryClaim {
  if (!DELIVERY_BOUND_KINDS.has(kind)) return { kind: 'none' };
  const raw = details !== null && typeof details === 'object' ? (details as Record<string, unknown>).delivery : undefined;
  if (raw === undefined || raw === null) return { kind: 'missing' };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LedgerError('BAD_REQUEST', 'details.delivery is an object');
  const d = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const x = d[k];
    if (typeof x !== 'string' || x === '') throw new LedgerError('BAD_REQUEST', `details.delivery.${k} is a non-empty string`);
    return x;
  };
  const opt = (k: string): string | null => (d[k] === undefined || d[k] === null ? null : str(k));
  const commit = str('commit');
  const base = str('base');
  if (!isOid(commit) || !isOid(base)) throw new LedgerError('BAD_REQUEST', 'details.delivery.commit and .base are git object ids');
  const ref = opt('ref');
  if (ref !== null && !ref.startsWith('refs/mission-pipeline/')) throw new LedgerError('BAD_REQUEST', 'delivery refs live under refs/mission-pipeline/');
  const targetBranch = opt('targetBranch') ?? opt('target');
  const manifest = opt('manifest');
  if (manifest !== null && !DATA_HASH.test(manifest)) throw new LedgerError('BAD_REQUEST', 'details.delivery.manifest is a data hash');
  const description = opt('description');
  if (description !== null && !DATA_HASH.test(description)) throw new LedgerError('BAD_REQUEST', 'details.delivery.description is a data hash');
  const out: DeliveryClaimFields = { mission: str('mission') as MissionId, op: str('op'), commit, base, ref, targetBranch, manifest: manifest as ContentHash | null, description: description as ContentHash | null };
  if (kind === 'delivery-ref') {
    // The delivery side's intent carries the ref, commit and base at the top: they must be the checked ones.
    const top = details as Record<string, unknown>;
    for (const k of ['ref', 'commit', 'base'] as const) {
      if (top[k] !== undefined && top[k] !== out[k]) throw new LedgerError('BAD_REQUEST', `details.${k} differs from details.delivery.${k}`);
    }
  }
  return { kind: 'claim', d: out };
}

/**
 * 6.6 授权 ("确认这次交付仍是当前的、没有被取消"; git review r1 #11), in the
 * authorization's transaction:
 * - `landing`: `details.delivery` must be the mission's current delivery (the
 *   latest recorded one) with the same op, commit and base, the same target
 *   branch when one was recorded, and not withdrawn;
 * - `delivery-ref`: the delivery is being created, so it is not recorded yet:
 *   it must not be withdrawn, not superseded by a later delivery of the
 *   mission, and, if already recorded, recorded with this commit, base and ref.
 * Refusals are DELIVERY_NOT_CURRENT (WI-06, class A). Returns what the intent
 * stores (recovery reads the expected commit and ref from it).
 */
function checkDelivery(tx: WriteTx, kind: string, claim: DeliveryClaim, tag: ScopeTag): IntentDelivery | null {
  if (claim.kind === 'none') return null;
  if (claim.kind === 'missing') throw new LedgerError('DELIVERY_NOT_CURRENT', `a ${kind} action names no delivery (details.delivery): the memory cannot confirm it is the current one`);
  const d = claim.d;
  if (d.mission !== tag.mission) throw new LedgerError('SCOPE_MISMATCH', `the delivery's mission ${d.mission} is not the action's mission ${tag.mission}`);
  const own = deliveryInfo(tx, d.mission, d.op);
  if (own !== null && own.state === 'withdrawn') throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} of mission ${d.mission} was withdrawn (${own.withdrawnReason ?? ''})`);
  if (kind === 'landing') {
    const cur = currentDelivery(tx, d.mission);
    if (cur === null) throw new LedgerError('DELIVERY_NOT_CURRENT', `no delivery of mission ${d.mission} is recorded`);
    if (cur.delivery !== d.op) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is not current: the mission's latest recorded delivery is ${cur.delivery}${cur.state === 'withdrawn' ? ' (withdrawn)' : ''}`);
    if (cur.state === 'withdrawn') throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} of mission ${d.mission} was withdrawn (${cur.withdrawnReason ?? ''})`);
    if (cur.commit !== d.commit || cur.base !== d.base) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is recorded with commit ${cur.commit} on base ${cur.base}, not commit ${d.commit} on base ${d.base}`);
    if (d.ref !== null && d.ref !== cur.ref) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is recorded under ${cur.ref}, not ${d.ref}`);
    if (cur.target !== null && d.targetBranch !== cur.target) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} was built for target branch ${cur.target}, not ${d.targetBranch ?? '(none named)'}`);
    return { mission: d.mission, op: d.op, commit: cur.commit, base: cur.base, ref: cur.ref, targetBranch: d.targetBranch ?? cur.target, manifest: cur.manifest, description: cur.description ?? d.description };
  }
  if (d.ref === null) throw new LedgerError('BAD_REQUEST', 'a delivery-ref action names its ref (details.delivery.ref)');
  if (own !== null) {
    if (own.recordedRev !== null && (own.commit !== d.commit || own.base !== d.base || own.ref !== d.ref)) {
      throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is already recorded with commit ${own.commit} on base ${own.base} under ${own.ref}; a recorded delivery is never re-pointed`);
    }
    const later = laterDelivery(tx, d.mission, d.op, own.seq);
    if (later !== null) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is superseded by the mission's later delivery ${later.delivery} (${later.state})`);
  }
  if (d.manifest !== null) tx.data.get(d.manifest);
  if (d.description !== null) tx.data.get(d.description);
  return { mission: d.mission, op: d.op, commit: d.commit, base: d.base, ref: d.ref, targetBranch: d.targetBranch, manifest: d.manifest, description: d.description };
}

function checkTag(tag: ScopeTag): void {
  if (!tag || typeof tag.mission !== 'string' || !Array.isArray(tag.capabilities) || !tag.capabilities.every((c) => typeof c === 'string')) {
    throw new LedgerError('BAD_REQUEST', 'an action needs its scope tag { mission, capabilities }');
  }
}

/**
 * Authorize one external action (a landing, a delivery ref...) before git
 * runs. At most one authorized-and-unfinished action per conflict domain; none
 * in the scope of a stop; a delivery-bound action only for its current
 * delivery, and never while git writes are held. `details`: any JSON, stored
 * as data. The write's operation id is the intent's op.
 */
export function authorizeIntent(tx: WriteTx, req: { intent: string; kind: string; domain: string; tag: ScopeTag; details: unknown }): { intent: string } {
  if (typeof req.intent !== 'string' || !ID.test(req.intent)) throw new LedgerError('BAD_REQUEST', 'an intent id is 1 to 200 id characters');
  if (typeof req.kind !== 'string' || req.kind === '' || typeof req.domain !== 'string' || req.domain === '') throw new LedgerError('BAD_REQUEST', 'an intent names its kind and its conflict domain');
  checkTag(req.tag);
  const detailsJson = canonicalJson(req.details ?? null);
  if (Buffer.byteLength(detailsJson, 'utf8') > MAX_DETAILS_BYTES) throw new LedgerError('TOO_LARGE', 'action details are too large');
  const claim = deliveryClaim(req.kind, JSON.parse(detailsJson));
  // A committed stop is the safety floor: reported first.
  assertNotStopped(tx, req.tag, 'this action');
  if (DELIVERY_BOUND_KINDS.has(req.kind)) assertGitWrites(tx, `a ${req.kind}`);
  const delivery = checkDelivery(tx, req.kind, claim, req.tag);
  // Every data value the intent will name exists (recovery reads them, §6.7): the delivery's own, or the request's.
  if (delivery?.manifest) tx.data.get(delivery.manifest);
  if (delivery?.description) tx.data.get(delivery.description);
  const busy = tx.stmt("SELECT intent FROM intents WHERE domain = ? AND state = 'authorized' LIMIT 1").get(req.domain) as { intent: string } | undefined;
  if (busy) throw new LedgerError('DOMAIN_BUSY', `conflict domain ${req.domain} has unfinished action ${busy.intent}`);
  if (tx.stmt('SELECT 1 FROM intents WHERE intent = ?').get(req.intent)) throw new LedgerError('FACT_CONFLICT', `intent ${req.intent} exists`);
  const details = tx.data.put(detailsJson);
  tx.append({
    kind: 'intent.authorized',
    intent: req.intent,
    op: tx.op ?? req.intent,
    intentKind: req.kind,
    domain: req.domain,
    launch: null,
    mission: req.tag.mission,
    capabilities: [...req.tag.capabilities],
    details,
    ...(delivery !== null ? { delivery } : {}),
  });
  return { intent: req.intent };
}

/**
 * A retry of an open intent (§6.6: "a retry of an open landing intent is
 * checked against stops exactly like a new landing"): still open, outside every
 * stop, git writes not held, and its delivery still current. Returns it.
 */
export function recheckIntent(tx: WriteTx, intent: string): IntentInfo {
  const i = intentInfo(tx, intent);
  if (i === null) throw new LedgerError('BAD_REQUEST', `no intent ${intent}`);
  if (i.state !== 'authorized') throw new LedgerError('BAD_REQUEST', `intent ${intent} is ${i.state}, not open`);
  assertNotStopped(tx, i.tag, 'this action');
  if (DELIVERY_BOUND_KINDS.has(i.kind)) assertGitWrites(tx, `a ${i.kind}`);
  const details = JSON.parse(tx.data.text(i.details)) as unknown;
  checkDelivery(tx, i.kind, deliveryClaim(i.kind, details), i.tag);
  return i;
}

/** Record an action's result: done or failed (a landing the PM closes as not landed, under WI-06). An intent no longer open is left as it is. */
export function finishIntent(tx: WriteTx, req: { intent: string; outcome: 'done' | 'failed' }): { state: IntentInfo['state'] | null } {
  if (req.outcome !== 'done' && req.outcome !== 'failed') throw new LedgerError('BAD_REQUEST', 'an action finishes done or failed');
  const i = intentInfo(tx, req.intent);
  if (i?.state === 'authorized') tx.append({ kind: 'intent.state', intent: req.intent, state: req.outcome, executor: null });
  return { state: intentInfo(tx, req.intent)?.state ?? null };
}

const PHASES = ['authorized', 'admitted', 'pre-state', 'push', 'verify', 'done', 'refused'];

/**
 * Persist a landing's phase before the phase starts. `data`: the phase's facts
 * (any JSON, stored as data). Phases only move forward; recording the current
 * phase again is a no-op in effect.
 */
export function recordLandingPhase(tx: WriteTx, req: { landing: string; intent: string | null; phase: string; data: unknown }): { phase: string } {
  if (!PHASES.includes(req.phase)) throw new LedgerError('BAD_REQUEST', `unknown landing phase ${req.phase}`);
  const json = canonicalJson(req.data ?? null);
  if (Buffer.byteLength(json, 'utf8') > MAX_DETAILS_BYTES) throw new LedgerError('TOO_LARGE', 'landing phase data is too large');
  const row = tx.stmt('SELECT phase FROM landings WHERE landing = ?').get(req.landing) as { phase: string } | undefined;
  if (row && PHASES.indexOf(req.phase) < PHASES.indexOf(row.phase)) throw new LedgerError('BAD_REQUEST', `landing ${req.landing} is at ${row.phase}; cannot go back to ${req.phase}`);
  if (row && (row.phase === 'done' || row.phase === 'refused') && row.phase !== req.phase) throw new LedgerError('BAD_REQUEST', `landing ${req.landing} already ended (${row.phase})`);
  const data = tx.data.put(json);
  tx.append({ kind: 'landing.phase', landing: req.landing, intent: req.intent, phase: req.phase, data });
  return { phase: req.phase };
}
