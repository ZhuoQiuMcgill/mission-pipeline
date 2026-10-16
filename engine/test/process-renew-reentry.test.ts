import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256 } from '../src/common/hash.ts';
import type { EvidenceId, JudgmentId } from '../src/common/ids.ts';
import type { EvidenceRecord } from '../src/common/records.ts';
import { decisionLabels, recordEnvironment, renewalCandidates } from '../src/evaluator/index.ts';
import { effectiveEvidence, evidenceApplicable } from '../src/evaluator/semantics.ts';
import { StoredIndex } from '../src/evaluator/store.ts';
import { appendRecords, flowEvents, tryLock } from '../src/memory/index.ts';
import { pmNext, pmRenew, runOnCommit, shellRunner, type ProcessContext } from '../src/process/index.ts';
import { builders } from './labels-fixtures.ts';
import { addDetailedPlan, addMissionToReview, ENV_A, ENV_B, processProject, reviewerPass, step } from './process-fixtures.ts';

const declared = [{ id: 'A', command: 'echo A' }, { id: 'B', command: 'echo B' }];
const mixed = [{ id: 'setup', command: 'echo setup', network: true }, ...declared];
const ENV_C = { ...ENV_A, os: 'thirdos' };
const declaration = { by: 'mp' as const, checkout: 'clean' as const, declared: true };

/** Every reported success applies; every remaining normal candidate has a Reviewer or a busy exit. */
async function checkedRenew(ctx: ProcessContext) {
  const result = await pmRenew(ctx);
  assert.ok(result.skipped.every((s) => !s.why.includes('OP_CONFLICT')), JSON.stringify(result));
  ctx.memory.read((db) => {
    const ix = new StoredIndex(db);
    for (const r of result.reruns) for (const jid of r.renewed) {
      const j = ix.judgments.get(jid as JudgmentId)!.rec;
      assert.ok(j.evidence.some((e) => effectiveEvidence(ix, j, e as EvidenceId) === r.run), `${jid} actually uses ${r.run}`);
      assert.ok(j.evidence.every((e) => evidenceApplicable(ix, effectiveEvidence(ix, j, e as EvidenceId))), `${jid} applies under the current identity`);
    }
    const reviews = flowEvents(db, { mission: 'm1' as never, line: 'renew', event: 'review-needed' });
    for (const cand of renewalCandidates(db).candidates) for (const j of cand.judgments) {
      assert.ok(reviews.some((e) => e.key === `${j.judgment}@${result.environment}`)
        || result.skipped.some((s) => s.evidence === cand.evidence && /busy|LOCKED/i.test(s.why)), `remaining ${j.judgment} has an exit`);
    }
    const edges = db.stmt('SELECT o.rev AS a, r.rev AS b FROM lbl_renewals n JOIN lbl_evidence o ON o.evidence = n.original JOIN lbl_evidence r ON r.evidence = n.replacement').all() as Array<{ a: number; b: number }>;
    assert.ok(edges.every((e) => e.b > e.a), 'every newly recorded renewal advances in log order');
  });
  return result;
}

function factCounts(ctx: ProcessContext) {
  return ctx.memory.read((db) => ({
    renewals: db.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence.renewal'").get(),
    reviews: flowEvents(db, { mission: 'm1' as never, line: 'renew', event: 'review-needed' }).length,
  }));
}

/** A retry changes no renewal or Reviewer facts (mixed setup may run again: existing backlog). */
async function settledRenew(ctx: ProcessContext) {
  const first = await checkedRenew(ctx);
  const counts = factCounts(ctx);
  const again = await checkedRenew(ctx);
  assert.deepEqual(again.reruns.flatMap((r) => r.renewed), [], 'a second renew reports no new successes');
  assert.deepEqual(factCounts(ctx), counts, 'a second renew changes no renewal or Reviewer facts');
  return first;
}

