// 4.4 (F3, problem P2): materials by need. What a seat handed back reaches the seat that needs it
// next, as an optional material read page by page (never inlined into the card): the Constructor's
// hand-back on its Reviewer's card, as claims to check and never evidence (ruling E-4); a rework's
// past on its Constructor's card; the previous feasibility report on a revision's cards. The
// feasibility card renders what it reviews, and the plan's data formats and storage reach the
// Constructor and Reviewer cards of its tasks. Cards queued by 4.3, without these fields, still read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { itemLine } from '../src/flow/requirements.ts';
import { architect, constructorDone, detailedPlan, drive, feasibilityReturn, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { parseSeatCard, renderSeatCard, seatCommandsOf, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard } from '../src/seat/cards/architect.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import { resultProblems } from '../src/seat/results.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(over: Record<string, Script>, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

function materialOf(ports: World, card: { materials?: readonly MaterialRef[] | undefined }, id: string): { m: MaterialRef; text: string } {
  const m = card.materials?.find((x) => x.id === id);
  assert.ok(m !== undefined, `material ${id} on the card: ${JSON.stringify(card.materials ?? null)}`);
  return { m, text: ports.ledger.content.get(m.ref as never) };
}

describe("4.4 F3: the Reviewer reads the Constructor's hand-back as claims to check", () => {
  it('the report of the attempt under review, with done and decisions_needed, is an optional material; reading it is not required, citing it is refused', async () => {
    const { ports, engine } = await setup();
    let held = true;
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1'
        ? { handBack: constructorDone({ done: 'parsed quoted fields with a state machine', decisions_needed: ['Is a byte-order mark kept?'] }), report: '# Report\n\nI ran the tests by hand: all green.\n' }
        : { handBack: constructorDone() }),
      // the impl review is left queued: it is handed back below
      reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('impl') && held ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass'), materialsRead: new Set() }),
    }));
    const rev = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
    const { m, text } = materialOf(ports, rev, 'constructor-claims');
    assert.equal(m.mustRead, false, 'optional: not on the must-read list');
    assert.equal(m.role, 'record');
    assert.match(text, /^# The Constructor's claims: to check, not proof\n/);
    assert.ok(text.includes('none of it is evidence for a standard'), text);
    assert.ok(text.includes('## What it says it did\nparsed quoted fields with a state machine'), text);
    assert.ok(text.includes('## Questions it raised (decisions_needed)\n- Is a byte-order mark kept?'), text);
    assert.ok(text.includes('## Its report\n# Report\n\nI ran the tests by hand: all green.'), text);
    const rendered = renderSeatCard(rev as never, { dispatch: 'd-test' });
    assert.ok(rendered.includes("- [constructor-claims] The Constructor's claims: to check, not proof (attempt 1): 1 page\n"), 'listed by pointer, not must read');
    assert.ok(!rendered.includes('I ran the tests by hand'), 'the report is not inlined into the card');
    assert.ok(rendered.includes('`mp seat d-test read <material> [--page <n>]`'), 'the Reviewer gets the read command');
    // the claims are read, never cited for these standards: a pointer to them is refused, and a judgment on the candidate is accepted
    // (4.4, F10: they may be cited only for a standard checked by report: test/p44-f10-standards.test.ts)
    const citing = reviewer(rev, 'pass');
    const bad = resultProblems(rev, { ...citing, judgments: citing.judgments.map((j) => ({ ...j, evidence: ['material:constructor-claims'] })) }, { snapshot: { lines: () => null } });
    assert.ok(bad.some((x) => x.includes("material:constructor-claims: the Constructor's report is cited only for a standard checked by report")), bad.join('\n'));
    assert.ok(resultProblems(rev, { ...citing, judgments: citing.judgments.map((j) => ({ ...j, evidence: ['report:S1'] })) }, { snapshot: { lines: () => null } }).some((x) => x.includes('report:S1: ')));
    held = false;
    const problems = await ports.scheduler.run('rev.m1.impl.1', { handBack: reviewer(rev, 'pass'), materialsRead: new Set() });
    assert.deepEqual(problems, [], 'accepted without reading the optional material');
    // a task's interface Reviewer gets its own Constructor's claims
    assert.ok(materialOf(ports, ports.scheduler.card<ReviewerCard>('rev.m1.iface.1'), 'constructor-claims').text.includes('## What it says it did\nimplemented'));
  });

  it('a card queued by 4.3 (no materials, no data formats) still reads, renders and has no read command', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    for (const task of ['rev.m1.impl.1', 'con.m1.impl.1']) {
      const card = structuredClone(ports.scheduler.card<ReviewerCard | ConstructorCard>(task)) as unknown as Record<string, unknown>;
      delete card['materials'];
      delete card['dataFormats'];
      delete card['storage'];
      const parsed = parseSeatCard(card);
      const rendered = renderSeatCard(parsed as never, { dispatch: 'd-old' });
      assert.ok(!rendered.includes('## Materials') && !rendered.includes("## The plan's data formats"), rendered);
      assert.ok(!seatCommandsOf(parsed as never).includes('read'));
    }
  });
});

