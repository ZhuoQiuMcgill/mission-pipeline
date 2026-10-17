// A mission through the shell-invoked `mp`, and the copy of its folder (design 4.1 §11 scenarios
// 1, 2, 8 and 12): harness A (one PM filler) records the words, the requirement items and the PM
// plan, dispatches Calibrator ①, the Architect and Calibrator ②, and dispatches the Constructor,
// whose seat is still working when the folder is copied, while no `mp` runs, to another path.
// Harness B (another filler) opens the copy: `mp read status` and `mp pm next` show the same state;
// the in-flight dispatch is released and dispatched again; the mission is built, reviewed,
// delivered and landed there. Every seat is scripted: it reads its card and materials with
// `mp seat`, writes its hand-back files into tmp/<dispatch>/ and hands back. Then the tree reads
// on that mission: `mp read why` from the delivered commit reaches the maintainer's words through
// every handover, each step with its state, checks, who handed it over and its leaf; `mp read
// from`, `chain` and `tree`; a leaf edited by hand is shown, not hidden.
//
// MP_TEST_INPROCESS=1 runs the same scenario through runCli in this process (quicker, for debugging).

import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { addDetailedPlan, addPlan, CHECK_JS, reviewerPass } from './process-fixtures.ts';
import { cardOf, cli, gitProject, handBackFiles, materialPages, sh, write, type Ran } from './cli-fixtures.ts';

const INPROCESS = process.env['MP_TEST_INPROCESS'] === '1';
/** MP_TEST_PRINT=1 prints the tree reads (to look at them). */
const PRINT = process.env['MP_TEST_PRINT'] === '1';
const M = 'm1';

async function mp(cwd: string, ...argv: string[]): Promise<Ran> {
  return INPROCESS ? cli(cwd, argv) : sh(cwd, argv);
}

/** `mp` with a document on its standard input (the no-file hand-back). */
async function mpIn(cwd: string, input: string, ...argv: string[]): Promise<Ran> {
  return INPROCESS ? cli(cwd, argv, { stdin: input }) : sh(cwd, argv, { input });
}

async function ok(cwd: string, ...argv: string[]): Promise<any> {
  const r = await mp(cwd, ...argv, '--json');
  assert.equal(r.code, 0, `mp ${argv.join(' ')} failed (${r.code}):\n${r.out}${r.err}`);
  return r.json;
}

/** One scripted seat step: the one ready step of `kind`, dispatched, its materials read, its hand-back. */
async function seat(
  dir: string,
  kind: string,
  filledBy: string,
  fields: (card: any, dispatch: string) => unknown,
  o: { cwd?: (d: string) => string; before?: (d: string) => void | Promise<void>; form?: 'files' | 'stdin' | 'stdin-json' } = {},
): Promise<{ dispatch: string; answer: any }> {
  const next = await ok(dir, 'pm', 'next');
  const step = (next.result.ready as Array<{ kind: string; step: string }>).find((r) => r.kind === kind);
  assert.ok(step !== undefined, `no ready ${kind}: ${JSON.stringify(next.result.ready)} held ${JSON.stringify(next.result.held)} errors ${JSON.stringify(next.result.errors)}`);
  const d = (await ok(dir, 'pm', 'dispatch', step.step, '--filled-by', filledBy)).result.dispatch as string;
  const card = cardOf(dir, d);
  for (const [m, page] of materialPages(card)) await ok(dir, 'seat', d, 'read', m, '--page', String(page));
  await o.before?.(d);
  const cwd = o.cwd !== undefined ? o.cwd(d) : dir;
  let r: any;
  if (o.form === 'stdin' || o.form === 'stdin-json') {
    // the no-file form: one document on stdin, as a harness whose sub-agents may not write files hands back
    const result = JSON.stringify(fields(card, d), null, 2);
    const doc = o.form === 'stdin' ? `# Report of ${d}\n\nDone as the card says.\n\n\`\`\`json\n${result}\n\`\`\`\n` : `# Report of ${d}\n\nDone as the card says.\n`;
    const x = await mpIn(cwd, doc, 'seat', d, 'handback', '--stdin', ...(o.form === 'stdin-json' ? ['--result-json', result] : []), '--json');
    assert.equal(x.code, 0, `mp seat ${d} handback --stdin failed (${x.code}):\n${x.out}${x.err}`);
    r = x.json;
  } else {
    const f = handBackFiles(dir, d, fields(card, d));
    r = await ok(cwd, 'seat', d, 'handback', '--report', f.report, '--result', f.result);
  }
  assert.equal(r.result.kind, 'recorded', JSON.stringify(r.result));
  return { dispatch: d, answer: r.result };
}

