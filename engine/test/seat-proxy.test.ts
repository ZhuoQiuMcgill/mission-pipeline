// Design 6.5 "计量代理" and §14 item 2, offline: a fake model service upstream and a real
// ledger service. Every model request is bounded and reserved in the ledger BEFORE it is
// forwarded, settled by the usage the response reports (or at zero / at the reservation
// when the outcome says so); at the limit the request is refused and the seat aborted;
// unlimited mode meters all the same; several seats share one limit; a proxy that dies
// mid-request leaves its reservation to be settled at the reserved amount.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { id, type Generation, type LaunchId, type MissionId, type ReservationId, type StopId } from '../src/common/ids.ts';
import { LedgerClient, serveLedger } from '../src/ledger/ipc.ts';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { DEFAULT_MODEL_CONFIG, boundPrices, upperBoundMicros, usageMicros, type ApiUsage } from '../src/seat/modelConfig.ts';
import { MeteringProxy, SpendLedgerDown, UsageReader, ledgerSpend, type ProxyFatal } from '../src/seat/proxy.ts';

const PROXY_MAIN = fileURLToPath(new URL('../src/seat/proxy-main.ts', import.meta.url));
const MODEL = 'claude-haiku-5-5';
const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];

let svc: LedgerService;
let ledgerServer: Server;
let socketPath = '';
let client: LedgerClient;
let gen: Generation;
let seq = 0;

before(async () => {
  const d = mkdtempSync(join(tmpdir(), 'mp-seat-proxy-'));
  dirs.push(d);
  svc = new LedgerService({ paths: ledgerPaths(join(d, 'ledger'), join(d, 'control')) });
  svc.open();
  socketPath = join(d, 'ledger.sock');
  ledgerServer = serveLedger(svc, socketPath);
  client = new LedgerClient(socketPath, 10_000);
  gen = (await client.call('beginGeneration', {})) as Generation;
});

after(async () => {
  for (const c of closers.reverse()) await c();
  client?.close();
  if (ledgerServer) await new Promise<void>((r) => ledgerServer.close(() => r()));
  svc?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function launchIn(mission: MissionId, capabilities: string[] = []): Promise<LaunchId> {
  seq++;
  const launch = id<LaunchId>(`launch-proxy-${process.pid}-${seq}`);
  await client.call('registerLaunch', { op: `reg:${launch}`, gen, launch, tag: { mission, capabilities } });
  return launch;
}

const spend = (mission: MissionId) => svc.spendSummary(mission);

// ---------------------------------------------------------------- a fake model service

type Behavior = 'sse' | 'json' | 'error' | 'cut' | 'stall';

interface Seen {
  readonly url: string;
  readonly auth: string | undefined;
  readonly acceptEncoding: string | undefined;
  readonly bodyBytes: number;
  readonly inflightAtArrival: number;
  readonly spentAtArrival: number;
}

const USAGE: ApiUsage = { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 250, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 } };

function sseBody(model: string): string {
  const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  return [
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { ...USAGE, output_tokens: 1 } } }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo – ✓' } }),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: USAGE.output_tokens } }),
    ev('message_stop', { type: 'message_stop' }),
  ].join('');
}

async function fakeModel(mission: MissionId, behavior: () => Behavior, delayMs = 0): Promise<{ url: string; seen: Seen[]; release: () => void }> {
  const seen: Seen[] = [];
  const stalled: ServerResponse[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = spend(mission);
      seen.push({
        url: req.url ?? '',
        auth: req.headers['authorization'],
        acceptEncoding: req.headers['accept-encoding'],
        bodyBytes: Buffer.concat(chunks).length,
        inflightAtArrival: s.inflight,
        spentAtArrival: s.spent,
      });
      const b = behavior();
      setTimeout(() => {
        if (req.method !== 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"data":[]}');
        } else if (b === 'json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_1', type: 'message', model: MODEL, content: [{ type: 'text', text: 'hi' }], usage: USAGE }));
        } else if (b === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }));
        } else if (b === 'cut') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(sseBody(MODEL).split('event: content_block_start')[0]);
          setTimeout(() => res.destroy(), 20);
        } else if (b === 'stall') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(sseBody(MODEL).split('event: content_block_start')[0]);
          stalled.push(res);
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const body = sseBody(MODEL);
          // split inside a multi-byte character to exercise the stream decoder
          const cut = Buffer.from(body).indexOf(Buffer.from('é')) + 1;
          const buf = Buffer.from(body);
          res.write(buf.subarray(0, cut));
          setTimeout(() => res.end(buf.subarray(cut)), 5);
        }
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => {
    for (const r of stalled) r.destroy();
    return new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    release: () => {
      for (const r of stalled.splice(0)) r.destroy();
    },
  };
}

