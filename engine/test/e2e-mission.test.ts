// One complete mission end to end through the REAL processes with a FAKE model (2026-10-09,
// before the first live run): `mp install` writes the configuration; the PM session's
// SessionStart hook starts the watchdog, which starts the ledger service, the scheduler (with its
// flows and its evaluator worker) and the inbox probes; every seat runs in a real execution unit
// (transient systemd service + unit supervisor + seat host + Claude Code in its enclosure) against
// a scripted model behind the real metering proxy (test/e2e/seats.ts). The PM side goes through
// the PM session's UserPromptSubmit hook (the user's words, stops) and the `mp` commands.
//
//   1. the whole mission: the user's words → requirement items → PM plan → Calibrator ① →
//      Architect (detailed plan, one task) → mechanical checks → Calibrator ② → Constructor
//      (writes the change through its tools) → product commit → verification runs (evidence) →
//      Reviewer (pass, citing the evidence) → proven → `mp deliver` → landed on main in the
//      main checkout → `mp close`; the ledger has the records, the notices carry WI numbers, a
//      happy mission raises no exception notice, nothing is left behind.
//   2. the user says "停" while the Constructor runs: the running seat is ended, nothing is
//      dispatched or accepted after it, the stop report says stopped after cleanup; released,
//      the cancelled work does not resume and the Secretary's decision (abandon) is carried out.
//   3. a rework and a Secretary decision (the Constructor's question; the Reviewer's rework).
//   4. the scheduler is killed while the Constructor runs: the watchdog restarts it and the new
//      generation adopts the unit.
//   5. a false-positive stop ("不要…" in an ordinary instruction, risk 9) released by the PM.
//   6. an exhausted environment-retry loop: the Secretary runs and grants once.
//
// No workaround: the configuration is `mp install`'s output, with only the fake model's URL and
// the fixture self-check acceptance added (TEST-PATCH in test/e2e/stack.ts). No fuse2fs is used
// (this machine has none), and the verification runs need the user's node (W3).
//
//   MP_E2E=1 node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/e2e-mission.test.ts
//   (opt-in: without MP_E2E=1 the suite is skipped, so `npm test` does not run it)
//   MP_E2E_KEEP=1 keeps the temp directories of each scenario (the engine is stopped first).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import type { DetailedPlanDoc, PmPlanDoc } from '../src/flow/plandoc.ts';
import { E2E_SKIP, HAS_FUSE2FS, Stack, waitFor } from './e2e/stack.ts';
import { seatLogText, type SeatPlan } from './e2e/seats.ts';
import { constructorDone, reviewer, secretary } from '../src/flow/scripted.ts';

const MISSION = 'e2e-m1';
const TASK = 'exclaim';
const PROMPT =
  "Make greet() end with an exclamation mark, so greet('Ada') returns 'Hello, Ada!'. The unit tests must pass. The details are yours to decide. Deliver it when it is done.";

const FILES = {
  'README.md': '# greeter\n',
  'src/greeter/greet.py': 'def greet(name):\n    return "Hello, " + name\n',
  'src/greeter/test_greet.py':
    'import unittest\n\nfrom greet import greet\n\n\nclass GreetTest(unittest.TestCase):\n    def test_exclaims(self):\n        self.assertEqual(greet("Ada"), "Hello, Ada!")\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
};
const FIXED = 'def greet(name):\n    return "Hello, " + name + "!"\n';

function pmPlan(mission: string): PmPlanDoc {
  return {
    format: 'mp4.pm-plan.v1',
    mission,
    round: 1,
    order: 'free',
    elements: [
      {
        id: 'e1',
        kind: 'deliverable',
        text: "greet() ends with an exclamation mark (greet('Ada') returns 'Hello, Ada!'), and the unit tests pass",
        provenance: { by: 'user', message: 'cc-p1', quote: 'Make greet() end with an exclamation mark' },
        after: [],
        items: ['g1', 's1'],
      },
    ],
    goalsBeyond: [],
    authorizations: ['a1'],
  };
}

