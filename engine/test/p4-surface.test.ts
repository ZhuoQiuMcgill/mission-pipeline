// 4.1.2 part P4 (design DesignDoc_ExecutionRedundancy v01: D-7, D-9, D-11, D-12): the user's end of a
// mission and the field fixes.
//
//   - `mp pm finish`: deliver, land and close on one words entry; when landing cannot complete it
//     stops after the delivery with the mission open, and the same words serve `land` and `close`;
//   - `mp pm deliver` runs no command and shows the full-run status (P1's resolver, a stub here);
//   - `mp pm close` is never refused on the state of the work: the snapshot lists it (D-11);
//   - a seat-side flow pass leaves its sandbox's permission errors to the PM, without a notice;
//   - config `commit` sets the author and committer of the candidate and delivery commits;
//   - `mp read show plan` prints the mechanical failure texts; `mp init` looks into first-level
//     folders; `mp pm constraint add --words`; the Constructor's hand-back says its worktree is gone.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { setLabelBatchLimit } from '../src/evaluator/index.ts';
import { permissionDenied, registerFlowStep } from '../src/flow/engine.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { GitExitError, PlainGit } from '../src/git/plainGit.ts';
import { openProject } from '../src/cli/project.ts';
import { appendRecords, flowEvents, missionCloses } from '../src/memory/index.ts';
import { listNotices, missionState, pmClose, pmDeliver, pmDispatch, pmFinish, pmMission, pmNext, pmSay, type CloseSnapshot } from '../src/process/index.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { dispatchView } from '../src/process/seat.ts';
import { cli, gitProject, handBackFiles, type TestProject } from './cli-fixtures.ts';
import { drained, frontier, seedFanout } from './exploration-exits.ts';
import { memoryPorts } from './flow-memory-fixtures.ts';
import { builders } from './labels-fixtures.ts';
import { addDetailedPlan, addMissionToReview, CHECK_JS, ENV_A, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const PRODUCT = `prod.con.${M}.impl.1`;

/** The mission through the Reviewer's pass: its product accepted and proven. */
async function accepted(p: ProcessProject): Promise<void> {
  await addMissionToReview(p, M);
  await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
}

function snapshotOf(p: ProcessProject, mission: string): CloseSnapshot {
  const last = p.ctx.memory.read((db) => missionCloses(db, mission as MissionId)).at(-1)!;
  return JSON.parse(p.ctx.memory.data.text(last.snapshot!)) as CloseSnapshot;
}

function landingWords(p: ProcessProject): string[] {
  const text = (d: string): string => (/^[0-9a-f]{64}$/.test(d) ? p.ctx.memory.data.text(d) : d);
  return p.ctx.memory.read((db) => (db.stmt("SELECT details FROM intents WHERE kind = 'landing' AND state = 'done'").all() as Array<{ details: string }>).map((r) => (JSON.parse(text(r.details)) as { words: string }).words));
}

// ---------------------------------------------------------------- mp pm finish

describe('mp pm finish (D-9): deliver, land and close on one words entry', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('delivers every accepted output of the plan in effect, lands it and closes the mission, all citing the same words', async () => {
    // the Constructor hands back through the CLI from the project: its worktree is gone afterwards, and it is told so
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const con = pmDispatch(ctx, (await readyOf(ctx, 'constructor')).step);
    write(join(p.dir, con.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(p.dir, con.worktree!), 'src/check.js', CHECK_JS);
    p.ctx.memory.close();
    const f = handBackFiles(p.dir, con.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    const hb = await cli(p.dir, ['seat', con.dispatch, 'handback', '--report', f.report, '--result', f.result]);
    assert.equal(hb.code, 0, hb.out + hb.err);
    assert.match(hb.out, new RegExp(`Hand-back of ${con.dispatch} recorded; your worktree has been removed — if your shell was inside it, the next command's error is expected\\.`));
    p.reopen();
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    p.ctx.memory.close();

    const w = (await cli(p.dir, ['pm', 'say', 'Looks good: close and merge.', '--json'])).json.result.words as string;
    assert.equal(w, 'W-2');
    const r = await cli(p.dir, ['pm', 'finish', M, '--words', w, '--json']);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    const res = r.json.result;
    assert.deepEqual(res.outputs.map((t: { id: string }) => t.id), [PRODUCT], 'the accepted outputs of the plan in effect by default');
    assert.equal(res.delivery.result.kind, 'delivered');
    assert.equal(res.landing.kind, 'landed');
    assert.equal(res.stoppedAt, null);
    const commit = res.delivery.result.record.commit as string;
    assert.equal(p.git('rev-parse', 'refs/heads/main'), commit);
    assert.ok(existsSync(join(p.dir, 'src', 'add.js')));

    const ctx2 = p.reopen();
    assert.equal(ctx2.memory.read((db) => missionState(db, M)), 'closed');
    const snap = snapshotOf(p, M);
    assert.equal(snap.words, w, 'the close cites the words');
    assert.equal(snap.mode, 'with-risk');
    assert.deepEqual(snap.delivered?.entries.map((e) => [e.object, e.label]), [[PRODUCT, 'proven']]);
    assert.equal(snap.fullRun?.line, 'full suite never run');
    assert.deepEqual(landingWords(p), [w], 'the landing cites the words');
    const leaf = readFileSync(join(p.dir, '.mission-pipeline', 'missions', M, 'deliveries', `${res.delivery.id}.md`), 'utf8');
    assert.match(leaf, new RegExp(`Asked for in ${w}`), 'the delivery cites the words');
    assert.equal(ctx2.memory.read((db) => Number((db.stmt('SELECT COUNT(*) AS n FROM words').get() as { n: number }).n)), 2, 'one words entry for the three steps');
    p.ctx.memory.close();
    const shown = await cli(p.dir, ['read', 'status']);
    assert.match(shown.out, new RegExp(`${res.delivery.id} recorded, landed`));
    p.reopen();
  });

  it('prints the honest snapshot as its report', async () => {
    p.ctx.memory.close();
    const r = await cli(p.dir, ['pm', 'finish', M, '--words', 'W-2']);
    p.reopen();
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /1\. Deliver \(prod\.con\.m1\.impl\.1\): Delivery d-[0-9a-f]{12} made/);
    assert.match(r.out, /No command ran: full suite never run/);
    assert.match(r.out, /2\. Land: Landed: main/);
    assert.match(r.out, /3\. Close: Mission m1 closed \(with-risk\) on W-2/);
    for (const head of ['Delivered: d-', 'Unfinished: none', 'Not proven: none', 'Open or deferred issues: none', 'Start risks: none', 'Proven in an older environment: none', 'Repairs: none', 'Full suite: full suite never run']) assert.ok(r.out.includes(head), `${head}\n${r.out}`);
  });
});

describe('mp pm finish stops after the delivery when landing cannot complete; the same words serve land and close', () => {
  const p = processProject();
  after(() => p.cleanup());
  let w = '';
  let delivery = '';

  before(async () => {
    await accepted(p);
    // a closing check from 4.1.1's config: deliver never runs it (D-7)
    const marker = join(p.dir, '..', 'closing-check-ran');
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', closingChecks: [{ id: 'mark', command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }] }));
    w = pmSay(p.ctx, 'Close it and merge it.').words;
    p.ctx.memory.close();
  });

  it('mp pm deliver runs no command and prints the full-run status', async () => {
    const r = await cli(p.dir, ['pm', 'deliver', M, '--outputs', PRODUCT, '--words', w, '--json']);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    delivery = r.json.result.delivery;
    assert.equal(r.json.result.result.record.fullRun.line, 'full suite never run');
    assert.ok(!existsSync(join(p.dir, '..', 'closing-check-ran')), 'no closing check ran');
    const text = await cli(p.dir, ['pm', 'deliver', M, '--outputs', PRODUCT, '--words', w]);
    assert.match(text.out, /No command ran: full suite never run\. A full run at the end is your call \(D-7\)\./);
    assert.ok(!existsSync(join(p.dir, '..', 'closing-check-ran')));
  });

  it('a delivery that cannot be made stops at once: nothing lands, the mission stays open', async () => {
    const r = await cli(p.dir, ['pm', 'finish', M, '--words', w, '--outputs', 'nope', '--json']);
    assert.equal(r.code, 3, JSON.stringify(r.json));
    assert.equal(r.json.result.stoppedAt, 'deliver');
    assert.equal(r.json.result.landing, null);
    assert.equal(r.json.result.close, null);
    p.reopen();
    assert.equal(p.ctx.memory.read((db) => missionState(db, M)), 'open');
    p.ctx.memory.close();
  });

  it('a landing refused by a dirty worktree (WI-02): delivered, not landed, the mission open', async () => {
    const before = p.git('rev-parse', 'refs/heads/main');
    writeFileSync(join(p.dir, 'README.md'), '# the project\n\nedited by the user, not committed\n');
    const r = await cli(p.dir, ['pm', 'finish', M, '--words', w, '--json']);
    assert.equal(r.code, 3, JSON.stringify(r.json));
    assert.equal(r.json.result.delivery.id, delivery, 'the delivery made by deliver with the same words is reused');
    assert.equal(r.json.result.delivery.result.kind, 'delivered');
    assert.equal(r.json.result.landing.kind, 'not-landed');
    assert.equal(r.json.result.stoppedAt, 'land');
    assert.equal(r.json.result.wi, 'WI-02');
    assert.equal(r.json.result.close, null);
    assert.equal(p.git('rev-parse', 'refs/heads/main'), before, 'nothing landed');
    p.reopen();
    assert.equal(p.ctx.memory.read((db) => missionState(db, M)), 'open', 'the mission stays open');
    p.ctx.memory.close();
    const text = await cli(p.dir, ['pm', 'finish', M, '--words', w]);
    assert.match(text.out, new RegExp(`Stopped after the delivery: ${delivery} is delivered, not landed; mission m1 stays open\\. Once the WI is resolved, the same words serve: mp pm land ${delivery} --words ${w}, then mp pm close m1 --words ${w}\\.`));
    assert.match(text.out, /WI-02/);
  });

  it('the base moved meanwhile: the WI-05 default rebuilds; land with the same words; finish again lands the rebuild, never rebuilds again, and closes', async () => {
    p.git('checkout', '--', 'README.md');
    write(p.dir, 'NOTES.md', 'a commit by someone else\n');
    p.git('add', 'NOTES.md');
    p.git('commit', '-q', '-m', 'someone else');
    const r = await cli(p.dir, ['pm', 'finish', M, '--words', w, '--json']);
    assert.equal(r.code, 3, JSON.stringify(r.json));
    assert.equal(r.json.result.landing.kind, 'base-moved');
    assert.equal(r.json.result.rebuild.kind, 'delivered');
    assert.equal(r.json.result.stoppedAt, 'land');
    const rebuilt = r.json.result.rebuild.record.delivery as string;
    assert.equal(rebuilt, `${delivery}-r1`);
    // the WI resolved by the PM with the same words: mp pm land
    const land = await cli(p.dir, ['pm', 'land', rebuilt, '--words', w, '--json']);
    assert.equal(land.code, 0, JSON.stringify(land.json));
    assert.equal(p.git('rev-parse', 'refs/heads/main'), land.json.result.result.commit);
    // finish again (a retry): it lands the rebuilt delivery (already there: recorded as found), rebuilds nothing, closes
    const again = await cli(p.dir, ['pm', 'finish', M, '--words', w, '--json']);
    assert.equal(again.code, 0, JSON.stringify(again.json));
    assert.deepEqual([again.json.result.landed, again.json.result.landing.kind, again.json.result.rebuild, again.json.result.stoppedAt], [rebuilt, 'landed', null, null]);
    p.reopen();
    assert.deepEqual(p.ctx.memory.read((db) => (db.stmt('SELECT delivery FROM deliveries WHERE mission = ? ORDER BY seq').all(M) as Array<{ delivery: string }>).map((d) => d.delivery)), [delivery, rebuilt], 'one rebuild, no second one');
    assert.equal(p.ctx.memory.read((db) => missionState(db, M)), 'closed');
    assert.equal(snapshotOf(p, M).delivered?.delivery, rebuilt);
    p.ctx.memory.close();
    // and mp pm close with the same words: another honest snapshot, citing them
    const close = await cli(p.dir, ['pm', 'close', M, '--words', w, '--json']);
    assert.equal(close.code, 0, JSON.stringify(close.json));
    p.reopen();
    const snap = snapshotOf(p, M);
    assert.equal(snap.words, w);
    assert.equal(snap.delivered?.delivery, rebuilt);
  });
});

describe('mp pm finish with nothing to deliver', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('closes the mission and lands nothing (an exploration\'s stage, a plan with nothing accepted)', async () => {
    pmMission(p.ctx, 'm9');
    const w = pmSay(p.ctx, 'This stage is done: close it.').words;
    const r = await pmFinish(p.ctx, { mission: 'm9', words: w });
    assert.deepEqual([r.delivery, r.landing, r.stoppedAt], [null, null, null]);
    assert.equal(r.close?.doc.words, w);
    assert.equal(p.ctx.memory.read((db) => missionState(db, 'm9')), 'closed');
  });
});

