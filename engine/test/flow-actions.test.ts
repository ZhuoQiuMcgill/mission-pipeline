// The flows' program actions on a real repository and real execution units (design 7.1, 4.1,
// 4.2, 6.5, 7.2): one task from the Constructor's export to its product commit, the program's
// verification runs as a supervised unit through the scheduler and the run host, the evidence,
// and the Reviewer card. Seats are scripted (no model); the git repository, the ledger service,
// the scheduler, the unit supervisor, the run host and its sandbox are real.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ContentHash, GitOid, MissionId } from '../src/common/ids.ts';
import type { EvidenceRecord, ObjectVersionRecord } from '../src/common/records.ts';
import type { TreeDocument } from '../src/exec/export.ts';
import { programActions, schedulerVerifyUnits, type ActionContext } from '../src/flow/actions/index.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, type Script } from '../src/flow/scripted.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import type { ContentStore } from '../src/ledger/content.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, type Fixture } from './git-fixtures.test.ts';
import { cleanupEnvs, inProcessLedger, makeEnv, newScheduler, unitSkip } from './scheduler-fixtures.ts';

const M = 'm1' as MissionId;
let fx: Fixture;
before(() => {
  fx = makeFixture('flow-actions');
});
after(async () => {
  await cleanupEnvs();
  fx.cleanup();
});

const IMPL = 'export function parse(text: string): string[][] {\n  return text.split("\\n").map((l) => l.split(","));\n}\n';

/** The export the seat host would have stored for the Constructor's writable paths (src/seat/tree.ts). */
function storeExport(content: ContentStore, files: Record<string, string>): ContentHash {
  const entries: TreeDocument['entries'][number][] = [{ path: 'src/parser/impl', kind: 'dir', mode: 0o755, size: 0, hash: null, target: null }];
  for (const [path, text] of Object.entries(files)) entries.push({ path, kind: 'file', mode: 0o644, size: Buffer.byteLength(text), hash: content.put(text), target: null });
  return content.put(JSON.stringify({ format: 'mp4.tree.v1', entries } satisfies TreeDocument));
}

function singleTaskPlan(commands: DetailedPlanDoc['tasks'][number]['verificationCommands']): DetailedPlanDoc {
  const full = detailedPlan(M);
  return {
    ...full,
    reusedInterfaces: [{ name: 'Parser', file: 'src/parser/api.ts', location: 'line 1', provenance: { planElement: 'e1' } }],
    newInterfaces: [],
    tasks: [{ ...(full.tasks[1] as DetailedPlanDoc['tasks'][number]), implements: ['Parser'], dependsOn: [], verificationCommands: commands, provenance: { planElement: 'e1' } }],
  };
}

async function world(name: string) {
  const repo = initRepo(fx, name);
  const M0 = rawCommit(fx, repo, { 'src/parser/api.ts': 'export interface Parser { parse(text: string): string[][] }\n', 'README.md': 'parser\n', 'CLAUDE.md': 'instructions for agents\n' }, null, 'M0');
  checkoutMain(fx, repo, M0);
  const layout: RepoLayout = await discoverRepo(fx.git, repo);
  const description = await readTransformDescription(fx.git, layout, fx.user);
  const e = makeEnv(`flow-actions-${name}`);
  const l = inProcessLedger(e);
  const s = newScheduler(e);
  await s.start();
  const ports = fakePorts();
  const ctx: ActionContext = {
    git: fx.git,
    repo: layout,
    description,
    workDir: join(e.root, 'flow-work'),
    exports: s.content,
    ledger: ports.ledger,
    base: async () => M0,
    disk: { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false },
    ident: { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000100 +0000' },
  };
  const actions = programActions(ctx, { units: schedulerVerifyUnits(s), ledgerSocket: e.socket, runLimits: { memoryMax: 256 * 1024 * 1024, pidsMax: 64 }, areaBytes: 64 * 1024 * 1024, hostBytes: 192 * 1024 * 1024 });
  ports.scheduler.actions = { snapshot: actions.snapshot, product: actions.product, verify: actions.verify };
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!] }), userWords: ['msg1'], mode: 'stable' });
  const close = async (): Promise<void> => {
    await s.close();
    await l.close();
  };
  return { repo, M0, layout, e, l, s, ports, engine: new FlowEngine(ports), close };
}

