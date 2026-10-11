// The exits of an exploration, asserted on the real process (the reopened-exploration fix and code
// review round 9): every state ends in exactly one of a current settle, an open escalation with a
// way forward, or a step that is ready or in flight; and nothing waits on an escalation the flow
// will never carry out.

import assert from 'node:assert/strict';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { pendingTasks, type XState } from '../src/flow/exploration/machine.ts';
import { decisionFor, openEscalations, type EscalationBody } from '../src/flow/secretary.ts';
import { labelStatus, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { pmDrain, pmNext, readSteps } from '../src/process/index.ts';
import type { ProcessProject } from './process-fixtures.ts';

/**
 * After the flow took every step it can (`mp pm next`):
 * - every open escalation of the exploration (its flow's xp.* and fail.*, and the decision layer's
 *   routing explore.*) has a way forward (its Secretary step ready or in flight, a wait on the user,
 *   or a decision to carry out) and offers the user a decision the flow carries out (never only
 *   "ask-user"), and so does every escalation ever raised on it;
 * - a stopped exploration has exactly one of a current settle or an open escalation of its flow;
 * - a routing escalation is open only while a settle is current (it routes that settle);
 * - a running exploration has no current settle, and a step ready or in flight, or an open escalation.
 */
export async function assertExits(p: ProcessProject, m: string, x: string, tag: string): Promise<XState> {
  await pmNext(p.ctx);
  const ports = p.ctx.ports();
  const s = await explorationState(ports, m as MissionId, x);
  const ctx = flowCtx(ports, m as MissionId);
  const all = await openEscalations(ctx, `exploration:${x}`);
  const flow = all.filter((e) => !e.id.startsWith('explore.'));
  const routing = all.filter((e) => e.id.startsWith('explore.'));
  const steps = readSteps(p.ctx);
  const moving = (task: string): boolean => steps.ready.some((r) => r.step === task) || steps.inFlight.some((d) => d.step === task);
  const what = JSON.stringify({ stopped: s.stopped?.reason ?? null, settled: s.settled?.key ?? null, settles: s.settles.length, flow: flow.map((e) => e.id), routing: routing.map((e) => e.id), pending: pendingTasks(s).map((q) => q.task), turn: s.turn });
  for (const e of all) {
    const forward = moving(e.task) || steps.waitingOnUser.some((w) => w.escalation === e.id) || (await decisionFor(ctx, e.id)) !== null;
    assert.ok(forward, `${tag}: escalation ${e.id} has no way forward: ${what}`);
  }
  assertUserOptions(p, m, x, tag);
  if (s.stopped !== null) assert.ok((s.settled !== null) !== (flow.length > 0), `${tag}: a stopped exploration has exactly one of a current settle or an open escalation of its flow: ${what}`);
  else {
    assert.equal(s.settled, null, `${tag}: a running exploration has no current settle: ${what}`);
    assert.ok(pendingTasks(s).some((q) => moving(q.task)) || flow.length > 0, `${tag}: a running exploration has a step ready or in flight, or an open escalation: ${what}`);
  }
  assert.ok(routing.length === 0 || s.settled !== null, `${tag}: a routing escalation is open only while a settle is current: ${what}`);
  return s;
}

/** Every escalation ever raised on the exploration (xp.*, fail.*, explore.*) offers the user at least one decision the flow carries out. */
export function assertUserOptions(p: ProcessProject, m: string, x: string, tag: string): void {
  const rows = p.ctx.memory.read((db) => db.stmt("SELECT key, body FROM flow_events WHERE mission = ? AND line = 'secretary' AND event = 'escalation'").all(m) as Array<{ key: string; body: string }>);
  for (const r of rows) {
    const e = JSON.parse(p.ctx.memory.data.text(r.body)) as EscalationBody;
    if (e.subject !== `exploration:${x}`) continue;
    assert.ok(e.options.some((o) => o !== 'ask-user'), `${tag}: escalation ${e.id} (${e.source}) offers the user no decision: ${JSON.stringify(e.options)}`);
  }
}

// ---------------------------------------------------------------- labels recomputing (code review round 9, class B)

/** Unrelated objects whose review rests on basis line `common`: a later version of it makes a frontier larger than a batch (as stb9-probe). */
export async function seedFanout(p: ProcessProject, m: string, n: number): Promise<void> {
  const ports = p.ctx.ports();
  const c = ports.ledger.content;
  await ports.ledger.append(`seed:basis:${m}`, { records: [{ kind: 'basis.version', basisKind: 'standard', line: `common.${m}`, version: `common.${m}.v1`, mission: m, scope: null } as never] });
  const empty = c.putList([]);
  const common = c.putList([`common.${m}.v1`]);
  const content = c.put('unrelated object');
  for (let b = 0; b < Math.ceil(n / 100); b++) {
    const recs = Array.from({ length: 100 }, (_, i) => {
      const k = b * 100 + i;
      return [
        { kind: 'object.version', object: `bulk.${m}.${k}`, objectKind: 'interpretation', mission: m, module: null, content, prerequisites: empty, scope: { paths: [`bulk/${k}.md`], taskType: 'exploration' }, reviews: [{ review: 'crititor', basisLines: [`common.${m}`], reliesOn: [] }] },
        { kind: 'judgment', judgment: `j.bulk.${m}.${k}`, review: 'crititor', executor: 'crititor', target: `bulk.${m}.${k}`, verdict: 'pass', evidence: empty, bases: common, constraints: empty, reliesOn: empty, issues: [], revokes: null, evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [], extends: null },
      ];
    }).flat();
    await ports.ledger.append(`seed:${m}:${b}`, { records: recs as never });
  }
  pmDrain(p.ctx);
}
/** A basis update larger than a label batch: the labels recompute until drained. */
/** A basis update larger than a label batch (`v`: the version of the fan-out's basis line, 2 for the first update): the labels recompute until drained. */
export async function frontier(p: ProcessProject, m: string, v = 2): Promise<void> {
  setLabelBatchLimit(256);
  await p.ctx.ports().ledger.append(`update:${m}:${v}`, { records: [{ kind: 'basis.version', basisKind: 'standard', line: `common.${m}`, version: `common.${m}.v${v}`, mission: m, scope: null } as never] });
  assert.equal(p.ctx.memory.read((db) => labelStatus(db)).recomputing, true);
}
export function drained(p: ProcessProject): void {
  setLabelBatchLimit(null);
  pmDrain(p.ctx);
  assert.equal(p.ctx.memory.read((db) => labelStatus(db)).recomputing, false);
}

// ---------------------------------------------------------------- rulings (code review round 10)

/**
 * The invariant of the decision's single commit: every ruling judgment (j.sec.<escalation> when the
 * Secretary decided, j.user.<escalation> when the user did) sits with the "applied" event of the same
 * escalation that carried its decision out (accept or accept-risk, by the decider its id names),
 * committed in the same write (the same operation).
 */
export function assertRulingsCarried(p: ProcessProject, tag = ''): number {
  const rows = p.ctx.memory.read((db) => db.stmt("SELECT rev, op, json_extract(record, '$.judgment') AS j FROM log WHERE kind = 'judgment' AND (json_extract(record, '$.judgment') LIKE 'j.sec.%' OR json_extract(record, '$.judgment') LIKE 'j.user.%')").all() as Array<{ rev: number; op: string | null; j: string }>);
  for (const r of rows) {
    const m = /^j\.(sec|user)\.(.+)$/.exec(r.j)!;
    const a = p.ctx.memory.read((db) => db.stmt("SELECT op, json_extract(record, '$.body') AS body FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.line') = 'secretary' AND json_extract(record, '$.event') = 'applied' AND json_extract(record, '$.key') = ?").get(m[2]!) as { op: string | null; body: string } | undefined);
    assert.ok(a !== undefined, `${tag}: ruling ${r.j} without its escalation carried out`);
    assert.equal(a.op, r.op, `${tag}: ruling ${r.j} not in the write that carried its decision out`);
    const body = JSON.parse(p.ctx.memory.data.text(a.body)) as { what?: { option?: string }; by?: string };
    assert.ok(body.what?.option === 'accept' || body.what?.option === 'accept-risk', `${tag}: ruling ${r.j} with a decision carried out as ${JSON.stringify(body.what)}`);
    assert.equal(body.by, m[1] === 'sec' ? 'secretary' : 'user', `${tag}: ruling ${r.j} decided by ${String(body.by)}`);
  }
  return rows.length;
}

/** After a suite: the ruling sweep on every project, then its cleanup (always). */
export function sweepThenClean(ps: readonly ProcessProject[]): void {
  try {
    for (const p of ps) assertRulingsCarried(p, p.dir);
  } finally {
    for (const p of ps) p.cleanup();
  }
}
