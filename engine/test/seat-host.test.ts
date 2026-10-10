// Design 6.2 "席位宿主", 7.1, 9.3, 6.5, offline: each test runs one seat launch in a real
// execution unit (a transient systemd service with the unit supervisor), against a real ledger
// service, with Claude Code (the SDK's own binary) inside its enclosure, reaching a scripted
// fake model service only through the real metering proxy.
//
// Checked: the seat sees only the program's tools, its one-page definition and its card; its
// writes stay in its areas; run layers, the Claude Code exit, the Reviewer's judgment and
// findings arrive as pending results; the proof is registered and the unit is eligible; the
// program rules refuse a malformed hand-back; heartbeats; the export and transcript in the
// content store; a spend refusal, a stop (spool and SIGTERM) and the time limit end the seat
// through the SDK's abort; async evidence keeps the whole session state and a new unit
// resumes it; a request over the recovery cap is refused; a lost state degrades to a new session.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { id, type ContentHash, type LaunchId, type MissionId, type StopId } from '../src/common/ids.ts';
import { readAlerts } from '../src/exec/alerts.ts';
import { findFuse2fs } from '../src/exec/platform.ts';
import { createDiskImage, isMountPoint } from '../src/exec/sandbox.ts';
import { readRecords } from '../src/ledger/store.ts';
import type { ClaudeCodeExitRecord, IssueRecord, JudgmentRecord, RunLayerRecord, SeatResultRecord } from '../src/common/records.ts';
import { sendStop } from '../src/ledger/stops.ts';
import { checkTerminationProof } from '../src/exec/acceptance.ts';
import { DEFAULT_STOP_GRACE_MS, stopUnit } from '../src/exec/supervisor.ts';
import { SEAT_DEFINITIONS } from '../src/seat/card.ts';
import { SEAT_STOP_GRACE_MS } from '../src/seat/unit.ts';
import { heartbeatPath } from '../src/seat/host.ts';
import { readTree } from '../src/seat/tree.ts';
import type { FakeModel } from './seat-fakemodel.ts';
import { SeatHarness, UNIT_SKIP, recordsOf, recordsOf as kinds, until, type RunOptions, type UnitRun } from './seat-harness.ts';

const MODEL = 'claude-haiku-5-5';
const CONSTRUCTOR_TOOLS = ['edit_file', 'list_directory', 'read_file', 'run_command', 'search_content', 'submit_result', 'write_file'].map((t) => `mcp__program__${t}`);
const REVIEWER_TOOLS = ['list_directory', 'read_file', 'rerun_declared_command', 'search_content', 'submit_result'].map((t) => `mcp__program__${t}`);

const h = new SeatHarness();
let modelConfig = '';
let fakeLogin = '';

before(async () => {
  await h.start();
  modelConfig = h.modelConfigFile(MODEL, 1000);
  // a subscription-shaped login with fake tokens (the fake model accepts anything), plus a
  // connector token that must never reach the seat
  fakeLogin = join(h.tmp('mp-seat-login-'), 'credentials.json');
  writeFileSync(
    fakeLogin,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-fake-access', refreshToken: 'sk-ant-ort01-fake-refresh', expiresAt: Date.now() + 8 * 3_600_000, scopes: ['user:inference'] },
      mcpOAuth: { connector: { accessToken: 'connector-secret-never-copied' } },
    }),
  );
});

after(async () => {
  await h.close();
});

const runSeatUnit = (o: RunOptions): Promise<UnitRun> => h.run({ modelConfig, ...o });
const diag = (state: string, launch: LaunchId): string => h.diag(state, launch);
function fakeOf(r: UnitRun): FakeModel {
  assert.ok(r.fake !== null);
  return r.fake;
}

/** The launch's seat.result: exactly one pending, saying what the local outcome copy says. */
function seatResultOf(r: UnitRun): SeatResultRecord {
  const all = kinds(r, 'seat.result') as SeatResultRecord[];
  assert.equal(all.length, 1, `seat.result records: ${JSON.stringify(all)}`);
  const sr = all[0] as SeatResultRecord;
  const o = r.outcome;
  assert.deepEqual(
    [sr.launch, sr.seat, sr.status, sr.result, sr.export, sr.transcript, sr.recoveryState, sr.evidenceRequest],
    [r.launch, o.seat, o.status, o.result, o.export, o.transcript, o.recoveryState, o.evidenceRequest],
  );
  assert.ok(o.pendingResults.includes(`host-result:${r.launch}`));
  return sr;
}

/** A Reviewer hand-back for reviewerCard (both: every standard judged). */
const reviewerJudgment = (both: boolean) => ({
  judgments: [
    { standard: 'S1', met: 'yes', reason: 'the file holds alpha', evidence: ['evidence:E1', 'file:src/a.txt:1'] },
    ...(both ? [{ standard: 'S2', met: 'no', reason: 'no greeting at all', evidence: ['file:src/a.txt:1'] }] : []),
  ],
  gap_responses: [{ gap: 'G1', response: 'confirmed: nothing checks politeness' }],
  issue_responses: [],
  findings: ['the file has no trailing summary line'],
  verdict: 'rework',
});

// ---------------------------------------------------------------- cards

const LIMITS = {
  run: { memoryMax: 256 << 20, pidsMax: 256, timeoutMs: 60_000 },
  areaBytes: 64 << 20,
  export: { maxLogicalBytes: 1 << 20, maxFiles: 200 },
  recoveryStateBytes: 32 << 20,
  maxTurns: 12,
  wallClockMs: 120_000,
};

function common(launch: LaunchId, mission: MissionId, snapshot: string, writable: string[]): Record<string, unknown> {
  return {
    format: 'mp4.seat-card.v1',
    launch,
    mission,
    module: 'greeter',
    capabilities: [],
    duties: 'You build the greeter module.',
    decisionQuotes: [],
    constraints: [],
    workspace: { snapshot, writablePaths: writable },
    limits: LIMITS,
  };
}