async function proxyFor(launch: LaunchId, upstream: string, opts: { ledgerOutageMs?: number; socket?: string } = {}) {
  const fatal: { reason: ProxyFatal; detail: string }[] = [];
  const c = new LedgerClient(opts.socket ?? socketPath, 2_000);
  const proxy = await MeteringProxy.start({
    launch,
    ledger: ledgerSpend(c, launch),
    config: DEFAULT_MODEL_CONFIG,
    upstream,
    onFatal: (reason, detail) => fatal.push({ reason, detail }),
    settleRetry: { attempts: 2, delayMs: 50 },
    ...(opts.ledgerOutageMs !== undefined ? { ledgerOutageMs: opts.ledgerOutageMs } : {}),
  });
  closers.push(async () => {
    await proxy.close(2_000);
    c.close();
  });
  return { proxy, fatal };
}

/** What Claude Code sends: POST /v1/messages?beta=true, streamed, Bearer credentials. */
async function ask(base: string, maxTokens = 1000, extra: Record<string, unknown> = {}): Promise<{ status: number; body: string }> {
  const r = await fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat-test', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
  return { status: r.status, body: await r.text() };
}

// ---------------------------------------------------------------- pure

describe('request bound and settlement prices (pure)', () => {
  test('the bound uses body bytes plus the tool overhead at the dearest input price, and max_tokens at the dearest output price', () => {
    const b = boundPrices(DEFAULT_MODEL_CONFIG.metering.prices[MODEL]!);
    assert.equal(b.input, 0.5 * 2, 'long-context input, 1-hour cache write');
    assert.equal(b.output, 2.5, 'long-context output');
    assert.equal(upperBoundMicros(DEFAULT_MODEL_CONFIG, MODEL, 10_000, 1_000), Math.ceil((10_000 + 4_096) * 1 + 1_000 * 2.5));
    assert.equal(upperBoundMicros(DEFAULT_MODEL_CONFIG, MODEL, 0, null), Math.ceil(4_096 + 128_000 * 2.5), 'no max_tokens: the configured default');
    assert.throws(() => upperBoundMicros(DEFAULT_MODEL_CONFIG, 'unknown-model', 1, 1));
  });

  test('usage is priced by tier and cache TTL', () => {
    const small = usageMicros(DEFAULT_MODEL_CONFIG, MODEL, USAGE);
    assert.equal(small, Math.ceil(1200 * 0.1 + 300 * 0.1 * 1.25 + 5000 * 0.01 + 250 * 0.5));
    const long = usageMicros(DEFAULT_MODEL_CONFIG, MODEL, { input_tokens: 150_000, output_tokens: 10 });
    assert.equal(long, Math.ceil(150_000 * 0.5 + 10 * 2.5), 'over 100K input tokens: the higher tier');
    const noBreakdown = usageMicros(DEFAULT_MODEL_CONFIG, MODEL, { cache_creation_input_tokens: 1000 });
    assert.equal(noBreakdown, Math.ceil(1000 * 0.1 * 2), 'cache writes without a TTL breakdown: the 1-hour rate');
  });

  test('usage is read from a stream split anywhere, or from a JSON body', () => {
    const body = Buffer.from(sseBody(MODEL));
    for (const step of [1, 7, 64, body.length]) {
      const r = new UsageReader('text/event-stream; charset=utf-8');
      for (let i = 0; i < body.length; i += step) r.push(body.subarray(i, i + step));
      r.end();
      assert.equal(r.sawStart, true);
      assert.equal(r.sawFinal, true);
      assert.equal(r.model, MODEL);
      assert.deepEqual(r.usage(), USAGE);
    }
    const j = new UsageReader('application/json');
    j.push(Buffer.from(JSON.stringify({ type: 'message', model: MODEL, usage: USAGE })));
    j.end();
    assert.deepEqual(j.usage(), USAGE);
    const e = new UsageReader('application/json');
    e.push(Buffer.from(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })));
    e.end();
    assert.equal(e.sawStart, false);
    assert.equal(e.usage(), null);
  });
});

