// Landing with its journal on the real ledger service over IPC (6.6 step 7, 6.1, 3.9).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, revision, type AlertId, type GitOid, type MissionId, type OpId, type StopId } from '../src/common/ids.ts';
import { GIB, type FsStats } from '../src/git/admission.ts';
import { land, SimulatedCrash, type LandingKey, type LandingRequest, type PhaseRecord } from '../src/git/landing.ts';
import { landingDomain, landingIdentity, LedgerLandingJournal, recoverUnfinishedLandings, summarizeLandingRequest } from '../src/git/landingLedger.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import type { ProcessIdentity } from '../src/git/safeGit.ts';
import { readRecords } from '../src/ledger/store.ts';
import { canonicalJson } from '../src/common/hash.ts';
import type { LedgerClient } from '../src/ledger/ipc.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, startLedger, type Fixture, type LedgerHarness } from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('landing-ledger');
});
after(() => fx.cleanup());

const M = id<MissionId>('m1');
const NO_LEDGER = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };
let n = 0;

interface World {
  repo: string;
  layout: RepoLayout;
  A: GitOid;
  req: LandingRequest;
  h: LedgerHarness;
}

async function world(): Promise<World> {
  const repo = initRepo(fx, `r${n++}`);
  const A = rawCommit(fx, repo, { 'f.txt': 'one\n' }, null, 'A');
  checkoutMain(fx, repo, A);
  const B = rawCommit(fx, repo, { 'f.txt': 'two\n' }, A, 'B');
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const op = id<OpId>(`op${n++}`);
  assert.equal((await createProgramRef(fx.git, layout, deliveryRef(M, op), B)).kind, 'created');
  const h = await startLedger(join(fx.root, `ledger${n++}`));
  // 6.6 授权: a landing is authorized only for the mission's current, recorded delivery (review r1 #11).
  const manifest = h.content.put(canonicalJson({ delivery: op, commit: B, base: A }));
  await h.client.call('recordDelivery', { op: `record-${op}`, mission: M, delivery: op, commit: B, base: A, ref: deliveryRef(M, op), manifest, target: 'main' });
  return { repo, layout, A, h, req: { key: { mission: M, op }, repoPath: repo, targetBranch: 'main', base: A, delivery: B, description: d, user: fx.user, ledger: NO_LEDGER } };
}

/** details.delivery for a direct authorization of a landing of `w`'s delivery. */
function deliveryClaim(w: World): Record<string, string> {
  return { mission: M, op: w.req.key.op, commit: w.req.delivery, base: w.req.base, ref: deliveryRef(M, w.req.key.op), targetBranch: 'main' };
}

function journalFor(w: World, attempt = 0): LedgerLandingJournal {
  const { landing, intent } = landingIdentity(w.req.key, attempt);
  return new LedgerLandingJournal({
    client: w.h.client,
    content: w.h.content,
    gen: w.h.gen,
    landing,
    intent,
    tag: { mission: M, capabilities: [] },
    request: summarizeLandingRequest(w.req, w.h.content, landingDomain(w.layout)),
  });
}

function log(w: World): { revision: number; record: Record<string, unknown> }[] {
  return readRecords(w.h.paths.db, revision(0)).map((c) => ({ revision: c.revision, record: c.record as unknown as Record<string, unknown> }));
}

function rev(repo: string, r: string): string {
  return fx.raw(['rev-parse', r], repo);
}