function constructorCard(launch: LaunchId, mission: MissionId, snapshot: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...common(launch, mission, snapshot, ['src']),
    seat: 'constructor',
    goal: 'Write the greeting into src/out.txt.',
    standards: [{ id: 'S1', text: 'src/out.txt holds the greeting' }],
    requirementItems: [],
    readableFiles: ['src/a.txt'],
    interpreter: '',
    verificationCommands: [{ id: 'check', command: 'cat src/out.txt' }],
    interfaces: { implements: [], calls: [] },
    ...over,
  };
}

function reviewerCard(launch: LaunchId, mission: MissionId, snapshot: string): Record<string, unknown> {
  const empty = h.content.putList([]);
  return {
    ...common(launch, mission, snapshot, []),
    seat: 'reviewer',
    target: 'greeter-v1',
    review: 'review-greeter',
    standards: [
      { id: 'S1', text: 'src/a.txt holds alpha' },
      { id: 'S2', text: 'the greeting is polite' },
    ],
    interfaces: [],
    candidate: { changedPaths: ['src/a.txt'] },
    verificationRuns: [{ evidence: 'E1', command: 'cat src/a.txt', summary: 'printed alpha' }],
    declaredCommands: [{ id: 'show', command: 'echo declared-ok && cat src/a.txt' }],
    selfReportedGaps: [{ id: 'G1', text: 'no politeness check' }],
    openIssues: [],
    binding: {
      judgment: `judgment-${launch}`,
      bases: empty,
      constraints: empty,
      reliesOn: empty,
      revokes: null,
      extends: null,
      evidenceUse: { fields: [], statisticalOrExternal: false },
      superseded: [],
    },
  };
}

function treeFile(tree: ContentHash, path: string): string | null {
  const e = readTree(h.content, tree).entries.find((x) => x.path === path);
  return e?.hash != null ? h.content.get(e.hash).toString('utf8') : null;
}

// ---------------------------------------------------------------- tests

