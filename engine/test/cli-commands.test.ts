// The `mp` command line (design 4.1 §4.1, §5, §6.6, §8; decisions 1, 3, 4, 8, 9; Appendix E):
// parsing, help and exit codes; the --json envelope; the PM's operation ids (a retry replays, other
// arguments are refused) and its session (every PM command is attributed to the latest session's
// filler); words entries (decision 9: the same text once); refusals with their 4.1 WI; stops
// written directly at a conservative scope; a broken event chain stops every write and
// `mp pm continue-from` resumes it; the project found from any folder below it.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cli, gitProject, type TestProject } from './cli-fixtures.ts';
import { addPlan } from './process-fixtures.ts';

describe('mp: help, parsing and exit codes', () => {
  const p = gitProject();
  after(() => p.cleanup());

  it('prints help; unknown commands and options are usage errors (64)', async () => {
    const none = await cli(p.dir, []);
    assert.equal(none.code, 64);
    assert.match(none.out, /mp pm dispatch/);
    assert.match(none.out, /mp seat <dispatch> handback/);
    assert.match(none.out, /mp read why/);
    assert.equal((await cli(p.dir, ['help'])).code, 0);
    assert.match((await cli(p.dir, ['pm', '--help'])).out, /mp pm release/);
    const usage = await cli(p.dir, ['pm', 'dispatch', '--help']);
    assert.equal(usage.code, 0);
    assert.match(usage.out, /Usage: mp pm dispatch <step> --filled-by/);
    const unknown = await cli(p.dir, ['pm', 'launch', '--json']);
    assert.equal(unknown.code, 64);
    assert.equal(unknown.json.error.code, 'USAGE');
    assert.equal((await cli(p.dir, ['frobnicate'])).code, 64);
  });

  it('without a memory: 78 and "run mp init"; the JSON form says the same', async () => {
    const r = await cli(p.dir, ['read', 'status', '--json']);
    assert.equal(r.code, 78);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'NOT_INITIALIZED');
    assert.match(r.json.error.message, /mp init/);
  });
});

