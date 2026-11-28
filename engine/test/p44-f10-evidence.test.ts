// 4.4 (F10, ruling E-4 as the PM design applies it; issue 65): evidence outside the commit. A declared
// command may name the files it writes; when mp runs it on the candidate's checkout it keeps them with the
// run's record, and the Reviewer's card lists them under the run it cites. A file the Constructor's
// hand-back names is checked by its sha256 and size, copied before its hand-back folder is removed, and
// listed on the Reviewer's card with the attempt that handed it in, labelled outside the commit; the
// Reviewer may cite it (whether it shows this candidate is its judgment), also once the original is gone.
// A judgment that cites such data is not renewed mechanically: the default is a new review. The seat's
// hand-back folder is removed only after the hand-back command has printed its result.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { canonicalJson } from '../src/common/hash.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from '../src/flow/openItems.ts';
import { personItemId } from '../src/flow/riskItems.ts';
import { renewalCandidates } from '../src/evaluator/index.ts';
import { flowEvents, dispatchInfo } from '../src/memory/index.ts';
import { pmDispatch, pmNext, pmRenew, recordSeatHandBack, seatFullRun, seatHandback, seatRerun, sweepTmp } from '../src/process/index.ts';
import { ownDeclaredFiles, recordedGroup, renewalGroupKey, runOnCommit } from '../src/process/runs.ts';
import { dispatchView } from '../src/process/seat.ts';
import { handbackDoc } from '../src/process/ports.ts';
import { artifactLines, renderSeatCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { addDetailedPlan, CHECK_JS, ENV_A, ENV_B, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';
import { project43 } from './p43-fixtures.ts';
import { CAN_SYMLINK, NO_SYMLINK } from './git-fixtures.test.ts';

// 4.4.1 (Windows): a link to a file needs Developer Mode or the right to create one there
const LINKS = { skip: CAN_SYMLINK ? false : NO_SYMLINK };

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

/** The add mission's plan whose standard is checked by an artifact its verification command writes. */
function artifactPlan(commands: unknown[] = [{ id: 'check', command: 'node src/check.js > check.log', artifacts: ['check.log', 'missing.txt'] }]): unknown {
  const p = addDetailedPlan('m1') as { tasks: Array<Record<string, unknown>> };
  return { ...p, tasks: p.tasks.map((t) => ({ ...t, standards: [{ id: 'S1', text: 'add(2, 3) is 5, as check.log shows', check: 'artifact' }], verificationCommands: commands })) };
}

/** The mission up to its Constructor's dispatch, its worktree written. */
async function toConstructor(p: ProcessProject, plan: unknown = artifactPlan()): Promise<string> {
  const ctx = p.ctx;
  await startAddMission(ctx, 'm1');
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(ctx, 'architect-decompose', () => plan);
  await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
  const s = await readyOf(ctx, 'constructor');
  const d = pmDispatch(ctx, s.step);
  const wt = join(p.dir, d.worktree!);
  write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
  write(wt, 'src/check.js', CHECK_JS);
  return d.dispatch;
}

const constructorFields = (files: string[]): unknown => ({ done: 'implemented add; the simulator log is attached', unmet_standards: [], unfixed_problems: [], decisions_needed: [], files });

test('a run keeps the files its command names; the Constructor\'s handed-in file is checked, kept and listed with its attempt; the Reviewer cites it after its folder is gone; such a judgment is not renewed mechanically', async () => {
  const p = project43();
  try {
    const ctx = p.ctx;
    const con = await toConstructor(p);
    const dir = join(ctx.memory.paths.tmp, con);
    mkdirSync(dir, { recursive: true });
    const log = 'simulator: 12 rows\n';
    writeFileSync(join(dir, 'sim.log'), log);
    const pointer = `data:${join(dir, 'sim.log')}#sha256=${sha(log)}&size=${Buffer.byteLength(log)}`;
    // a pointer whose sha256 is not the file's is refused, and the folder stays for the fix
    const wrong = await handBack(ctx, con, constructorFields([`data:${join(dir, 'sim.log')}#sha256=${'0'.repeat(64)}&size=${Buffer.byteLength(log)}`]));
    assert.equal(wrong.kind, 'refused');
    assert.ok(wrong.kind === 'refused' && wrong.problems.some((x) => x.startsWith('files[0]: ') && x.includes(`the file's sha256 is ${sha(log)}`)), JSON.stringify(wrong));
    assert.ok(existsSync(dir));
    const a = await handBack(ctx, con, constructorFields([pointer]));
    assert.equal(a.kind, 'recorded');
    assert.ok(a.kind === 'recorded' && a.notes.includes(`Kept with this hand-back: ${join(dir, 'sim.log')} (a copy at .mission-pipeline/files/${sha(log)})`), JSON.stringify(a));
    assert.equal(readFileSync(join(ctx.memory.paths.root, 'files', sha(log)), 'utf8'), log, 'the copy is in the memory folder, by its content');
    assert.ok(!existsSync(dir), 'the hand-back folder is removed once recorded (here: a direct call, no output to wait for)');
    const doc = ctx.memory.read((db) => handbackDoc(ctx.memory.data, dispatchInfo(db, con)!))!;
    assert.deepEqual(doc.data?.map((x) => [x.pointer, x.label, x.kept]), [[pointer, 'outside the commit (sha256 checked at hand-back)', `files/${sha(log)}`]]);
    // the verification run kept what its command wrote, and says what it did not write
    const kept = ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: 'artifacts', event: 'kept' }));
    assert.equal(kept.length, 1);
    const r = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, r.step, { filledBy: 'h/reviewer' });
    const card = dispatchView(ctx, rd.dispatch).card as unknown as ReviewerCard;
    const arts = card.verificationRuns[0]!.artifacts!;
    assert.equal(arts[0]!.path, 'check.log');
    assert.match(arts[0]!.kept!, /^\.mission-pipeline\/files\/[0-9a-f]{64}$/);
    assert.match(readFileSync(join(p.dir, arts[0]!.kept!), 'utf8'), /ok 1 - adds two numbers/, 'the kept file is what the command wrote');
    assert.deepEqual(arts[1], { path: 'missing.txt', why: 'the run did not write it' });
    assert.deepEqual(card.handedIn, [{ pointer, attempt: 1, dispatch: con, label: 'outside the commit (sha256 checked at hand-back)', kept: `.mission-pipeline/files/${sha(log)}` }]);
    const rendered = renderSeatCard(card as never, { dispatch: rd.dispatch });
    assert.ok(rendered.includes(`  file it wrote: check.log (sha256 ${arts[0]!.sha256}, ${arts[0]!.size} bytes), kept at ${arts[0]!.kept}`), rendered);
    assert.ok(rendered.includes(`- ${pointer}\n  handed in with attempt 1 (dispatch ${con}); outside the commit (sha256 checked at hand-back); a copy is kept at .mission-pipeline/files/${sha(log)}`), rendered);
    const summary = readFileSync(join(ctx.memory.paths.root, ...`missions/m1/runs/${String(card.verificationRuns[0]!.evidence).split('.')[0]}.md`.split('/')), 'utf8');
    assert.match(summary, /- Files it names:\n {2}- check\.log: kept at \.mission-pipeline\/files\/[0-9a-f]{64} \(sha256 [0-9a-f]{64}, \d+ bytes\)\n {2}- missing\.txt: not kept \(the run did not write it\)/);
    // a rerun keeps them too, and says so
    const rerun = await seatRerun(ctx, rd.dispatch, 'check');
    assert.equal(rerun.artifacts?.[0]?.path, 'check.log');
    assert.match(rerun.artifacts?.[0]?.kept ?? '', /^\.mission-pipeline\/files\//);
    // the Reviewer cites the handed-in file, whose original is gone: checked on the copy mp kept
    readAll(ctx, rd.dispatch);
    const fields = { judgments: [{ standard: 'S1', met: 'yes', reason: 'check.log and the simulator log agree', evidence: [`evidence:${card.verificationRuns[0]!.evidence}`, pointer] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' };
    const rv = await handBack(ctx, rd.dispatch, fields);
    assert.equal(rv.kind, 'recorded', JSON.stringify(rv));
    const rdoc = ctx.memory.read((db) => handbackDoc(ctx.memory.data, dispatchInfo(db, rd.dispatch)!))!;
    assert.deepEqual(rdoc.data?.map((x) => x.label), ['outside the commit (sha256 checked at hand-back, on the copy mp kept when the Constructor handed it in)']);
    assert.equal(ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: 'outside-data', event: 'cited' })).map((e) => e.key).join(','), `j.${r.step}`);
    // after an environment change, the judgment resting on that observation needs a new review
    p.reopen(ENV_B).environment();
    const rc = p.ctx.memory.read((db) => renewalCandidates(db));
    const j = rc.reviews.find((x) => x.judgment === `j.${r.step}`);
    assert.ok(j !== undefined && !j.renewable, JSON.stringify(rc));
    assert.equal(j.reason, 'it cites data outside the commit, which a rerun does not repeat: a new review');
    p.reopen(ENV_A);
  } finally { p.cleanup(); }
});