describe('seat host in an execution unit (offline, scripted model)', { skip: UNIT_SKIP }, () => {
  test('Constructor: program tools only; writes, runs and hands back; the unit is eligible and cleaned', async () => {
    const r = await runSeatUnit({
      card: constructorCard,
      credentials: { kind: 'subscription', source: fakeLogin, minLifetimeMs: 600_000 },
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__write_file', input: { path: 'src/out.txt', content: 'hello from the seat\n' } };
        if (q.step === 1) return { kind: 'tool', name: 'mcp__program__run_command', input: { command: 'cat src/out.txt && ls /' } };
        if (q.step === 2)
          return { kind: 'tool', name: 'mcp__program__submit_result', input: { done: 'wrote src/out.txt', unmet_standards: [], unfixed_problems: [], decisions_needed: [] } };
        return { kind: 'text', text: 'Done.' };
      },
    });
    const o = r.outcome;
    assert.equal(o.status, 'handed-back', `${o.reason}\n${diag(r.state, r.launch)}`);
    const sr = seatResultOf(r);
    assert.ok(sr.result !== null && sr.export !== null && sr.transcript !== null, 'the notes, the product and the transcript are in the ledger');
    assert.equal(sr.seat, 'constructor');

    // what the model was given: the seat's tools only, its definition, its card
    const main = fakeOf(r).requests.filter((q) => q.main);
    assert.equal(main.length, 4);
    for (const q of main) assert.deepEqual([...q.toolNames].sort(), CONSTRUCTOR_TOOLS);
    assert.ok(fakeOf(r).requests.every((q) => q.toolNames.every((n) => n.startsWith('mcp__program__'))), 'no built-in tool in any request');
    assert.ok(main[0]!.system.includes(SEAT_DEFINITIONS.constructor.slice(0, 80)));
    assert.ok(!main[0]!.system.includes('official CLI'), 'the default Claude Code prompt is replaced');
    assert.ok(main[0]!.userText.includes('Write the greeting into src/out.txt.'));
    assert.match(String(main[0]!.headers['authorization']), /^Bearer sk-ant-oat01-fake-access$/);
    // the run's output went back to the seat (the snapshot at /work; the root has no host home)
    assert.ok(main[2]!.userText.includes('hello from the seat'));
    assert.ok(main[2]!.userText.includes('status: completed'));

    // the product, the notes, the transcript (without the login)
    assert.equal(treeFile(o.export as ContentHash, 'src/out.txt'), 'hello from the seat\n');
    const doc = JSON.parse(h.content.get(o.result as ContentHash).toString('utf8')) as { seat: string; result: { done: string } };
    assert.deepEqual([doc.seat, doc.result.done], ['constructor', 'wrote src/out.txt']);
    const transcript = readTree(h.content, o.transcript as ContentHash).entries.map((e) => e.path);
    assert.ok(transcript.includes(`projects/-/${o.sessionId}.jsonl`), transcript.join(', '));
    assert.ok(!transcript.some((p) => p.endsWith('.credentials.json')));
    assert.equal(o.loginChanged, false);

    // Claude Code wrote only into its three areas (§14 item 1)
    assert.ok(o.claudeWritesComplete);
    for (const p of o.claudeWrites) assert.match(p, /^(config|tmp|shm)\//);
    assert.ok(o.claudeWrites.includes('config/.credentials.json'));
    assert.ok(o.claudeWrites.includes(`config/projects/-/${o.sessionId}.jsonl`));

    // pending results under the launch, the proof, the acceptance check, the cleanup
    const runs = kinds(r, 'run.layer') as RunLayerRecord[];
    assert.deepEqual(
      runs.map((x) => [x.run, x.status, x.oomKillDelta]),
      [['run-1', 'completed', 0]],
    );
    assert.deepEqual((kinds(r, 'claude-code.exit') as ClaudeCodeExitRecord[]).map((x) => x.exit), [{ code: 0, signal: null }]);
    assert.ok(r.proof !== null, diag(r.state, r.launch));
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true });
    assert.equal(r.cleanup, 'done');

    // heartbeats while running; removed at the end
    assert.ok(r.phases.includes('running'), `phases seen: ${r.phases.join(', ')}`);
    assert.equal(existsSync(heartbeatPath(r.control, r.launch)), false);

    // every model request was reserved and settled; the proxy agrees with the SDK's own count
    const s = h.svc.spendSummary(r.mission);
    assert.equal(s.inflight, 0);
    assert.ok(s.spent > 0);
    assert.equal(s.spent, o.metering.settledMicros);
    assert.equal(o.metering.requests, 4);
    assert.ok(o.sdkResult !== null);
    assert.equal(Math.round((o.sdkResult.totalCostUsd ?? -1) * 1e6), o.metering.settledMicros);
  });

  test('Reviewer: a malformed hand-back is refused; the judgment and the findings become pending results', async () => {
    const judged = reviewerJudgment;
    const r = await runSeatUnit({
      card: reviewerCard,
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__read_file', input: { path: 'src/a.txt' } };
        if (q.step === 1) return { kind: 'tool', name: 'mcp__program__rerun_declared_command', input: { id: 'show' } };
        if (q.step === 2) return { kind: 'tool', name: 'mcp__program__submit_result', input: judged(false) };
        if (q.step === 3) return { kind: 'tool', name: 'mcp__program__submit_result', input: judged(true) };
        return { kind: 'text', text: 'Done.' };
      },
    });
    assert.equal(r.outcome.status, 'handed-back', `${r.outcome.reason}\n${diag(r.state, r.launch)}`);
    const sr = seatResultOf(r);
    assert.equal(sr.seat, 'reviewer');
    assert.ok(sr.result !== null && sr.transcript !== null);
    assert.equal(sr.export, null, 'a Reviewer exports nothing');
    const main = fakeOf(r).requests.filter((q) => q.main);
    for (const q of main) assert.deepEqual([...q.toolNames].sort(), REVIEWER_TOOLS);
    assert.ok(main[1]!.userText.includes('alpha'));
    assert.ok(main[2]!.userText.includes('declared-ok'));
    assert.ok(main[3]!.userText.includes('Not accepted'), 'the incomplete hand-back was refused');
    assert.ok(main[3]!.userText.includes('standard "S2" is not judged'));

    const [j] = kinds(r, 'judgment') as JudgmentRecord[];
    assert.ok(j !== undefined);
    assert.equal(j.verdict, 'fail');
    assert.equal(j.judgment, `judgment-${r.launch}`);
    assert.deepEqual(h.content.getList(j.evidence), ['E1']);
    const [issue] = kinds(r, 'issue') as IssueRecord[];
    assert.ok(issue !== undefined);
    assert.ok(issue.text !== undefined);
    assert.equal(issue.issue, `finding:${issue.text}`);
    const finding = JSON.parse(h.content.get(issue.text).toString('utf8')) as { text: string };
    assert.equal(finding.text, 'the file has no trailing summary line');
    assert.equal((kinds(r, 'run.layer') as RunLayerRecord[]).length, 1);
    assert.ok(r.proof !== null);
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true });
    assert.equal(r.outcome.export, null, 'a Reviewer exports nothing');
  });

  test('spend limit: the first request is refused before it is forwarded, and the seat is aborted', async () => {
    const r = await runSeatUnit({
      card: constructorCard,
      before: async (_launch, mission) => {
        await h.client.call('setSpendLimit', { op: `limit:${mission}`, mission, micros: 1_000 });
      },
      script: () => ({ kind: 'text', text: 'never reached' }),
    });
    assert.equal(r.outcome.status, 'cancelled', diag(r.state, r.launch));
    assert.equal(r.outcome.endedBy, 'spend-limit');
    seatResultOf(r);
    assert.equal(fakeOf(r).requests.filter((q) => q.main).length, 0, 'nothing reached the model service');
    assert.deepEqual(h.svc.spendSummary(r.mission), { limit: 1_000, spent: 0, inflight: 0 });
    assert.ok(r.outcome.metering.refused >= 1);
    assert.ok(r.proof !== null);
    assert.equal(r.cleanup, 'done');
  });

  test('a stop in the control-plane spool ends the seat mid-request; its reservation is settled', async () => {
    const r = await runSeatUnit({
      card: constructorCard,
      script: () => ({ kind: 'stall' }),
      during: async ({ mission, control, state, fake }) => {
        await until(() => (fake?.requests ?? []).some((q) => q.main), 60_000, 'the first model request');
        sendStop({ inbox: join(state, 'inbox'), controlPlane: control }, { stop: id<StopId>('stop-1'), scope: { kind: 'mission', mission }, words: 'stop this', at: Date.now() });
      },
    });
    assert.equal(r.outcome.status, 'cancelled', diag(r.state, r.launch));
    assert.equal(r.outcome.endedBy, 'stop');
    seatResultOf(r);
    const s = h.svc.spendSummary(r.mission);
    assert.equal(s.inflight, 0);
    assert.ok(s.spent > 0, 'a request that reached the model service is settled at its reservation');
    assert.ok(r.proof !== null);
    assert.equal(r.cleanup, 'done');
  });

  test('a stop already spooled when the unit starts: the seat never starts', async () => {
    const r = await runSeatUnit({
      card: constructorCard,
      before: async (_launch, mission, { control, state }) => {
        sendStop({ inbox: join(state, 'inbox'), controlPlane: control }, { stop: id<StopId>('stop-early'), scope: { kind: 'mission', mission }, words: 'not now', at: Date.now() });
      },
      script: () => ({ kind: 'text', text: 'never reached' }),
    });
    assert.equal(r.outcome.status, 'cancelled', diag(r.state, r.launch));
    assert.equal(r.outcome.endedBy, 'stop');
    seatResultOf(r);
    assert.equal(fakeOf(r).requests.length, 0);
    assert.equal(r.outcome.claudeExit, null, 'no Claude Code process was started');
    assert.equal((kinds(r, 'claude-code.exit') as ClaudeCodeExitRecord[]).length, 0);
    assert.ok(r.proof !== null);
    assert.equal(r.cleanup, 'done');
  });

  test('a stop through the supervisor (SIGTERM) ends the seat the same way', async () => {
    const r = await runSeatUnit({
      card: constructorCard,
      script: () => ({ kind: 'stall' }),
      during: async ({ unitName, fake }) => {
        await until(() => (fake?.requests ?? []).some((q) => q.main), 60_000, 'the first model request');
        await stopUnit(unitName);
      },
    });
    assert.equal(r.outcome.status, 'cancelled', diag(r.state, r.launch));
    assert.equal(r.outcome.endedBy, 'stop');
    seatResultOf(r);
    assert.equal(h.svc.spendSummary(r.mission).inflight, 0);
    assert.equal((kinds(r, 'claude-code.exit') as ClaudeCodeExitRecord[]).length, 1, 'the aborted Claude Code process still has its end recorded');
    assert.ok(r.proof !== null);
    assert.equal(r.cleanup, 'done');
  });

  test("the card's time limit ends the seat", async () => {
    const r = await runSeatUnit({
      card: (l, m, s) => constructorCard(l, m, s, { limits: { ...LIMITS, wallClockMs: 4_000 } }),
      script: () => ({ kind: 'stall' }),
    });
    assert.equal(r.outcome.status, 'timed-out', diag(r.state, r.launch));
    seatResultOf(r);
    assert.equal(r.outcome.endedBy, 'timeout');
  });

  test('async evidence: the whole session state is kept, and a new unit resumes the same session', async () => {
    const round1 = await runSeatUnit({
      card: (l, m, s) => constructorCard(l, m, s, { allowAsyncEvidence: true }),
      credentials: { kind: 'subscription', source: fakeLogin, minLifetimeMs: 600_000 },
      script: (q) =>
        q.step === 0
          ? { kind: 'tool', name: 'mcp__program__request_evidence', input: { steps: ['time the greeter on 1 MB'], data: 'none', measure: ['ms'], assertions: ['under 100 ms'] } }
          : { kind: 'text', text: 'Waiting for the evidence.' },
    });
    const o1 = round1.outcome;
    assert.equal(o1.status, 'needs-evidence', `${o1.reason}\n${diag(round1.state, round1.launch)}`);
    const sr1 = seatResultOf(round1);
    assert.ok(sr1.recoveryState !== null && sr1.evidenceRequest !== null);
    const req = JSON.parse(h.content.get(o1.evidenceRequest as ContentHash).toString('utf8')) as { steps: string[] };
    assert.deepEqual(req.steps, ['time the greeter on 1 MB']);
    const state = readTree(h.content, o1.recoveryState as ContentHash).entries.map((e) => e.path);
    assert.ok(state.includes(`projects/-/${o1.sessionId}.jsonl`), state.join(', '));
    assert.ok(!state.some((p) => p.endsWith('.credentials.json')), 'the login is never part of a recovery state');

    const round2 = await runSeatUnit({
      card: (l, m, s) =>
        constructorCard(l, m, s, { allowAsyncEvidence: true, resume: { sessionId: o1.sessionId, state: o1.recoveryState, evidence: 'EVIDENCE-RESULT-42: 37 ms' } }),
      credentials: { kind: 'subscription', source: fakeLogin, minLifetimeMs: 600_000 },
      script: (q) =>
        q.userText.includes('EVIDENCE-RESULT-42') && !q.userText.includes('Recorded as')
          ? { kind: 'tool', name: 'mcp__program__submit_result', input: { done: 'measured: 37 ms', unmet_standards: [], unfixed_problems: [], decisions_needed: [] } }
          : { kind: 'text', text: 'Done.' },
    });
    const o2 = round2.outcome;
    assert.equal(o2.status, 'handed-back', `${o2.reason}\n${diag(round2.state, round2.launch)}`);
    seatResultOf(round2);
    assert.equal(o2.resumeDegraded, null);
    const first = fakeOf(round2).requests.find((q) => q.main);
    assert.ok(first !== undefined);
    assert.equal(first.step, 2, 'the resumed conversation carries the earlier round');
    assert.ok(first.userText.includes('Write the greeting into src/out.txt.'), 'the original card is in the history');
    assert.ok(first.userText.includes('EVIDENCE-RESULT-42'));
    assert.equal(o2.sessionId, o1.sessionId);
  });

  test('async evidence over the recovery cap is refused; the seat hands back instead', async () => {
    const r = await runSeatUnit({
      card: (l, m, s) => constructorCard(l, m, s, { allowAsyncEvidence: true, limits: { ...LIMITS, recoveryStateBytes: 1_000 } }),
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__request_evidence', input: { steps: ['x'], data: '', measure: [], assertions: [] } };
        if (q.step === 1) return { kind: 'tool', name: 'mcp__program__submit_result', input: { done: 'handed back instead', unmet_standards: [], unfixed_problems: [], decisions_needed: [] } };
        return { kind: 'text', text: 'Done.' };
      },
    });
    assert.equal(r.outcome.status, 'handed-back', diag(r.state, r.launch));
    const main = fakeOf(r).requests.filter((q) => q.main);
    assert.ok(main[1]!.userText.includes('Not accepted'));
    seatResultOf(r);
    assert.ok(main[1]!.userText.includes('recovery cap'));
    assert.equal(r.outcome.recoveryState, null);
    assert.equal(r.outcome.evidenceRefusals.length, 1, 'the refusal is recorded (WI-17: the PM is told from the second one)');
  });

  test('a lost recovery state degrades to a new session given the card and the evidence', async () => {
    const r = await runSeatUnit({
      card: (l, m, s) => constructorCard(l, m, s, { resume: { sessionId: '00000000-0000-4000-8000-000000000000', state: null, evidence: 'EVIDENCE-X' } }),
      script: (q) =>
        q.step === 0
          ? { kind: 'tool', name: 'mcp__program__submit_result', input: { done: 'restarted', unmet_standards: [], unfixed_problems: [], decisions_needed: [] } }
          : { kind: 'text', text: 'Done.' },
    });
    assert.equal(r.outcome.status, 'handed-back', diag(r.state, r.launch));
    assert.equal(r.outcome.resumeDegraded, 'no recovery state was kept');
    seatResultOf(r);
    const first = fakeOf(r).requests.find((q) => q.main);
    assert.ok(first !== undefined && first.step === 0);
    assert.ok(first.userText.includes('could not be resumed'));
    assert.ok(first.userText.includes('Write the greeting into src/out.txt.'));
    assert.ok(first.userText.includes('EVIDENCE-X'));
  });
  test('Reviewer scratch: rerun commands write into the scratch paths only; nothing is exported or kept', async () => {
    const r = await runSeatUnit({
      files: { 'src/a.txt': 'alpha\n', 'docs/readme.txt': 'docs\n' },
      card: (l, m, s) => ({
        ...reviewerCard(l, m, s),
        workspace: { snapshot: s, writablePaths: [], scratchPaths: ['src'] },
        declaredCommands: [
          { id: 'build', command: 'mkdir -p src/build && echo built-in-scratch > src/build/out.txt && cat src/build/out.txt' },
          { id: 'outside', command: 'echo x > docs/new.txt' },
        ],
      }),
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__rerun_declared_command', input: { id: 'build' } };
        if (q.step === 1) return { kind: 'tool', name: 'mcp__program__rerun_declared_command', input: { id: 'outside' } };
        if (q.step === 2) return { kind: 'tool', name: 'mcp__program__read_file', input: { path: 'src/build/out.txt' } };
        if (q.step === 3) return { kind: 'tool', name: 'mcp__program__submit_result', input: reviewerJudgment(true) };
        return { kind: 'text', text: 'Done.' };
      },
    });
    assert.equal(r.outcome.status, 'handed-back', `${r.outcome.reason}\n${diag(r.state, r.launch)}`);
    const main = fakeOf(r).requests.filter((q) => q.main);
    for (const q of main) assert.deepEqual([...q.toolNames].sort(), REVIEWER_TOOLS, 'scratch adds no file-writing tool');
    assert.ok(main[0]!.userText.includes('Scratch paths'), 'the card names the scratch');
    assert.match(main[1]!.userText, /status: completed[\s\S]*built-in-scratch/);
    assert.match(main[2]!.userText, /Read-only file system/, 'outside the scratch the snapshot stays read-only');
    assert.ok(main[3]!.userText.includes('built-in-scratch'), 'the seat can read what its command wrote');
    assert.equal(seatResultOf(r).export, null);
    assert.equal(r.outcome.export, null);
    assert.equal(existsSync(join(r.snapshot, 'src', 'build')), false, 'the host snapshot is untouched');
    assert.equal((kinds(r, 'run.layer') as RunLayerRecord[]).length, 2);
    assert.ok(r.proof !== null);
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true });
  });

  test(`a stop during a slow transcript capture: the seat unit's ${SEAT_STOP_GRACE_MS / 1000} s grace lets the host finish its report`, async () => {
    const delay = DEFAULT_STOP_GRACE_MS + 4_000;
    let took = 0;
    const r = await runSeatUnit({
      card: constructorCard,
      script: () => ({ kind: 'stall' }),
      hostConfig: { testHooks: { finishingDelayMs: delay } },
      during: async ({ unitName, fake }) => {
        await until(() => (fake?.requests ?? []).some((q) => q.main), 60_000, 'the first model request');
        const t0 = Date.now();
        await stopUnit(unitName);
        took = Date.now() - t0;
      },
    });
    assert.ok(took > DEFAULT_STOP_GRACE_MS && took < SEAT_STOP_GRACE_MS, `the stop took ${took} ms`);
    assert.equal(r.outcome.status, 'cancelled', diag(r.state, r.launch));
    assert.equal(r.outcome.endedBy, 'stop');
    assert.ok(r.outcome.transcript !== null, 'the slow capture completed');
    seatResultOf(r);
    assert.ok(r.proof !== null);
    assert.deepEqual(r.proof.exit, { code: 0, signal: null }, 'the host ended on its own, not killed by the grace timer');
    assert.equal(r.cleanup, 'done');
  });
});

