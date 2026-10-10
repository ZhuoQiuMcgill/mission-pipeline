// Design 7.1 tool profiles, 2 seats, 9.4 model per seat, end to end through the seat host:
// one launch per profile in a real execution unit (transient systemd service + unit supervisor
// + seat host), a real ledger service, Claude Code inside its enclosure, and a scripted fake
// model behind the real metering proxy. The card kinds are the fixture kinds of
// test/seat-fixture-cards.ts (loaded into the host through its test-only cardModules config),
// one per profile on different seats, plus one real registry kind (researcher-reader).
//
// Checked per profile: the seat gets exactly its tools, its kind's definition and card; the
// model is the one model_config.json names for the kind's seat (or the default); the hand-back
// is checked by the program (the must-read list, the kind's own rules) and refused back to the
// seat; the accepted hand-back's records arrive as pending results under the launch; a
// 'materials' seat runs without any sandbox; fetch_url reaches only the card's addresses, each
// fetch authorized by the ledger and recorded as evidence, a refusal raising a WI notice.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type { ContentHash, LaunchId, MissionId } from '../src/common/ids.ts';
import type { EvidenceRecord, IssueRecord, RunLayerRecord, SeatResultRecord } from '../src/common/records.ts';
import { readAlerts } from '../src/exec/alerts.ts';
import { checkTerminationProof } from '../src/exec/acceptance.ts';
import { MATERIAL_PAGE_BYTES } from '../src/seat/cards/common.ts';
import { fixtureDefinition } from './seat-fixture-cards.ts';
import type { FakeModel, FakeRequest } from './seat-fakemodel.ts';
import { SeatHarness, UNIT_SKIP, recordsOf, type RunOptions, type UnitRun } from './seat-harness.ts';

const FIXTURES = fileURLToPath(new URL('./seat-fixture-cards.ts', import.meta.url));
const h = new SeatHarness();
let modelConfig = '';

before(async () => {
  await h.start();
  // per seat of design 2 (9.4); crititor and auditor are left to the default configuration
  modelConfig = join(h.tmp('mp-seat-models-'), 'model_config.json');
  const m = (model: string) => ({ provider: 'anthropic', model, maxOutputTokens: 1000 });
  writeFileSync(
    modelConfig,
    JSON.stringify({
      format: 'mp4.model-config.v1',
      seats: { secretary: m('claude-sonnet-5-5'), architect: m('claude-haiku-4-5'), researcher: m('claude-haiku-5-5'), constructor: m('claude-haiku-5-5') },
    }),
  );
});
after(async () => {
  await h.close();
});

const run = (o: RunOptions): Promise<UnitRun> => h.run({ modelConfig, ...o, hostConfig: { cardModules: [FIXTURES], ...o.hostConfig } });
const diag = (r: UnitRun): string => `${r.outcome?.reason ?? ''}\n${h.diag(r.state, r.launch)}`;
const fakeOf = (r: UnitRun): FakeModel => {
  assert.ok(r.fake !== null);
  return r.fake;
};
const mains = (r: UnitRun): FakeRequest[] => fakeOf(r).requests.filter((q) => q.main);
/** The program tools a request offered (Claude Code lists them sorted). */
const toolsOf = (q: FakeRequest): string[] => q.toolNames.map((n) => n.replace(/^mcp__program__/, '')).sort();
const sorted = (names: string[]): string[] => [...names].sort();
const tool = (name: string, input: unknown) => ({ kind: 'tool' as const, name: `mcp__program__${name}`, input });
const DONE = { kind: 'text' as const, text: 'Done.' };

function seatResultOf(r: UnitRun): SeatResultRecord {
  const all = recordsOf(r, 'seat.result') as SeatResultRecord[];
  assert.equal(all.length, 1, JSON.stringify(all));
  return all[0] as SeatResultRecord;
}

const LIMITS = {
  run: { memoryMax: 256 << 20, pidsMax: 256, timeoutMs: 60_000 },
  areaBytes: 64 << 20,
  export: { maxLogicalBytes: 1 << 20, maxFiles: 200 },
  recoveryStateBytes: 32 << 20,
  maxTurns: 14,
  wallClockMs: 120_000,
};

function common(kind: string, launch: LaunchId, mission: MissionId): Record<string, unknown> {
  return {
    format: 'mp4.seat-card.v1',
    seat: kind,
    launch,
    mission,
    module: 'greeter',
    capabilities: [],
    duties: `Fixture duties for ${kind}.`,
    decisionQuotes: [],
    constraints: [],
    limits: LIMITS,
  };
}