test('issue 65: mp seat handback removes its folder only after it has printed its result; a refused hand-back keeps it', async () => {
  const p = project43();
  try {
    const con = await toConstructor(p);
    const dir = join(p.ctx.memory.paths.tmp, con);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), '# Report\n\nDone.\n');
    const run = async (fields: unknown): Promise<{ code: number; out: string; present: boolean | null }> => {
      writeFileSync(join(dir, 'result.json'), JSON.stringify(fields));
      let present: boolean | null = null;
      let out = '';
      const r = await runCli(['seat', con, 'handback', '--report', `.mission-pipeline/tmp/${con}/report.md`, '--result', `.mission-pipeline/tmp/${con}/result.json`], { cwd: p.dir, env: {}, out: async (text) => { out += text; present = existsSync(dir); }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' } } });
      return { code: r.exitCode, out: out + r.stdout + r.stderr, present };
    };
    const refused = await run({ done: 'x' });
    assert.notEqual(refused.code, 0);
    assert.ok(existsSync(dir), 'a refused hand-back keeps the folder for the fix');
    const ok = await run(constructorFields([]));
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, new RegExp(`Hand-back of ${con} recorded`));
    assert.equal(ok.present, true, 'the folder is there while the result is printed');
    assert.ok(!existsSync(dir), 'and removed after');
    // a direct caller that asks to keep the folder keeps it until it removes it
    const q = project43();
    try {
      const c2 = await toConstructor(q);
      const d2 = join(q.ctx.memory.paths.tmp, c2);
      mkdirSync(d2, { recursive: true });
      const a = await recordSeatHandBack(q.ctx, c2, { report: '# r\n', fields: constructorFields([]), keepScratch: true, advance: false });
      assert.equal(a.kind, 'recorded');
      assert.ok(existsSync(d2));
    } finally { q.cleanup(); }
  } finally { p.cleanup(); }
});

