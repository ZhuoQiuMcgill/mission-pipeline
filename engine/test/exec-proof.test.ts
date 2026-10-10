// Design 7.1 "终止证明" steps 1-5 and 6.3 "证明对账入口" (supervisor side): proof files,
// registration semantics, bounded back-off, deterministic rejection, stops. In-process, with a
// fake clock for the 10-minute schedule.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import { execAlert } from '../src/exec/alerts.ts';
import type { TerminationProofRecord } from '../src/common/records.ts';
import {
  DEFAULT_RETRY_POLICY,
  FileAlertSink,
  MemoryProofLedger,
  PROOF_FILE_FORMAT,
  markProofRejected,
  proofFilePath,
  readAlerts,
  readProofFile,
  removeProofFile,
  resubmitProofFile,
  scanProofFiles,
  submitProofWithRetry,
  validateTerminationProof,
  writeProofFile,
  type Clock,
  type ProofFile,
  type ProofSink,
  type ProofSubmitResult,
} from '../src/exec/proof.ts';
import {
  SUPERVISOR_CONFIG_FORMAT,
  bootId,
  isProcessAlive,
  parseSupervisorConfig,
  processIdentity,
} from '../src/exec/supervisor.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-exec-proof-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const L = id<LaunchId>('launch-proof-1');
const P: TerminationProofRecord = {
  kind: 'termination.proof',
  launch: L,
  exit: { code: 137, signal: null },
  controlOomKill: 1,
  unitOomKill: 4,
  unitOom: 1,
};

function file(p: TerminationProofRecord = P): ProofFile {
  return {
    format: PROOF_FILE_FORMAT,
    status: 'pending',
    proof: p,
    writtenAt: new Date(0).toISOString(),
    supervisor: { pid: 1, bootId: 'b' },
    diagnostics: {
      hostStarted: true,
      spawnError: null,
      hostExitedAt: new Date(0).toISOString(),
      unitEmptyAt: new Date(0).toISOString(),
      leftoversKilled: false,
      populatedAtProof: false,
      stopped: false,
      serviceOom: 0,
    },
    rejection: null,
  };
}

