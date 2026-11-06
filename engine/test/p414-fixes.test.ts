import assert from 'node:assert/strict';
import test from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { compareToCommit } from '../src/git/workspace.ts';
import { compareWorktree, land } from '../src/git/land.ts';
import { pmClose } from '../src/process/close.ts';
import { pmRepair } from '../src/process/pm.ts';
import { buildGraph, resolveNodes, walk } from '../src/cli/tree.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { commitOn, fixture, M as GM, recordedDelivery, words, write } from './git41-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const events = <B = any>(w: World, line: string, event: string) => w.ledger.events<B>({ mission: M, line, event });
const escalations = async (w: World) => (await events<EscalationBody>(w, 'secretary', 'escalation')).map((e) => e.body).filter((e) => e.source === 'loop-exhausted');
function plan() {
  const p = detailedPlan(M);
  return { ...p, tasks: [...p.tasks, { ...p.tasks[1]!, id: 'integ', kind: 'integration' as const, module: null, writeScope: [], implements: [], calls: [], dependsOn: ['impl'], provenance: { planElements: ['e1', 'e2'] } }] };
}
function script(over: Record<string, Script> = {}): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : base)(t, s);
}
async function usedUp(spentGrant = false) {
  const w = memoryPorts();
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const engine = new FlowEngine(w);
  let n = 0;
  let granted = false;
  await drive(engine, w.scheduler, script({
    reviewer: (t) => {
      const c = t.card as unknown as ReviewerCard;
      if (c.target.includes('integ')) return null;
      return { handBack: reviewer(c, c.target.includes('impl') ? 'rework' : 'pass', { findings: [`dependency finding ${++n}`] }) };
    },
    secretary: (t) => {
      const card = t.card as unknown as SecretaryCard;
      if (spentGrant && !granted) { granted = true; return { handBack: secretary(card, 'grant', { grantExtra: 1 }) }; }
      return { handBack: secretary(card, 'accept-risk', { classification: 'important-within-authority', notice: 'accept the dependency risk' }) };
    },
  }));
  assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), `prod.con.m1.impl.${spentGrant ? 4 : 3}`);
  return { w, engine };
}
const reopenReview: Script = (t) => {
  const c = t.card as unknown as ReviewerCard;
  return c.target.includes('integ') ? { handBack: { ...reviewer(c, 'rework', { findings: ['quoted integration finding'] }), reopen: [{ task: 'impl', issue: 'dependency is slow' }] } } : { handBack: reviewer(c, 'pass') };
};
async function reviewedReopen(spentGrant = false) {
  const x = await usedUp(spentGrant);
  await drive(x.engine, x.w.scheduler, script({ reviewer: reopenReview, secretary: () => null }));
  return x;
}
async function unchanged(w: World, engine: FlowEngine) {
  const head = w.ledger.head;
  const reports = await engine.reconcile();
  assert.deepEqual(reports.flatMap((r) => r.errors), []);
  assert.equal(w.ledger.head, head, 'a further pass writes nothing');
}

test('#47 review reopen gets a distinct escalation and its own Secretary step', async () => {
  const { w, engine } = await reviewedReopen();
  const es = await escalations(w);
  assert.equal(es.length, 2);
  assert.notEqual(es[0]!.id, es[1]!.id);
  assert.ok(w.scheduler.queued('secretary').some((t) => t.task === es[1]!.task));
  await unchanged(w, engine);
});

test('#47 repair reopen gets a distinct escalation; #50 repair offers no accept-risk', async () => {
  const { w, engine } = await usedUp();
  const words = say(w, 'Fix the dependency speed.');
  await pmRepair(w.ctx, { mission: M, words, kind: 'usability', text: 'dependency speed' });
  await drive(engine, w.scheduler, script({ reviewer: () => null, secretary: () => null,
    'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'dependency speed' }], add: [], note: 'impl owns it' } }),
  }));
  const es = await escalations(w);
  assert.equal(es.length, 2);
  assert.notEqual(es[0]!.id, es[1]!.id);
  assert.ok(!es[1]!.options.includes('accept-risk'));
  assert.ok(w.scheduler.queued('secretary').some((t) => t.task === es[1]!.task));
  await unchanged(w, engine);
});

test('#47 grant on the reopen overrides the kept negative verdict and integration proceeds', async () => {
  const { w, engine } = await reviewedReopen();
  const esc = (await escalations(w))[1]!;
  const words = say(w, 'Grant another attempt to fix the dependency.');
  await answerEscalation(w, { mission: M, escalation: esc.id, option: 'grant', words: `Grant another attempt. (${words})`, grantExtra: 1 });
  await drive(engine, w.scheduler, script());
  assert.ok(w.scheduler.tasks.has('con.m1.impl.4'));
  assert.ok(await acceptedProduct(flowCtx(w, M), 'integ'));
  await unchanged(w, engine);
});