for (const method of ['legacy', 'v2'] as const) {
  test(`late judgment in a mixed group renews without an op conflict: ${method}`, async () => {
    const p = processProject();
    try {
      const commit = p.git('rev-parse', 'HEAD');
      let originals: string[];
      const b = builders(p.ctx.memory);
      if (method === 'legacy') {
        const identity = sha256(canonicalJson(ENV_A));
        originals = ['old-setup', 'old-A', 'old-B'];
        p.ctx.memory.write({}, (tx) => {
          recordEnvironment(tx, { identity: identity as never, parts: ENV_A });
          appendRecords(tx, mixed.map((c, i) => b.evidence(originals[i]!, identity, i === 0 ? 'other' : 'declared', { candidate: commit, command: c.command, run: 'legacy-group', exit: '0', status: 'completed' })));
        });
      } else {
        const r = await runOnCommit(p.ctx, { mission: 'm1', commit, commands: mixed, purpose: 'original', declaration });
        originals = r.runs.map((r) => r.evidence);
      }
      p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.product('Q', { commit }), b.judge('J', 'P', { evidence: [originals[1]!] })]));
      const ctx = p.reopen(method === 'legacy' ? ENV_A : ENV_B);
      assert.deepEqual((await settledRenew(ctx)).reruns.flatMap((r) => r.renewed), ['J']);
      ctx.memory.write({}, (tx) => appendRecords(tx, [builders(ctx.memory).judge('K', 'Q', { evidence: [originals[2]!] })]));
      assert.deepEqual((await settledRenew(ctx)).reruns.flatMap((r) => r.renewed), ['K']);
      assert.deepEqual(ctx.memory.read((db) => decisionLabels(db, ['P', 'Q'])), { P: 'proven', Q: 'proven' });
      const writes = ctx.memory.stmt("SELECT op FROM ops WHERE op LIKE 'run:%'").all();
      assert.ok(writes.length > 0, 'execution uses per-run operation ids');
    } finally { p.cleanup(); }
  });
}

test('all-reused renewal pairs include late K, then late L in their op identity', async () => {
  const p = processProject();
  try {
    const commit = p.git('rev-parse', 'HEAD');
    const req = { mission: 'm1', commit, commands: declared, purpose: 'verification', declaration };
    const old = await runOnCommit(p.ctx, req);
    const b = builders(p.ctx.memory);
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.product('Q', { commit }), b.product('R', { commit }), b.judge('J', 'P', { evidence: [old.runs[0]!.evidence] })]));
    let calls = 0;
    const ctx = p.reopen(ENV_B, { runner: (req) => { calls++; return shellRunner(req); } });
    await runOnCommit(ctx, req);
    calls = 0;
    for (const [judgment, target] of [['J', 'P'], ['K', 'Q'], ['L', 'R']]) {
      if (judgment !== 'J') ctx.memory.write({}, (tx) => appendRecords(tx, [builders(ctx.memory).judge(judgment!, target!, { evidence: [old.runs[0]!.evidence] })]));
      const result = await settledRenew(ctx);
      assert.deepEqual(result.reruns.flatMap((r) => r.renewed), [judgment]);
      assert.equal(ctx.memory.read((db) => decisionLabels(db, [target!]))[target!], 'proven');
    }
    assert.equal(calls, 0, 'all three pairings reuse the same recorded replacements');
    const ops = ctx.memory.stmt("SELECT op FROM ops WHERE op LIKE 'renew-pairs:%'").all() as Array<{ op: string }>;
    assert.equal(ops.length, 3);
    assert.ok(ops.every((o) => o.op.includes(ctx.environment().identity)));
  } finally { p.cleanup(); }
});