// ---------------------------------------------------------------- through a real ledger

describe('the metering proxy with a real ledger', () => {
  test('the reservation is in the ledger before the request is forwarded; settled by usage; bytes and credentials pass through', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-usage`);
    const launch = await launchIn(mission);
    const up = await fakeModel(mission, () => 'sse');
    const { proxy } = await proxyFor(launch, up.url);
    const r = await ask(proxy.url, 1000);
    await proxy.drain();
    assert.equal(r.status, 200);
    assert.equal(r.body, sseBody(MODEL), 'the stream reached the client unchanged');
    const seen = up.seen[0];
    assert.ok(seen);
    const entry = proxy.log[0];
    assert.ok(entry);
    assert.equal(seen.inflightAtArrival, entry.reservedMicros, 'the bound was reserved before the model saw the request');
    assert.equal(seen.auth, 'Bearer sk-ant-oat-test');
    assert.equal(seen.acceptEncoding, 'identity');
    assert.equal(seen.url, '/v1/messages?beta=true');
    assert.equal(entry.settlement, 'usage');
    assert.equal(entry.settledMicros, usageMicros(DEFAULT_MODEL_CONFIG, MODEL, USAGE));
    assert.deepEqual(spend(mission), { limit: null, spent: entry.settledMicros, inflight: 0 });
    assert.equal(proxy.totals.outputTokens, USAGE.output_tokens);
  });

  test('a JSON response is settled by its usage; an error before any message at zero; a cut stream at the reservation', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-outcomes`);
    const launch = await launchIn(mission);
    const order: Behavior[] = ['json', 'error', 'cut'];
    const up = await fakeModel(mission, () => order.shift() ?? 'sse');
    const { proxy } = await proxyFor(launch, up.url);
    assert.equal((await ask(proxy.url)).status, 200);
    assert.equal((await ask(proxy.url)).status, 400);
    await ask(proxy.url).catch(() => undefined);
    await proxy.drain();
    assert.deepEqual(
      proxy.log.map((e) => e.settlement),
      ['usage', 'zero', 'reservation'],
    );
    const s = spend(mission);
    assert.equal(s.inflight, 0);
    assert.equal(s.spent, usageMicros(DEFAULT_MODEL_CONFIG, MODEL, USAGE) + 0 + (proxy.log[2]?.reservedMicros ?? NaN));
  });

  test('an unreachable model service: 502 to the client, settled at zero', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-down`);
    const launch = await launchIn(mission);
    const { proxy } = await proxyFor(launch, 'http://127.0.0.1:1');
    assert.equal((await ask(proxy.url)).status, 502);
    await proxy.drain();
    assert.equal(proxy.log[0]?.settlement, 'zero');
    assert.deepEqual(spend(mission), { limit: null, spent: 0, inflight: 0 });
  });

  test('requests that cannot cost money pass through unmetered', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-unmetered`);
    const launch = await launchIn(mission);
    const up = await fakeModel(mission, () => 'sse');
    const { proxy } = await proxyFor(launch, up.url);
    const r = await fetch(`${proxy.url}/v1/models`);
    await r.text();
    await proxy.drain();
    assert.equal(r.status, 200);
    assert.equal(proxy.log[0]?.settlement, 'unmetered');
    assert.deepEqual(spend(mission), { limit: null, spent: 0, inflight: 0 });
  });

  test('over the limit: the request is refused before forwarding and the seat is aborted', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-limit`);
    await client.call('setSpendLimit', { op: `limit:${mission}`, mission, micros: 50_000 });
    const launch = await launchIn(mission);
    const up = await fakeModel(mission, () => 'sse');
    const { proxy, fatal } = await proxyFor(launch, up.url);
    const r = await ask(proxy.url, 100_000); // bound ~250k micro-dollars > 50k
    assert.equal(r.status, 403);
    assert.match(r.body, /SPEND_LIMIT/);
    assert.equal(up.seen.length, 0, 'never forwarded');
    assert.deepEqual(fatal.map((f) => f.reason), ['spend-limit']);
    assert.deepEqual(spend(mission), { limit: 50_000, spent: 0, inflight: 0 });
    const ok = await ask(proxy.url, 100); // a small request still fits
    assert.equal(ok.status, 200);
  });

  test('unlimited mode meters all the same', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-unlimited`);
    const launch = await launchIn(mission);
    const up = await fakeModel(mission, () => 'sse');
    const { proxy, fatal } = await proxyFor(launch, up.url);
    for (let i = 0; i < 3; i++) assert.equal((await ask(proxy.url, 128_000)).status, 200);
    await proxy.drain();
    assert.equal(fatal.length, 0);
    assert.equal(proxy.log.filter((e) => e.settlement === 'usage').length, 3);
    assert.equal(spend(mission).spent, 3 * usageMicros(DEFAULT_MODEL_CONFIG, MODEL, USAGE));
    assert.ok(up.seen.every((s) => s.inflightAtArrival > 0), 'every request was reserved first');
  });

  test('several seats share one limit: spent + in flight never exceeds it', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-concurrent`);
    const bound = upperBoundMicros(DEFAULT_MODEL_CONFIG, MODEL, 200, 1_000); // about the size of one request below
    const limit = 3 * bound + 10;
    await client.call('setSpendLimit', { op: `limit:${mission}`, mission, micros: limit });
    const up = await fakeModel(mission, () => 'sse', 60);
    const seats = await Promise.all([0, 1, 2, 3].map(async () => proxyFor(await launchIn(mission), up.url)));
    const results = await Promise.all(seats.flatMap(({ proxy }) => [ask(proxy.url, 1_000), ask(proxy.url, 1_000)]));
    await Promise.all(seats.map(({ proxy }) => proxy.drain()));
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 403).length;
    assert.equal(ok + refused, 8);
    assert.ok(ok >= 3, `at least the limit's worth went through (${ok})`);
    for (const s of up.seen) assert.ok(s.inflightAtArrival + s.spentAtArrival <= limit, `${s.inflightAtArrival}+${s.spentAtArrival} <= ${limit}`);
    const after = spend(mission);
    assert.equal(after.inflight, 0);
    assert.ok(after.spent <= limit);
    assert.equal(after.spent, seats.reduce((n, { proxy }) => n + proxy.totals.settledMicros, 0), 'ledger and proxies agree');
    assert.ok(seats.some(({ fatal }) => fatal.some((f) => f.reason === 'spend-limit')), 'a refused seat is aborted');
  });

  test('a stopped launch: refused and the seat aborted', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-stopped`);
    const launch = await launchIn(mission);
    await client.call('stop', { stop: id<StopId>(`stop-${launch}`), scope: { kind: 'mission', mission }, words: '停', at: Date.now() });
    const up = await fakeModel(mission, () => 'sse');
    const { proxy, fatal } = await proxyFor(launch, up.url);
    assert.equal((await ask(proxy.url)).status, 403);
    assert.deepEqual(fatal.map((f) => f.reason), ['stopped']);
    assert.equal(up.seen.length, 0);
  });

  test('the ledger unreachable: 503 (retryable) and, past the outage window, the seat is aborted', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-ledger-down`);
    const launch = await launchIn(mission);
    const up = await fakeModel(mission, () => 'sse');
    const { proxy, fatal } = await proxyFor(launch, up.url, { ledgerOutageMs: 100, socket: join(dirs[0] as string, 'no-ledger.sock') });
    const first = await ask(proxy.url);
    assert.equal(first.status, 503);
    assert.equal(fatal.length, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await ask(proxy.url)).status, 503);
    assert.deepEqual(fatal.map((f) => f.reason), ['ledger-down']);
    assert.equal(up.seen.length, 0);
  });

  test('the proxy dies with a request in flight: the reservation stays open until settled at the reserved amount', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-death`);
    const launch = await launchIn(mission);
    const up = await fakeModel(mission, () => 'stall');
    const d = mkdtempSync(join(tmpdir(), 'mp-seat-proxy-main-'));
    dirs.push(d);
    writeFileSync(join(d, 'proxy.json'), JSON.stringify({ launch, ledgerSocket: socketPath, upstream: up.url }));
    const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', PROXY_MAIN, join(d, 'proxy.json')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    closers.push(() => {
      child.kill('SIGKILL');
    });
    const base = await new Promise<string>((resolve) => child.stdout?.once('data', (b: Buffer) => resolve(b.toString().trim())));
    const pending = ask(base, 2_000).catch(() => ({ status: 0, body: '' }));
    for (let i = 0; i < 100 && up.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(up.seen.length, 1, 'the model got the request');
    const reserved = spend(mission).inflight;
    assert.ok(reserved > 0);
    child.kill('SIGKILL');
    await pending;
    up.release();
    assert.deepEqual(spend(mission), { limit: null, spent: 0, inflight: reserved }, 'nothing settled by the dead proxy');
    // what the unit supervisor does once the host is gone (ledgerSink.settleOpenSpend)
    await client.call('settleLaunchAtReservation', { op: `settle-at-reservation:${launch}`, launch });
    assert.deepEqual(spend(mission), { limit: null, spent: reserved, inflight: 0 });
  });
});

// ---------------------------------------------------------------- code review r1: findings 8, 9, 10 and a lost reservation answer

/** An upstream that answers every request with `reply` and records what reached it. */
async function rawUpstream(reply: (req: IncomingMessage, body: string) => { status: number; type?: string; body: string; destroyAfter?: boolean }) {
  const seen: { method: string; url: string; body: string }[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      const r = reply(req, body);
      res.writeHead(r.status, { 'content-type': r.type ?? 'application/json' });
      if (r.destroyAfter === true) {
        res.write(r.body);
        setTimeout(() => res.destroy(), 10);
      } else res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const apiErr = (type: string): string => JSON.stringify({ type: 'error', error: { type, message: 'x' } });
const sseEvents = (events: unknown[]): string => events.map((d) => `event: ${(d as { type: string }).type}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const FULL = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 };

