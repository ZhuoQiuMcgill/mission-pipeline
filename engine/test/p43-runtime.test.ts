import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { MissionId } from '../src/common/ids.ts';
import { appendRecords } from '../src/memory/index.ts';
import { openProcess } from '../src/process/context.ts';
import { runOnCommit } from '../src/process/runs.ts';
import { secNext, secWait, stopSecretary } from '../src/process/secretary.ts';
import { processStart } from '../src/process/detached.ts';
import { project43, done43, live43, secretary43, escalation43 } from './p43-fixtures.ts';
import { recordSeatHandBack } from '../src/process/seat.ts';
import { readAll } from './process-fixtures.ts';
import { ENV_A } from './process-fixtures.ts';

test('B.1 an admitted run group records its result after replacement; a retired generation cannot admit another', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    let calls = 0;
    const ctx = openProcess(p.dir, {secretary: id, observe: () => ENV_A, runner: async () => {
      calls++;
      await done43(p, ['pm','secretary','start','--replace']);
      return {exitCode: 0, signal: null, error: null, timedOut: false, output: Buffer.from('the admitted result'), durationMs: 1};
    }});
    try {
      const req = {mission: 'm1', commit: p.git('rev-parse','HEAD'), commands: [{id: 'local', command: 'echo test'}], purpose: 'local verification', declaration: {by: 'mp' as const, checkout: 'clean' as const, declared: true}};
      const run = await runOnCommit(ctx, req);
      assert.equal(run.runs[0]?.passed, true);
      assert.ok(ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'evidence' AND json_extract(record,'$.evidence') = ?").get(run.runs[0]!.evidence));
      await assert.rejects(() => runOnCommit(ctx, req), /live Secretary/);
      assert.equal(calls, 1);
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});

test('wait --since wakes on hand-back, ready work, notice, PM decision, note, question, reply and stop', async () => {
  const p = project43();
  try {
    const id = await live43(p), ctx = secretary43(p, id);
    try {
      await escalation43(p, 'runtime-answer');
      await escalation43(p, 'runtime-handback');
      for (const kind of ['ready','notice','pm-answer','note','question','reply','hand-back','stop']) {
        const baseline = await secNext(ctx);
        const pending = secWait(ctx, {since: baseline.revision, timeout: 1, pollMs: 5, periodicMs: 30});
        await new Promise((r) => setTimeout(r, 12));
        if (kind === 'note') await done43(p, ['pm','note','new instruction']);
        else if (kind === 'question') await done43(p, ['pm','ask-secretary','progress?']);
        else if (kind === 'reply') {const q = await done43(p, ['pm','ask-secretary','details?']); await done43(p, ['sec','reply',q.id,'details'], id);}
        else if (kind === 'stop') await done43(p, ['pm','stop','stop all','--scope','all']);
        else if (kind === 'ready') await escalation43(p, 'runtime-ready');
        else if (kind === 'pm-answer') await done43(p, ['pm','answer','m1','runtime-answer','--by','pm','--no-words','--reason','minor; choose the default','--option','accept']);
        else if (kind === 'hand-back') {const d = await done43(p, ['sec','card','runtime-handback'], id); readAll(ctx, d.dispatch); await recordSeatHandBack(ctx, d.dispatch, {report: 'done', fields: {option: 'accept', classification: 'detail', authorization: null, reason: 'fine', instructions: '', grantExtra: 0, notice: '', mayMatter: false}, advance: false});}
        else ctx.memory.write({}, (tx) => {
          if (kind === 'notice') tx.append({kind: 'alert', alert: 'runtime-notice' as never, category: 'operational', body: tx.data.put('{"trigger":"new notice"}')});
        });
        assert.equal((await pending).timedOut, false, kind);

      }
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});

test('periodic wait detects an admitted detached worker disappearing without any new log event', async () => {
  const p = project43();
  const worker = spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  try {
    assert.ok(worker.pid);
    await escalation43(p); const id = await live43(p);
    const d = await done43(p, ['sec','card','choice'], id);
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [{kind: 'flow.event', mission: 'm1' as MissionId, line: `dispatch:${d.dispatch}`, event: 'detached', key: 'lost-run', body: tx.data.put(JSON.stringify({run: 'lost-run', evidence: 'ev-lost', command: 'local', dispatch: d.dispatch, task: d.step, pid: worker.pid, start: processStart(worker.pid!), host: hostname(), startedAt: Date.now()}))}]));
    const ctx = secretary43(p, id);
    try {
      const before = await secNext(ctx);
      const waiting = secWait(ctx, {since: before.revision, timeout: 2, pollMs: 5, periodicMs: 20});
      await new Promise((r) => setTimeout(r, 30)); worker.kill('SIGTERM');
      assert.equal((await waiting).timedOut, false);
      assert.ok(ctx.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'detached-end' AND key = 'lost-run'").get());
    } finally {ctx.memory.close();}
  } finally {worker.kill('SIGKILL'); p.cleanup();}
});

test('fallback after grace prints the recorded harness handle and returns to the 4.2 driver', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    await done43(p, ['pm','secretary','handle',id,'handle-123']);
    await done43(p, ['pm','stop','stop all','--scope','all']);
    const ctx = openProcess(p.dir, {observe: () => ENV_A, now: () => Date.now() + 61_000});
    try {const r = stopSecretary(ctx, {op: 'grace'}); assert.match(r.stopHint, /claude stop 'handle-123'/);} finally {ctx.memory.close();}
    assert.equal((await done43(p, ['pm','next'])).errors.length, 0);
  } finally {p.cleanup();}
});