describe('a mission through the shell-invoked mp, copied to another folder mid-way, delivered there (§11.1, §11.2, §11.12)', () => {
  const p = gitProject();
  after(() => p.cleanup());
  const copy = join(p.base, 'copy');

  it('harness A: words, requirements, PM plan, Calibrator ①, Architect, Calibrator ②; the Constructor dispatched', async () => {
    await ok(p.dir, 'init', '--pointer', 'agents');
    const cfgFile = join(p.dir, '.mission-pipeline', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    // 4.1.2: closingChecks is read as the full suite; a task's own check differs from it (only the integration task's Reviewer runs the full suite)
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, closingChecks: [{ id: 'smoke', command: 'node src/check.js --smoke' }] }, null, 2));
    await ok(p.dir, 'config');
    await ok(p.dir, 'pm', 'session', '--filled-by', 'claude-code/opus');
    await ok(p.dir, 'pm', 'mission', 'open', M);
    const w1 = (await ok(p.dir, 'pm', 'say', 'Please write an add function, with a check that it works. The details are yours to decide.')).result.words as string;
    assert.equal(w1, 'W-1');
    await ok(p.dir, 'pm', 'requirement', 'add', M, 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'an add function', '--words', w1);
    await ok(p.dir, 'pm', 'requirement', 'add', M, 'a1', '--type', 'authorization', '--text', "Details are the PM's", '--quote', 'The details are yours to decide', '--words', w1);
    write(p.base, 'plan.json', JSON.stringify(addPlan(M, w1)));
    const plan = await ok(p.dir, 'pm', 'plan', 'submit', M, '--file', join(p.base, 'plan.json'), '--words', w1);
    assert.equal(plan.result.plan, `pmplan.${M}.1`);

    // Calibrator ①: its card from `mp seat card`; a hand-back before the must-read pages are read is refused and does not count
    const next = await ok(p.dir, 'pm', 'next');
    const s1 = next.result.ready[0];
    assert.equal(s1.kind, 'calibrator-1');
    const d1 = await ok(p.dir, 'pm', 'dispatch', s1.step, '--filled-by', 'claude-code/sonnet');
    assert.match(d1.result.prompt, /^You are the Calibrator of Mission Pipeline\. Your card: `mp seat D-1 card`/);
    const text = await mp(p.dir, 'seat', 'D-1', 'card');
    assert.equal(text.code, 0);
    assert.match(text.out, /mp seat D-1 handback --report \.mission-pipeline\/tmp\/D-1\/report\.md --result \.mission-pipeline\/tmp\/D-1\/result\.json/);
    const early = handBackFiles(p.dir, 'D-1', cal1Pass(cardOf(p.dir, 'D-1')));
    const refused = await mp(p.dir, 'seat', 'D-1', 'handback', '--report', early.report, '--result', early.result, '--json');
    assert.equal(refused.code, 3);
    assert.ok(refused.json.result.problems.some((x: string) => x.includes('must-read')));
    for (const [m, page] of materialPages(cardOf(p.dir, 'D-1'))) await ok(p.dir, 'seat', 'D-1', 'read', m, '--page', String(page));
    assert.equal((await ok(p.dir, 'seat', 'D-1', 'handback', '--report', early.report, '--result', early.result)).result.outcome, 'accepted');

    await seat(p.dir, 'architect-decompose', 'codex/gpt-6', () => addDetailedPlan(M), {
      form: 'stdin',
      before: () => {
        /* the Architect reads the project at its card's commit */
      },
    });
    // a document on stdin without its json block is refused (it does not count); the same seat then hands back with one
    const cal2 = await seat(p.dir, 'calibrator-2', 'claude-code/sonnet', (c) => cal2Pass(c), {
      form: 'stdin',
      before: async (d) => {
        const bare = await mpIn(p.dir, '# Report\n\nNo fields here.\n', 'seat', d, 'handback', '--stdin', '--json');
        assert.equal(bare.code, 3);
        assert.equal(bare.json.error.code, 'NO_JSON_BLOCK');
      },
    });
    const leaf = readFileSync(join(p.dir, '.mission-pipeline', 'missions', M, 'dispatches', cal2.dispatch, 'report.md'), 'utf8');
    assert.match(leaf, /^# Report of D-\d+\n\nDone as the card says\./);
    assert.doesNotMatch(leaf, /```json/, 'the report leaf is the report; the fields went to result.json');
    assert.ok(existsSync(join(p.dir, '.mission-pipeline', 'tmp', cal2.dispatch, 'result.json')), 'mp wrote the hand-back files itself');

    const n2 = await ok(p.dir, 'pm', 'next');
    const s4 = n2.result.ready.find((r: { kind: string }) => r.kind === 'constructor');
    const d4 = await ok(p.dir, 'pm', 'dispatch', s4.step, '--filled-by', 'claude-code/sonnet');
    assert.equal(d4.result.dispatch, 'D-4');
    assert.equal(d4.result.worktree, '.mission-pipeline/worktrees/D-4');
    // the seat starts working in its worktree, then the folder is copied while no mp runs
    write(join(p.dir, '.mission-pipeline', 'worktrees', 'D-4'), 'src/add.js', 'exports.add = (a, b) => a - b; // half done\n');
  });

  it('the copy: harness B sees the same state; the in-flight dispatch is released and dispatched again; the mission finishes there', async () => {
    cpSync(p.dir, copy, { recursive: true });
    const st = await ok(copy, 'read', 'status');
    assert.ok(st.problems.some((x: { code: string }) => x.code === 'MOVED'), JSON.stringify(st.problems));
    assert.ok(!st.problems.some((x: { code: string }) => x.code === 'CHAIN_BROKEN' || x.code === 'GIT_WRITES_HELD'));
    assert.deepEqual(st.result.inFlight.map((d: { dispatch: string }) => d.dispatch), ['D-4']);
    assert.equal(st.result.missions[0].mission, M);
    const original = await ok(p.dir, 'read', 'status', '--no-mark');
    assert.deepEqual(original.result.inFlight.map((d: { dispatch: string }) => d.dispatch), ['D-4'], 'the source folder is untouched');

    await ok(copy, 'pm', 'session', '--filled-by', 'codex/gpt-6');
    const n = await ok(copy, 'pm', 'next');
    assert.deepEqual(n.result.inFlight.map((d: { dispatch: string }) => d.dispatch), ['D-4']);
    assert.equal(n.result.ready.length, 0);
    const rel = await ok(copy, 'pm', 'release', 'D-4', '--abandoned');
    assert.equal(rel.result.requeued, true);
    assert.equal(rel.result.worktree, 'kept');

    // the Constructor again, in a new worktree of the copy; it hands back from inside its worktree
    const con = await seat(copy, 'constructor', 'codex/gpt-6', () => ({ done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] }), {
      before: (d) => {
        const wt = join(copy, '.mission-pipeline', 'worktrees', d);
        assert.ok(existsSync(join(wt, 'README.md')));
        write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
        write(wt, 'src/check.js', CHECK_JS);
      },
      cwd: (d) => join(copy, '.mission-pipeline', 'worktrees', d),
    });
    assert.equal(con.dispatch, 'D-5');
    assert.deepEqual(con.answer.candidate.changedPaths, ['src/add.js', 'src/check.js']);
    assert.equal(con.answer.verification[0].passed, true);

    // the Reviewer, another filler: reads the candidate, reruns a declared command (a new run id each time), cites the program's runs
    const reruns: string[] = [];
    const rev = await seat(copy, 'reviewer', 'claude-code/haiku', (c) => reviewerPass(c, reruns.slice(0, 1).map((r) => `evidence:${r}`)), {
      form: 'stdin-json',
      before: async (d) => {
        const co = await ok(copy, 'seat', d, 'checkout');
        assert.ok(existsSync(join(co.result.path, 'src', 'add.js')), 'the Reviewer reads the candidate commit');
        assert.ok(!existsSync(join(co.result.path, 'src', 'data.local')));
        const id = cardOf(copy, d).declaredCommands[0].id as string;
        for (let i = 0; i < 2; i++) reruns.push((await ok(copy, 'seat', d, 'rerun', id)).result.run as string);
        assert.notEqual(reruns[0], reruns[1], 'every rerun executes and gets a new run id (§6.5 sampling)');
      },
    });
    assert.equal(rev.answer.outcome, 'accepted');

    const w2 = (await ok(copy, 'pm', 'say', 'Deliver it.')).result.words as string;
    const del = await ok(copy, 'pm', 'deliver', M, '--outputs', `prod.con.${M}.impl.1`, '--words', w2);
    assert.equal(del.result.result.kind, 'delivered', JSON.stringify(del.result));
    const landed = await ok(copy, 'pm', 'land', del.result.delivery, '--words', w2);
    assert.equal(landed.result.result.kind, 'landed', JSON.stringify(landed.result));
    const main = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: copy, encoding: 'utf8' }).trim();
    assert.equal(main, del.result.result.record.commit);
    assert.ok(existsSync(join(copy, 'src', 'add.js')));
    assert.ok(!existsSync(join(p.dir, 'src', 'add.js')), 'the source folder\'s repository is its own');
  });

  it('mp read why from the delivered commit reaches the words through every handover, each step with its state, checks, handover and leaf', async () => {
    const why = await ok(copy, 'read', 'why', 'main');
    const nodes = why.result.nodes as Array<{ key: string; state: string | null; checks: string | null; by: string | null; leaves: Array<{ path: string; status: string }> }>;
    const keys = nodes.map((n) => n.key);
    for (const k of ['words:W-1', 'words:W-2', `requirement:item.${M}.g1.v1`, `plan:pmplan.${M}.1`, `plan:dplan.${M}.1.1`, 'dispatch:D-2', 'dispatch:D-5', `object:prod.con.${M}.impl.1`, `task:con.${M}.impl.1`, `task:arch.${M}.1.1`]) assert.ok(keys.includes(k), `why main reaches ${k}: ${keys.join(', ')}`);
    // review r1 #7: through the Reviewer: the acceptance names its judgment, the judgment its dispatch and the runs it cites
    for (const k of ['dispatch:D-6', `judgment:j.rev.${M}.impl.1`, `task:rev.${M}.impl.1`]) assert.ok(keys.includes(k), `why main passes the Reviewer (${k}): ${keys.join(', ')}`);
    assert.ok(keys.some((k) => k.startsWith('run:') && k.endsWith('.check')), `why main reaches the cited verification run: ${keys.join(', ')}`);
    assert.ok((why.result.edges as Array<{ from: string; to: string; rel: string }>).some((e) => e.from === `object:prod.con.${M}.impl.1` && e.to === `judgment:j.rev.${M}.impl.1` && e.rel === 'accepted by'));
    assert.match(nodes.find((n) => n.key === `task:con.${M}.impl.1`)!.by!, /handed over by architect-decompose, dispatch D-2/, 'the handover recorded with the task (queuedBy)');
    assert.equal(why.result.reachesWords, true);
    const node = (k: string) => nodes.find((n) => n.key === k)!;
    assert.match(node(`object:prod.con.${M}.impl.1`).by!, /constructor, dispatch D-5 \(codex\/gpt-6\)/);
    assert.match(node(`object:prod.con.${M}.impl.1`).checks!, /verification 1\/1 passed/);
    assert.match(node(`object:prod.con.${M}.impl.1`).state!, /proven/);
    assert.match(node(`plan:dplan.${M}.1.1`).by!, /architect-decompose, dispatch D-2 \(codex\/gpt-6\)/);
    assert.match(node(`plan:dplan.${M}.1.1`).checks!, /mechanical checks passed.*Calibrator ② ?: ?pass|mechanical checks passed/);
    assert.ok(node('dispatch:D-5').leaves.some((l) => l.path.endsWith('dispatches/D-5/report.md') && l.status === 'ok'));
    assert.match(node(`plan:pmplan.${M}.1`).by!, /the PM via `mp pm plan submit` \(claude-code\/opus\)/);
    assert.match(node('words:W-1').by!, /the user/);
    const text = await mp(copy, 'read', 'why', 'main');
    if (PRINT) console.log(`$ mp read why main\n${text.out}`);
    assert.match(text.out, /← quotes "an add function": words W-1/);
    assert.match(text.out, /leaf: \.mission-pipeline\/words\/\d{4}-\d\d-\d\d\.md#/);
  });

  it('mp read from, chain and tree show the same tree from the other sides', async () => {
    const from = await ok(copy, 'read', 'from', 'W-1');
    const fk = (from.result.nodes as Array<{ key: string }>).map((n) => n.key);
    for (const k of [`requirement:item.${M}.g1.v1`, `plan:pmplan.${M}.1`, `object:prod.con.${M}.impl.1`]) assert.ok(fk.includes(k), `from W-1 reaches ${k}`);
    assert.ok(fk.some((k) => k.startsWith('delivery:')), 'what rests on W-1 includes the delivery');

    const chain = await mp(copy, 'read', 'chain', 'D-5');
    assert.equal(chain.code, 0);
    assert.match(chain.out, /Dispatch D-5: constructor on task con\.m1\.impl\.1, filled by codex\/gpt-6/);
    assert.match(chain.out, /planned in: plan dplan\.m1\.1\.1/);
    assert.match(chain.out, /report: \.mission-pipeline\/missions\/m1\/dispatches\/D-5\/report\.md/);
    assert.match(chain.out, /handed back by: object prod\.con\.m1\.impl\.1/);
    const d4 = await mp(copy, 'read', 'chain', 'D-4');
    assert.match(d4.out, /released \(abandoned\)/);
    const d1 = await mp(copy, 'read', 'chain', 'D-1');
    assert.match(d1.out, /a handback was refused: must-read page/, 'the refused hand-back\'s checks are shown');

    const tree = await mp(copy, 'read', 'tree', M);
    if (PRINT) console.log(`$ mp read chain D-5\n${chain.out}\n$ mp read tree ${M}\n${tree.out}\n$ mp read status\n${(await mp(copy, 'read', 'status', '--no-mark')).out}\n$ mp read from W-1\n${(await mp(copy, 'read', 'from', 'W-1')).out}`);
    assert.equal(tree.code, 0, tree.err);
    const lines = tree.out.split('\n');
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const depth = (i: number) => lines[i]!.search(/\S/);
    const w1 = at(/- words W-1 /);
    const g1 = at(/- requirement item\.m1\.g1\.v1 /);
    const pm = at(/- plan pmplan\.m1\.1 /);
    const prod = at(/- object prod\.con\.m1\.impl\.1 /);
    const delivery = at(/- delivery m1\//);
    for (const [name, i] of Object.entries({ w1, g1, pm, prod, delivery })) assert.ok(i > 0, `${name} in the tree:\n${tree.out}`);
    assert.ok(w1 < g1 && g1 < pm && pm < prod && prod < delivery, tree.out);
    // words → requirements and plans → tasks → dispatches → candidates → judgments → deliveries
    assert.ok(depth(w1) < depth(g1) && depth(w1) < depth(pm) && depth(pm) < depth(prod) && depth(prod) < depth(delivery), tree.out);
    const d5 = at(/- dispatch D-5 /);
    assert.ok(d5 > pm && d5 < prod && depth(d5) === depth(prod) - 2, `the candidate sits under the dispatch that handed it back:\n${tree.out}`);
    assert.ok(at(/- judgment j\.rev\.m1\.impl\.1 /) > prod);
    assert.match(lines[delivery]!, /\[recorded, landed\]/);
    assert.ok(at(/- landing land:m1:/) > delivery);

    const show = await ok(copy, 'read', 'show', 'delivery', (await ok(copy, 'read', 'status')).result.missions[0].deliveries[0].delivery);
    assert.equal(show.result.delivery.state, 'recorded');
  });

  it('a leaf edited by hand is shown as edited (U-13: shown, not prevented), and mp read leaf says so', async () => {
    const report = join(copy, '.mission-pipeline', 'missions', M, 'dispatches', 'D-5', 'report.md');
    writeFileSync(report, `${readFileSync(report, 'utf8')}\nedited by hand\n`);
    const why = await mp(copy, 'read', 'why', 'D-5');
    assert.match(why.out, /dispatches\/D-5\/report\.md \(leaf edited after it was recorded\)/);
    const leaf = await mp(copy, 'read', 'leaf', `missions/${M}/dispatches/D-5/report.md`);
    assert.match(leaf.out, /EDITED AFTER IT WAS RECORDED/);
    assert.match(leaf.out, /WI-30/);
  });
});
