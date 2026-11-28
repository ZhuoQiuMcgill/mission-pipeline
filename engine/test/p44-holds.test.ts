// 4.4 (G6; the plan's F6, problem P6): holds. "Not this yet" is a record any session reads: the PM places
// one on the user's words, the Secretary for its own reasons with no words, and nothing refuses either. A
// hold blocks new dispatches only (the ready list and the claim); its condition is evaluated when the list
// is built and writes nothing; `mp sec wait` wakes on a change of hold and at a hold's time.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { defaultConfig, writeConfig } from '../src/cli/config.ts';
import { beginAction, endAction } from '../src/cli/project.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { flowCtx } from '../src/flow/context.ts';
import { raiseEscalation } from '../src/flow/secretary.ts';
import { openProcess, pmDispatch, type ProcessOptions } from '../src/process/index.ts';
import { holdsOn, placeHold, type HoldRow } from '../src/process/holds.ts';
import { secWait, secretaryWakes, SECRETARY_WAKE } from '../src/process/secretary.ts';
import type { TaskSpecDoc } from '../src/process/ports.ts';
import type { MissionId } from '../src/common/ids.ts';
import { rebuildState } from '../src/memory/index.ts';
import { ENV_A, CHECK_JS, addDetailedPlan, addMissionToReview, handBack, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';
import { project43, live43 } from './p43-fixtures.ts';

/** One mp command, JSON out; `process` adds options of the process context (a clock, the free disk). */
async function mp(p: ProcessProject, args: string[], o: { identity?: string | null; process?: ProcessOptions } = {}) {
  const r = await runCli([...args, '--json'], { cwd: p.dir, env: { MP_SECRETARY: o.identity ?? '' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' }, ...(o.process ?? {}) } });
  return { code: r.exitCode, ...JSON.parse(r.stdout || r.stderr) } as { code: number; result: any; error?: any; replayed?: boolean };
}
async function done(p: ProcessProject, args: string[], o: { identity?: string | null; process?: ProcessOptions } = {}): Promise<any> {
  const r = await mp(p, args, o);
  assert.equal(r.code, 0, JSON.stringify(r));
  return r.result;
}
async function text(p: ProcessProject, args: string[], o: { identity?: string | null; process?: ProcessOptions } = {}): Promise<string> {
  const r = await runCli(args, { cwd: p.dir, env: { MP_SECRETARY: o.identity ?? '' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' }, ...(o.process ?? {}) } });
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout;
}

/** Mission m1 at its Constructor step (Calibrator ①, the Architect and Calibrator ② done): the step's id. */
async function atConstructor(p: ProcessProject, mission = 'm1'): Promise<string> {
  await startAddMission(p.ctx, mission);
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(p.ctx, 'architect-decompose', () => addDetailedPlan(mission));
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
  return (await readyOf(p.ctx, 'constructor')).step;
}

async function userWords(p: ProcessProject, said: string): Promise<string> {
  return (await done(p, ['pm', 'say', said, '--tag', 'instruction'])).words;
}

test('G6: a PM hold on a task holds its Constructor steps, in the ready list and in the claim; released by hand, the step is dispatched', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    const w = await userWords(p, 'Do not start the add function before I have seen the design.');
    const h = await done(p, ['pm', 'hold', 'add', '--task', 'impl', '--mission', 'm1', '--reason', 'the user wants to see the design first', '--words', w]);
    assert.deepEqual([h.hold, h.state, h.holdsNow], ['H-1', 'in-force', [`${constructor} (constructor)`]]);
    const next = await done(p, ['pm', 'next']);
    assert.ok(!next.ready.some((r: any) => r.step === constructor), '4.3 had it ready: the hold lived only in a note');
    const held = next.held.find((x: any) => x.step === constructor);
    assert.deepEqual(held.holds.map((x: any) => [x.id, x.reason, x.by, x.words]), [['H-1', 'the user wants to see the design first', 'pm', w]]);
    assert.match(await text(p, ['pm', 'next']), /— hold H-1 \(the PM on W-\d+\): the user wants to see the design first; it waits until it is released by hand \(mp pm hold release H-1\)/);
    // a claim made on a list read before the hold is refused in its own write
    const refusedClaim = await mp(p, ['pm', 'dispatch', constructor]);
    assert.equal(refusedClaim.code, 3);
    assert.equal(refusedClaim.error.code, 'NOT_READY');
    assert.match(refusedClaim.error.message, /is held: hold H-1 \(the PM on W-\d+\)/);
    const r = await done(p, ['pm', 'hold', 'release', 'H-1', '--words', w]);
    assert.equal(r.released, true);
    assert.equal((await done(p, ['pm', 'hold', 'release', 'H-1'])).released, false, 'a second release records nothing');
    assert.ok((await done(p, ['pm', 'next'])).ready.some((x: any) => x.step === constructor));
    assert.equal((await mp(p, ['pm', 'dispatch', constructor, '--filled-by', 'test/scripted'])).code, 0);
  } finally {
    p.cleanup();
  }
});

test('G6: a hold blocks new dispatches only: a Constructor in flight hands back and its run is recorded; --all holds the review but not a Secretary decision', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    const d = pmDispatch(p.ctx, constructor, { filledBy: 'test/scripted' });
    const w = await userWords(p, 'Hold everything for now, the machine is busy.');
    assert.equal((await done(p, ['pm', 'hold', 'add', '--all', '--reason', 'the machine is busy', '--words', w])).hold, 'H-1');
    const wt = join(p.dir, d.worktree!);
    write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(wt, 'src/check.js', CHECK_JS);
    const a = await handBack(p.ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(a.kind, 'recorded', 'a hand-back in flight is untouched by a hold');
    await raiseEscalation(flowCtx(p.ctx.ports(), 'm1' as MissionId), { id: 'choice', source: 'constructor-decision', lineage: 'L', subject: 'task:impl', summary: 'choose a detail', reasons: ['a choice'], options: ['answer', 'accept', 'grant', 'ask-user'] });
    const next = await done(p, ['pm', 'next']);
    const review = next.held.find((x: any) => x.kind === 'reviewer');
    assert.ok(review !== undefined && review.holds[0].id === 'H-1', JSON.stringify(next.held));
    assert.ok(next.ready.some((x: any) => x.kind === 'secretary'), 'a Secretary decision is never held by --all');
    assert.ok(!next.ready.some((x: any) => x.kind === 'reviewer'));
  } finally {
    p.cleanup();
  }
});

test('G6: a task hold leaves its review; a step hold holds that one step; mp read blocked and mp read holds show them', async () => {
  const p = project43();
  try {
    await addMissionToReview(p, 'm1');
    const review = (await readyOf(p.ctx, 'reviewer')).step;
    await done(p, ['pm', 'hold', 'add', '--task', 'impl', '--mission', 'm1', '--reason', 'no new attempt yet']);
    assert.ok((await done(p, ['pm', 'next'])).ready.some((x: any) => x.step === review), 'a task hold holds its Constructor steps only');
    assert.equal((await mp(p, ['sec', 'hold', 'add', '--step', review, '--reason', 'a ruling is pending'])).code, 3, 'mp sec needs a live Secretary');
    await done(p, ['pm', 'hold', 'add', '--step', review, '--reason', 'a ruling is pending']);
    const blocked = await done(p, ['read', 'blocked']);
    const entry = blocked.blocked.find((e: any) => e.blocked.because.includes(review));
    assert.ok(entry !== undefined, JSON.stringify(blocked.blocked));
    assert.match(entry.blocked.because, /is held: hold H-2 \(the PM\): a ruling is pending; it waits until it is released by hand \(mp pm hold release H-2\)/);
    assert.match(entry.blocked.next, /it is dispatched once H-2 no longer holds it \(mp read holds says how each ends\)/);
    const holds = await done(p, ['read', 'holds']);
    assert.deepEqual(holds.holds.map((x: any) => [x.id, x.state, x.holdsNow]), [['H-1', 'in-force', []], ['H-2', 'in-force', [`${review} (reviewer)`]]]);
    const shown = await text(p, ['read', 'holds']);
    assert.match(shown, /\[H-2\] in force: step .*; placed by the PM at .*: a ruling is pending/);
    assert.match(shown, /holds now: no queued step/);
  } finally {
    p.cleanup();
  }
});

test('G6: a resource hold holds every step that needs it: a capability, or an exclusive resource it leases', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    await done(p, ['pm', 'hold', 'add', '--resource', 'run-commands', '--reason', 'the build machine is down']);
    assert.ok((await done(p, ['pm', 'next'])).held.some((x: any) => x.step === constructor && x.holds[0].id === 'H-1'));
    const hold = (resource: string, mission: string | null = null): HoldRow => ({ placed: { kind: 'hold.placed', hold: 'H-9', subject: { kind: 'resource', resource }, mission, after: null, from: null, until: null, reason: 'r', by: 'secretary', generation: 'S-1', words: null }, rev: 1, at: 0, released: null });
    const spec = (seat: string, exclusive: string[]): TaskSpecDoc => ({ format: 'mp41.task.v1', task: 't', lineage: 'L', mission: 'm1' as MissionId, card: { seat } as never, priority: 1, capabilities: ['seat'], mode: 'fast', exclusive });
    const q = { task: 't', mission: 'm1', lineage: 'L' };
    assert.equal(holdsOn([hold('simulator')], q, spec('reviewer', ['simulator'])).length, 1);
    assert.equal(holdsOn([hold('simulator')], q, spec('reviewer', [])).length, 0);
    assert.equal(holdsOn([hold('simulator', 'm2')], q, spec('reviewer', ['simulator'])).length, 0, '--mission narrows it');
    assert.equal(holdsOn([hold('seat')], q, spec('secretary', [])).length, 0, 'a Secretary decision is held only by a hold on its own step');
  } finally {
    p.cleanup();
  }
});

test('G6: from and until are evaluated when the list is built and write nothing; the state shows in mp read holds', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    const t0 = Date.UTC(2026, 10, 28, 8, 0);
    const at = (ms: number): { process: ProcessOptions } => ({ process: { now: () => ms } });
    const h = await done(p, ['pm', 'hold', 'add', '--all', '--from', '+1h', '--until', '2026-11-28T11:00Z', '--reason', 'the user is away'], at(t0));
    assert.deepEqual([h.state, h.holdsNow], ['waiting', []]);
    assert.ok((await done(p, ['pm', 'next'], at(t0))).ready.some((x: any) => x.step === constructor), 'not in force before its time');
    const head = Number(p.ctx.memory.head());
    assert.ok((await done(p, ['read', 'holds'], at(t0 + 2 * 3_600_000))).holds[0].state === 'in-force');
    assert.equal(Number(p.ctx.memory.head()), head, 'a read of holds writes nothing');
    assert.ok((await done(p, ['pm', 'next'], at(t0 + 2 * 3_600_000))).held.some((x: any) => x.step === constructor));
    assert.ok((await done(p, ['pm', 'next'], at(t0 + 4 * 3_600_000))).ready.some((x: any) => x.step === constructor), 'over after its end time');
    const all = await done(p, ['read', 'holds', '--all'], at(t0 + 4 * 3_600_000));
    assert.deepEqual([all.holds[0].state, all.holds[0].note], ['over', 'its end time 2026-11-28 11:00 UTC has passed']);
    assert.equal((await done(p, ['read', 'holds'], at(t0 + 4 * 3_600_000))).holds.length, 0);
  } finally {
    p.cleanup();
  }
});

