// 4.1.3 P3 item 3 (E-4; field issue #43): a request the program would refuse later is refused now.
// `mp seat <id> request-evidence` checks what the executor's `mp seat <id> rerun` is certain to
// refuse, or never offers, for the commands the request declares, and the research author's
// attempt register is checked the same way at its hand-back:
//   a  a working directory the run refuses (normalizeCwd: absolute, leaving the checkout, inside
//      .git), with the reason and the accepted forms; "." , a relative path and none are accepted
//   b  an id declared twice
//   c  the project's full suite
//   d  commands on a reading (named, or the exploration's default executor)
//   e  the exits: a refused request leaves the dispatch in flight; it asks again fixed, or hands
//      back without evidence; a refused attempt register is fixed in the same dispatch

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProcessContext } from '../src/process/context.ts';
import { evidenceCommandProblems, recordEvidenceRequest } from '../src/process/seat.ts';
import { normalizeCwd } from '../src/process/runs.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import { attack, cardOf, finding, hand, only, submit, world, type World } from './flow-exploration-fixtures.ts';

const BASE = { steps: ['run the probe'], data: 'the fixture', measure: ['status'], assertions: [] as string[] };

/** A design exploration whose author is asked to dispose of a finding (it may ask for evidence). */
async function authorTurn(o: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world(o);
  await w.advance();
  await hand(w, 'researcher-author', submit('v1'));
  await w.advance();
  await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'a lost run leaves no record')]));
  await w.advance();
  return w;
}

/** The author's request on its dispatch in flight: the problems when it is refused. */
async function ask(w: World, request: unknown, ctx?: ProcessContext): Promise<string[]> {
  const t = [...w.scheduler.tasks.values()].find((x) => x.spec.card.seat === 'researcher-author' && (x.state === 'queued' || x.state === 'running'));
  if (t === undefined) throw new Error('no author turn');
  if (ctx === undefined) return w.scheduler.run(t.spec.task, { evidence: request, notes: 'notes' });
  const a = await recordEvidenceRequest(ctx, w.scheduler.dispatchOf(t.spec.task), { request, notes: 'notes', advance: false });
  return a.kind === 'refused' ? [...a.problems] : [];
}

