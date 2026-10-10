// The PM's CLI (design 9.2) against a real ledger service process in temp dirs:
// layer 0 with the ledger up and down and with the evaluator blocked (10.2, 6.1,
// WI-11); stops through the one entry with the exact message and exit code, their
// four states, narrowing and release (6.1, 6.4); operation ids that make retries
// idempotent (3.11 principle 3); the WI-12 resume; notices with their WI options
// (3.9); delivery and landing through the adapter (6.6, WI-01, WI-06).

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useDeliveryAdapter, realDeliveryAdapter, type DeliveryAdapter } from '../src/cli/adapters/delivery.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { SUMMARY_FORMAT, summaryPath } from '../src/evaluator/checkpoint.ts';
import { canonicalJson } from '../src/common/hash.ts';
import { DEFAULT_MODEL_CONFIG } from '../src/seat/modelConfig.ts';
import { cleanupEnvs, LedgerProc, startWatched, waitFor } from './scheduler-fixtures.ts';
import { CLI_MAIN, cliEnv, ioOf, ledgerCall, mp, mpJson, runProcess, type CliEnv } from './cli-fixtures.ts';

const procs: LedgerProc[] = [];
async function ledgerUp(env: CliEnv, o: ConstructorParameters<typeof LedgerProc>[1] = {}): Promise<LedgerProc> {
  const lp = new LedgerProc(env, o);
  await lp.start();
  procs.push(lp);
  return lp;
}

// Each ledger's content store is many directories: remove every env right after its test (/tmp is shared).
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill();
  await cleanupEnvs();
});

async function stopActive(env: CliEnv, stop: string): Promise<boolean> {
  return (await ledgerCall(env, 'stopState', { stop })) === 'active';
}