describe('4.4 F3: a rework attempt gets its past', () => {
  it("the previous review's report and the attempt's own earlier hand-back are optional materials of the next Constructor card", async () => {
    const { ports, engine } = await setup();
    let n = 0;
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone({ done: `the work of ${t.task}`, unfixed_problems: t.task === 'con.m1.impl.1' ? ['CRLF input is untested'] : [] }), report: `# Constructor report of ${t.task}\n` }),
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface') || n++ > 0) return { handBack: reviewer(c, 'pass') };
        return { handBack: reviewer(c, 'rework', { failing: 'S1', findings: ['quoted newlines are dropped'] }), report: '# Review\n\nS1 fails on a quoted newline.\n' };
      },
    }));
    assert.equal(ports.scheduler.card<ConstructorCard>('con.m1.impl.1').materials, undefined, 'a first attempt has no past');
    const con = ports.scheduler.card<ConstructorCard>('con.m1.impl.2');
    assert.deepEqual(con.materials?.map((m) => [m.id, m.mustRead]), [['previous-review', false], ['previous-handback', false]]);
    const review = materialOf(ports, con, 'previous-review').text;
    assert.ok(review.startsWith('# The previous review of this task (attempt 1)\nReview rev.m1.impl.1 '), review);
    assert.ok(review.includes('handed back "rework"') && review.includes('- [S1] not met: checked (evidence:') && review.includes('- quoted newlines are dropped'), review);
    assert.ok(review.includes('## Its report\n# Review\n\nS1 fails on a quoted newline.'), review);
    const own = materialOf(ports, con, 'previous-handback').text;
    assert.ok(own.startsWith('# Your earlier hand-back (attempt 1)'), own);
    assert.ok(own.includes('the work of con.m1.impl.1') && own.includes('- CRLF input is untested') && own.includes('# Constructor report of con.m1.impl.1'), own);
    const rendered = renderSeatCard(con as never, { dispatch: 'd-test' });
    assert.ok(rendered.includes("- [previous-review] The previous review's report (attempt 1): 1 page\n- [previous-handback] Your earlier hand-back (attempt 1): 1 page"), rendered);
    assert.ok(rendered.includes('`mp seat d-test read <material> [--page <n>]`'));
  });
});

describe('4.4 F3: the feasibility review sees what it reviews, and a revision gets its report', () => {
  it("the feasibility card renders each task's standards, requirement items, files to read and interface links", async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const card = ports.scheduler.card<ArchitectFeasibilityCard>('feas.dplan.m1.1.1');
    const rendered = renderSeatCard(card as never, { dispatch: 'd-test' });
    assert.ok(rendered.includes(`\n  standards: [S1] Parses quoted fields; [S2] Unit tests pass\n  requirement items: ${itemLine(M, 'g1')}, ${itemLine(M, 's1')}\n  files to read: src/parser/api.ts\n  implements: Parser; calls: none`), rendered);
    assert.ok(rendered.includes('\n  standards: [S1] The interface compiles\n'), rendered);
    assert.equal(card.materials, undefined, 'a first review has no earlier report');
  });

  it('after a feasibility return the revising Architect and the next feasibility review get the previous report as an optional material', async () => {
    const { ports, engine } = await setup();
    let returned = false;
    await drive(engine, ports.scheduler, withKinds({
      'architect-feasibility': (t) => (returned ? { handBack: { findings: [], criticalPath: [], verdict: 'feasible' } } : ((returned = true), { handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'the parser buffers whole files in memory'), report: '# Feasibility\n\nWhole files are read at once.\n' })),
      'architect-decompose': () => ({ handBack: architect(detailedPlan(M)) }),
    }));
    const arch = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2');
    assert.deepEqual(arch.materials?.map((m) => [m.id, m.mustRead]), [['plan-old', true], ['feasibility-report', false]]);
    const text = materialOf(ports, arch, 'feasibility-report').text;
    assert.ok(text.startsWith('# The feasibility review of detailed plan dplan.m1.1.1\nReview feas.dplan.m1.1.1 '), text);
    assert.ok(text.includes('- [F1] blocking, capacity (iface): the parser buffers whole files in memory — suggestion: split it'), text);
    assert.ok(text.includes('## The critical path it found\niface') && text.includes('## Its report\n# Feasibility\n\nWhole files are read at once.'), text);
    assert.ok(renderSeatCard(arch as never, { dispatch: 'd-test' }).includes('- [feasibility-report] The previous feasibility report (dplan.m1.1.1): 1 page\n'));
    const next = ports.scheduler.card<ArchitectFeasibilityCard>('feas.dplan.m1.1.2');
    assert.equal(materialOf(ports, next, 'feasibility-report').text, text, 'the next feasibility review reads the same report');
    assert.ok(renderSeatCard(next as never, { dispatch: 'd-test' }).includes('`mp seat d-test read <material> [--page <n>]`'));
  });
});

describe("4.4 F3: the plan's data formats and storage reach the cards of its tasks", () => {
  it('they are printed on the Constructor and Reviewer cards of that plan; a plan without them prints neither', async () => {
    const { ports, engine } = await setup();
    const plan = (): DetailedPlanDoc => ({ ...detailedPlan(M), dataFormats: ['CSV in (RFC 4180), string[][] out'], storage: ['nothing is stored: parsing is in memory'] });
    await drive(engine, ports.scheduler, happyScript(M, plan));
    for (const task of ['con.m1.impl.1', 'rev.m1.impl.1', 'con.m1.iface.1']) {
      const card = ports.scheduler.card<ConstructorCard | ReviewerCard>(task);
      assert.deepEqual([card.dataFormats, card.storage], [['CSV in (RFC 4180), string[][] out'], ['nothing is stored: parsing is in memory']], task);
      const rendered = renderSeatCard(card as never, { dispatch: 'd-test' });
      assert.ok(rendered.includes("## The plan's data formats\n- CSV in (RFC 4180), string[][] out\n\n## The plan's storage\n- nothing is stored: parsing is in memory\n"), rendered);
    }
    const plain = await setup();
    await drive(plain.engine, plain.ports.scheduler, happyScript(M));
    const card = plain.ports.scheduler.card<ConstructorCard>('con.m1.impl.1');
    assert.equal(card.dataFormats, undefined);
    assert.ok(!renderSeatCard(card as never, { dispatch: 'd-test' }).includes("## The plan's data formats"));
  });
});