test('G6: a hold while a named task is not accepted ends when it is accepted, in another mission too', async () => {
  const p = project43();
  try {
    await addMissionToReview(p, 'm1');
    await startAddMission(p.ctx, 'm2');
    const cal = (await readyOf(p.ctx, 'calibrator-1')).step;
    await done(p, ['pm', 'hold', 'add', '--all', '--mission', 'm2', '--after', 'm1/impl', '--reason', 'm2 starts after the add function']);
    const next = await done(p, ['pm', 'next']);
    assert.ok(next.held.some((x: any) => x.step === cal && x.holds[0].after === 'm1/impl'));
    assert.ok(next.ready.some((x: any) => x.kind === 'reviewer'), 'the hold is narrowed to m2');
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    assert.ok((await done(p, ['pm', 'next'])).ready.some((x: any) => x.step === cal), 'impl is accepted: the hold is over');
    const all = await done(p, ['read', 'holds', '--all']);
    assert.deepEqual([all.holds[0].state, all.holds[0].note], ['over', 'task m1/impl is accepted']);
  } finally {
    p.cleanup();
  }
});

test('G6: the Secretary places and releases holds with no words; mp sec next lists a held step with the hold as data; it is told when it lifts the PM\'s hold on the user\'s words', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    const id = await live43(p);
    assert.equal((await mp(p, ['sec', 'hold', 'add', '--all', '--reason', 'x', '--words', 'W-1'], { identity: id })).code, 64, 'a Secretary hold takes no words');
    const h = await done(p, ['sec', 'hold', 'add', '--task', 'impl', '--reason', 'its review of the interface comes first'], { identity: id });
    assert.equal(h.by, 'secretary');
    const next = await done(p, ['sec', 'next'], { identity: id });
    const held = next.held.find((x: any) => x.step === constructor);
    assert.deepEqual(held.holds, [{ id: 'H-1', reason: 'its review of the interface comes first', by: 'secretary', words: null, until: null, after: null }]);
    assert.match(await text(p, ['sec', 'next', '--all'], { identity: id }), /hold H-1 \(the Secretary\): its review of the interface comes first; it waits until it is released by hand \(mp sec hold release H-1\)/);
    const claim = await mp(p, ['sec', 'dispatch', constructor, '--filled-by', 'test/scripted'], { identity: id });
    assert.equal(claim.error?.code, 'NOT_READY');
    assert.match(claim.error.message, /mp sec hold release H-1/);
    assert.equal((await done(p, ['sec', 'hold', 'release', 'H-1'], { identity: id })).released, true);
    // the PM's hold on the user's words: the Secretary's release is recorded, and it is told whose it is
    const w = await userWords(p, 'Do not build it yet.');
    const pmHold = await done(p, ['pm', 'hold', 'add', '--task', 'impl', '--reason', 'the user said so', '--words', w]);
    const lifted = await mp(p, ['sec', 'hold', 'release', pmHold.hold], { identity: id });
    assert.equal(lifted.code, 0);
    assert.match(lifted.result.warnings[0], new RegExp(`placed by the PM on the user's words ${w}: its release is the PM's`));
    // a PM hold without words is recorded, with a warning
    const bare = await done(p, ['pm', 'hold', 'add', '--step', constructor, '--reason', 'later']);
    assert.match(bare.warnings.join('\n'), /no --words/);
  } finally {
    p.cleanup();
  }
});

