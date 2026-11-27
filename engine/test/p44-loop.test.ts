// 4.4 (F8): a loop that says only what is new. `mp sec next` keeps a cursor per Secretary generation,
// reduces what its caller saw before to count lines, and only the pass a caller sees marks notices
// delivered or moves the cursor; `mp sec wait` wakes only on what calls for the Secretary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { cursor, raiseAlert } from '../src/memory/index.ts';
import { listNotices, markNotices } from '../src/process/notices.ts';
import { secCursorName, secWait, SECRETARY_WAKE } from '../src/process/secretary.ts';
import { recordSeatHandBack } from '../src/process/seat.ts';
import { ENV_A, readAll, addMissionToReview, type ProcessProject } from './process-fixtures.ts';
import { project43, done43, live43, secretary43, escalation43 } from './p43-fixtures.ts';
import type { AlertId, ContentHash } from '../src/common/ids.ts';

async function text43(p: ProcessProject, args: string[], identity: string): Promise<string> {
  const r = await runCli(args, {cwd: p.dir, env: {MP_SECRETARY: identity}, process: {observe: () => ENV_A, ident: {name: 'test', email: 'test@test'}}});
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout;
}

/** A Secretary notice: one that names a WI (it calls for an action), or one that only informs. */
function notice(p: ProcessProject, id: string, trigger: string, o: {informs?: boolean} = {}): void {
  p.ctx.memory.write({}, (tx) => {raiseAlert(tx, {alert: id as AlertId, category: 'operational-check', ...(o.informs === true ? {informational: true as const} : {wi: 'WI-20'}), body: tx.data.put(JSON.stringify({mission: 'm1', trigger})) as ContentHash});});
}

const decide = {option: 'accept', classification: 'detail', authorization: null, reason: 'fine', instructions: '', grantExtra: 0, notice: '', mayMatter: false};

test('F8: an item that arrives between two passes is printed in full once, then counted; --all and --since print it again', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    const first = await done43(p, ['sec','next'], id);
    assert.equal(first.since, null, 'the first pass of a generation prints everything');
    const q = await done43(p, ['sec','ask-pm','which port does the service use?'], id);
    await done43(p, ['pm','reply',q.id,'port 8080']);
    notice(p, 'n-check', 'the nightly check needs a look');
    const second = await done43(p, ['sec','next'], id);
    assert.deepEqual(second.replies.map((r: any) => r.id), [q.id]);
    assert.ok(second.notices.some((n: any) => n.id === 'n-check'));
    assert.equal(cursor(p.ctx.memory, secCursorName(id))?.rev, second.revision);
    const third = await text43(p, ['sec','next'], id);
    assert.doesNotMatch(third, /port 8080/, '4.3 printed every PM reply again');
    assert.doesNotMatch(third, /nightly check/, '4.3 printed every delivered notice again');
    assert.match(third, /Seen before \(up to rev \d+; mp sec next --all prints them\): 1 earlier notice\(s\) still open \(mp sec alerts\); 1 earlier PM reply/);
    const counted = await done43(p, ['sec','next'], id);
    assert.deepEqual([counted.replies.length, counted.earlier.replies, counted.earlier.notices], [0, 1, 1]);
    assert.ok(!counted.notices.some((n: any) => n.id === 'n-check'));
    const all = await text43(p, ['sec','next','--all'], id);
    assert.match(all, /port 8080/); assert.match(all, /nightly check/);
    const since = await done43(p, ['sec','next','--since',String(first.revision)], id);
    assert.deepEqual(since.replies.map((r: any) => r.id), [q.id]);
    assert.ok(since.notices.some((n: any) => n.id === 'n-check'));
    assert.equal((await done43(p, ['sec','next'], id)).replies.length, 0);
  } finally {p.cleanup();}
});

test('F8: the passes inside mp sec wait reconcile and leave the cursor and the delivered marks alone', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    const first = await done43(p, ['sec','next'], id);
    notice(p, 'n-wait', 'a run needs a look');
    const sec = secretary43(p, id);
    try {
      const r = await secWait(sec, {since: first.revision, timeout: 0.05, pollMs: 5, periodicMs: 10});
      assert.equal(r.timedOut, false);
    } finally {sec.memory.close();}
    assert.equal(listNotices(p.ctx.memory, p.ctx.memory.data, {audience: 'secretary'}).find((n) => n.id === 'n-wait')?.state, 'undelivered', '4.3 marked it delivered in the pass inside wait');
    assert.equal(cursor(p.ctx.memory, secCursorName(id))?.rev, first.revision);
    const next = await done43(p, ['sec','next'], id);
    assert.equal(next.notices.find((n: any) => n.id === 'n-wait')?.state, 'undelivered');
  } finally {p.cleanup();}
});