test('phases go to the ledger in order; the push process is recorded on the intent; the intent ends verified', async () => {
  const w = await world();
  try {
    const journal = journalFor(w);
    const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
    assert.equal(rep.kind === 'checked' && rep.verification.landed, true, JSON.stringify(rep));
    const st = (await w.h.client.call('landingState', { landing: journal.landing })) as { phase: string; data: { report: string } };
    assert.equal(st.phase, 'done');
    assert.equal(JSON.parse(w.h.content.get(st.data.report as never).toString()).kind, 'checked');
    assert.equal(await w.h.client.call('intentState', { intent: journal.intent }), 'done');
    const events = log(w);
    assert.deepEqual(
      events.filter((e) => e.record.kind === 'landing.phase').map((e) => e.record.phase),
      ['authorized', 'admitted', 'pre-state', 'push', 'verify', 'done'],
    );
    const states = events.filter((e) => e.record.kind === 'intent.state' && e.record.intent === journal.intent);
    assert.deepEqual(states.map((e) => e.record.state), ['pending_verify', 'done']);
    assert.equal((states[0]?.record.executor as { pid: number }).pid > 0, true, 'the push process identity is on the intent');
    // Phases only move forward.
    await assert.rejects(
      w.h.client.call('recordLandingPhase', { op: 'again', landing: journal.landing, intent: journal.intent, phase: 'authorized', data: null }),
      /already ended|cannot go back/,
    );
    assert.deepEqual(await w.h.client.call('unfinishedLandings', {}), []);
  } finally {
    await w.h.close();
  }
});

test('a committed stop refuses the landing: refused in the ledger, nothing pushed, no intent', async () => {
  const w = await world();
  try {
    await w.h.client.call('stop', { stop: id<StopId>('s1'), scope: { kind: 'mission', mission: M }, words: '停', at: 1 });
    const journal = journalFor(w);
    const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
    assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'authorization-refused');
    assert.match(rep.kind === 'not-auto-landed' ? rep.detail : '', /STOPPED/);
    assert.equal(((await w.h.client.call('landingState', { landing: journal.landing })) as { phase: string }).phase, 'refused');
    assert.equal(await w.h.client.call('intentState', { intent: journal.intent }), null);
    assert.equal(rev(w.repo, 'main'), w.A);
  } finally {
    await w.h.close();
  }
});

test('one landing per repository at a time: a busy domain refuses; once it is released a new attempt lands', async () => {
  const w = await world();
  try {
    // Another landing of this repository holds the domain.
    await w.h.client.call('authorize', {
      op: 'other-landing',
      gen: w.h.gen,
      launch: null,
      intent: 'other-intent',
      kind: 'landing',
      domain: landingDomain(w.layout),
      tag: { mission: M, capabilities: [] },
      details: { delivery: deliveryClaim(w) },
    });
    const first = await land(w.req, { git: fx.git, journal: journalFor(w, 0), scratchDir: fx.root });
    assert.equal(first.kind === 'not-auto-landed' && first.reason, 'authorization-refused');
    assert.match(first.kind === 'not-auto-landed' ? first.detail : '', /DOMAIN_BUSY/);
    await w.h.client.call('finishIntent', { intent: 'other-intent', outcome: 'failed' });
    const second = await land(w.req, { git: fx.git, journal: journalFor(w, 1), scratchDir: fx.root });
    assert.equal(second.kind === 'checked' && second.verification.landed, true);
  } finally {
    await w.h.close();
  }
});

class CrashAfterPushProcess extends LedgerLandingJournal {
  override async recordPushProcess(key: LandingKey, p: ProcessIdentity): Promise<void> {
    await super.recordPushProcess(key, p);
    throw new SimulatedCrash('after the push process was recorded');
  }
}

class CrashBeforePush extends LedgerLandingJournal {
  override async beginPhase(key: LandingKey, rec: PhaseRecord): Promise<void> {
    if (rec.phase === 'push') throw new SimulatedCrash('before the push phase');
    await super.beginPhase(key, rec);
  }
}