test('G6: mp sec wait wakes on a change of hold and at a hold\'s time; a hold\'s time not reached does not wake it', async () => {
  const p = project43();
  try {
    await atConstructor(p);
    const id = await live43(p);
    const base = await done(p, ['sec', 'next'], { identity: id });
    const sec = openProcess(p.dir, { secretary: id, observe: () => ENV_A });
    try {
      assert.equal((await secWait(sec, { since: base.revision, timeout: 0 })).timedOut, true);
      const until = Date.now() + 3_600_000;
      await done(p, ['sec', 'hold', 'add', '--all', '--until', new Date(until).toISOString(), '--reason', 'a usage threshold: reset at the hour'], { identity: id });
      assert.equal((await secWait(sec, { since: base.revision, timeout: 0 })).timedOut, false, 'a change of hold wakes it');
      const after = await done(p, ['sec', 'next'], { identity: id });
      assert.equal((await secWait(sec, { since: after.revision, timeout: 0 })).timedOut, true, 'its time is not reached');
      assert.equal(secretaryWakes(sec.memory, after.revision, until + 1), true, 'its time reached wakes it');
      assert.ok(SECRETARY_WAKE.kinds.includes('hold.placed') && SECRETARY_WAKE.kinds.includes('hold.released'));
    } finally {
      sec.memory.close();
    }
    const later = openProcess(p.dir, { secretary: id, observe: () => ENV_A, now: () => Date.now() + 2 * 3_600_000 });
    try {
      const last = await done(p, ['sec', 'next'], { identity: id });
      assert.equal((await secWait(later, { since: last.revision, timeout: 0 })).timedOut, false, 'wait reads the time on its own clock');
    } finally {
      later.memory.close();
    }
  } finally {
    p.cleanup();
  }
});

