// 4.4 (F16, P5): must-read material that can be read. The Secretary's current-facts is a digest; the
// task line in full is a material that is not must-read; the constraints are not repeated in it; each
// decision is printed once on the card; a dispatch reports its must-read pages and warns its driver past
// mustReadWarnPages (never a notice to the PM); outputs and pages say "fetched".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, parseConfig, writeConfig } from '../src/cli/config.ts';
import { dispatchView, seatRead } from '../src/process/seat.ts';
import { cardSizeReport, pmDispatch, pmRelease } from '../src/process/pm.ts';
import { processContext } from '../src/process/context.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import { runCli } from '../src/cli/main.ts';
import { ENV_A, readyOf, type ProcessProject } from './process-fixtures.ts';
import { project43, command43, done43, secretary43 } from './p43-fixtures.ts';
import { constructorAsks, liveWithEscalation } from './p44-decision-fixtures.ts';

const materials = (p: ProcessProject, dispatch: string) => dispatchView(p.ctx, dispatch).card['materials'] as MaterialRef[];
const text = (p: ProcessProject, m: MaterialRef) => p.ctx.memory.data.text(m.ref);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test('the Secretary reads a digest: goal, standards, items by id, one line per event; the task line in full is not must-read; no constraint repeated; each decision once', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add accept strings?']);
    const s = await liveWithEscalation(p);
    const d = await done43(p, ['sec', 'card', s.escalation], s.id);
    const ms = materials(p, d.dispatch);
    const facts = ms.find((m) => m.id === 'current-facts')!;
    const line = ms.find((m) => m.id === 'task-line')!;
    assert.equal(facts.mustRead, true);
    assert.equal(line.mustRead, false, 'the full task line is a material that is not must-read');
    const digest = text(p, facts);
    assert.match(digest, /Task impl \(implementation\): Implement add and its check/);
    assert.match(digest, /\[S1\] add\(2, 3\) is 5/);
    assert.match(digest, /\[item\.m1\.g1\] goal: An add function/);
    assert.doesNotMatch(digest, /Keep every commit small/, 'the constraints are on the card, not repeated in the digest');
    const full = JSON.parse(text(p, line)) as { task: { id: string }; events: { event: string }[] };
    assert.equal(full.task.id, 'impl');
    const eventLines = digest.split('\n').filter((l) => /^- (spec|attempt|dispatched|verified|candidate|decisions|review|rework|escalated|[a-z-]+) /.test(l) && !l.startsWith('- ['));
    assert.equal(eventLines.length, full.events.length, 'one line per event of the task line');
    assert.equal(count(d.card, 'add returns a number, never a string'), 1, 'the decision is printed once on the card');
    assert.match(d.card, /\[item\.m1\.d1\] add returns a number/);
    assert.equal(count(d.card, 'Keep every commit small'), 1);
    // the hand-back needs every must-read page fetched, and not the task line
    const sec = secretary43(p, s.id);
    try { for (const m of ms.filter((x) => x.mustRead)) for (let n = 1; n <= m.pages; n++) seatRead(sec, d.dispatch, m.id, n); } finally { sec.memory.close(); }
    const r = await done43(p, ['sec', 'decide', s.escalation, '--option', 'answer', '--instructions', 'numbers only', '--reason', 'the decision says so'], s.id);
    assert.equal(r.kind, 'recorded');
  } finally { p.cleanup(); }
});

test('a dispatch reports its must-read pages; past mustReadWarnPages it warns whoever dispatches, and no notice goes to the PM', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add accept strings?']);
    const s = await liveWithEscalation(p);
    const quiet = await command43(p, ['sec', 'card', s.escalation], s.id);
    const pages = materials(p, quiet.result.dispatch).filter((m) => m.mustRead).reduce((n, m) => n + m.pages, 0);
    // 4.4 (G3) adds the card's bytes and its largest sections to the same report
    const { mustReadPages, mustReadWarnPages, warnings } = quiet.result.size;
    assert.deepEqual({ mustReadPages, mustReadWarnPages, warnings }, { mustReadPages: pages, mustReadWarnPages: 6, warnings: [] });
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), mustReadWarnPages: 2 });
    const notices = () => Number((p.ctx.memory.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'notice'").get() as { n: number }).n);
    const before = notices();
    const loud = await command43(p, ['sec', 'card', s.escalation], s.id);
    assert.equal(loud.result.size.mustReadWarnPages, 2);
    assert.match(loud.result.size.warnings[0], new RegExp(`must-read material is ${pages} pages, above mustReadWarnPages \\(2\\): request 1`));
    assert.equal(notices(), before, 'the report is the dispatch output: no notice, none to the PM');
    assert.equal((await done43(p, ['pm', 'inbox'])).items.some((i: { text: string }) => /must-read/.test(i.text)), false);
  } finally { p.cleanup(); }
});