// ---------------------------------------------------------------- code review r1, end to end
// Code review r1 findings 4, 5, 7, 13 and 15, end to end: one seat launch per test in a real
// execution unit (transient systemd service, unit supervisor, seat host, Claude Code in its
// enclosure) against a real ledger service and a scripted model service.
//   4: the transcript and the tool log count against the card's export caps with the product;
//      cut at what is left, and the seat's records say so;
//   5: the writable area admission decided is the one the seat runs on (an image is an image);
//      a large-disk unit without fuse2fs does not run, as a resource block (WI-10);
//   7: no passing startup self-check for these versions: the seat is not started (WI-18);
//  13: async evidence saves the recovery state before it accepts; a state that outgrows the cap
//      after acceptance falls back to the saved one, never to nothing;
//  15: every exception goes to the ledger as an alert with its WI, the trigger facts and the
//      default action, and to the local alert file.

const EXTRACTED_FUSE2FS = process.env['MP_TEST_FUSE2FS']; // an unpacked fuse2fs for machines without one on PATH
const fuse2fs = findFuse2fs() ?? findFuse2fs(EXTRACTED_FUSE2FS);


const REVIEW_LIMITS = {
  run: { memoryMax: 256 << 20, pidsMax: 256, timeoutMs: 60_000 },
  areaBytes: 64 << 20,
  export: { maxLogicalBytes: 1 << 20, maxFiles: 200 },
  recoveryStateBytes: 32 << 20,
  maxTurns: 12,
  wallClockMs: 120_000,
};