// ---------------------------------------------------------------- close (D-11)

describe('mp pm close is never refused on the state of the work (D-11)', () => {
  it('--mode full with an unproven output and an unfinished task: it closes and the snapshot lists both', async () => {
    const w = memoryPorts();
    const r = builders(w.memory);
    w.ctx.environment();
    const ev = (line: string, event: string, key: string, body: unknown) => ({ kind: 'flow.event', mission: 'm1', line, event, key, body: w.memory.data.put(JSON.stringify(body)) });
    w.memory.write({}, (tx) => {
      appendRecords(tx, [
        r.product('p1'), r.judge('j1', 'p1'), r.product('p2'), r.product('plan'), r.judge('jp', 'plan'),
        ev('plan', 'effective', 'plan', { dplan: 'plan', tasks: ['a', 'b', 'c'] }),
        // a: accepted and proven; b: accepted, its product not proven (no passing judgment); c: dispatched, not accepted
        ev('task:a', 'dispatched', 'con.m1.a.1', { k: 1, dplan: 'plan', commit: 'c', snapshot: 'c', prerequisites: [] }),
        ev('task:a', 'product', '1', { k: 1, object: 'p1' }),
        ev('task:a', 'accepted', '1', { product: 'p1', judgment: 'j1' }),
        ev('task:b', 'dispatched', 'con.m1.b.1', { k: 1, dplan: 'plan', commit: 'c', snapshot: 'c', prerequisites: [] }),
        ev('task:b', 'product', '1', { k: 1, object: 'p2' }),
        ev('task:b', 'accepted', '1', { product: 'p2', judgment: 'j2' }),
        ev('task:c', 'dispatched', 'con.m1.c.1', { k: 1, dplan: 'plan', commit: 'c', snapshot: 'c', prerequisites: [] }),
      ] as never);
    });
    const closed = await pmClose(w.ctx, 'm1', { mode: 'full' });
    assert.equal(closed.mode, 'full');
    assert.equal(w.memory.read((db) => missionState(db, 'm1')), 'closed');
    const doc = closed.doc;
    assert.deepEqual(doc.proof.filter((o) => o.label !== 'proven').map((o) => o.object), ['p2']);
    assert.ok(doc.unfinished.planTasks.includes('c'), JSON.stringify(doc.unfinished));
    assert.ok(doc.risks.some((x) => x.startsWith('not proven: p2')), JSON.stringify(doc.risks));
    assert.ok(doc.risks.includes('plan task c not accepted'));
    assert.match(closed.message, /Not proven: p2 \(task b\)/);
    assert.match(closed.message, /Unfinished: plan task c/);
    // the snapshot as recorded is the one returned
    const recorded = JSON.parse(w.memory.data.text(closed.snapshot)) as CloseSnapshot;
    assert.deepEqual(recorded, doc);
  });

  describe('with the labels recomputing', () => {
    const p = processProject();
    after(() => {
      setLabelBatchLimit(null);
      p.cleanup();
    });

    it('a frontier larger than a batch: the batch runs first, the close goes on and records "labels were recomputing at close"', async () => {
      pmMission(p.ctx, M);
      await seedFanout(p, M, 400);
      await frontier(p, M);
      const closed = await pmClose(p.ctx, M, { mode: 'full', request: 'recomputing' });
      assert.equal(closed.doc.labelsRecomputing, true);
      assert.ok(closed.risks.some((x) => x.startsWith('labels were recomputing at close')), JSON.stringify(closed.risks));
      assert.match(closed.message, /Labels were recomputing at close/);
      assert.equal(p.ctx.memory.read((db) => missionState(db, M)), 'closed');
    });

    it('a frontier one batch settles: the close succeeds after the batch with the labels settled', async () => {
      drained(p);
      pmMission(p.ctx, M);
      await frontier(p, M, 3);
      setLabelBatchLimit(null);
      const closed = await pmClose(p.ctx, M, { mode: 'full', request: 'settled' });
      assert.equal(closed.doc.labelsRecomputing, false);
      assert.ok(!closed.risks.some((x) => x.startsWith('labels were recomputing')));
    });
  });
});

