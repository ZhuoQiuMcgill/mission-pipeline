// 4.1.3 (P4 items 1 and 7, #30): a long experiment run does not depend on the seat's lifetime.
//   in this process (the worker run by a test spawner, its command held by a gate):
//   1  `rerun --detach` answers at once with the run id; `wait` says running, then returns the result as
//      a foreground rerun does (with its tail); the evidence is a foreground rerun's; a hand-back cites it
//   2  the step dispatched again (its seat gone): the new card lists the run, running; the new seat waits
//      on it and cites it; `mp pm next` lists the run that ended for the dispatch in flight
//   3  lost: a worker that is gone (its pid, or its pid with another start time) is recorded as lost
//      by `wait` and by `mp pm next`; a result that arrives after "lost" still counts
//   4  stopped: the worker told to stop, or a stop recorded before it records, records no result
//   with real workers (`mp` processes, POSIX process groups):
//   5  started from a shell's `mp seat <id> rerun --detach`, which returns at once; the worker outlives
//      it, in its own process group, under the experiment time limit; the cleanup runs (item 7)
//   6  on its time limit the whole process group ends, a background child too
//   7  `mp pm stop` ends the run's process group and records it as stopped, with no evidence

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { appendRecords, commitStop, factById, flowEvents, type WriteTx } from '../src/memory/index.ts';
import {
  DETACHED_EVENT,
  DISPATCH_LINE,
  dispatchStepRuns,
  LOST_WHY,
  pmDispatch,
  pmNext,
  pmRelease,
  pmStop,
  processStart,
  recordDetachedEnd,
  shellRunner,
  type CommandOutcome,
  type CommandRunner,
  type DetachSpawner,
  type ProcessContext,
} from '../src/process/index.ts';
import { dispatchView, seatCard, seatRerunDetached, seatRerunWorker, seatWait } from '../src/process/seat.ts';
import { sh } from './cli-fixtures.ts';
import { blind, RUN_PLACEHOLDER } from './flow-exploration-fixtures.ts';
import { ENV_A, handBack, processProject, readAll, type ProcessProject } from './process-fixtures.ts';
import { experimentDispatch } from './p413-fixtures.ts';

const LOUD = "for (let i = 1; i <= 500; i++) console.log('status: item ' + i + ' ok');\n";
const POSIX = process.platform !== 'win32';

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

/** A runner whose commands wait until the test opens the gate, then run with the platform's shell. */
function gated(): { readonly runner: CommandRunner; open(): void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  return { runner: async (req): Promise<CommandOutcome> => (await gate, shellRunner(req)), open: () => open() };
}

/** The worker in this process (its pid is this process's): what `--detach` starts, without a process of its own. */
function inProcess(o: { readonly stopping?: AbortSignal } = {}): { readonly spawner: DetachSpawner; readonly done: Array<Promise<Awaited<ReturnType<typeof seatRerunWorker>>>> } {
  const done: Array<Promise<Awaited<ReturnType<typeof seatRerunWorker>>>> = [];
  const spawner: DetachSpawner = (ctx, req) =>
    new Promise((resolve, reject) => {
      done.push(seatRerunWorker(ctx, req.dispatch, req.command, { ready: resolve, ...(o.stopping !== undefined ? { stopping: o.stopping } : {}) }).catch((e: unknown) => (reject(e), Promise.reject(e))));
    });
  return { spawner, done };
}

/** The experiment's hand-back, its claims citing `evidence`. */
function experimentResult(ctx: ProcessContext, dispatch: string, evidence: string): unknown {
  const card = dispatchView(ctx, dispatch).card as never;
  return JSON.parse(JSON.stringify(blind(card)).split(RUN_PLACEHOLDER).join(`run:${evidence}`));
}

const evidenceRecord = (ctx: ProcessContext, id: string) => ctx.memory.read((db) => factById(db, 'evidence', id)?.record) as { runClass: string; fields: Record<string, string> } | undefined;

