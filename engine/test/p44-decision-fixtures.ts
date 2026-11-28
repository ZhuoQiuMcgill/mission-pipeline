// 4.4 fixtures for the decision and inbox tests (F9, G2, F16): a mission whose Constructor hands back
// with questions, so a constructor-decision escalation waits on a real task of the plan in effect.
import { join } from 'node:path';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { pmDispatch, pmRequirement, pmSay } from '../src/process/pm.ts';
import { secNext } from '../src/process/secretary.ts';
import { CHECK_JS, addDetailedPlan, handBack, readyOf, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';
import { done43, live43, secretary43 } from './p43-fixtures.ts';

/** The add mission to its Constructor's hand-back with `questions`; a decision item and an instruction are recorded first. */
export async function constructorAsks(p: ProcessProject, questions: readonly string[]): Promise<void> {
  const ctx = p.ctx;
  await startAddMission(ctx, 'm1');
  const w = pmSay(ctx, 'Return a number from add, never a string.').words;
  await pmRequirement(ctx, { mission: 'm1', item: 'd1', type: 'decision', text: 'add returns a number, never a string', quote: 'Return a number from add, never a string.', words: w });
  await done43(p, ['pm', 'constraint', 'add', 'm1', 'small', '--kind', 'instruction', '--text', 'Keep every commit small and focused', '--paths', '**']);
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(ctx, 'architect-decompose', () => addDetailedPlan('m1'));
  await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
  const s = await readyOf(ctx, 'constructor');
  const d = pmDispatch(ctx, s.step);
  const wt = join(p.dir, d.worktree!);
  write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
  write(wt, 'src/check.js', CHECK_JS);
  const a = await handBack(ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [...questions] });
  if (a.kind !== 'recorded') throw new Error(JSON.stringify(a));
}

/** The live Secretary and the escalation its next pass offers. */
export async function liveWithEscalation(p: ProcessProject): Promise<{ id: string; escalation: string }> {
  const id = await live43(p);
  const ctx = secretary43(p, id);
  try {
    const next = await secNext(ctx);
    const secStep = next.ready.find((r) => r.kind === 'secretary');
    if (secStep === undefined) throw new Error(`no Secretary step ready: ${JSON.stringify(next.ready)}`);
    return { id, escalation: secStep.step.slice('sec.'.length) };
  } finally { ctx.memory.close(); }
}