// ---------------------------------------------------------------- a seat-side pass in a sandbox

let armed: null | (() => Error) = null;
registerFlowStep('p4-sandbox-probe', async () => {
  if (armed !== null) throw armed();
});

const erofs = (): Error => Object.assign(new Error("EROFS: read-only file system, open '/work/.git/index.lock'"), { code: 'EROFS', errno: -30, syscall: 'open', path: '/work/.git/index.lock' });
const gitDenied = (): Error => new GitExitError({ argv: ['git', 'update-ref', 'refs/x', 'abc'], code: 128, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: Unable to create '/work/.git/refs/x.lock': Permission denied\n"), durationMs: 1 });

it('permissionDenied: the error code first, then git\'s stderr wordings (read-only, permission denied, insufficient permission); nothing else', () => {
  const git = (stderr: string) => new GitExitError({ argv: ['git', 'hash-object', '-w', '--stdin'], code: 128, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr), durationMs: 1 });
  assert.equal(permissionDenied(git('error: insufficient permission for adding an object to repository database .git/objects\nfatal: failed to write object\n')), 'the repository (git hash-object -w: insufficient permission)');
  assert.equal(permissionDenied(git("fatal: Unable to create '/w/.git/index.lock': Read-only file system\n")), '/w/.git/index.lock (git hash-object -w: Read-only file system)');
  assert.equal(permissionDenied(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/w/.git/objects/ab' })), '/w/.git/objects/ab', 'the code is read first');
  assert.equal(permissionDenied(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'EPERM', syscall: 'rename' }) })), 'rename (EPERM)');
  assert.equal(permissionDenied(git('fatal: bad object HEAD\n')), null);
  assert.equal(permissionDenied(new Error('a real defect')), null);
});

