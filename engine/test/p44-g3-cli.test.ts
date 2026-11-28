// 4.4 (G3) at the command line: `mp sec instruct` records an instruction as the Secretary's; the PM's
// `mp pm constraint add` accepts an address too, and `mp pm constraint scope` addresses an existing one with no
// new version; `mp pm requirement add --tasks` names a decision's tasks; `mp read constraints` and
// `mp read repairs`; a dispatch reports its card's size and largest sections. Every command whose options are
// absent keeps the identity and payload 4.3 computed, so a 4.3 receipt replays.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginAction, endAction } from '../src/cli/project.ts';
import { defaultConfig, parseConfig, writeConfig } from '../src/cli/config.ts';
import { flowEvents } from '../src/memory/index.ts';
import type { MissionId } from '../src/common/ids.ts';
import { cardSizeReport } from '../src/process/pm.ts';
import { processContext } from '../src/process/context.ts';
import { command43, done43, live43, project43 } from './p43-fixtures.ts';
import { constructorAsks } from './p44-decision-fixtures.ts';
import { readyOf, type ProcessProject } from './process-fixtures.ts';

const constraintBodies = (p: ProcessProject, mission: string) => p.ctx.memory.read((db) => flowEvents(db, { mission: mission as MissionId, line: 'requirements', event: 'constraint' }).map((e) => JSON.parse(p.ctx.memory.data.text(e.body)) as Record<string, unknown>));

test('mp sec instruct records the Secretary\'s instruction for one mission; an id of the PM\'s is refused; the reads name the author; --withdraw takes it back', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    await done43(p, ['pm', 'constraint', 'add', 'm1', 'pm-rule', '--kind', 'instruction', '--text', 'Run the linter first.']);
    const id = await live43(p);
    const runCli = (await import('../src/cli/main.ts')).runCli;
    const env = { cwd: p.dir, env: { MP_SECRETARY: id }, process: { observe: () => ({ os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } }), ident: { name: 't', email: 't@t' } } };
    const first = await runCli(['sec', 'instruct', 'm1', 'samples', '--text', 'Put sample files under fixtures/.', '--tasks', 'impl', '--op', 'sec-instruct-1'], env);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /Instruction samples recorded as constraint\.samples\.v1\.[0-9a-f]+, the Secretary's: a ruling within the plan, never a proof input\./);
    assert.match(first.stdout, /It is addressed to task impl of mission m1: it reaches the work it names/);
    // the same --op replays the recorded result; run again without one, the same text and address write nothing new
    const again = await runCli(['sec', 'instruct', 'm1', 'samples', '--text', 'Put sample files under fixtures/.', '--tasks', 'impl', '--op', 'sec-instruct-1'], env);
    assert.match(again.stdout, /already done; its recorded result is shown, nothing ran again/);
    const out = await command43(p, ['sec', 'instruct', 'm1', 'samples', '--text', 'Put sample files under fixtures/.', '--tasks', 'impl'], id);
    assert.equal(out.code, 0);
    assert.equal(constraintBodies(p, 'm1').filter((b) => b['line'] === 'constraint.samples').length, 1, 'one version');
    const body = constraintBodies(p, 'm1').find((b) => b['line'] === 'constraint.samples')!;
    assert.equal(body['author'], 'secretary');
    assert.deepEqual(body['scope'], { mission: 'm1', paths: ['**'], taskTypes: [], tasks: ['impl'] });
    assert.equal(body['kind'], 'instruction');
    const refused = await command43(p, ['sec', 'instruct', 'm1', 'pm-rule', '--text', 'Something else.'], id);
    assert.equal(refused.error.code, 'NOT_ALLOWED');
    assert.match(refused.error.message, /pm-rule is the PM's instruction: the Secretary records its own under a new id/);
    const read = await done43(p, ['read', 'constraints', 'm1']);
    assert.deepEqual(read.constraints.map((c: { id: string; author: string }) => [c.id, c.author]), [['constraint.pm-rule', 'pm'], ['constraint.samples', 'secretary']]);
    // the PM cannot withdraw through the Secretary's command, nor the Secretary the PM's
    const noPm = await command43(p, ['sec', 'instruct', '--withdraw', 'pm-rule', '--reason', 'gone'], id);
    assert.match(noPm.error.message, /pm-rule is the PM's: only the PM withdraws it/);
    assert.match((await runCli(['sec', 'instruct', '--withdraw', 'samples', '--reason', 'the fixtures moved'], env)).stdout, /Instruction samples withdrawn by the Secretary; its record is kept\./);
    assert.match((await runCli(['sec', 'instruct', '--withdraw', 'samples', '--reason', 'the fixtures moved'], env)).stdout, /Instruction samples was withdrawn already; nothing was written\./);
    assert.deepEqual((await done43(p, ['read', 'constraints', 'm1'])).constraints.map((c: { id: string }) => c.id), ['constraint.pm-rule']);
    const withdrawn = p.ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as MissionId, line: 'requirements', event: 'constraint-withdrawn' }).map((e) => JSON.parse(p.ctx.memory.data.text(e.body))));
    assert.deepEqual(withdrawn.map((b: Record<string, unknown>) => [b['by'], b['reason']]), [['secretary', 'the fixtures moved']]);
    // the PM's way: not the Secretary's identity
    const pmTry = await command43(p, ['sec', 'instruct', 'm1', 'x', '--text', 'y']);
    assert.notEqual(pmTry.code, 0);
  } finally { p.cleanup(); }
});