test('a crash once the push started: the ledger lists it unfinished; recovery verifies, never pushes again, and finishes the intent verified', async () => {
  const w = await world();
  try {
    const { landing, intent } = landingIdentity(w.req.key, 0);
    const journal = new CrashAfterPushProcess({
      client: w.h.client,
      content: w.h.content,
      gen: w.h.gen,
      landing,
      intent,
      tag: { mission: M, capabilities: [] },
      request: summarizeLandingRequest(w.req, w.h.content, landingDomain(w.layout)),
    });
    const reflogBefore = fx.raw(['reflog', 'show', '--format=%H', 'refs/heads/main'], w.repo).split('\n').length;
    await assert.rejects(() => land(w.req, { git: fx.git, journal, scratchDir: fx.root }), SimulatedCrash);
    assert.deepEqual(await w.h.client.call('unfinishedLandings', {}), [{ landing, phase: 'push', intent }]);
    assert.equal(await w.h.client.call('intentState', { intent }), 'pending_verify');
    const results = await recoverUnfinishedLandings({ client: w.h.client, content: w.h.content, gen: w.h.gen, git: fx.git, scratchDir: fx.root, user: fx.user, ledgerReserve: NO_LEDGER });
    assert.equal(results.length, 1);
    const r = results[0]?.result;
    assert.equal(r?.kind, 'checked');
    if (r?.kind === 'checked' && r.report.kind === 'checked') {
      assert.equal(r.report.recovered, true);
      assert.equal(r.report.verification.landed, true);
      assert.equal(r.report.verification.overall, 'expected');
    }
    assert.equal(await w.h.client.call('intentState', { intent }), 'done');
    assert.equal(((await w.h.client.call('landingState', { landing })) as { phase: string }).phase, 'done');
    assert.equal(fx.raw(['reflog', 'show', '--format=%H', 'refs/heads/main'], w.repo).split('\n').length, reflogBefore + 1, 'exactly one push');
  } finally {
    await w.h.close();
  }
});

test('interrupted before the push: recovery ends it as interrupted and releases the intent; a new attempt lands', async () => {
  const w = await world();
  try {
    const { landing, intent } = landingIdentity(w.req.key, 0);
    const journal = new CrashBeforePush({
      client: w.h.client,
      content: w.h.content,
      gen: w.h.gen,
      landing,
      intent,
      tag: { mission: M, capabilities: [] },
      request: summarizeLandingRequest(w.req, w.h.content, landingDomain(w.layout)),
    });
    await assert.rejects(() => land(w.req, { git: fx.git, journal, scratchDir: fx.root }), SimulatedCrash);
    const results = await recoverUnfinishedLandings({ client: w.h.client, content: w.h.content, gen: w.h.gen, git: fx.git, scratchDir: fx.root, user: fx.user, ledgerReserve: NO_LEDGER });
    assert.deepEqual(results.map((x) => x.result.kind), ['not-started']);
    const st = (await w.h.client.call('landingState', { landing })) as { phase: string; data: { report: string } };
    assert.equal(st.phase, 'refused');
    assert.equal(JSON.parse(w.h.content.get(st.data.report as never).toString()).reason, 'interrupted-before-push');
    assert.equal(await w.h.client.call('intentState', { intent }), 'failed');
    assert.equal(rev(w.repo, 'main'), w.A);
    const again = await land(w.req, { git: fx.git, journal: journalFor(w, 1), scratchDir: fx.root });
    assert.equal(again.kind === 'checked' && again.verification.landed, true);
  } finally {
    await w.h.close();
  }
});

