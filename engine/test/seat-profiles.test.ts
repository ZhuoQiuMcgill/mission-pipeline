// Design 7.1 tool profiles, 2 seats, 9.4 model per seat, offline and without a model: the
// seat-card registry's profiles as the seat host applies them to any card kind
// (src/seat/profiles.ts), the tool server built for each profile (src/seat/mcpTools.ts), the
// material tool with its must-read list, and the reading investigation's web fetcher
// (src/seat/web.ts) against a local HTTP server. The end-to-end runs through the host are in
// test/seat-host-profiles.test.ts.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ContentHash } from '../src/common/ids.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { MATERIAL_PAGE_BYTES, commonCardFields, Material, materialPageCount, renderCommon } from '../src/seat/cards/common.ts';
import { TOOL_PROFILES, registerSeatCard, seatCardEntry, seatCardKinds, type SeatName } from '../src/seat/cards/index.ts';
import type { ProgramTools } from '../src/exec/tools.ts';
import { buildSeatServer, type CallToolResult, type SeatToolHooks } from '../src/seat/mcpTools.ts';
import { DEFAULT_MODEL_CONFIG, parseModelConfig, seatModelFor } from '../src/seat/modelConfig.ts';
import { MaterialShelf, asyncEvidenceAllowed, hostCardView, sandboxPaths, seatToolNames } from '../src/seat/profiles.ts';
import type { HandBack } from '../src/seat/results.ts';
import { allowedBy, fetchAllowed, isPublicAddress, isTextual, webAllowance } from '../src/seat/web.ts';
import { FIXTURE_KINDS } from './seat-fixture-cards.ts';
import { z } from 'zod';

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const LIMITS = {
  run: { memoryMax: 64 << 20 },
  areaBytes: 16 << 20,
  export: { maxLogicalBytes: 1 << 20, maxFiles: 100 },
  recoveryStateBytes: 8 << 20,
};

function fixtureCard(kind: string, extra: Record<string, unknown> = {}): { readonly seat: string } & Record<string, unknown> {
  const raw = {
    format: 'mp4.seat-card.v1',
    launch: 'launch-profiles-1',
    mission: 'm-profiles',
    module: null,
    capabilities: [],
    duties: 'Fixture duties.',
    decisionQuotes: [],
    constraints: [],
    limits: LIMITS,
    seat: kind,
    ...extra,
  };
  return seatCardEntry(kind).schema.parse(raw) as { readonly seat: string } & Record<string, unknown>;
}

const RO = { snapshot: '/nonexistent-snapshot', writablePaths: [], scratchPaths: ['out'] };
const RW = { snapshot: '/nonexistent-snapshot', writablePaths: ['src'] };

const textOf = (r: CallToolResult): string => r.content.map((c) => c.text).join('\n');

function hooks(over: Partial<SeatToolHooks> = {}): SeatToolHooks & { submitted: HandBack[] } {
  const submitted: HandBack[] = [];
  return {
    submitted,
    context: { snapshot: { lines: () => null } },
    log: () => undefined,
    onSubmit: async (r) => {
      submitted.push(r);
      return 'ok';
    },
    ...over,
  };
}

// ---------------------------------------------------------------- the registry and the profiles

