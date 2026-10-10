// A small JSON-lines RPC over a Unix domain socket, for services other than the
// ledger (the ledger keeps its own typed protocol in src/ledger/ipc.ts).
//   request:  {"id": 1, "method": "...", "params": {...}}
//   response: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
// Requests on one connection are answered in order.
//
// The client follows the ledger client's design (core review r2 F16): concurrent
// first calls share one connection attempt; each connection has its own buffer
// and its own outstanding requests, so a closing old connection fails only the
// requests sent on it; a line that does not parse is skipped, never thrown.

import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** The service could not be reached or did not answer in time: retryable. */
export class RpcUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcUnavailable';
  }
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export function serveRpc(socketPath: string, handler: RpcHandler): Server {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((sock) => {
    let buf = '';
    let chain: Promise<void> = Promise.resolve();
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        chain = chain.then(() => answer(sock, line, handler));
      }
    });
    sock.on('error', () => sock.destroy());
  });
  server.listen(socketPath);
  return server;
}

async function answer(sock: Socket, line: string, handler: RpcHandler): Promise<void> {
  let id: unknown = null;
  try {
    const req = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
    id = req.id ?? null;
    if (typeof req.method !== 'string') throw new RpcError('BAD_REQUEST', 'missing method');
    const result = await handler(req.method, req.params ?? {});
    if (!sock.destroyed) sock.write(JSON.stringify({ id, ok: true, result: result ?? null }) + '\n');
  } catch (e) {
    const code = e instanceof RpcError ? e.code : 'INTERNAL';
    const message = e instanceof Error ? e.message : String(e);
    if (!sock.destroyed) sock.write(JSON.stringify({ id, ok: false, error: { code, message } }) + '\n');
  }
}

interface Waiter {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

/** One live connection with its own buffer and its own outstanding requests. */
interface Conn {
  readonly sock: Socket;
  buf: string;
  readonly waiting: Map<number, Waiter>;
}

export interface RpcClientOptions {
  /** Opens the socket (tests inject a fake). Default: `net.createConnection(path)`. */
  readonly connect?: (socketPath: string) => Socket;
}

export class RpcClient {
  private conn: Conn | null = null;
  private connecting: { readonly promise: Promise<Conn>; readonly sock: Socket } | null = null;
  private nextId = 1;
  private readonly open: (socketPath: string) => Socket;
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 10_000, opts: RpcClientOptions = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.open = opts.connect ?? ((p) => createConnection(p));
  }

  /** The live connection, or the one attempt in flight; concurrent callers share it. */
  private connect(): Promise<Conn> {
    if (this.conn && !this.conn.sock.destroyed) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting.promise;
    let sock: Socket;
    try {
      sock = this.open(this.socketPath);
    } catch (e) {
      return Promise.reject(new RpcUnavailable(e instanceof Error ? e.message : String(e)));
    }
    const conn: Conn = { sock, buf: '', waiting: new Map() };
    const promise = new Promise<Conn>((resolve, reject) => {
      let settled = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        this.conn = conn;
        resolve(conn);
      });
      sock.on('error', (e: Error) => {
        failAll(conn, new RpcUnavailable(e.message));
        if (!settled) {
          settled = true;
          reject(new RpcUnavailable(e.message));
        }
      });
      sock.on('close', () => {
        failAll(conn, new RpcUnavailable('connection closed'));
        if (this.conn === conn) this.conn = null;
        if (!settled) {
          settled = true;
          reject(new RpcUnavailable('connection closed before it was established'));
        }
      });
      sock.on('data', (chunk: string | Buffer) => onData(conn, typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    });
    const attempt = { promise, sock };
    this.connecting = attempt;
    const clear = (): void => {
      if (this.connecting === attempt) this.connecting = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    const conn = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (conn.sock.destroyed) {
        reject(new RpcUnavailable('connection closed'));
        return;
      }
      const timer = setTimeout(() => {
        conn.waiting.delete(id);
        reject(new RpcUnavailable(`${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      conn.waiting.set(id, { resolve, reject, timer });
      try {
        conn.sock.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        conn.waiting.delete(id);
        reject(new RpcUnavailable(e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Close the current connection (and an attempt in flight). A later call reconnects. */
  close(): void {
    const c = this.conn;
    this.conn = null;
    if (c) {
      failAll(c, new RpcUnavailable('client closed'));
      c.sock.end();
    }
    const pending = this.connecting;
    this.connecting = null;
    pending?.sock.destroy();
  }
}

function onData(conn: Conn, chunk: string): void {
  conn.buf += chunk;
  let nl: number;
  while ((nl = conn.buf.indexOf('\n')) !== -1) {
    const line = conn.buf.slice(0, nl);
    conn.buf = conn.buf.slice(nl + 1);
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      continue;
    }
    if (msg === null || typeof msg !== 'object' || typeof msg.id !== 'number') continue;
    const w = conn.waiting.get(msg.id);
    if (!w) continue;
    clearTimeout(w.timer);
    conn.waiting.delete(msg.id);
    if (msg.ok === true) w.resolve(msg.result);
    else w.reject(new RpcError(String(msg.error?.code ?? 'INTERNAL'), String(msg.error?.message ?? 'no message')));
  }
}

function failAll(conn: Conn, e: Error): void {
  for (const [, w] of conn.waiting) {
    clearTimeout(w.timer);
    w.reject(e);
  }
  conn.waiting.clear();
}
