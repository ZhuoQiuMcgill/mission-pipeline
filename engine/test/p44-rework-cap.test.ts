// 4.4 (F12 c, problem P11): the rework cap is a setting, config.json `loops.rework` (default 2, as in 4.3), read
// where the flows read every loop's state; a change applies to the loops not used up yet.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { defaultConfig, parseConfig, writeConfig } from '../src/cli/config.ts';
import { openProject } from '../src/cli/project.ts';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import { drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say, withReworkCap } from './flow-memory-fixtures.ts';
import { project43 } from './p43-fixtures.ts';
import { ENV_A, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const loopEscalations = async (w: World) => (await w.ledger.events<EscalationBody>({ mission: M, line: 'secretary', event: 'escalation' })).map((e) => e.body).filter((e) => e.source === 'loop-exhausted');

async function world(o: { reworkCap?: number } = {}): Promise<{ w: World; engine: FlowEngine }> {
  const w = memoryPorts(o);
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { w, engine: new FlowEngine(w) };
}
/** impl's reviews send back the products `rework` names; every other seat as in a run where all agree. */
function script(rework: (target: string) => boolean, holdTask?: string): Script {
  const base = happyScript(M);
  return (t, s) => {
    if (t.task === holdTask || t.card.seat === 'secretary') return null;
    if (t.card.seat !== 'reviewer') return base(t, s);
    const c = t.card as unknown as ReviewerCard;
    return { handBack: reviewer(c, rework(c.target) ? 'rework' : 'pass', { findings: [`finding at ${c.target}`] }) };
  };
}

let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

describe('4.4 F12 (c): the rework cap is a setting', () => {
  it('config.json loops.rework sets the reworks a loop allows: one with loops.rework 1; two without it, as in 4.3', async () => {
    for (const cap of [1, undefined]) {
      const { w, engine } = await world(cap === undefined ? {} : { reworkCap: cap });
      await drive(engine, w.scheduler, script((x) => x.includes('.impl.')));
      const allowed = cap ?? 2;
      const es = await loopEscalations(w);
      assert.equal(es.length, 1);
      assert.deepEqual([(es[0]!.facts as { allowed: number }).allowed, (es[0]!.facts as { attempt: number }).attempt], [allowed, allowed + 1]);
      assert.ok(w.scheduler.tasks.has(`con.m1.impl.${allowed + 1}`) && !w.scheduler.tasks.has(`con.m1.impl.${allowed + 2}`));
    }
  });

  it('a change of the setting applies to a loop not used up yet; a loop used up stays so', async () => {
    const a = await world({ reworkCap: 1 });
    // one rework of attempt 1: the loop has used its one rework, and is not used up yet
    await drive(a.engine, a.w.scheduler, script((x) => x === 'prod.con.m1.impl.1', 'con.m1.impl.2'));
    assert.ok(a.w.scheduler.tasks.has('con.m1.impl.2'));
    // the project raises it to 2: attempt 2 may be sent back once more
    const raised = withReworkCap(a.w, 2);
    await drive(new FlowEngine(raised), raised.scheduler, script((x) => x.includes('.impl.')));
    assert.ok(a.w.scheduler.tasks.has('con.m1.impl.3') && !a.w.scheduler.tasks.has('con.m1.impl.4'));
    assert.equal(((await loopEscalations(a.w))[0]!.facts as { allowed: number }).allowed, 2);

    const b = await world({ reworkCap: 1 });
    await drive(b.engine, b.w.scheduler, script((x) => x.includes('.impl.')));
    assert.equal((await loopEscalations(b.w)).length, 1);
    const later = withReworkCap(b.w, 3);
    const head = b.w.ledger.head;
    assert.deepEqual((await new FlowEngine(later).reconcile()).flatMap((r) => r.errors), []);
    assert.equal(b.w.ledger.head, head, 'nothing moves');
    assert.ok(!b.w.scheduler.tasks.has('con.m1.impl.3'), 'the used-up loop and its escalation stand');
  });

  it('mp config shows the cap; the context and the flows read it from config.json; absent, 2', async () => {
    p = project43();
    let out = await cli(p.dir, ['config']);
    assert.match(out.out, /Reworks a task's rework loop allows before the Secretary decides: 2 \(loops\.rework not set: the default\)/);
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), loops: { rework: 3 } });
    out = await cli(p.dir, ['config']);
    assert.match(out.out, /Reworks a task's rework loop allows before the Secretary decides: 3 \(loops\.rework\)/);
    const project = await openProject({ cwd: p.dir, env: {}, process: { observe: () => ENV_A } }, { flag: null, decides: false });
    try {
      assert.equal(project.ctx.reworkCap, 3);
      assert.equal((await project.ctx.ports().ledger.loop('task.m1.x', 'rework')).allowed, 3);
      assert.equal((await project.ctx.ports().ledger.loop('task.m1.x', 'mechanical-return')).allowed, 3, 'the other loops keep their caps');
      assert.equal((await project.ctx.ports().ledger.loop('task.m1.x', 'feasibility-return')).allowed, 1);
    } finally {
      project.close();
    }
    assert.throws(() => parseConfig({ ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), loops: { rework: -1 } }), /loops\.rework/);
    assert.equal(parseConfig(defaultConfig({ targetBranch: 'main', versionCommands: [] })).loops, undefined, 'a 4.3 config has none');
  });
});