test('a space reminder becomes a system alert, raised before the push (6.6 空间提醒, 3.9)', async () => {
  const w = await world();
  try {
    const close: FsStats = { id: 'close', kind: 'ext4', blockSize: 4096, totalBytes: 10 * GIB, availableBytes: 1.5 * GIB, totalInodes: 1000, availableInodes: 1000 };
    const journal = journalFor(w);
    const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root, fsProbe: () => close });
    assert.equal(rep.kind === 'checked' && rep.verification.landed, true);
    const events = log(w);
    const alert = events.find((e) => e.record.kind === 'alert');
    assert.equal(alert?.record.category, 'space-reminder');
    assert.equal(alert?.record.wi, 'WI-10', 'every alert carries its work instruction (3.11 exception table)');
    const body = JSON.parse(w.h.content.get(alert?.record.body as never).toString()) as { trigger: string; landing: string; wi: string };
    assert.equal(body.landing, journal.landing);
    assert.equal(body.wi, 'WI-10');
    assert.match(body.trigger, /close to the .* the program keeps free/);
    const push = events.find((e) => e.record.kind === 'landing.phase' && e.record.phase === 'push');
    assert.ok(alert !== undefined && push !== undefined && alert.revision < push.revision, 'reminded before the push');
    assert.ok(id<AlertId>(String(alert?.record.alert)).startsWith('space-'));
  } finally {
    await w.h.close();
  }
});

test('3.11: a landing refusal reaches the PM as a system alert carrying its work instruction, trigger facts and default action', async () => {
  const w = await world();
  try {
    // A second checkout of main, past git's guard: WI-01.
    const second = join(fx.root, `second-${n++}`);
    fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-f', second, 'main'], w.repo);
    const journal = journalFor(w);
    const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
    assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'target-in-several-worktrees/WI-01', JSON.stringify(rep));
    const alerts = log(w).filter((e) => e.record.kind === 'alert');
    assert.deepEqual(
      alerts.map((e) => [e.record.wi, e.record.category]),
      [['WI-01', 'landing-occupancy']],
    );
    const body = JSON.parse(w.h.content.get(alerts[0]?.record.body as never).toString()) as {
      wi: string;
      trigger: string;
      defaultAction: string;
      facts: { reason: string; paths: string[]; occupancy: { worktree: string; branch: string | null }[] };
    };
    assert.equal(body.wi, 'WI-01');
    assert.match(body.trigger, /checked out in 2 worktrees/);
    assert.match(body.defaultAction, /at least every 10 minutes/);
    assert.deepEqual([...body.facts.paths].sort(), [w.repo, second].sort());
    assert.deepEqual(
      body.facts.occupancy.map((o) => o.branch),
      ['refs/heads/main', 'refs/heads/main'],
    );
    assert.equal(((await w.h.client.call('landingState', { landing: journal.landing })) as { phase: string }).phase, 'refused');
    assert.equal(rev(w.repo, 'main'), w.A);
  } finally {
    await w.h.close();
  }
});

// ---------------------------------------------------------------- review r1 #7, #10, #11; 6.5 landing attempts

test('review r1 #7: a landing whose terminal phase was recorded while its intent stayed open: the recovery sweep finishes the intent', async () => {
  const w = await world();
  try {
    const j = journalFor(w, 0);
    assert.deepEqual(await j.authorize(w.req.key), { ok: true });
    // The order before the fix: the terminal phase committed, then a crash before finishIntent.
    const request = summarizeLandingRequest(w.req, w.h.content, landingDomain(w.layout));
    const report = { kind: 'not-auto-landed', reason: 'insufficient-space', wi: 'WI-06', detail: 'x', paths: [], manualCommands: [] };
    await w.h.client.call('recordLandingPhase', { op: `${j.landing}:refused`, landing: j.landing, intent: j.intent, phase: 'refused', data: { request, report: w.h.content.put(canonicalJson(report)) } });
    assert.equal(await w.h.client.call('intentState', { intent: j.intent }), 'authorized');
    assert.deepEqual(await w.h.client.call('unfinishedLandings', {}), [], 'the ledger no longer lists it as unfinished');
    const results = await recoverUnfinishedLandings({ client: w.h.client, content: w.h.content, gen: w.h.gen, git: fx.git, scratchDir: fx.root, user: fx.user, ledgerReserve: NO_LEDGER });
    assert.deepEqual(results.map((x) => [x.landing, x.result.kind]), [[j.landing, 'intent-closed']]);
    assert.equal(await w.h.client.call('intentState', { intent: j.intent }), 'failed');
    // The repository's landing domain is free again.
    const again = await land(w.req, { git: fx.git, journal: journalFor(w, 1), scratchDir: fx.root });
    assert.equal(again.kind === 'checked' && again.verification.landed, true, JSON.stringify(again));
  } finally {
    await w.h.close();
  }
});