describe('seat host: every tool profile, through the registry (offline, scripted model)', { skip: UNIT_SKIP }, () => {
  test("materials (Secretary's profile): no sandbox; the must-read list and the kind's rules refuse the hand-back; records pending", async () => {
    const words = `${'w'.repeat(MATERIAL_PAGE_BYTES)}PAGE-TWO-MARKER the rest of the user's words`;
    const wordsRef = h.content.put(words);
    const noteRef = h.content.put('an optional note');
    const r = await run({
      card: (launch, mission) => ({
        ...common('fixture-materials', launch, mission),
        materials: [
          { id: 'words', title: "The user's words", ref: wordsRef, pages: 2, mustRead: true },
          { id: 'note', title: 'A note', ref: noteRef, pages: 1, mustRead: false },
        ],
      }),
      script: (q) => {
        if (q.step === 0) return tool('submit_result', { summary: 'too early' });
        if (q.step === 1) return tool('read_material', { material: 'words', page: 1 });
        if (q.step === 2) return tool('read_material', { material: 'words', page: 2 });
        if (q.step === 3) return tool('submit_result', { summary: 'bad' });
        if (q.step === 4) return tool('submit_result', { summary: 'all pages read', finding: 'the user asked for the same thing twice' });
        return DONE;
      },
    });
    const o = r.outcome;
    assert.equal(o.status, 'handed-back', diag(r));
    assert.deepEqual([o.seat, o.seatName, o.model], ['fixture-materials', 'secretary', { name: 'claude-sonnet-5-5', source: 'config' }]);
    assert.equal(o.area, null, 'no writable area: no sandbox at all');
    assert.deepEqual(o.materialsRead, ['words#1', 'words#2']);

    const main = mains(r);
    for (const q of main) {
      assert.deepEqual(toolsOf(q), sorted(['read_material', 'submit_result']));
      assert.equal(q.body?.['model'], 'claude-sonnet-5-5');
    }
    assert.ok(main[0]!.system.includes(fixtureDefinition('fixture-materials')));
    assert.ok(main[0]!.userText.includes('Fixture duties for fixture-materials.'));
    assert.ok(main[0]!.userText.includes('[words] The user\'s words: 2 pages (must read)'));
    assert.match(main[1]!.userText, /must-read page words#1 was not read/);
    assert.match(main[1]!.userText, /must-read page words#2 was not read/);
    assert.ok(main[3]!.userText.includes('PAGE-TWO-MARKER'));
    assert.match(main[4]!.userText, /fixture rule/);
    assert.doesNotMatch(main[4]!.userText.slice(main[3]!.userText.length), /must-read page/);

    const sr = seatResultOf(r);
    assert.deepEqual([sr.seat, sr.status, sr.export], ['fixture-materials', 'handed-back', null]);
    const doc = JSON.parse(h.content.get(sr.result as ContentHash).toString('utf8')) as { seat: string; result: { summary: string } };
    assert.deepEqual([doc.seat, doc.result.summary], ['fixture-materials', 'all pages read']);
    // the entry's records, pending under the launch; no run layer (nothing ran)
    const issues = recordsOf(r, 'issue') as IssueRecord[];
    assert.equal(issues.length, 1);
    assert.match(h.content.get(issues[0]!.text as ContentHash).toString('utf8'), /the same thing twice/);
    assert.equal(recordsOf(r, 'run.layer').length, 0);
    assert.ok(r.proof !== null && r.cleanup === 'done', diag(r));
  });

  test('read-web (reading investigation): only allowed addresses, each authorized by the ledger, recorded as evidence; refusals raise a WI', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.url));
      if (req.url === '/docs/a') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('page A body: the parser is named Quill');
      } else if (req.url === '/docs/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('B'.repeat(4000));
      } else if (req.url === '/docs/out') {
        res.writeHead(302, { location: '/private/secret' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('secret');
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await run({
        card: (launch, mission, snapshot) => ({
          ...common('fixture-web', launch, mission),
          workspace: { snapshot, writablePaths: [] },
          network: { allowed: [`${base}/docs/`], maxBytes: 1000 },
        }),
        hostConfig: { generation: h.gen, testHooks: { webAllowPrivate: true } },
        script: (q) => {
          if (q.step === 0) return tool('fetch_url', { url: `${base}/docs/a` });
          if (q.step === 1) return tool('fetch_url', { url: `${base}/docs/big` });
          if (q.step === 2) return tool('fetch_url', { url: `${base}/private/secret` });
          if (q.step === 3) return tool('fetch_url', { url: `${base}/docs/out` });
          if (q.step === 4) return tool('fetch_url', { url: `${base}/docs/a`, offset: 14 });
          if (q.step === 5) return tool('read_file', { path: 'src/a.txt' });
          if (q.step === 6) return tool('submit_result', { summary: 'the parser is Quill' });
          return DONE;
        },
      });
      const o = r.outcome;
      assert.equal(o.status, 'handed-back', diag(r));
      assert.deepEqual([o.seatName, o.model?.name], ['researcher', 'claude-haiku-5-5']);
      const main = mains(r);
      for (const q of main) assert.deepEqual(toolsOf(q), sorted(['read_file', 'list_directory', 'search_content', 'fetch_url', 'submit_result']));
      assert.match(main[1]!.userText, /page A body: the parser is named Quill/);
      assert.match(main[2]!.userText, /1000 bytes, cut at the size cap/, 'the card caps the size');
      assert.match(main[3]!.userText, /Refused: .*private\/secret is not an address this card allows/);
      assert.match(main[4]!.userText, /redirects to .*private\/secret, which this card does not allow/);
      assert.match(main[5]!.userText, /bytes 14-38 of 38\nhe parser is named Quill/, 'later offsets come from the recorded copy');
      assert.match(main[6]!.userText, /alpha/);
      // the server saw only allowed addresses (the redirect target and the direct refusal never left)
      assert.deepEqual(seen, ['/docs/a', '/docs/big', '/docs/out']);

      // each page recorded as evidence (record + body, within the export caps), cited by the seat-result document
      assert.equal(o.webFetches.length, 2);
      const [a, big] = o.webFetches;
      assert.deepEqual([a!.url, a!.status, a!.truncated, big!.truncated, big!.bytes], [`${base}/docs/a`, 200, false, true, 1000]);
      const rec = JSON.parse(h.content.get(a!.record).toString('utf8')) as { format: string; body: ContentHash; address: string; intent: string };
      assert.equal(rec.format, 'mp4.web-fetch.v1');
      assert.equal(h.content.get(rec.body).toString('utf8'), 'page A body: the parser is named Quill');
      const sr = seatResultOf(r);
      const doc = JSON.parse(h.content.get(sr.result as ContentHash).toString('utf8')) as { webFetches?: string[] };
      assert.deepEqual(doc.webFetches, [a!.record, big!.record]);
      // every fetch an external action of the launch: authorized, then finished (6.1)
      assert.equal(h.svc.intentState(rec.intent), 'done');
      // the refusals: in the outcome, and one WI notice for the launch
      assert.equal(o.webRefusals.length, 2);
      assert.deepEqual(o.webUnsettled, []);
      const alerts = readAlerts(r.state).filter((x) => x.kind === 'web-fetch-refused');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]!.wi, 'WI-15');
      assert.equal(recordsOf(r, 'run.layer').length, 0, 'reading files runs nothing');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  test('read-web without the ledger authorization (no scheduler generation): every fetch is refused before any byte leaves; WI', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.url));
      res.end('x');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await run({
        card: (launch, mission, snapshot) => ({ ...common('fixture-web', launch, mission), workspace: { snapshot, writablePaths: [] }, network: { allowed: [`${base}/`] } }),
        hostConfig: { testHooks: { webAllowPrivate: true } },
        script: (q) => {
          if (q.step === 0) return tool('fetch_url', { url: `${base}/page` });
          if (q.step === 1) return tool('submit_result', { summary: 'not obtained: refused' });
          return DONE;
        },
      });
      assert.equal(r.outcome.status, 'handed-back', diag(r));
      assert.match(mains(r)[1]!.userText, /cannot authorize network access for this launch/);
      assert.deepEqual(seen, []);
      assert.equal(r.outcome.webFetches.length, 0);
      assert.equal(readAlerts(r.state).filter((x) => x.kind === 'web-fetch-refused').length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  test("read (Architect's profile): the snapshot read-only, no shell; the model of the architect seat", async () => {
    const r = await run({
      card: (launch, mission, snapshot) => ({ ...common('fixture-read', launch, mission), workspace: { snapshot, writablePaths: [] } }),
      script: (q) => {
        if (q.step === 0) return tool('search_content', { pattern: 'alpha' });
        if (q.step === 1) return tool('run_command', { command: 'touch /work/x' });
        if (q.step === 2) return tool('submit_result', { summary: 'read it' });
        return DONE;
      },
    });
    assert.equal(r.outcome.status, 'handed-back', diag(r));
    assert.deepEqual([r.outcome.seatName, r.outcome.model?.name, r.outcome.area], ['architect', 'claude-haiku-4-5', 'tmpfs']);
    const main = mains(r);
    for (const q of main) {
      assert.deepEqual(toolsOf(q), sorted(['read_file', 'list_directory', 'search_content', 'submit_result']));
      assert.equal(q.body?.['model'], 'claude-haiku-4-5');
    }
    assert.match(main[1]!.userText, /src\/a\.txt/);
    assert.match(main[2]!.userText, /No such tool available|not available|no such tool/i, 'a tool outside the profile does not exist for the seat');
    assert.equal(seatResultOf(r).export, null);
    assert.equal(recordsOf(r, 'run.layer').length, 0);
  });

  test("read-rerun (Auditor's profile): only declared commands, writing into scratch; the default model when the file names no auditor", async () => {
    const r = await run({
      files: { 'src/a.txt': 'alpha\n', 'out/.keep': '' },
      card: (launch, mission, snapshot) => ({
        ...common('fixture-rerun', launch, mission),
        workspace: { snapshot, writablePaths: [], scratchPaths: ['out'] },
        declaredCommands: [{ id: 'build', command: 'mkdir -p out && cp src/a.txt out/b.txt && cat out/b.txt' }],
      }),
      script: (q) => {
        if (q.step === 0) return tool('rerun_declared_command', { id: 'build' });
        if (q.step === 1) return tool('rerun_declared_command', { id: 'rm -rf /' });
        if (q.step === 2) return tool('submit_result', { summary: 'rebuilt' });
        return DONE;
      },
    });
    assert.equal(r.outcome.status, 'handed-back', diag(r));
    assert.deepEqual([r.outcome.seatName, r.outcome.model?.source], ['auditor', 'default']);
    const main = mains(r);
    for (const q of main) assert.deepEqual(toolsOf(q), sorted(['read_file', 'list_directory', 'search_content', 'rerun_declared_command', 'submit_result']));
    assert.match(main[1]!.userText, /status: completed[\s\S]*alpha/);
    assert.match(main[2]!.userText, /is not a declared command/);
    assert.deepEqual((recordsOf(r, 'run.layer') as RunLayerRecord[]).map((x) => x.status), ['completed']);
    assert.equal(seatResultOf(r).export, null, 'scratch is never exported');
  });

  test('write on a kind other than the Constructor (blind experiment): writes and runs; the writable paths are scratch, not a product', async () => {
    const r = await run({
      card: (launch, mission, snapshot) => ({ ...common('fixture-write', launch, mission), workspace: { snapshot, writablePaths: ['src'] } }),
      script: (q) => {
        if (q.step === 0) return tool('write_file', { path: 'src/t.txt', content: 'measured\n' });
        if (q.step === 1) return tool('run_command', { command: 'cat src/t.txt' });
        if (q.step === 2) return tool('submit_result', { summary: 'ran it' });
        return DONE;
      },
    });
    assert.equal(r.outcome.status, 'handed-back', diag(r));
    assert.equal(r.outcome.seatName, 'constructor');
    for (const q of mains(r)) assert.deepEqual(toolsOf(q), sorted(['read_file', 'list_directory', 'search_content', 'write_file', 'edit_file', 'run_command', 'submit_result']));
    assert.match(mains(r)[2]!.userText, /measured/);
    assert.equal(seatResultOf(r).export, null);
    assert.equal(r.outcome.export, null);
    assert.equal(recordsOf(r, 'run.layer').length, 1);
  });

  test("read-evidence (Crititor's profile): request_evidence without allowAsyncEvidence on the card; read_material for its materials", async () => {
    const mref = h.content.put('version 2 of the design');
    const r = await run({
      card: (launch, mission, snapshot) => ({
        ...common('fixture-evidence', launch, mission),
        workspace: { snapshot, writablePaths: [] },
        materials: [{ id: 'v2', title: 'Version 2', ref: mref, pages: 1, mustRead: true }],
      }),
      script: (q) => {
        if (q.step === 0) return tool('read_material', { material: 'v2', page: 1 });
        if (q.step === 1) return tool('request_evidence', { steps: ['time the parser on 1 MB'], data: 'none', measure: ['ms'], assertions: ['under 100 ms'] });
        return { kind: 'text', text: 'Waiting for the evidence.' };
      },
    });
    assert.equal(r.outcome.status, 'needs-evidence', diag(r));
    assert.equal(r.outcome.seatName, 'crititor');
    for (const q of mains(r)) assert.deepEqual(toolsOf(q), sorted(['read_file', 'list_directory', 'search_content', 'read_material', 'submit_result', 'request_evidence']));
    assert.match(mains(r)[1]!.userText, /version 2 of the design/);
    assert.ok(r.outcome.recoveryState !== null && r.outcome.evidenceRequest !== null);
    assert.deepEqual(r.outcome.materialsRead, ['v2#1']);
  });

  test('writable paths that cannot fit the card\'s area: refused up front with the cause (WI-10), "resource exceeded", and the attempt is acceptable (M2)', async () => {
    const r = await run({
      before: async (_l, _m, d) => {
        // a 100 MiB (sparse) file in the writable path; the card's area is 64 MiB
        mkdirSync(join(d.state, 'snap', 'src'), { recursive: true });
        writeFileSync(join(d.state, 'snap', 'src', 'big.bin'), '');
        truncateSync(join(d.state, 'snap', 'src', 'big.bin'), 100 * 1024 * 1024);
      },
      card: (launch, mission, snapshot) => ({ ...common('fixture-write', launch, mission), workspace: { snapshot, writablePaths: ['src'] } }),
      script: () => DONE,
    });
    const o = r.outcome;
    assert.equal(o.status, 'resource-exceeded', diag(r));
    assert.deepEqual(o.notStarted, { cause: 'resource-blocked', wi: 'WI-10' });
    assert.match(o.reason ?? '', /the writable paths take (more than )?\d+ bytes in the writable area, and the card's area is 67108864 bytes/);
    assert.equal(fakeOf(r).requests.length, 0, 'no model request: the seat never started');
    const alerts = readAlerts(r.state).filter((x) => x.kind === 'area-unavailable');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-10');
    assert.equal(seatResultOf(r).status, 'resource-exceeded');
    assert.ok(r.proof !== null);
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true }, 'not "normal-exit: the host recorded no exit"');
  });

  test('a real registry kind end to end: researcher-reader (read-web, blind steps) becomes an evidence record', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Quill parser</title>');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await run({
        card: (launch, mission, snapshot) => ({
          ...common('researcher-reader', launch, mission),
          workspace: { snapshot, writablePaths: [] },
          network: { allowed: [`${base}/`] },
          steps: [`Read ${base}/about and record the page title.`],
          data: '',
          measure: ['title'],
          assertions: ['the title names a parser'],
          evidence: { id: `ev-reader-${launch}`.slice(0, 120), envLine: 'env-line-reading', envSnapshot: 'env-snap-reading', attempt: null },
          materials: [],
        }),
        hostConfig: { generation: h.gen, testHooks: { webAllowPrivate: true } },
        script: (q) => {
          if (q.step === 0) return tool('fetch_url', { url: `${base}/about` });
          if (q.step === 1) return tool('submit_result', { steps: [], measurements: [], assertions: [], observations: '' });
          if (q.step === 2)
            return tool('submit_result', {
              steps: [{ step: 1, done: 'yes', note: 'read the page' }],
              measurements: [{ measure: 'title', value: 'Quill parser', source: 'fetch:1' }],
              assertions: [{ assertion: 1, holds: 'yes', basis: 'fetch:1: the title says parser' }],
              observations: 'none',
            });
          return DONE;
        },
      });
      const o = r.outcome;
      assert.equal(o.status, 'handed-back', diag(r));
      assert.deepEqual([o.seat, o.seatName], ['researcher-reader', 'researcher']);
      const main = mains(r);
      assert.deepEqual(toolsOf(main[0]!), sorted(['read_file', 'list_directory', 'search_content', 'fetch_url', 'submit_result']));
      assert.ok(main[0]!.system.startsWith('You are the Researcher seat') || main[0]!.system.includes('blind reading card'));
      assert.match(main[1]!.userText, /Quill parser/);
      assert.match(main[2]!.userText, /Not accepted[\s\S]*step 1 is reported 0 times/, "the kind's own rules refuse the empty report");
      const ev = recordsOf(r, 'evidence') as EvidenceRecord[];
      assert.equal(ev.length, 1, JSON.stringify(r.pending.map((x) => x.kind)));
      assert.equal(ev[0]!.fields['measure:title'], 'Quill parser');
      assert.equal(ev[0]!.fields['executor'], 'reading');
      // every claim rests on a page the program fetched and recorded (the host's webFetches)
      assert.equal(ev[0]!.fields['status'], 'completed');
      assert.equal(ev[0]!.fields['fetch:1'], o.webFetches[0]?.record);
      const report = JSON.parse(h.content.get(ev[0]!.fields['report'] as ContentHash).toString('utf8')) as { format: string };
      assert.equal(report.format, 'mp4.blind-report.v1');
      assert.equal(o.webFetches.length, 1);
      assert.ok(readFileSync(join(r.state, 'units', r.launch, 'outcome.json'), 'utf8').includes('"researcher-reader"'));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