function detailedPlan(mission: string): DetailedPlanDoc {
  return {
    reusedInterfaces: [{ name: 'greet', file: 'src/greeter/greet.py', location: 'line 1', provenance: { planElement: 'e1' } }],
    newInterfaces: [],
    modules: [{ id: 'greeter', writeScope: ['src/greeter/**'], provenance: { planElement: 'e1' } }],
    tasks: [
      {
        id: TASK,
        kind: 'implementation',
        module: 'greeter',
        goal: 'greet() ends with an exclamation mark',
        standards: [
          { id: 'S1', text: 'greet("Ada") returns "Hello, Ada!"' },
          { id: 'S2', text: 'the unit tests pass' },
        ],
        requirementItems: [`item.${mission}.g1`, `item.${mission}.s1`],
        writeScope: ['src/greeter/**'],
        readableFiles: ['src/greeter/greet.py', 'src/greeter/test_greet.py'],
        interpreter: 'python3',
        // node from the user's toolchain (outside /usr) and python3 for the project's tests
        verificationCommands: [{ id: 'unit', command: "node -e 'process.exit(0)' && node --version && python3 -B -m unittest -v test_greet", cwd: 'src/greeter' }],
        implements: ['greet'],
        calls: [],
        dependsOn: [],
        exclusive: [],
        estimate: { durationMs: 60_000, costMicros: 200_000, basis: 'a one-line change' },
        provenance: { planElement: 'e1' },
      },
    ],
    risks: [],
  };
}

const SEATS: SeatPlan = { detailedPlan, constructorFiles: { 'src/greeter/greet.py': FIXED } };

// ---------------------------------------------------------------- reading the engine

interface FlowEventRow {
  revision: number;
  line: string;
  event: string;
  key: string;
  body: string;
}

async function events(s: Stack, line?: string, event?: string): Promise<Array<FlowEventRow & { doc: Record<string, unknown> }>> {
  const l = s.ledger();
  const rows = (await l.call('flowEvents', { mission: MISSION, ...(line !== undefined ? { line } : {}), ...(event !== undefined ? { event } : {}), after: 0, limit: 10_000 } as never)) as FlowEventRow[];
  const { ContentStore } = await import('../src/ledger/content.ts');
  const { contentHash } = await import('../src/common/ids.ts');
  const c = new ContentStore(join(s.cli.ledgerRoot, 'content'));
  return rows.map((r) => ({ ...r, doc: JSON.parse(c.get(contentHash(r.body)).toString('utf8')) as Record<string, unknown> }));
}

async function event(s: Stack, line: string, ev: string): Promise<Record<string, unknown> | null> {
  return (await events(s, line, ev)).at(-1)?.doc ?? null;
}

async function records(s: Stack, kinds: string[]): Promise<Array<{ revision: number; record: Record<string, unknown> }>> {
  return (await s.ledger().call('recordsByKind', { kinds, after: 0, limit: 10_000 } as never)) as Array<{ revision: number; record: Record<string, unknown> }>;
}

async function diag(s: Stack): Promise<string> {
  const parts: string[] = [];
  try {
    const st = (await s.scheduler().call('status', {})) as { waiting: unknown; tasks: Array<{ task: string; state: string; note: string | null }>; paused: boolean; storageFault: boolean };
    parts.push(`scheduler: paused=${st.paused} storageFault=${st.storageFault} waiting=${JSON.stringify(st.waiting)}`);
    for (const t of st.tasks) parts.push(`  task ${t.task}: ${t.state}${t.note ? ` (${t.note})` : ''}`);
  } catch (e) {
    parts.push(`scheduler status: ${(e as Error).message}`);
  }
  try {
    const ev = await events(s);
    parts.push(`flow events: ${ev.map((e) => `${e.line}/${e.event}/${e.key}`).join(', ')}`);
  } catch (e) {
    parts.push(`flow events: ${(e as Error).message}`);
  }
  try {
    for (const a of new ControlPlane(s.cli.controlPlane).alerts()) parts.push(`alert ${a.category} ${a.wi ?? 'NO-WI'}: ${trig(a.trigger).slice(0, 400)}`);
  } catch (e) {
    parts.push(`alerts: ${(e as Error).message}`);
  }
  parts.push(`fake model log:\n${seatLogText(s.seats)}`);
  parts.push(s.logs(2500));
  return parts.join('\n');
}

const MIN = 60_000;

const trig = (t: unknown): string => (typeof t === 'string' ? t : JSON.stringify(t ?? null));

