// Real checkout coverage for the orchestrator (git cannot run in the Constructor sandbox).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { raiseEscalation } from '../src/flow/secretary.ts';
import { pmConstraint, pmDispatch, pmPlan, pmRequirement, pmSay, pmWithdrawRequirement } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import { addDetailedPlan, addPlan, CHECK_JS, handBack, processProject, readAll, readyOf, startAddMission, step, write } from './process-fixtures.ts';

describe('P3: dispatch refresh with real checkout/worktree cards', () => {
  for (const kind of ['constructor', 'reviewer', 'secretary'] as const) it(`${kind} receives decisions and authority current at claim`, async () => {
    const p = processProject();
    try {
      const ctx = p.ctx; const mission = 'refresh';
      const words = await startAddMission(ctx, mission);
      await pmPlan(ctx, { mission, plan: addPlan(mission, words), words: [words], mode: 'fast' });
      await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
      await step(ctx, 'architect-decompose', () => addDetailedPlan(mission));
      await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
      if (kind === 'reviewer') {
        const constructor = pmDispatch(ctx, (await readyOf(ctx, 'constructor')).step);
        readAll(ctx, constructor.dispatch);
        write(join(p.dir, constructor.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
        write(join(p.dir, constructor.worktree!), 'src/check.js', CHECK_JS);
        const result = await handBack(ctx, constructor.dispatch, { done: 'implemented', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
        assert.equal(result.kind, 'recorded');
      }
      if (kind === 'secretary') await raiseEscalation(flowCtx(ctx.ports(), mission as MissionId), { id: 'refresh-question', source: 'constructor-decision', lineage: `task.${mission}.add`, subject: 'task:add', summary: 'Choose the current behavior', reasons: ['Need a decision'], options: ['answer', 'ask-user'] });
      const queued = await readyOf(ctx, kind);
      const late = pmSay(ctx, 'Keep the add operation reversible.').words;
      await pmRequirement(ctx, { mission, item: 'late', type: 'decision', text: 'Keep it reversible', quote: 'Keep the add operation reversible', words: late });
      await pmWithdrawRequirement(ctx, { mission, item: 'a1', reason: 'withdrawn before claim' });
      await pmConstraint(ctx, { mission, constraint: 'instruction', kind: 'instruction', text: 'Explain any behavior change', scope: { paths: ['**'], taskTypes: [] } });
      const d = pmDispatch(ctx, queued.step);
      assert.match(d.card, /Keep it reversible/);
      assert.match(d.card, /Instruction \(context only; not a proof input\)/);
      const v = dispatchView(ctx, d.dispatch);
      const authorizations = (v.card['materials'] as Array<{ id: string; ref: string }> | undefined)?.find((m) => m.id === 'authorizations');
      if (kind === 'secretary') assert.equal(ctx.memory.data.text(authorizations!.ref), '(none)');
      else assert.equal(authorizations, undefined, 'the builder does not render authorization material for this seat');
      if (kind === 'constructor') assert.ok(d.worktree !== null);
      if (kind === 'secretary') assert.deepEqual(v.card['authorizations'], []);
    } finally { p.cleanup(); }
  });
});