test('G6: a hold placed again (the same --op, or a run again without one) is the same hold; an interrupted run finishes on its retry', async () => {
  const p = project43();
  try {
    await atConstructor(p);
    const first = await mp(p, ['pm', 'hold', 'add', '--task', 'impl', '--reason', 'later', '--op', 'h1']);
    const replay = await mp(p, ['pm', 'hold', 'add', '--task', 'impl', '--reason', 'later', '--op', 'h1']);
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.hold, first.result.hold);
    const again = await done(p, ['pm', 'hold', 'add', '--task', 'impl', '--reason', 'later']);
    assert.deepEqual([again.hold, again.repeated], ['H-1', true], 'no second hold');
    // the write committed, the action's result not recorded: the retry with the same --op finishes it
    const action = { op: 'h2', command: 'hold add', args: { positionals: ['add'], flags: { step: 'x.y', reason: 'soon' } } };
    assert.equal(beginAction(p.ctx.memory, { ...action, filler: null }), null);
    placeHold(p.ctx, { op: 'h2', subject: { kind: 'step', step: 'x.y' }, reason: 'soon' });
    const retry = await done(p, ['pm', 'hold', 'add', '--step', 'x.y', '--reason', 'soon', '--op', 'h2']);
    assert.equal(retry.hold, 'H-2');
    assert.equal((await done(p, ['read', 'holds'])).holds.length, 2);
  } finally {
    p.cleanup();
  }
});

