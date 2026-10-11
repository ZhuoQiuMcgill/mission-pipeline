// The reads of an exploration (design 4.1 §6.3, §8.4; decision 5): `mp read show exploration <id>`
// lists the findings round by round with the author's dispositions and the Stabilizer's verdicts;
// the tree reads connect the exploration's versions to the dispatches that handed them back and
// to the maintainer's words; `mp read show` of a dispatch and a notice; `mp read status` while a
// mission is in progress; after an environment change, `mp pm next` offers `mp pm renew`, which
// restores the proof without a seat when the declared outputs are equal (§6.5, decision 18).

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { cal1Fail, cal1Pass } from '../src/flow/scripted.ts';
import { pmMission, pmPlan, pmRequirement, pmSay } from '../src/process/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { cli } from './cli-fixtures.ts';
import { addMissionToReview, addPlan, ENV_B, processProject, reviewerPass, startAddMission, step } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const X = 'X1';

describe('mp read on an exploration with a Stabilizer round', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('show exploration: findings, dispositions and the Stabilizer\'s verdict per round; why from a version reaches the words', async () => {
    const ctx = p.ctx;
    pmMission(ctx, M);
    const w = pmSay(ctx, 'Find a cache design with no obvious logical hole. The details are yours to decide.').words;
    await pmRequirement(ctx, { mission: M, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
    await pmPlan(ctx, {
      mission: M,
      words: [w],
      plan: {
        format: 'mp4.pm-plan.v1',
        mission: M,
        round: 1,
        order: 'free',
        elements: [
          {
            id: 'x',
            kind: 'exploration',
            text: 'Design the cache',
            provenance: { by: 'user', words: w, quote: 'Find a cache design' },
            exploration: { id: X, deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: 'structure' }, budget: { rounds: 3, micros: null }, stop: '', research: false },
            after: [],
            items: [],
          },
        ],
        goalsBeyond: [],
        authorizations: ['a1'],
      },
    });
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'researcher-author', () => ({ step: 'submit', message: 'a version', artifact: 'v1: an LRU cache with a lock', dispositions: [], directionQuestions: [], attempts: [] }));
    await step(ctx, 'crititor', (c: CrititorCard) => ({ findings: [{ severity: 'serious', class: 'internal contradiction', title: 'the lock and the eviction contradict', basis: 'the passage', consequence: 'it deadlocks', direction: 'fix it', evidence: [] }], rechecks: [], settled: [], reply: 'assessment', ...(c ? {} : {}) }));
    await step(ctx, 'researcher-author', (c: AuthorCard) => ({ step: 'submit', message: 'v2', artifact: 'v2: lock-free eviction', dispositions: c.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'changed' })), directionQuestions: [], attempts: [] }));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => ({
      findings: c.findings.map((f) => ({ finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'a real hole', question: '' })),
      round: { verdict: 'on-track', reason: 'answers the question', question: '' },
    }));

    const show = await cli(p.dir, ['read', 'show', 'exploration', X]);
    assert.equal(show.code, 0, show.err);
    assert.match(show.out, /exploration X1 of mission m1/);
    assert.match(show.out, /round 1 — Stabilizer \(.+\): on-track/);
    assert.match(show.out, /\[serious\] the lock and the eviction contradict — .*disposition: revise; Stabilizer: in-scope/);
    const json = await cli(p.dir, ['read', 'show', 'exploration', `${M}/${X}`, '--json']);
    assert.equal(json.json.result[0].findings[0].scope, 'in-scope');

    const tree = await cli(p.dir, ['read', 'tree', M]);
    assert.match(tree.out, /- exploration m1\/X1 /);
    const why = await cli(p.dir, ['read', 'why', 'D-5', '--json']);
    assert.equal(why.code, 0, why.err);
    assert.equal(why.json.result.reachesWords, true, JSON.stringify(why.json.result.nodes.map((n: { key: string }) => n.key)));

    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.json.result.missions[0].mission, M);
    const d = await cli(p.dir, ['read', 'show', 'dispatch', 'D-1']);
    assert.match(d.out, /material pages read: /);
    assert.equal((await cli(p.dir, ['read', 'show', 'dispatch', 'D-99'])).code, 3);
  });
});

