// Each resident-only assertion exercises a surface absent in 4.2. Regression assertions
// name the 4.2 behaviour they replace (global identity, inline recovery, hidden notices).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { appendRecords, cursor, flowEvents } from '../src/memory/index.ts';
import { liveSecretary, generations } from '../src/memory/resident.ts';
import { pmNext, pmDispatch, pmRelease, pmStop } from '../src/process/pm.ts';
import { secNext, secWait, pmNote, pmQuestion, unconfirmedSeats } from '../src/process/secretary.ts';
import { listNotices } from '../src/process/notices.ts';
import { noticeAudience, PM_NOTICE_ACTIONS } from '../src/process/noticeAudience.ts';
import { recordSeatHandBack, dispatchView } from '../src/process/seat.ts';
import { readAll } from './process-fixtures.ts';
import { startAddMission, step, addPlan, addMissionToReview, reviewerPass } from './process-fixtures.ts';
import { cal1Fail } from '../src/flow/scripted.ts';
import { pmPlan, pmSay } from '../src/process/pm.ts';
import { channel, pmInbox } from '../src/process/secretary.ts';
import { taggedWords } from '../src/memory/words.ts';
import { project43, command43, done43, live43, secretary43, escalation43 } from './p43-fixtures.ts';
import type { MissionId, ContentHash } from '../src/common/ids.ts';

test('B.6/A.2 pending → live; replacement fences old commands and writes; pending leaves 4.2 loop working', async () => {
  const p = project43();
  try {
    const pending = await done43(p, ['pm','secretary','start','--op','start-one']);
    assert.equal((await done43(p, ['read','secretary'])).current.state, 'pending');
    assert.equal((await command43(p, ['pm','next'])).code, 0);
    const again = await done43(p, ['pm','secretary','start']);
    assert.equal(generations(p.ctx.memory)[0]?.state, 'retired');
    assert.equal((await command43(p, ['sec','session'], pending.generation)).error.code, 'NOT_ALLOWED');
    await done43(p, ['sec','session','--filled-by','any/model'], again.generation);
    assert.match((await done43(p, ['sec','handbook'], again.generation)).path, /secretary\/SECRETARY\.md$/);
    for (const name of ['next','dispatch','release','drain','renew','alerts']) assert.equal((await command43(p, ['pm',name])).error.code, 'NOT_ALLOWED', name);
    const old = secretary43(p, again.generation);
    try {
      assert.equal((await command43(p, ['pm','secretary','start'])).error.code, 'NOT_ALLOWED');
      await done43(p, ['pm','secretary','start','--replace']);
      assert.throws(() => old.memory.write({}, (tx) => tx.append({kind: 'pm.question', id: 'bad', text: 'stale'})), /live Secretary/);
      assert.equal((await command43(p, ['sec','handbook'], again.generation)).error.code, 'NOT_ALLOWED');
    } finally {old.memory.close();}
    assert.equal(liveSecretary(p.ctx.memory), null);
    assert.equal((await command43(p, ['pm','next'])).code, 0);
    assert.equal((await command43(p, ['sec','next','--as','S-1'])).error.code, 'USAGE');
  } finally {p.cleanup();}
});

test('resident plan submission queues no seat inline; returned-plan PM notice resolves only by the named PM action', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    const words = await startAddMission(p.ctx, 'm1');
    assert.equal(p.ctx.memory.stmt('SELECT 1 FROM tasks').get(), undefined, '4.2 submitted the Calibrator inline');
    const ctx = secretary43(p, id);
    try {
      await step(ctx, 'calibrator-1', (c) => cal1Fail(c, 'e1', 'ask-user'));
      await secNext(ctx);
      const item = (await done43(p, ['pm','inbox'])).items.find((i: any) => i.action.includes('revise the PM plan'));
      assert.ok(item);
      assert.equal((await command43(p, ['pm','inbox','--ack',item.id])).error.code, 'NOT_ALLOWED');
      await done43(p, ['pm','inbox','--asked-user',item.id]);
      assert.equal((await done43(p, ['pm','inbox'])).items.find((i: any) => i.id === item.id).state, 'waits on the user');
      const newWords = pmSay(p.ctx, 'Use the simpler add function.').words;
      const plan = addPlan('m1', words) as any; plan.elements[0].text = 'The simpler add function with a check';
      await pmPlan(p.ctx, {mission: 'm1', plan, words: [words,newWords]});
      assert.equal((await done43(p, ['pm','inbox'])).items.some((i: any) => i.id === item.id), false);
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});