describe('a seat-side flow pass: its sandbox\'s permission errors are the PM\'s next step, not an internal error', () => {
  const p = processProject();
  after(() => {
    armed = null;
    p.cleanup();
  });
  const internal = () => p.ctx.memory.read((db) => listNotices(db, p.ctx.memory.data, { includeAcknowledged: true })).filter((n) => n.category === 'flow-internal-error');

  it('EROFS and a git permission error during the hand-back\'s pass: no notice, a note for the seat; the PM\'s next step finishes the pass', async () => {
    await startAddMission(p.ctx, M);
    const d1 = pmDispatch(p.ctx, (await readyOf(p.ctx, 'calibrator-1')).step);
    readAll(p.ctx, d1.dispatch);
    armed = erofs;
    const a1 = await handBack(p.ctx, d1.dispatch, cal1Pass(dispatchView(p.ctx, d1.dispatch).card as unknown as Calibrator1Card));
    armed = null;
    assert.ok(a1.kind === 'recorded' && a1.outcome === 'accepted', JSON.stringify(a1));
    assert.ok(a1.kind === 'recorded' && a1.notes.includes("left to the PM: this seat's sandbox could not write /work/.git/index.lock"), JSON.stringify(a1));
    assert.deepEqual(internal(), [], 'no WI-20 notice');
    // the PM's next step runs the pass in its own process
    assert.deepEqual((await pmNext(p.ctx)).errors, []);
    const d2 = pmDispatch(p.ctx, (await readyOf(p.ctx, 'architect-decompose')).step);
    readAll(p.ctx, d2.dispatch);
    armed = gitDenied;
    const a2 = await handBack(p.ctx, d2.dispatch, addDetailedPlan(M));
    armed = null;
    assert.ok(a2.kind === 'recorded' && a2.notes.includes("left to the PM: this seat's sandbox could not write /work/.git/refs/x.lock (git update-ref refs/x: Permission denied)"), JSON.stringify(a2));
    assert.deepEqual(internal(), []);
    assert.deepEqual((await pmNext(p.ctx)).errors, []);
    await readyOf(p.ctx, 'calibrator-2');
  });

  it('the same EROFS in the PM\'s own pass, and any other error in a seat-side pass, still raise WI-20', async () => {
    armed = erofs;
    const n = await pmNext(p.ctx);
    armed = null;
    assert.ok(n.errors.some((e) => e.includes('EROFS')), JSON.stringify(n.errors));
    assert.equal(internal().length, 1, 'the PM-side pass is not a sandbox: WI-20');
    const d3 = pmDispatch(p.ctx, (await readyOf(p.ctx, 'calibrator-2')).step);
    readAll(p.ctx, d3.dispatch);
    armed = () => new Error('a real defect');
    const a3 = await handBack(p.ctx, d3.dispatch, cal2Pass(dispatchView(p.ctx, d3.dispatch).card as never));
    armed = null;
    assert.ok(a3.kind === 'recorded' && !a3.notes.some((x) => x.startsWith('left to the PM')), JSON.stringify(a3));
    assert.ok(internal().some((x) => x.trigger.includes('a real defect')), 'a real internal error in a seat-side pass is still WI-20');
  });
});