describe('mp pm: operation ids, the PM session, words, refusals', () => {
  let p: TestProject;
  before(async () => {
    p = gitProject();
    assert.equal((await cli(p.dir, ['init'])).code, 0);
  });
  after(() => p.cleanup());

  it('every PM command carries an operation id; the same id again replays, other arguments are refused (65)', async () => {
    const a = await cli(p.dir, ['pm', 'mission', 'open', 'm1', '--op', 'open-m1', '--json']);
    assert.equal(a.code, 0, a.out);
    assert.deepEqual([a.json.ok, a.json.op, a.json.replayed, a.json.command], [true, 'open-m1', false, 'pm mission']);
    assert.deepEqual([a.json.result.mission, a.json.result.state], ['m1', 'open']);
    const b = await cli(p.dir, ['pm', 'mission', 'open', 'm1', '--op', 'open-m1', '--json']);
    assert.equal(b.json.replayed, true);
    assert.deepEqual(b.json.result, a.json.result);
    const c = await cli(p.dir, ['pm', 'mission', 'open', 'm2', '--op', 'open-m1', '--json']);
    assert.equal(c.code, 65);
    assert.equal(c.json.error.code, 'OP_CONFLICT');
    const generated = await cli(p.dir, ['pm', 'mission', 'list']);
    assert.match(generated.out, /\(operation mission-[a-z0-9]+-[0-9a-f]{6}\)/);
    assert.match(generated.out, /m1: open/);
  });

  it('decision 8: every mp pm command is attributed to the latest session\'s filler; --filled-by overrides one command', async () => {
    const s = await cli(p.dir, ['pm', 'session', '--filled-by', 'codex/gpt-6', '--json']);
    assert.equal(s.code, 0, s.out);
    assert.deepEqual(s.json.result.filler, { harness: 'codex', model: 'gpt-6' });
    await cli(p.dir, ['pm', 'say', 'Hello there.', '--op', 'say-1']);
    await cli(p.dir, ['pm', 'mission', 'open', 'm3', '--op', 'open-m3', '--filled-by', 'claude-code/opus']);
    const db = new DatabaseSync(join(p.dir, '.mission-pipeline', 'memory.db'), { readOnly: true });
    try {
      const row = (op: string) => db.prepare('SELECT command, harness, model FROM pm_commands WHERE op = ?').get(op) as { command: string; harness: string; model: string };
      assert.deepEqual({ ...row('pm:say-1') }, { command: 'say', harness: 'codex', model: 'gpt-6' });
      assert.deepEqual({ ...row('pm:open-m3') }, { command: 'mission open', harness: 'claude-code', model: 'opus' });
    } finally {
      db.close();
    }
    const usage = await cli(p.dir, ['pm', 'session']);
    assert.equal(usage.code, 64, 'a session names its filler');
  });

  it('decision 9: the same text as the latest entry is the same W-<n>; words that look like a stop get a hint', async () => {
    const a = await cli(p.dir, ['pm', 'say', 'Please add a subtract function too.', '--json']);
    const b = await cli(p.dir, ['pm', 'say', 'Please add a subtract function too.', '--json']);
    assert.equal(a.json.result.words, b.json.result.words);
    assert.equal(b.json.result.repeated, true);
    const stdin = await cli(p.dir, ['pm', 'say', '--stdin', '--json'], { stdin: 'Line one.\nLine two, verbatim.' });
    assert.equal(stdin.json.result.repeated, false);
    const s = await cli(p.dir, ['pm', 'say', '先停一下']);
    assert.match(s.out, /look like a stop/);
  });

  it('a requirement quotes its words entry verbatim (refused otherwise, 3); --words names an existing entry (decision 1)', async () => {
    const w = (await cli(p.dir, ['pm', 'say', 'I want an add function. Details are yours.', '--json'])).json.result.words as string;
    const bad = await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'a multiply function', '--words', w, '--json']);
    assert.equal(bad.code, 3);
    assert.match(bad.json.error.message, /verbatim/);
    assert.equal((await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'an add function'])).code, 64, '--words is required');
    assert.equal((await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'x', '--quote', 'x', '--words', 'W-99'])).code, 3);
    const good = await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'an add function', '--words', w, '--json']);
    assert.equal(good.code, 0, good.err);
    assert.equal(good.json.result.version, 'item.m1.g1.v1');
  });

  it('the project is found from any folder below it, or with --project', async () => {
    mkdirSync(join(p.dir, 'deep', 'er'), { recursive: true });
    const r = await cli(join(p.dir, 'deep', 'er'), ['read', 'status', '--json', '--no-mark']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.result.project, p.dir);
    const q = await cli(p.base, ['read', 'status', '--project', 'project', '--json', '--no-mark']);
    assert.equal(q.code, 0, q.err);
  });

  it('mp config validates config.json; a broken one is refused with what is wrong', async () => {
    const ok = await cli(p.dir, ['config', '--json']);
    assert.equal(ok.code, 0);
    assert.equal(ok.json.result.targetBranch, 'main');
    assert.deepEqual(ok.json.result.environment.versionCommands, ['node --version']);
    const file = join(p.dir, '.mission-pipeline', 'config.json');
    const good = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...good, closingChecks: [{ id: 'bad id!', command: '' }] }));
    const bad = await cli(p.dir, ['config', '--json']);
    assert.equal(bad.code, 3);
    assert.equal(bad.json.error.code, 'BAD_CONFIG');
    writeFileSync(file, JSON.stringify(good));
  });
});