test('keeping a file is bounded and never throws: over the size or the count, a link, a file changed since its check: recorded with why', async () => {
  const { keepBudget, keepFile } = await import('../src/process/keptFiles.ts');
  const { mkdtempSync, symlinkSync, truncateSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'mp-keep-'));
  try {
    const root = join(base, 'memory');
    mkdirSync(root);
    writeFileSync(join(base, 'a.log'), 'a\n');
    assert.deepEqual(await keepFile(root, join(base, 'a.log'), keepBudget()), { kept: `files/${sha('a\n')}`, sha256: sha('a\n'), size: 2 });
    assert.match((await keepFile(root, join(base, 'a.log'), { files: 0, bytes: 1 << 20 }) as { why: string }).why, /^more than 20 files/);
    assert.match((await keepFile(root, join(base, 'a.log'), keepBudget(), { sha256: '0'.repeat(64), size: 2 }) as { why: string }).why, /the file changed after it was checked/);
    // a link to a folder (on Windows a junction, which any account may make; the link to a file: the next test)
    mkdirSync(join(base, 'folder'));
    symlinkSync(join(base, 'folder'), join(base, 'link-dir'), 'junction');
    assert.equal((await keepFile(root, join(base, 'link-dir'), keepBudget()) as { why: string }).why, 'it is a link, not a regular file');
    writeFileSync(join(base, 'big.bin'), '');
    truncateSync(join(base, 'big.bin'), 64 * 1024 * 1024 + 1);
    assert.match((await keepFile(root, join(base, 'big.bin'), keepBudget()) as { why: string }).why, /over the 64 MiB a kept file may have/);
    assert.equal((await keepFile(root, join(base, 'none.log'), keepBudget()) as { why: string }).why, 'no such file');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('keeping a file: a link to a file is not followed, recorded with why', LINKS, async () => {
  const { keepBudget, keepFile } = await import('../src/process/keptFiles.ts');
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'mp-keep-'));
  try {
    const root = join(base, 'memory');
    mkdirSync(root);
    writeFileSync(join(base, 'a.log'), 'a\n');
    symlinkSync(join(base, 'a.log'), join(base, 'link.log'));
    assert.equal((await keepFile(root, join(base, 'link.log'), keepBudget()) as { why: string }).why, 'it is a link, not a regular file');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

/** The add mission through its Constructor (no file handed in) to its Reviewer, which passes citing the verification run: the judgment and the dispatch. */
async function reviewedOnRun(p: ProcessProject, plan: unknown): Promise<{ judgment: string; reviewer: string }> {
  const ctx = p.ctx;
  const con = await toConstructor(p, plan);
  const a = await handBack(ctx, con, constructorFields([]));
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  const r = await readyOf(ctx, 'reviewer');
  const rd = pmDispatch(ctx, r.step, { filledBy: 'h/reviewer' });
  readAll(ctx, rd.dispatch);
  const card = dispatchView(ctx, rd.dispatch).card as unknown as ReviewerCard;
  const fields = { judgments: card.standards.map((s) => ({ standard: s.id, met: 'yes', reason: 'check.log says so', evidence: card.verificationRuns.map((x) => `evidence:${x.evidence}`) })), gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' };
  const rv = await handBack(ctx, rd.dispatch, fields);
  assert.equal(rv.kind, 'recorded', JSON.stringify(rv));
  return { judgment: `j.${r.step}`, reviewer: rd.dispatch };
}

test('review p9-2: after an environment change, a pass on a run whose command names files is renewed only when the rerun writes the same files', async () => {
  // 4.4.1 (Windows): the commands run under cmd.exe there too, so the file's changing part is written by node, not by date(1)
  const stamp = `node -e "require('fs').appendFileSync('check.log', String(process.hrtime.bigint()))"`;
  for (const [command, renews] of [['node src/check.js > check.log', true], [`node src/check.js > check.log && ${stamp}`, false]] as const) {
    const p = project43();
    try {
      const { judgment } = await reviewedOnRun(p, artifactPlan([{ id: 'check', command, artifacts: ['check.log'] }]));
      p.reopen(ENV_B).environment();
      const r = await pmRenew(p.ctx, { mission: 'm1' });
      const rerun = r.reruns.find((x) => x.renewed.includes(judgment) || x.refused.some((f) => f.judgment === judgment));
      assert.ok(rerun !== undefined, JSON.stringify(r));
      if (renews) assert.deepEqual(rerun.renewed, [judgment], 'the same files: renewed as before');
      else {
        assert.deepEqual(rerun.renewed, []);
        assert.match(rerun.refused.find((f) => f.judgment === judgment)!.reason, /^the record does not show that it repeated check\.log as the original run kept it \(missing, another sha256, no recorded hash, or not shown to be written by it\): a new review$/);
        const needed = p.ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: 'renew', event: 'review-needed' }));
        assert.ok(needed.some((e) => e.key.startsWith(`${judgment}@`)), 'the existing re-review path takes it');
      }
    } finally { p.cleanup(); }
  }
});

test('review p9-7: a named file an earlier command of the run wrote, unchanged by the command that names it, is kept with its origin not established', async () => {
  const p = project43();
  try {
    const ctx = p.ctx;
    const con = await toConstructor(p, artifactPlan([{ id: 'prep', command: 'echo prepared > report.json' }, { id: 'check', command: 'node src/check.js', artifacts: ['report.json'] }]));
    const a = await handBack(ctx, con, constructorFields([]));
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    const r = await readyOf(ctx, 'reviewer');
    const card = dispatchView(ctx, pmDispatch(ctx, r.step).dispatch).card as unknown as ReviewerCard;
    const check = card.verificationRuns.find((x) => x.command === 'node src/check.js')!;
    assert.equal(check.artifacts?.[0]?.origin, 'not-established');
    assert.match(check.artifacts?.[0]?.kept ?? '', /^\.mission-pipeline\/files\//, 'it is kept all the same');
    const text = renderSeatCard(card as never, { dispatch: 'D-x' });
    assert.ok(text.includes('  file there after it, unchanged from before it ran (that it wrote it is not established): report.json'), text);
    assert.ok(!text.includes('file it wrote: report.json'));
  } finally { p.cleanup(); }
});

test('review p9-5, p9-6: a Reviewer\'s cited file in its own folder is copied before its hand-back is recorded; one that cannot be copied keeps the folder; a sweep and a retry after the record lose nothing', async () => {
  const p = project43();
  try {
    const ctx = p.ctx;
    const con = await toConstructor(p);
    const cdir = join(ctx.memory.paths.tmp, con);
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, 'sim.log'), 'rows: 3\n');
    const handed = `data:${join(cdir, 'sim.log')}#sha256=${sha('rows: 3\n')}&size=8`;
    // the seat's command leaves its folder until it has printed; a sweep by another process after the record loses nothing
    const writeFiles = (dir: string, fields: unknown): void => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'report.md'), '# r\n'); writeFileSync(join(dir, 'result.json'), JSON.stringify(fields)); };
    writeFiles(cdir, constructorFields([handed]));
    const a = await seatHandback(ctx, con, { report: `.mission-pipeline/tmp/${con}/report.md`, result: `.mission-pipeline/tmp/${con}/result.json`, keepScratch: true });
    assert.equal(a.kind, 'recorded');
    assert.ok(existsSync(cdir));
    sweepTmp(ctx, { budgetMs: 10_000 });
    assert.ok(!existsSync(cdir), 'the sweep removed the folder');
    assert.equal(readFileSync(join(ctx.memory.paths.root, 'files', sha('rows: 3\n')), 'utf8'), 'rows: 3\n', 'what the hand-back named was copied before its record');
    const again = await recordSeatHandBack(ctx, con, { report: '# r\n', fields: constructorFields([handed]), advance: false });
    assert.ok(again.kind === 'recorded' && again.repeated, 'an identical retry after the record: nothing new, nothing lost');
    // the Reviewer cites a measurement written to its own folder, and one too large to keep
    const r = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, r.step);
    readAll(ctx, rd.dispatch);
    const rdir = join(ctx.memory.paths.tmp, rd.dispatch);
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, 'measure.log'), 'latency 12 ms\n');
    const measured = `data:${join(rdir, 'measure.log')}#sha256=${sha('latency 12 ms\n')}&size=14`;
    const card = dispatchView(ctx, rd.dispatch).card as unknown as ReviewerCard;
    const judge = (evidence: string[]) => ({ judgments: [{ standard: 'S1', met: 'yes', reason: 'measured', evidence: [`evidence:${card.verificationRuns[0]!.evidence}`, ...evidence] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' });
    writeFileSync(join(rdir, 'big.bin'), '');
    truncateSync(join(rdir, 'big.bin'), 64 * 1024 * 1024 + 1);
    const big = `data:${join(rdir, 'big.bin')}#sha256=${sha(Buffer.alloc(64 * 1024 * 1024 + 1))}&size=${64 * 1024 * 1024 + 1}`;
    const rv = await recordSeatHandBack(ctx, rd.dispatch, { report: '# r\n', fields: judge([measured, big]), advance: false });
    assert.equal(rv.kind, 'recorded', JSON.stringify(rv));
    const doc = ctx.memory.read((db) => handbackDoc(ctx.memory.data, dispatchInfo(db, rd.dispatch)!))!;
    assert.equal(doc.data?.find((x) => x.pointer === measured)?.kept, `files/${sha('latency 12 ms\n')}`, 'the measurement is kept, and the record says where');
    assert.match(doc.data?.find((x) => x.pointer === big)?.notKept ?? '', /over the 64 MiB/);
    assert.equal(readFileSync(join(ctx.memory.paths.root, 'files', sha('latency 12 ms\n')), 'utf8'), 'latency 12 ms\n');
    assert.ok(existsSync(join(rdir, 'big.bin')), 'a file that could not be copied keeps the folder');
    assert.ok(rv.kind === 'recorded' && rv.keepScratch === true && rv.notes.some((n) => n.includes(`.mission-pipeline/tmp/${rd.dispatch}/ is left in place: ${join(rdir, 'big.bin')} could not be copied`)), JSON.stringify(rv));
  } finally { p.cleanup(); }
});

test('review p9-2 (round 2): a renewal is mechanical only when the record shows the rerun repeated the file: no recorded hash, or a file not shown to be written by the command, goes to a new review', async () => {
  // 4.4.1 (Windows): a file over the 64 MiB a kept file may have, written by node rather than truncate(1), so cmd.exe runs it too
  const big = `node -e "require('fs').writeFileSync('big.bin', ''); require('fs').truncateSync('big.bin', 70 * 1024 * 1024)"`;
  for (const [command, file] of [[big, 'big.bin'], ['node src/check.js', 'README.md']] as const) {
    const p = project43();
    try {
      const { judgment } = await reviewedOnRun(p, artifactPlan([{ id: 'check', command, artifacts: [file] }]));
      p.reopen(ENV_B).environment();
      const r = await pmRenew(p.ctx, { mission: 'm1' });
      const rerun = r.reruns.find((x) => x.refused.some((f) => f.judgment === judgment));
      assert.ok(rerun !== undefined && rerun.renewed.length === 0, JSON.stringify(r));
      assert.match(rerun.refused.find((f) => f.judgment === judgment)!.reason, new RegExp(`^the record does not show that it repeated ${file.replace('.', '\\.')} as the original run kept it`));
    } finally { p.cleanup(); }
  }
});

test('review p9-r2-2: the named files of a run are stored once and named from each evidence record; renewal reads them and the inline form of earlier records', async () => {
  const p = processProject();
  try {
    const ctx = p.ctx;
    const commit = p.git('rev-parse', 'HEAD').trim();
    const long = (i: number, j: number): string => `out/${String(i).padStart(2, '0')}-${String(j).padStart(2, '0')}-${'x'.repeat(88)}.txt`;
    const commands = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, command: `true ${i}`, artifacts: Array.from({ length: 20 }, (_, j) => long(i, j)) }));
    const r = await runOnCommit(ctx, { mission: 'm1', commit, commands, purpose: 'many named files', declaration: { by: 'mp', checkout: 'clean', declared: true } });
    assert.equal(r.runs.length, 50, 'every command is recorded: the write stays within its limit');
    const fields = r.runs[0]!.fields;
    assert.ok(fields['groupFiles'] !== undefined && !fields['group']!.includes('artifacts'), 'the group stays the 4.3 form; its files are named by hash');
    const g = recordedGroup(fields, (h) => ctx.memory.data.text(h))!;
    assert.deepEqual(g[7]!.artifacts, commands[7]!.artifacts);
    assert.ok(g.every((c, i) => c.command === `true ${i}`));
    // an earlier record carried its files inline in the group
    const inline = { group: JSON.stringify([{ command: 'a', cwd: '.', sampled: false, network: false, artifacts: ['x.log'] }]) };
    assert.deepEqual(recordedGroup(inline, () => '')![0]!.artifacts, ['x.log']);
    // a group whose commands name no file is 4.3's: no reference
    const plain = await runOnCommit(ctx, { mission: 'm1', commit, commands: [{ id: 'p', command: 'true plain' }], purpose: 'plain', declaration: { by: 'mp', checkout: 'clean', declared: true } });
    assert.equal(plain.runs[0]!.fields['groupFiles'], undefined);
    assert.equal(plain.runs[0]!.fields['group'], canonicalJson([{ command: 'true plain', cwd: '.', sampled: false, network: false }]), 'the group of 4.3');
  } finally { p.cleanup(); }
});