describe('layer 0 (10.2)', { timeout: 120_000 }, () => {
  test('status with the ledger up: stops, recovery, evaluator, notices; text and JSON', async () => {
    const env = cliEnv('status-up');
    await ledgerUp(env);
    const t = await mp(env, 'status');
    assert.equal(t.exitCode, 0, t.stderr);
    assert.match(t.stdout, /ledger service available/);
    assert.match(t.stdout, /Stops: none/);
    const j = await mpJson(env, 'status');
    const r = j.out['result'] as { format: string; ledger: { reachable: boolean; head: number }; recovery: { paused: boolean } };
    assert.equal(r.format, 'mp4.layer0.v1');
    assert.equal(r.ledger.reachable, true);
    assert.equal(r.recovery.paused, false);
  });

  test('status while the ledger is down still answers: the heartbeat head, stops by their actual confirmations', async () => {
    const env = cliEnv('status-down');
    const lp = await ledgerUp(env);
    await lp.kill();
    // a stop sent now goes through the inboxes and the control plane only (6.1)
    const s = await mpJson(env, 'stop', '停', '--op', 'stop-while-down');
    assert.equal(s.exitCode, 0);
    assert.equal((s.out['result'] as { result: string }).result, 'persisted');
    const j = await mpJson(env, 'status');
    assert.equal(j.exitCode, 0);
    const r = j.out['result'] as { ledger: { reachable: boolean; error: string }; stops: Array<{ stop: string; state: string }> };
    assert.equal(r.ledger.reachable, false);
    assert.ok(r.stops.some((x) => x.state === 'persisted, awaiting commit'), JSON.stringify(r.stops));
    const t = await mp(env, 'status');
    assert.match(t.stdout, /ledger service unavailable/);
    assert.match(t.stdout, /persisted, awaiting commit/);
    assert.match(t.stdout, /stops still take effect through the inboxes and the fast notice/);
  });

  test('evaluator blocked and in fault: level 0 shows it, with the last checkpoint and its lag (6.1, WI-11, WI-18)', async () => {
    const env = cliEnv('status-eval');
    await ledgerUp(env);
    const cp = new ControlPlane(env.cp);
    cp.putStatus({
      format: 'mp4.scheduler-status.v1',
      gen: 1 as never,
      recoveryPause: false,
      storageFault: false,
      stale: false,
      dispatchPaused: null,
      waiting: [{ mission: 'm1' as never, task: 't1', reason: 'waiting for resources' }],
      blocked: [{ mission: 'm1' as never, reason: 'resource block (WI-10)' }],
      evaluator: { fault: 'the evaluator is blocked: its memory pool cannot be enforced (WI-18)', degraded: null, blocked: { memoryMb: 2048 }, checkpointPaused: null, published: 3, lastCheckpoint: null },
      at: Date.now(),
    });
    const summary = {
      format: SUMMARY_FORMAT,
      revision: 2,
      head: 2,
      writtenAt: new Date().toISOString(),
      rules: 'x',
      checkpoint: null,
      targets: { total: 0, labels: { negated: 0, 'basis-withdrawn': 0, unaccepted: 0, 'not-fully-proven': 0, proven: 0 }, byLabel: { negated: [], 'basis-withdrawn': [], unaccepted: [], 'not-fully-proven': [], proven: [] } },
      ops: { total: 0, allProven: 0, notAllProven: 0, executed: 0, executedNotAllProven: 0, byOp: {} },
      judgments: { total: 0, current: 0, notCurrent: 0 },
      fixes: { fixed: 0, 'fixed-not-fully-proven': 0, unfixed: 0 },
      proofDebt: 1,
      cycles: 0,
    };
    writeFileSync(summaryPath(env.evaluatorCheckpoint), JSON.stringify(summary));
    // a few commits so the ledger head is ahead of the checkpoint
    for (let i = 0; i < 3; i++) await ledgerCall(env, 'setMission', { mission: `m${i}`, state: 'open' });
    const j = await mpJson(env, 'status');
    const ev = (j.out['result'] as { evaluator: { source: string; revision: number; lag: number; fault: string; blocked: unknown; proofDebt: number } }).evaluator;
    assert.equal(ev.source, 'checkpoint');
    assert.equal(ev.revision, 2);
    assert.ok(ev.lag >= 1, `lag ${ev.lag}`);
    assert.match(ev.fault, /memory pool/);
    assert.deepEqual(ev.blocked, { memoryMb: 2048 });
    assert.equal(ev.proofDebt, 1);
    const t = await mp(env, 'status');
    assert.match(t.stdout, /Evaluator: fault \(WI-11\)/);
    assert.match(t.stdout, /\d+ commits behind the ledger/);
    assert.match(t.stdout, /Persistently blocked \(1\)/);
  });
});

