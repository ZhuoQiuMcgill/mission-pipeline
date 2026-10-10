// Design 7.1: acceptance of an attempt from its termination proof and the host's pending
// records under the launch, and classification of a run layer's end. Pure table tests.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { id, type LaunchId, type RunId } from '../src/common/ids.ts';
import type { BaseRecord, ClaudeCodeExitRecord, RunLayerRecord, SeatResultRecord, TerminationProofRecord } from '../src/common/records.ts';
import { checkTerminationProof, claudeCodeExit, classifyRunLayer, recordedOomKills, seatNeverStarted, type HostRecords } from '../src/exec/acceptance.ts';

const L = id<LaunchId>('launch-acc-1');
const OTHER = id<LaunchId>('launch-acc-2');

function proof(p: Partial<TerminationProofRecord> = {}): TerminationProofRecord {
  return { kind: 'termination.proof', launch: L, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0, ...p };
}

function run(run: string, oomKillDelta: number, extra: Partial<RunLayerRecord> = {}): RunLayerRecord {
  return {
    kind: 'run.layer',
    launch: L,
    run: id<RunId>(run),
    finalOom: oomKillDelta > 0 ? 1 : 0,
    finalOomKill: oomKillDelta,
    oomDelta: oomKillDelta > 0 ? 1 : 0,
    oomKillDelta,
    status: oomKillDelta > 0 ? 'resource-exceeded' : 'completed',
    ...extra,
  };
}

function cc(code: number | null, signal: string | null = null, launch: LaunchId = L): ClaudeCodeExitRecord {
  return { kind: 'claude-code.exit', launch, exit: { code, signal } };
}

/** A seat unit's pending records: its run layers and the recorded end of Claude Code. */
const seat = (runLayers: RunLayerRecord[] = [], code = 0): HostRecords => ({ seatUnit: true, records: [...runLayers, cc(code)] });

describe('run layer classification (7.1 "运行层被结束时，宿主怎样告诉席位")', () => {
  const cases: [string, { oom: number; oomKill: number }, string][] = [
    ['nothing happened', { oom: 0, oomKill: 0 }, 'completed'],
    ['own limit fired and killed', { oom: 1, oomKill: 4 }, 'resource-exceeded'],
    ['own limit fired, nothing killed yet', { oom: 1, oomKill: 0 }, 'resource-exceeded'],
    ['killed by an ancestor or machine shortage', { oom: 0, oomKill: 3 }, 'environment-failure'],
    ['own oom wins over oom_kill', { oom: 2, oomKill: 9 }, 'resource-exceeded'],
  ];
  for (const [name, d, want] of cases) test(name, () => assert.equal(classifyRunLayer(d), want));
});

describe('acceptance from the termination proof (7.1, three checks)', () => {
  test('normal unit, no OOM: eligible', () => {
    assert.deepEqual(checkTerminationProof(proof(), seat()), { eligible: true });
  });

  test('a run layer hit its own limit and the host accounted for every kill: eligible', () => {
    assert.deepEqual(checkTerminationProof(proof({ unitOomKill: 4 }), seat([run('r1', 4), run('r2', 0)])), { eligible: true });
  });

  test('several run layers: unit oom_kill must equal the sum of their final deltas', () => {
    assert.deepEqual(checkTerminationProof(proof({ unitOomKill: 7 }), seat([run('r1', 4), run('r2', 3)])), { eligible: true });
    const v = checkTerminationProof(proof({ unitOomKill: 8 }), seat([run('r1', 4), run('r2', 3)]));
    assert.equal(v.eligible, false);
    if (!v.eligible) {
      assert.equal(v.outcome, 'environment-failure');
      assert.deepEqual(v.failures, [{ check: 'oom-kills-accounted', unitOomKill: 8, recordedOomKill: 7 }]);
    }
  });

  test('a kill the host did not record (ancestor OOM: unit oom 0, oom_kill > 0) is an environment failure', () => {
    const v = checkTerminationProof(proof({ exit: { code: null, signal: 'SIGKILL' }, controlOomKill: 2, unitOomKill: 3, unitOom: 0 }), seat());
    assert.equal(v.eligible, false);
    if (!v.eligible) {
      assert.equal(v.outcome, 'environment-failure');
      assert.deepEqual(
        v.failures.map((f) => f.check),
        ['normal-exit', 'control-oom-kill', 'oom-kills-accounted'],
      );
    }
  });

  test('unit limit fired (unit oom > 0): resource exceeded', () => {
    const v = checkTerminationProof(proof({ exit: { code: null, signal: 'SIGKILL' }, controlOomKill: 2, unitOomKill: 4, unitOom: 1 }), seat());
    assert.equal(v.eligible, false);
    if (!v.eligible) assert.equal(v.outcome, 'resource-exceeded');
  });

  test('v34: all three checks met but the unit hit its own limit (oom > 0, nothing killed): not accepted, resource exceeded', () => {
    const v = checkTerminationProof(proof({ unitOom: 1 }), seat());
    assert.equal(v.eligible, false);
    if (!v.eligible) {
      assert.equal(v.outcome, 'resource-exceeded');
      assert.deepEqual(v.failures, [{ check: 'unit-oom', unitOom: 1 }]);
    }
  });

  test('host exited non-zero: environment failure', () => {
    const v = checkTerminationProof(proof({ exit: { code: 1, signal: null } }), seat());
    assert.equal(v.eligible, false);
    if (!v.eligible) {
      assert.equal(v.outcome, 'environment-failure');
      assert.deepEqual(v.failures, [{ check: 'normal-exit', detail: 'host exited with 1' }]);
    }
  });

  test('host killed by a signal without OOM: environment failure', () => {
    const v = checkTerminationProof(proof({ exit: { code: null, signal: 'SIGTERM' } }), seat());
    assert.equal(v.eligible, false);
    if (!v.eligible) assert.equal(v.outcome, 'environment-failure');
  });

  test('Claude Code ended abnormally, was not recorded, or was recorded twice differently: not eligible', () => {
    assert.equal(checkTerminationProof(proof(), seat([], 2)).eligible, false);
    const missing = checkTerminationProof(proof(), { seatUnit: true, records: [] });
    assert.equal(missing.eligible, false);
    if (!missing.eligible) assert.equal(missing.failures[0]?.check, 'normal-exit');
    const twice = checkTerminationProof(proof(), { seatUnit: true, records: [cc(0), cc(null, 'SIGKILL')] });
    assert.equal(twice.eligible, false);
    assert.deepEqual(claudeCodeExit(L, [cc(0), cc(0)]), { exit: { code: 0, signal: null } });
    assert.ok('problem' in claudeCodeExit(L, [cc(0, null, OTHER)]), 'another launch does not count');
  });

  test('a unit without a seat (verification run) needs no Claude Code record; other records are ignored', () => {
    const other: BaseRecord = { kind: 'notice', notice: 'n', audience: 'pm', body: '0'.repeat(64) as never };
    assert.deepEqual(checkTerminationProof(proof(), { seatUnit: false, records: [other] }), { eligible: true });
  });

  test('control layer lost a process to an OOM: not eligible even if counts match', () => {
    const v = checkTerminationProof(proof({ controlOomKill: 1, unitOomKill: 1 }), seat([run('r1', 1)]));
    assert.equal(v.eligible, false);
    if (!v.eligible) assert.deepEqual(v.failures, [{ check: 'control-oom-kill', controlOomKill: 1 }]);
  });

  test('more recorded kills than the unit saw: not eligible', () => {
    assert.equal(checkTerminationProof(proof({ unitOomKill: 0 }), seat([run('r1', 2)])).eligible, false);
  });
});