test('review F2-3: two runs of one command on one commit that named different files are two renewal groups, and each is compared with the files it named itself', async () => {
  const p = processProject();
  try {
    const commit = p.git('rev-parse', 'HEAD').trim();
    const declaration = { by: 'mp' as const, checkout: 'clean' as const, declared: true };
    // in one environment the command names no file; in the next, the same command names its report
    const none = await runOnCommit(p.ctx, { mission: 'm1', commit, commands: [{ id: 'check', command: 'true check' }], purpose: 'names no file', declaration });
    p.reopen(ENV_B).environment();
    const ctx = p.ctx;
    const named = await runOnCommit(ctx, { mission: 'm1', commit, commands: [{ id: 'check', command: 'true check', artifacts: ['report.md'] }], purpose: 'names its report', declaration });
    const a = { evidence: none.runs[0]!.evidence, fields: none.runs[0]!.fields };
    const b = { evidence: named.runs[0]!.evidence, fields: named.runs[0]!.fields };
    assert.notEqual(a.evidence, b.evidence, 'two recorded runs');
    assert.equal(a.fields['group'], b.fields['group'], 'the same command group in the 4.3 form');
    assert.notEqual(renewalGroupKey(commit, a), renewalGroupKey(commit, b), 'two groups: neither lends the other its files');
    assert.equal(renewalGroupKey(commit, b), renewalGroupKey(commit, { evidence: 'other', fields: b.fields }), 'one group for runs that named the same files');
    const text = (h: string): string => ctx.memory.data.text(h);
    assert.deepEqual(ownDeclaredFiles(a, 'true check', '.', text), []);
    assert.deepEqual(ownDeclaredFiles(b, 'true check', '.', text), ['report.md'], 'its own declaration');
  } finally { p.cleanup(); }
});

