// Release review r5: op ids are global in the project memory, so every op id the flows build from
// a per-mission name carries the mission. A grep over every op-id template in src/flow/** (with
// the few project-wide or indirect ones named and justified), and two missions with the same task,
// standard and command ids run through spec → construct → rework → accept on the project memory.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { drive, happyScript, pmPlan, reviewer, type Script } from '../src/flow/scripted.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Op-id templates that need no explicit mission, and why. */
const PROJECT_WIDE_OR_INDIRECT: ReadonlyArray<{ readonly file: string; readonly template: string; readonly why: string }> = [
  { file: 'src/flow/exploration/step.ts', template: '`grant:${id}:${by}`', why: 'indirect: id = escId(mission, …) carries the mission' },
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

  it('two missions with the same task, standard and command ids run spec → construct → rework → accept on the project memory without an op conflict', async () => {
    const ports = memoryPorts();
    for (const mission of ['m3', 'm4'] as MissionId[]) {
      const w = say(ports, `Build me a CSV parser with tests. The details are yours to decide. (${mission})`);
      await recordItem(ports, { mission, item: 'g1', type: 'goal', text: 'A CSV parser', source: { kind: 'words', words: w, quote: 'Build me a CSV parser' } });
      await recordItem(ports, { mission, item: 's1', type: 'acceptance', text: 'It has tests', source: { kind: 'words', words: w, quote: 'with tests' } });
      await recordItem(ports, { mission, item: 'a1', type: 'authorization', text: "Details are the PM's", source: { kind: 'words', words: w, quote: 'The details are yours to decide' } });
      await submitPmBatch(ports, { mission, plan: pmPlan(mission), userWords: [w], mode: 'fast' });
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
    await drive(new FlowEngine(ports), ports.scheduler, script);
    for (const mission of ['m3', 'm4'] as MissionId[]) {
      const accepted = (await ports.ledger.events({ mission, event: 'accepted' })).map((x) => x.line).sort();
      assert.deepEqual(accepted, ['task:iface', 'task:impl'], `${mission}: both tasks accepted`);
      assert.equal((await ports.ledger.events({ mission, event: 'rework' })).length, 1, `${mission}: one rework`);
      assert.equal((await ports.ledger.events({ mission, event: 'spec' })).length, 2, `${mission}: both specs recorded`);
    }
  });
});