describe('run-layer records count once (7.1 check 3: "每份计数只累计一次")', () => {
  test('the same run recorded twice with the same content counts once', () => {
    assert.deepEqual(recordedOomKills(L, [run('r1', 4), run('r1', 4)]), { sum: 4, problems: [] });
  });

  test('the same run recorded twice with different contents is a problem', () => {
    assert.equal(recordedOomKills(L, [run('r1', 4), run('r1', 5)]).problems.length, 1);
    const v = checkTerminationProof(proof({ unitOomKill: 4 }), seat([run('r1', 4), run('r1', 5)]));
    assert.equal(v.eligible, false);
    if (!v.eligible) assert.ok(v.failures.some((f) => f.check === 'run-records'));
  });

  test('records of another launch are not counted and make the attempt unaccountable', () => {
    const r = recordedOomKills(L, [run('r1', 4, { launch: OTHER })]);
    assert.equal(r.sum, 0);
    assert.equal(r.problems.length, 1);
  });

  test('malformed counters are a problem', () => {
    assert.equal(recordedOomKills(L, [run('r1', -1)]).problems.length, 1);
  });
});

describe('a seat the host never started for want of resources (code review M2)', () => {
  const sr = (over: Partial<SeatResultRecord> = {}): SeatResultRecord => ({
    kind: 'seat.result',
    launch: L,
    seat: 'constructor',
    status: 'resource-exceeded',
    result: null,
    export: null,
    transcript: null,
    recoveryState: null,
    evidenceRequest: null,
    ...over,
  });
  test('is eligible on its own report ("resource exceeded", nothing in it), not refused for a missing Claude Code exit', () => {
    assert.equal(seatNeverStarted(L, [sr()]), true);
    assert.deepEqual(checkTerminationProof(proof(), { seatUnit: true, records: [sr()] }), { eligible: true });
  });
  test('anything else still needs the Claude Code exit', () => {
    for (const records of [[sr({ status: 'environment-failure' })], [sr({ transcript: 'a'.repeat(64) as never })], [sr(), sr()], [], [sr({ launch: id<LaunchId>('launch-other') })]]) {
      assert.equal(seatNeverStarted(L, records), false, JSON.stringify(records));
      const v = checkTerminationProof(proof(), { seatUnit: true, records });
      assert.ok(!v.eligible && v.failures.some((f) => f.check === 'normal-exit'), JSON.stringify(v));
    }
    // a recorded exit is checked as always
    const v = checkTerminationProof(proof(), { seatUnit: true, records: [sr(), cc(1)] });
    assert.ok(!v.eligible);
    // and the host's own exit too
    const h = checkTerminationProof(proof({ exit: { code: 1, signal: null } }), { seatUnit: true, records: [sr()] });
    assert.ok(!h.eligible);
  });
});