/** A client that fails one terminal-phase record, as a crash between finishIntent and the terminal phase would. */
function failingTerminalPhase(inner: LedgerClient): LedgerClient {
  let failed = false;
  return {
    call: async (method: string, params: unknown) => {
      const p = params as { phase?: string };
      if (method === 'recordLandingPhase' && (p.phase === 'refused' || p.phase === 'done') && !failed) {
        failed = true;
        throw new Error('simulated crash before the terminal phase');
      }
      return (inner.call as (m: string, p: unknown) => Promise<unknown>)(method, params);
    },
  } as unknown as LedgerClient;
}

test('review r1 #7: complete() finishes the intent before the terminal phase; a crash in between is completed by recovery', async () => {
  const w = await world();
  try {
    const { landing, intent } = landingIdentity(w.req.key, 0);
    const journal = new LedgerLandingJournal({
      client: failingTerminalPhase(w.h.client),
      content: w.h.content,
      gen: w.h.gen,
      landing,
      intent,
      tag: { mission: M, capabilities: [] },
      request: summarizeLandingRequest(w.req, w.h.content, landingDomain(w.layout)),
    });
    const tiny: FsStats = { id: 'tiny', kind: 'ext4', blockSize: 4096, totalBytes: 10 * GIB, availableBytes: GIB + 4096, totalInodes: 1000, availableInodes: 1000 };
    await assert.rejects(() => land(w.req, { git: fx.git, journal, scratchDir: fx.root, fsProbe: () => tiny }), /simulated crash/);
    assert.equal(await w.h.client.call('intentState', { intent }), 'failed', 'the intent was finished first: the domain is not held');
    assert.equal(((await w.h.client.call('landingState', { landing })) as { phase: string }).phase, 'admitted');
    const results = await recoverUnfinishedLandings({ client: w.h.client, content: w.h.content, gen: w.h.gen, git: fx.git, scratchDir: fx.root, user: fx.user, ledgerReserve: NO_LEDGER });
    assert.deepEqual(results.map((x) => x.result.kind), ['not-started']);
    assert.equal(((await w.h.client.call('landingState', { landing })) as { phase: string }).phase, 'refused');
    assert.equal(await w.h.client.call('intentState', { intent }), 'failed');
  } finally {
    await w.h.close();
  }
});

test('review r1 #10: one landing whose recovery fails does not stop the others', async () => {
  const w = await world();
  try {
    const request = summarizeLandingRequest(w.req, w.h.content, landingDomain(w.layout));
    // A landing whose recorded request cannot be read back (its description is not in the content store).
    await w.h.client.call('authorize', { op: 'bad:authorize', gen: w.h.gen, launch: null, intent: 'landing-intent-bad', kind: 'landing', domain: 'landing:elsewhere', tag: { mission: M, capabilities: [] }, details: { delivery: deliveryClaim(w) } });
    await w.h.client.call('recordLandingPhase', { op: 'bad:push', landing: 'landing-bad', intent: 'landing-intent-bad', phase: 'push', data: { request: { ...request, description: 'f'.repeat(64) }, token: 'mp-landing-none' } });
    // A good one, interrupted before the push.
    const j = journalFor(w, 0);
    assert.deepEqual(await j.authorize(w.req.key), { ok: true });
    await w.h.client.call('recordLandingPhase', { op: `${j.landing}:pre-state`, landing: j.landing, intent: j.intent, phase: 'pre-state', data: { request } });
    const results = await recoverUnfinishedLandings({ client: w.h.client, content: w.h.content, gen: w.h.gen, git: fx.git, scratchDir: fx.root, user: fx.user, ledgerReserve: NO_LEDGER });
    const byLanding = new Map(results.map((x) => [x.landing, x.result.kind] as const));
    assert.equal(byLanding.get('landing-bad'), 'error');
    assert.equal(byLanding.get(j.landing), 'not-started', 'the other landing was still recovered');
    assert.equal(await w.h.client.call('intentState', { intent: j.intent }), 'failed');
  } finally {
    await w.h.close();
  }
});