/** Time only moves when the code under test sleeps. */
function fakeClock(): Clock & { t: number; sleeps: number[] } {
  const c = {
    t: 0,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
  return c;
}

class ScriptedSink implements ProofSink {
  readonly attempts: number[] = [];
  private readonly answers: (ProofSubmitResult | Error)[];
  private readonly clock: Clock | null;
  constructor(answers: (ProofSubmitResult | Error)[], clock: Clock | null = null) {
    this.answers = answers;
    this.clock = clock;
  }
  async submit(): Promise<ProofSubmitResult> {
    this.attempts.push(this.clock?.now() ?? Date.now());
    const a = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (a === undefined) throw new Error('no answer scripted');
    if (a instanceof Error) throw a;
    return a;
  }
}

describe('proof validation', () => {
  test('a well-formed proof passes unchanged', () => {
    assert.deepEqual(validateTerminationProof(JSON.parse(JSON.stringify(P))), P);
    assert.deepEqual(validateTerminationProof({ ...P, exit: { code: null, signal: 'SIGKILL' } }).exit, { code: null, signal: 'SIGKILL' });
  });
  for (const [name, bad] of [
    ['extra key', { ...P, extra: 1 }],
    ['negative count', { ...P, unitOom: -1 }],
    ['fractional count', { ...P, unitOomKill: 1.5 }],
    ['bad launch id', { ...P, launch: '../x' }],
    ['wrong kind', { ...P, kind: 'evidence' }],
    ['code and signal both set', { ...P, exit: { code: 1, signal: 'SIGKILL' } }],
    ['bad signal name', { ...P, exit: { code: null, signal: 'kill' } }],
    ['not an object', 'proof'],
  ] as const) {
    test(`rejects: ${name}`, () => assert.throws(() => validateTerminationProof(bad)));
  }
});

describe('proof files in the state directory', () => {
  test('written atomically under proofs/<launch>.json, read back, scanned, marked, removed', () => {
    const state = tmp();
    const path = writeProofFile(state, file());
    assert.equal(path, proofFilePath(state, L));
    assert.deepEqual(readProofFile(path), file());
    // no temporary file is left next to it
    assert.deepEqual(readdirSync(join(state, 'proofs')), [`${L}.json`]);

    let scan = scanProofFiles(state);
    assert.equal(scan.pending.length, 1);
    assert.equal(scan.rejected.length, 0);

    const marked = markProofRejected(path, 'conflicting-proof', 'different content', new Date(5));
    assert.equal(marked.status, 'rejected');
    assert.deepEqual(marked.proof, P, 'the proof itself is kept unchanged');
    scan = scanProofFiles(state);
    assert.equal(scan.pending.length, 0);
    assert.equal(scan.rejected[0]?.file.rejection?.reason, 'conflicting-proof');

    removeProofFile(path);
    removeProofFile(path); // idempotent
    assert.deepEqual(scanProofFiles(state), { pending: [], rejected: [], malformed: [] });
  });

  test('scan ignores interrupted atomic writes and reports malformed files', () => {
    const state = tmp();
    mkdirSync(join(state, 'proofs'));
    writeFileSync(join(state, 'proofs', `.${L}.json.abc123.tmp`), '{"half');
    writeFileSync(join(state, 'proofs', 'launch-x.json'), '{"format":"nope"}');
    writeFileSync(join(state, 'proofs', 'launch-y.json'), JSON.stringify(file())); // name does not match its launch
    const scan = scanProofFiles(state);
    assert.equal(scan.pending.length, 0);
    assert.deepEqual(
      scan.malformed.map((m) => m.path.split('/').pop()),
      ['launch-x.json', 'launch-y.json'],
    );
  });

  test('scan of a state directory without proofs is empty', () => {
    assert.deepEqual(scanProofFiles(tmp()), { pending: [], rejected: [], malformed: [] });
  });
});

describe('registration semantics (reference ledger, 7.1 step 4)', () => {
  test('dedup by launch id: the same proof again returns the same ack', async () => {
    const ledger = new MemoryProofLedger({ knownLaunches: [L] });
    const a = await ledger.submit(P);
    const b = await ledger.submit(JSON.parse(JSON.stringify(P)));
    assert.equal(a.kind, 'registered');
    assert.equal(b.kind, 'registered');
    if (a.kind === 'registered' && b.kind === 'registered') {
      assert.equal(a.duplicate, false);
      assert.equal(b.duplicate, true);
      assert.equal(b.ack, a.ack);
    }
    assert.equal(ledger.size, 1);
  });

  test('deterministic rejections: conflicting content, unknown launch, malformed', async () => {
    const ledger = new MemoryProofLedger({ knownLaunches: [L] });
    await ledger.submit(P);
    assert.deepEqual((await ledger.submit({ ...P, unitOomKill: 5 })).kind, 'rejected');
    const conflict = await ledger.submit({ ...P, unitOomKill: 5 });
    assert.equal(conflict.kind === 'rejected' && conflict.reason, 'conflicting-proof');
    const unknown = await ledger.submit({ ...P, launch: id<LaunchId>('launch-never-dispatched') });
    assert.equal(unknown.kind === 'rejected' && unknown.reason, 'launch-mismatch');
    const malformed = await ledger.submit({ ...P, unitOom: 'one' } as unknown as TerminationProofRecord);
    assert.equal(malformed.kind === 'rejected' && malformed.reason, 'malformed');
    assert.deepEqual(ledger.get(L), P, 'the first registration stands');
  });
});

describe('submission with bounded back-off (7.1 step 3)', () => {
  test('default schedule: 1 s doubling to 60 s, nothing started after 10 minutes', async () => {
    const clock = fakeClock();
    const sink = new ScriptedSink([new Error('ledger unavailable')], clock);
    const out = await submitProofWithRetry(P, sink, { clock });
    assert.equal(out.kind, 'gave-up');
    assert.deepEqual(clock.sleeps.slice(0, 8), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    assert.ok(clock.sleeps.every((s) => s <= DEFAULT_RETRY_POLICY.maxDelayMs));
    assert.deepEqual(sink.attempts, [0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000, 243000, 303000, 363000, 423000, 483000, 543000]);
    assert.ok((sink.attempts.at(-1) ?? 0) <= DEFAULT_RETRY_POLICY.totalMs);
    assert.equal(out.attempts, 15);
  });

  test('success after transient failures stops retrying', async () => {
    const clock = fakeClock();
    const sink = new ScriptedSink(
      [new Error('down'), { kind: 'unavailable', detail: 'storage failure' }, { kind: 'registered', ack: 'a1', duplicate: false }],
      clock,
    );
    const out = await submitProofWithRetry(P, sink, { clock });
    assert.deepEqual(out, { kind: 'registered', ack: 'a1', duplicate: false, attempts: 3 });
    assert.deepEqual(sink.attempts, [0, 1000, 3000]);
  });

  test('a deterministic rejection is final after one attempt', async () => {
    const clock = fakeClock();
    const sink = new ScriptedSink([{ kind: 'rejected', reason: 'conflicting-proof', detail: 'x' }], clock);
    const out = await submitProofWithRetry(P, sink, { clock });
    assert.equal(out.kind, 'rejected');
    assert.equal(sink.attempts.length, 1);
  });

  test('an unrecognized sink answer counts as unavailable, not as success', async () => {
    const clock = fakeClock();
    const sink = new ScriptedSink([{ kind: 'ok' } as unknown as ProofSubmitResult], clock);
    const out = await submitProofWithRetry(P, sink, { clock, policy: { ...DEFAULT_RETRY_POLICY, totalMs: 5000 } });
    assert.equal(out.kind, 'gave-up');
  });

  test('under a stop: exactly one submission, then exit', async () => {
    const clock = fakeClock();
    const sink = new ScriptedSink([new Error('down')], clock);
    const stop = new AbortController();
    stop.abort();
    const out = await submitProofWithRetry(P, sink, { clock, stop: stop.signal });
    assert.equal(out.kind, 'stopped');
    assert.equal(sink.attempts.length, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('a stop arriving during the back-off: one last attempt, then exit', async () => {
    const stop = new AbortController();
    const clock = fakeClock();
    const realSleep = clock.sleep;
    clock.sleep = async (ms, signal) => {
      await realSleep(ms, signal);
      if (clock.sleeps.length === 2) stop.abort();
    };
    const sink = new ScriptedSink([new Error('down')], clock);
    const out = await submitProofWithRetry(P, sink, { clock, stop: stop.signal });
    assert.equal(out.kind, 'stopped');
    assert.equal(sink.attempts.length, 3);
  });

  test('a hanging sink call times out and counts as a failed attempt', async () => {
    const hang: ProofSink = { submit: () => new Promise(() => undefined) };
    const out = await submitProofWithRetry(P, hang, {
      clock: fakeClock(),
      policy: { initialDelayMs: 1, maxDelayMs: 1, totalMs: 0, attemptTimeoutMs: 30 },
    });
    assert.equal(out.kind, 'gave-up');
    if (out.kind === 'gave-up') assert.match(out.lastError, /no answer within 30 ms/);
  });
});

describe('scheduler side: resubmitting files left in the state directory (6.3 entry step 2)', () => {
  test('registered: the file is removed; the ledger holds the proof', async () => {
    const state = tmp();
    writeProofFile(state, file());
    const ledger = new MemoryProofLedger();
    const [entry] = scanProofFiles(state).pending;
    assert.ok(entry);
    const out = await resubmitProofFile(entry, ledger);
    assert.equal(out.kind, 'registered');
    assert.deepEqual(ledger.get(L), P);
    assert.equal(scanProofFiles(state).pending.length, 0);
  });

  test('rejected: the file is marked and never offered again', async () => {
    const state = tmp();
    writeProofFile(state, file());
    const ledger = new MemoryProofLedger();
    await ledger.submit({ ...P, unitOom: 0 });
    const [entry] = scanProofFiles(state).pending;
    assert.ok(entry);
    const out = await resubmitProofFile(entry, ledger);
    assert.equal(out.kind, 'rejected');
    const scan = scanProofFiles(state);
    assert.equal(scan.pending.length, 0);
    assert.equal(scan.rejected[0]?.file.rejection?.reason, 'conflicting-proof');
  });

  test('ledger unavailable: one attempt, the file stays pending', async () => {
    const state = tmp();
    writeProofFile(state, file());
    const [entry] = scanProofFiles(state).pending;
    assert.ok(entry);
    const out = await resubmitProofFile(entry, new ScriptedSink([new Error('down')]));
    assert.equal(out.kind, 'gave-up');
    assert.equal(out.attempts, 1);
    assert.equal(scanProofFiles(state).pending.length, 1);
  });
});

describe('alerts and identity', () => {
  test('alerts are appended durably and read back, each with its WI, trigger facts and default action (3.11)', () => {
    const state = tmp();
    const sink = new FileAlertSink(state);
    sink.alert(execAlert('proof-rejected', L, 'x', { reason: 'conflicting-proof' }, 'the file is marked rejected'));
    sink.alert(execAlert('supervisor-error', null, 'y', { error: 'boom' }, 'the supervisor exits'));
    const got = readAlerts(state);
    assert.deepEqual(
      got.map((a) => [a.kind, a.wi, a.defaultAction]),
      [
        ['proof-rejected', 'WI-20', 'the file is marked rejected'],
        ['supervisor-error', 'WI-15', 'the supervisor exits'],
      ],
    );
    assert.deepEqual(got[0]?.trigger, { reason: 'conflicting-proof' });
  });

  test('process identity: this process is alive; a changed start time or boot id is not the same process', () => {
    const me = processIdentity(process.pid);
    assert.ok(me);
    assert.equal(me.bootId, bootId());
    assert.equal(isProcessAlive(me), true);
    assert.equal(isProcessAlive({ ...me, startTime: me.startTime + 1 }), false);
    assert.equal(isProcessAlive({ ...me, bootId: 'another-boot' }), false);
    assert.equal(processIdentity(2 ** 22 + 12345), null);
  });
});

describe('supervisor configuration', () => {
  const base = {
    format: SUPERVISOR_CONFIG_FORMAT,
    launch: 'launch-cfg-1',
    stateDir: '/tmp/state',
    unitName: null,
    host: { argv: ['/bin/true'], env: { PATH: '/usr/bin' }, cwd: '/' },
    unit: { memoryMax: 1 << 26, pidsMax: 32 },
    sink: { module: '/abs/sink.mjs', options: { a: 1 } },
  };

  test('a valid config parses with defaults filled in', () => {
    const c = parseSupervisorConfig(base);
    assert.equal(c.launch, 'launch-cfg-1');
    assert.deepEqual(c.stopFiles, []);
    assert.deepEqual(c.retry, {});
  });

  for (const [name, patch] of [
    ['relative state dir', { stateDir: 'state' }],
    ['empty argv', { host: { ...base.host, argv: [] } }],
    ['relative sink module', { sink: { module: 'sink.mjs' } }],
    ['zero memory', { unit: { memoryMax: 0 } }],
    ['bad launch id', { launch: 'a/b' }],
    ['unknown format', { format: 'v0' }],
    ['negative retry', { retry: { totalMs: -1 } }],
  ] as const) {
    test(`rejects: ${name}`, () => assert.throws(() => parseSupervisorConfig({ ...base, ...patch })));
  }
});