describe('stops (6.1, 6.4)', { timeout: 120_000 }, () => {
  test('mp stop prints the entry\'s exact message and exits with its code; the ledger commits it', async () => {
    const env = cliEnv('stop');
    await ledgerUp(env);
    const r = await runProcess(CLI_MAIN, ['stop', '停 mission-x'], { cwd: env.project, env: ioOf(env).env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Operation id: stop-/);
    assert.match(r.stdout, /\nFast notice sent; persisted \(awaiting commit\)\.\n/);
    const j = JSON.parse((await runProcess(CLI_MAIN, ['stop', 'halt', '--json', '--scope', 'mission:m1'], { cwd: env.project, env: ioOf(env).env })).stdout) as { op: string; result: { stop: string; scope: unknown; exitCode: number } };
    assert.deepEqual(j.result.scope, { kind: 'mission', mission: 'm1' });
    assert.equal(j.result.exitCode, 0);
    await waitFor(() => stopActive(env, j.result.stop), 10_000, 'committed');
    const show = await mp(env, 'show', 'stop', j.result.stop);
    assert.match(show.stdout, /: committed/);
    assert.match(show.stdout, /Scope: mission m1/);
  });

  test('no inbox writable: exit 76 (neither persisted nor notified)', async () => {
    const env = cliEnv('stop-fail');
    // no ledger was ever opened: no inbox is installed, and the control plane cannot be created
    writeFileSync(join(env.root, 'cp-file'), '');
    const { writeConfig } = await import('./cli-fixtures.ts');
    writeConfig({ ...env, cp: join(env.root, 'cp-file', 'sub') });
    const r = await mpJson(env, 'stop', 'stop');
    assert.equal(r.exitCode, 76);
    assert.equal((r.out['result'] as { result: string }).result, 'failed');
  });

  test('an operation id makes a retry idempotent; the same id with other arguments is refused', async () => {
    const env = cliEnv('stop-op');
    await ledgerUp(env);
    const a = await mpJson(env, 'stop', '停', '--op', 'pm-op-1');
    const b = await mpJson(env, 'stop', '停', '--op', 'pm-op-1');
    assert.equal(a.out['op'], 'pm-op-1');
    assert.equal(b.out['replayed'], true);
    assert.equal((a.out['result'] as { stop: string }).stop, (b.out['result'] as { stop: string }).stop);
    const c = await mpJson(env, 'stop', '别的话', '--op', 'pm-op-1');
    assert.equal(c.exitCode, 65);
    assert.equal((c.out['error'] as { code: string }).code, 'OP_CONFLICT');
    const bad = await mp(env, 'stop', '停', '--op', 'bad op id');
    assert.equal(bad.exitCode, 64);
    const ops = await mpJson(env, 'ops');
    const listed = ops.out['result'] as { source: string; ops: Array<{ op: string; command: string; state: string }> };
    assert.equal(listed.source, 'ledger', 'the PM action is recorded in the ledger (recordPmAction)');
    assert.ok(listed.ops.some((o) => o.op === 'pm-op-1' && o.command === 'stop' && o.state === 'done'), JSON.stringify(listed.ops));
    assert.equal(((await ledgerCall(env, 'pmAction', { action: 'pm-op-1' })) as { state: string }).state, 'done');
  });

  test('narrowing commits the narrower stop and releases the old one in one ledger step (narrowStop); release; refusals', async () => {
    const env = cliEnv('narrow');
    await ledgerUp(env);
    const s = await mpJson(env, 'stop', '停', '--scope', 'all', '--op', 'n-1');
    const old = (s.out['result'] as { stop: string }).stop;
    await waitFor(() => stopActive(env, old), 10_000, 'committed');
    const wider = await mpJson(env, 'stop-narrow', old, '--scope', 'all');
    assert.equal(wider.exitCode, 3, 'the same scope is not narrower');
    const n = await mpJson(env, 'stop-narrow', old, '--scope', 'mission:m1', '--op', 'n-2');
    assert.equal(n.exitCode, 0, JSON.stringify(n.out));
    const nr = n.out['result'] as { stop: string; narrowed: boolean };
    assert.equal(nr.narrowed, true);
    assert.equal(await ledgerCall(env, 'stopState', { stop: old }), 'released');
    assert.equal(await stopActive(env, nr.stop), true);
    const again = await mpJson(env, 'stop-narrow', nr.stop, '--scope', 'mission:m2');
    assert.equal(again.exitCode, 3, 'mission m2 is not inside mission m1');
    const rel = await mp(env, 'stop-release', nr.stop);
    assert.equal(rel.exitCode, 0);
    assert.match(rel.stdout, /released/);
    const rel2 = await mp(env, 'stop-release', nr.stop, '--op', 'rel-2');
    assert.match(rel2.stdout, /was already released/);
    const none = await mp(env, 'stop-release', 'stop-never');
    assert.equal(none.exitCode, 3);
  });
});

describe('recovery pause after a reboot (6.1, WI-12)', { timeout: 120_000 }, () => {
  test('resume only after the user answered; an answer that sounds like a stop needs --stop-words or --no-stop; a named stop is committed first', async () => {
    const env = cliEnv('resume');
    const bootFile = join(env.root, 'boot-id');
    writeFileSync(bootFile, 'boot-A\n');
    const a = await ledgerUp(env, { bootIdFile: bootFile });
    await ledgerCall(env, 'setMission', { mission: 'm1', state: 'open' });
    await a.kill(); // the machine stops abnormally: the memory filesystem is gone
    rmSync(env.cp, { recursive: true, force: true });
    writeFileSync(bootFile, 'boot-B\n');
    const b = await ledgerUp(env, { bootIdFile: bootFile });
    assert.equal(b.ready?.recoveryPause, true);
    const st = await mpJson(env, 'status');
    assert.equal((st.out['result'] as { recovery: { paused: boolean } }).recovery.paused, true);
    assert.match((await mp(env, 'status')).stdout, /Recovery pause \(WI-12\)/);
    const check = await mp(env, 'recovery-check');
    assert.equal(check.exitCode, 0, check.stderr);
    assert.match(check.stdout, /Ask the user: The machine restarted around/);
    assert.equal((await mp(env, 'resume')).exitCode, 64, 'the PM never answers for the user');
    const unclear = await mpJson(env, 'resume', '--answer', '有，我当时说过停');
    assert.equal(unclear.exitCode, 3);
    assert.equal((unclear.out['error'] as { code: string }).code, 'ANSWER_UNCLEAR');
    const ok = await mpJson(env, 'resume', '--answer', '有，我当时说过停', '--stop-words', '停 m1', '--op', 'resume-1');
    assert.equal(ok.exitCode, 0, JSON.stringify(ok.out));
    const res = ok.out['result'] as { resumed: boolean; via: string; submittedStop: { stop: string } };
    assert.equal(res.resumed, true);
    assert.equal(res.via, 'ledger', 'no scheduler configured: the ledger, which the scheduler reads');
    assert.equal(await stopActive(env, res.submittedStop.stop), true, 'the named stop is committed before resuming');
    const after = await mpJson(env, 'status');
    assert.equal((after.out['result'] as { recovery: { paused: boolean } }).recovery.paused, false);
    const again = await mp(env, 'resume', '--answer', '没有');
    assert.match(again.stdout, /There is no recovery pause now/);
  });
});

describe('notices for the PM (3.9, 3.11)', { timeout: 60_000 }, () => {
  test('alerts lists WI number, trigger, default action and the WI options; delivered when shown; ack confirms', async () => {
    const env = cliEnv('alerts');
    await ledgerUp(env);
    new ControlPlane(env.cp).putAlert({
      format: 'mp4.alert-copy.v1',
      alert: 'scheduler.evaluator-fault.abc',
      category: 'evaluator-fault',
      wi: 'WI-11',
      key: 'k',
      trigger: 'the derived state cannot be computed: 3 failures and a rebuild',
      defaultAction: 'no more restarts; reads return the last checkpoint summary',
      detail: { failures: 3 },
      source: 'scheduler',
      at: Date.now(),
      committed: false,
    });
    const l0 = await mpJson(env, 'status');
    assert.equal((l0.out['result'] as { notices: { undelivered: number } }).notices.undelivered, 1);
    const a = await mp(env, 'alerts');
    assert.match(a.stdout, /WI-11 The evaluator is in its fault state, or its resource pool is too small \(evaluator-fault, /);
    assert.match(a.stdout, /Trigger: the derived state cannot be computed/);
    assert.match(a.stdout, /Default action already taken: no more restarts/);
    assert.match(a.stdout, /Handle per WI-11: open the WI page \/.*\/plugin\/pm\/wi\/WI-11\.md/);
    assert.doesNotMatch(a.stdout, /mp retry-evaluator/, 'the options live only in the page');
    const aj = await mpJson(env, 'alerts', '--all');
    const page = ((aj.out['result'] as { notices: Array<{ page: string }> }).notices[0]!).page;
    assert.match(readFileSync(page, 'utf8'), /`mp retry-evaluator`/);
    const l1 = await mpJson(env, 'status');
    assert.deepEqual((l1.out['result'] as { notices: { undelivered: number; unconfirmed: number } }).notices, { undelivered: 0, unconfirmed: 1, byWi: { 'WI-11': 1 } });
    const s = await mp(env, 'show', 'alert', 'scheduler.evaluator-fault.abc');
    assert.match(s.stdout, /Facts: \{"failures":3\}/);
    await mp(env, 'alerts', '--ack', 'scheduler.evaluator-fault.abc');
    assert.match((await mp(env, 'alerts')).stdout, /No notices to handle/);
    const marks = (await ledgerCall(env, 'noticeDeliveries', { notices: ['scheduler.evaluator-fault.abc'] })) as Array<{ state: string }>;
    assert.equal(marks[0]?.state, 'acknowledged', 'the ledger records the delivery state (markNotice)');
  });
});

describe('delivery and landing through the adapter (6.6)', { timeout: 120_000 }, () => {
  async function recordDelivery(env: CliEnv, op: string): Promise<void> {
    const content = new ContentStore(ledgerPaths(env.ledgerRoot, env.cp).content);
    const manifest = content.put(canonicalJson({ manifest: { entries: [] } }));
    await ledgerCall(env, 'recordDelivery', { op: `rec-${op}`, mission: 'm1', delivery: op, commit: 'a'.repeat(40), base: 'b'.repeat(40), ref: `refs/mission-pipeline/delivered/m1/${op}`, manifest });
  }

  function fake(over: Partial<DeliveryAdapter>): () => void {
    return useDeliveryAdapter({ ...realDeliveryAdapter, landingState: async () => ({ landed: null, attempts: null, refOnly: false, summary: 'whether it landed is unknown' }), ...over });
  }

  test('land --deliver-ref-only records the choice and gives the merge commands; land reports a WI-01 refusal with the options', async () => {
    const env = cliEnv('land');
    await ledgerUp(env);
    await recordDelivery(env, 'op-d1');
    const ref = await mp(env, 'land', 'op-d1', '--deliver-ref-only');
    assert.equal(ref.exitCode, 0, ref.stderr);
    assert.match(ref.stdout, /delivered as a ref only/);
    assert.match(ref.stdout, /merge --ff-only refs\/mission-pipeline\/delivered\/m1\/op-d1/);
    const restore = fake({
      land: async () => ({ kind: 'not-auto-landed', reason: 'occupancy-many', wi: 'WI-01', detail: 'main is checked out in 2 worktrees', paths: [], manualCommands: [] }) as never,
    });
    try {
      const r = await mpJson(env, 'land', 'op-d1');
      assert.equal(r.exitCode, 3);
      const t = await mp(env, 'land', 'op-d1');
      assert.match(t.stdout, /Not landed automatically this time; nothing was written/);
      assert.match(t.stdout, /Handle per WI-01 The target branch's occupancy does not allow an automatic landing .*: open the WI page .*WI-01\.md/);
    } finally {
      restore();
    }
    const missing = await mp(env, 'land', 'op-none');
    assert.equal(missing.exitCode, 3);
    const w = await mp(env, 'withdraw-delivery', 'op-d1', '--reason', 'user: do not deliver this');
    assert.equal(w.exitCode, 0, w.stderr);
    assert.match(w.stdout, /withdrawn: it is never landed or delivered again/);
    assert.match((await mp(env, 'withdraw-delivery', 'op-d1', '--reason', 'again', '--op', 'wd-2')).stdout, /was already withdrawn/);
  });

  test('deliver creates the ref and lands at once (the user\'s "交付" is consent to land)', async () => {
    const env = cliEnv('deliver');
    await ledgerUp(env);
    const calls: string[] = [];
    const restore = fake({
      deliver: async (_ctx, i) => {
        calls.push(`deliver:${i.mission}:${i.outputs.join(',')}`);
        return { kind: 'delivered', record: { key: { mission: i.mission, op: i.op }, manifest: {} as never, base: 'b'.repeat(40), commit: 'c'.repeat(40), ref: `refs/mission-pipeline/delivered/${i.mission}/${i.op}`, proof: {} as never, checks: [], rebuilds: 0, landed: false } } as never;
      },
      land: async (_ctx, i) => {
        calls.push(`land:${i.delivery.delivery}`);
        return { kind: 'checked', outcome: 'landed', verification: { worktrees: [], newWorktrees: [] }, reminders: [], locks: [], why: '' } as never;
      },
    });
    try {
      const r = await mp(env, 'deliver', 'm1', '--outputs', 'obj-1,unit:u1', '--op', 'dl-1');
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /Delivery ref created/);
      assert.match(r.stdout, /Landed: the target branch contains the delivery commit/);
      assert.deepEqual(calls, ['deliver:m1:obj-1,unit:u1', 'land:dl-1']);
      assert.equal((await mp(env, 'deliver', 'm1')).exitCode, 64, '--outputs is required');
    } finally {
      restore();
    }
  });

  test('mission open, close (closeMission: a closing snapshot), and the missions list', async () => {
    const env = cliEnv('close');
    await ledgerUp(env);
    assert.equal((await mp(env, 'mission', 'open', 'm1')).exitCode, 0);
    assert.match((await mp(env, 'mission', 'list')).stdout, /m1: open/);
    const r = await mpJson(env, 'close', 'm1', '--mode', 'with-risk', '--op', 'close-1');
    assert.equal(r.exitCode, 0, JSON.stringify(r.out));
    assert.equal((r.out['result'] as { version: number }).version, 1);
    assert.match((await mp(env, 'mission', 'list', '--state', 'closed')).stdout, /m1: closed \(closing snapshots: 1\)/);
    assert.equal((await mp(env, 'close', 'm1', '--mode', 'everything')).exitCode, 64);
  });

  test('mission ids (review r1 #17): a dotted id is refused at mission open with the rule; normal ids work', async () => {
    const env = cliEnv('mid');
    await ledgerUp(env);
    // the reviewer's repro: "a.b" + "c" and "a" + "b.c" derived the same global ids
    const bad = await mp(env, 'mission', 'open', 'a.b');
    assert.equal(bad.exitCode, 64, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /mission id "a\.b" is not allowed: use 1 to 64 letters, digits or "-"/);
    assert.equal((await mp(env, 'requirement', 'add', 'a.b', 'R1', '--text', 'x')).exitCode, 64, 'every command that takes a mission');
    assert.doesNotMatch((await mp(env, 'mission', 'list')).stdout, /a\.b/);
    assert.equal((await mp(env, 'mission', 'open', 'a')).exitCode, 0);
    assert.equal((await mp(env, 'mission', 'open', 'Mission-2')).exitCode, 0);
    assert.match((await mp(env, 'mission', 'list')).stdout, /Mission-2: open/);
  });
});

describe('model-config (WI-09)', { timeout: 120_000 }, () => {
  test('set all puts every seat on one model; aliases and dated ids are taken; an unknown seat or a non-Claude model is refused', async () => {
    const env = cliEnv('models');
    await ledgerUp(env);
    type Seats = Record<string, { provider: string; model: string; effort?: string; maxOutputTokens?: number }>;
    const seats = (): Seats => (JSON.parse(readFileSync(env.modelConfig, 'utf8')) as { seats: Seats }).seats;
    // a file with one seat of its own and one seat outside the defaults
    writeFileSync(env.modelConfig, JSON.stringify({ format: 'mp4.model-config.v1', seats: { reviewer: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'max' }, legacy: { provider: 'anthropic', model: 'claude-opus-5' } } }));
    const all = await mpJson(env, 'model-config', 'set', 'all', '--model', 'sonnet');
    assert.equal(all.exitCode, 0, JSON.stringify(all.out));
    assert.deepEqual(Object.keys(seats()).sort(), [...Object.keys(DEFAULT_MODEL_CONFIG.seats), 'legacy'].sort(), 'every default seat, plus the one the file named');
    for (const m of Object.values(seats())) assert.equal(m.model, 'sonnet');
    assert.equal(seats()['reviewer']?.effort, 'max', 'a seat keeps what was not changed');
    assert.equal(seats()['architect']?.effort, 'high', 'a seat the file did not name starts from the default');
    const eff = await mp(env, 'model-config', 'set', 'all', '--effort', 'low', '--max-output-tokens', '16000');
    assert.equal(eff.exitCode, 0, eff.stderr);
    assert.match(eff.stdout, /^Changed every seat \(calibrator, architect, .*legacy\): sonnet, effort low\. Seats started from now on use it\.$/m);
    for (const m of Object.values(seats())) assert.deepEqual([m.model, m.effort, m.maxOutputTokens], ['sonnet', 'low', 16_000]);
    // one seat, with a dated id
    assert.equal((await mp(env, 'model-config', 'set', 'architect', '--model', 'claude-haiku-4-5-20251001')).exitCode, 0);
    assert.equal(seats()['architect']?.model, 'claude-haiku-4-5-20251001');
    assert.equal(seats()['constructor']?.model, 'sonnet');
    // refused, the file unchanged: an unknown seat, a non-Claude model
    const before = readFileSync(env.modelConfig, 'utf8');
    const typo = await mp(env, 'model-config', 'set', 'architekt', '--model', 'opus');
    assert.equal(typo.exitCode, 64, typo.stdout + typo.stderr);
    assert.match(typo.stdout + typo.stderr, /unknown seat "architekt": the seats are calibrator, architect, secretary, constructor, reviewer, researcher, crititor, auditor \(or all\)/);
    const gpt = await mp(env, 'model-config', 'set', 'all', '--model', 'gpt-5');
    assert.equal(gpt.exitCode, 3, gpt.stdout + gpt.stderr);
    assert.match(gpt.stdout + gpt.stderr, /not changed: .*has no price: a seat model is any Claude model id/);
    assert.equal(readFileSync(env.modelConfig, 'utf8'), before);
    const shown = await mp(env, 'model-config', 'show');
    assert.match(shown.stdout, /^calibrator: sonnet, effort low, max output 16000$/m);
  });
});

describe('WI actions through the scheduler (WI-08, WI-09, WI-11, WI-12)', { timeout: 180_000 }, () => {
  test('recovery-check, retry-evaluator, grant, spend-limit and model-config', async () => {
    const env = cliEnv('sched', { scheduler: true });
    const sys = await startWatched(env);
    try {
      const rc = await mpJson(env, 'recovery-check');
      assert.equal(rc.exitCode, 0, JSON.stringify(rc.out));
      assert.equal((rc.out['result'] as { via: string; format: string }).via, 'scheduler');
      const re = await mp(env, 'retry-evaluator');
      assert.equal(re.exitCode, 0, re.stderr);
      const g = await mpJson(env, 'grant', 'lineage-x', 'rework', '--extra', '1', '--reason', 'user: one more try');
      assert.equal(g.exitCode, 3, 'not exhausted: nothing to grant');
      const badLoop = await mp(env, 'grant', 'lineage-x', 'nope', '--extra', '1', '--reason', 'x');
      assert.equal(badLoop.exitCode, 64);
      const un = await mpJson(env, 'spend-limit', 'm1', 'unlimited');
      assert.equal(un.exitCode, 0, JSON.stringify(un.out));
      assert.equal(((await ledgerCall(env, 'spendSummary', { mission: 'm1' })) as { limit: number | null }).limit, null);
      const money = await mpJson(env, 'spend-limit', 'm1', '$12.50');
      assert.ok([70, 3].includes(money.exitCode), JSON.stringify(money.out));
      const mc = await mp(env, 'model-config', 'set', 'reviewer', '--effort', 'xhigh');
      assert.equal(mc.exitCode, 0, mc.stderr);
      assert.match(readFileSync(env.modelConfig, 'utf8'), /"effort": "xhigh"/);
      const bad = await mp(env, 'model-config', 'set', 'reviewer', '--model', 'no-such-model');
      assert.equal(bad.exitCode, 3, 'an unpriced model is refused, the file unchanged');
      assert.ok(existsSync(env.modelConfig));
      const unknownTask = await mp(env, 'show', 'task', 'no-such-task');
      assert.equal(unknownTask.exitCode, 3);
    } finally {
      await sys.close();
    }
  });
});