// ---------------------------------------------------------------- config `commit`

describe('config commit: the identity of the commits mp writes', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('commit.author and commit.committer set a candidate\'s and a delivery\'s author and committer; mp config shows them', async () => {
    p.ctx.memory.close();
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', commit: { author: 'Jane Dev <jane@example.com>', committer: 'CI Bot <ci@example.com>' } }));
    const shown = await cli(p.dir, ['config']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Commit identity: author Jane Dev <jane@example\.com>; committer CI Bot <ci@example\.com>/);
    // opened as every mp command opens it: the identity comes from config.json
    const project = await openProject({ cwd: p.dir, env: { MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: true });
    p.ctx = project.ctx;
    const { candidate } = await addMissionToReview(p, M);
    const who = (c: string) => p.git('log', '-1', '--format=%an <%ae>|%cn <%ce>', c);
    assert.equal(who(candidate), 'Jane Dev <jane@example.com>|CI Bot <ci@example.com>', 'the Constructor\'s candidate');
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    const w = pmSay(p.ctx, 'Deliver it.').words;
    const del = await pmDeliver(p.ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: PRODUCT as never }], words: w });
    assert.equal(del.kind, 'delivered', JSON.stringify(del));
    if (del.kind === 'delivered') assert.equal(who(del.record.commit), 'Jane Dev <jane@example.com>|CI Bot <ci@example.com>', 'the delivery commit');
  });

  it('the default stays Mission Pipeline <mp@localhost>; a malformed identity is refused by mp config', async () => {
    p.ctx.memory.close();
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main' }));
    assert.match((await cli(p.dir, ['config'])).out, /Commit identity: author Mission Pipeline <mp@localhost> \(default\); committer Mission Pipeline <mp@localhost> \(default\)/);
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', commit: { author: 'no email here' } }));
    const bad = await cli(p.dir, ['config', '--json']);
    assert.equal(bad.code, 3);
    assert.match(bad.json.error.message, /commit\.author: a commit identity "Name <email>"/);
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', commit: { author: 'Solo Dev <solo@example.com>' } }));
    assert.match((await cli(p.dir, ['config'])).out, /author Solo Dev <solo@example\.com>; committer the author/);
    p.reopen();
  });
});

