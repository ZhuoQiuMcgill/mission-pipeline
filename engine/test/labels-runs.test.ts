// Run classes and the environment identity (4.1 §6.5; scenarios 7 and 13):
// declared / sampling / other, fixed when the run is recorded; the refusal of a
// judgment that uses a timing, statistical or external field of a run that is
// not a sampling run; reuse of declared runs only; the identity observed once
// per process and recorded when it changes; "needs rerun" after a change; the
// mechanical renewal of declared runs with equal outputs; the mechanical
// regression check with declared runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixKey } from '../src/common/records.ts';
import {
  currentEnvironment,
  decisionLabels,
  ENV_LINE,
  environmentConfig,
  environmentIdentity,
  findReusableRun,
  fixStates,
  forgetObservedEnvironment,
  observeEnvironment,
  readEnvironmentConfig,
  recordedEnvironment,
  recordEnvironment,
  recordRenewal,
  recordRenewedRun,
  renewalCandidates,
  rerunMismatch,
  RUN_FIELD,
  RUN_METHOD,
  runClassOf,
  sampleRunId,
} from '../src/evaluator/index.ts';
import { appendRecords, commitProofOp, LedgerError, recordsByKind, type Memory, type WriteTx } from '../src/memory/index.ts';
import { builders, labelProject, machine } from './labels-fixtures.ts';

let n = 0;
function w<T>(m: Memory, fn: (tx: WriteTx) => T): T {
  const op = `r-${++n}`;
  return m.write({ op, payload: op }, fn);
}

function refused(fn: () => unknown, code: string, re?: RegExp): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LedgerError, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (re) assert.match(caught.message, re);
}

test('run classes: fixed from the card when the run is recorded (declared, sampling, other)', () => {
  const card = { by: 'mp' as const, checkout: 'clean' as const, declared: true, network: false, sampled: false };
  assert.equal(runClassOf(card), 'declared');
  assert.equal(runClassOf({ ...card, sampled: true }), 'sampling', 'a benchmark the card marks sampled');
  assert.equal(runClassOf({ ...card, experiment: true }), 'sampling', 'an exploration experiment');
  assert.equal(runClassOf({ ...card, rerun: true }), 'sampling', 'mp seat <id> rerun');
  assert.equal(runClassOf({ ...card, network: true }), 'other', 'network declared');
  assert.equal(runClassOf({ ...card, network: true, sampled: true }), 'sampling', 'sampling marks win: an external measurement');
  assert.equal(runClassOf({ ...card, by: 'seat' }), 'other', "a seat's scratch run");
  assert.equal(runClassOf({ ...card, checkout: 'worktree' }), 'other', 'a run on a worktree');
  assert.equal(runClassOf({ ...card, declared: false }), 'other', 'a command the card does not declare');

  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    w(m, (tx) => appendRecords(tx, [b.evidence('E1', 'I1', 'declared')]));
    // The same run id with another class is another fact: refused; the same record again is a no-op.
    refused(() => w(m, (tx) => appendRecords(tx, [b.evidence('E1', 'I1', 'sampling')])), 'FACT_CONFLICT');
    w(m, (tx) => appendRecords(tx, [b.evidence('E1', 'I1', 'declared')]));
    refused(() => w(m, (tx) => appendRecords(tx, [b.evidence('E2', 'I1', 'closed' as never)])), 'RECORD_INVALID', /runClass must be one of declared, sampling, other/);
  } finally {
    p.cleanup();
  }
});

