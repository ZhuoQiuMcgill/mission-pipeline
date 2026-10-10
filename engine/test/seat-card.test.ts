// Seat cards (4.2, 8.1), the program's rules for a handed-back result (8.1), the records a
// result becomes, the seat's login (7.1, 9.3), trees in the content store (6.2) and the model
// configuration (9.3, 6.5). Pure, no processes.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { validateRecord } from '../src/common/validate.ts';
import { sha256 } from '../src/common/hash.ts';
import { ContentStore } from '../src/ledger/content.ts';
import type { ExportManifest } from '../src/exec/export.ts';
import { cardTag, parseSeatCard, renderCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import { CredentialsUnusable, loginChanged, prepareCredentials } from '../src/seat/credentials.ts';
import { CONFIRMED_PRICES, DEFAULT_MODEL_CONFIG, DEFAULT_PRICES, ModelConfigError, SEAT_NAMES, boundPrices, parseModelConfig, resolvePrice, upperBoundMicros, usageMicros, withEverySeat, type ApiUsage, type ModelPrice } from '../src/seat/modelConfig.ts';
import { SEAT_HOST_MAIN, SEAT_STOP_GRACE_MS, seatUnitConfig } from '../src/seat/unit.ts';
import { DEFAULT_STOP_GRACE_MS } from '../src/exec/supervisor.ts';
import { citedEvidence, findingRecords, judgmentRecord, parseSeatResult, resultProblems, snapshotFiles, type ResultContext, type ReviewerResult } from '../src/seat/results.ts';
import { readTree, restoreTree, storeExportedTree } from '../src/seat/tree.ts';
import type { LaunchId } from '../src/common/ids.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-seat-card-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const H = (c: string): string => c.repeat(64);
const LIMITS = { run: { memoryMax: 256 << 20 }, areaBytes: 64 << 20, export: { maxLogicalBytes: 1 << 20, maxFiles: 100 }, recoveryStateBytes: 8 << 20 };
const COMMON = {
  format: 'mp4.seat-card.v1',
  launch: 'L1',
  mission: 'M1',
  module: 'mod-a',
  capabilities: ['net'],
  duties: 'Implement the parser.',
  decisionQuotes: ['"keep it small"'],
  constraints: [{ id: 'K1', text: 'no new dependencies', kind: 'object' }],
  workspace: { snapshot: '/tmp/snap', writablePaths: ['src'] },
  limits: LIMITS,
};

function constructorCard(over: Record<string, unknown> = {}): ConstructorCard {
  return parseSeatCard({
    ...COMMON,
    seat: 'constructor',
    goal: 'Parse the header.',
    standards: [
      { id: 'S1', text: 'parses valid headers' },
      { id: 'S2', text: 'rejects bad ones' },
    ],
    requirementItems: [{ id: 'R1', text: 'header format v2' }],
    readableFiles: ['README'],
    interpreter: 'node 22',
    verificationCommands: [{ id: 'test', command: 'npm test' }],
    interfaces: { implements: [{ name: 'parse', definition: '(s: string) => Header' }], calls: [] },
    ...over,
  }) as ConstructorCard;
}

function reviewerCard(over: Record<string, unknown> = {}): ReviewerCard {
  return parseSeatCard({
    ...COMMON,
    seat: 'reviewer',
    workspace: { snapshot: '/tmp/snap', writablePaths: [] },
    target: 'obj-v3',
    review: 'rev-1',
    standards: [
      { id: 'S1', text: 'parses valid headers' },
      { id: 'S2', text: 'rejects bad ones' },
    ],
    interfaces: [],
    candidate: { changedPaths: ['src/parse.ts'] },
    verificationRuns: [
      { evidence: 'E1', command: 'npm test', summary: '12 passed' },
      { evidence: 'E2', command: 'npm run lint', summary: 'clean' },
    ],
    declaredCommands: [{ id: 'test', command: 'npm test' }],
    selfReportedGaps: [{ id: 'G1', text: 'no fuzzing' }],
    openIssues: [{ issue: 'I7', text: 'crash on empty input' }],
    binding: {
      judgment: 'J1',
      bases: { hash: H('a'), count: 1 },
      constraints: { hash: H('b'), count: 1 },
      reliesOn: { hash: H('c'), count: 0 },
      revokes: null,
      extends: null,
      evidenceUse: { fields: ['passed'], statisticalOrExternal: false },
      superseded: [],
    },
    ...over,
  }) as ReviewerCard;
}

/** A candidate snapshot as the pointer checker sees it: src/parse.ts has 60 lines. */
const CTX: ResultContext = { snapshot: { lines: (p) => (p === 'src/parse.ts' ? 60 : null) } };

const goodReview = (): ReviewerResult => ({
  judgments: [
    { standard: 'S1', met: 'yes', reason: 'tests pass', evidence: ['evidence:E1'] },
    { standard: 'S2', met: 'no', reason: 'accepts junk', evidence: ['file:src/parse.ts:40', 'evidence:E1'] },
  ],
  gap_responses: [{ gap: 'G1', response: 'acceptable for now' }],
  issue_responses: [{ issue: 'I7', response: 'fixed', reason: 'guard added' }],
  findings: ['the error message leaks the path'],
  verdict: 'rework',
});

describe('seat cards', () => {
  test('a Constructor card parses and renders as its first message', () => {
    const c = constructorCard();
    const text = renderCard(c);
    for (const s of ['Parse the header.', '[S1] parses valid headers', '[R1] header format v2', '- src', '[test] npm test', 'parse: (s: string) => Header', '[K1] no new dependencies', 'submit_result']) {
      assert.ok(text.includes(s), s);
    }
    assert.deepEqual(cardTag(c), { mission: 'M1', capabilities: ['net'], module: 'mod-a' });
  });

  test('a Reviewer card renders every gap, issue and verification run to answer', () => {
    const text = renderCard(reviewerCard());
    for (const s of ['obj-v3', '[E1] npm test: 12 passed', '[G1] no fuzzing', '[I7] crash on empty input', '[test] npm test']) assert.ok(text.includes(s), s);
  });

  test('a Reviewer writes no file: scratch paths for its commands instead of writable paths', () => {
    const c = reviewerCard({ workspace: { snapshot: '/tmp/snap', writablePaths: [], scratchPaths: ['.', 'build'] } });
    assert.deepEqual(c.workspace.scratchPaths, ['.', 'build']);
    assert.ok(renderCard(c).includes('Scratch paths'));
    assert.ok(!renderCard(reviewerCard()).includes('Scratch paths'), 'no scratch, no section');
    assert.throws(() => reviewerCard({ workspace: { snapshot: '/tmp/snap', writablePaths: ['src'] } }), /no writable paths/);
  });

  test('malformed cards are refused', () => {
    assert.throws(() => constructorCard({ launch: '../x' }));
    assert.throws(() => constructorCard({ standards: [] }));
    assert.throws(() => constructorCard({ workspace: { snapshot: 'relative', writablePaths: [] } }));
    assert.throws(() => reviewerCard({ binding: { judgment: 'J1' } }));
    assert.throws(() => parseSeatCard({ ...COMMON, seat: 'architect' }));
  });
});

describe('handed-back results (8.1 program rules)', () => {
  test('Constructor: four notes; an unmet standard must be on the card', () => {
    const c = constructorCard();
    const ok = { done: 'implemented', unmet_standards: [{ standard: 'S2', why: 'needs a decision' }], unfixed_problems: [], decisions_needed: ['more memory?'] };
    assert.deepEqual(resultProblems(c, ok, CTX), []);
    assert.deepEqual(parseSeatResult(c, ok), { seat: 'constructor', result: ok });
    assert.match(resultProblems(c, { ...ok, unmet_standards: [{ standard: 'S9', why: 'x' }] }, CTX).join(), /S9/);
    assert.ok(resultProblems(c, { done: '' }, CTX).length > 0);
  });

  test('Reviewer: one judgment per standard, valid pointers, every gap and issue answered, pass only when all met', () => {
    const c = reviewerCard();
    assert.deepEqual(resultProblems(c, goodReview(), CTX), []);
    const bad = (f: (r: ReviewerResult) => ReviewerResult): string => resultProblems(c, f(goodReview()), CTX).join(' | ');
    assert.match(bad((r) => ({ ...r, judgments: r.judgments.slice(0, 1) })), /"S2" is not judged/);
    assert.match(bad((r) => ({ ...r, judgments: [...r.judgments, r.judgments[0]!] })), /judged 2 times/);
    assert.match(bad((r) => ({ ...r, judgments: [...r.judgments, { standard: 'S9', met: 'yes', reason: '', evidence: [] }] })), /"S9" is not a standard/);
    assert.match(bad((r) => ({ ...r, judgments: [{ ...r.judgments[0]!, evidence: ['evidence:E9'] }, r.judgments[1]!] })), /E9 is not a verification run/);
    assert.match(bad((r) => ({ ...r, judgments: [{ ...r.judgments[0]!, evidence: ['see above'] }, r.judgments[1]!] })), /neither evidence/);
    assert.match(bad((r) => ({ ...r, gap_responses: [] })), /gap "G1" is not answered/);
    assert.match(bad((r) => ({ ...r, issue_responses: [] })), /issue "I7" has no response/);
    assert.match(bad((r) => ({ ...r, verdict: 'pass' })), /"pass" leaves a standard/);
  });

  test('finding 14: every judgment gives a reason and valid evidence pointers; empty or forged evidence is refused', () => {
    const c = reviewerCard();
    const allYes = (evidence: string[], reason = 'checked'): ReviewerResult => ({
      ...goodReview(),
      judgments: [
        { standard: 'S1', met: 'yes', reason, evidence },
        { standard: 'S2', met: 'yes', reason, evidence },
      ],
      verdict: 'pass',
    });
    const problems = (r: ReviewerResult): string => resultProblems(c, r, CTX).join(' | ');
    // the reviewer's repro: every standard "yes", no reason, no evidence -> accepted before; refused now
    assert.match(problems(allYes([], '')), /cite at least one evidence pointer/);
    assert.match(problems(allYes([], '')), /give the reason/);
    assert.match(problems(allYes(['file:src/nope.ts:1'])), /src\/nope\.ts is not a file of the candidate snapshot/);
    assert.match(problems(allYes(['file:src/parse.ts:61'])), /lines 61 are not inside src\/parse\.ts \(60 lines\)/);
    assert.match(problems(allYes(['file:src/parse.ts:0'])), /not inside/);
    assert.match(problems(allYes(['file:src/parse.ts:30-20'])), /not inside/);
    assert.match(problems(allYes(['file:../etc/passwd:1'])), /normalized path inside the snapshot/);
    assert.match(problems(allYes(['file:src/../../x:1'])), /normalized path inside the snapshot/);
    assert.match(problems(allYes(['file:.git/config:1'])), /normalized path inside the snapshot/);
    assert.match(problems(allYes(['evidence:E3'])), /E3 is not a verification run on the card/);
    assert.deepEqual(resultProblems(c, allYes(['file:src/parse.ts:1-60', 'evidence:E2']), CTX), []);
    assert.deepEqual(resultProblems(c, allYes(['file:src/parse.ts']), CTX), [], 'a whole-file pointer to an existing file');
  });

  test('finding 14: pointers are checked against the real snapshot without following links', () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'src'), { recursive: true });
    writeFileSync(join(snap, 'src', 'a.ts'), 'one\ntwo\nthree');
    writeFileSync(join(snap, 'src', 'empty.ts'), '');
    writeFileSync(join(root, 'outside.ts'), 'x\n'.repeat(100));
    symlinkSync(join(root, 'outside.ts'), join(snap, 'src', 'link.ts'));
    symlinkSync(root, join(snap, 'up'));
    const files = snapshotFiles(snap);
    assert.equal(files.lines('src/a.ts'), 3, 'a last line without a newline counts');
    assert.equal(files.lines('src/empty.ts'), 0);
    assert.equal(files.lines('src/link.ts'), null, 'a symlink is not a snapshot file');
    assert.equal(files.lines('up/outside.ts'), null, 'nor a path through a symlinked directory');
    assert.equal(files.lines('src'), null, 'nor a directory');
    assert.equal(files.lines('src/missing.ts'), null);
    const c = reviewerCard();
    const ctx: ResultContext = { snapshot: files };
    const r: ReviewerResult = { ...goodReview(), judgments: [
      { standard: 'S1', met: 'yes', reason: 'r', evidence: ['file:src/a.ts:3'] },
      { standard: 'S2', met: 'no', reason: 'r', evidence: ['file:up/outside.ts:50'] },
    ] };
    assert.match(resultProblems(c, r, ctx).join(' | '), /up\/outside\.ts is not a file of the candidate snapshot/);
    assert.match(resultProblems(c, { ...r, judgments: [r.judgments[0]!, { ...r.judgments[1]!, evidence: ['file:src/empty.ts:1'] }] }, ctx).join(), /not inside src\/empty\.ts \(0 lines\)/);
  });

  test('the judgment record carries the card binding, the verdict and the cited runs', () => {
    const c = reviewerCard();
    const r = goodReview();
    assert.deepEqual(citedEvidence(c, r), ['E1']);
    const rec = judgmentRecord(c, r, { hash: H('d'), count: 1 } as never);
    validateRecord(rec);
    assert.equal(rec.verdict, 'fail');
    assert.equal(rec.judgment, 'J1');
    assert.equal(rec.target, 'obj-v3');
    assert.deepEqual(rec.issues, [{ issue: 'I7', response: 'fixed' }]);
    assert.equal(judgmentRecord(c, { ...r, verdict: 'needs-decision' }, { hash: H('d'), count: 1 } as never).verdict, 'undecided');
  });

  test('findings become issue records whose id leads to the words', () => {
    const content = new ContentStore(join(tmp(), 'content'));
    mkdirSync(content.root); // fan-out directories on demand (put creates them): no 65,536-inode layout per test
    const c = reviewerCard();
    const [rec] = findingRecords(c, goodReview(), content, 'L1' as LaunchId);
    assert.ok(rec !== undefined);
    validateRecord(rec);
    assert.match(rec.issue, /^finding:[0-9a-f]{64}$/);
    assert.equal(rec.text, rec.issue.slice('finding:'.length), 'the record names its text');
    const doc = JSON.parse(content.get(rec.issue.slice('finding:'.length) as never).toString('utf8')) as { text: string; target: string };
    assert.equal(doc.text, 'the error message leaks the path');
    assert.deepEqual(content.getList(rec.observedOn), ['obj-v3']);
    assert.equal(rec.module, 'mod-a');
    assert.deepEqual(findingRecords(c, { ...goodReview(), findings: [] }, content, 'L1' as LaunchId), []);
  });
});