/** Drive the flow until `done` holds, letting the real verification unit run in between. */
async function driveUntil(engine: FlowEngine, ports: ReturnType<typeof fakePorts>, script: Script, done: () => Promise<boolean>, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await drive(engine, ports.scheduler, script);
    if (await done()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the flow');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('flow actions on a real repository and real units', { skip: unitSkip, timeout: 240_000 }, () => {
  test('Constructor export → product commit → verification unit → evidence → Reviewer card → accepted and proven', async () => {
    const w = await world('happy');
    try {
      const exportHash = storeExport(w.s.content, { 'src/parser/impl/index.ts': IMPL });
      const plan = singleTaskPlan([
        { id: 'grep', command: 'grep -q "export function parse" src/parser/impl/index.ts' },
        { id: 'cat', command: 'cat src/parser/impl/index.ts | wc -l' },
      ]);
      const base = happyScript(M, () => plan);
      let reviewerCard: ReviewerCard | null = null;
      const script: Script = (t, sch) => {
        if (t.card.seat === 'constructor') return { handBack: constructorDone(), exportHash };
        if (t.card.seat === 'reviewer') {
          reviewerCard = t.card as unknown as ReviewerCard;
          return { handBack: reviewer(reviewerCard, 'pass') };
        }
        return base(t, sch);
      };
      await driveUntil(w.engine, w.ports, script, async () => (await w.ports.ledger.events({ mission: M, event: 'accepted' })).length === 1);

      // the Constructor's snapshot: the base without instruction files or .git, its new writable directory prepared
      const con = w.ports.scheduler.card<ConstructorCard>('con.m1.impl.1');
      assert.ok(existsSync(join(con.workspace.snapshot, 'src/parser/api.ts')));
      assert.equal(existsSync(join(con.workspace.snapshot, 'CLAUDE.md')), false, '7.1: no project instruction file in a snapshot');
      assert.equal(existsSync(join(con.workspace.snapshot, '.git')), false);
      assert.deepEqual(con.workspace.writablePaths, ['src/parser/impl']);
      assert.ok(existsSync(join(con.workspace.snapshot, 'src/parser/impl')), 'the sandbox can bind the new module directory');

      // the product: a real commit on the base, its write scope = the export; the version recorded with its placement
      const prod = (await w.ports.ledger.records(['object.version'])).map((c) => c.record as ObjectVersionRecord).find((r) => r.objectKind === 'product');
      assert.ok(prod?.source !== undefined);
      assert.equal(fx.raw(['rev-parse', `${prod.source.commit}^`], w.repo), w.M0, 'the product commit sits on the snapshot the seat saw');
      assert.equal(fx.raw(['show', `${prod.source.commit}:src/parser/impl/index.ts`], w.repo), IMPL.trimEnd());
      assert.deepEqual(prod.scope.paths, ['src/parser/impl/index.ts']);
      assert.deepEqual(prod.reviews.map((r) => r.review), ['reviewer']);
      assert.equal(fx.raw(['rev-parse', 'main'], w.repo), w.M0, 'the user\'s branch is never moved');
      assert.equal(fx.raw(['show', `${prod.source.commit}:CLAUDE.md`], w.repo), 'instructions for agents', 'files the seat never saw are kept, not deleted');
      assert.equal(fx.raw(['diff', '--name-only', w.M0, prod.source.commit], w.repo), 'src/parser/impl/index.ts', 'the commit changes exactly the product');

      // the verification unit ran through the scheduler: an accepted launch with its run layers
      const vt = w.s.tasks.get(`verify.${prod.object}`);
      assert.ok(vt !== undefined && vt.state === 'done');
      const launch = vt.launches.at(-1)!;
      assert.equal(w.l.svc.dispositionFor(launch), 'accepted');
      assert.ok(w.l.svc.proofFor(launch), 'the supervisor proved the unit\'s end');
      // the evidence: one record per command, on the environment's current snapshot
      const evidence = (await w.ports.ledger.records(['evidence'])).map((c) => c.record as EvidenceRecord);
      assert.deepEqual(evidence.map((x) => [x.evidence, x.fields['exit'], x.fields['status'], x.runClass]), [
        [`ev.${prod.object}.grep`, '0', 'completed', 'open'],
        [`ev.${prod.object}.cat`, '0', 'completed', 'open'],
      ]);
      assert.equal((await w.ports.ledger.records(['env.snapshot'])).length, 1);

      // the Reviewer judged the canonical candidate with the program's runs
      const rc = reviewerCard as ReviewerCard | null;
      assert.ok(rc !== null);
      assert.equal(rc.target, prod.object);
      assert.deepEqual(rc.candidate.changedPaths, ['src/parser/impl/index.ts']);
      assert.deepEqual(rc.verificationRuns.map((r) => r.evidence), [`ev.${prod.object}.grep`, `ev.${prod.object}.cat`]);
      assert.match(rc.verificationRuns[1]?.summary ?? '', /exit 0.*output: 3/);
      assert.equal(readFileSync(join(rc.workspace.snapshot, 'src/parser/impl/index.ts'), 'utf8'), IMPL);
      assert.equal(existsSync(join(rc.workspace.snapshot, 'CLAUDE.md')), false);
      assert.ok(!readdirSync(rc.workspace.snapshot).includes('.git'));

      // stable mode: the whole chain is proven on the real evidence
      assert.equal((await w.ports.evaluator.labels([prod.object])).labels[prod.object], 'proven');
    } finally {
      await w.close();
    }
  });

  test("a dependent task's snapshot holds its dependency's accepted product (5.3), laid over the base", async () => {
    const w = await world('deps');
    try {
      const API2 = 'export interface Parser { parse(text: string): string[][]; strict: boolean }\n';
      const ifaceExport = w.s.content.put(
        JSON.stringify({ format: 'mp4.tree.v1', entries: [{ path: 'src/parser/api.ts', kind: 'file', mode: 0o644, size: Buffer.byteLength(API2), hash: w.s.content.put(API2), target: null }] } satisfies TreeDocument),
      );
      const implExport = storeExport(w.s.content, { 'src/parser/impl/index.ts': IMPL });
      const plan: DetailedPlanDoc = { ...detailedPlan(M), tasks: detailedPlan(M).tasks.map((t) => ({ ...t, verificationCommands: [{ id: 'ok', command: 'true' }], provenance: { planElement: 'e1' } })) };
      const base = happyScript(M, () => plan);
      const script: Script = (t, sch) => {
        if (t.task === 'con.m1.iface.1') return { handBack: constructorDone(), exportHash: ifaceExport };
        if (t.task === 'con.m1.impl.1') return { handBack: constructorDone(), exportHash: implExport };
        return base(t, sch);
      };
      await driveUntil(w.engine, w.ports, script, async () => (await w.ports.ledger.events({ mission: M, event: 'accepted' })).length === 2);
      const iface = w.ports.scheduler.card<ConstructorCard>('con.m1.iface.1');
      assert.deepEqual(iface.workspace.writablePaths, ['src/parser/api.ts'], 'an existing file is its own writable path');
      const impl = w.ports.scheduler.card<ConstructorCard>('con.m1.impl.1');
      assert.equal(readFileSync(join(impl.workspace.snapshot, 'src/parser/api.ts'), 'utf8'), API2, "impl sees iface's accepted interface, not the base's");
      const prods = (await w.ports.ledger.records(['object.version'])).map((c) => c.record as ObjectVersionRecord).filter((r) => r.objectKind === 'product');
      const implProd = prods.find((p) => p.object.includes('impl'));
      assert.deepEqual(w.ports.ledger.content.getList(implProd!.prerequisites), [prods.find((p) => p.object.includes('iface'))!.object], 'the dependency is its prerequisite (5.3)');
      assert.equal((await w.ports.evaluator.labels([implProd!.object])).labels[implProd!.object], 'proven');
    } finally {
      await w.close();
    }
  });

  test('a failing verification command is evidence too; an export the program cannot commit goes back to the Constructor', async () => {
    const w = await world('rework');
    try {
      const bad = storeExport(w.s.content, { 'src/parser/impl/index.ts': IMPL, 'src/parser/impl/../../../escape.ts': 'x\n' });
      const good = storeExport(w.s.content, { 'src/parser/impl/index.ts': '// not yet\n' });
      const plan = singleTaskPlan([{ id: 'grep', command: 'grep -q "export function parse" src/parser/impl/index.ts' }]);
      const base = happyScript(M, () => plan);
      const script: Script = (t, sch) => {
        if (t.task === 'con.m1.impl.1') return { handBack: constructorDone(), exportHash: bad };
        if (t.card.seat === 'constructor') return { handBack: constructorDone(), exportHash: good };
        if (t.card.seat === 'reviewer') return null; // left queued: the evidence is what this test checks
        return base(t, sch);
      };
      await driveUntil(w.engine, w.ports, script, async () => w.ports.scheduler.queued('reviewer').length === 1);
      // the unrepresentable export became a rework with the program's reason
      const con2 = w.ports.scheduler.card<ConstructorCard>('con.m1.impl.2');
      assert.match(con2.duties, /could not make a commit of your result: .*unsafe path/);
      // the failing command is recorded as evidence and reaches the Reviewer as not passed
      const rc = w.ports.scheduler.card<ReviewerCard>(w.ports.scheduler.queued('reviewer')[0]!.task);
      assert.match(rc.verificationRuns[0]?.summary ?? '', /completed; exit 1/);
      const ev = (await w.ports.ledger.records(['evidence'])).map((c) => c.record as EvidenceRecord);
      assert.deepEqual(ev.map((x) => x.fields['exit']), ['1']);
      const prod = (await w.ports.ledger.records(['object.version'])).map((c) => c.record as ObjectVersionRecord).filter((r) => r.objectKind === 'product');
      assert.equal(prod.length, 1, 'no product version for the refused export');
      assert.equal(fx.raw(['show', `${prod[0]!.source!.commit as GitOid}:src/parser/impl/index.ts`], w.repo), '// not yet');
    } finally {
      await w.close();
    }
  });
});