test('mp pm constraint add --tasks/--repair and mp pm constraint scope: bound to one mission, a warning for names not there yet, no new version on a scope change', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    const r = await command43(p, ['pm', 'constraint', 'add', 'm1', 'one-task', '--kind', 'instruction', '--text', 'Stream the input.', '--tasks', 'impl']);
    assert.equal(r.code, 0, JSON.stringify(r));
    const text = (await import('../src/cli/main.ts')).runCli;
    const human = await text(['pm', 'constraint', 'add', 'm1', 'one-repair', '--kind', 'instruction', '--text', 'Touch the header code only.', '--repair', 'R-1'], { cwd: p.dir, env: { MP_SECRETARY: '' }, process: { observe: () => ({ os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } }), ident: { name: 't', email: 't@t' } } });
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /It is addressed to repair R-1 of mission m1: it reaches the work it names \(now the cards of 0 tasks\) and no other work\./);
    assert.match(human.stdout, /Warning: mission m1 has no R-1 now\./);
    const noMission = await command43(p, ['pm', 'constraint', 'add', 'orphan', '--kind', 'instruction', '--text', 'x', '--tasks', 'impl']);
    assert.equal(noMission.error.code, 'NOT_ALLOWED');
    assert.match(noMission.error.message, /give --mission <m>/);
    const object = await command43(p, ['pm', 'constraint', 'add', 'm1', 'obj', '--kind', 'object', '--text', 'x', '--tasks', 'impl']);
    assert.match(object.error.message, /an address \(--tasks, --repair\) is for an instruction/);
    await done43(p, ['pm', 'constraint', 'add', 'm1', 'later', '--kind', 'instruction', '--text', 'Prefer small functions.', '--mission', 'm1']);
    const before = constraintBodies(p, 'm1').length;
    const scoped = await done43(p, ['pm', 'constraint', 'scope', 'later', '--tasks', 'impl,iface']);
    assert.equal(scoped.scopeChanged, true);
    assert.deepEqual(scoped.scope.tasks, ['impl', 'iface']);
    assert.equal(constraintBodies(p, 'm1').length, before, 'no new version');
    assert.equal((await done43(p, ['pm', 'constraint', 'scope', 'later', '--tasks', 'impl,iface'])).scopeChanged, false);
    const read = await done43(p, ['read', 'constraints', 'm1', '--reach']);
    assert.deepEqual(read.constraints.find((c: { id: string }) => c.id === 'constraint.later').address, { tasks: ['impl', 'iface'], repairs: [] });
  } finally { p.cleanup(); }
});

test('mp pm requirement add --tasks names a decision\'s tasks; on another type it is refused', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    const w = (await done43(p, ['pm', 'say', 'Use LF line endings in the parser.'])).words;
    const runCli = (await import('../src/cli/main.ts')).runCli;
    const r = await runCli(['pm', 'requirement', 'add', 'm1', 'd1', '--type', 'decision', '--text', 'LF line endings', '--quote', 'Use LF line endings', '--words', w, '--tasks', 'impl'], { cwd: p.dir, env: { MP_SECRETARY: '' }, process: { observe: () => ({ os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } }), ident: { name: 't', email: 't@t' } } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /Requirement item d1 \(decision\) of m1 recorded as item\.m1\.d1\.v1; as a decision it is printed on the cards of impl only \(a task whose card links the item still lists it under its requirement items\)\./);
    const help = await runCli(['help', 'pm', 'requirement'], { cwd: p.dir, env: { MP_SECRETARY: '' } });
    assert.match(help.stdout, /a task whose own card links the item still lists its current text under its requirement items/);
    const item = p.ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as MissionId, line: 'requirements', event: 'item' }).map((e) => JSON.parse(p.ctx.memory.data.text(e.body)))).find((b: { line: string }) => b.line === 'item.m1.d1');
    assert.deepEqual(item.tasks, ['impl']);
    const goal = await command43(p, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'x', '--quote', 'Use LF line endings', '--words', w, '--tasks', 'impl']);
    assert.match(goal.error.message, /--tasks goes with --type decision/);
  } finally { p.cleanup(); }
});

test('mp read repairs and mp read constraints on a mission with nothing say so', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    const runCli = (await import('../src/cli/main.ts')).runCli;
    const env = { cwd: p.dir, env: { MP_SECRETARY: '' }, process: { observe: () => ({ os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } }), ident: { name: 't', email: 't@t' } } };
    assert.match((await runCli(['read', 'repairs', 'm1'], env)).stdout, /Mission m1 has no repair\./);
    assert.match((await runCli(['read', 'constraints', 'm1'], env)).stdout, /Mission m1 has no constraint in force\./);
  } finally { p.cleanup(); }
});