test('a judgment that uses a timing, statistical or external field rests only on sampling runs: refused otherwise, whichever arrives first', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    w(m, (tx) => appendRecords(tx, [b.product('P'), b.evidence('D', 'I1', 'declared', { exit: '0', durationMs: '120' }), b.evidence('S', 'I1', 'sampling', { exit: '0', durationMs: '118', 'stat:p95': '130' }), b.evidence('X', 'I1', 'other', { exit: '0', 'ext:status': '200' })]));
    refused(() => w(m, (tx) => appendRecords(tx, [b.judge('J1', 'P', { evidence: ['D'], fields: ['exit', 'durationMs'] })])), 'RECORD_INVALID', /uses the field durationMs of run D, a declared run/);
    refused(() => w(m, (tx) => appendRecords(tx, [b.judge('J2', 'P', { evidence: ['X'], fields: ['ext:status'] })])), 'RECORD_INVALID', /a other run/);
    refused(() => w(m, (tx) => appendRecords(tx, [b.judge('J3', 'P', { evidence: ['D'], fields: ['exit'], statisticalOrExternal: true })])), 'RECORD_INVALID', /statistical inference or external state of run D/);
    // On sampling runs: accepted. A judgment using only plain fields may rest on any run.
    w(m, (tx) => appendRecords(tx, [b.judge('J4', 'P', { evidence: ['S'], fields: ['exit', 'durationMs', 'stat:p95'] }), b.judge('J5', 'P', { evidence: ['D', 'X'], fields: ['exit'], review: 'sec' })]));
    // The judgment first, the run later: the run is refused when its class does not fit.
    w(m, (tx) => appendRecords(tx, [b.judge('J6', 'P', { evidence: ['LATER'], fields: ['time:wall'], review: 'perf' })]));
    refused(() => w(m, (tx) => appendRecords(tx, [b.evidence('LATER', 'I1', 'declared', { 'time:wall': '5' })])), 'RECORD_INVALID', /judgment J6 uses the field time:wall of run LATER/);
    w(m, (tx) => appendRecords(tx, [b.evidence('LATER', 'I1', 'sampling', { 'time:wall': '5' })]));
  } finally {
    p.cleanup();
  }
});

test('reuse: only a declared run, for the same candidate, command and environment identity; a sampling run is never reused and every rerun is a new run (scenario 13)', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    const b = builders(m);
    const f = (extra: Record<string, string> = {}): Record<string, string> => ({ exit: '0', [RUN_FIELD.candidate]: 'c'.repeat(40), [RUN_FIELD.command]: 'npm test', ...extra });
    w(m, (tx) => appendRecords(tx, [b.evidence('D1', env, 'declared', f()), b.evidence('O1', env, 'other', f({ [RUN_FIELD.command]: 'curl x' })), b.evidence('D0', 'older', 'declared', f())]));
    assert.equal(m.read((db) => findReusableRun(db, { candidate: 'c'.repeat(40), command: 'npm test' }))?.evidence, 'D1');
    assert.equal(m.read((db) => findReusableRun(db, { candidate: 'c'.repeat(40), command: 'npm test', environment: 'another' })), null, 'another identity');
    assert.equal(m.read((db) => findReusableRun(db, { candidate: 'd'.repeat(40), command: 'npm test' })), null, 'another candidate');
    assert.equal(m.read((db) => findReusableRun(db, { candidate: 'c'.repeat(40), command: 'curl x' })), null, 'an other run is never reused');
    // A benchmark run twice on the same candidate, command and environment: two runs, two ids.
    const ids = [sampleRunId('bench.P'), sampleRunId('bench.P')];
    assert.notEqual(ids[0], ids[1]);
    w(m, (tx) => appendRecords(tx, ids.map((x) => b.evidence(x, env, 'sampling', f({ [RUN_FIELD.command]: 'npm run bench', 'time:wall': '7' })))));
    assert.equal(m.read((db) => recordsByKind(db, { kinds: ['evidence'] })).filter((c) => (c.record as { fields: Record<string, string> }).fields[RUN_FIELD.command] === 'npm run bench').length, 2);
    assert.equal(m.read((db) => findReusableRun(db, { candidate: 'c'.repeat(40), command: 'npm run bench' })), null, 'a sampling run is never reused');
    w(m, (tx) => appendRecords(tx, [{ kind: 'evidence.revoked', evidence: 'D1' } as never]));
    assert.equal(m.read((db) => findReusableRun(db, { candidate: 'c'.repeat(40), command: 'npm test' })), null, 'a revoked run is not reused');
  } finally {
    p.cleanup();
  }
});