describe('1: rerun --detach answers at once; wait returns the result', () => {
  it('running, then finished with the result and tail of a foreground rerun; the hand-back cites it', async () => {
    const g = gated();
    p = processProject({ files: { 'loud.js': LOUD }, options: { runner: g.runner } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const w = inProcess();
    const s = await seatRerunDetached(p.ctx, d, 'probe', w.spawner);
    assert.match(s.run, /^rerun-/);
    assert.equal(s.dispatch, d);
    const now = await seatWait(p.ctx, d, s.run, { seconds: 0 });
    assert.equal(now.state, 'running');
    assert.equal(now.evidence, s.evidence);
    assert.ok(now.since !== null);
    const started = p.ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as MissionId, line: DISPATCH_LINE(d), event: DETACHED_EVENT }));
    assert.equal(started.length, 1, 'recorded as running against the dispatch');
    const body = JSON.parse(p.ctx.memory.data.text(started[0]!.body)) as { pid: number; start: string | null; host: string };
    assert.equal(body.pid, process.pid);
    assert.equal(body.host, hostname());
    if (process.platform === 'linux') assert.match(body.start ?? '', /^linux:/);
    g.open();
    assert.equal((await w.done[0])!.state, 'finished');
    const r = await seatWait(p.ctx, d, s.run, { seconds: 5, pollMs: 10 });
    assert.equal(r.state, 'finished');
    assert.equal(r.result!.passed, true);
    assert.equal(r.result!.run, s.evidence);
    assert.equal(r.result!.tail.split('\n').at(-1), 'status: item 500 ok');
    assert.match(r.result!.summary, /^completed; exit 0/);
    assert.equal((await seatWait(p.ctx, d, s.evidence, { seconds: 0 })).state, 'finished', 'the evidence id names it too');
    // the evidence is a foreground rerun's
    const rec = evidenceRecord(p.ctx, s.evidence)!;
    assert.equal(rec.runClass, 'sampling');
    assert.equal(rec.fields['dispatch'], d);
    assert.equal(rec.fields['run'], s.run);
    assert.equal(rec.fields['purpose'], `rerun of probe by dispatch ${d}`);
    assert.ok(existsSync(join(p.dir, '.mission-pipeline', r.result!.leaf!)));
    const a = await handBack(p.ctx, d, experimentResult(p.ctx, d, s.evidence));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
  });
});

