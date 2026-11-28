// 4.4 package p3, review round 2: a repair's change of a task accepted meanwhile goes back to the
// Architect (p3-3, in the flow); every command-line claim takes the checked path; a full run's start
// is recorded under its run locks (p3-r2-1); a material that cannot be stored never refuses a claim
// (p3-r2-2); a claim that met unchecked accepted work says nothing was claimed (p3-r2-3).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { cal1Pass, cal2Pass, constructorDone, detailedPlan, drive, feasibilityReturn, feasible, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { LedgerError, listDispatches } from '../src/memory/index.ts';
import { pmDispatch, pmNext, pmRelease, pmRepair, pmSay, runFullSuite, seatFullRun, shellRunner, type CommandRunner } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard, ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import { STARTS_CHANGED } from '../src/seat/cards/refresh.ts';
import { PM_COMMANDS } from '../src/cli/commands/pm.ts';
import { SEC_COMMANDS } from '../src/cli/commands/secretary.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { addDetailedPlan, addMissionToReview, CHECK_JS, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

async function world(): Promise<{ ports: World; engine: FlowEngine }> {
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

function claimed<C>(ports: World, task: string): C {
  const d = ports.ctx.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  assert.ok(d !== undefined, `task ${task} was dispatched`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

describe('p3-3: a change of a task accepted by the time the decision is applied goes back to the Architect', () => {
  it('a stale repair card offered the change; the flow returns the hand-back through the mechanical-return loop, on a card built on the work accepted now, and the repair is not decided', async () => {
    const { ports, engine } = await world();
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('iface') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }));
    const w2 = say(ports, 'Trying it, the interface lacks a header option.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the interface lacks a header option' });
    await engine.reconcile();
    const repair = ports.scheduler.queued('architect-repair')[0]!.task;
    // the Architect claims its card while iface awaits its review: iface is changeable on it
    const d = pmDispatch(ports.ctx, repair).dispatch;
    assert.deepEqual((dispatchView(ports.ctx, d).card as unknown as ArchitectRepairCard).accepted, []);
    // iface is accepted before the Architect hands back its change of iface's card
    const rev = ports.scheduler.queued('reviewer')[0]!;
    assert.deepEqual(await ports.scheduler.run(rev.task, { handBack: reviewer(rev.card as never, 'pass') }), []);
    await engine.reconcile();
    const iface = detailedPlan(M).tasks.find((t) => t.id === 'iface')!;
    assert.deepEqual(await ports.scheduler.run(repair, { handBack: { reopen: [], add: [], change: [{ ...iface, goal: 'Define the Parser interface, with a header option' }], note: 'iface owns the option' } }), []);
    await engine.reconcile();
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs', event: 'decided' })).length, 0, 'not recorded as decided with the edit skipped');
    const next = ports.scheduler.queued('architect-repair');
    assert.equal(next.length, 1);
    const card = next[0]!.card as unknown as ArchitectRepairCard;
    assert.deepEqual(card.revision?.mechanicalFailures, ['change[iface]: task iface now has an accepted product: reopen it instead (the card it was changed on predates its acceptance)']);
    assert.deepEqual(card.accepted.map((a) => a.task), ['iface'], 'the card of the next attempt is built on the work accepted now');
    assert.ok((await ports.ledger.records(['loop.attempt'])).some((r) => r.record.loop === 'mechanical-return'), 'counted on the mechanical-return loop');
  });
});