test('the environment identity: config key, parts, hash; observed once per process; recorded only when it changes', () => {
  assert.deepEqual(environmentConfig({ targetBranch: 'main', environment: { versionCommands: ['node --version', 'node --version', 'git --version'] } }), { versionCommands: ['node --version', 'git --version'] });
  assert.deepEqual(environmentConfig({ targetBranch: 'main' }), { versionCommands: [] });
  assert.throws(() => environmentConfig({ environment: { versionCommands: 'node --version' } }), /versionCommands/);
  const p = labelProject();
  try {
    const { m, dir } = p;
    mkdirSync(join(dir, '.mission-pipeline'), { recursive: true });
    writeFileSync(join(dir, '.mission-pipeline', 'config.json'), JSON.stringify({ environment: { versionCommands: ['node --version'] }, other: { owned: 'elsewhere' } }));
    const cfg = readEnvironmentConfig(dir);
    assert.deepEqual(cfg, { versionCommands: ['node --version'] });
    const parts = observeEnvironment(dir, cfg);
    assert.equal(parts.os, process.platform);
    assert.equal(parts.arch, process.arch);
    assert.equal(parts.versions['node --version'], process.version);
    assert.equal(environmentIdentity(parts), environmentIdentity({ ...parts }), 'the identity is the hash of the parts');

    let observed = 0;
    const observe = (): ReturnType<ReturnType<typeof machine>> => {
      observed++;
      return machine('linux')();
    };
    const first = currentEnvironment(m, { observe });
    assert.equal(first.changed, true);
    assert.equal(first.previous, null);
    const again = currentEnvironment(m, { observe });
    assert.equal(again.changed, false);
    assert.equal(observed, 1, 'observed at most once per process');
    const rec = m.read((db) => recordedEnvironment(db));
    assert.equal(rec?.identity, first.identity);
    assert.deepEqual(rec?.parts, machine('linux')());
    assert.equal(m.read((db) => recordsByKind(db, { kinds: ['env.snapshot'] })).length, 1);
    // Another machine (a new process there).
    forgetObservedEnvironment(m.projectDir);
    const win = currentEnvironment(m, { observe: machine('win32', { 'node --version': 'v22.17.1' }) });
    assert.equal(win.changed, true);
    assert.equal(win.previous, first.identity);
    assert.equal(m.read((db) => recordsByKind(db, { kinds: ['env.snapshot'] })).length, 2);
  } finally {
    p.cleanup();
  }
});

test('the gate refuses a decision in a process that has not observed the environment, or whose observation is no longer the recorded one', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    w(m, (tx) => appendRecords(tx, [b.evidence('E1', env), b.product('P'), b.judge('J', 'P', { evidence: ['E1'] }), b.pending('op', ['P'])]));
    forgetObservedEnvironment(m.projectDir);
    refused(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never })), 'BAD_REQUEST', /not observed the environment identity/);
    currentEnvironment(m, { observe: machine('linux') });
    // Another process (another harness on the same folder) recorded its identity meanwhile.
    w(m, (tx) => recordEnvironment(tx, { identity: 'f'.repeat(64) as never, parts: machine('darwin')() }));
    refused(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never })), 'STALE_REQUEST', /call currentEnvironment\(memory\) again/);
    const back = currentEnvironment(m, { observe: machine('linux') });
    assert.equal(back.changed, true, 'this process records its own identity again');
    w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }));
  } finally {
    p.cleanup();
  }
});

