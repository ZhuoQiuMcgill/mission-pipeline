// The run lock of declared runs (design 4.1 §4.1 "Process locks", §5.3, §6.5): a declared run is
// recorded only after its commands have run, so while it executes its reuse key finds nothing.
// Without a lock, every other `mp` process that advances the flow meanwhile (a seat's hand-back, a
// PM write command, `mp pm next`) started another execution of the same run on the same candidate
// and waited for it. These tests hold a run open from another process with a command that waits for
// a gate file, and count the executions in a file outside the checkout:
//   - two processes verify the same candidate at once: one executes, the others are "pending" with
//     nothing run or recorded; afterwards the recorded run is reused; exactly one execution;
//   - a sampling run (a rerun) of the same command still executes while the declared run holds it;
//   - a holder that is killed releases the lock: the next call executes, in a checkout of its own;
//   - the flow: while a Constructor's hand-back verifies its candidate, the PM's `mp pm next` comes
//     back at once with the task waiting, no failure and no second execution; the result arrives;
//   - a hand-back whose verification is pending elsewhere is recorded once and runs nothing.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { gitActions, pmDispatch, pmNext, readSteps, runOnCommit, type ProcessContext } from '../src/process/index.ts';
import { appendRecords } from '../src/memory/index.ts';
import { ENV_LINE } from '../src/evaluator/index.ts';
import { RUN_FIELD } from '../src/evaluator/runs.ts';
import { RunInProgress } from '../src/process/runs.ts';
import { dispatchView } from '../src/process/seat.ts';
import { addDetailedPlan, CHECK_JS, ENV_A, handBack, processProject, readAll, readyOf, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const CHILD = fileURLToPath(new URL('./process-run-lock-child.ts', import.meta.url));

let p: ProcessProject | null = null;
const children: ChildProcess[] = [];
let gateFile: string | null = null;

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  // a killed holder leaves its command running: the open gate ends it
  if (gateFile !== null && existsSync(dirname(gateFile))) writeFileSync(gateFile, '');
  gateFile = null;
  const q = p;
  p = null;
  q?.cleanup();
});

/**
 * A command that counts its executions (one line per execution in `counter`) and, on the first
 * execution only, waits until the `gate` file exists (at most two minutes, and only while the
 * counter is there): it holds a run open.
 */
function gatedCommand(q: ProcessProject): { readonly command: string; readonly counter: string; readonly gate: string } {
  const base = dirname(q.dir);
  const script = join(base, 'gated.js');
  const counter = join(base, 'executions.txt');
  const gate = join(base, 'gate');
  writeFileSync(
    script,
    `const fs = require('node:fs');
const [counter, gate] = process.argv.slice(2);
fs.appendFileSync(counter, process.pid + '\\n');
const first = fs.readFileSync(counter, 'utf8').trim().split('\\n').length === 1;
const until = Date.now() + 120000;
while (first && !fs.existsSync(gate) && fs.existsSync(counter) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
console.log('ok 1 - gated');
`,
  );
  gateFile = gate;
  return { command: `node ${JSON.stringify(script)} ${JSON.stringify(counter)} ${JSON.stringify(gate)}`, counter, gate };
}

function executions(counter: string): number {
  return existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter((x) => x !== '').length : 0;
}

/** The evidence records of `command` in the memory. */
function evidenceOf(ctx: ProcessContext, command: string): Array<{ evidence: string; runClass: string }> {
  return ctx.memory.read(
    (db) =>
      db
        .stmt("SELECT json_extract(record, '$.evidence') AS evidence, json_extract(record, '$.runClass') AS runClass FROM log WHERE kind = 'evidence' AND json_extract(record, '$.fields.command') = ? ORDER BY rev")
        .all(command) as Array<{ evidence: string; runClass: string }>,
  );
}