/** The PM side of the mission up to the PM plan: the user's words (hook), the mission, the items, the plan (mp). */
async function pmSide(s: Stack, o: { readonly prompt?: string; readonly openFirst?: boolean; readonly afterWords?: (facts: string) => Promise<void> } = {}): Promise<void> {
  if (o.openFirst === true) {
    const first = await s.mp('mission', 'open', MISSION);
    assert.equal(first.code, 0, `mp mission open: ${first.raw.stdout}${first.raw.stderr}`);
  }
  const hook = await s.userPrompt(o.prompt ?? PROMPT, 'p1');
  assert.match(hook.facts, /"booked":true/, `the user's words are booked by the hook\n${hook.raw.stdout}\n${hook.raw.stderr}`);
  await o.afterWords?.(hook.facts);
  const open = await s.mp('mission', 'open', MISSION);
  assert.equal(open.code, 0, `mp mission open: ${open.raw.stdout}${open.raw.stderr}`);
  for (const [item, type, text, quote] of [
    ['g1', 'goal', "greet() ends with an exclamation mark: greet('Ada') returns 'Hello, Ada!'", 'Make greet() end with an exclamation mark'],
    ['s1', 'acceptance', 'The unit tests pass', 'The unit tests must pass'],
    ['a1', 'authorization', 'The details are the PM\'s to decide', 'The details are yours to decide'],
  ] as const) {
    const r = await s.mp('requirement', 'add', MISSION, item, '--type', type, '--text', text, '--quote', quote, '--message', 'cc-p1');
    assert.equal(r.code, 0, `mp requirement add ${item}: ${r.raw.stdout}${r.raw.stderr}`);
  }
  const planFile = join(s.root, 'pm-plan.json');
  writeFileSync(planFile, JSON.stringify(pmPlan(MISSION)));
  const p = await s.mp('plan', 'submit', MISSION, '--file', planFile, '--words', 'cc-p1');
  assert.equal(p.code, 0, `mp plan submit: ${p.raw.stdout}${p.raw.stderr}`);
}

