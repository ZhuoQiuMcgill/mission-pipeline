// The evaluator's query RPC client (src/common/rpc.ts; core review r2 F16):
// concurrent first calls share one connection attempt; each connection has its
// own buffer and outstanding requests, so a closing old connection fails only
// its own requests; split frames and garbage lines are handled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { RpcClient, RpcError, RpcUnavailable, serveRpc } from '../src/common/rpc.ts';

/** A socket the test drives by hand. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: Array<{ id: number; method: string; params: unknown }> = [];
  setEncoding(): this {
    return this;
  }
  write(s: string): boolean {
    for (const line of s.split('\n')) if (line) this.writes.push(JSON.parse(line) as { id: number; method: string; params: unknown });
    return true;
  }
  end(): this {
    return this.destroy();
  }
  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
  connect(): void {
    this.emit('connect');
  }
  reply(id: number, result: unknown): void {
    this.emit('data', JSON.stringify({ id, ok: true, result }) + '\n');
  }
}

function fakeClient(timeoutMs = 2000): { client: RpcClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const client = new RpcClient('fake.sock', timeoutMs, {
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as Socket;
    },
  });
  return { client, sockets };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('concurrent first calls share one connection attempt (F16)', async () => {
  const { client, sockets } = fakeClient();
  const calls = [client.call('a'), client.call('b'), client.call('c')];
  await tick();
  assert.equal(sockets.length, 1, 'one connection for three concurrent first calls');
  sockets[0]!.connect();
  await tick();
  assert.deepEqual(sockets[0]!.writes.map((w) => w.method), ['a', 'b', 'c']);
  // Answers out of order still reach their callers.
  for (const w of [...sockets[0]!.writes].reverse()) sockets[0]!.reply(w.id, w.method.toUpperCase());
  assert.deepEqual(await Promise.all(calls), ['A', 'B', 'C']);
  client.close();
});

test('a closing old connection fails only the requests sent on it; the next call reconnects (F16, the reviewer\'s race)', async () => {
  const { client, sockets } = fakeClient();
  const first = client.call('one');
  await tick();
  sockets[0]!.connect();
  await tick();
  sockets[0]!.reply(sockets[0]!.writes[0]!.id, 1);
  assert.equal(await first, 1);
  // Connection A is torn down, but its 'close' event is late; a new call opens B.
  const a = sockets[0]!;
  const pendingOnA = client.call('stuck-on-a');
  await tick();
  a.destroyed = true; // A died; its close event has not arrived yet
  const onB = client.call('on-b');
  await tick();
  assert.equal(sockets.length, 2, 'a destroyed connection is not reused');
  const b = sockets[1]!;
  b.connect();
  await tick();
  a.emit('close'); // the late close of A
  await assert.rejects(pendingOnA, RpcUnavailable, 'the request sent on A fails');
  b.reply(b.writes[0]!.id, 'b');
  assert.equal(await onB, 'b', 'the request on B is not failed by A closing');
  client.close();
});

test('split frames, several responses in one chunk, garbage lines and unknown ids (F16)', async () => {
  const { client, sockets } = fakeClient();
  const p1 = client.call('x');
  const p2 = client.call('y');
  await tick();
  const s = sockets[0]!;
  s.connect();
  await tick();
  const [w1, w2] = s.writes;
  const r1 = JSON.stringify({ id: w1!.id, ok: true, result: { big: 'x'.repeat(1000) } });
  const r2 = JSON.stringify({ id: w2!.id, ok: false, error: { code: 'NOT_READY', message: 'later' } });
  s.emit('data', r1.slice(0, 7));
  s.emit('data', r1.slice(7, 500));
  s.emit('data', `${r1.slice(500)}\nnot json at all\n${JSON.stringify({ id: 999, ok: true, result: 0 })}\n${r2.slice(0, 10)}`);
  s.emit('data', `${r2.slice(10)}\n`);
  assert.deepEqual(await p1, { big: 'x'.repeat(1000) });
  await assert.rejects(p2, (e: unknown) => e instanceof RpcError && e.code === 'NOT_READY');
  client.close();
});

test('each connection has its own buffer: a partial line on a dead connection never prefixes the next (F16)', async () => {
  const { client, sockets } = fakeClient();
  const p = client.call('x');
  await tick();
  sockets[0]!.connect();
  await tick();
  sockets[0]!.emit('data', '{"id":1,"ok":tr'); // torn
  sockets[0]!.destroy();
  await assert.rejects(p, RpcUnavailable);
  const q = client.call('y');
  await tick();
  sockets[1]!.connect();
  await tick();
  sockets[1]!.reply(sockets[1]!.writes[0]!.id, 'clean');
  assert.equal(await q, 'clean');
  client.close();
});

test('a connection error before connecting fails every waiting first call; timeouts are retryable (F16)', async () => {
  const { client, sockets } = fakeClient(40);
  const a = client.call('a');
  const b = client.call('b');
  await tick();
  sockets[0]!.emit('error', new Error('ECONNREFUSED'));
  await assert.rejects(a, RpcUnavailable);
  await assert.rejects(b, RpcUnavailable);
  const c = client.call('c');
  await tick();
  assert.equal(sockets.length, 2);
  sockets[1]!.connect();
  await assert.rejects(c, /timed out/);
  // A late answer to a timed-out request is ignored.
  sockets[1]!.reply(sockets[1]!.writes[0]!.id, 'late');
  // close() during a connection attempt fails its callers; a later call reconnects.
  client.close();
  const d = client.call('d');
  await tick();
  client.close();
  await assert.rejects(d, RpcUnavailable);
  const e = client.call('e');
  await tick();
  assert.equal(sockets.length, 4);
  sockets[3]!.connect();
  await tick();
  sockets[3]!.reply(sockets[3]!.writes[0]!.id, 'e');
  assert.equal(await e, 'e');
  client.close();
});

test('over a real Unix socket: concurrent first calls use one server connection; errors keep their codes (F16)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-evrpc-'));
  const path = join(dir, 'q.sock');
  const server = serveRpc(path, async (method, params) => {
    if (method === 'echo') return params;
    throw new RpcError('BAD_REQUEST', `unknown method ${method}`);
  });
  let connections = 0;
  server.on('connection', () => connections++);
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const client = new RpcClient(path, 5000);
  try {
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => client.call('echo', { i })));
    assert.deepEqual(out, Array.from({ length: 20 }, (_, i) => ({ i })));
    assert.equal(connections, 1);
    await assert.rejects(client.call('nope'), (e: unknown) => e instanceof RpcError && e.code === 'BAD_REQUEST');
  } finally {
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