test('one environment identity across PM commands, reads, attribution and separate asked cursors', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','session','--filled-by','harness/pm']);
    const id = await live43(p);
    assert.equal((await command43(p, ['pm','say','not the user'], id)).error.code, 'NOT_ALLOWED');
    assert.equal((await command43(p, ['sec','next'])).error.code, 'NOT_ALLOWED');
    await done43(p, ['sec','alerts','--op','sec-alerts'], id);
    const rec = p.ctx.memory.stmt("SELECT record FROM log WHERE kind = 'op.receipt' AND json_extract(record,'$.op') = 'pm:sec-alerts'").get() as {record: string};
    assert.equal(JSON.parse(rec.record).filler.model, 'secretary');
    await done43(p, ['pm','say','the PM still owns its attribution','--op','pm-say']);
    const pm = p.ctx.memory.stmt("SELECT record FROM log WHERE kind = 'op.receipt' AND json_extract(record,'$.op') = 'pm:pm-say'").get() as {record: string};
    assert.equal(JSON.parse(pm.record).filler.model, 'pm');
    await done43(p, ['read','status'], id);
    assert.equal(cursor(p.ctx.memory, 'asked'), null, '4.2 advanced the shared PM cursor');
    assert.ok(cursor(p.ctx.memory, 'asked.sec'));
    await done43(p, ['read','status']);
    assert.ok(cursor(p.ctx.memory, 'asked'));
    assert.equal((await command43(p, ['read','status'], 'S-999')).error.code, 'NOT_ALLOWED');
  } finally {p.cleanup();}
});

test('resident PM commands defer reconciliation; reads are pure apart from their own cursor', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    await done43(p, ['pm','mission','open','m1']);
    const before = Number(p.ctx.memory.head());
    await done43(p, ['pm','say','Build something','--tag','instruction']);
    assert.ok(Number(p.ctx.memory.head()) > before);
    const operational = () => p.ctx.memory.stmt("SELECT COUNT(*) AS n FROM log WHERE kind IN ('task.queued','env.snapshot')").get();
    const count = operational();
    for (const args of [['read','status','--no-mark'], ['read','blocked'], ['read','secretary']]) await done43(p, args);
    assert.deepEqual(operational(), count);
    const sec = secretary43(p, id);
    try {const r = await secWait(sec, {since: before, timeout: 0}); assert.equal(r.timedOut, false);} finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('channel: notes, questions, replies, inbox acknowledgments and every exchange wakes wait', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    const first = await done43(p, ['sec','next'], id);
    const sec = secretary43(p, id);
    try {
      const timed = await secWait(sec, {since: first.revision, timeout: 0.03, pollMs: 5});
      assert.equal(timed.timedOut, true);
      let settled = false;
      const waiting = secWait(sec, {since: Number(sec.memory.head()), timeout: 1, pollMs: 5}).then((r) => {settled = true; return r;});
      await new Promise((r) => setTimeout(r, 20)); assert.equal(settled, false);
      const n = await done43(p, ['pm','note','new instruction','--op','n']);
      assert.equal((await waiting).timedOut, false);
      assert.equal((await done43(p, ['sec','next'], id)).notes[0].id, n.id);
      await done43(p, ['sec','ack-note',n.id], id);
      assert.equal((await done43(p, ['sec','next'], id)).notes.length, 0);
      const q = await done43(p, ['pm','ask-secretary','what is running?']);
      assert.equal((await done43(p, ['pm','inbox'])).items.find((i: any) => i.id === q.id).state, 'open');
      assert.equal((await done43(p, ['sec','next'], id)).questions[0].id, q.id);
      await done43(p, ['sec','reply',q.id,'all details are in memory','--op','reply'], id);
      assert.equal((await done43(p, ['pm','inbox'])).items.find((i: any) => i.id === q.id).state, 'answered');
      await done43(p, ['pm','inbox','--ack',q.id]);
      assert.equal((await done43(p, ['pm','inbox'])).items.length, 0);
      assert.equal((await command43(p, ['sec','reply',q.id,'all details are in memory','--op','reply'], id)).replayed, true);
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('adopted 4.2 dispatches; abandoned seats remain unconfirmed under stops; fallback restores PM release', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const d = pmDispatch(p.ctx, (await pmNext(p.ctx)).ready[0]!.step);
    const id = await live43(p);
    assert.ok((await done43(p, ['sec','next'], id)).inFlight.some((f: any) => f.dispatch === d.dispatch));
    await done43(p, ['sec','release',d.dispatch,'--abandoned'], id);
    await done43(p, ['pm','stop','stop all','--scope','all']);
    assert.ok(unconfirmedSeats(p.ctx.memory).some((f) => f.dispatch === d.dispatch), '4.2 stop counts ignored abandoned seats');
    const next = await done43(p, ['sec','next'], id);
    assert.ok(next.unconfirmed.length > 0);
    const status = await done43(p, ['read','status','--no-mark']);
    assert.ok(status.unconfirmed.length > 0);
    assert.match((await done43(p, ['pm','session','--filled-by','h/pm'])).layer1, /unconfirmed seat/);
    assert.equal((await command43(p, ['pm','release',d.dispatch,'--ended'])).error.code, 'NOT_ALLOWED');
    assert.equal((await command43(p, ['pm','secretary','stop'])).error.code, 'NOT_ALLOWED');
    const stopped = await done43(p, ['pm','secretary','stop','--gone']);
    assert.match(stopped.stopHint, /by name/);
    await done43(p, ['pm','release',d.dispatch,'--ended']);
    assert.equal(unconfirmedSeats(p.ctx.memory).length, 0);
  } finally {p.cleanup();}
});

test('notice audiences use one table; pending paging cannot hide a notice behind >500 acknowledged records', async () => {
  const p = project43();
  try {
    p.ctx.memory.write({}, (tx) => {
      for (let i = 0; i < 550; i++) {
        tx.append({kind: 'alert', alert: `a${i}` as never, category: i === 0 ? 'plan-revision-restarts-work' : 'operational', body: tx.data.put(JSON.stringify({mission: 'm1', trigger: `notice ${i}`})) as ContentHash});
        if (i !== 0) tx.append({kind: 'notice.delivery', notice: `a${i}`, state: 'acknowledged'});
      }
    });
    assert.deepEqual(listNotices(p.ctx.memory, p.ctx.memory.data, {limit: 1}).map((n) => n.id), ['a0'], '4.2 limited before filtering');
    assert.equal((await done43(p, ['pm','inbox'])).items[0].id, 'a0');
    for (const category of Object.keys(PM_NOTICE_ACTIONS)) assert.equal(noticeAudience(category, {direction: true}), 'pm', category);
    assert.equal(noticeAudience('unknown-future-category'), 'secretary');
    const id = await live43(p);
    assert.equal((await done43(p, ['sec','next'], id)).notices.length, 0);
    await done43(p, ['pm','inbox','--ack','a0']);
    assert.equal((await done43(p, ['pm','inbox'])).items.length, 0);
  } finally {p.cleanup();}
});

test('A.3 a moved resident project is read without move recovery; the Secretary performs recovery on its next command', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    p.ctx.memory.connection.prepare("UPDATE meta SET value = ? WHERE key = 'project_path'").run('/an/earlier/project/path');
    const before = Number(p.ctx.memory.head());
    await done43(p, ['read','status','--no-mark']);
    assert.equal(Number(p.ctx.memory.head()), before, '4.2 openProject performed move recovery even for a read');
    assert.equal(p.ctx.memory.getMeta('project_path'), '/an/earlier/project/path');
    await done43(p, ['sec','next'], id);
    assert.equal(p.ctx.memory.getMeta('project_path'), p.dir);
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'memory.moved' AND rev > ?").get(before));
  } finally {p.cleanup();}
});