describe('finding 8: only listed endpoints; unknown ones are refused, never forwarded unreserved', () => {
  test('a batch, a legacy completion, other methods: refused before forwarding, nothing reserved', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-allowlist`);
    const launch = await launchIn(mission);
    const up = await rawUpstream(() => ({ status: 200, body: JSON.stringify({ id: 'b1', type: 'message_batch' }) }));
    const { proxy } = await proxyFor(launch, up.url);
    const batch = { requests: [{ custom_id: 'one', params: { model: MODEL, max_tokens: 100_000, messages: [{ role: 'user', content: 'hi' }] } }] };
    const tries: [string, string, unknown][] = [
      ['POST', '/v1/messages/batches', batch],
      ['POST', '/v1/complete', { model: MODEL, max_tokens_to_sample: 10, prompt: 'x' }],
      ['DELETE', '/v1/messages', null],
      ['PUT', '/v1/messages', { model: MODEL, max_tokens: 10, messages: [] }],
      ['POST', '/v1/messages/batches/b1/cancel', {}],
      ['POST', '/api/anything', {}],
    ];
    for (const [method, path, body] of tries) {
      const r = await fetch(`${proxy.url}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== null ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.match(await r.text(), /not an endpoint the metering proxy serves/);
    }
    await proxy.drain();
    assert.equal(up.seen.length, 0, 'nothing reached the model service');
    assert.ok(proxy.log.every((e) => e.settlement === 'refused' && e.reservation === null));
    assert.deepEqual(spend(mission), { limit: null, spent: 0, inflight: 0 });
  });

  test('the free endpoints pass unmetered; a message request that cannot be bounded is refused unforwarded', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-free`);
    const launch = await launchIn(mission);
    const up = await rawUpstream((req) => ({ status: 200, body: req.url?.startsWith('/v1/messages/count_tokens') ? '{"input_tokens":3}' : '{"data":[]}' }));
    const { proxy } = await proxyFor(launch, up.url);
    assert.equal((await fetch(`${proxy.url}/v1/models`)).status, 200);
    assert.equal((await fetch(`${proxy.url}/v1/models/${MODEL}`)).status, 200);
    assert.equal((await fetch(`${proxy.url}/v1/messages/count_tokens`, { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [] }) })).status, 200);
    for (const body of ['not json', JSON.stringify([1]), JSON.stringify({ max_tokens: 10, messages: [] }), JSON.stringify({ model: MODEL, max_tokens: '100', messages: [] }), JSON.stringify({ model: MODEL, max_tokens: -1, messages: [] }), JSON.stringify({ model: MODEL, max_tokens: 1.5, messages: [] })]) {
      const r = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body });
      assert.equal(r.status, 400, body);
      assert.match(await r.text(), /cannot be bounded/);
    }
    await proxy.drain();
    assert.equal(up.seen.length, 3, 'only the three free requests were forwarded');
    assert.deepEqual(proxy.log.map((e) => e.settlement), ['unmetered', 'unmetered', 'unmetered', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
    assert.deepEqual(spend(mission), { limit: null, spent: 0, inflight: 0 });
  });
});

describe('finding 9: only complete, well-typed usage is final; anything else settles at the reservation', () => {
  test('empty, partial, mistyped or inconsistent usage, and a stream without message_stop', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-usage-check`);
    const launch = await launchIn(mission);
    const bodies: { type?: string; body: string; want: string }[] = [
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: {} }), want: 'reservation' },
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: { input_tokens: 10, output_tokens: 5 } }), want: 'reservation' },
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: { ...FULL, output_tokens: '5' } }), want: 'reservation' },
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: { ...FULL, cache_read_input_tokens: null } }), want: 'reservation' },
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: { ...FULL, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1 } } }), want: 'reservation' },
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: { ...FULL, input_tokens: -3 } }), want: 'reservation' },
      { body: JSON.stringify({ model: MODEL, usage: FULL }), want: 'reservation' },
      {
        type: 'text/event-stream',
        body: sseEvents([
          { type: 'message_start', message: { model: MODEL, usage: { ...FULL, output_tokens: 1 } } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
        want: 'reservation',
      },
      {
        type: 'text/event-stream',
        body: sseEvents([
          { type: 'message_start', message: { model: MODEL, usage: { ...FULL, output_tokens: 1 } } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]),
        want: 'usage',
      },
      { body: JSON.stringify({ type: 'message', model: MODEL, usage: { ...FULL, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } } }), want: 'usage' },
    ];
    const queue = [...bodies];
    const up = await rawUpstream(() => {
      const b = queue.shift() as (typeof bodies)[number];
      return { status: 200, ...(b.type !== undefined ? { type: b.type } : {}), body: b.body };
    });
    const { proxy } = await proxyFor(launch, up.url);
    for (let i = 0; i < bodies.length; i++) await (await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: MODEL, max_tokens: 100, messages: [] }) })).text();
    await proxy.drain();
    assert.deepEqual(proxy.log.map((e) => e.settlement), bodies.map((b) => b.want));
    for (const e of proxy.log.filter((x) => x.settlement === 'reservation')) assert.equal(e.settledMicros, e.reservedMicros);
    assert.ok(proxy.log.filter((x) => x.settlement === 'reservation').every((e) => typeof e.note === 'string'), 'the reason is logged');
    // the reviewer's case: usage {} used to settle at zero
    assert.ok((proxy.log[0]?.settledMicros ?? 0) > 0);
    assert.equal(spend(mission).inflight, 0);
  });
});