describe('request-evidence: what the rerun would refuse is refused at once', () => {
  test('a: an absolute working directory, with the reason and the accepted forms; nothing is queued', async () => {
    const w = await authorTurn();
    const problems = await ask(w, { ...BASE, executor: 'experiment', commands: [{ id: 'probe', command: 'node probe.js', cwd: '/home/zhuo/project' }] });
    assert.deepEqual(problems, ['request.commands[0] (probe): the working directory "/home/zhuo/project" is not relative to the repository root: use "." or a path relative to the repository root, or leave cwd out (an absolute path goes in the command text)']);
    assert.throws(() => normalizeCwd('/home/zhuo/project'), /is not relative to the repository root/, 'the very refusal of the rerun');
    await w.advance();
    assert.equal(w.scheduler.queued('constructor-experiment').length, 0, 'no evidence execution is dispatched for it');
    assert.equal(w.scheduler.queued('researcher-author').length, 1, 'the seat is still on its turn');
  });

  test('a: leaving the checkout, inside .git, a Windows path; ".", a relative path and none are accepted', () => {
    const ctx = { fullSuite: [] };
    const cases: Array<[string | undefined, RegExp | null]> = [
      ['../other', /leaves the checkout/],
      ['.git/hooks', /leaves the checkout/],
      ['C:\\work', /is not relative to the repository root/],
      ['.', null],
      ['sub/dir/', null],
      ['./sub', null],
      [undefined, null],
    ];
    for (const [cwd, why] of cases) {
      const ps = evidenceCommandProblems(ctx, 'request.commands', [{ id: 'c', command: 'true', ...(cwd !== undefined ? { cwd } : {}) }], 'experiment');
      if (why === null) assert.deepEqual(ps, [], String(cwd));
      else assert.ok(ps.length === 1 && why.test(ps[0]!), `${cwd}: ${ps.join('; ')}`);
    }
  });

  test('b: an id declared twice', async () => {
    const w = await authorTurn();
    const problems = await ask(w, { ...BASE, executor: 'experiment', commands: [{ id: 'probe', command: 'node a.js' }, { id: 'probe', command: 'node b.js' }] });
    assert.deepEqual(problems, ['request.commands[1] (probe): the id "probe" is declared twice: give each command its own id (the executor runs one with mp seat <id> rerun <command-id>)']);
  });

  test("c: the project's full suite", async () => {
    const w = await authorTurn();
    const ctx = { ...w.ports.ctx, fullSuite: [{ id: 'all', command: 'npm test' }] } as ProcessContext;
    const problems = await ask(w, { ...BASE, executor: 'experiment', commands: [{ id: 'suite', command: 'npm  test', cwd: '.' }] }, ctx);
    assert.deepEqual(problems, ['request.commands[0] (suite): "npm  test" is the project\'s full suite: it is never rerun from a card (the integration review runs it)']);
    assert.deepEqual(await ask(w, { ...BASE, executor: 'experiment', commands: [{ id: 'local', command: 'npm test', cwd: 'pkg' }] }, ctx), [], 'the same text in a package is a local test');
  });

  test("d: commands on a reading, named or by the exploration's default executor", async () => {
    const w = await authorTurn();
    const named = await ask(w, { ...BASE, executor: 'reading', commands: [{ id: 'probe', command: 'node probe.js' }] });
    assert.deepEqual(named, ['request.commands: a reading runs no commands (its executor reads sources and has no rerun): ask for an experiment (executor "experiment") to run them, or leave them out']);
    const r = await authorTurn({ evidenceExecutor: 'reading' });
    assert.equal((await ask(r, { ...BASE, commands: [{ id: 'probe', command: 'node probe.js' }] })).length, 1, 'the default executor of this exploration reads');
    const e = await authorTurn();
    assert.deepEqual(await ask(e, { ...BASE, commands: [{ id: 'probe', command: 'node probe.js' }] }), [], 'the default executor runs commands');
  });

  test('e: the exits: the same dispatch asks again fixed (the command reaches the executor), or hands back without evidence', async () => {
    const w = await authorTurn();
    const t = only(w, 'researcher-author');
    const d = w.scheduler.dispatchOf(t.task);
    assert.equal((await ask(w, { ...BASE, executor: 'experiment', commands: [{ id: 'probe', command: 'node probe.js', cwd: '/abs' }] })).length, 1);
    assert.equal(w.scheduler.dispatchOf(t.task), d, 'refused: the dispatch stays in flight');
    assert.deepEqual(await ask(w, { ...BASE, executor: 'experiment', commands: [{ id: 'probe', command: 'cd /abs && node probe.js', cwd: '.' }] }), []);
    await w.advance();
    const ex = cardOf<ExperimentCard>(w, 'constructor-experiment');
    assert.deepEqual(ex.commands, [{ id: 'probe', command: 'cd /abs && node probe.js', cwd: '.' }]);
    // the other exit: refused, then the seat hands back its submission without evidence
    const w2 = await authorTurn();
    const t2 = only(w2, 'researcher-author');
    assert.equal((await ask(w2, { ...BASE, executor: 'experiment', commands: [{ id: 'p', command: 'x', cwd: '../up' }] })).length, 1);
    const a = cardOf<{ openFindings: Array<{ id: string }> }>(w2, 'researcher-author');
    assert.deepEqual(await w2.scheduler.run(t2.task, { handBack: submit('v2', a.openFindings.map((f) => ({ finding: f.id, action: 'revise' as const, note: 'changed' }))) }), []);
  });

  test("e: a research author's attempt register is checked the same way at its hand-back, and fixed in the same dispatch", async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does the lock survive a crash?', decision: { type: 'structure', text: 'which lock' } });
    await w.advance();
    const t = only(w, 'researcher-author');
    const bad: RegisteredAttemptT[] = [
      { id: 'A1', kind: 'experiment', purpose: 'p', steps: ['run it'], data: '', measure: ['m'], assertions: [], commands: [{ id: 'run', command: 'sh crash.sh', cwd: '/home/u/repo' }] },
      { id: 'A2', kind: 'reading', purpose: 'p', steps: ['read'], data: '', measure: ['m'], assertions: [], commands: [{ id: 'fetch', command: 'curl x' }] },
    ];
    const problems = await w.scheduler.run(t.task, { handBack: submit('method v1', [], { attempts: bad }) });
    assert.ok(problems.some((p) => p.startsWith('attempts[A1].commands[0] (run): the working directory "/home/u/repo" is not relative to the repository root')), problems.join('; '));
    assert.ok(problems.some((p) => p.startsWith('attempts[A2].commands: a reading runs no commands')), problems.join('; '));
    const good = [{ ...bad[0]!, commands: [{ id: 'run', command: 'sh crash.sh' }] }, { ...bad[1]!, commands: [] }];
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: submit('method v1', [], { attempts: good }) }), []);
    assert.equal(w.scheduler.tasks.get(t.task)?.dispatches.length, 1, 'the same dispatch');
  });
});