test('a retried mp sec card with the same --op prints the card from its leaf with the same size warning', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add accept strings?']);
    const s = await liveWithEscalation(p);
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), mustReadWarnPages: 1 });
    const run = (args: string[]) => runCli(args, { cwd: p.dir, env: { MP_SECRETARY: s.id, MP_ROLE: 'ignored' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' } } });
    const warning = /Warning: this card's must-read material is \d+ pages, above mustReadWarnPages \(1\)/;
    const first = await run(['sec', 'card', s.escalation, '--op', 'card-heavy']);
    assert.equal(first.exitCode, 0, first.stdout);
    assert.match(first.stdout, warning);
    // the recorded result names the card's leaf, not its text (F17): the replay reads the leaf and the recorded size report
    const again = await run(['sec', 'card', s.escalation, '--op', 'card-heavy']);
    assert.equal(again.exitCode, 0, again.stdout);
    assert.match(again.stdout, warning);
    assert.ok(again.stdout.includes(first.stdout.split('\n')[0]!), 'the same card');
  } finally { p.cleanup(); }
});

test('the driver of a 4.2-mode project sees the report on mp pm dispatch', async () => {
  const p = project43();
  try {
    writeConfig(p.dir, { ...defaultConfig({ targetBranch: 'main', versionCommands: [] }), mustReadWarnPages: 1 });
    await constructorAsks(p, ['Should add accept strings?']);
    const step = (await readyOf(p.ctx, 'secretary')).step;
    const r = await command43(p, ['pm', 'dispatch', step, '--filled-by', 'h/m']);
    assert.ok(r.result.size.mustReadPages > 1);
    assert.equal(r.result.size.warnings.length, 1);
  } finally { p.cleanup(); }
});

test('outputs and pages say "fetched": the receipt is a fetch, and the engine adds no gate', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add accept strings?']);
    const s = await liveWithEscalation(p);
    const d = await done43(p, ['sec', 'card', s.escalation], s.id);
    assert.match(d.card, /fetch each page with the read command below and read it/);
    assert.match(d.card, /`mp sec read [^`]+`: fetches one page of a material/);
    const refused = await command43(p, ['sec', 'decide', s.escalation, '--option', 'answer', '--instructions', 'x', '--reason', 'y'], s.id);
    assert.equal(refused.error.code, 'NOT_ALLOWED');
    assert.ok(refused.error.detail.problems.some((x: string) => /must-read page request#1 was not fetched/.test(x)), JSON.stringify(refused.error.detail.problems));
    const sec = secretary43(p, s.id);
    try { assert.match(seatRead(sec, d.dispatch, 'request', 1).text, /\(must read; this fetch is recorded\)/); } finally { sec.memory.close(); }
    const shown = await command43(p, ['read', 'show', 'dispatch', d.dispatch]);
    assert.equal(shown.code, 0);
  } finally { p.cleanup(); }
});

test('compatibility: a config without mustReadWarnPages reads with the default 6, and a dispatch of a card with no materials reports none', () => {
  const c = parseConfig(defaultConfig({ targetBranch: 'main', versionCommands: [] }));
  assert.equal(c.mustReadWarnPages, undefined);
  const p = project43();
  try {
    const ctx = processContext(p.ctx.memory);
    assert.equal(ctx.mustReadWarnPages, 6);
    assert.deepEqual(cardSizeReport(ctx, { seat: 'constructor' }), { mustReadPages: 0, mustReadWarnPages: 6, warnings: [] });
  } finally { p.cleanup(); }
});

test('review p1-8: a page of a dispatch that is over reads as history and claims no receipt', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add accept strings?']);
    const step = (await readyOf(p.ctx, 'secretary')).step;
    const d = pmDispatch(p.ctx, step, { filledBy: 'h/m' });
    assert.match(seatRead(p.ctx, d.dispatch, 'request', 1).text, /\(must read; this fetch is recorded\)/);
    await pmRelease(p.ctx, d.dispatch, 'ended');
    const reads = () => Number((p.ctx.memory.stmt("SELECT COUNT(*) AS n FROM flow_events WHERE line = ? AND event = 'read'").get(`dispatch:${d.dispatch}`) as { n: number }).n);
    const before = reads();
    const page = seatRead(p.ctx, d.dispatch, 'current-facts', 1);
    assert.doesNotMatch(page.text, /this fetch is recorded/);
    assert.match(page.text, new RegExp(`dispatch ${d.dispatch} is over, so no fetch is recorded`));
    assert.match(page.text, /Escalation /, 'the page itself stays readable');
    assert.equal(reads(), before, 'nothing was recorded');
  } finally { p.cleanup(); }
});