test('scenario 7 (4.1.2): a proven product moved to another machine stays proven (older environment); an explicit rerun with equal declared outputs renews it; a timing judgment cannot be renewed', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    const linux = currentEnvironment(m, { observe: machine('linux') }).identity;
    const commit = 'a'.repeat(40);
    const fields = { exit: '0', out: 'h1', durationMs: '120', [RUN_FIELD.candidate]: commit, [RUN_FIELD.command]: 'npm test', [RUN_FIELD.method]: RUN_METHOD };
    w(m, (tx) =>
      appendRecords(tx, [
        b.basis('S', 'S.v1', 'standard'),
        b.evidence('E1', linux, 'declared', fields),
        b.evidence('B1', linux, 'sampling', { exit: '0', 'time:wall': '7', [RUN_FIELD.candidate]: commit, [RUN_FIELD.command]: 'npm run bench', [RUN_FIELD.method]: RUN_METHOD }),
        b.product('P', { commit, reviews: [{ review: 'reviewer' }, { review: 'perf' }] }),
        b.judge('J', 'P', { evidence: ['E1'], bases: ['S.v1'], fields: ['exit', 'out'] }),
        b.judge('JT', 'P', { evidence: ['B1'], bases: ['S.v1'], fields: ['exit', 'time:wall'], review: 'perf' }),
        b.product('Q', { commit, reviews: [{ review: 'reviewer' }] }),
        b.judge('JQ', 'Q', { evidence: ['E1'], bases: ['S.v1'], fields: ['exit', 'out'] }),
      ]),
    );
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', 'Q'])), { P: 'proven', Q: 'proven' });
    // The folder is opened on Windows: a new process observes another identity.
    forgetObservedEnvironment(m.projectDir);
    const win = currentEnvironment(m, { observe: machine('win32') });
    assert.equal(win.changed, true);
    // 4.1.2 (D-1): runs from an older environment still count; reads label them "older environment"
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', 'Q'])), { P: 'proven', Q: 'proven' }, 'an environment change alone invalidates nothing; history unchanged');
    assert.equal(m.read((db) => recordsByKind(db, { kinds: ['judgment'] })).length, 3);

    // What `mp pm renew` must rerun, and what needs a Reviewer.
    const rc = m.read((db) => renewalCandidates(db));
    assert.equal(rc.environment, win.identity);
    assert.deepEqual(
      rc.candidates.map((c) => [c.evidence, c.command, c.candidate, c.commits, c.environment, c.judgments.map((j) => [j.judgment, j.renewable])]),
      [['E1', 'npm test', commit, [commit], linux, [['J', true], ['JQ', true]]]],
    );
    assert.equal(rc.affected, 1, 'one candidate to rerun');
    assert.deepEqual(rc.reviews.map((j) => [j.judgment, j.reason]), [['JT', 'a sampling run is never renewed']]);

    // A rerun whose used field differs renews nothing.
    const diff = w(m, (tx) => recordRenewedRun(tx, { original: 'E1' as never, run: b.evidence('E1.win.a', win.identity, 'declared', { ...fields, out: 'h2' }) as never }));
    assert.deepEqual(diff.renewed, []);
    assert.deepEqual(diff.refused.map((r) => [r.judgment, r.reason, r.field]), [['J', 'field-differs', 'out'], ['JQ', 'field-differs', 'out']]);
    // Equal outputs (the timing differs, unused): renewed without a seat.
    const ok = w(m, (tx) => recordRenewedRun(tx, { original: 'E1' as never, run: b.evidence('E1.win', win.identity, 'declared', { ...fields, durationMs: '310' }) as never }));
    assert.deepEqual([...ok.renewed].sort(), ['J', 'JQ']);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['Q'])), { Q: 'proven' });
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P'])), { P: 'proven' }, 'its performance position rests on the older run until a new judgment');
    // A sampling run is never renewed, even with equal fields.
    w(m, (tx) => appendRecords(tx, [b.evidence('B2', win.identity, 'sampling', { exit: '0', 'time:wall': '7', [RUN_FIELD.candidate]: commit, [RUN_FIELD.command]: 'npm run bench', [RUN_FIELD.method]: RUN_METHOD })]));
    assert.deepEqual(
      w(m, (tx) => recordRenewal(tx, { judgment: 'JT' as never, original: 'B1' as never, replacement: 'B2' as never })),
      { renewed: false, reason: 'not-declared' },
    );
    // The Reviewer judges the performance position again, on a sampling run under the new identity.
    w(m, (tx) => appendRecords(tx, [b.judge('JT2', 'P', { evidence: ['B2'], bases: ['S.v1'], fields: ['exit', 'time:wall'], review: 'perf' })]));
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P'])), { P: 'proven' });
    assert.deepEqual(m.read((db) => renewalCandidates(db)).candidates, []);
    // Back on Linux: the renewed runs are from an older environment there (still counted); renew could rerun them.
    forgetObservedEnvironment(m.projectDir);
    currentEnvironment(m, { observe: machine('linux') });
    assert.deepEqual(m.read((db) => decisionLabels(db, ['Q'])), { Q: 'proven' });
    assert.deepEqual(m.read((db) => renewalCandidates(db)).candidates.map((c) => c.evidence), ['E1.win']);
  } finally {
    p.cleanup();
  }
});