test('#47 a 4.1.3-shaped kept verdict without the reopen escalation heals on the next pass', async () => {
  const { w, engine } = await usedUp();
  w.ledger.failNext = (op) => op.startsWith('flow:escalation:');
  await assert.rejects(drive(engine, w.scheduler, script({ reviewer: reopenReview, secretary: () => null })), /injected failure/);
  assert.ok((await events<{ proceed: boolean }>(w, 'task:impl', 'loop-verdict')).some((e) => e.key === 'reopen:integ:1' && !e.body.proceed));
  assert.equal((await escalations(w)).length, 1, 'only the already-decided ordinary escalation exists');
  await drive(engine, w.scheduler, script({ reviewer: () => null, secretary: () => null }));
  assert.equal((await escalations(w)).length, 2);
  await unchanged(w, engine);
});

for (const by of ['user', 'secretary'] as const) test(`#50 review-reopen accept-risk by ${by} accepts the reviewed product and records the ruling`, async () => {
  const { w, engine } = await reviewedReopen(true);
  const esc = (await escalations(w)).at(-1)!;
  assert.ok(esc.options.includes('accept-risk'));
  const card = w.scheduler.card<SecretaryCard>(esc.task);
  assert.equal(card.grantAvailable, false, 'the Secretary already spent its grant');
  assert.match(card.options.find((o) => o.id === 'accept-risk')!.outcome, /no further review round runs/);
  let words: string | undefined;
  if (by === 'user') {
    words = say(w, 'Accept the integration with the remaining finding as a risk.');
    await answerEscalation(w, { mission: M, escalation: esc.id, option: 'accept-risk', words: `Accept it as it is. (${words})` });
  }
  await drive(engine, w.scheduler, script({ secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'accept-risk', { classification: 'important-within-authority', notice: 'accept the integration risk' }) }) }));
  const accepted = (await events(w, 'task:integ', 'accepted'))[0]!.body;
  const reviewed = (await events(w, 'task:integ', 'product'))[0]!.body;
  const review = (await events(w, 'task:integ', 'review'))[0]!.body;
  assert.equal(accepted.k, 2);
  assert.equal(accepted.product, reviewed.object);
  assert.equal(accepted.decision.escalation, esc.id);
  assert.equal(accepted.decision.option, 'accept-risk');
  assert.equal(accepted.decision.by, by);
  assert.equal(accepted.decision.words, words);
  assert.ok(accepted.risks.some((r: string) => r.includes('quoted integration finding')));
  const ruling = await w.ledger.judgment(accepted.judgment);
  assert.equal(ruling?.target, reviewed.object);
  assert.equal(ruling?.executor, by);
  assert.equal(ruling?.verdict, 'pass');
  assert.equal(ruling?.revokes, review.judgment);
  assert.ok(!w.scheduler.tasks.has('con.m1.impl.5'));
  assert.ok(!w.scheduler.tasks.has('rev.m1.integ.2'));
  const graph = buildGraph(w.ctx, { mission: M });
  assert.match(walk(w.ctx, graph, resolveNodes(graph, w.ctx, accepted.product), 'back').text, /accepted with its risk/);
  await unchanged(w, engine);
  const closed = await pmClose(w.ctx, M, { mode: 'with-risk' });
  assert.ok(closed.doc.acceptedWithRisk?.some((r) => r.task === 'integ'));
  assert.ok(closed.risks.some((r) => r.includes('quoted integration finding')));
});

test('#50 accept-risk waits for the dependency versions reviewed and retries every pass', async () => {
  const { w, engine } = await reviewedReopen();
  const esc = (await escalations(w))[1]!;
  const iface = (await events(w, 'task:iface', 'accepted'))[0]!.body;
  await w.ledger.append('test:dependency-reopened', { events: [{ mission: M, line: 'task:iface', event: 'rework', key: '2', body: { k: 2, reason: 'reopen', issues: ['recheck'], instructions: [] } }] });
  const words = say(w, 'Accept the reviewed integration once its inputs are still accepted.');
  await answerEscalation(w, { mission: M, escalation: esc.id, option: 'accept-risk', words: `Accept it. (${words})` });
  await engine.reconcile();
  assert.equal((await events(w, 'task:integ', 'accepted')).length, 0);
  assert.ok(w.ledger.notices.some((n) => n.category === 'accept-risk-waits'));
  assert.ok(!(await events(w, 'secretary', 'applied')).some((e) => e.key === esc.id));
  await unchanged(w, engine);
  // Restore acceptance of the exact reviewed input, rather than substitute a newer product.
  await w.ledger.append('test:input-accepted-again', { events: [{ mission: M, line: 'task:iface', event: 'accepted', key: '2', body: { ...iface, k: 2 } }] });
  await engine.reconcile();
  assert.equal((await events(w, 'task:integ', 'accepted')).length, 1);
  await unchanged(w, engine);
});