for (const commands of [declared, mixed]) for (const path of [[ENV_B, ENV_A], [ENV_B, ENV_C, ENV_B]]) {
  test(`environment return executes fresh evidence: ${commands === mixed ? 'partial reuse' : 'full reuse'}, A→${path.map((e) => e === ENV_A ? 'A' : e === ENV_B ? 'B' : 'C').join('→')}`, async () => {
    const calls: string[] = [];
    const p = processProject({ options: { runner: (req) => { calls.push(req.command); return shellRunner(req); } } });
    try {
      const commit = p.git('rev-parse', 'HEAD');
      const original = await runOnCommit(p.ctx, { mission: 'm1', commit, commands, purpose: 'original', declaration });
      const a = original.runs.find((r) => r.command.id === 'A')!;
      const b = builders(p.ctx.memory);
      p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.judge('J', 'P', { evidence: [a.evidence] })]));
      for (const [i, env] of path.entries()) {
        const ctx = p.reopen(env);
        calls.length = 0;
        const result = await settledRenew(ctx);
        assert.deepEqual(result.reruns.flatMap((r) => r.renewed), ['J']);
        assert.deepEqual(calls, commands.map((c) => c.command), 'one actual suite execution, including setup');
        assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], 'proven');
        const evidence = result.reruns[0]!.run;
        assert.notEqual(evidence, a.evidence);
        const row = ctx.memory.stmt('SELECT fields FROM lbl_evidence WHERE evidence = ?').get(evidence) as { fields: string };
        assert.equal(JSON.parse(row.fields)['runMethod'], 'v2');
        const fresh = (ctx.memory.stmt("SELECT record FROM log WHERE kind = 'evidence' AND json_extract(record, '$.fields.run') = ?").all(JSON.parse(row.fields)['run']) as Array<{ record: string }>).map((r) => JSON.parse(r.record) as EvidenceRecord);
        if (i === path.length - 1) assert.equal(fresh.filter((r) => r.runClass === 'declared').length, 1, 'on return only A is recorded fresh; B ran as setup');
      }
    } finally { p.cleanup(); }
  });
}

test('a forced fresh renewal takes its declared lock and has a busy retry exit', async () => {
  const p = processProject();
  try {
    const commit = p.git('rev-parse', 'HEAD');
    const r = await runOnCommit(p.ctx, { mission: 'm1', commit, commands: declared, purpose: 'original', declaration });
    const b = builders(p.ctx.memory);
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.judge('J', 'P', { evidence: [r.runs[0]!.evidence] })]));
    await settledRenew(p.reopen(ENV_B));
    const ctx = p.reopen(ENV_A);
    const key = { candidate: commit, command: declared[0]!.command, cwd: '.', environment: ctx.environment().identity, method: 'v2' };
    const lock = tryLock(join(ctx.memory.paths.locks, 'runs'), `run-${sha256(canonicalJson(key)).slice(0, 40)}`);
    assert.ok(lock);
    try {
      const busy = await checkedRenew(ctx);
      assert.deepEqual(busy.reruns, []);
      assert.equal(busy.skipped.length, 1);
    } finally { lock.release(); }
    assert.deepEqual((await settledRenew(ctx)).reruns.flatMap((r) => r.renewed), ['J']);
  } finally { p.cleanup(); }
});

for (const commands of [declared, mixed]) {
  test(`refused field then renew again creates one Reviewer request: ${commands === mixed ? 'mixed' : 'declared'}`, async () => {
    const p = processProject();
    try {
      const commit = p.git('rev-parse', 'HEAD');
      const old = await runOnCommit(p.ctx, { mission: 'm1', commit, commands, purpose: 'original', declaration });
      const b = builders(p.ctx.memory);
      p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.judge('J', 'P', { evidence: [old.runs.find((r) => r.command.id === 'A')!.evidence], fields: ['output'] })]));
      const ctx = p.reopen(ENV_B, { runner: (req) => ({ ...shellRunner(req), output: Buffer.from('changed output\n') }) });
      const result = await settledRenew(ctx);
      assert.deepEqual(result.reruns.flatMap((r) => r.renewed), []);
      assert.match(result.reruns[0]!.refused[0]!.reason, /field-differs/);
      assert.equal(result.reviewSteps, 1);
      assert.equal(ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: 'renew', event: 'review-needed' })).length, 1);
      assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], 'not-fully-proven');
    } finally { p.cleanup(); }
  });
}