describe('finding 10: an HTTP error alone is not proof the request was free', () => {
  test('5xx, gateway pages and mismatched error types settle at the reservation; documented pre-execution refusals at zero', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-errors`);
    const launch = await launchIn(mission);
    const replies: { status: number; type?: string; body: string; want: string }[] = [
      { status: 502, body: apiErr('api_error'), want: 'reservation' },
      { status: 500, body: apiErr('api_error'), want: 'reservation' },
      { status: 529, body: apiErr('overloaded_error'), want: 'reservation' },
      { status: 503, type: 'text/html', body: '<html>bad gateway</html>', want: 'reservation' },
      { status: 400, type: 'text/html', body: '<html>gateway says 400</html>', want: 'reservation' },
      { status: 400, body: apiErr('api_error'), want: 'reservation' },
      { status: 429, body: '{"type":"error"', want: 'reservation' },
      { status: 400, body: apiErr('invalid_request_error'), want: 'zero' },
      { status: 401, body: apiErr('authentication_error'), want: 'zero' },
      { status: 403, body: apiErr('permission_error'), want: 'zero' },
      { status: 404, body: apiErr('not_found_error'), want: 'zero' },
      { status: 413, body: apiErr('request_too_large'), want: 'zero' },
      { status: 429, body: apiErr('rate_limit_error'), want: 'zero' },
      {
        status: 200,
        type: 'text/event-stream',
        body: sseEvents([{ type: 'message_start', message: { model: MODEL, usage: { ...FULL, output_tokens: 1 } } }, { type: 'error', error: { type: 'overloaded_error' } }]),
        want: 'reservation',
      },
    ];
    const queue = [...replies];
    const up = await rawUpstream(() => {
      const r = queue.shift() as (typeof replies)[number];
      return { status: r.status, ...(r.type !== undefined ? { type: r.type } : {}), body: r.body };
    });
    const { proxy } = await proxyFor(launch, up.url);
    for (let i = 0; i < replies.length; i++) await (await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: MODEL, max_tokens: 100, messages: [] }) })).text();
    await proxy.drain();
    assert.deepEqual(proxy.log.map((e) => `${e.status}:${e.settlement}`), replies.map((r) => `${r.status}:${r.want}`));
    // the reviewer's case: a 502 used to settle at zero
    assert.equal(proxy.log[0]?.settledMicros, proxy.log[0]?.reservedMicros);
    assert.equal(spend(mission).inflight, 0);
  });

  test('a response cut after its headers settles at the reservation even with an error status', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-cut-error`);
    const launch = await launchIn(mission);
    const up = await rawUpstream(() => ({ status: 429, body: '{"type":"error","error":{"type":"rate_', destroyAfter: true }));
    const { proxy } = await proxyFor(launch, up.url);
    await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: MODEL, max_tokens: 100, messages: [] }) })
      .then((r) => r.text())
      .catch(() => undefined);
    await proxy.drain();
    assert.equal(proxy.log[0]?.settlement, 'reservation');
  });
});