async function waitFor(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Another `mp` process (process-run-lock-child.ts); `answer` is its one JSON line. */
function child(action: Record<string, unknown>): { readonly proc: ChildProcess; readonly answer: Promise<any>; readonly exit: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CHILD, JSON.stringify(action)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
  const exit = new Promise<number | null>((resolve) => proc.on('close', (code, signal) => resolve(signal !== null ? -1 : code)));
  const answer = exit.then(() => {
    const line = out.trim().split('\n').at(-1) ?? '';
    if (!line.startsWith('{')) throw new Error(`the child gave no answer (stdout ${JSON.stringify(out)}, stderr ${JSON.stringify(err.slice(-2000))})`);
    return JSON.parse(line) as unknown;
  });
  // a child the test kills gives no answer: that is not an unhandled rejection (awaiting it still throws)
  answer.catch(() => undefined);
  return { proc, answer, exit };
}

function verifyIn(q: ProcessProject, commit: string, commands: ReadonlyArray<{ id: string; command: string }>) {
  return child({ action: 'verify', dir: q.dir, env: ENV_A, mission: M, object: 'prod.lock-test', commit, commands });
}

const verifyHere = (ctx: ProcessContext, commit: string, commands: ReadonlyArray<{ id: string; command: string }>) => ctx.actions().verify({ mission: M, object: 'prod.lock-test', snapshot: commit, commands });

/** The checkouts of runs under `.mission-pipeline/tmp/`. */
function runCheckouts(ctx: ProcessContext): string[] {
  return existsSync(ctx.memory.paths.tmp) ? readdirSync(ctx.memory.paths.tmp).filter((n) => n.startsWith('run-')).sort() : [];
}

describe('the run lock: a declared run executes once while other processes advance', () => {
  it('two processes verify the same candidate and commands at once: one executes, the others are pending; then the run is reused', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const g = gatedCommand(p);
    const commands = [{ id: 'check', command: g.command }];
    const holder = verifyIn(p, commit, commands);
    await waitFor('the first execution to start', () => executions(g.counter) === 1);
    // the run executes and is not recorded yet: every other verification of it waits, in any process
    const others = [verifyIn(p, commit, commands), verifyIn(p, commit, commands)];
    for (const o of others) assert.deepEqual(await o.answer, { pending: true }, 'another process does not run it again');
    assert.equal(await verifyHere(p.ctx, commit, commands), 'pending', 'nor does this one');
    assert.equal(executions(g.counter), 1, 'still one execution');
    assert.deepEqual(evidenceOf(p.ctx, g.command), [], 'nothing recorded by the waiting calls');
    assert.equal(runCheckouts(p.ctx).length, 1, "only the holder's checkout exists");
    writeFileSync(g.gate, '');
    const done = (await holder.answer) as { runs: Array<{ evidence: string; passed: boolean }> };
    assert.equal(done.runs.length, 1, JSON.stringify(done));
    assert.equal(done.runs[0]!.passed, true);
    // the next call (the waiting step's next pass) reuses the recorded run
    const again = await verifyHere(p.ctx, commit, commands);
    assert.notEqual(again, 'pending');
    assert.deepEqual(again, done.runs, 'the recorded run, reused');
    assert.equal(executions(g.counter), 1, 'exactly one execution in all');
    assert.equal(evidenceOf(p.ctx, g.command).length, 1, 'one evidence record');
    assert.deepEqual(runCheckouts(p.ctx), [], 'the checkout is removed');
  });

  it('a declared command in a mixed group waits for its lock; sampled commands execute on each successful call', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const g = gatedCommand(p);
    const declared = { id: 'check', command: g.command };
    const holder = verifyIn(p, commit, [declared]);
    await waitFor('the declared command', () => executions(g.counter) === 1);
    const mixed = [declared, { id: 'sample', command: 'node -e 0', sampled: true }];
    await assert.rejects(runOnCommit(p.ctx, { mission: M, commit, commands: mixed, purpose: 'mixed', declaration: { by: 'mp', checkout: 'clean', declared: true } }), RunInProgress);
    assert.equal(executions(g.counter), 1);
    assert.equal(evidenceOf(p.ctx, 'node -e 0').length, 0);
    writeFileSync(g.gate, '');
    await holder.answer;
    for (let i = 0; i < 2; i++) {
      const done = await runOnCommit(p.ctx, { mission: M, commit, commands: mixed, purpose: 'mixed', declaration: { by: 'mp', checkout: 'clean', declared: true } });
      assert.equal(done.runs[0]!.reused, true);
    }
    assert.equal(evidenceOf(p.ctx, g.command).length, 1, 'setup is never new evidence');
    assert.equal(evidenceOf(p.ctx, 'node -e 0').length, 2, 'every sample executes');
  });

  it('partial reuse executes A then B in one checkout, but records only B; duplicate reuse keys record once', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const setup = { id: 'A', command: `node -e "require('node:fs').writeFileSync('installed', 'yes')"` };
    const check = { id: 'B', command: `node -e "if(require('node:fs').readFileSync('installed','utf8')!=='yes')process.exit(1)"` };
    const a = await verifyHere(p.ctx, commit, [setup]);
    assert.ok(a !== 'pending');
    const ab = await verifyHere(p.ctx, commit, [setup, check, { ...check, id: 'B-again' }]);
    assert.ok(ab !== 'pending');
    assert.equal(ab[0]!.evidence, a[0]!.evidence);
    assert.equal(ab[1]!.passed, true, 'setup populated the same checkout');
    assert.equal(ab[2]!.evidence, ab[1]!.evidence);
    assert.equal(evidenceOf(p.ctx, setup.command).length, 1);
    assert.equal(evidenceOf(p.ctx, check.command).length, 1);
    assert.deepEqual(await verifyHere(p.ctx, commit, [setup, check]), ab.slice(0, 2));
    assert.deepEqual(runCheckouts(p.ctx), []);
  });

  it('a failing setup-only execution is a note, and later commands still run and record their results', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const setup = { id: 'A', command: 'setup' };
    const check = { id: 'B', command: 'check' };
    const calls: string[] = [];
    let fail = false;
    const ctx = { ...p.ctx, runner: ({ command }: { command: string }) => {
      calls.push(command);
      return { exitCode: fail ? 1 : 0, signal: null, error: null, timedOut: false, output: Buffer.from(''), durationMs: 1 };
    } };
    const req = { mission: M, commit, purpose: 'partial', declaration: { by: 'mp' as const, checkout: 'clean' as const, declared: true } };
    const first = await runOnCommit(ctx, { ...req, commands: [setup] });
    fail = true;
    const next = await runOnCommit(ctx, { ...req, commands: [setup, check] });
    assert.deepEqual(calls, ['setup', 'setup', 'check']);
    assert.equal(next.runs[0]!.evidence, first.runs[0]!.evidence);
    assert.equal(next.runs[0]!.passed, true, 'recorded evidence stays in force');
    assert.match(next.runs[0]!.setupFailure!, /Setup-only.*failed/);
    assert.equal(next.runs[1]!.passed, false, 'later failure recorded as it came out');
    assert.equal(evidenceOf(ctx, 'setup').length, 1);
    assert.equal(evidenceOf(ctx, 'check').length, 1);
    assert.deepEqual(runCheckouts(ctx), []);
    const again = await runOnCommit(ctx, { ...req, commands: [setup, check] });
    assert.equal(again.reused, true, 'failed evidence is reusable too; no stuck retry');
    assert.equal(again.runs[0]!.setupFailure, undefined, 'a temporary failure is not evidence');
  });

  it('missing and v1 run methods execute again, v2 is reused, and old evidence stays intact', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const env = p.ctx.environment();
    for (const method of [undefined, 'v1']) {
      const command = `node -e "console.log('${method ?? 'legacy'}')"`;
      const fields = { candidate: commit, command, status: 'completed', exit: '0', ...(method === undefined ? {} : { [RUN_FIELD.method]: method }) };
      p.ctx.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'evidence', evidence: `old-${method ?? 'missing'}` as never, envLine: ENV_LINE, envSnapshot: env.identity, runClass: 'declared', fields }]));
      const req = { mission: M, commit, commands: [{ id: 'A', command }], purpose: 'upgrade', declaration: { by: 'mp' as const, checkout: 'clean' as const, declared: true } };
      const fresh = await runOnCommit(p.ctx, req);
      assert.equal(fresh.reused, false);
      assert.equal(fresh.runs[0]!.fields[RUN_FIELD.method], 'v2');
      const again = await runOnCommit(p.ctx, req);
      assert.equal(again.reused, true);
      assert.equal(again.runs[0]!.evidence, fresh.runs[0]!.evidence);
      assert.equal(evidenceOf(p.ctx, command).length, 2, 'old and v2 retained');
    }
  });

  it('a sampling run (a rerun) of the same command still executes while the declared run holds the lock', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const g = gatedCommand(p);
    const commands = [{ id: 'check', command: g.command }];
    const holder = verifyIn(p, commit, commands);
    await waitFor('the declared run to start', () => executions(g.counter) === 1);
    const rerun = await runOnCommit(p.ctx, { mission: M, commit, commands, purpose: 'rerun while the declared run executes', declaration: { by: 'mp', checkout: 'clean', declared: true, rerun: true } });
    assert.equal(rerun.reused, false, 'a sampling run is never reused');
    assert.equal(rerun.runs[0]!.passed, true);
    assert.equal(executions(g.counter), 2, 'the rerun executed');
    const again = await runOnCommit(p.ctx, { mission: M, commit, commands, purpose: 'another rerun', declaration: { by: 'mp', checkout: 'clean', declared: true, rerun: true } });
    assert.equal(executions(g.counter), 3, 'every rerun executes');
    assert.notEqual(again.runs[0]!.evidence, rerun.runs[0]!.evidence, 'a new run id each time');
    assert.equal(await verifyHere(p.ctx, commit, commands), 'pending', 'the declared run still holds its lock');
    writeFileSync(g.gate, '');
    const done = (await holder.answer) as { runs: Array<{ evidence: string }> };
    const reused = await verifyHere(p.ctx, commit, commands);
    assert.deepEqual(reused, done.runs, 'the declared run is reused, not the samples');
    assert.equal(executions(g.counter), 3);
    assert.deepEqual(evidenceOf(p.ctx, g.command).map((e) => e.runClass), ['sampling', 'sampling', 'declared']);
  });

  it('a holder that is killed releases the lock: the next call executes in a checkout of its own', async () => {
    p = processProject();
    const commit = p.git('rev-parse', 'HEAD');
    const g = gatedCommand(p);
    const commands = [{ id: 'check', command: g.command }];
    const holder = verifyIn(p, commit, commands);
    await waitFor('the run to start', () => executions(g.counter) === 1);
    assert.equal(await verifyHere(p.ctx, commit, commands), 'pending');
    const stale = runCheckouts(p.ctx);
    assert.equal(stale.length, 1);
    holder.proc.kill('SIGKILL');
    assert.equal(await holder.exit, -1);
    // its checkout is left behind and nothing was recorded; the operating system freed the lock
    assert.deepEqual(runCheckouts(p.ctx), stale);
    assert.deepEqual(evidenceOf(p.ctx, g.command), []);
    const r = await verifyHere(p.ctx, commit, commands);
    assert.ok(r !== 'pending', 'not blocked by the killed holder');
    assert.equal(r[0]!.passed, true, 'the stale checkout does not break the run');
    assert.equal(executions(g.counter), 2, 'it executed (the killed run recorded nothing to reuse)');
    assert.equal(evidenceOf(p.ctx, g.command).length, 1);
    assert.deepEqual(runCheckouts(p.ctx), stale, "its own checkout is removed; the killed one's is another directory");
    assert.deepEqual(await verifyHere(p.ctx, commit, commands), r, 'and reused from then on');
  });

  it('a run that fails before it is recorded releases its lock: the next call is not pending', async () => {
    p = processProject();
    const missing = '0123456789abcdef0123456789abcdef01234567';
    const commands = [{ id: 'check', command: 'node -e 0' }];
    await assert.rejects(verifyHere(p.ctx, missing, commands), (e: Error & { code?: string }) => e.code === 'missing-objects');
    await assert.rejects(verifyHere(p.ctx, missing, commands), (e: Error & { code?: string }) => e.code === 'missing-objects', 'the same refusal again, not "pending"');
    // the refusal of runOnCommit itself while another process holds the lock is a LOCKED one ("busy, retry")
    const e = new RunInProgress('c0ffee', ['check']);
    assert.equal(e.code, 'LOCKED');
    assert.equal(e.name, 'LedgerError');
  });

  it("the flow: while a Constructor's hand-back verifies its candidate, mp pm next comes back with the task waiting, nothing failed and nothing run twice", async () => {
    p = processProject();
    const g = gatedCommand(p);
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan(M, { verification: [{ id: 'check', command: g.command }] }));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    readAll(ctx, d.dispatch);
    const wt = join(p.dir, d.worktree!);
    write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(wt, 'src/check.js', CHECK_JS);
    const dir = join(ctx.memory.paths.tmp, d.dispatch);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), `# Report of ${d.dispatch}\n\nDone as the card says.\n`);
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] }));
    // the seat hands back in its own process: recorded, then its verification runs (held open by the gate)
    const seat = child({ action: 'handback', dir: p.dir, env: ENV_A, dispatch: d.dispatch, report: `.mission-pipeline/tmp/${d.dispatch}/report.md`, result: `.mission-pipeline/tmp/${d.dispatch}/result.json` });
    await waitFor("the hand-back's verification to start", () => executions(g.counter) === 1);
    // meanwhile the PM advances the process, twice
    for (let i = 0; i < 2; i++) {
      const next = await pmNext(ctx);
      assert.deepEqual(next.errors, [], 'no flow step failed');
      assert.deepEqual(next.notices.filter((n) => n.category.startsWith('flow-')).map((n) => `${n.category}: ${n.trigger}`), [], 'no failure notice');
      assert.ok(!next.ready.some((r) => r.kind === 'reviewer'), 'the task waits for its runs');
    }
    assert.equal(executions(g.counter), 1, 'the PM did not run the verification again');
    assert.deepEqual(evidenceOf(ctx, g.command), []);
    assert.equal(dispatchView(ctx, d.dispatch).info.handback, 'accepted', 'the hand-back is recorded');
    writeFileSync(g.gate, '');
    const answer = (await seat.answer) as { kind: string; verification: Array<{ evidence: string; passed: boolean }> | null; notes: string[] };
    assert.equal(answer.kind, 'recorded', JSON.stringify(answer));
    assert.equal(answer.verification?.length, 1, JSON.stringify(answer));
    assert.equal(answer.verification![0]!.passed, true);
    // the result reaches the flow: the Reviewer is ready, citing the one run
    const rev = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, rev.step);
    const card = dispatchView(ctx, rd.dispatch).card as unknown as { verificationRuns: Array<{ evidence: string }> };
    assert.deepEqual(card.verificationRuns.map((r) => r.evidence), [answer.verification![0]!.evidence]);
    assert.equal(executions(g.counter), 1, 'exactly one execution in all');
    assert.equal(evidenceOf(ctx, g.command).length, 1);
  });

  it('a hand-back whose verification is pending in another process is recorded once, runs nothing, and the flow gets the result later', async () => {
    p = processProject();
    let ctx = p.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    // another process holds the run lock of this candidate's runs: verify answers "pending" (the case above)
    ctx = p.reopen(ENV_A, { actions: (c) => ({ ...gitActions(c), verify: async () => 'pending' as const }) });
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    readAll(ctx, d.dispatch);
    const wt = join(p.dir, d.worktree!);
    write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(wt, 'src/check.js', CHECK_JS);
    const fields = { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] };
    const a = await handBack(ctx, d.dispatch, fields);
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    if (a.kind !== 'recorded') return;
    assert.equal(a.outcome, 'accepted');
    assert.notEqual(a.candidate, null);
    assert.equal(a.verification, null, 'no runs of its own');
    assert.ok(a.notes.some((n) => /executing in another mp process/.test(n)), a.notes.join('\n'));
    assert.ok(!a.notes.some((n) => /could not run now|will advance on the PM's next step/.test(n)), a.notes.join('\n'));
    assert.deepEqual(evidenceOf(ctx, 'node src/check.js'), []);
    const next = await pmNext(ctx);
    assert.deepEqual(next.errors, []);
    assert.deepEqual(next.notices.filter((n) => n.category.startsWith('flow-')).map((n) => n.category), [], 'nothing marked failed');
    assert.ok(!readSteps(ctx).ready.some((r) => r.kind === 'reviewer'));
    // the same hand-back again is the recorded one (one hand-back per dispatch)
    const again = await handBack(ctx, d.dispatch, fields);
    assert.equal(again.kind === 'recorded' && again.repeated, true);
    // once the runs can be had (here: this process runs them), the flow verifies and the Reviewer is ready
    ctx = p.reopen(ENV_A);
    await readyOf(ctx, 'reviewer');
    assert.equal(evidenceOf(ctx, 'node src/check.js').length, 1);
  });
});