describe('p3-3: every command-line claim takes the checked path', () => {
  it('mp pm dispatch, mp sec dispatch and mp sec card claim through pmDispatchChecked; no command-line module calls the plain claim', async () => {
    const dispatch = PM_COMMANDS.find((c) => c.name[0] === 'dispatch')!;
    const sec = SEC_COMMANDS.find((c) => c.name[0] === 'dispatch')!;
    assert.equal(sec.run, dispatch.run, 'mp sec dispatch is mp pm dispatch');
    assert.match(dispatch.run.toString(), /pmDispatchChecked\(/);
    // a file path, not the URL's pathname (on Windows that is "/C:/…")
    const engine = fileURLToPath(new URL('..', import.meta.url));
    const files = [...readdirSync(join(engine, 'src', 'cli', 'commands')).map((f) => join(engine, 'src', 'cli', 'commands', f)), join(engine, 'src', 'cli', 'main.ts'), join(engine, 'src', 'process', 'secretary.ts')];
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bpmDispatch\(/, `${f} claims through the checked path`);
    // and it claims a repair step end to end
    p = processProject();
    const ctx = p.ctx;
    await addMissionToReview(p, M);
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    await pmNext(ctx);
    const w2 = pmSay(ctx, 'Trying it, add(2, 3) prints a warning. Please fix that.').words;
    await pmRepair(ctx, { mission: M, words: w2, kind: 'defect', text: 'add(2, 3) prints a warning', about: 'impl' });
    const s = await readyOf(ctx, 'architect-repair');
    const r = await cli(p.dir, ['pm', 'dispatch', s.step, '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((dispatchView(ctx, r.json.result.dispatch).card as unknown as ArchitectRepairCard).accepted.map((a) => a.task), ['impl']);
  });
});

describe('p3-r2-1: a full run records its start under its run locks, immediately before it executes', () => {
  it('a full run refused because another process holds its run lock leaves the dispatch unstarted', async () => {
    const SUITE = [{ id: 'suite', command: 'node suite.js' }];
    let hold = false;
    let entered!: () => void;
    const inRun = new Promise<void>((r) => (entered = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    const runner: CommandRunner = async (req) => {
      if (hold && req.command === 'node suite.js') {
        entered();
        await gate;
      }
      return shellRunner(req);
    };
    p = processProject({ files: { 'suite.js': "process.exit(0);\n" }, options: { runner, fullSuite: SUITE } });
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', fullSuite: SUITE }));
    const ctx = p.ctx;
    const plan = addDetailedPlan(M) as { tasks: unknown[] };
    plan.tasks.push({ id: 'integ', kind: 'integration', module: null, goal: 'Use add in the app', standards: [{ id: 'S1', text: 'the app prints add(2, 3)' }], requirementItems: [`item.${M}.g1`], writeScope: ['app/**'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'app', command: 'node app/main.js' }], implements: [], calls: ['add'], dependsOn: ['impl'], exclusive: [], estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: { planElement: 'e1' } });
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => plan);
    if ((await pmNext(ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(ctx, 'architect-feasibility', () => feasible());
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const construct = async (task: string, files: Record<string, string>): Promise<string> => {
      const d = pmDispatch(ctx, (await pmNext(ctx)).ready.find((r) => r.kind === 'constructor' && r.step.includes(`.${task}.`))!.step);
      for (const [rel, text] of Object.entries(files)) write(join(p!.dir, d.worktree!), rel, text);
      const a = await handBack(ctx, d.dispatch, constructorDone());
      assert.ok(a.kind === 'recorded' && a.candidate !== null);
      return a.candidate.commit;
    };
    await construct('impl', { 'src/add.js': 'exports.add = (a, b) => a + b;\n', 'src/check.js': CHECK_JS });
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const candidate = await construct('integ', { 'app/main.js': "const { add } = require('../src/add.js');\nconsole.log(add(2, 3));\n" });
    const rv = pmDispatch(ctx, (await pmNext(ctx)).ready.find((r) => r.kind === 'reviewer' && r.step.includes('.integ.'))!.step).dispatch;
    // another process runs the same suite on the same candidate and holds its run lock
    hold = true;
    const other = runFullSuite(ctx, { mission: M, commit: candidate, suite: SUITE, by: 'pm', cites: { words: null, authority: null, reason: 'a test', dispatch: null } });
    await inRun;
    await assert.rejects(seatFullRun(ctx, rv), (e: unknown) => e instanceof LedgerError);
    const r = await pmRelease(ctx, rv, 'ended');
    assert.equal(r.unstarted, 1, 'nothing of it ran: its release costs nothing');
    hold = false;
    go();
    await other;
  });
});

describe('p3-r2-2: a material that cannot be stored never refuses a claim', () => {
  it('queued in the 4.3 shape or queued now, each F3 material too large to store leaves one line on the card, saying where its report is, and every claim goes on', async () => {
    const { ports, engine } = await world();
    // past the data value's limit (as a 64 MiB report would be once the headings are added)
    const put = ports.memory.data.put.bind(ports.memory.data);
    ports.memory.data.put = ((d: string | Uint8Array) => {
      if (typeof d === 'string' && /^# (The Constructor's claims|The previous review of this task|Your earlier hand-back|The feasibility review of detailed plan)/.test(d)) throw new LedgerError('TOO_LARGE', 'a data value is too large');
      return put(d);
    }) as typeof ports.memory.data.put;
    // the Reviewer's and the rework's cards in the 4.3 shape (filled in at the claim), the planning cards as queued now
    const submit = ports.scheduler.submit.bind(ports.scheduler);
    ports.scheduler.submit = async (t: FlowTask) => {
      const card = { ...t.card } as Record<string, unknown>;
      if (card['seat'] === 'reviewer' || card['seat'] === 'constructor') for (const k of ['materials', 'materialsNotAttached']) delete card[k];
      return submit({ ...t, card: card as FlowTask['card'] });
    };
    let returned = false;
    let reworked = false;
    await drive(engine, ports.scheduler, withKinds({
      'architect-feasibility': (t) => (returned ? { handBack: { findings: [], criticalPath: [], verdict: 'feasible' } } : ((returned = true), { handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'whole files in memory') })),
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface') || reworked) return { handBack: reviewer(c, 'pass') };
        reworked = true;
        return { handBack: reviewer(c, 'rework', { failing: 'S1' }) };
      },
    }));
    const line = (c: { materialsNotAttached?: readonly string[] | undefined }, id: string): string => {
      const l = (c.materialsNotAttached ?? []).find((x) => x.startsWith(`[${id}] `));
      assert.ok(l !== undefined, JSON.stringify(c.materialsNotAttached ?? null));
      return l;
    };
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.equal((rev.materials as MaterialRef[] | undefined)?.length ?? 0, 0);
    assert.match(line(rev, 'constructor-claims'), /^\[constructor-claims\] The Constructor's claims: to check, not proof \(attempt 1\): could not be attached \(TOO_LARGE\); read the report at \.mission-pipeline\/missions\/m1\/dispatches\/D-\d+\/report\.md$/);
    assert.ok(renderSeatCard(rev as never, { dispatch: 'd-test' }).includes('## Materials that could not be attached\n- [constructor-claims] '));
    const con = claimed<ConstructorCard>(ports, 'con.m1.impl.2');
    line(con, 'previous-review');
    line(con, 'previous-handback');
    line(ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2'), 'feasibility-report');
    line(claimed<ArchitectFeasibilityCard>(ports, 'feas.dplan.m1.1.2'), 'feasibility-report');
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2, 'the work went on');
  });
});

describe('p3-r2-3: a claim that meets accepted work its caller did not check says plainly that nothing was claimed', () => {
  it('the refusal names it and says to run the dispatch again', async () => {
    const { ports, engine } = await world();
    const append = ports.ledger.append.bind(ports.ledger);
    ports.ledger.append = ((op, e) => append(op, { ...e, ...(e.events !== undefined ? { events: e.events.map((x) => {
      if (x.event !== 'dispatched' || x.key !== 'con.m1.iface.1') return x;
      const { prerequisites: _pin, ...body } = x.body as { prerequisites?: unknown };
      return { ...x, body };
    }) } : {}) })) as typeof ports.ledger.append;
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('iface') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }));
    await pmRepair(ports.ctx, { mission: M, words: say(ports, 'Trying it, the header row is lost.'), kind: 'defect', text: 'the header row is lost' });
    await engine.reconcile();
    const repair = ports.scheduler.queued('architect-repair')[0]!.task;
    const rev = ports.scheduler.queued('reviewer')[0]!;
    await ports.scheduler.run(rev.task, { handBack: reviewer(rev.card as never, 'pass') });
    await engine.reconcile();
    assert.throws(() => pmDispatch(ports.ctx, repair, { starts: new Map() }), (e: unknown) => (e as { detail?: Record<string, unknown> }).detail?.[STARTS_CHANGED] === true && /^NOT_READY: nothing was claimed: the accepted work of iface changed while the claim of .* checked it; run the dispatch again$/.test((e as Error).message));
    assert.equal(ports.ctx.memory.read((db) => listDispatches(db, { task: repair, limit: 10 })).length, 0, 'nothing was claimed');
  });
});

void readAll;
