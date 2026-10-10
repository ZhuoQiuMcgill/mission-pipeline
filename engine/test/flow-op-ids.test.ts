// Release review r5: ledger op ids are global, so every op id the flows build from a per-mission
// name carries the mission. A grep over every op-id template in src/flow/** (with the few
// project-wide or indirect ones named and justified), and two missions with the same task,
// standard and command ids run through spec → construct → rework → accept on the real ledger.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { BaseRecord, LoopKind } from '../src/common/records.ts';
import { ledgerAdapter } from '../src/flow/adapters.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { FakeFlowScheduler, type FakeFlowLedger } from '../src/flow/fakes.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { FlowEvaluatorPort, FlowLedgerPort, LoopStatus } from '../src/flow/ports.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { drive, happyScript, pmPlan, reviewer, type Script } from '../src/flow/scripted.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { Alerts } from '../src/scheduler/alerts.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { SchedulerLedger } from '../src/scheduler/ledger.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { cleanupEnvs, inProcessLedger, makeEnv } from './scheduler-fixtures.ts';

after(cleanupEnvs);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Op-id templates that need no explicit mission, and why. */
const PROJECT_WIDE_OR_INDIRECT: ReadonlyArray<{ readonly file: string; readonly template: string; readonly why: string }> = [
  { file: 'src/flow/actions/verify.ts', template: '`flow:env-snapshot:${envLine}:${snapshot}`', why: 'project-wide: the environment snapshot record is the same for every mission' },
  { file: 'src/flow/exploration/step.ts', template: '`grant:${id}:${by}`', why: 'indirect: id = escId(mission, …) carries the mission' },
  { file: 'src/flow/fakes.ts', template: '`restart:${task}:${t.launches.length}`', why: 'test double only; task ids carry the mission' },
];

