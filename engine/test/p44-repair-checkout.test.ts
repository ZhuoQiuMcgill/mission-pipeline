// 4.4 (F3, problem P2): the repair Architect can read what it may reopen. The accepted work on its
// card names each product's commit, and `mp seat <id> checkout --product <task>` serves a shared
// read-only checkout of it, held by the dispatch and removed with the other shared checkouts (4.1.2).
// A repair card queued before 4.4, without the commits, still reads.

import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { ObjectVersionRecord } from '../src/common/records.ts';
import { factById, flowEvents } from '../src/memory/index.ts';
import { DISPATCH_LINE, pmDispatch, pmNext, pmRepair, pmSay, seatCheckout } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { ArchitectRepairCardSchema, renderArchitectRepair, type ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { cli } from './cli-fixtures.ts';
import { addMissionToReview, handBack, processProject, readAll, readyOf, reviewerPass, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

describe('4.4 F3: the repair Architect reads an accepted product (mp seat <id> checkout --product <task>)', () => {
  it("a shared read-only checkout of the product's commit, held by the dispatch and removed when it is over; refused for a task not listed and for another card", async () => {
    p = processProject();
    const ctx = p.ctx;
    await addMissionToReview(p, M);
    // another card kind has no --product
    const rev = pmDispatch(ctx, (await readyOf(ctx, 'reviewer')).step).dispatch;
    await assert.rejects(seatCheckout(ctx, rev, { product: 'impl' }), /--product is for a repair Architect's card, which lists the accepted products it may reopen; this is a reviewer card/);
    readAll(ctx, rev);
    assert.equal((await handBack(ctx, rev, reviewerPass(dispatchView(ctx, rev).card as never))).kind, 'recorded');
    await pmNext(ctx);
    const w2 = pmSay(ctx, 'Trying it, add(2, 3) prints a warning. Please fix that.').words;
    await pmRepair(ctx, { mission: M, words: w2, kind: 'defect', text: 'add(2, 3) prints a warning', about: 'impl' });
    const d = pmDispatch(ctx, (await readyOf(ctx, 'architect-repair')).step).dispatch;
    const card = dispatchView(ctx, d).card as unknown as ArchitectRepairCard;
    const record = ctx.memory.read((db) => factById(db, 'object.version', 'prod.con.m1.impl.1'))!.record as ObjectVersionRecord;
    assert.deepEqual(card.accepted.map((a) => [a.task, a.product, a.commit]), [['impl', 'prod.con.m1.impl.1', record.source!.commit]], 'the accepted work names its commit');
    const rendered = renderSeatCard(card as never, { dispatch: d });
    assert.ok(rendered.includes(`- impl: prod.con.m1.impl.1 (attempt 1, commit ${record.source!.commit}): src/add.js, src/check.js`), rendered);
    assert.ok(rendered.includes(`\`mp seat ${d} checkout --product <task>\`: the same for the accepted product of a task on the accepted list, at its commit.`), rendered);
    assert.ok(rendered.includes('Accepted products are the plan\'s state'), 'the role page says they may be read');
    const c = await seatCheckout(ctx, d, { product: 'impl' });
    assert.equal(c.commit, record.source!.commit);
    assert.equal(c.product, 'prod.con.m1.impl.1');
    assert.ok(existsSync(join(c.path, 'src', 'add.js')), 'the product as it was accepted');
    assert.equal(statSync(join(c.path, 'src', 'add.js')).mode & 0o222, 0, 'read-only: a seat cannot write into it');
    assert.ok(ctx.memory.read((db) => flowEvents(db, { mission: M, line: DISPATCH_LINE(d), event: 'checkout' })).some((e) => e.key === c.commit), 'the dispatch holds it');
    assert.equal((await seatCheckout(ctx, d, { product: 'impl' })).path, c.path, 'reused, not built again');
    await assert.rejects(seatCheckout(ctx, d, { product: 'nope' }), /task nope has no accepted product on the card \(accepted: impl\)/);
    const r = await cli(p.dir, ['seat', d, 'checkout', '--product', 'impl']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.startsWith(c.path) && r.out.includes(`(commit ${c.commit}, the accepted product prod.con.m1.impl.1 of task impl:`), r.out);
    // the Architect hands back: the checkout only it held goes
    readAll(ctx, d);
    assert.equal((await handBack(ctx, d, { reopen: [{ task: 'impl', issue: 'print no warning' }], add: [], note: 'impl owns it' })).kind, 'recorded');
    assert.ok(!existsSync(c.path), 'removed once no dispatch in flight holds it');
  });

  it('a repair card queued before 4.4 (accepted work without commits) still reads and renders', () => {
    const task = { id: 'fix', kind: 'implementation', module: 'core', goal: 'Fix it', standards: [{ id: 'S1', text: 'It is fixed' }], requirementItems: [], writeScope: ['src/**'], readableFiles: [], interpreter: 'node', verificationCommands: [], implements: [], calls: [], dependsOn: [], exclusive: [], estimate: { durationMs: 1, costMicros: 1, basis: 'small' }, provenance: 'architect' };
    const card = {
      format: 'mp41.seat-card.v1', task: 'arch-repair.m1.R-1.1', mission: 'm1', module: null, capabilities: [], duties: 'Turn the repair into the least work.', decisionQuotes: [], constraints: [],
      seat: 'architect-repair', workspace: { snapshot: 'a'.repeat(40), writablePaths: [] }, repair: { id: 'R-1', kind: 'defect', text: 'it breaks', words: 'W-2', about: 'task impl' },
      dplan: 'dplan.m1.1.1', pmPlan: 'pmplan.m1.1', elements: [], plan: { reusedInterfaces: [], newInterfaces: [], modules: [], tasks: [task], risks: [] },
      accepted: [{ task: 'impl', product: 'prod.con.m1.impl.1', attempt: 1, changedPaths: ['src/add.js'] }], owners: [], history: { gitLog: '', runs: [] }, revision: null,
    };
    assert.ok(renderArchitectRepair(ArchitectRepairCardSchema.parse(card)).includes('- impl: prod.con.m1.impl.1 (attempt 1): src/add.js'));
  });
});