test('F6 (H-3): with limits in config.json, new Constructor steps are held while one is passed; mp read scratch lists what takes the disk and writes nothing', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    assert.ok((await done(p, ['pm', 'next'])).ready.some((x: any) => x.step === constructor), 'the default sets no limit');
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), limits: { worktrees: 1, freeBytes: 1_000_000 } });
    mkdirSync(join(p.dir, '.mission-pipeline', 'worktrees', 'D-99'), { recursive: true });
    write(join(p.dir, '.mission-pipeline', 'worktrees', 'D-99'), 'big.bin', 'x'.repeat(2048));
    const next = await done(p, ['pm', 'next'], { process: { diskFree: () => 500_000 } });
    const held = next.held.find((x: any) => x.step === constructor);
    assert.equal(held.diskLimit, true);
    assert.match(held.why, /1 worktree\(s\) are on disk, at or above limits.worktrees \(1\); 488\.3 KB is free on the project's disk, below limits.freeBytes \(976\.6 KB\)/);
    assert.equal((await mp(p, ['pm', 'dispatch', constructor], { process: { diskFree: () => 500_000 } })).error?.code, 'NOT_READY');
    const head = Number(p.ctx.memory.head());
    const scratch = await done(p, ['read', 'scratch'], { process: { diskFree: () => 500_000 } });
    assert.equal(Number(p.ctx.memory.head()), head, 'the listing writes nothing');
    const wt = scratch.entries.find((e: any) => e.kind === 'worktree');
    assert.deepEqual([wt.path, wt.bytes, wt.owner], ['.mission-pipeline/worktrees/D-99', 2048, 'no dispatch of this memory names it']);
    assert.equal(scratch.freeBytes, 500_000);
    const listed = await text(p, ['read', 'scratch'], { process: { diskFree: () => 500_000 } });
    assert.match(listed, /Worktrees under \.mission-pipeline\/worktrees \(1, 2\.0 KB\):\n {2}\.mission-pipeline\/worktrees\/D-99: 2\.0 KB, no dispatch of this memory names it, \d+ s old/);
    assert.match(listed, /Shared checkouts under \.mission-pipeline\/tmp\/checkouts \(0, 0 B\): none/);
    assert.match(listed, /Disk limits \(config\.json limits\): worktrees 1, freeBytes 976\.6 KB; a disk limit of config\.json is passed/);
    assert.match(await text(p, ['config']), /Disk limits: worktrees 1, freeBytes 976\.6 KB/);
    // free space again and no folder over the limit: the step is ready
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), limits: { worktrees: 2, freeBytes: 1_000_000 } });
    assert.ok((await done(p, ['pm', 'next'], { process: { diskFree: () => 2_000_000 } })).ready.some((x: any) => x.step === constructor));
    const d = await done(p, ['pm', 'dispatch', constructor, '--filled-by', 'test/scripted'], { process: { diskFree: () => 2_000_000 } });
    const owned = (await done(p, ['read', 'scratch'])).entries.filter((e: any) => e.owner.startsWith(`dispatch ${d.dispatch} `)).map((e: any) => [e.kind, e.owner]);
    assert.deepEqual(owned, [['worktree', `dispatch ${d.dispatch} (constructor, m1), in flight`], ['scratch', `dispatch ${d.dispatch} (constructor, m1), in flight`]]);
  } finally {
    p.cleanup();
  }
});

