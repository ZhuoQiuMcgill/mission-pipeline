// 4.4 (F19): after an upgrade, the flows' replays raise notices about what is already over. A notice
// whose mission is closed, whose detailed plan was superseded, or whose escalation (the decision it
// asks for) is decided is born resolved: recorded, never pending. A notice of 4.3 is not rewritten.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AlertId, ContentHash, MissionId } from '../src/common/ids.ts';
import { commit, ev, flowCtx, noticeAlertId, notify } from '../src/flow/context.ts';
import { PLAN_LINE, SECRETARY_LINE } from '../src/flow/plandoc.ts';
import { raiseAlert, setMission } from '../src/memory/index.ts';
import { listNotices } from '../src/process/notices.ts';
import { processProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;

test('F19: a notice about a closed mission, a superseded plan or a decided escalation is born resolved', async () => {
  const p = processProject();
  try {
    const ctx = flowCtx(p.ctx.ports(), M);
    p.ctx.memory.write({}, (tx) => {setMission(tx, M, 'open');});
    await commit(ctx, 'test:effective', { events: [ev(ctx, PLAN_LINE, 'effective', 'dplan.m1.1.1', { dplan: 'dplan.m1.1.1' }), ev(ctx, PLAN_LINE, 'effective', 'dplan.m1.2.1', { dplan: 'dplan.m1.2.1' }), ev(ctx, SECRETARY_LINE, 'applied', 'E-1', { by: 'pm' })] });
    const tell = (key: string, o: { detail?: unknown; askUser?: true } = {}) => notify(ctx, { category: 'operational-check', wi: null, key, trigger: key, defaultAction: 'nothing', detail: o.detail ?? null, ...(o.askUser ? { askUser: true } : {}) });
    const state = (key: string) => listNotices(p.ctx.memory, p.ctx.memory.data, { includeAcknowledged: true }).find((n) => n.id === noticeAlertId({ mission: M, category: 'operational-check', key }))?.state;
    await tell('old-plan', { detail: { dplan: 'dplan.m1.1.1' } });
    await tell('plan-in-effect', { detail: { dplan: 'dplan.m1.2.1' } });
    await tell('plan-not-yet-in-effect', { detail: { dplan: 'dplan.m1.3.1' } });
    await tell('decided', { detail: { escalation: 'E-1' }, askUser: true });
    await tell('decided-object', { detail: { escalation: { id: 'E-1' } }, askUser: true });
    await tell('open-question', { detail: { escalation: 'E-2' }, askUser: true });
    await tell('informs-about-decided', { detail: { escalation: 'E-1' } });
    assert.deepEqual(['old-plan', 'decided', 'decided-object'].map(state), ['acknowledged', 'acknowledged', 'acknowledged'], '4.3 left them pending');
    assert.deepEqual(['plan-in-effect', 'plan-not-yet-in-effect', 'open-question', 'informs-about-decided'].map(state), ['undelivered', 'undelivered', 'undelivered', 'undelivered']);
    assert.match(readFileSync(join(p.ctx.memory.paths.root, 'missions', M, 'notices.md'), 'utf8'), /Resolved when raised: its plan dplan\.m1\.1\.1 is superseded\./);
    // a closed mission: every notice raised about it is born resolved
    p.ctx.memory.write({}, (tx) => {setMission(tx, M, 'closed');});
    await tell('after-close', { detail: { dplan: 'dplan.m1.2.1' } });
    assert.equal(state('after-close'), 'acknowledged');
    assert.ok(listNotices(p.ctx.memory, p.ctx.memory.data, { includeAcknowledged: true }).some((n) => n.id === noticeAlertId({ mission: M, category: 'operational-check', key: 'after-close' })), 'it stays on the record');
  } finally {
    p.cleanup();
  }
});

test('F19 compatibility: a notice raised before 4.4 about a mission closed later is not rewritten and stays pending', () => {
  const p = processProject();
  try {
    p.ctx.memory.write({}, (tx) => {
      setMission(tx, M, 'open');
      raiseAlert(tx, { alert: 'flow:m1:older:abc' as AlertId, category: 'older', informational: true, body: tx.data.put(JSON.stringify({ mission: 'm1', trigger: 'raised by 4.3' })) as ContentHash });
      setMission(tx, M, 'closed');
    });
    assert.equal(listNotices(p.ctx.memory, p.ctx.memory.data).find((n) => n.id === 'flow:m1:older:abc')?.state, 'undelivered');
  } finally {
    p.cleanup();
  }
});