// ---------------------------------------------------------------- smaller fixes

describe('mp read show plan prints the mechanical failure texts', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('a detailed plan that fails its mechanical checks: each failure as the flow recorded it', async () => {
    await startAddMission(p.ctx, M);
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    // the only task is marked as the Architect's own: the PM plan element e1 has no task (coverage)
    const plan = addDetailedPlan(M) as { tasks: Array<{ provenance: unknown }> };
    plan.tasks[0]!.provenance = 'architect';
    await step(p.ctx, 'architect-decompose', () => plan);
    const dplan = `dplan.${M}.1.1`;
    const recorded = p.ctx.memory.read((db) => flowEvents(db, { mission: M, line: 'plan', event: 'mechanical-check', limit: 100 })).filter((e) => e.key === dplan);
    assert.equal(recorded.length, 1);
    p.ctx.memory.close();
    const r = await cli(p.dir, ['read', 'show', 'plan', dplan]);
    p.reopen();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mechanical checks failed \(1\)/);
    assert.ok(r.out.includes(`mechanical checks of ${dplan}: failed (1):\n    failed: coverage: PM plan element "e1" has no task`), JSON.stringify(r.out));
  });
});

describe('mp init and mp pm constraint add', () => {
  let t: TestProject;
  before(() => {
    t = gitProject({ files: { 'frontend/package.json': '{ "name": "web" }\n', 'admin/package.json': '{ "name": "admin" }\n', 'api/pyproject.toml': '[project]\nname = "api"\n', 'node_modules/x/go.mod': 'module x\n' } });
    rmSync(join(t.dir, 'package.json'));
  });
  after(() => t.cleanup());

  it('mp init detects version commands in first-level folders, each once (frontend/package.json → node)', async () => {
    const r = await cli(t.dir, ['init']);
    assert.equal(r.code, 0, r.err);
    const cfg = JSON.parse(readFileSync(join(t.dir, '.mission-pipeline', 'config.json'), 'utf8'));
    assert.deepEqual(cfg.environment.versionCommands, ['node --version', 'python3 --version'], 'node once for two folders; nothing from node_modules');
  });

  it('mp pm constraint add --words records the words the constraint came from', async () => {
    const w = (await cli(t.dir, ['pm', 'say', 'Always use tabs in this project.', '--json'])).json.result.words as string;
    const r = await cli(t.dir, ['pm', 'constraint', 'add', 'tabs', '--kind', 'instruction', '--text', 'Indent with tabs', '--words', w, '--json']);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.result.words, w);
    const ctx = (await openProject({ cwd: t.dir, env: { MP_PROJECT: '' }, process: { observe: () => ENV_A } }, { flag: null, decides: false })).ctx;
    try {
      const bodies = ctx.memory.read((db) => flowEvents(db, { mission: 'project' as MissionId, line: 'requirements', event: 'constraint', limit: 100 })).map((e) => JSON.parse(ctx.memory.data.text(e.body)) as { line: string; words?: string });
      assert.deepEqual(bodies.map((b) => b.words), [w]);
    } finally {
      ctx.memory.close();
    }
    const none = await cli(t.dir, ['pm', 'constraint', 'add', 'other', '--kind', 'object', '--text', 'x', '--words', 'W-99', '--json']);
    assert.equal(none.code, 3);
    assert.equal(none.json.error.code, 'NO_WORDS');
  });
});