test('F8: wait does not wake on a seat’s claim, read or refused hand-back, or a notice that only informs; a hand-back wakes it', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const base = await done43(p, ['sec','next'], id);
    const sec = secretary43(p, id);
    try {
      const d = await done43(p, ['sec','card','choice'], id);
      readAll(sec, d.dispatch);
      assert.equal((await recordSeatHandBack(sec, d.dispatch, {report: 'done', fields: {...decide, option: 'no-such-option'}, advance: false})).kind, 'refused');
      notice(p, 'n-info', 'an informational line', {informs: true});
      assert.equal((await secWait(sec, {since: base.revision, timeout: 0})).timedOut, true, '4.3 woke on every record');
      assert.equal((await recordSeatHandBack(sec, d.dispatch, {report: 'done', fields: decide, advance: false})).kind, 'recorded');
      assert.equal((await secWait(sec, {since: base.revision, timeout: 0})).timedOut, false);
    } finally {sec.memory.close();}
    assert.ok(SECRETARY_WAKE.kinds.includes('dispatch.handback') && !SECRETARY_WAKE.kinds.includes('dispatch.claimed'));
  } finally {p.cleanup();}
});

test('F8: a notice that only informs is delivered once and needs no acknowledgement; mp sec alerts --all still lists it', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    await done43(p, ['sec','next'], id);
    notice(p, 'n-info', 'the environment changed', {informs: true});
    notice(p, 'n-act', 'a check failed');
    assert.ok((await done43(p, ['sec','next'], id)).notices.some((n: any) => n.id === 'n-info'));
    const later = await done43(p, ['sec','next'], id);
    assert.ok(!later.notices.some((n: any) => n.id === 'n-info'));
    assert.equal(later.earlier.notices, 1, 'only the notice that calls for an action is counted');
    const alerts = (await done43(p, ['sec','alerts'], id)).notices.map((n: any) => n.id);
    assert.ok(!alerts.includes('n-info') && alerts.includes('n-act'));
    assert.ok((await done43(p, ['sec','alerts','--all'], id)).notices.some((n: any) => n.id === 'n-info'));
    assert.ok((await done43(p, ['sec','next','--all'], id)).notices.some((n: any) => n.id === 'n-info'));
  } finally {p.cleanup();}
});

test('F8 compatibility: a 4.3 memory has no cursor; the first pass of each generation prints everything as 4.3 did', async () => {
  const p = project43();
  try {
    notice(p, 'n-old', 'raised and delivered under 4.3');
    markNotices(p.ctx.memory, ['n-old'], 'delivered');
    const id = await live43(p);
    const first = await done43(p, ['sec','next'], id);
    assert.ok(first.notices.some((n: any) => n.id === 'n-old' && n.state === 'delivered'));
    assert.equal((await done43(p, ['sec','next'], id)).earlier.notices, 1);
    const g = await done43(p, ['pm','secretary','start','--replace']);
    await done43(p, ['sec','session','--filled-by','harness/secretary'], g.generation);
    assert.ok((await done43(p, ['sec','next'], g.generation)).notices.some((n: any) => n.id === 'n-old'), 'a new generation sees the open notices once');
  } finally {p.cleanup();}
});

test('F8: the queued steps of a closed mission are one count line', async () => {
  const p = project43();
  try {
    await addMissionToReview(p, 'm1');
    const id = await live43(p);
    const words = await done43(p, ['pm','say','Stop this mission for now','--tag','instruction']);
    await done43(p, ['pm','close','m1','--words',words.words]);
    assert.ok((await done43(p, ['sec','next'], id)).held.some((h: any) => h.closedMission === true));
    const next = await done43(p, ['sec','next'], id);
    assert.ok(!next.held.some((h: any) => h.closedMission === true));
    assert.ok(next.earlier.closedMissionSteps >= 1);
    assert.match(await text43(p, ['sec','next'], id), /queued step\(s\) of closed missions held/);
    assert.ok((await done43(p, ['sec','next','--all'], id)).held.some((h: any) => h.closedMission === true));
  } finally {p.cleanup();}
});