describe('the seat login', () => {
  const NOW = 1_800_000_000_000;
  function creds(expiresAt: number | undefined): string {
    const d = tmp();
    const p = join(d, '.credentials.json');
    writeFileSync(
      p,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-A', refreshToken: 'ref-A', refreshTokenExpiresAt: 1, ...(expiresAt !== undefined ? { expiresAt } : {}), scopes: ['user:inference'] },
        mcpOAuth: { srv: { accessToken: 'mcp-secret' } },
        pluginLogins: { x: 'y' },
      }),
    );
    return p;
  }

  test('subscription: only the claudeAiOauth entry is copied, private to the user', () => {
    const seed = tmp();
    const r = prepareCredentials({ kind: 'subscription', source: creds(NOW + 3_600_000), minLifetimeMs: 600_000 }, seed, NOW);
    assert.deepEqual(r.env, {});
    assert.equal(r.seedFile, join(seed, '.credentials.json'));
    const copied = JSON.parse(readFileSync(join(seed, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(copied), ['claudeAiOauth']);
    assert.deepEqual(Object.keys(copied['claudeAiOauth'] as object).sort(), ['accessToken', 'expiresAt', 'scopes'], 'no refresh token: the seat cannot rotate the login');
    assert.ok(!readFileSync(join(seed, '.credentials.json'), 'utf8').includes('mcp-secret'));
    assert.equal(statSync(join(seed, '.credentials.json')).mode & 0o777, 0o600);
  });

  test('subscription: a token that expires before the seat could end is refused (refresh-rotation hazard)', () => {
    const seed = tmp();
    assert.throws(() => prepareCredentials({ kind: 'subscription', source: creds(NOW + 60_000), minLifetimeMs: 600_000 }, seed, NOW), CredentialsUnusable);
    assert.throws(() => prepareCredentials({ kind: 'subscription', source: creds(undefined), minLifetimeMs: 600_000 }, seed, NOW), CredentialsUnusable);
    assert.throws(() => prepareCredentials({ kind: 'subscription', source: join(seed, 'missing.json'), minLifetimeMs: 0 }, seed, NOW), CredentialsUnusable);
    assert.equal(existsSync(join(seed, '.credentials.json')), false);
  });

  test('api key: from the named variable into the Claude Code environment only', () => {
    process.env['MP_TEST_SEAT_KEY'] = 'sk-test';
    try {
      const seed = tmp();
      assert.deepEqual(prepareCredentials({ kind: 'api-key', variable: 'MP_TEST_SEAT_KEY' }, seed).env, { ANTHROPIC_API_KEY: 'sk-test' });
      assert.throws(() => prepareCredentials({ kind: 'api-key', variable: 'MP_TEST_SEAT_KEY_UNSET' }, seed), CredentialsUnusable);
    } finally {
      delete process.env['MP_TEST_SEAT_KEY'];
    }
  });

  test('a refresh inside the seat is noticed', () => {
    const seed = tmp();
    const r = prepareCredentials({ kind: 'subscription', source: creds(NOW + 3_600_000), minLifetimeMs: 0 }, seed, NOW);
    assert.equal(loginChanged(r.seedFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-A' } })), false);
    assert.equal(loginChanged(r.seedFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-B' } })), true);
    assert.equal(loginChanged(null, 'x'), false);
  });
});

describe('trees in the content store (export, transcript, recovery state)', () => {
  test('a stored tree restores its files; symlinks stay entries; escaping paths are refused', () => {
    const content = new ContentStore(join(tmp(), 'content'));
    mkdirSync(content.root); // fan-out directories on demand (put creates them): no 65,536-inode layout per test
    const src = tmp();
    mkdirSync(join(src, 'projects', '-'), { recursive: true });
    writeFileSync(join(src, 'projects', '-', 's1.jsonl'), '{"a":1}\n');
    writeFileSync(join(src, '.claude.json'), '{}');
    symlinkSync('/etc/passwd', join(src, 'link'));
    const file = (path: string, data: string) => ({ path, kind: 'file' as const, mode: 0o644, size: Buffer.byteLength(data), sha256: sha256(data), target: null });
    const manifest: ExportManifest = {
      entries: [
        { path: 'projects', kind: 'dir', mode: 0o755, size: 0, sha256: null, target: null },
        { path: 'projects/-', kind: 'dir', mode: 0o755, size: 0, sha256: null, target: null },
        file('projects/-/s1.jsonl', '{"a":1}\n'),
        file('.claude.json', '{}'),
        { path: 'link', kind: 'symlink', mode: 0o777, size: 11, sha256: null, target: '/etc/passwd' },
      ],
      logicalBytes: 21,
      skipped: [],
    };
    const hash = storeExportedTree(content, src, manifest);
    assert.equal(readTree(content, hash).entries.length, 5);
    const dest = tmp();
    assert.equal(restoreTree(content, hash, dest), 2);
    assert.equal(readFileSync(join(dest, 'projects', '-', 's1.jsonl'), 'utf8'), '{"a":1}\n');
    assert.equal(existsSync(join(dest, 'link')), false);

    const evil = content.put(JSON.stringify({ format: 'mp4.tree.v1', entries: [{ path: '../escape', kind: 'file', mode: 0o644, size: 1, hash: content.put('x'), target: null }] }));
    assert.throws(() => restoreTree(content, evil, tmp()), /bad tree path/);
    assert.throws(() => readTree(content, content.put('{"format":"other"}')), /not a tree/);
  });
});

describe('the seat unit (6.2, 7.1)', () => {
  test('a seat unit starts the seat host and gets the longer stop grace; program runs keep theirs', () => {
    const cfg = seatUnitConfig({
      launch: 'L1' as LaunchId,
      stateDir: '/tmp/state',
      hostConfigPath: '/tmp/state/host.json',
      unit: { memoryMax: 1 << 30, pidsMax: 512 },
      sink: { module: '/x/ledgerSink.ts' },
      env: { PATH: '/usr/bin' },
      cwd: '/tmp/state',
    });
    assert.equal(cfg.stopGraceMs, SEAT_STOP_GRACE_MS);
    assert.equal(SEAT_STOP_GRACE_MS, 30_000);
    assert.equal(DEFAULT_STOP_GRACE_MS, 10_000);
    assert.deepEqual(cfg.host.argv.slice(-2), [SEAT_HOST_MAIN, '/tmp/state/host.json']);
    assert.ok(SEAT_HOST_MAIN.endsWith('/src/seat/host-main.ts') && existsSync(SEAT_HOST_MAIN));
    assert.equal(seatUnitConfig({ ...{ launch: 'L1' as LaunchId, stateDir: '/s', hostConfigPath: '/h', unit: { memoryMax: 1 << 30 }, sink: { module: '/m' }, env: {}, cwd: '/' }, stopGraceMs: 45_000 }).stopGraceMs, 45_000);
  });
});

describe('model configuration (9.3, 6.5)', () => {
  test('a file names seats; its prices are merged over the defaults', () => {
    const cfg = parseModelConfig({
      format: 'mp4.model-config.v1',
      seats: { constructor: { provider: 'anthropic', model: 'claude-haiku-5-5', maxOutputTokens: 1000 } },
      metering: { prices: { 'my-model': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2 } } },
    });
    assert.equal(cfg.seats['constructor']?.model, 'claude-haiku-5-5');
    assert.ok(cfg.metering.prices['my-model'] !== undefined);
    assert.deepEqual(cfg.metering.prices['claude-haiku-5-5'], DEFAULT_PRICES['claude-haiku-5-5']);
    assert.equal(cfg.metering.toolOverheadTokens, 4096);
    assert.deepEqual([...CONFIRMED_PRICES], ['claude-haiku-5-5'], 'every other default price awaits confirmation');
    assert.throws(() => parseModelConfig({ format: 'mp4.model-config.v1', seats: { constructor: { provider: 'openai', model: 'x' } } }));
    assert.throws(() => parseModelConfig({ format: 'mp4.model-config.v1', seats: { constructor: { provider: 'anthropic', model: 'x', effort: 'extreme' } } }));
  });

  test('finding 11: the bound takes the dearest of EVERY input tier; a legal config can no longer settle above its bound', () => {
    // the reviewer's config: cache reads priced 100x plain input
    const cfg = parseModelConfig({
      format: 'mp4.model-config.v1',
      seats: { constructor: { provider: 'anthropic', model: 'test' } },
      metering: { toolOverheadTokens: 0, prices: { test: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 100, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2 } } },
    });
    const bound = upperBoundMicros(cfg, 'test', 1000, 1);
    const actual = usageMicros(cfg, 'test', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 0 });
    assert.equal(actual, 10_000);
    assert.ok(bound >= actual, `bound ${bound} >= actual ${actual}`);
    // worst case for a 1000-byte request: every byte a token at the dearest tier
    const worst = usageMicros(cfg, 'test', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 1 });
    assert.ok(bound >= worst, `bound ${bound} >= ${worst}`);
    const p = (o: Partial<ModelPrice>): ModelPrice => ({ inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0.1, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2, ...o });
    assert.equal(boundPrices(p({})).input, 2, '1-hour cache write');
    assert.equal(boundPrices(p({ cacheWrite5mMultiplier: 3 })).input, 3, '5-minute cache write when dearer');
    assert.equal(boundPrices(p({ cacheReadPerMTok: 7 })).input, 7, 'cache read when dearer');
    assert.equal(boundPrices(p({ longContext: { aboveInputTokens: 10, inputPerMTok: 2, outputPerMTok: 9, cacheReadPerMTok: 0.2 } })).input, 4, 'long-context cache write');
    assert.equal(boundPrices(p({ longContext: { aboveInputTokens: 10, inputPerMTok: 0.5, outputPerMTok: 9, cacheReadPerMTok: 11 } })).input, 11, 'long-context cache read');
    assert.equal(boundPrices(p({ longContext: { aboveInputTokens: 10, inputPerMTok: 0.5, outputPerMTok: 9, cacheReadPerMTok: 0.2 } })).output, 9);
  });

  test('finding 11: price configurations are validated on load', () => {
    const base = (price: unknown, seats: unknown = { constructor: { provider: 'anthropic', model: 'm' } }) => ({ format: 'mp4.model-config.v1', seats, metering: { prices: { m: price } } });
    const ok = { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0.1, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2 };
    assert.ok(parseModelConfig(base(ok)).metering.prices['m']);
    for (const [what, bad] of [
      ['a negative price', { ...ok, inputPerMTok: -1 }],
      ['an infinite price', { ...ok, outputPerMTok: Infinity }],
      ['NaN', { ...ok, cacheReadPerMTok: Number.NaN }],
      ['a cache-write multiplier below 1', { ...ok, cacheWrite5mMultiplier: 0.5 }],
      ['a missing tier', { inputPerMTok: 1, outputPerMTok: 1, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2 }],
      ['an unknown key', { ...ok, cacheWrite24hMultiplier: 3 }],
      ['a long-context tier without its threshold', { ...ok, longContext: { inputPerMTok: 2, outputPerMTok: 2, cacheReadPerMTok: 0.2 } }],
    ] as const) {
      assert.throws(() => parseModelConfig(base(bad)), ModelConfigError, what);
    }
    assert.throws(() => parseModelConfig(base(ok, { constructor: { provider: 'anthropic', model: 'unpriced-model' } })), /has no price/);
  });
});