test('mixed 4.2 words and every new record kind rebuild with no migration and no rewritten log facts', async () => {
  const p = project43();
  try {
    const old = await done43(p, ['pm','say','older untyped words']);
    const raw = p.ctx.memory.stmt("SELECT record FROM log WHERE kind = 'user.words'").get() as {record: string};
    const id = await live43(p);
    await done43(p, ['pm','tag',old.words,'--tag','decision']);
    await done43(p, ['pm','summary','The PM summarizes the old decision','--covers',`${old.words}#1`]);
    await done43(p, ['pm','note','a new instruction']);
    const q = await done43(p, ['pm','ask-secretary','details?']);
    await done43(p, ['sec','reply',q.id,'the details'], id);
    await done43(p, ['pm','stop','stop all','--scope','all','--words',old.words]);
    const snapshot = () => ({generation: liveSecretary(p.ctx.memory), channel: channel(p.ctx), inbox: pmInbox(p.ctx), words: taggedWords(p.ctx.memory, p.ctx.memory.data)});
    const before = snapshot();
    const tail = p.ctx.memory.stmt('SELECT hash FROM log ORDER BY rev DESC LIMIT 1').get();
    p.ctx.memory.rebuild();
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(p.ctx.memory.stmt('SELECT hash FROM log ORDER BY rev DESC LIMIT 1').get(), tail);
    assert.equal((p.ctx.memory.stmt("SELECT record FROM log WHERE kind = 'user.words'").get() as {record: string}).record, raw.record);
    for (const kind of ['secretary.generation','pm.note','pm.question','sec.reply','user.words-tags','words.summary']) assert.ok(p.ctx.memory.stmt('SELECT 1 FROM log WHERE kind = ?').get(kind), kind);
  } finally {p.cleanup();}
});

test('mission completion belongs to the PM inbox until delivery consent takes effect or the user closes', async () => {
  const p = project43();
  try {
    await addMissionToReview(p, 'm1');
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    await live43(p);
    const item = (await done43(p, ['pm','inbox'])).items.find((i: any) => i.id.startsWith('mission-end:m1:'));
    assert.ok(item); assert.match(item.action, /ask consent to deliver/);
    assert.equal((await command43(p, ['pm','inbox','--ack',item.id])).error.code, 'NOT_ALLOWED');
    const words = await done43(p, ['pm','say','Close this stage','--tag','instruction']);
    await done43(p, ['pm','close','m1','--words',words.words]);
    assert.equal((await done43(p, ['pm','inbox'])).items.some((i: any) => i.id === item.id), false);
  } finally {p.cleanup();}
});