test('a renewal rerun is a declared run under the current identity', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    w(m, (tx) => appendRecords(tx, [b.evidence('E1', 'old', 'declared')]));
    refused(() => w(m, (tx) => recordRenewedRun(tx, { original: 'E1' as never, run: b.evidence('E2', env, 'sampling') as never })), 'BAD_REQUEST', /declared run/);
    refused(() => w(m, (tx) => recordRenewedRun(tx, { original: 'E1' as never, run: b.evidence('E2', 'other-identity', 'declared') as never })), 'BAD_REQUEST', /current environment identity/);
    refused(() => w(m, (tx) => recordRenewedRun(tx, { original: 'E1' as never, run: b.evidence('E2', env, 'declared', { exit: '0' }, 'py') as never })), 'BAD_REQUEST', /current environment identity/);
    assert.equal(ENV_LINE, 'env');
  } finally {
    p.cleanup();
  }
});

test('the mechanical regression check counts only a declared run (5.6 with "declared")', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    const ok = { exit: '0', 'test:t1': 'passed', 'input:testfile:t/a.py': 'a'.repeat(64), 'input:runner:cfg': 'b'.repeat(64) };
    const coverage = (evidence: string) => ({
      kind: 'issue.coverage',
      issue: 'N',
      version: 'P',
      evidence,
      command: 'pytest',
      tests: m.data.putList(['t1']),
      inputs: m.data.putList([`testfile:t/a.py=${'a'.repeat(64)}`, `runner:cfg=${'b'.repeat(64)}`]),
    });
    w(m, (tx) => appendRecords(tx, [b.evidence('E1', env), b.product('P'), b.judge('J', 'P', { evidence: ['E1'] }), b.evidence('R', env, 'sampling', ok), coverage('R') as never]));
    assert.equal(m.read((db) => fixStates(db, [fixKey('N', 'P')])).states[fixKey('N', 'P')], 'unfixed', 'a sampling run does not count');
    w(m, (tx) => appendRecords(tx, [b.evidence('R2', env, 'declared', ok), coverage('R2') as never]));
    assert.equal(m.read((db) => fixStates(db, [fixKey('N', 'P')])).states[fixKey('N', 'P')], 'fixed');
    // 4.1.2: after an environment change the declared run still counts (older environment): the fix stays mechanically fixed.
    forgetObservedEnvironment(m.projectDir);
    currentEnvironment(m, { observe: machine('darwin') });
    assert.equal(m.read((db) => fixStates(db, [fixKey('N', 'P')])).states[fixKey('N', 'P')], 'fixed');
  } finally {
    p.cleanup();
  }
});