function reviewConstructorCard(launch: LaunchId, mission: MissionId, snapshot: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'mp4.seat-card.v1',
    launch,
    mission,
    module: 'greeter',
    capabilities: [],
    duties: 'You build the greeter module.',
    decisionQuotes: [],
    constraints: [],
    workspace: { snapshot, writablePaths: ['src'] },
    limits: REVIEW_LIMITS,
    seat: 'constructor',
    goal: 'Write the greeting into src/out.txt.',
    standards: [{ id: 'S1', text: 'src/out.txt holds the greeting' }],
    requirementItems: [],
    readableFiles: ['src/a.txt'],
    interpreter: '',
    verificationCommands: [],
    interfaces: { implements: [], calls: [] },
    ...over,
  };
}

const done = (what: string) => ({ kind: 'tool' as const, name: 'mcp__program__submit_result', input: { done: what, unmet_standards: [], unfixed_problems: [], decisions_needed: [] } });

function oneSeatResult(r: UnitRun): SeatResultRecord {
  const all = recordsOf(r, 'seat.result') as SeatResultRecord[];
  assert.equal(all.length, 1, JSON.stringify(all));
  return all[0] as SeatResultRecord;
}

/** Alerts committed to the ledger for a launch: (category, wi, body). */
function ledgerAlerts(launch: LaunchId): { category: string; wi: string | undefined; body: { trigger: Record<string, unknown>; defaultAction: string } }[] {
  return readRecords(h.svc.paths.db, 0 as never)
    .map((c) => c.record)
    .filter((x): x is Extract<typeof x, { kind: 'alert' }> => x.kind === 'alert')
    .map((a) => ({ category: a.category, wi: a.wi, body: JSON.parse(h.content.get(a.body).toString('utf8')) as { launch: string; trigger: Record<string, unknown>; defaultAction: string } }))
    .filter((a) => (a.body as unknown as { launch: string }).launch === launch);
}