describe('mp pm renew after an environment change (§6.5, decision 18)', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('next reports the change and offers renew; renew reruns the declared commands and restores the proof', async () => {
    await addMissionToReview(p, 'm2');
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    const product = 'prod.con.m2.impl.1';
    const before = await cli(p.dir, ['read', 'show', 'object', product, '--json']);
    assert.match(before.json.result.items[0].node.state, /^proven/);
    const next = await cli(p.dir, ['pm', 'next', '--json'], { env: ENV_B });
    assert.equal(next.code, 0, next.err);
    assert.ok(next.json.problems.some((x: { code: string }) => x.code === 'ENVIRONMENT'), JSON.stringify(next.json.problems));
    assert.ok(next.json.result.renew !== null && next.json.result.renew.candidates >= 1, JSON.stringify(next.json.result.renew));
    assert.match((await cli(p.dir, ['pm', 'next'], { env: ENV_B })).out, /Ready: mp pm renew/);
    const r = await cli(p.dir, ['pm', 'renew', '--json'], { env: ENV_B });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.json.result.reruns.length >= 1 && r.json.result.reruns.every((x: { passed: boolean }) => x.passed), JSON.stringify(r.json.result));
    await cli(p.dir, ['pm', 'next'], { env: ENV_B });
    const now = await cli(p.dir, ['read', 'show', 'object', product, '--json'], { env: ENV_B });
    assert.match(now.json.result.items[0].node.state, /^proven/);
  });
});

describe('the tree reads show the decision in effect and contested requirement items (final review F2, F3)', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('Calibrator ① asking the user contests the item; once a plan passes Calibrator ①, it is in force again', async () => {
    const ctx = p.ctx;
    await startAddMission(ctx, 'm3');
    await step(ctx, 'calibrator-1', (c) => cal1Fail(c, 'e1', 'ask-user'));
    const contested = await cli(p.dir, ['read', 'show', 'requirement', 'item.m3.g1', '--json']);
    assert.equal(contested.code, 0, contested.err);
    assert.equal(contested.json.result.items[0].node.state, 'contested');
    const w2 = pmSay(ctx, 'Yes, an add function is what I want.').words;
    await pmPlan(ctx, { mission: 'm3', plan: addPlan('m3', 'W-1'), words: ['W-1', w2] });
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    const settled = await cli(p.dir, ['read', 'show', 'requirement', 'item.m3.g1', '--json']);
    assert.equal(settled.json.result.items[0].node.state, 'in force');
  });

  it('a Secretary\'s ask-user answered by the user: the user\'s option is in effect, linked to their words entry; the ask-user is history', async () => {
    const ctx = p.ctx;
    const spec = { id: 'esc1', task: 'sec.esc1', source: 'loop-exhausted', lineage: 'line1', subject: 'task:con1', summary: 'The loop is exhausted', reasons: ['retry required'], options: ['grant', 'ask-user'] };
    const decision = { escalation: 'esc1', by: 'secretary', option: 'ask-user', classification: 'needs-user', authorization: null, reason: 'Please ask the user', instructions: '', grantExtra: 0, notice: 'Please ask the user', mayMatter: false };
    await ctx.ports().ledger.append('fixture:escalation', {
      events: [
        { mission: 'm3' as never, line: 'secretary', event: 'escalation', key: 'esc1', body: spec },
        { mission: 'm3' as never, line: 'secretary', event: 'decision', key: 'esc1', body: decision },
      ],
    });
    const w = pmSay(ctx, 'Grant one more attempt.').words;
    const a = await cli(p.dir, ['pm', 'answer', 'm3', 'esc1', '--option', 'grant', '--extra', '1', '--words', w, '--json']);
    assert.equal(a.code, 0, a.out + a.err);
    const why = await cli(p.dir, ['read', 'why', 'decision:m3/esc1', '--json']);
    const node = why.json.result.nodes.find((n: { key: string }) => n.key === 'decision:m3/esc1');
    assert.match(node.title, /^grant/);
    assert.match(node.title, /earlier: the secretary chose ask-user \(needs-user\)/);
    assert.match(node.by, new RegExp(`^the user \\(${w}\\)`));
    assert.match(node.state, /^in effect/);
    assert.ok(why.json.result.edges.some((e: { from: string; to: string; rel: string }) => e.from === 'decision:m3/esc1' && e.to === `words:${w}` && e.rel === 'the user decided in'));
    assert.equal(why.json.result.reachesWords, true);
    const tree = await cli(p.dir, ['read', 'tree', 'm3']);
    assert.match(tree.out, /- decision m3\/esc1 — grant/);
    // final review (i): the documented <kind> <id> form finds the decision next to its escalation
    const show = await cli(p.dir, ['read', 'show', 'decision', 'm3/esc1', '--json']);
    assert.equal(show.code, 0, show.out);
    assert.equal(show.json.result.items[0].node.kind, 'decision');
  });
});
