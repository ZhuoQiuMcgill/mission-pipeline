// 4.4 (F4): the parked commit of a blocked hand-back, on a real repository. The engine collects the
// Constructor's in-scope edits as it collects a candidate and keeps them as a parked commit: not a
// product, never verified, reviewed, re-bound or delivered, held by a kept ref while its attempt can be
// resumed (and anchored again by each reconciliation, as a memory copied to another clone needs). The
// answer resumes the attempt with a new Constructor step whose worktree starts on the parked commit; its
// candidate is taken against the attempt's start, so the product holds the whole attempt's work. An
// untouched resumed dispatch released costs nothing (p3: a clean worktree at its start).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { keptRef } from '../src/git/refs.ts';
import { buildGraph } from '../src/cli/tree.ts';
import { cal1Pass, cal2Pass, secretary } from '../src/flow/scripted.ts';
import { pmDispatch, pmNext, pmRelease } from '../src/process/index.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { CHECK_JS, addDetailedPlan, handBack, processProject, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

const commitsOf = (pp: ProcessProject): string[] => pp.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.source.commit') AS c FROM log WHERE kind = 'object.version' AND json_extract(record, '$.source.commit') IS NOT NULL").all() as Array<{ c: string }>).map((r) => r.c));

describe('4.4 F4: a parked commit on a real repository', () => {
  it('holds the edits made before the pause; the resumed worktree starts on it; the product holds the whole attempt; it is never a product, and a ref keeps it', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));

    // the Constructor writes part of the work, then stops to ask
    const s = await readyOf(ctx, 'constructor');
    assert.equal(s.step, 'con.m1.impl.1');
    const d1 = pmDispatch(ctx, s.step);
    const wt1 = join(p.dir, d1.worktree!);
    const start = p.git('-C', wt1, 'rev-parse', 'HEAD');
    write(wt1, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    const a = await handBack(ctx, d1.dispatch, { done: 'wrote add; stopped before the check', unmet_standards: [], unfixed_problems: [], decisions_needed: [{ question: 'Is a check script wanted?', when: 'before-review' }], blocked: true });
    assert.ok(a.kind === 'recorded' && a.parked === true && a.candidate !== null, JSON.stringify(a));
    assert.equal(a.verification, null, 'nothing is verified');
    const parked = a.candidate.commit;
    assert.equal(p.git('show', `${parked}:src/add.js`), 'exports.add = (a, b) => a + b;');
    assert.equal(p.git('rev-parse', `${parked}^`), start, 'the parked commit is the edits on the attempt\'s start');
    assert.ok(!existsSync(wt1), 'the handed-back worktree is removed');
    assert.equal(p.git('rev-parse', keptRef(M, parked)), parked, 'a kept ref holds the parked commit');
    assert.ok(!commitsOf(p).includes(parked), 'no product version is recorded with it');
    assert.match(buildGraph(ctx, { mission: M }).nodes.get(`commit:${parked}`)?.title ?? '', /^the parked commit of dispatch D-\d+ \(its edits when it stopped to ask; not a product\)$/, 'the tree reads say what it is');
    const next = await pmNext(ctx);
    assert.ok(!next.ready.some((r) => r.kind === 'reviewer') && !next.held.some((r) => r.kind === 'reviewer'), 'no review is queued');

    // a reconciliation anchors it again when the ref is gone (a memory copied to another clone)
    p.git('update-ref', '-d', keptRef(M, parked));
    await pmNext(ctx);
    assert.equal(p.git('rev-parse', keptRef(M, parked)), parked);

    // the Secretary seat answers
    await step(ctx, 'secretary', (c: SecretaryCard) => secretary(c, 'answer', { instructions: 'Yes: add src/check.js.' }));
    const r = await readyOf(ctx, 'constructor');
    assert.equal(r.step, 'con.m1.impl.1.p1', 'a new Constructor step continues attempt 1');

    // an untouched resumed dispatch released costs nothing: its worktree is clean at the parked commit
    const d2 = pmDispatch(ctx, r.step);
    const wt2 = join(p.dir, d2.worktree!);
    assert.equal(p.git('-C', wt2, 'rev-parse', 'HEAD'), parked, 'the resumed worktree starts on the parked commit');
    assert.equal(readFileSync(join(wt2, 'src', 'add.js'), 'utf8'), 'exports.add = (a, b) => a + b;\n');
    const rel = await pmRelease(ctx, d2.dispatch, 'ended');
    assert.equal(rel.unstarted, 1, 'an unstarted release of the resumed dispatch costs nothing');

    const d3 = pmDispatch(ctx, r.step);
    const wt3 = join(p.dir, d3.worktree!);
    write(wt3, 'src/check.js', CHECK_JS);
    const b = await handBack(ctx, d3.dispatch, { done: 'added the check', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(b.kind === 'recorded' && b.candidate !== null && b.parked === undefined, JSON.stringify(b));
    assert.equal(p.git('rev-parse', `${b.candidate.commit}^`), start, 'the candidate is taken against the attempt\'s start');
    assert.deepEqual(b.candidate.changedPaths, ['src/add.js', 'src/check.js'], 'the product holds the edits before and after the pause');
    assert.ok(b.verification !== null && b.verification.every((v) => v.passed), 'the candidate is verified');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const accepted = ctx.memory.read((db) => db.stmt("SELECT key FROM flow_events WHERE line = 'task:impl' AND event = 'accepted'").all() as Array<{ key: string }>);
    assert.deepEqual(accepted.map((x) => x.key), ['1'], 'accepted at the same attempt');
    assert.ok(!commitsOf(p).includes(parked), 'the parked commit is never a product');
  });
});