describe('code review r1: seat host end to end', { skip: UNIT_SKIP }, () => {
  test('finding 7: without a passing startup self-check for these versions the seat is not started (WI-18)', async () => {
    const empty = h.tmp('mp-seat-no-selfcheck-');
    for (const variant of ['no evidence', 'fixtures not accepted'] as const) {
      const r = await runSeatUnit({
        card: reviewConstructorCard,
        script: () => done('never'),
        ...(variant === 'no evidence' ? { selfCheckDir: empty } : { hostConfig: { selfCheck: { dir: h.selfCheckDir } } }),
      });
      assert.equal(r.outcome.status, 'environment-failure', variant);
      assert.match(r.outcome.reason ?? '', /startup self-check/);
      assert.equal(r.fake?.requests.length, 0, `${variant}: nothing reached the model service`);
      assert.equal(r.outcome.claudeExit, null, 'no Claude Code process was started');
      assert.equal(oneSeatResult(r).status, 'environment-failure');
      const local = readAlerts(r.state).filter((a) => a.kind === 'selfcheck-failed');
      assert.equal(local.length, 1);
      assert.equal(local[0]?.wi, 'WI-18');
      assert.doesNotMatch(readFileSync(join(r.state, 'host.err'), 'utf8'), /not delivered to the ledger/, `${variant}: the ledger has it`);
    }
    // one alert per failing version set: the PM is told once, not once per refused launch
    const inLedger = readRecords(h.svc.paths.db, 0 as never)
      .map((c) => c.record)
      .filter((x): x is Extract<typeof x, { kind: 'alert' }> => x.kind === 'alert' && x.category === 'selfcheck-failed');
    assert.equal(inLedger.length, 1);
    assert.equal(inLedger[0]?.wi, 'WI-18');
    const body = JSON.parse(h.content.get(inLedger[0]!.body).toString('utf8')) as { trigger: Record<string, unknown>; defaultAction: string };
    assert.ok(Array.isArray(body.trigger['missing']) && body.trigger['versions'] !== undefined, 'with the trigger facts');
    assert.match(body.defaultAction, /not started/);
  });

  test('finding 15: a spend refusal is an alert with WI-09 in the ledger', async () => {
    const r = await runSeatUnit({
      card: reviewConstructorCard,
      before: async (_l, mission) => {
        await h.client.call('setSpendLimit', { op: `limit:${mission}`, mission, micros: 1_000 });
      },
      script: () => done('never'),
    });
    assert.equal(r.outcome.endedBy, 'spend-limit');
    const a = ledgerAlerts(r.launch).find((x) => x.category === 'spend-refused');
    assert.ok(a !== undefined, JSON.stringify(ledgerAlerts(r.launch)));
    assert.equal(a.wi, 'WI-09');
    assert.ok(a.body.trigger['metering'] !== undefined);
  });

  test('finding 4: the transcript and the tool log share the export caps with the product; they are cut and say so', async () => {
    const cap = 6 * 1024;
    const r = await runSeatUnit({
      card: (l, m, s) => reviewConstructorCard(l, m, s, { limits: { ...REVIEW_LIMITS, export: { maxLogicalBytes: cap, maxFiles: 50 } } }),
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__write_file', input: { path: 'src/out.txt', content: 'hello\n' } };
        if (q.step === 1) return { kind: 'tool', name: 'mcp__program__run_command', input: { command: 'head -c 3000 /dev/zero | tr "\\0" x' } };
        if (q.step === 2) return done('wrote src/out.txt');
        return { kind: 'text', text: 'Done.' };
      },
    });
    const o = r.outcome;
    assert.equal(o.status, 'handed-back', `${o.reason}\n${h.diag(r.state, r.launch)}`);
    const sr = oneSeatResult(r);
    assert.ok(sr.export !== null && sr.transcript !== null, 'the product whole, the transcript present');
    assert.ok(o.exportUsed.bytes <= cap, `the launch stored ${o.exportUsed.bytes} bytes within its cap of ${cap}`);
    const transcript = readTree(h.content, sr.transcript as ContentHash);
    assert.ok(transcript.incomplete !== undefined, 'the transcript is marked incomplete');
    assert.match(o.transcriptIncomplete ?? '', /export allowance is used up/);
    const stored = transcript.entries.reduce((n, e) => n + (e.kind === 'file' ? e.size : 0), 0);
    const product = readTree(h.content, sr.export as ContentHash).entries.reduce((n, e) => n + (e.kind === 'file' ? e.size : 0), 0);
    const result = h.content.get(sr.result as ContentHash).length;
    assert.ok(stored + product + result <= cap, `${stored} + ${product} + ${result} <= ${cap}`);
    assert.ok(o.toolLogIncomplete !== null, 'the tool log says it is cut or missing');
  });

  test('finding 13: the state is saved before the request is accepted; growth after acceptance falls back to it', async () => {
    const big = 'y'.repeat(2 << 20);
    const round1 = await runSeatUnit({
      card: (l, m, s) => reviewConstructorCard(l, m, s, { allowAsyncEvidence: true, limits: { ...REVIEW_LIMITS, recoveryStateBytes: 1 << 20 } }),
      script: (q) =>
        q.step === 0
          ? { kind: 'tool', name: 'mcp__program__request_evidence', input: { steps: ['time it'], data: 'none', measure: ['ms'], assertions: ['fast'] } }
          : { kind: 'text', text: big },
      timeoutMs: 240_000,
    });
    const o1 = round1.outcome;
    assert.equal(o1.status, 'needs-evidence', `${o1.reason}\n${h.diag(round1.state, round1.launch)}`);
    assert.ok(o1.recoveryState !== null, 'never "the turn ended but the state could not be stored"');
    assert.match(o1.recoveryStateNote ?? '', /saved when the request was accepted/);
    assert.equal(oneSeatResult(round1).recoveryState, o1.recoveryState);
    const saved = readTree(h.content, o1.recoveryState as ContentHash);
    assert.equal(saved.incomplete, undefined, 'saved whole');
    const fb = ledgerAlerts(round1.launch).find((a) => a.category === 'recovery-state-fallback');
    assert.equal(fb?.wi, 'WI-17');

    // the next round resumes from the saved state
    let resumedBody = '';
    const round2 = await runSeatUnit({
      card: (l, m, s) => reviewConstructorCard(l, m, s, { allowAsyncEvidence: true, resume: { sessionId: o1.sessionId, state: o1.recoveryState, evidence: 'EVIDENCE-7: 12 ms' } }),
      script: (q) => {
        if (resumedBody === '') resumedBody = JSON.stringify(q.body);
        return q.userText.includes('EVIDENCE-7') && !q.userText.includes('Recorded as') ? done('measured') : { kind: 'text', text: 'Done.' };
      },
      timeoutMs: 240_000,
    });
    assert.equal(round2.outcome.status, 'handed-back', `${round2.outcome.reason}\n${h.diag(round2.state, round2.launch)}`);
    assert.equal(round2.outcome.resumeDegraded, null);
    // every tool_use the resumed conversation carries has its tool_result (what the real API requires)
    const msgs = (JSON.parse(resumedBody) as { messages: { role: string; content: unknown }[] }).messages;
    const uses = msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; id?: string }[]).filter((b) => b.type === 'tool_use').map((b) => b.id) : []));
    const results = new Set(msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; tool_use_id?: string }[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [])));
    assert.ok(uses.length > 0 && uses.every((u) => results.has(u)), `tool uses ${JSON.stringify(uses)} answered by ${JSON.stringify([...results])}`);
  });

  test('finding 5: a large-disk unit runs on its fixed-size image, not on a tmpfs; the image is torn down after', { skip: fuse2fs === null ? 'needs fuse2fs' : false }, async () => {
    const d = h.tmp('mp-seat-image-');
    const image = join(d, 'unit.img');
    const mountDir = join(d, 'mnt');
    mkdirSync(mountDir);
    await createDiskImage({ path: image, bytes: 32 << 20, inodes: 256 });
    const r = await runSeatUnit({
      card: reviewConstructorCard,
      area: { kind: 'image', image, mountDir },
      hostConfig: { install: { fuse2fs: fuse2fs as string } },
      cleanup: { fuseMounts: [mountDir], images: [image] },
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__run_command', input: { command: 'stat -f -c "AREA-FS=%T" src; echo hi > src/out.txt; cat src/out.txt' } };
        if (q.step === 1) return done('ran on the image');
        return { kind: 'text', text: 'Done.' };
      },
    });
    assert.equal(r.outcome.status, 'handed-back', `${r.outcome.reason}\n${h.diag(r.state, r.launch)}`);
    assert.equal(r.outcome.area, 'image');
    const main = (r.fake?.requests ?? []).filter((q) => q.main);
    assert.match(main[1]?.userText ?? '', /AREA-FS=fuse/, 'the writable paths live on the FUSE-mounted image');
    assert.doesNotMatch(main[1]?.userText ?? '', /AREA-FS=tmpfs/);
    assert.equal(r.cleanup, 'done');
    assert.equal(isMountPoint(mountDir), false);
    assert.equal(existsSync(image), false, 'unmounted, then the image deleted (dependency order)');
  });

  test('finding 5: without fuse2fs a large-disk unit does not run (resource block, WI-10), never on tmpfs', async () => {
    const d = h.tmp('mp-seat-image-');
    const image = join(d, 'unit.img');
    const mountDir = join(d, 'mnt');
    mkdirSync(mountDir);
    const r = await runSeatUnit({
      card: reviewConstructorCard,
      area: { kind: 'image', image, mountDir },
      hostConfig: { install: { fuse2fs: '/nonexistent/fuse2fs' } },
      script: () => done('never'),
    });
    // M2: a resource block, "resource exceeded" (not retried as an environment failure), and an acceptable report
    assert.equal(r.outcome.status, 'resource-exceeded');
    assert.deepEqual(r.outcome.notStarted, { cause: 'resource-blocked', wi: 'WI-10' });
    assert.match(r.outcome.reason ?? '', /resource-blocked/);
    assert.ok(r.proof !== null);
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true });
    assert.equal(r.fake?.requests.length, 0, 'the seat never started');
    const a = ledgerAlerts(r.launch).find((x) => x.category === 'area-unavailable');
    assert.equal(a?.wi, 'WI-10');
    assert.ok(readFileSync(join(r.state, 'alerts.jsonl'), 'utf8').includes('area-unavailable'), 'and the local copy');
  });

  test('fault: a command over its declared peak in a full seat is ended as a whole and reported "resource exceeded"; the attempt stays acceptable', async () => {
    const r = await runSeatUnit({
      card: (l, m, s) => reviewConstructorCard(l, m, s, { limits: { ...REVIEW_LIMITS, run: { memoryMax: 64 << 20, pidsMax: 64, timeoutMs: 60_000 } } }),
      script: (q) => {
        if (q.step === 0) return { kind: 'tool', name: 'mcp__program__run_command', input: { command: 'dd if=/dev/zero of=/dev/null bs=200M count=1; echo survived' } };
        if (q.step === 1) return done('noted the limit');
        return { kind: 'text', text: 'Done.' };
      },
    });
    assert.equal(r.outcome.status, 'handed-back', `${r.outcome.reason}\n${h.diag(r.state, r.launch)}`);
    const main = (r.fake?.requests ?? []).filter((q) => q.main);
    assert.match(main[1]?.userText ?? '', /resource exceeded/);
    assert.doesNotMatch(main[1]?.userText ?? '', /survived/, 'the shell was ended with the whole run layer');
    const layers = recordsOf(r, 'run.layer') as RunLayerRecord[];
    assert.equal(layers[0]?.status, 'resource-exceeded');
    assert.ok((layers[0]?.oomKillDelta ?? 0) >= 1);
    assert.ok(r.proof !== null);
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true }, 'every kill is accounted for');
  });

  test('fault: the whole seat unit over its memory: everything in it ends, the proof says so, the attempt is "resource exceeded"', async () => {
    const r = await runSeatUnit({
      card: (l, m, s) => reviewConstructorCard(l, m, s, { limits: { ...REVIEW_LIMITS, run: { memoryMax: 4 * 1024 ** 3, pidsMax: 64, timeoutMs: 60_000 } } }),
      unitMemoryMax: 900 << 20,
      allowNoOutcome: true,
      script: (q) => (q.step === 0 ? { kind: 'tool', name: 'mcp__program__run_command', input: { command: 'dd if=/dev/zero of=/dev/null bs=1500M count=1' } } : done('unreachable')),
    });
    assert.ok(r.proof !== null, h.diag(r.state, r.launch));
    assert.ok(r.proof.unitOom >= 1, `unit oom ${r.proof.unitOom}; outcome ${JSON.stringify(r.outcome)}\n${JSON.stringify(r.fake?.requests.map((q) => q.userText.slice(-600)))}\n${h.diag(r.state, r.launch)}`);
    const verdict = checkTerminationProof(r.proof, { seatUnit: true, records: r.pending });
    assert.equal(verdict.eligible, false);
    assert.ok(!verdict.eligible && verdict.outcome === 'resource-exceeded', JSON.stringify(verdict));
    assert.equal(r.cleanup, 'done', 'and the unit is cleaned up');
  });

  for (const [what, enclosure] of [
    ['config', { configBytes: 32 * 1024, tmpBytes: 64 << 20, shmBytes: 1 << 20 }],
    ['tmp', { configBytes: 64 << 20, tmpBytes: 16 * 1024, shmBytes: 16 * 1024 }],
  ] as const) {
    test(`fault: the Claude Code ${what} area full in a full seat: the host still reports, nothing escapes the areas`, async () => {
      const r = await runSeatUnit({
        card: reviewConstructorCard,
        hostConfig: { enclosure },
        script: (q) => (q.step === 0 ? done('done despite a full area') : { kind: 'text', text: 'Done.' }),
      });
      const o = r.outcome;
      assert.ok(['handed-back', 'environment-failure', 'seat-failure'].includes(o.status), `${o.status}: ${o.reason}`);
      oneSeatResult(r);
      assert.ok(r.proof !== null);
      assert.equal(r.cleanup, 'done');
      for (const p of o.claudeWrites) assert.match(p, /^(config|tmp|shm)\//, 'only the capped areas were written');
    });
  }

  test('r2 finding 3: refused evidence requests save nothing; the round never writes more state copies than reserved', async () => {
    const r = await runSeatUnit({
      card: (l, m, sn) => reviewConstructorCard(l, m, sn, { allowAsyncEvidence: true, limits: { ...REVIEW_LIMITS, export: { maxLogicalBytes: 1_500, maxFiles: 50 } } }),
      script: (q) => {
        if (q.step <= 2) return { kind: 'tool', name: 'mcp__program__request_evidence', input: { steps: ['measure'], data: 'x'.repeat(4_000), measure: [], assertions: [] } };
        if (q.step === 3) return done('handed back instead');
        return { kind: 'text', text: 'Done.' };
      },
    });
    assert.equal(r.outcome.status, 'handed-back', `${r.outcome.reason}\n${h.diag(r.state, r.launch)}`);
    assert.equal(r.outcome.evidenceRefusals.length, 3);
    assert.ok(r.outcome.evidenceRefusals.every((x) => /does not fit/.test(x)));
    assert.equal(r.outcome.recoveryStateSaves, 0, 'the request was refused before any state was saved');
    assert.equal(ledgerAlerts(r.launch).find((a) => a.category === 'async-evidence-refused')?.wi, 'WI-17', 'the PM is told from the second refusal');
  });

  test("r2 finding 6: a recovery state over the new card's cap is never restored: a new session from the ledger (WI-17)", async () => {
    const round1 = await runSeatUnit({
      card: (l, m, sn) => reviewConstructorCard(l, m, sn, { allowAsyncEvidence: true }),
      script: (q) => (q.step === 0 ? { kind: 'tool', name: 'mcp__program__request_evidence', input: { steps: ['x'], data: 'none', measure: [], assertions: [] } } : { kind: 'text', text: 'Waiting.' }),
    });
    assert.equal(round1.outcome.status, 'needs-evidence', round1.outcome.reason ?? '');
    const round2 = await runSeatUnit({
      card: (l, m, sn) =>
        reviewConstructorCard(l, m, sn, {
          allowAsyncEvidence: true,
          limits: { ...REVIEW_LIMITS, recoveryStateBytes: 1_024 },
          resume: { sessionId: round1.outcome.sessionId, state: round1.outcome.recoveryState, evidence: 'EVIDENCE-R2-6' },
        }),
      script: (q) => (q.step === 0 ? done('started afresh') : { kind: 'text', text: 'Done.' }),
    });
    assert.equal(round2.outcome.status, 'handed-back', `${round2.outcome.reason}\n${h.diag(round2.state, round2.launch)}`);
    assert.match(round2.outcome.resumeDegraded ?? '', /over this card's recovery cap .*cap of 1024 bytes/);
    const first = round2.fake?.requests.find((q) => q.main);
    assert.ok(first !== undefined && first.step === 0 && first.userText.includes('could not be resumed') && first.userText.includes('EVIDENCE-R2-6'));
    assert.equal(ledgerAlerts(round2.launch).find((a) => a.category === 'recovery-state-degraded')?.wi, 'WI-17');
  });
});