test('review r1 #11: the landing authorization carries the delivery\'s identity for the ledger to check', async () => {
  const w = await world();
  try {
    const j = journalFor(w, 0);
    assert.deepEqual(await j.authorize(w.req.key), { ok: true });
    const auth = log(w).find((e) => e.record.kind === 'intent.authorized' && e.record.intent === j.intent);
    const details = JSON.parse(w.h.content.get(auth?.record.details as never).toString()) as { delivery: Record<string, string> };
    assert.deepEqual(details.delivery, deliveryClaim(w));
  } finally {
    await w.h.close();
  }
});

test('6.5: the ledger counts a delivery\'s landing attempts as they enter the push stage; the 5th is refused (LOOP_EXHAUSTED, WI-08)', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 4; i++) assert.deepEqual(await journalFor(w, i).enterPushStage(w.req.key, `t${i}`), { ok: true, attempt: i + 1 });
    const fifth = await journalFor(w, 4).enterPushStage(w.req.key, 't4');
    assert.equal(fifth.ok, false);
    assert.match(fifth.ok ? '' : fifth.reason, /landing-attempt .* exhausted/);
    // The same attempt entering again (a retried call) is not counted twice.
    assert.deepEqual(await journalFor(w, 3).enterPushStage(w.req.key, 't3'), { ok: true, attempt: 4 });
  } finally {
    await w.h.close();
  }
});

test('review r1 #11 (ledger side): a delivery that is no longer current, or was withdrawn, is refused at authorization (DELIVERY_NOT_CURRENT, WI-06 A)', async () => {
  const w = await world();
  try {
    // A later delivery of the same mission is recorded: the earlier one is superseded.
    const op2 = id<OpId>(`op-later-${n++}`);
    const C = rawCommit(fx, w.repo, { 'f.txt': 'three\n' }, w.A, 'C');
    await createProgramRef(fx.git, w.layout, deliveryRef(M, op2), C);
    await w.h.client.call('recordDelivery', { op: `record-${op2}`, mission: M, delivery: op2, commit: C, base: w.A, ref: deliveryRef(M, op2), manifest: w.h.content.put(canonicalJson({ delivery: op2 })), target: 'main' });
    const old = await land(w.req, { git: fx.git, journal: journalFor(w, 0), scratchDir: fx.root });
    assert.equal(old.kind === 'not-auto-landed' && `${old.reason}/${old.wi}`, 'authorization-refused/WI-06', JSON.stringify(old));
    assert.match(old.kind === 'not-auto-landed' ? old.detail : '', /not current/);
    assert.equal(rev(w.repo, 'main'), w.A);
    // The current one, withdrawn by the user: refused too.
    await w.h.client.call('withdrawDelivery', { op: `withdraw-${op2}`, mission: M, delivery: op2, reason: 'the user withdrew it' });
    const req2: LandingRequest = { ...w.req, key: { mission: M, op: op2 }, delivery: C };
    const withdrawn = await land(req2, { git: fx.git, journal: journalFor({ ...w, req: req2 }, 0), scratchDir: fx.root });
    assert.equal(withdrawn.kind === 'not-auto-landed' && withdrawn.reason, 'authorization-refused');
    assert.match(withdrawn.kind === 'not-auto-landed' ? withdrawn.detail : '', /withdrawn/);
    assert.equal(rev(w.repo, 'main'), w.A);
  } finally {
    await w.h.close();
  }
});