describe('end-to-end mission through the real processes (fake model)', { skip: E2E_SKIP, timeout: 20 * MIN }, () => {
  test('one mission: the user\'s words to the delivery landed on main', { timeout: 15 * MIN }, async () => {
    const t0 = Date.now();
    const s = new Stack({ name: 'mission', files: FILES, seats: SEATS });
    const timings: string[] = [];
    const mark = (what: string): void => void timings.push(`${((Date.now() - t0) / 1000).toFixed(1)} s ${what}`);
    let closed = false;
    try {
      const m0 = s.makeProject();
      await s.start();
      mark(`engine up${HAS_FUSE2FS ? '' : ' (no fuse2fs on this machine)'}`);
      const seatsCfg = s.installedScheduler['seats'] as Record<string, unknown>;
      if (!HAS_FUSE2FS) assert.equal(seatsCfg['fuse2fs'], undefined, 'install names no fuse2fs on a machine without one');
      assert.match(s.sessionStart, /engine was just started|引擎刚刚启动/, `the SessionStart hook says it started the engine: ${s.sessionStart.slice(0, 600)}`);
      await pmSide(s);
      mark('PM plan submitted');
      const d = (): Promise<string> => diag(s);

      await waitFor('the PM plan to take effect (Calibrator ① pass)', 4 * MIN, () => event(s, 'plan', 'pm-plan-effective'), d);
      mark('PM plan effective');
      const arch = await waitFor('the detailed plan (Architect)', 4 * MIN, () => event(s, 'plan', 'arch'), d);
      mark('detailed plan');
      const mech = await waitFor('the mechanical check', MIN, () => event(s, 'plan', 'mechanical-check'), d);
      assert.equal(mech['ok'], true, `mechanical check: ${JSON.stringify(mech)}`);
      const eff = await waitFor('the detailed plan to take effect (Calibrator ② pass)', 4 * MIN, () => event(s, 'plan', 'effective'), d);
      assert.equal(eff['dplan'], arch['object']);
      mark('detailed plan effective');
      const dispatched = await waitFor('the task to be dispatched (Constructor)', 4 * MIN, () => event(s, `task:${TASK}`, 'dispatched'), d);
      assert.equal(dispatched['commit'], m0, 'the Constructor works on the mission base');
      mark('Constructor dispatched');
      const product = await waitFor('the product commit', 5 * MIN, () => event(s, `task:${TASK}`, 'product'), d);
      mark('product');
      const commit = String(product['commit']);
      assert.equal(s.gitIn('cat-file', '-t', commit).trim(), 'commit');
      assert.equal(s.gitIn('show', `${commit}:src/greeter/greet.py`), FIXED, 'the product commit has the Constructor\'s change');
      assert.deepEqual(product['changedPaths'], ['src/greeter/greet.py']);
      const verified = await waitFor('the verification runs', 4 * MIN, () => event(s, `task:${TASK}`, 'verified'), d);
      const runs = verified['runs'] as Array<{ evidence: string; passed: boolean; summary: string }>;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.passed, true, `node runs and the unit tests pass on the candidate: ${runs[0]!.summary}`);
      assert.match(runs[0]!.summary, new RegExp(`output: ${process.version.replace(/\./g, '\\.')}`), `node --version printed inside the verification sandbox: ${runs[0]!.summary}`);
      mark('verified');
      const review = await waitFor('the Reviewer judgment', 4 * MIN, () => event(s, `task:${TASK}`, 'review'), d);
      assert.equal(review['verdict'], 'pass');
      await waitFor('the task accepted', MIN, () => event(s, `task:${TASK}`, 'accepted'), d);
      mark('accepted');
      const object = String(product['object']);
      await waitFor(
        'the product labelled proven',
        3 * MIN,
        async () => {
          const r = (await s.evaluator().call('targets', { ids: [object] })) as { states: Record<string, { label: string } | null> };
          return r.states[object]?.label === 'proven';
        },
        async () => `label: ${JSON.stringify(await s.evaluator().call('targets', { ids: [object] }).catch((e: Error) => e.message))}\n${await d()}`,
      );
      mark('proven');

      // the user: "交付" → the PM delivers (consent to land, method A)
      const hook2 = await s.userPrompt('交付吧。', 'p2');
      assert.doesNotMatch(hook2.facts, /"detected":true/, 'a delivery word is not a stop');
      const del = await s.mp('deliver', MISSION, '--outputs', object, '--project', s.repo);
      mark('delivered');
      assert.equal(del.code, 0, `mp deliver: ${del.raw.stdout}${del.raw.stderr}\n${await d()}`);
      const res = del.json?.['result'] as Record<string, unknown>;
      const landing = res['landing'] as { landed: boolean };
      assert.equal(landing.landed, true, JSON.stringify(res));

      // main in the main checkout contains the delivery commit; the worktree is updated and clean
      const deliveries = await records(s, ['delivery.recorded']);
      assert.equal(deliveries.length, 1, JSON.stringify(deliveries));
      const deliveryCommit = String(deliveries[0]!.record['commit']);
      assert.equal(s.gitIn('merge-base', '--is-ancestor', deliveryCommit, 'main') === '', true);
      assert.equal(s.gitIn('rev-parse', 'HEAD').trim(), s.gitIn('rev-parse', 'main').trim());
      assert.equal(s.gitIn('symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
      assert.equal(readFileSync(join(s.repo, 'src/greeter/greet.py'), 'utf8'), FIXED, 'the main checkout\'s worktree has the change');
      assert.equal(s.gitIn('status', '--porcelain').trim(), '', 'the main checkout is clean');

      // the user: the mission is done; the PM closes it (full close-out, 6.6)
      const close = await s.mp('close', MISSION, '--mode', 'full');
      assert.equal(close.code, 0, `mp close: ${close.raw.stdout}${close.raw.stderr}`);
      const missions = await s.mp('mission', 'list', '--state', 'closed');
      assert.match(JSON.stringify(missions.json), new RegExp(MISSION), `the mission is closed: ${JSON.stringify(missions.json)}`);

      // the PM's layer 0 reads without error after the delivery
      const status = await s.mp('status');
      assert.equal(status.code, 0, `mp status: ${status.raw.stdout}${status.raw.stderr}`);
      const alertsCmd = await s.mp('alerts');
      assert.equal(alertsCmd.code, 0, `mp alerts: ${alertsCmd.raw.stdout}${alertsCmd.raw.stderr}`);

      // the ledger's records
      const objs = (await records(s, ['object.version'])).map((r) => String(r.record['object']));
      for (const o of [`pmplan.${MISSION}.1`, String(arch['object']), object]) assert.ok(objs.includes(o), `object version ${o} in ${objs.join(', ')}`);
      const judgments = (await records(s, ['judgment'])).map((r) => String(r.record['judgment']));
      assert.ok(judgments.some((j) => j.startsWith('j.cal1.')), `Calibrator ① judgment in ${judgments.join(', ')}`);
      assert.ok(judgments.some((j) => j.startsWith('j.cal2.')), `Calibrator ② judgment in ${judgments.join(', ')}`);
      assert.ok(judgments.includes(String(review['judgment'])), `Reviewer judgment in ${judgments.join(', ')}`);
      const evidence = (await records(s, ['evidence'])).map((r) => String(r.record['evidence']));
      assert.ok(evidence.includes(runs[0]!.evidence), `evidence ${runs[0]!.evidence} in ${evidence.join(', ')}`);
      const words = (await records(s, ['user.words'])).map((r) => String(r.record['message']));
      assert.ok(words.includes('cc-p1') && words.includes('cc-p2'), `user words booked: ${words.join(', ')}`);

      // every exception notice carries its WI
      const alerts = new ControlPlane(s.cli.controlPlane).alerts();
      const noWi = alerts.filter((a) => a.wi === null || a.wi === '');
      const seatCount = [...s.seats.launches.values()].reduce((n, l) => n + l.length, 0);
      mark(`${seatCount} seat launches, ${alerts.length} notices`);
      assert.deepEqual(
        noWi.map((a) => `${a.category}: ${trig(a.trigger)}`),
        [],
        'every notice names its WI',
      );
      assert.deepEqual(
        [...s.seats.launches.entries()].map(([k, v]) => `${k}:${v.length}`).sort(),
        ['architect-decompose:1', 'calibrator-1:1', 'calibrator-2:1', 'constructor:1', 'reviewer:1'],
        'one launch per seat, no retries',
      );
      // a happy mission raises no exception notice (checked last, after the cleanup checks)
      const exceptions = [...new Set(alerts.map((a) => `${a.category} ${a.wi}: ${trig(a.trigger).slice(0, 160)}`))];

      closed = true;
      const left = await s.close();
      mark('closed');
      assert.deepEqual(left, { processes: [], units: [], mounts: [] }, 'nothing is left behind after the engine stops');
      assert.deepEqual(exceptions, [], 'no exception notice on a happy mission');
    } finally {
      process.stderr.write(`[e2e mission] ${timings.join(' | ')}\n${s.notes.join('\n')}\n`);
      if (!closed) await s.close();
    }
  });

  test('the user says "停" while the Constructor runs: the seat ends, nothing more is dispatched or accepted, the report says stopped', { timeout: 15 * MIN }, async () => {
    const t0 = Date.now();
    const s = new Stack({ name: 'stop', files: FILES, seats: { ...SEATS, behavior: { constructor: 'stall-after-work' as const } } });
    let closed = false;
    try {
      s.makeProject();
      await s.start();
      await pmSide(s);
      const d = (): Promise<string> => diag(s);
      await waitFor('the Constructor working (its seat stalled after writing the change)', 10 * MIN, () => s.seats.stalled.size > 0, d);
      const constructorLaunch = [...s.seats.stalled][0]!;
      const before = (await s.scheduler().call('tasks', {})) as Array<{ task: string; state: string; launches: string[] }>;
      const con = before.find((t) => t.launches.includes(constructorLaunch));
      assert.ok(con !== undefined && con.state === 'running', JSON.stringify(before));

      // the user: "停" (UserPromptSubmit hook → stopEntry)
      const hook = await s.userPrompt('停', 'p-stop');
      assert.match(hook.facts, /"detected":true/, `the stop is detected: ${hook.facts}`);
      const stop = /"stop":\{"stop":"([^"]+)"/.exec(hook.facts)?.[1];
      assert.ok(stop !== undefined, hook.facts);
      const tStop = Date.now();

      const report = await waitFor(
        'the stop report: stopped (after cleanup)',
        3 * MIN,
        async () => {
          const r = (await s.scheduler().call('stopReport', { stop })) as { state: string } | null;
          return r !== null && r.state === 'stopped' ? r : null;
        },
        async () => `report: ${JSON.stringify(await s.scheduler().call('stopReport', { stop }).catch((e: Error) => e.message))}\n${await d()}`,
      );
      const stopMs = Date.now() - tStop;
      const units = (report as unknown as { units: Array<{ launch: string; processesEnded: boolean; cleanup: string }> }).units;
      const u = units.find((x) => x.launch === constructorLaunch);
      assert.ok(u !== undefined, `the Constructor's unit is in the report: ${JSON.stringify(report)}`);
      assert.equal(u.processesEnded, true);
      assert.equal(u.cleanup, 'done');

      // nothing further is dispatched or accepted: wait a few scheduler ticks
      await new Promise((r) => setTimeout(r, 8_000));
      // a unit ended by the user's stop is stopped, not a failed attempt: no WI-15 notice for it
      const stopNotices = new ControlPlane(s.cli.controlPlane)
        .alerts()
        .filter((a) => a.category === 'attempt-quarantined' || (a.wi === 'WI-15' && JSON.stringify([a.key, a.trigger, a.detail]).includes(constructorLaunch)))
        .map((a) => `${a.category} ${a.wi}: ${trig(a.trigger).slice(0, 200)}`);
      assert.deepEqual(stopNotices, [], 'no attempt-quarantined / WI-15 notice for the stopped launch');
      const after = (await s.scheduler().call('tasks', {})) as Array<{ task: string; state: string; launches: string[] }>;
      const running = after.filter((t) => t.state === 'running');
      assert.deepEqual(running.map((t) => t.task), [], 'nothing runs after the stop');
      const newLaunches = after.flatMap((t) => t.launches).filter((l) => !before.flatMap((x) => x.launches).includes(l));
      assert.deepEqual(newLaunches, [], 'no launch after the stop');
      assert.equal(await event(s, `task:${TASK}`, 'product'), null, 'the stopped Constructor\'s work is not accepted (no product)');
      const conAfter = after.find((t) => t.task === con.task);
      assert.notEqual(conAfter?.state, 'done', `the stopped Constructor is not done: ${JSON.stringify(conAfter)}`);
      process.stderr.write(`[e2e stop] stop to "stopped" report in ${stopMs} ms; Constructor task ${con.task} is ${conAfter?.state} (${JSON.stringify(after.map((t) => `${t.task}:${t.state}`))})\n`);

      // the user confirms the stop was meant and lets the mission go on: the cancelled work does
      // not resume by itself; the Secretary's decision (here: abandon) is carried out
      const rel = await s.mp('stop-release', stop, '--reason', 'the user: 停 was meant for that task only; go on with the rest');
      assert.equal(rel.code, 0, `mp stop-release: ${rel.raw.stdout}${rel.raw.stderr}`);
      // the release takes effect: the Secretary task the flow queued for the stopped line is no longer held
      await waitFor(
        'the released stop to stop holding the work in its scope',
        60_000,
        async () => {
          const st = (await s.scheduler().call('status', {})) as { waiting: Array<{ task: string; reason: string }> };
          return !st.waiting.some((w) => /a stop covers it/.test(w.reason));
        },
        async () => `the stop is released in the ledger, but the scheduler still holds work under it (its staging copy and inbox slots still list it: src/scheduler/stops.ts covers() reads readPendingStops unfiltered)\n${await d()}`,
      );
      const abandoned = await waitFor('the Secretary\'s decision on the stopped task (abandon) carried out', 3 * MIN, () => event(s, `task:${TASK}`, 'abandoned'), d);
      assert.match(String(abandoned['escalation']), /^fail\.con\./);
      const final = (await s.scheduler().call('tasks', {})) as Array<{ task: string; state: string; launches: string[] }>;
      const sec = final.filter((t) => t.task.startsWith('sec.'));
      assert.ok(sec.length === 1 && sec[0]!.state === 'done', `one Secretary task, done: ${JSON.stringify(sec)}`);
      assert.deepEqual(
        final.filter((t) => t.task.startsWith('con.')).map((t) => `${t.task}:${t.launches.length}`),
        [`${con.task}:1`],
        'the stopped Constructor is never launched again',
      );
      assert.equal(await event(s, `task:${TASK}`, 'product'), null);
      process.stderr.write(`[e2e stop] released; Secretary abandoned the task; total ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

      closed = true;
      const left = await s.close();
      assert.deepEqual(left, { processes: [], units: [], mounts: [] }, 'nothing is left behind after the engine stops');
    } finally {
      if (!closed) await s.close();
    }
  });
  test('a rework and a Secretary decision: the Constructor\'s question goes to the Secretary, the Reviewer sends it back once, the second attempt is accepted and proven', { timeout: 15 * MIN }, async () => {
    const t0 = Date.now();
    const QUESTION = 'Should greet() also strip surrounding whitespace from the name?';
    const FINDING = 'greet() has no test for an empty name';
    const s = new Stack({
      name: 'rework',
      files: FILES,
      seats: {
        ...SEATS,
        handBack: (seat, card, n) => {
          if (seat === 'constructor' && n === 1) return constructorDone({ decisions_needed: [QUESTION] });
          if (seat === 'reviewer' && n === 1) return reviewer(card as never, 'rework', { failing: 'S1', findings: [FINDING] });
          if (seat === 'secretary') return secretary(card as never, 'answer', { instructions: 'No: keep the name as given (a detail within the authorization).' });
          return undefined;
        },
      },
    });
    let closed = false;
    try {
      s.makeProject();
      await s.start();
      await pmSide(s);
      const d = (): Promise<string> => diag(s);
      const first = await waitFor('the first product', 6 * MIN, () => event(s, `task:${TASK}`, 'product'), d);
      const review1 = await waitFor('the first review (rework)', 4 * MIN, async () => (await events(s, `task:${TASK}`, 'review')).at(0)?.doc ?? null, d);
      assert.equal(review1['verdict'], 'rework');
      const rework = await waitFor('the rework decision (attempt 2)', 2 * MIN, async () => (await events(s, `task:${TASK}`, 'rework')).find((e) => e.key === '2')?.doc ?? null, d);
      assert.ok((rework['issues'] as string[]).some((i) => i.includes(FINDING)), JSON.stringify(rework));
      const accepted = await waitFor('the second attempt accepted', 6 * MIN, async () => (await events(s, `task:${TASK}`, 'accepted')).find((e) => e.key === '2')?.doc ?? null, d);
      const products = (await events(s, `task:${TASK}`, 'product')).map((e) => e.doc);
      assert.equal(products.length, 2);
      assert.equal(accepted['product'], products[1]!['object']);
      assert.notEqual(products[1]!['object'], first['object']);
      const object = String(accepted['product']);
      await waitFor('the second product proven', 3 * MIN, async () => ((await s.evaluator().call('targets', { ids: [object] })) as { states: Record<string, { label: string } | null> }).states[object]?.label === 'proven', d);
      // the Constructor's question went to the Secretary (it did not stop the task) and was answered
      const secretaryEvents = await events(s, 'secretary');
      const esc = secretaryEvents.find((e) => e.event === 'escalation' && e.key.startsWith('cdec.'));
      assert.ok(esc !== undefined, `the Constructor's question is escalated: ${secretaryEvents.map((e) => `${e.event}/${e.key}`).join(', ')}`);
      assert.ok(secretaryEvents.some((e) => e.event === 'decision' && e.key === esc.key), `the Secretary decided: ${secretaryEvents.map((e) => `${e.event}/${e.key}`).join(', ')}`);
      // the second Reviewer saw the open issue of the first version (5.6)
      const revCards = (s.seats.launches.get('reviewer') ?? []).length;
      assert.equal(revCards, 2);
      assert.deepEqual(
        [...s.seats.launches.entries()].map(([k, v]) => `${k}:${v.length}`).sort(),
        ['architect-decompose:1', 'calibrator-1:1', 'calibrator-2:1', 'constructor:2', 'reviewer:2', 'secretary:1'],
      );
      const issues = await records(s, ['issue']);
      assert.ok(issues.length >= 1, 'the finding is an issue record');
      process.stderr.write(`[e2e rework] two attempts, one Secretary decision, proven in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
      closed = true;
      const left = await s.close();
      assert.deepEqual(left, { processes: [], units: [], mounts: [] });
    } finally {
      if (!closed) await s.close();
    }
  });
  test('the scheduler is killed while the Constructor runs: the watchdog restarts it, the new generation adopts the unit, the mission reaches proven', { timeout: 15 * MIN }, async () => {
    const t0 = Date.now();
    const s = new Stack({ name: 'takeover', files: FILES, seats: { ...SEATS, constructorCommands: ["node -e 'process.exit(0)' && cd src/greeter && python3 -B -m unittest -q test_greet && sleep 20"] } });
    let closed = false;
    try {
      s.makeProject();
      await s.start();
      await pmSide(s);
      const d = (): Promise<string> => diag(s);
      // the Constructor is inside its run_command (the tests pass in its sandbox, then it sleeps)
      await waitFor('the Constructor running its command', 6 * MIN, () => s.seats.log.some((e) => e.seat === 'constructor' && e.reply === 'run_command'), d);
      const hb = JSON.parse(readFileSync(join(s.cli.controlPlane, 'scheduler.heartbeat'), 'utf8')) as { pid: number };
      const gen0 = ((await s.scheduler().call('ping', {})) as { gen: number }).gen;
      process.kill(hb.pid, 'SIGKILL');
      const tKill = Date.now();
      // the watchdog starts a new scheduler generation
      const gen1 = await waitFor(
        'a new scheduler generation',
        2 * MIN,
        async () => {
          try {
            const p = (await s.scheduler().call('ping', {})) as { gen: number; started: boolean };
            return p.started && p.gen > gen0 ? p.gen : null;
          } catch {
            return null;
          }
        },
        d,
      );
      const restartMs = Date.now() - tKill;
      const accepted = await waitFor('the task accepted after the takeover', 6 * MIN, () => event(s, `task:${TASK}`, 'accepted'), d);
      const object = String(accepted['product']);
      await waitFor('the product proven', 3 * MIN, async () => ((await s.evaluator().call('targets', { ids: [object] })) as { states: Record<string, { label: string } | null> }).states[object]?.label === 'proven', d);
      const tasks = (await s.scheduler().call('tasks', {})) as Array<{ task: string; state: string; launches: string[] }>;
      const con = tasks.find((t) => t.task.startsWith('con.'));
      assert.equal(con?.launches.length, 1, `the Constructor's unit was adopted, not run again: ${JSON.stringify(con)}`);
      assert.equal((s.seats.launches.get('constructor') ?? []).length, 1);
      const product = await event(s, `task:${TASK}`, 'product');
      assert.equal(s.gitIn('show', `${String(product?.['commit'])}:src/greeter/greet.py`), FIXED);
      process.stderr.write(`[e2e takeover] scheduler gen ${gen0} killed, gen ${gen1} up in ${restartMs} ms; proven in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
      closed = true;
      const left = await s.close();
      assert.deepEqual(left, { processes: [], units: [], mounts: [] });
    } finally {
      if (!closed) await s.close();
    }
  });
  test('a false-positive stop (an ordinary "不要…" in the user\'s words) released by the PM: the mission goes on', { timeout: 10 * MIN }, async () => {
    const s = new Stack({ name: 'falsestop', files: FILES, seats: SEATS });
    let closed = false;
    try {
      s.makeProject();
      await s.start();
      let stop = '';
      // the mission is open; the user's message carries a constraint the conservative detection
      // takes for a stop (risk 9): with one open mission it covers that mission only
      await pmSide(s, {
        openFirst: true,
        prompt: `${PROMPT} 不要改测试文件。`,
        afterWords: async (facts) => {
          assert.match(facts, /"detected":true/, `the conservative detection stops on "不要": ${facts}`);
          stop = /"stop":\{"stop":"([^"]+)"/.exec(facts)?.[1] ?? '';
          assert.notEqual(stop, '');
          const scope = /"stop":\{"stop":"[^"]+","scope":(\{[^}]*\})/.exec(facts)?.[1] ?? '';
          assert.deepEqual(JSON.parse(scope || 'null'), { kind: 'mission', mission: MISSION }, `the stop covers the open mission only: ${facts}`);
          // the PM confirms with the user that it was not a stop, and releases it (WI: risk 9)
          const rel = await s.mp('stop-release', stop, '--reason', 'the user: 不要改测试文件 is a requirement, not a stop');
          assert.equal(rel.code, 0, `mp stop-release: ${rel.raw.stdout}${rel.raw.stderr}`);
        },
      });
      const d = (): Promise<string> => diag(s);
      await waitFor(
        'the PM plan to take effect after the released false-positive stop',
        2 * MIN,
        () => event(s, 'plan', 'pm-plan-effective'),
        async () => `stop ${stop} is released in the ledger; the scheduler still holds the work under it\n${await d()}`,
      );
      closed = true;
      const left = await s.close();
      assert.deepEqual(left, { processes: [], units: [], mounts: [] });
    } finally {
      if (!closed) await s.close();
    }
  });
  test('a lineage whose environment retries are exhausted: the Secretary runs and grants once, the next attempt is accepted', { timeout: 10 * MIN }, async () => {
    const s = new Stack({ name: 'exhausted', files: FILES, seats: { ...SEATS, modelError: (seat, n) => seat === 'constructor' && n <= 2 } });
    let closed = false;
    try {
      s.makeProject();
      await s.start();
      await pmSide(s);
      const d = (): Promise<string> => diag(s);
      // two environment failures with the same signature: the env-retry loop is exhausted (no progress), WI-08, the Secretary
      await waitFor('the exhausted lineage escalated to the Secretary', 6 * MIN, async () => (await events(s, 'secretary', 'escalation')).find((e) => e.doc['source'] === 'loop-exhausted') ?? null, d);
      await waitFor(
        'the Secretary seat to run for the exhausted lineage',
        2 * MIN,
        () => (s.seats.launches.get('secretary') ?? []).length > 0,
        async () => `the Secretary task runs in the lineage it handles (6.5) and that lineage is exhausted, so the scheduler refuses it at dispatch (src/scheduler/scheduler.ts submit: lineage = secretaryFor.lineage; dispatch: lineageExhausted)\n${await d()}`,
      );
      const accepted = await waitFor('the attempt after the grant accepted', 4 * MIN, () => event(s, `task:${TASK}`, 'accepted'), d);
      assert.ok(accepted !== null);
      closed = true;
      const left = await s.close();
      assert.deepEqual(left, { processes: [], units: [], mounts: [] });
    } finally {
      if (!closed) await s.close();
    }
  });
});