describe('mp pm stop: written directly, at a conservative scope (§6.6, Appendix E)', () => {
  let p: TestProject;
  before(async () => {
    p = gitProject();
    await cli(p.dir, ['init']);
    await cli(p.dir, ['pm', 'mission', 'open', 'm1']);
  });
  after(() => p.cleanup());

  it('a generic stop with one open mission restricts that mission; it is linked to the words entry that holds it', async () => {
    const w = (await cli(p.dir, ['pm', 'say', '停一下，先别做了', '--json'])).json.result.words as string;
    const s = await cli(p.dir, ['pm', 'stop', '停一下，先别做了', '--json']);
    assert.equal(s.code, 0, s.err);
    assert.deepEqual(s.json.result.scope, { kind: 'mission', mission: 'm1' });
    assert.equal(s.json.problems.length, 0);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.json.result.stops.length, 1);
    assert.equal(st.json.result.stops[0].wordsEntry, w);
    const id = s.json.result.stop as string;
    // narrowing only shrinks a scope
    const wide = await cli(p.dir, ['pm', 'stop-narrow', id, '--scope', 'all', '--json']);
    assert.equal(wide.code, 3);
    assert.equal(wide.json.error.code, 'NOT_NARROWER');
    const rel = await cli(p.dir, ['pm', 'stop-release', id, '--json']);
    assert.equal(rel.json.result.released, true);
    assert.equal((await cli(p.dir, ['pm', 'stop-release', id, '--json'])).json.result.released, false);
  });

  it('two open missions, none named: everything; --scope sets it; a scope naming no possible mission widens', async () => {
    await cli(p.dir, ['pm', 'mission', 'open', 'm2']);
    assert.deepEqual((await cli(p.dir, ['pm', 'stop', 'stop', '--json'])).json.result.scope, { kind: 'all' });
    assert.deepEqual((await cli(p.dir, ['pm', 'stop', 'stop m2', '--scope', 'mission:m2', '--json'])).json.result.scope, { kind: 'mission', mission: 'm2' });
    assert.deepEqual((await cli(p.dir, ['pm', 'stop', 'stop', '--scope', 'mission:../x', '--json'])).json.result.scope, { kind: 'all' });
  });

  it('review r1 #1: words that ask for everything restrict everything, even when they name one mission (two open)', async () => {
    assert.deepEqual((await cli(p.dir, ['pm', 'stop', 'Stop everything, including m1', '--json'])).json.result.scope, { kind: 'all' });
    assert.deepEqual((await cli(p.dir, ['pm', 'stop', '全部停下，包括 m1', '--json'])).json.result.scope, { kind: 'all' });
    assert.deepEqual((await cli(p.dir, ['pm', 'stop', 'stop m1', '--json'])).json.result.scope, { kind: 'mission', mission: 'm1' }, 'one named mission still narrows a stop without a global word');
  });

  it('review r1 #5: a broken config.json never blocks a stop (other commands still refuse it)', async () => {
    const file = join(p.dir, '.mission-pipeline', 'config.json');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, '{ not json');
    let id = '';
    try {
      const s = await cli(p.dir, ['pm', 'stop', '停', '--json']);
      assert.equal(s.code, 0, s.out + s.err);
      id = s.json.result.stop as string;
      assert.equal((await cli(p.dir, ['read', 'status', '--json'])).json.error.code, 'BAD_CONFIG');
    } finally {
      writeFileSync(file, good);
    }
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.ok(st.json.result.stops.some((x: { stop: string }) => x.stop === id), 'the stop written with a broken config is in the memory');
  });
});

describe('review r1 #3: mp pm close goes through the process layer (pmClose)', () => {
  let p: TestProject;
  before(async () => {
    p = gitProject();
    await cli(p.dir, ['init']);
    await cli(p.dir, ['pm', 'mission', 'open', 'm1']);
    const w = (await cli(p.dir, ['pm', 'say', 'Write an add function. The details are yours to decide.', '--json'])).json.result.words as string;
    await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'add', '--quote', 'Write an add function', '--words', w]);
    await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'a1', '--type', 'authorization', '--text', 'details', '--quote', 'The details are yours to decide', '--words', w]);
    writeFileSync(join(p.base, 'plan.json'), JSON.stringify(addPlan('m1', w)).replace('an add function', 'Write an add function'));
    await cli(p.dir, ['pm', 'plan', 'submit', 'm1', '--file', join(p.base, 'plan.json'), '--words', w]);
  });
  after(() => p.cleanup());

  it('a full close with work unfinished is refused; with-risk closes and holds the queued step (not cancelled)', async () => {
    const ready = (await cli(p.dir, ['pm', 'next', '--json'])).json.result.ready as Array<{ step: string }>;
    assert.equal(ready.length, 1);
    const full = await cli(p.dir, ['pm', 'close', 'm1', '--mode', 'full', '--json']);
    assert.equal(full.code, 3, full.out);
    assert.match(full.json.error.message, /unfinished/);
    const risk = await cli(p.dir, ['pm', 'close', 'm1', '--mode', 'with-risk', '--json']);
    assert.equal(risk.code, 0, risk.err);
    assert.equal(risk.json.result.mode, 'with-risk');
    const next = (await cli(p.dir, ['pm', 'next', '--json'])).json.result;
    assert.equal(next.ready.length, 0);
    assert.deepEqual(next.held.map((h: { step: string }) => h.step), [ready[0]!.step], 'the production step is held, not cancelled');
  });
});