describe('release review r5: op ids carry the mission', () => {
  it('every op-id template in src/flow/** names the mission, or is listed as project-wide or indirect', () => {
    const root = new URL('../', import.meta.url).pathname;
    const found: Array<{ file: string; template: string }> = [];
    for (const f of files(join(root, 'src/flow'))) {
      const rel = f.slice(root.length);
      for (const m of readFileSync(f, 'utf8').matchAll(/`(?:flow|xp|aud|grant|restart):[^`]*`/g)) found.push({ file: rel, template: m[0] });
    }
    assert.ok(found.length > 40, `the scan found the builders (${found.length})`);
    const missing = found.filter((x) => !/mission|tok\(|ltok\(|\$\{m\}/.test(x.template) && !PROJECT_WIDE_OR_INDIRECT.some((a) => a.file === x.file && a.template === x.template));
    assert.deepEqual(missing, [], 'op ids without the mission');
  });

  it('two missions with the same task, standard and command ids run spec → construct → rework → accept on the real ledger without an op conflict', async () => {
    const e = makeEnv('flow-r5');
    const l = inProcessLedger(e);
    const lp = ledgerPaths(e.ledgerRoot, e.cp);
    const client = SchedulerLedger.connect(e.socket, 5_000);
    const store = new ContentStore(lp.content);
    try {
      const gen = await l.svc.beginGeneration();
      const inner = ledgerAdapter({ ledger: client, content: store, alerts: new Alerts({ ledger: client, content: store, controlPlane: new ControlPlane(e.cp), source: 'flow' }), gen: () => gen });
      // the fake scheduler plays the seat hosts; what it commits goes to the real ledger, in order
      let chain: Promise<void> = Promise.resolve();
      let n = 0;
      const shim = {
        content: inner.content,
        commit(records: readonly BaseRecord[]): void {
          const rs = records.filter((r) => r.kind !== 'seat.result'); // the host's own record: not appendable by the program
          if (rs.length > 0) {
            const op = `shim:${++n}`;
            chain = chain.then(() => inner.append(op, { records: rs }));
          }
        },
        loop: async (lineage: string, loop: LoopKind): Promise<LoopStatus> => (await chain, inner.loop(lineage, loop)),
        loopAttempt: async (req: Parameters<FlowLedgerPort['loopAttempt']>[0]): Promise<LoopStatus> => (await chain, inner.loopAttempt(req)),
        grantLoop: async (req: { lineage: string; loop: LoopKind; by: 'secretary' | 'user'; extra: number; op: string; reason?: string }) => {
          await chain;
          if (req.by === 'secretary' && (await inner.loop(req.lineage, req.loop)).secretaryGrantUsed) return { granted: false, why: 'secretary-already-granted' };
          await inner.append(req.op, { records: [{ kind: 'loop.grant', lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra, reason: inner.content.put(req.reason ?? '') }] });
          return { granted: true };
        },
      };
      const settled = <T>(f: () => Promise<T>): Promise<T> => chain.then(f);
      const ledger: FlowLedgerPort = {
        content: inner.content,
        append: (op, entries) => settled(() => inner.append(op, entries)),
        commitProofOp: (req) => settled(() => inner.commitProofOp(req)),
        events: (q) => settled(() => inner.events(q)),
        records: (kinds, o) => settled(() => inner.records(kinds, o)),
        objectVersion: (x) => settled(() => inner.objectVersion(x)),
        judgment: (x) => settled(() => inner.judgment(x)),
        loop: (lineage, loop) => settled(() => inner.loop(lineage, loop)),
        loopAttempt: (req) => settled(() => inner.loopAttempt(req)),
        notify: (x) => settled(() => inner.notify(x)),
        missions: () => settled(() => inner.missions()),
      };
      const scheduler = new FakeFlowScheduler(shim as unknown as FakeFlowLedger);
      const evaluator: FlowEvaluatorPort = {
        labels: async (ids) => ({ revision: 0, labels: Object.fromEntries(ids.map((i) => [i, 'proven' as const])) }),
        deciding: async () => ({ revision: 0, views: {} }),
        judgments: async (ids) => ({ revision: 0, current: Object.fromEntries(ids.map((i) => [i, true])) }),
        ops: async () => ({ revision: 0, states: {} }),
      };
      const ports = { ledger, scheduler, evaluator };
      for (const mission of ['m3', 'm4'] as MissionId[]) {
        await recordItem(ports, { mission, item: 'g1', type: 'goal', text: 'A CSV parser', source: { kind: 'words', message: `${mission}-msg1`, quote: 'Build me a CSV parser' } });
        await recordItem(ports, { mission, item: 's1', type: 'acceptance', text: 'It has tests', source: { kind: 'words', message: `${mission}-msg1`, quote: 'with tests' } });
        await recordItem(ports, { mission, item: 'a1', type: 'authorization', text: "Details are the PM's", source: { kind: 'words', message: `${mission}-msg1`, quote: 'The details are yours to decide' } });
        await submitPmBatch(ports, { mission, plan: pmPlan(mission), userWords: [`${mission}-msg1`], mode: 'fast' });
      }
      // each mission's impl is sent back once by its Reviewer, then passes
      const reworked = new Set<string>();
      const script: Script = (t, s) => {
        if (t.card.seat === 'reviewer') {
          const c = t.card as unknown as ReviewerCard;
          if (c.target.includes('impl') && !reworked.has(t.mission)) {
            reworked.add(t.mission);
            return { handBack: reviewer(c, 'rework', { failing: 'S1' }) };
          }
          return { handBack: reviewer(c, 'pass') };
        }
        return happyScript(t.mission)(t, s);
      };
      await drive(new FlowEngine(ports), scheduler, script);
      await chain;
      for (const mission of ['m3', 'm4'] as MissionId[]) {
        const accepted = (await ledger.events({ mission, event: 'accepted' })).map((x) => x.line).sort();
        assert.deepEqual(accepted, ['task:iface', 'task:impl'], `${mission}: both tasks accepted`);
        assert.equal((await ledger.events({ mission, event: 'rework' })).length, 1, `${mission}: one rework`);
        assert.equal((await ledger.events({ mission, event: 'spec' })).length, 2, `${mission}: both specs recorded`);
      }
    } finally {
      client.close();
      await l.close();
    }
  });
});