describe('tool profiles (7.1) and the model per seat (9.4)', () => {
  test('every registered kind (real and fixture) has a known profile and a seat with a model', () => {
    const kinds = seatCardKinds();
    for (const k of ['constructor', 'reviewer', ...FIXTURE_KINDS.map((f) => f.kind)]) assert.ok(kinds.includes(k), k);
    for (const k of kinds) {
      const e = seatCardEntry(k);
      assert.ok(Object.hasOwn(TOOL_PROFILES, e.toolProfile), `${k}: ${e.toolProfile}`);
      const m = seatModelFor(DEFAULT_MODEL_CONFIG, e.seat);
      assert.ok(m !== null, `${k} (seat ${e.seat}) has a default model`);
      assert.equal(typeof e.definition, 'string');
      assert.ok(e.definition.length > 0);
    }
  });

  test('the model comes from model_config.json by seat, the default when the file does not name it', () => {
    const seats: SeatName[] = ['calibrator', 'architect', 'secretary', 'constructor', 'reviewer', 'researcher', 'crititor', 'auditor'];
    assert.deepEqual(Object.keys(DEFAULT_MODEL_CONFIG.seats).sort(), [...seats].sort());
    const c = parseModelConfig({ format: 'mp4.model-config.v1', seats: { secretary: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } });
    assert.deepEqual(seatModelFor(c, 'secretary'), { model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, source: 'config' });
    assert.equal(seatModelFor(c, 'architect')?.source, 'default');
    assert.equal(seatModelFor(c, 'architect')?.model.model, DEFAULT_MODEL_CONFIG.seats['architect']?.model);
    assert.equal(seatModelFor(c, 'nobody'), null);
    assert.equal(seatModelFor(c, 'constructor-experiment'), null, 'a card kind is not a model key');
    assert.equal(seatModelFor(c, '__proto__'), null);
  });

  test('tools per profile: materials, read, read-rerun, read-evidence, read-web, write', () => {
    const none = {};
    const mats = { materials: [{ id: 'm', title: 't', ref: 'a'.repeat(64), pages: 1, mustRead: true }] };
    assert.deepEqual(seatToolNames('materials', mats), ['read_material', 'submit_result']);
    assert.deepEqual(seatToolNames('read', none), ['read_file', 'list_directory', 'search_content', 'submit_result']);
    assert.deepEqual(seatToolNames('read-rerun', none), ['read_file', 'list_directory', 'search_content', 'rerun_declared_command', 'submit_result']);
    assert.deepEqual(seatToolNames('read-evidence', none), ['read_file', 'list_directory', 'search_content', 'submit_result', 'request_evidence']);
    assert.deepEqual(seatToolNames('read-evidence', { allowAsyncEvidence: false }), ['read_file', 'list_directory', 'search_content', 'submit_result'], 'a card can say no');
    assert.deepEqual(seatToolNames('read-web', none), ['read_file', 'list_directory', 'search_content', 'fetch_url', 'submit_result']);
    assert.deepEqual(seatToolNames('write', none), ['read_file', 'list_directory', 'search_content', 'write_file', 'edit_file', 'run_command', 'submit_result']);
    // materials on any profile add the material tool; allowAsyncEvidence adds request_evidence
    assert.deepEqual(seatToolNames('write', mats), ['read_file', 'list_directory', 'search_content', 'write_file', 'edit_file', 'run_command', 'read_material', 'submit_result']);
    assert.deepEqual(seatToolNames('read-rerun', { allowAsyncEvidence: true }), ['read_file', 'list_directory', 'search_content', 'rerun_declared_command', 'submit_result', 'request_evidence']);
    assert.equal(asyncEvidenceAllowed('read', {}), false);
    assert.equal(asyncEvidenceAllowed('read', { allowAsyncEvidence: true }), true);
  });

  test('the sandbox per profile: none for materials; the snapshot read-only; scratch for read-rerun; writable paths for write', () => {
    const w = { seat: 'k', workspace: { snapshot: '/s', writablePaths: ['src'], scratchPaths: ['out'] } };
    assert.equal(sandboxPaths('materials', w), null);
    assert.deepEqual(sandboxPaths('read', w), { snapshot: '/s', writablePaths: [] });
    assert.deepEqual(sandboxPaths('read-evidence', w), { snapshot: '/s', writablePaths: [] });
    assert.deepEqual(sandboxPaths('read-web', w), { snapshot: '/s', writablePaths: [] });
    assert.deepEqual(sandboxPaths('read-rerun', w), { snapshot: '/s', writablePaths: ['out'] });
    assert.deepEqual(sandboxPaths('write', w), { snapshot: '/s', writablePaths: ['src'] });
    assert.throws(() => sandboxPaths('read', { seat: 'k' }), /no workspace/);
  });

  test('the host view rejects a card kind without the common fields', () => {
    assert.throws(() => hostCardView({ seat: 'x' }), /lacks fields the seat host needs/);
    const v = hostCardView(fixtureCard('fixture-web', { workspace: RO, network: { allowed: ['https://example.org/docs/'] } }));
    assert.deepEqual(v.network?.allowed, ['https://example.org/docs/']);
  });

  test('the tool server of every profile offers exactly its tools (file tools need a sandbox)', () => {
    const tools = {} as ProgramTools;
    const mats = [{ id: 'm1', title: 'T', ref: 'a'.repeat(64), pages: 1, mustRead: true }];
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ['fixture-materials', { materials: mats }, ['read_material', 'submit_result']],
      ['fixture-read', { workspace: RO }, ['read_file', 'list_directory', 'search_content', 'submit_result']],
      ['fixture-rerun', { workspace: RO, declaredCommands: [{ id: 'c', command: 'true' }] }, ['read_file', 'list_directory', 'search_content', 'rerun_declared_command', 'submit_result']],
      ['fixture-evidence', { workspace: RO, materials: mats }, ['read_file', 'list_directory', 'search_content', 'read_material', 'submit_result', 'request_evidence']],
      ['fixture-web', { workspace: RO, network: { allowed: [] } }, ['read_file', 'list_directory', 'search_content', 'fetch_url', 'submit_result']],
      ['fixture-write', { workspace: RW }, ['read_file', 'list_directory', 'search_content', 'write_file', 'edit_file', 'run_command', 'submit_result']],
    ];
    for (const [kind, extra, want] of cases) {
      const card = fixtureCard(kind, extra);
      const s = buildSeatServer(card, kind === 'fixture-materials' ? null : tools, hooks({
        readMaterial: () => ({ ok: false, message: 'no' }),
        fetchUrl: async () => ({ ok: false, text: 'no' }),
        onEvidenceRequest: async () => ({ accepted: false, message: 'no' }),
      }));
      assert.deepEqual(s.names, want.map((n) => `mcp__program__${n}`), kind);
    }
    assert.throws(() => buildSeatServer(fixtureCard('fixture-read', { workspace: RO }), null, hooks()), /need a tool sandbox/);
    assert.throws(() => buildSeatServer(fixtureCard('fixture-materials', { materials: mats }), null, hooks()), /serves no read_material/);
    assert.throws(() => buildSeatServer(fixtureCard('fixture-web', { workspace: RO, network: { allowed: [] } }), tools, hooks()), /serves none/);
  });
});