describe('fault: the reservation is committed but its answer is lost', () => {
  test('the request is refused unforwarded and the committed reservation is released at zero', async () => {
    const mission = id<MissionId>(`m-proxy-${process.pid}-lost-answer`);
    const launch = await launchIn(mission);
    const up = await rawUpstream(() => ({ status: 200, body: JSON.stringify({ type: 'message', model: MODEL, usage: FULL }) }));
    const c = new LedgerClient(socketPath, 2_000);
    closers.push(() => c.close());
    const real = ledgerSpend(c, launch);
    let lost = 0;
    const lossy = {
      async reserve(reservation: ReservationId, micros: number): Promise<void> {
        await real.reserve(reservation, micros);
        if (lost++ === 0) throw new SpendLedgerDown('the answer was lost after the commit (test)');
      },
      settle: (reservation: ReservationId, micros: number) => real.settle(reservation, micros),
    };
    const proxy = await MeteringProxy.start({ launch, ledger: lossy, config: DEFAULT_MODEL_CONFIG, upstream: up.url, settleRetry: { attempts: 2, delayMs: 50 } });
    closers.push(() => proxy.close(2_000));
    const first = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: MODEL, max_tokens: 100, messages: [] }) });
    assert.equal(first.status, 503);
    await first.text();
    await proxy.drain();
    assert.equal(up.seen.length, 0, 'never forwarded');
    assert.deepEqual(spend(mission), { limit: null, spent: 0, inflight: 0 }, 'the committed reservation was released at zero');
    // the retry is reserved and forwarded normally
    const second = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: MODEL, max_tokens: 100, messages: [] }) });
    assert.equal(second.status, 200);
    await second.text();
    await proxy.drain();
    assert.equal(up.seen.length, 1);
    assert.equal(spend(mission).inflight, 0);
    assert.ok(spend(mission).spent > 0);
  });
});