describe('2: the step dispatched again carries the run', () => {
  it('the new card lists it running; the new seat waits on it and cites it; mp pm next lists it for the dispatch in flight', async () => {
    const g = gated();
    p = processProject({ files: { 'loud.js': LOUD }, options: { runner: g.runner } });
    const d1 = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const w = inProcess();
    const s = await seatRerunDetached(p.ctx, d1, 'probe', w.spawner);
    // the seat is gone: the PM releases its dispatch and dispatches the step again
    await pmRelease(p.ctx, d1, 'ended');
    const ready = (await pmNext(p.ctx)).ready.find((x) => x.kind === 'constructor-experiment')!;
    const d2 = pmDispatch(p.ctx, ready.step).dispatch;
    readAll(p.ctx, d2);
    const card = seatCard(p.ctx, d2).text;
    assert.match(card, /## Runs already made for this step/);
    assert.ok(card.includes(`${s.run} (command probe, by ${d1}): still running`), card);
    assert.ok(card.includes(`\`mp seat ${d2} wait ${s.run}\``));
    assert.match(card, /Record from their results and do not run them again/);
    assert.match(card, /rerun <command-id> --detach/);
    assert.match(card, /Never end your turn to ask whether to keep waiting/);
    assert.deepEqual((await pmNext(p.ctx)).detachedRuns, [], 'nothing ended yet');
    g.open();
    await w.done[0];
    // ended after d2's claim: listed for d2, which is in flight
    const notes = (await pmNext(p.ctx)).detachedRuns;
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.dispatch, d2);
    assert.equal(notes[0]!.startedBy, d1);
    assert.match(notes[0]!.text, new RegExp(`^run ${s.run} \\(started by ${d1}\\) for dispatch ${d2} finished at \\S+ \\(exit 0\\)\\. If its seat is gone, release ${d2} and dispatch it again; the new card carries ${s.run}\\.$`));
    const r = await seatWait(p.ctx, d2, s.run, { seconds: 5, pollMs: 10 });
    assert.equal(r.state, 'finished');
    assert.equal(r.startedBy, d1);
    assert.equal(r.result!.tail.split('\n').length, 400);
    const a = await handBack(p.ctx, d2, experimentResult(p.ctx, d2, s.evidence));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', `the carried run is citable: ${JSON.stringify(a)}`);
    assert.deepEqual((await pmNext(p.ctx)).detachedRuns, [], 'handed back: nothing to tell the PM');
  });

  it('a run that ended before the step was dispatched again is on the new card with its result, not in mp pm next', async () => {
    p = processProject({ files: { 'loud.js': LOUD } });
    const d1 = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const w = inProcess();
    const s = await seatRerunDetached(p.ctx, d1, 'probe', w.spawner);
    await w.done[0];
    assert.equal((await pmNext(p.ctx)).detachedRuns.length, 1, 'finished for d1, in flight: listed');
    await pmRelease(p.ctx, d1, 'ended');
    const d2 = pmDispatch(p.ctx, (await pmNext(p.ctx)).ready.find((x) => x.kind === 'constructor-experiment')!.step).dispatch;
    assert.ok(seatCard(p.ctx, d2).text.includes(`${s.run} (command probe, by ${d1}): passed — completed; exit 0`));
    assert.ok(seatCard(p.ctx, d2).text.includes(`Cite it as evidence:${s.evidence} or run:${s.evidence}.`));
    assert.deepEqual((await pmNext(p.ctx)).detachedRuns, []);
  });
});

/** A "detached" record as a worker writes it, with the given pid and start time. */
function recordWorker(ctx: ProcessContext, dispatch: string, run: string, pid: number, start: string | null): { run: string; evidence: string; dispatch: string } {
  const info = dispatchView(ctx, dispatch).info;
  const body = { run, evidence: `sample.${run}.probe.sx`, command: 'probe', dispatch, task: info.task, pid, start, host: hostname(), startedAt: Date.now() };
  ctx.memory.write({ op: `test-detached:${run}`, payload: {} }, (tx: WriteTx) => {
    appendRecords(tx, [{ kind: 'flow.event', mission: info.mission, line: DISPATCH_LINE(dispatch), event: DETACHED_EVENT, key: run, body: tx.data.put(JSON.stringify(body)) as ContentHash }]);
  });
  return body;
}