test('review F2-4: a Reviewer\'s cited path outside its folder that is a link to a file in it: the bytes it was checked against are copied before the folder is removed', LINKS, async () => {
  const q = project43();
  try {
    const ctx = q.ctx;
    const con = await toConstructor(q);
    assert.equal((await handBack(ctx, con, constructorFields([]))).kind, 'recorded');
    const r = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, r.step);
    readAll(ctx, rd.dispatch);
    const { mkdtempSync, symlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const rdir = join(ctx.memory.paths.tmp, rd.dispatch);
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, 'measure.log'), 'latency 7 ms\n');
    const outside = mkdtempSync(join(tmpdir(), 'mp-link-in-'));
    symlinkSync(join(rdir, 'measure.log'), join(outside, 'measure.log'));
    const cited = `data:${join(outside, 'measure.log')}#sha256=${sha('latency 7 ms\n')}&size=13`;
    const card = dispatchView(ctx, rd.dispatch).card as unknown as ReviewerCard;
    const fields = { judgments: [{ standard: 'S1', met: 'yes', reason: 'measured', evidence: [`evidence:${card.verificationRuns[0]!.evidence}`, cited] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' };
    const rv = await recordSeatHandBack(ctx, rd.dispatch, { report: '# r\n', fields, advance: false });
    assert.equal(rv.kind, 'recorded', JSON.stringify(rv));
    const doc = ctx.memory.read((db) => handbackDoc(ctx.memory.data, dispatchInfo(db, rd.dispatch)!))!;
    assert.equal(doc.data?.[0]?.kept, `files/${sha('latency 7 ms\n')}`, 'kept, and the record says where');
    assert.ok(!existsSync(rdir), 'the clean-up removed the folder the link points into');
    assert.equal(readFileSync(join(ctx.memory.paths.root, 'files', sha('latency 7 ms\n')), 'utf8'), 'latency 7 ms\n', 'the bytes checked are kept');
  } finally { q.cleanup(); }
});

test('review F3-7: an integration task whose only standard a person checks passes resting on its full run; the acceptance lists the standard as an item to verify', async () => {
  const SUITE = [{ id: 'suite', command: 'node suite.js' }];
  const SUITE_JS = "const { add } = require('./src/add.js');\nconsole.log(add(2, 3) === 5 ? 'ok 1 - the whole suite' : 'not ok 1 - the whole suite');\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n";
  const p = processProject({ files: { 'suite.js': SUITE_JS }, options: { fullSuite: SUITE } });
  try {
    const ctx = p.ctx;
    const dp = addDetailedPlan('m1') as { tasks: unknown[] };
    dp.tasks.push({
      id: 'integ', kind: 'integration', module: null, goal: 'Use add in the app',
      standards: [{ id: 'S1', text: 'A user runs the app and sees 5', check: 'person' }],
      requirementItems: ['item.m1.g1'], writeScope: ['app/**'], readableFiles: ['README.md'], interpreter: 'node',
      verificationCommands: [{ id: 'app', command: 'node app/main.js' }], implements: [], calls: ['add'], dependsOn: ['impl'], exclusive: [],
      estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'a small change' }, provenance: { planElement: 'e1' },
    });
    await startAddMission(ctx, 'm1');
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => dp);
    if ((await pmNext(ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(ctx, 'architect-feasibility', () => feasible());
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const construct = async (task: string, files: Record<string, string>): Promise<void> => {
      const s = (await pmNext(ctx)).ready.find((x) => x.kind === 'constructor' && x.step.includes(`.${task}.`))!;
      const d = pmDispatch(ctx, s.step);
      for (const [rel, text] of Object.entries(files)) write(join(p.dir, d.worktree!), rel, text);
      const a = await handBack(ctx, d.dispatch, constructorFields([]));
      assert.ok(a.kind === 'recorded' && a.candidate !== null, JSON.stringify(a));
    };
    const reviewer = async (task: string): Promise<{ dispatch: string; card: ReviewerCard }> => {
      const s = (await pmNext(ctx)).ready.find((x) => x.kind === 'reviewer' && x.step.includes(`.${task}.`))!;
      const d = pmDispatch(ctx, s.step);
      readAll(ctx, d.dispatch);
      return { dispatch: d.dispatch, card: dispatchView(ctx, d.dispatch).card as unknown as ReviewerCard };
    };
    await construct('impl', { 'src/add.js': 'exports.add = (a, b) => a + b;\n', 'src/check.js': CHECK_JS });
    const ri = await reviewer('impl');
    assert.equal((await handBack(ctx, ri.dispatch, reviewerPass(ri.card as never))).kind, 'recorded');
    await construct('integ', { 'app/main.js': "const { add } = require('../src/add.js');\nconsole.log(add(2, 3));\n" });
    const rv = await reviewer('integ');
    assert.deepEqual(rv.card.standards.map((s) => [s.id, s.check]), [['S1', 'person']]);
    const pass = { judgments: [], gap_responses: rv.card.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' })), issue_responses: [], findings: [], verdict: 'pass' };
    const refused = await handBack(ctx, rv.dispatch, pass);
    assert.ok(refused.kind === 'refused' && refused.problems.some((x) => /cites a passing full run of its candidate/.test(x)), 'without a full run: refused, as every integration pass is');
    const fr = await seatFullRun(ctx, rv.dispatch);
    assert.equal(fr.marker.passed, true);
    const a = await handBack(ctx, rv.dispatch, pass);
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    await pmNext(ctx);
    const accepted = ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: 'task:integ', event: 'accepted' }));
    assert.equal(accepted.length, 1, 'the integration task is accepted');
    const judgment = ctx.memory.read((db) => (db.stmt("SELECT record FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = ?").get(rv.card.binding.judgment) as { record: string }).record);
    const cites = ctx.memory.data.getList(JSON.parse(judgment).evidence as never);
    assert.deepEqual([...cites].sort(), fr.marker.commands.map((x) => x.evidence).sort(), 'the pass rests on its full run');
    const items = ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: OPEN_ITEMS_LINE, event: OPEN_ITEM })).map((e) => JSON.parse(ctx.memory.data.text(e.body)) as { id: string; kind: string; task?: string });
    assert.deepEqual(items.filter((i) => i.task === 'integ').map((i) => [i.id, i.kind]), [[personItemId('integ', 1, 'S1'), 'verify']], 'the person\'s standard is an item to verify');
  } finally { p.cleanup(); }
});