// ---------------------------------------------------------------- materials and the must-read list

describe('the material tool and the must-read list (7.1 "材料工具", round 6 item 4)', () => {
  let content: ContentStore;
  let big: string;
  let bigRef: ContentHash;
  let smallRef: ContentHash;
  before(() => {
    content = new ContentStore(join(tmp('mp-seat-materials-'), 'content'));
    // two pages, with a multi-byte character on the cut (never split)
    big = `${'u'.repeat(MATERIAL_PAGE_BYTES - 1)}é and the second page of the user's words`;
    bigRef = content.put(big);
    smallRef = content.put('a short note');
  });

  const card = (pagesOfBig: number): { readonly seat: string } & Record<string, unknown> =>
    fixtureCard('fixture-materials', {
      materials: [
        { id: 'words', title: "The user's words", ref: bigRef, pages: pagesOfBig, mustRead: true },
        { id: 'note', title: 'A note', ref: smallRef, pages: 1, mustRead: false },
      ],
    });

  test('the hand-back is refused until every must-read page was read; the kind\'s own rules apply too', async () => {
    assert.equal(materialPageCount(big), 2);
    const c = card(2);
    const view = hostCardView(c);
    const shelf = new MaterialShelf(content, view.materials ?? []);
    assert.deepEqual(shelf.check(), []);
    const h = hooks({ readMaterial: (id, page) => shelf.page(id, page) });
    const s = buildSeatServer(c, null, h);
    const call = (name: string, args: unknown): Promise<CallToolResult> => (s.handlers.get(name) as (a: unknown) => Promise<CallToolResult>)(args);

    let r = await call('submit_result', { summary: 'early' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /must-read page words#1 was not read/);
    assert.match(textOf(r), /must-read page words#2 was not read/);
    assert.doesNotMatch(textOf(r), /note#1/, 'an optional material is not on the list');

    r = await call('read_material', { material: 'words', page: 1 });
    assert.notEqual(r.isError, true);
    assert.match(textOf(r), /^\[words\] The user's words: page 1 of 2 \(must read\)\n/);
    assert.ok(!textOf(r).includes('é'), 'the cut never splits a character');
    r = await call('read_material', { material: 'words', page: 3 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /no page 3/);
    r = await call('read_material', { material: 'other', page: 1 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not a material on the card \(materials: words, note\)/);

    r = await call('submit_result', { summary: 'bad' });
    assert.match(textOf(r), /must-read page words#2 was not read/);
    assert.match(textOf(r), /fixture rule/, "the kind's own problems are reported with the list");
    assert.doesNotMatch(textOf(r), /words#1/);

    r = await call('read_material', { material: 'words', page: 2 });
    assert.match(textOf(r), /^\[words\] The user's words: page 2 of 2 \(must read\)\né and the second page/);
    assert.deepEqual([...s.materialsRead()].sort(), ['words#1', 'words#2']);

    r = await call('submit_result', { summary: 'bad' });
    assert.equal(r.isError, true);
    assert.doesNotMatch(textOf(r), /must-read/);
    r = await call('submit_result', { summary: 'all read', finding: 'x' });
    assert.notEqual(r.isError, true, textOf(r));
    assert.deepEqual(h.submitted, [{ seat: 'fixture-materials', result: { summary: 'all read', finding: 'x' } }]);
    r = await call('read_material', { material: 'note', page: 1 });
    assert.match(textOf(r), /round is over/);
  });

  test("a kind's own must-read refusal and the host's are reported once", async () => {
    if (!seatCardKinds().includes('fixture-dup')) {
      const Shape = { summary: z.string() };
      registerSeatCard({
        kind: 'fixture-dup',
        seat: 'calibrator',
        schema: z.object({ ...commonCardFields, seat: z.literal('fixture-dup'), materials: z.array(Material) }) as never,
        resultShape: Shape,
        resultSchema: z.object(Shape),
        definition: 'dup',
        toolProfile: 'materials',
        render: (c: never) => renderCommon(c),
        problems: (c: { materials: { id: string; pages: number; mustRead: boolean }[] }, _r: unknown, ctx: { materialsRead?: ReadonlySet<string> }) =>
          c.materials.flatMap((m) => (m.mustRead && !(ctx.materialsRead?.has(`${m.id}#1`) ?? false) ? [`must-read page ${m.id}#1 was not read`] : [])),
        records: () => [],
      } as never);
    }
    const c = fixtureCard('fixture-dup', { materials: [{ id: 'note', title: 'N', ref: smallRef, pages: 1, mustRead: true }] });
    const shelf = new MaterialShelf(content, hostCardView(c).materials ?? []);
    const s = buildSeatServer(c, null, hooks({ readMaterial: (id, page) => shelf.page(id, page) }));
    const r = await (s.handlers.get('submit_result') as (a: unknown) => Promise<CallToolResult>)({ summary: 's' });
    assert.equal(textOf(r).split('must-read page note#1 was not read').length - 1, 1, textOf(r));
  });

  test('materials are checked whole before the seat starts: pages, presence, duplicate ids, corruption', () => {
    const missing = 'b'.repeat(64);
    const shelf = new MaterialShelf(content, [
      { id: 'words', title: 'W', ref: bigRef, pages: 3, mustRead: true },
      { id: 'gone', title: 'G', ref: missing, pages: 1, mustRead: true },
      { id: 'words', title: 'W2', ref: smallRef, pages: 1, mustRead: false },
    ]);
    const p = shelf.check();
    assert.equal(p.length, 3, p.join('\n'));
    assert.match(p.join('\n'), /words .* has 2 pages, the card says 3/);
    assert.match(p.join('\n'), /gone/);
    assert.match(p.join('\n'), /appears twice/);
    // a material corrupted after the check: the page is not served, and the host is told why
    const ref = content.put('will be corrupted');
    writeFileSync(content.path(ref), 'something else');
    const s2 = new MaterialShelf(content, [{ id: 'c', title: 'C', ref, pages: 1, mustRead: true }]);
    const r = s2.page('c', 1);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.broken !== undefined && /corruption/.test(r.broken));
  });
});

// ---------------------------------------------------------------- the web fetcher

describe('fetch_url: only the card\'s addresses, fetched outside the sandbox within caps (7.1)', () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      if (req.url === '/docs/a') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('page A body');
      } else if (req.url === '/docs/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(5000));
      } else if (req.url === '/docs/jump') {
        res.writeHead(302, { location: '/docs/a' });
        res.end();
      } else if (req.url === '/docs/out') {
        res.writeHead(302, { location: '/secret' });
        res.end();
      } else if (req.url === '/docs/loop') {
        res.writeHead(302, { location: '/docs/loop' });
        res.end();
      } else if (req.url === '/docs/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('partial');
        // never ends
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('secret');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('the allowance: origin and path prefix, query, no credentials, http(s) only', () => {
    const a = webAllowance({ allowed: ['https://example.org/docs/', 'example.com', 'https://api.example.net/v1/item?id=7', 'ftp://example.org/', 'not a url'] });
    assert.deepEqual(a.invalid, ['ftp://example.org/', 'not a url']);
    const ok = (u: string): boolean => allowedBy(a, new URL(u)) !== null;
    assert.ok(ok('https://example.org/docs/'));
    assert.ok(ok('https://example.org/docs/a/b?x=1'));
    assert.ok(ok('https://EXAMPLE.org:443/docs/a'));
    assert.ok(!ok('https://example.org/docsx'));
    assert.ok(!ok('https://example.org/'));
    assert.ok(!ok('https://example.org/docs/../secret'), 'normalized before matching');
    assert.ok(!ok('http://example.org/docs/a'), 'the scheme is part of the origin');
    assert.ok(!ok('https://example.org:8443/docs/a'));
    assert.ok(!ok('https://user:pw@example.org/docs/a'));
    assert.ok(ok('https://example.com/anything'), 'a bare host allows its whole https origin');
    assert.ok(!ok('https://sub.example.com/'));
    assert.ok(ok('https://api.example.net/v1/item?id=7'));
    assert.ok(!ok('https://api.example.net/v1/item?id=8'));
    assert.ok(!ok('https://api.example.net/v1/item'));
    assert.deepEqual(webAllowance(undefined).rules, []);
  });

  test('only public addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1', 'nonsense']) {
      assert.equal(isPublicAddress(a), false, a);
    }
    for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(a), true, a);
    assert.equal(isTextual('text/html', Buffer.from('<p>')), true);
    assert.equal(isTextual('image/png', Buffer.from('x')), false);
    assert.equal(isTextual(null, Buffer.from([0, 1, 2])), false);
  });

  test('fetches an allowed page; cuts at the size cap; follows allowed redirects; refuses the rest before any byte leaves', async () => {
    const base = `http://127.0.0.1:${port}`;
    const a = webAllowance({ allowed: [`${base}/docs/`], maxBytes: 1000 });
    const o = { allowPrivate: true };
    seen.length = 0;
    const r1 = await fetchAllowed(`${base}/docs/a#frag`, a, o);
    assert.equal(r1.kind, 'fetched');
    assert.ok(r1.kind === 'fetched');
    assert.equal(r1.body.toString(), 'page A body');
    assert.equal(r1.status, 200);
    assert.equal(r1.truncated, false);
    assert.equal(r1.finalUrl, `${base}/docs/a`);

    const r2 = await fetchAllowed(`${base}/docs/big`, a, o);
    assert.ok(r2.kind === 'fetched' && r2.truncated && r2.body.length === 1000);

    const r3 = await fetchAllowed(`${base}/docs/jump`, a, o);
    assert.ok(r3.kind === 'fetched');
    assert.deepEqual([r3.finalUrl, r3.redirects], [`${base}/docs/a`, [`${base}/docs/a`]]);

    const before = seen.length;
    const r4 = await fetchAllowed(`${base}/docs/out`, a, o);
    assert.equal(r4.kind, 'refused');
    assert.match(r4.kind === 'refused' ? r4.reason : '', /redirects to .*\/secret, which this card does not allow/);
    assert.deepEqual(seen.slice(before), [`127.0.0.1:${port} /docs/out`], 'the redirect target was never requested');

    const r5 = await fetchAllowed(`${base}/secret`, a, o);
    assert.equal(r5.kind, 'refused');
    assert.equal(seen.filter((s) => s.endsWith(' /secret')).length, 0);

    const r6 = await fetchAllowed(`${base}/docs/loop`, a, o);
    assert.ok(r6.kind === 'failed' && /more than 5 redirects/.test(r6.reason));

    const r7 = await fetchAllowed(`file:///etc/passwd`, a, o);
    assert.equal(r7.kind, 'refused');
    const r8 = await fetchAllowed('not a url', a, o);
    assert.equal(r8.kind, 'refused');
  });

  test('a non-public address is refused even when the card allows it; a name is pinned to the checked address', async () => {
    const base = `http://127.0.0.1:${port}`;
    const before = seen.length;
    const r1 = await fetchAllowed(`${base}/docs/a`, webAllowance({ allowed: [`${base}/docs/`] }));
    assert.ok(r1.kind === 'refused' && /non-public address/.test(r1.reason));
    // a name the card allows that resolves to a local address (DNS rebinding): refused
    const rebind = webAllowance({ allowed: [`http://docs.example.test:${port}/docs/`] });
    const r2 = await fetchAllowed(`http://docs.example.test:${port}/docs/a`, rebind, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.ok(r2.kind === 'refused' && /docs\.example\.test resolves to a non-public address \(127\.0\.0\.1\)/.test(r2.reason));
    const r3 = await fetchAllowed(`http://docs.example.test:${port}/docs/a`, rebind, { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] });
    assert.ok(r3.kind === 'refused', 'any local answer refuses the name');
    assert.equal(seen.length, before, 'nothing was requested');
    // allowed (tests): the connection goes to the resolved address, with the name as Host
    const r4 = await fetchAllowed(`http://docs.example.test:${port}/docs/a`, rebind, { allowPrivate: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.ok(r4.kind === 'fetched' && r4.address === '127.0.0.1' && r4.body.toString() === 'page A body');
    assert.equal(seen.at(-1), `docs.example.test:${port} /docs/a`);
  });

  test('the time cap ends a fetch that never completes; the seat being ended aborts it', async () => {
    const base = `http://127.0.0.1:${port}`;
    const a = { ...webAllowance({ allowed: [`${base}/docs/`] }), timeoutMs: 300 };
    const t0 = Date.now();
    const r = await fetchAllowed(`${base}/docs/slow`, a, { allowPrivate: true });
    assert.ok(r.kind === 'failed' && /within 300 ms/.test(r.reason), JSON.stringify(r));
    assert.ok(Date.now() - t0 < 3000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r2 = await fetchAllowed(`${base}/docs/slow`, webAllowance({ allowed: [`${base}/docs/`] }), { allowPrivate: true, signal: ac.signal });
    assert.ok(r2.kind === 'failed' && /being ended/.test(r2.reason));
  });
});