test('throw between execution and write rolls back, releases locks, and the next renew succeeds', async () => {
  const p = processProject();
  try {
    const commit = p.git('rev-parse', 'HEAD');
    const old = await runOnCommit(p.ctx, { mission: 'm1', commit, commands: mixed, purpose: 'original', declaration });
    const b = builders(p.ctx.memory);
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.judge('J', 'P', { evidence: [old.runs[1]!.evidence] })]));
    const ctx = p.reopen(ENV_B);
    const write = ctx.memory.write.bind(ctx.memory);
    let injected = false;
    ctx.memory.write = (o, fn) => {
      if (!injected && o.op?.startsWith('run:')) { injected = true; throw new Error('injected after execution, before write'); }
      return write(o, fn);
    };
    const before = factCounts(ctx);
    const interrupted = await pmRenew(ctx);
    assert.equal(injected, true);
    assert.match(interrupted.skipped[0]!.why, /injected/);
    assert.deepEqual(interrupted.reruns, []);
    assert.deepEqual(factCounts(ctx), before);
    const result = await settledRenew(ctx);
    assert.deepEqual(result.reruns.flatMap((r) => r.renewed), ['J']);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], 'proven');
  } finally { p.cleanup(); }
});

test('renew refuses a replacement that does not become the effective evidence', async () => {
  const p = processProject();
  try {
    const commit = p.git('rev-parse', 'HEAD');
    const req = { mission: 'm1', commit, commands: [declared[0]!], purpose: 'verification', declaration };
    const original = (await runOnCommit(p.ctx, req)).runs[0]!.evidence;
    const replacement = (await runOnCommit(p.reopen(ENV_B), req)).runs[0]!.evidence;
    const later = (await runOnCommit(p.reopen(ENV_C), req)).runs[0]!.evidence;
    const b = builders(p.ctx.memory);
    // A disconnected, already recorded forward edge: pairing original→replacement
    // would immediately resolve onward to a different environment's evidence.
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.judge('J', 'P', { evidence: [original] }), { kind: 'evidence.renewal', judgment: 'J' as never, original: replacement as never, replacement: later as never }]));
    const ctx = p.reopen(ENV_B);
    const result = await checkedRenew(ctx);
    assert.deepEqual(result.reruns.flatMap((r) => r.renewed), []);
    assert.match(result.reruns[0]!.refused[0]!.reason, /did not make the replacement effective/);
    assert.equal(result.reviewSteps, 1);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], 'not-fully-proven');
    // The existing forward edge is now connected: a retry can replace its endpoint
    // with a real fresh run. That recovery, in turn, has a no-op second renew.
    assert.deepEqual((await settledRenew(ctx)).reruns.flatMap((r) => r.renewed), ['J']);
  } finally { p.cleanup(); }
});

test('a refused renewal and repeated renew leave exactly one actual Reviewer step', async () => {
  const p = processProject();
  try {
    await addMissionToReview(p, 'm1');
    await step(p.ctx, 'reviewer', (card) => reviewerPass(card));
    const ctx = p.reopen(ENV_B, { runner: (req) => ({ ...shellRunner(req), exitCode: 1 }) });
    const result = await settledRenew(ctx);
    assert.ok(result.reruns.some((r) => r.refused.length > 0));
    const next = await pmNext(ctx);
    assert.equal(next.ready.filter((s) => s.kind === 'reviewer').length, 1, 'the refusal has one queued Reviewer');
    assert.deepEqual(next.errors, []);
  } finally { p.cleanup(); }
});

// ---- Stabilizer P1 r3: one Reviewer request per (judgment, environment), never an op conflict

function requestsOf(ctx: ProcessContext, missions: readonly string[]) {
  return ctx.memory.read((db) => missions.flatMap((mission) => flowEvents(db, { mission: mission as never, line: 'renew', event: 'review-needed' })));
}