test('G6: holds live in the log: a rebuild of the state tables (as after a copy of the folder) reads them the same, and the next id follows on', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    await done(p, ['pm', 'hold', 'add', '--task', 'impl', '--reason', 'later']);
    await done(p, ['pm', 'hold', 'add', '--all', '--reason', 'the machine is busy']);
    await done(p, ['pm', 'hold', 'release', 'H-2']);
    const before = (await done(p, ['read', 'holds', '--all'])).holds;
    p.ctx.memory.write({ op: 'rebuild', payload: 1 }, (tx) => rebuildState(tx, p.ctx.memory.extensions));
    assert.deepEqual((await done(p, ['read', 'holds', '--all'])).holds, before);
    assert.ok((await done(p, ['pm', 'next'])).held.some((x: any) => x.step === constructor && x.holds[0].id === 'H-1'));
    assert.equal((await done(p, ['pm', 'hold', 'add', '--step', constructor, '--reason', 'one step'])).hold, 'H-3');
  } finally {
    p.cleanup();
  }
});

test('G6 compatibility: a 4.3 memory has no hold: the ready list, the claim and mp read holds read as 4.3; 4.3 receipts of the commands p5 touched replay', async () => {
  const p = project43();
  try {
    const constructor = await atConstructor(p);
    assert.deepEqual((await done(p, ['read', 'holds'])).holds, []);
    const next = await done(p, ['pm', 'next']);
    assert.ok(next.ready.some((x: any) => x.step === constructor));
    assert.ok(next.held.every((x: any) => x.holds === undefined && x.diskLimit === undefined), 'no new field on a 4.3 memory');
    for (const [command, args, argv] of [['next', { positionals: [], flags: {} }, ['pm', 'next']], ['dispatch', { positionals: [constructor], flags: {} }, ['pm', 'dispatch', constructor]]] as const) {
      const action = { op: `old-${command}`, command, args };
      assert.equal(beginAction(p.ctx.memory, { ...action, filler: null }), null);
      endAction(p.ctx.memory, action, { exitCode: 0, text: `recorded by 4.3 for ${command}`, json: { recorded: command } }, false);
      const r = await mp(p, [...argv, '--op', `old-${command}`]);
      assert.equal(r.code, 0, JSON.stringify(r));
      assert.equal(r.replayed, true);
      assert.deepEqual(r.result, { recorded: command });
    }
  } finally {
    p.cleanup();
  }
});