describe('every Claude model is priced (resolvePrice)', () => {
  const as = (model: string): string | null => resolvePrice(DEFAULT_PRICES, model)?.pricedAs ?? null;

  test('exact ids, dated snapshots, -v1, [1m], @date and case resolve to their table entry', () => {
    assert.equal(as('claude-opus-5-5'), 'claude-opus-5-5');
    assert.deepEqual(resolvePrice(DEFAULT_PRICES, 'claude-opus-5-5')?.price, DEFAULT_PRICES['claude-opus-5-5']);
    for (const [id, entry] of [
      ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
      ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
      ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
      ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
      ['claude-opus-4-20250514', 'claude-opus-4'],
      ['claude-3-5-haiku-20241022', 'claude-3-5-haiku'],
      ['claude-3-5-sonnet-20241022-v2', 'claude-3-5-sonnet'],
      ['claude-opus-4-1-20250805-v1:0', 'claude-opus-4-1'],
      ['claude-opus-4-6-v1', 'claude-opus-4-6'],
      ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
      ['claude-sonnet-4-5-20250929[1m]', 'claude-sonnet-4-5'],
      ['claude-opus-4-1@20250805', 'claude-opus-4-1'],
      ['Claude-Opus-5-5', 'claude-opus-5-5'],
    ] as const) {
      assert.equal(as(id), entry, id);
    }
  });

  test('aliases price as the dearest of their family; an unknown family member too; an unknown claude id as the dearest of all', () => {
    for (const f of ['opus', 'sonnet', 'haiku', 'fable', 'mythos']) {
      assert.equal(as(f), `family:${f}`, f);
      assert.equal(as(`${f}[1m]`), `family:${f}`, `${f}[1m]`);
    }
    assert.equal(as('claude-opus-6'), 'family:opus');
    assert.equal(as('claude-opus-6-20270101'), 'family:opus');
    assert.equal(as('claude-3-opus'), 'family:opus');
    assert.equal(as('claude-haiku-3-5'), 'family:haiku');
    assert.equal(as('claude-mythos-preview'), 'family:mythos');
    assert.equal(as('claude-foo-1'), 'family:any-claude');
    const opus = resolvePrice(DEFAULT_PRICES, 'opus')!.price;
    assert.deepEqual([opus.inputPerMTok, opus.outputPerMTok, opus.cacheReadPerMTok], [15, 75, 1.5], 'the dearest opus entry, field by field');
    const any = resolvePrice(DEFAULT_PRICES, 'claude-foo-1')!.price;
    assert.deepEqual([any.inputPerMTok, any.outputPerMTok, any.cacheReadPerMTok], [15, 75, 1.5]);
  });

  test('a non-Claude id is not priced', () => {
    for (const id of ['gpt-5', 'gpt-6-astra', 'o3', 'best', 'opusplan', 'unknown-model', 'toString', '__proto__', '']) assert.equal(resolvePrice(DEFAULT_PRICES, id), null, id);
    assert.throws(() => upperBoundMicros(DEFAULT_MODEL_CONFIG, 'gpt-5', 1, 1), RangeError);
    assert.throws(() => usageMicros(DEFAULT_MODEL_CONFIG, 'gpt-5', {}), RangeError);
  });

  test('the older models carry the public prices; none of them is marked confirmed', () => {
    const fields = (m: string): number[] => {
      const p = DEFAULT_PRICES[m]!;
      return [p.inputPerMTok, p.outputPerMTok, p.cacheReadPerMTok];
    };
    assert.deepEqual(fields('claude-opus-4-5'), [5, 25, 0.5]);
    for (const m of ['claude-opus-4-1', 'claude-opus-4-0', 'claude-opus-4']) assert.deepEqual(fields(m), [15, 75, 1.5], m);
    for (const m of ['claude-sonnet-4-5', 'claude-sonnet-4-0', 'claude-sonnet-4']) {
      assert.deepEqual(fields(m), [3, 15, 0.3], m);
      assert.deepEqual(DEFAULT_PRICES[m]!.longContext, { aboveInputTokens: 200_000, inputPerMTok: 6, outputPerMTok: 22.5, cacheReadPerMTok: 0.6 }, m);
    }
    for (const m of ['claude-3-7-sonnet', 'claude-3-5-sonnet']) assert.deepEqual(fields(m), [3, 15, 0.3], m);
    assert.deepEqual(fields('claude-3-5-haiku'), [0.8, 4, 0.08]);
    assert.deepEqual(fields('claude-3-haiku'), [0.25, 1.25, 0.03]);
    assert.deepEqual(fields('claude-mythos-5'), [10, 50, 1]);
    assert.deepEqual([...CONFIRMED_PRICES], ['claude-haiku-5-5']);
  });

  test('conservative: a family (and any-claude) price is never cheaper than any member, for the bound and for the settlement', () => {
    const usages: ApiUsage[] = [
      { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 250, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 } },
      { input_tokens: 150_000, output_tokens: 10 }, // above the haiku long-context threshold, below sonnet's
      { input_tokens: 250_000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 4000 }, // above every threshold
      { cache_creation_input_tokens: 1000 },
    ];
    const families = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];
    for (const [synthetic, members] of [
      ...families.map((f) => [f, Object.keys(DEFAULT_PRICES).filter((k) => k.split('-').includes(f))] as const),
      ['claude-foo-1', Object.keys(DEFAULT_PRICES)] as const,
    ]) {
      assert.ok(members.length > 0, synthetic);
      for (const m of members) {
        for (const [bytes, max] of [[1000, 100], [500_000, null], [0, 64_000]] as const) {
          const sb = upperBoundMicros(DEFAULT_MODEL_CONFIG, synthetic, bytes, max);
          const mb = upperBoundMicros(DEFAULT_MODEL_CONFIG, m, bytes, max);
          assert.ok(sb >= mb, `bound of ${synthetic} ${sb} >= ${m} ${mb}`);
        }
        for (const u of usages) {
          const su = usageMicros(DEFAULT_MODEL_CONFIG, synthetic, u);
          const mu = usageMicros(DEFAULT_MODEL_CONFIG, m, u);
          assert.ok(su >= mu, `settlement of ${synthetic} ${su} >= ${m} ${mu} for ${JSON.stringify(u)}`);
        }
      }
    }
  });

  test('model_config.json takes aliases and dated ids and refuses a non-Claude model with the accepted forms', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'sonnet[1m]', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022', 'claude-opus-6']) {
      assert.equal(parseModelConfig({ format: 'mp4.model-config.v1', seats: { architect: { provider: 'anthropic', model } } }).seats['architect']?.model, model, model);
    }
    assert.throws(
      () => parseModelConfig({ format: 'mp4.model-config.v1', seats: { architect: { provider: 'anthropic', model: 'gpt-5' } } }),
      /the architect seat's model "gpt-5" has no price: a seat model is any Claude model id \(claude-\.\.\.\), a dated snapshot .*or an alias: opus, sonnet, haiku, fable/,
    );
    // a file's own price for an id still wins over the family fallback
    const own = parseModelConfig({
      format: 'mp4.model-config.v1',
      seats: { architect: { provider: 'anthropic', model: 'claude-opus-6' } },
      metering: { prices: { 'claude-opus-6': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2 } } },
    });
    assert.equal(resolvePrice(own.metering.prices, 'claude-opus-6')?.pricedAs, 'claude-opus-6');
  });

  test('withEverySeat sets every default seat and any other seat the file names, keeping the rest', () => {
    const raw = { format: 'mp4.model-config.v1', seats: { reviewer: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'max', maxOutputTokens: 1000 }, legacy: { provider: 'anthropic', model: 'claude-opus-5' } }, metering: { toolOverheadTokens: 10 } };
    const doc = withEverySeat(raw, { model: 'sonnet' });
    const seats = doc['seats'] as Record<string, { model: string; effort?: string; maxOutputTokens?: number }>;
    assert.deepEqual(Object.keys(seats), [...SEAT_NAMES, 'legacy']);
    for (const s of Object.values(seats)) assert.equal(s.model, 'sonnet');
    assert.deepEqual(seats['reviewer'], { provider: 'anthropic', model: 'sonnet', effort: 'max', maxOutputTokens: 1000 }, 'its own effort and cap kept');
    assert.deepEqual(seats['architect'], { provider: 'anthropic', model: 'sonnet', effort: 'high', maxOutputTokens: 32_000 }, 'an unnamed seat starts from the default seat');
    assert.deepEqual(doc['metering'], { toolOverheadTokens: 10 });
    assert.doesNotThrow(() => parseModelConfig(doc));
  });
});
