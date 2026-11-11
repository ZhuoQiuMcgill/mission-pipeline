// Local fix (pinned 4.3.0 clone, branch local/run-fixes): mechanical rule 4 (integration) leaves out an
// implementation task that itself depends on the integration task. A later plan's work that builds on the
// integrated tree cannot be a dependency of the integration task without a cycle; execution's
// taskDependencies already leaves such a task out of the integration's dependencies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MissionId } from '../src/common/ids.ts';
import { mechanicalCheck } from '../src/flow/mechanical.ts';
import { detailedPlan, pmPlan } from '../src/flow/scripted.ts';

const M = 'm1' as MissionId;

function withTask(id: string, dependsOn: string[], dir: string) {
  const base = detailedPlan(M, { extraTask: true });
  const impl = base.tasks.find((t) => t.id === 'impl')!;
  return { ...base, tasks: [...base.tasks, { ...impl, id, goal: `Task ${id}`, writeScope: [`src/${dir}/**`], dependsOn, implements: [] }] };
}

describe('rule 4 (integration) and work on top of the integrated tree', () => {
  it('an implementation task that depends on the integration task is outside rule 4', async () => {
    const plan = withTask('tail', ['docs'], 'tail');
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan, unsettled: new Set(), hasSymbol: async () => true });
    assert.deepEqual(r.failures, []);
  });

  it('a task that depends on it only transitively is outside too', async () => {
    const one = withTask('tail', ['docs'], 'tail');
    const impl = one.tasks.find((t) => t.id === 'impl')!;
    const plan = { ...one, tasks: [...one.tasks, { ...impl, id: 'tail2', goal: 'Task tail2', writeScope: ['src/tail2/**'], dependsOn: ['tail'], implements: [] }] };
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan, unsettled: new Set(), hasSymbol: async () => true });
    assert.deepEqual(r.failures, []);
  });

  it('an implementation task beside the integration task (neither depends on the other) still fails rule 4', async () => {
    const plan = withTask('side', ['iface'], 'side');
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan, unsettled: new Set(), hasSymbol: async () => true });
    assert.deepEqual(r.failures, ['integration: integration task docs does not depend on module task side']);
  });
});
