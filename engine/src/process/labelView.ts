// The delivery's view of the stored labels (A4's LabelView over A2's reads; design 4.1 §4.1,
// §6.7): the labels' revision, whether they are recomputing (also inside the delivery's
// authorization write), each target's stored label, and the runs its deciding judgments rest on
// after renewals. Opened afresh for every delivery step that asks (DeliverDeps.labels as a factory).

import type { EvidenceId, Revision } from '../common/ids.ts';
import { decidingViews, labelStatus, readLabels, type Label } from '../evaluator/index.ts';
import type { LabelView } from '../delivery/memoryView.ts';
import type { DeliveryTarget } from '../delivery/proofView.ts';
import type { Db } from '../memory/index.ts';
import type { ProcessContext } from './context.ts';

export function labelView(ctx: ProcessContext): LabelView {
  // a decision that reads labels: the environment identity is observed first (§6.5)
  ctx.environment();
  const status = ctx.memory.read((db) => labelStatus(db));
  const labels = new Map<string, Label>();
  const runs = new Map<string, ReadonlyArray<{ readonly evidence: EvidenceId; readonly fields: Readonly<Record<string, string>> | null }>>();
  return {
    revision: status.revision as Revision,
    recomputing: status.recomputing,
    recomputingIn(db: Db): boolean {
      return labelStatus(db).recomputing;
    },
    labelOf(target: DeliveryTarget): Label {
      let l = labels.get(target.id);
      if (l === undefined) {
        l = ctx.memory.read((db) => readLabels(db, [target.id]).states[target.id]?.label ?? 'unaccepted');
        labels.set(target.id, l);
      }
      return l;
    },
    decidingRuns(target: DeliveryTarget) {
      let r = runs.get(target.id);
      if (r === undefined) {
        const view = ctx.memory.read((db) => decidingViews(db, [target.id]).views.get(target.id) ?? null);
        r = (view?.deciding ?? []).flatMap((j) => j.evidence.map((e) => ({ evidence: e.effective, fields: e.record?.fields ?? null })));
        runs.set(target.id, r);
      }
      return r;
    },
  };
}