test('the working directory is part of a run\'s identity (cwd, missing = \'.\'): reuse, rerun checks and renewal match it', () => {
  // The rerun check: missing reads as the project root.
  const base = { exit: '0', [RUN_FIELD.candidate]: 'c'.repeat(40), [RUN_FIELD.command]: 'npm test', [RUN_FIELD.method]: RUN_METHOD };
  assert.equal(rerunMismatch(base, { ...base, [RUN_FIELD.cwd]: '.' }, true), null);
  assert.equal(rerunMismatch({ ...base, [RUN_FIELD.cwd]: 'pkg/a' }, { ...base, [RUN_FIELD.cwd]: 'pkg/a' }, true), null);
  assert.match(rerunMismatch({ ...base, [RUN_FIELD.cwd]: 'pkg/a' }, base, true) ?? '', /working directory/);
  assert.match(rerunMismatch(base, { ...base, [RUN_FIELD.cwd]: 'pkg/a' }, false) ?? '', /working directory/);
  const p = labelProject();
  try {
    const { m } = p;
    const linux = currentEnvironment(m, { observe: machine('linux') }).identity;
    const b = builders(m);
    w(m, (tx) => appendRecords(tx, [b.evidence('ROOT', linux, 'declared', base), b.evidence('SUB', linux, 'declared', { ...base, [RUN_FIELD.cwd]: 'pkg/a' })]));
    // Reuse: the same candidate and command in another directory is another run.
    const reuse = (cwd?: string) => m.read((db) => findReusableRun(db, { candidate: 'c'.repeat(40), command: 'npm test', ...(cwd !== undefined ? { cwd } : {}) }))?.evidence ?? null;
    assert.equal(reuse(), 'ROOT');
    assert.equal(reuse('.'), 'ROOT');
    assert.equal(reuse('pkg/a'), 'SUB');
    assert.equal(reuse('pkg/b'), null);
    // Renewal: a judgment on the run in pkg/a, after an environment change, is renewed only by a rerun in pkg/a.
    w(m, (tx) => appendRecords(tx, [b.product('P'), b.judge('J', 'P', { evidence: ['SUB'] })]));
    forgetObservedEnvironment(m.projectDir);
    const win = currentEnvironment(m, { observe: machine('win32') }).identity;
    const cand = m.read((db) => renewalCandidates(db)).candidates.find((c) => c.evidence === 'SUB');
    assert.equal(cand?.cwd, 'pkg/a');
    assert.equal(m.read((db) => renewalCandidates(db)).candidates.find((c) => c.evidence === 'ROOT'), undefined, 'no judgment rests on the root run');
    refused(() => w(m, (tx) => recordRenewedRun(tx, { original: 'SUB' as never, run: b.evidence('SUB.root', win, 'declared', base) as never })), 'BAD_REQUEST', /working directory/);
    refused(() => w(m, (tx) => appendRecords(tx, [b.evidence('SUB.b', win, 'declared', { ...base, [RUN_FIELD.cwd]: 'pkg/b' }), { kind: 'evidence.renewal', judgment: 'J', original: 'SUB', replacement: 'SUB.b' } as never])), 'RENEWAL_REFUSED', /working directory/);
    // 4.1.2: the run in pkg/a, from an older environment, still counts
    assert.equal(m.read((db) => decisionLabels(db, ['P'])).P, 'proven');
    const ok = w(m, (tx) => recordRenewedRun(tx, { original: 'SUB' as never, run: b.evidence('SUB.win', win, 'declared', { ...base, [RUN_FIELD.cwd]: 'pkg/a' }) as never }));
    assert.deepEqual(ok.renewed, ['J']);
    assert.equal(m.read((db) => decisionLabels(db, ['P'])).P, 'proven');
  } finally {
    p.cleanup();
  }
});

test('4.1.2: a run of an older run method never counts (invalidation by cause); a current-method run from an older environment does', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    const linux = currentEnvironment(m, { observe: machine('linux') }).identity;
    const commit = 'e'.repeat(40);
    const run = (method: string | null) => ({ exit: '0', [RUN_FIELD.candidate]: commit, [RUN_FIELD.command]: 'npm test', ...(method !== null ? { [RUN_FIELD.method]: method } : {}) });
    w(m, (tx) =>
      appendRecords(tx, [
        b.evidence('V2', linux, 'declared', run(RUN_METHOD)),
        b.evidence('V1', linux, 'declared', run('v1')),
        b.evidence('NONE', linux, 'declared', run(null)),
        b.product('P2', { commit }),
        b.judge('J2', 'P2', { evidence: ['V2'] }),
        b.product('P1', { commit }),
        b.judge('J1', 'P1', { evidence: ['V1'] }),
        b.product('P0', { commit }),
        b.judge('J0', 'P0', { evidence: ['NONE'] }),
      ]),
    );
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P2', 'P1', 'P0'])), { P2: 'proven', P1: 'not-fully-proven', P0: 'not-fully-proven' });
    forgetObservedEnvironment(m.projectDir);
    currentEnvironment(m, { observe: machine('win32') });
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P2', 'P1', 'P0'])), { P2: 'proven', P1: 'not-fully-proven', P0: 'not-fully-proven' });
  } finally {
    p.cleanup();
  }
});