describe('mp pm plan template: the PM plan\'s format, discoverable and prefilled', () => {
  let p: TestProject;
  before(async () => {
    p = gitProject();
    await cli(p.dir, ['init']);
    await cli(p.dir, ['pm', 'mission', 'open', 'm1']);
    await cli(p.dir, ['pm', 'say', 'Write an add function. The details are yours to decide.']);
    await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'Write an add function', '--words', 'W-1']);
    await cli(p.dir, ['pm', 'requirement', 'add', 'm1', 'a1', '--type', 'authorization', '--text', 'details', '--quote', 'The details are yours to decide', '--words', 'W-1']);
  });
  after(() => p.cleanup());

  it('prints an annotated skeleton prefilled with the requirement items; it validates as it is; a bad plan names the template', async () => {
    assert.match((await cli(p.dir, ['help', 'pm', 'plan'])).out, /mp pm plan template <mission>/);
    const t = await cli(p.dir, ['pm', 'plan', 'template', 'm1', '--json']);
    assert.equal(t.code, 0, t.err);
    const tpl = t.json.result.template;
    assert.equal(tpl.format, 'mp4.pm-plan.v1');
    assert.deepEqual(tpl.elements.map((e: { items: string[] }) => e.items), [['g1']]);
    assert.deepEqual(tpl.elements[0].provenance, { by: 'user', words: 'W-1', quote: 'Write an add function' });
    assert.deepEqual(tpl.authorizations, ['a1']);
    assert.ok(typeof tpl._note === 'string' && tpl._exploration_example.exploration.fuzzyGoal !== undefined);
    const text = await cli(p.dir, ['pm', 'plan', 'template', 'm1']);
    assert.match(text.out, /mp pm plan submit m1 --file plan\.json --words W-1/);
    const file = join(p.base, 'plan.json');
    assert.equal((await cli(p.dir, ['pm', 'plan', 'template', 'm1', '--file', file])).code, 0);
    const sub = await cli(p.dir, ['pm', 'plan', 'submit', 'm1', '--file', file, '--words', 'W-1', '--json']);
    assert.equal(sub.code, 0, sub.out + sub.err);
    writeFileSync(join(p.base, 'bad.json'), JSON.stringify({ format: 'mp4.pm-plan.v1', mission: 'm1', elements: [] }));
    const bad = await cli(p.dir, ['pm', 'plan', 'submit', 'm1', '--file', join(p.base, 'bad.json'), '--words', 'W-1', '--json']);
    assert.equal(bad.code, 3, bad.out);
    assert.equal(bad.json.error.code, 'BAD_PLAN');
    assert.match(bad.json.error.message, /mp pm plan template m1/);
  });
});

describe('a broken event chain stops every write (WI-29); continue-from resumes (decision 4)', () => {
  let p: TestProject;
  before(async () => {
    p = gitProject();
    await cli(p.dir, ['init']);
    await cli(p.dir, ['pm', 'mission', 'open', 'm1']);
    await cli(p.dir, ['pm', 'say', 'first words']);
    await cli(p.dir, ['pm', 'say', 'second words']);
  });
  after(() => p.cleanup());

  it('reads report the break with the last valid event; writes are refused naming WI-29; continue-from cuts and rebuilds', async () => {
    const db = new DatabaseSync(join(p.dir, '.mission-pipeline', 'memory.db'));
    const head = Number((db.prepare('SELECT MAX(rev) AS r FROM log').get() as { r: number }).r);
    // the last event edited by hand: every open checks the log's structure and its last event
    db.prepare("UPDATE log SET record = record || ' ' WHERE rev = ?").run(head);
    db.close();
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    const broken = (st.json.problems as Array<{ code: string; wi: string; message: string }>).find((x) => x.code === 'CHAIN_BROKEN');
    assert.ok(broken !== undefined, JSON.stringify(st.json));
    assert.equal(broken.wi, 'WI-29');
    const w = await cli(p.dir, ['pm', 'say', 'third words', '--json']);
    assert.equal(w.code, 3);
    assert.equal(w.json.error.wi, 'WI-29');
    const last = Number(/the last valid event is (\d+)/.exec(broken.message)![1]);
    assert.equal((await cli(p.dir, ['pm', 'continue-from', String(last + 5), '--json'])).json.error.code, 'NOT_LAST_VALID');
    const c = await cli(p.dir, ['pm', 'continue-from', String(last), '--json']);
    assert.equal(c.code, 0, c.err);
    assert.equal(c.json.result.continued, true);
    const again = await cli(p.dir, ['pm', 'say', 'third words', '--json']);
    assert.equal(again.code, 0, again.err);
    assert.equal((await cli(p.dir, ['read', 'status', '--json', '--no-mark'])).json.problems.length, 0);
  });
});