test('#50 accept-risk is moot after the waiting integration is given up and writes no ruling', async () => {
  const { w, engine } = await reviewedReopen();
  const esc = (await escalations(w))[1]!;
  await w.ledger.append('test:integration-given-up', { events: [{ mission: M, line: 'task:integ', event: 'abandoned', key: 'abandoned', body: { k: 2, reason: 'superseded work' } }] });
  const words = say(w, 'Accept it if the integration still waits.');
  await answerEscalation(w, { mission: M, escalation: esc.id, option: 'accept-risk', words: `Accept it. (${words})` });
  await engine.reconcile();
  assert.equal((await events(w, 'task:integ', 'accepted')).length, 0);
  assert.ok(w.ledger.notices.some((n) => n.category === 'accept-risk-moot'));
  assert.ok((await events(w, 'secretary', 'applied')).some((e) => e.key === esc.id));
  assert.equal(await w.ledger.judgment(`j.user.${esc.id}`), null);
  await unchanged(w, engine);
});

test('#48 a 4.1.3 ledger waiting on a carry conflict starts fresh on the next pass', async () => {
  const { w, engine } = await usedUp();
  const previous = (await events(w, 'task:impl', 'product')).at(-1)!.body;
  // The old release had recorded the next attempt and its conflict notice, but no dispatch.
  await w.ledger.append('test:legacy-carry-wait', { events: [{ mission: M, line: 'task:impl', event: 'rework', key: '4', body: { k: 4, reason: 'reviewer', issues: ['carry work'], instructions: [] } }] });
  await w.ledger.notify({ mission: M, category: 'rework-start-conflict', wi: null, key: 'legacy-carry', trigger: 'old carried conflict', defaultAction: 'wait for re-plan', detail: {} });
  const fresh = 'c'.repeat(40);
  const calls: boolean[] = [];
  w.scheduler.actions.snapshot = async (req) => {
    calls.push(req.carry !== undefined);
    if (req.carry !== undefined) throw Object.assign(new Error('conflict at src/parser/index.ts'), { code: 'conflict', detail: { carried: true, conflicts: ['src/parser/index.ts'] } });
    return { path: fresh, commit: fresh, products: await w.scheduler.composition(req.products ?? []) };
  };
  await engine.reconcile();
  const dispatched = (await events(w, 'task:impl', 'dispatched')).at(-1)!.body;
  assert.deepEqual(calls, [true, false]);
  assert.equal(dispatched.k, 4);
  assert.equal(dispatched.commit, fresh);
  assert.equal(dispatched.origin, fresh);
  const card = w.scheduler.card<{ duties: string }>('con.m1.impl.4');
  assert.ok(card.duties.includes(previous.commit));
  assert.match(card.duties, /carry over by hand/i);
  const notice = w.ledger.notices.find((n) => n.category === 'rework-carry-dropped')!;
  assert.equal((notice.detail as any).previous, previous.object);
  assert.equal((notice.detail as any).commit, previous.commit);
  assert.deepEqual((notice.detail as any).conflicts, ['src/parser/index.ts']);
  await unchanged(w, engine);
});

test('#49 LF and CRLF are clean, real edits differ, in both landing checks under autocrlf=true', async () => {
  const f = fixture({ files: { 'eol.txt': 'one\ntwo\n' } });
  try {
    f.git('config', 'core.autocrlf', 'true');
    const head = f.git('rev-parse', 'HEAD') as any;
    for (const content of ['one\ntwo\n', 'one\r\ntwo\r\n', 'changed\n']) {
      write(f.dir, 'eol.txt', content);
      const clean = !content.startsWith('changed');
      assert.equal((await compareToCommit(f.ctx, f.dir, head)).state, clean ? 'match' : 'differs');
      assert.equal((await compareWorktree(f.ctx, f.dir, 'main', head, head)).relation, clean ? 'consistent' : 'cannot-determine');
    }
    write(f.dir, 'eol.txt', 'one\ntwo\n');
    assert.equal((await compareToCommit(f.ctx, f.dir, head)).state, 'match');
  } finally { f.cleanup(); }
});

test('#49 landing helper fast-forwards an autocrlf=true checkout with LF worktree bytes', async () => {
  const f = fixture({ files: { 'eol.txt': 'one\ntwo\n' } });
  try {
    f.git('config', 'core.autocrlf', 'true');
    const base = f.git('rev-parse', 'HEAD');
    const candidate = commitOn(f.dir, base, { 'new.txt': 'landed\n' });
    recordedDelivery(f, 'd414', candidate, base, 'main');
    const result = await land(f.ctx, { mission: GM, delivery: 'd414', words: words(f.m) });
    assert.equal(result.kind, 'landed', JSON.stringify(result));
    if (result.kind === 'landed') assert.equal(result.worktree?.relation, 'consistent');
  } finally { f.cleanup(); }
});