describe('3: a worker that is gone is recorded as lost', () => {
  it('by its pid, or its pid with another start time (a reused pid); wait and mp pm next record it', async () => {
    p = processProject({ files: { 'loud.js': LOUD } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    recordWorker(p.ctx, d, 'rerun-gone', gone, 'linux:x:1');
    const r = await seatWait(p.ctx, d, 'rerun-gone', { seconds: 30, pollMs: 10 });
    assert.equal(r.state, 'lost');
    assert.equal(r.why, LOST_WHY);
    assert.ok(r.waitedMs < 5_000, 'at once');
    // this process's pid, with a start time that is not its own: another process, so the worker is gone
    if (processStart(process.pid)?.startsWith('linux:') === true) {
      recordWorker(p.ctx, d, 'rerun-reused', process.pid, 'linux:another-boot:1');
      assert.equal((await seatWait(p.ctx, d, 'rerun-reused', { seconds: 0 })).state, 'lost', 'not by the pid alone');
    }
    // the right pid and start time: alive, still running
    recordWorker(p.ctx, d, 'rerun-alive', process.pid, processStart(process.pid));
    assert.equal((await seatWait(p.ctx, d, 'rerun-alive', { seconds: 0 })).state, 'running');
    // mp pm next records one it finds
    recordWorker(p.ctx, d, 'rerun-later', gone, null);
    const notes = (await pmNext(p.ctx)).detachedRuns;
    assert.ok(notes.some((n) => n.run === 'rerun-later' && n.state === 'lost' && /was lost at \S+: its worker is gone/.test(n.text)), JSON.stringify(notes));
    assert.equal(p.ctx.memory.read((db) => dispatchStepRuns(db, p!.ctx.memory.data, dispatchView(p!.ctx, d).info)).find((x) => x.run === 'rerun-later')!.state, 'lost');
  });

  it('a result that arrives after "lost" is recorded and counts', async () => {
    const g = gated();
    p = processProject({ files: { 'loud.js': LOUD }, options: { runner: g.runner } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const w = inProcess();
    const s = await seatRerunDetached(p.ctx, d, 'probe', w.spawner);
    assert.equal(recordDetachedEnd(p.ctx, { run: s.run, evidence: s.evidence, dispatch: d }, 'lost', 'a reader thought so'), true);
    assert.equal((await seatWait(p.ctx, d, s.run, { seconds: 0 })).state, 'lost');
    g.open();
    assert.equal((await w.done[0])!.state, 'finished');
    const r = await seatWait(p.ctx, d, s.run, { seconds: 0 });
    assert.equal(r.state, 'finished', 'a result is a fact; "lost" was an inference');
    assert.ok(evidenceRecord(p.ctx, s.evidence) !== undefined);
  });
});

describe('4: a stopped run records no result', () => {
  it('the worker told to stop: recorded as stopped, no evidence', async () => {
    const g = gated();
    p = processProject({ files: { 'loud.js': LOUD }, options: { runner: g.runner } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const stop = new AbortController();
    const w = inProcess({ stopping: stop.signal });
    const s = await seatRerunDetached(p.ctx, d, 'probe', w.spawner);
    stop.abort();
    g.open();
    assert.equal((await w.done[0])!.state, 'stopped');
    const r = await seatWait(p.ctx, d, s.run, { seconds: 0 });
    assert.equal(r.state, 'stopped');
    assert.match(r.why ?? '', /told to stop/);
    assert.equal(evidenceRecord(p.ctx, s.evidence), undefined, 'nothing of it is recorded');
  });

  it('a stop recorded while it ran: its result is refused in its write and it is recorded as stopped', async () => {
    const g = gated();
    p = processProject({ files: { 'loud.js': LOUD }, options: { runner: g.runner } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const w = inProcess();
    const s = await seatRerunDetached(p.ctx, d, 'probe', w.spawner);
    // the stop record alone (no signal reaches this process's worker)
    p.ctx.memory.write({ op: 'stop:s1', payload: {}, stop: true }, (tx) => commitStop(tx, { stop: 's1' as never, scope: { kind: 'all' }, words: 'stop everything', at: Date.now(), wordsEntry: null }));
    g.open();
    assert.equal((await w.done[0])!.state, 'stopped');
    assert.equal(evidenceRecord(p.ctx, s.evidence), undefined);
    assert.match(p.ctx.memory.read((db) => dispatchStepRuns(db, p!.ctx.memory.data, dispatchView(p!.ctx, d).info))[0]!.why ?? '', /a stop covers it/);
  });
});

// ---------------------------------------------------------------- real workers

const alive = (pid: number): boolean => processStart(pid) !== null;

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A project whose `mp` processes all observe the real environment (the workers do), with this config.json. */
function realProject(files: Record<string, string>, config: Record<string, unknown>): ProcessProject {
  const pp = processProject({ files });
  writeFileSync(join(pp.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', ...config }));
  pp.reopen(ENV_A, { observe: undefined });
  return pp;
}

describe('5-7: real workers', { skip: !POSIX }, () => {
  it('5: started from a shell, it outlives that mp process, in its own process group, under the experiment limit; the cleanup runs', async () => {
    const mark = join(process.env['TMPDIR'] ?? '/tmp', `mp-p413-cleanup-${process.pid}-${Date.now()}`);
    p = realProject(
      { 'slow.js': "console.log('status: start');\nsetTimeout(() => console.log('status: done'), 3000);\n" },
      { commandTimeoutMs: 1_000, experimentCommandTimeoutMs: 60_000, cleanupCommands: [{ id: 'mark', command: `node -e "require('fs').appendFileSync(process.argv[1], 'cleaned\\n')" ${mark}` }] },
    );
    const d = await experimentDispatch(p.ctx, 'm1', 'node slow.js');
    const t0 = Date.now();
    const started = sh(p.dir, ['seat', d, 'rerun', 'probe', '--detach', '--json']);
    assert.equal(started.code, 0, started.out + started.err);
    const s = started.json.result as { run: string; evidence: string; pid: number };
    assert.ok(Date.now() - t0 < 30_000);
    assert.notEqual(s.pid, process.pid);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${s.pid}/stat`, 'utf8');
      const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      assert.equal(pgid, s.pid, 'the worker leads its own process group');
    }
    assert.equal((await seatWait(p.ctx, d, s.run, { seconds: 0 })).state, 'running', 'the starting mp process ended; the run goes on');
    const r = await seatWait(p.ctx, d, s.run, { seconds: 120, pollMs: 100 });
    assert.equal(r.state, 'finished', JSON.stringify(r));
    assert.equal(r.result!.passed, true, 'the experiment limit (60 s) applies, not commandTimeoutMs (1 s)');
    assert.match(r.result!.tail, /status: done/);
    await until('the worker to end', () => !alive(s.pid));
    assert.equal(readFileSync(mark, 'utf8'), 'cleaned\n', 'the cleanup ran once, after the command');
  });

  it('6: on its time limit the whole process group ends, a background child too', async () => {
    const bg = join(process.env['TMPDIR'] ?? '/tmp', `mp-p413-bg-${process.pid}-${Date.now()}`);
    p = realProject({}, { experimentCommandTimeoutMs: 1_500 });
    const d = await experimentDispatch(p.ctx, 'm1', `sleep 30 & echo $! > ${bg}; wait`);
    const s = await seatRerunDetached(p.ctx, d, 'probe');
    const r = await seatWait(p.ctx, d, s.run, { seconds: 60, pollMs: 100 });
    assert.equal(r.state, 'finished');
    assert.equal(r.result!.passed, false);
    assert.match(r.result!.summary, /^timeout;/);
    const child = Number(readFileSync(bg, 'utf8').trim());
    await until('the background child to end', () => !alive(child), 15_000);
  });

  it('7: mp pm stop ends the run\'s process group and records it as stopped, with no evidence', async () => {
    const bg = join(process.env['TMPDIR'] ?? '/tmp', `mp-p413-stop-${process.pid}-${Date.now()}`);
    p = realProject({}, { experimentCommandTimeoutMs: 120_000 });
    const d = await experimentDispatch(p.ctx, 'm1', `sleep 60 & echo $! > ${bg}; wait`);
    const s = await seatRerunDetached(p.ctx, d, 'probe');
    await until('the command to start', () => existsSync(bg) && readFileSync(bg, 'utf8').trim() !== '');
    const child = Number(readFileSync(bg, 'utf8').trim());
    const st = pmStop(p.ctx, { stop: 'stop-1' as never, scope: { kind: 'all' }, words: 'stop everything', wordsEntry: null });
    assert.deepEqual(st.detached, [{ run: s.run, dispatch: d, outcome: 'stopped' }]);
    assert.match(st.message, new RegExp(`mp stopped 1 detached run in its scope: ${s.run} \\(${d}\\)`));
    await until('the background child to end', () => !alive(child), 20_000);
    await until('the worker to end', () => !alive(s.pid), 30_000);
    const r = await seatWait(p.ctx, d, s.run, { seconds: 0 });
    assert.equal(r.state, 'stopped');
    assert.match(r.why ?? '', /stop stop-1/);
    assert.equal(evidenceRecord(p.ctx, s.evidence), undefined);
  });
});