test('two refused reruns on one judgment, two products in one renew, and a retry: one request each, no conflict', async () => {
  const p = processProject();
  try {
    for (const mission of ['m1', 'm2']) {
      await addMissionToReview(p, mission, { detailed: addDetailedPlan(mission, { verification: [{ id: 'a', command: `echo ${mission}-A` }, { id: 'b', command: `echo ${mission}-B` }] }) });
      await step(p.ctx, 'reviewer', (card) => reviewerPass(card));
    }
    // both declared commands now fail: every cited run is refused (a vacuous pass that now fails)
    const ctx = p.reopen(ENV_B, { runner: (req) => ({ ...shellRunner(req), exitCode: 1 }) });
    const first = await pmRenew(ctx);
    const refusedBy = new Map<string, number>();
    for (const r of first.reruns) for (const f of r.refused) refusedBy.set(f.judgment, (refusedBy.get(f.judgment) ?? 0) + 1);
    assert.deepEqual([...refusedBy.values()], [2, 2], 'each judgment has two refused reruns');
    assert.equal(first.reviewSteps, 2);
    const requests = requestsOf(ctx, ['m1', 'm2']);
    assert.deepEqual(requests.map((e) => e.mission), ['m1', 'm2'], 'the second product gets its request too');
    for (const e of requests) {
      const body = JSON.parse(ctx.memory.data.get(e.body as never).toString("utf8")) as { reason: string; rerun: string };
      const runs = first.reruns.filter((r) => r.refused.some((f) => `${f.judgment}@${first.environment}` === e.key)).map((r) => r.run);
      assert.equal(runs.length, 2);
      for (const run of runs) assert.ok(body.reason.includes(run), 'the one request names every refused rerun');
    }
    const ops = ctx.memory.stmt("SELECT op FROM ops WHERE op LIKE 'renew-review:%'").all();
    const again = await pmRenew(ctx);
    assert.equal(again.reviewSteps, 2);
    assert.deepEqual(requestsOf(ctx, ['m1', 'm2']), requests, 'a retry appends nothing');
    assert.deepEqual(ctx.memory.stmt("SELECT op FROM ops WHERE op LIKE 'renew-review:%'").all(), ops, 'a retry replays the recorded request write');
    const next = await pmNext(ctx);
    assert.deepEqual(next.ready.filter((s) => s.kind === 'reviewer').map((s) => s.mission).sort(), ['m1', 'm2'], 'one queued Reviewer per product');
    assert.deepEqual(next.errors, []);
  } finally { p.cleanup(); }
});

test('causes that differ for one judgment (run classes never renewed) give one request', async () => {
  const p = processProject();
  try {
    const identity = sha256(canonicalJson(ENV_A));
    const b = builders(p.ctx.memory);
    p.ctx.memory.write({}, (tx) => {
      recordEnvironment(tx, { identity: identity as never, parts: ENV_A });
      appendRecords(tx, [b.evidence('s1', identity, 'sampling'), b.evidence('o1', identity, 'other'), b.product('P'), b.judge('J', 'P', { evidence: ['s1', 'o1'] })]);
    });
    const ctx = p.reopen(ENV_B);
    const r = await pmRenew(ctx);
    assert.equal(r.reviews.length, 2);
    assert.equal(r.reviewSteps, 1);
    assert.equal(requestsOf(ctx, ['m1']).length, 1);
    await pmRenew(ctx);
    assert.equal(requestsOf(ctx, ['m1']).length, 1);
  } finally { p.cleanup(); }
});

test('a request already recorded under the key stands when the causes changed; other products still get theirs', async () => {
  const p = processProject();
  try {
    const identity = sha256(canonicalJson(ENV_A));
    const b = builders(p.ctx.memory);
    p.ctx.memory.write({}, (tx) => {
      recordEnvironment(tx, { identity: identity as never, parts: ENV_A });
      appendRecords(tx, [b.evidence('s1', identity, 'sampling'), b.evidence('s2', identity, 'sampling'), b.product('P'), b.product('Q'), b.judge('J', 'P', { evidence: ['s1'] }), b.judge('K', 'Q', { evidence: ['s2'] })]);
    });
    const ctx = p.reopen(ENV_B);
    const env = ctx.environment().identity;
    // an earlier renew recorded J's request with fewer causes (another body under the same key)
    const earlier = { judgment: 'J', target: 'P', review: 'reviewer', environment: env, reason: 'an earlier cause', rerun: null, passed: null };
    ctx.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: 'm1' as never, line: 'renew', event: 'review-needed', key: `J@${env}`, body: tx.data.put(canonicalJson(earlier)) as never }]));
    const r = await pmRenew(ctx);
    assert.equal(r.reviewSteps, 2);
    const requests = requestsOf(ctx, ['m1']);
    assert.deepEqual(requests.map((e) => e.key).sort(), [`J@${env}`, `K@${env}`]);
    assert.equal(JSON.parse(ctx.memory.data.get(requests.find((e) => e.key === `J@${env}`)!.body as never).toString("utf8")).reason, 'an earlier cause', 'the first request stands');
  } finally { p.cleanup(); }
});