test('a dispatch reports its card\'s size and its largest sections; past cardWarnBytes it warns whoever dispatches; no notice goes to the PM', async () => {
  const p = project43();
  try {
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), cardWarnBytes: 1024 });
    await constructorAsks(p, ['Should add accept strings?']);
    const notices = () => Number((p.ctx.memory.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'notice'").get() as { n: number }).n);
    const before = notices();
    const step = (await readyOf(p.ctx, 'secretary')).step;
    const runCli = (await import('../src/cli/main.ts')).runCli;
    const r = await runCli(['pm', 'dispatch', step, '--filled-by', 'h/m'], { cwd: p.dir, env: { MP_SECRETARY: '' }, process: { observe: () => ({ os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } }), ident: { name: 't', email: 't@t' } } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /\nCard: \d+ KiB; largest sections: [^\n]+ \d+ KiB, [^\n]+ \d+ KiB, [^\n]+ \d+ KiB\n/);
    assert.match(r.stdout, /Warning: its text is \d+ KiB, above cardWarnBytes \(1 KiB\); largest sections: /);
    assert.equal(notices(), before, 'no notice');
  } finally { p.cleanup(); }
});

test('compatibility: a config without cardWarnBytes reads with the default 64 KiB; a report without the card\'s text has no size fields', () => {
  assert.equal(parseConfig(defaultConfig({ targetBranch: 'main', versionCommands: [] })).cardWarnBytes, undefined);
  const p = project43();
  try {
    const ctx = processContext(p.ctx.memory);
    assert.equal(ctx.cardWarnBytes, 64 * 1024);
    assert.deepEqual(cardSizeReport(ctx, { seat: 'constructor' }), { mustReadPages: 0, mustReadWarnPages: 6, warnings: [] });
    const r = cardSizeReport(ctx, { seat: 'constructor' }, '# Card\n\n## A\nxx\n\n## B\nyyyyyyyy\n');
    assert.deepEqual(r.largest?.map((s) => s.section), ['B', 'A']);
    assert.equal(r.warnings.length, 0);
  } finally { p.cleanup(); }
});

async function retried43(p: ProcessProject, command: string, args43: unknown, argv: string[]): Promise<void> {
  const op = `old-${command.replace(/ /g, '-')}`;
  const action = { op, command, args: args43 };
  assert.equal(beginAction(p.ctx.memory, { ...action, filler: null }), null);
  endAction(p.ctx.memory, action, { exitCode: 0, text: `recorded by 4.3 for ${command}`, json: { recorded: command } }, false);
  const r = await command43(p, [...argv, '--op', op]);
  assert.equal(r.code, 0, `${command}: ${JSON.stringify(r)}`);
  assert.equal(r.replayed, true, command);
  assert.deepEqual(r.result, { recorded: command });
}

test('compatibility: the PM commands p6 touched replay a 4.3 receipt with the same --op, and a 4.3 run interrupted after its write finishes under 4.4', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    const w = (await done43(p, ['pm', 'say', 'Keep commits small.'])).words;
    await retried43(p, 'constraint add', { positionals: ['add', 'm1', 'small'], flags: { kind: 'instruction', text: 'Keep commits small.' } }, ['pm', 'constraint', 'add', 'm1', 'small', '--kind', 'instruction', '--text', 'Keep commits small.']);
    await retried43(p, 'requirement add', { positionals: ['add', 'm1', 'd1'], flags: { type: 'decision', text: 'small commits', quote: 'Keep commits small.', words: w } }, ['pm', 'requirement', 'add', 'm1', 'd1', '--type', 'decision', '--text', 'small commits', '--quote', 'Keep commits small.', '--words', w]);
    // interrupted: 4.3 wrote the constraint and stopped before its receipt was done; the retry writes the same payload
    const op = 'cut-constraint';
    const args = { positionals: ['add', 'm1', 'cut'], flags: { kind: 'instruction', text: 'Name files in kebab-case.' } };
    assert.equal(beginAction(p.ctx.memory, { op, command: 'constraint add', args, filler: null }), null);
    const { recordConstraint } = await import('../src/flow/requirements.ts');
    await recordConstraint(p.ctx.ports(), { mission: 'm1' as MissionId, constraint: 'cut', kind: 'instruction', text: 'Name files in kebab-case.', scope: { paths: ['**'], taskTypes: [] } });
    const r = await command43(p, ['pm', 'constraint', 'add', 'm1', 'cut', '--kind', 'instruction', '--text', 'Name files in kebab-case.', '--op', op]);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(constraintBodies(p, 'm1').filter((b) => b['line'] === 'constraint.cut').length, 1, 'one version');
  } finally { p.cleanup(); }
});