test('review p9-r2-3, p9-7 (round 2): a file there before a command is compared by its size when it is too large to hash; unknown when the sizes match; a file not kept is attributed to no command', async () => {
  const { keepBudget, keepArtifacts, artifactStates } = await import('../src/process/keptFiles.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'mp-keep2-'));
  try {
    const root = join(base, 'memory');
    const dir = join(base, 'checkout');
    mkdirSync(root);
    mkdirSync(dir);
    const big = 65 * 1024 * 1024;
    writeFileSync(join(dir, 'report.bin'), '');
    truncateSync(join(dir, 'report.bin'), big);
    writeFileSync(join(dir, 'same.bin'), '');
    truncateSync(join(dir, 'same.bin'), big);
    const before = await artifactStates(dir, ['report.bin', 'same.bin']);
    // the command replaces the large report by a short one, and rewrites the other with the same size
    writeFileSync(join(dir, 'report.bin'), 'short report\n');
    writeFileSync(join(dir, 'same.bin'), Buffer.alloc(big, 1));
    const kept = await keepArtifacts(root, dir, ['report.bin', 'same.bin'], keepBudget(), before);
    assert.equal(kept[0]!.origin, undefined, 'a size change is a change: written by it');
    assert.ok(kept[0]!.kept !== undefined);
    assert.equal(kept[1]!.origin, 'unknown', 'the same size and no hashes to compare: unknown');
    const lines = artifactLines(kept);
    assert.ok(lines.includes('\n  file it wrote: report.bin'), lines);
    assert.ok(lines.includes('\n  file it names, not kept: same.bin ('), lines);
    // the run's budget used up: a later command's file is not kept, and is not called written by it
    const spent = keepBudget();
    spent.files = 0;
    writeFileSync(join(dir, 'late.txt'), 'late\n');
    const late = await keepArtifacts(root, dir, ['late.txt'], spent, await artifactStates(dir, []));
    assert.match(late[0]!.why ?? '', /^more than 20 files/);
    assert.ok(artifactLines(late).includes('\n  file it names, not kept: late.txt (more than 20 files'), artifactLines(late));
    assert.ok(!artifactLines(late).includes('file it wrote'));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('review p9-5 (round 2): a Reviewer\'s cited path in its folder that is a link to a file elsewhere: the bytes it was checked against are copied and recorded', LINKS, async () => {
  const q = project43();
  try {
    const ctx = q.ctx;
    const con = await toConstructor(q);
    assert.equal((await handBack(ctx, con, constructorFields([]))).kind, 'recorded');
    const r = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, r.step);
    readAll(ctx, rd.dispatch);
    const { mkdtempSync, symlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const outside = mkdtempSync(join(tmpdir(), 'mp-link-'));
    writeFileSync(join(outside, 'measure.log'), 'latency 9 ms\n');
    const rdir = join(ctx.memory.paths.tmp, rd.dispatch);
    mkdirSync(rdir, { recursive: true });
    symlinkSync(join(outside, 'measure.log'), join(rdir, 'measure.log'));
    const cited = `data:${join(rdir, 'measure.log')}#sha256=${sha('latency 9 ms\n')}&size=13`;
    const card = dispatchView(ctx, rd.dispatch).card as unknown as ReviewerCard;
    const fields = { judgments: [{ standard: 'S1', met: 'yes', reason: 'measured', evidence: [`evidence:${card.verificationRuns[0]!.evidence}`, cited] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' };
    const rv = await recordSeatHandBack(ctx, rd.dispatch, { report: '# r\n', fields, advance: false });
    assert.equal(rv.kind, 'recorded', JSON.stringify(rv));
    const doc = ctx.memory.read((db) => handbackDoc(ctx.memory.data, dispatchInfo(db, rd.dispatch)!))!;
    assert.equal(doc.data?.[0]?.kept, `files/${sha('latency 9 ms\n')}`);
    assert.equal(readFileSync(join(ctx.memory.paths.root, 'files', sha('latency 9 ms\n')), 'utf8'), 'latency 9 ms\n', 'the bytes checked are the bytes kept');
    assert.ok(!existsSync(rdir), 'the clean-up removed the cited name; its bytes are kept');
  } finally { q.cleanup(); }
});
