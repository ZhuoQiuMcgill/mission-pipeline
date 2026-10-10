// The metering proxy of a seat host (design 6.5 "计量代理", §14 item 2; port of
// probes-4.0/probe-metering-proxy*). Claude Code is started with ANTHROPIC_BASE_URL pointing
// here, so every model request of the seat (the SDK's retries and compactions included)
// passes through it:
//   0. only an explicit list of endpoints is served (code review r1 finding 8): POST
//      /v1/messages is metered; token counting and the model list are documented as free and
//      pass unmetered; every other method and path is refused without being forwarded, so no
//      billing form can bypass the reservation;
//   1. compute the request's upper bound (modelConfig.ts) and reserve it in the ledger
//      BEFORE forwarding; a refusal (spend limit, stop, final disposition) answers the
//      request with an error and aborts the seat (onFatal);
//   2. forward it with the caller's credentials passed through (Bearer or x-api-key),
//      asking upstream for an uncompressed body (accept-encoding: identity) so the usage
//      can be read from the stream;
//   3. stream the response back unchanged while reading usage from the server-sent events
//      (message_start: input side; message_delta: final output; message_stop) or the JSON body;
//   4. settle (6.5: a request whose outcome is unknown is settled at what was reserved):
//      - by the usage, only when the response completed with a final usage that is complete
//        and well-typed (finding 9: all counters present, the cache-write tiers summing up);
//      - at zero, only when forwarding provably did not happen (no connection, no TLS session)
//        or the service answered with an API error of a class documented as refused before
//        execution and not charged (400, 401, 403, 404, 413, 429 with the matching error type,
//        before any message started; finding 10);
//      - at the reservation otherwise: 5xx, gateway errors, malformed or cut responses, an
//        unpriced served model.
// In "unlimited" mode the ledger never refuses, and the proxy meters all the same.

import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { id, type LaunchId, type ReservationId } from '../common/ids.ts';
import { LedgerClient, RemoteLedgerError } from '../ledger/ipc.ts';
import { upperBoundMicros, usageMicros, usageProblems, type ApiUsage, type ModelConfig } from './modelConfig.ts';

// ---------------------------------------------------------------- the ledger side

export type SpendRefusalCode = 'SPEND_LIMIT' | 'STOPPED' | 'UNRECOGNIZED_LAUNCH';

/** The ledger refused a reservation: the request is not forwarded and the seat is aborted. */
export class SpendRefused extends Error {
  readonly code: SpendRefusalCode;
  constructor(code: SpendRefusalCode, message: string) {
    super(message);
    this.name = 'SpendRefused';
    this.code = code;
  }
}

/** The ledger could not be reached or is in storage fault: retryable. */
export class SpendLedgerDown extends Error {
  override readonly name = 'SpendLedgerDown';
}

export interface SpendLedger {
  reserve(reservation: ReservationId, micros: number): Promise<void>;
  settle(reservation: ReservationId, micros: number): Promise<void>;
}

/** reserveSpend / settleSpend over the ledger's IPC, with op ids derived from the reservation. */
export function ledgerSpend(client: LedgerClient, launch: LaunchId): SpendLedger {
  const down = (e: unknown): SpendLedgerDown => new SpendLedgerDown(e instanceof Error ? e.message : String(e));
  return {
    async reserve(reservation, micros) {
      try {
        await client.call('reserveSpend', { op: `reserve:${reservation}`, reservation, launch, micros });
      } catch (e) {
        if (e instanceof RemoteLedgerError) {
          if (e.code === 'SPEND_LIMIT' || e.code === 'STOPPED' || e.code === 'UNRECOGNIZED_LAUNCH') throw new SpendRefused(e.code, e.message);
          if (e.code === 'STORAGE_FAULT') throw down(e);
          throw e;
        }
        throw down(e);
      }
    },
    async settle(reservation, micros) {
      try {
        await client.call('settleSpend', { op: `settle:${reservation}`, reservation, micros });
      } catch (e) {
        if (e instanceof RemoteLedgerError && e.code === 'ALREADY_SETTLED') return;
        if (e instanceof RemoteLedgerError && e.code !== 'STORAGE_FAULT') throw e;
        throw down(e);
      }
    },
  };
}

// ---------------------------------------------------------------- reading usage from a response

/** Reads usage and the served model from a streamed (SSE) or JSON Messages API response. */
export class UsageReader {
  private readonly sse: boolean;
  private readonly decoder = new StringDecoder('utf8');
  private text = '';
  private readonly jsonChunks: Buffer[] = [];
  private jsonBytes = 0;
  private jsonOverflow = false;
  private startUsage: Record<string, unknown> | null = null;
  private deltaUsage: Record<string, unknown> | null = null;
  model: string | null = null;
  /** A message started (the model service accepted and began the request). */
  sawStart = false;
  /** The final usage arrived (message_delta, or a complete JSON message body). */
  sawFinal = false;
  /** SSE: message_stop arrived (the message is complete). */
  sawStop = false;
  /** A JSON error body: its error type (e.g. "rate_limit_error"), or an SSE error event. */
  errorType: string | null = null;
  /** SSE: the order of the message events seen (message_start, message_delta, message_stop). */
  private readonly order: string[] = [];
  /** The body ended normally (set by the proxy when the upstream response ended). */
  complete = false;

  constructor(contentType: string | undefined) {
    this.sse = /text\/event-stream/i.test(contentType ?? '');
  }

  push(chunk: Buffer): void {
    if (!this.sse) {
      if (this.jsonBytes + chunk.length <= 16 << 20) {
        this.jsonChunks.push(chunk);
        this.jsonBytes += chunk.length;
      } else this.jsonOverflow = true;
      return;
    }
    this.text += this.decoder.write(chunk);
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.text);
      if (m === null) break;
      const event = this.text.slice(0, m.index);
      this.text = this.text.slice(m.index + m[0].length);
      this.event(event);
    }
    if (this.text.length > 1 << 20) this.text = this.text.slice(-(1 << 20)); // a runaway line is not an event
  }

  end(): void {
    if (this.sse) {
      this.text += this.decoder.end();
      if (this.text.trim() !== '') this.event(this.text);
      this.text = '';
      return;
    }
    if (this.jsonOverflow) return;
    try {
      const j = JSON.parse(Buffer.concat(this.jsonChunks).toString('utf8')) as { usage?: unknown; model?: unknown; type?: unknown; error?: { type?: unknown } };
      if (j.type === 'error') {
        this.errorType = typeof j.error?.type === 'string' ? j.error.type : 'unknown';
      } else if (j.type === 'message' && typeof j.usage === 'object' && j.usage !== null) {
        this.startUsage = j.usage as Record<string, unknown>;
        this.sawStart = true;
        this.sawFinal = true;
        this.sawStop = true;
      }
      if (typeof j.model === 'string') this.model = j.model;
    } catch {
      /* not JSON: no usage */
    }
  }

  private event(block: string): void {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data === '') return;
    let ev: { type?: string; message?: { usage?: unknown; model?: unknown }; usage?: unknown; error?: { type?: unknown } };
    try {
      ev = JSON.parse(data) as typeof ev;
    } catch {
      return;
    }
    if (ev.type === 'message_start' || ev.type === 'message_delta' || ev.type === 'message_stop') this.order.push(ev.type);
    if (ev.type === 'message_start') {
      this.sawStart = true;
      if (typeof ev.message?.usage === 'object' && ev.message.usage !== null) this.startUsage = ev.message.usage as Record<string, unknown>;
      if (typeof ev.message?.model === 'string') this.model = ev.message.model;
    } else if (ev.type === 'message_delta' && typeof ev.usage === 'object' && ev.usage !== null) {
      this.deltaUsage = ev.usage as Record<string, unknown>;
      this.sawFinal = true;
    } else if (ev.type === 'message_stop') {
      this.sawStop = true;
    } else if (ev.type === 'error') {
      this.errorType = typeof ev.error?.type === 'string' ? ev.error.type : 'unknown';
    }
  }

  /** The merged usage: input side from the latest block that has it, output from message_delta (unvalidated). */
  usage(): ApiUsage | null {
    if (this.startUsage === null && this.deltaUsage === null) return null;
    const s = this.startUsage ?? {};
    const d = this.deltaUsage ?? {};
    const out: Record<string, unknown> = {};
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation'] as const) {
      const v = d[k] !== undefined ? d[k] : s[k];
      if (v !== undefined) out[k] = v;
    }
    // the output count of a stream is the final delta's alone: message_start's is a placeholder (r2 finding 4)
    const output = this.sse ? d['output_tokens'] : s['output_tokens'];
    if (output !== undefined) out['output_tokens'] = output;
    return out as ApiUsage;
  }

  /**
   * The final usage when the message completed and the usage is complete and well-typed
   * (finding 9); otherwise null with the reason, and the request settles at its reservation.
   */
  finalUsage(): { readonly usage: ApiUsage | null; readonly problem: string | null } {
    if (!this.complete) return { usage: null, problem: 'the response did not complete' };
    if (!this.sawFinal) return { usage: null, problem: 'no final usage' };
    if (this.sse) {
      if (!this.sawStop) return { usage: null, problem: 'the stream has no message_stop' };
      const o = this.order;
      const start = o.indexOf('message_start');
      const lastDelta = o.lastIndexOf('message_delta');
      const stop = o.lastIndexOf('message_stop');
      if (start !== 0 || o.lastIndexOf('message_start') !== 0 || lastDelta < start || stop < lastDelta || stop !== o.length - 1) {
        return { usage: null, problem: `the message events are out of order (${o.join(', ')})` };
      }
      const out = this.deltaUsage?.['output_tokens'];
      if (typeof out !== 'number' || !Number.isSafeInteger(out) || out < 0) return { usage: null, problem: 'the final message_delta has no output count' };
    }
    if (this.errorType !== null) return { usage: null, problem: `an error event (${this.errorType}) in the response` };
    const u = this.usage();
    const problems = usageProblems(u);
    return problems.length === 0 ? { usage: u, problem: null } : { usage: null, problem: `incomplete usage: ${problems.join('; ')}` };
  }
}

/**
 * Error classes the Messages API documents as refused before the request is executed, and not
 * charged, with the status each comes with (finding 10). Only these settle at zero once the
 * request was forwarded. 5xx (api_error, overloaded_error), gateway errors and anything that is
 * not an API-shaped error body settle at the reservation.
 */
export const UNCHARGED_ERRORS: Readonly<Record<number, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
};

/** Which requests are served, and how (finding 8): metered, free (documented as not charged), or refused. */
export type EndpointClass = { readonly kind: 'metered' } | { readonly kind: 'free'; readonly why: string } | { readonly kind: 'refused'; readonly why: string };

export function classifyEndpoint(method: string, pathname: string): EndpointClass {
  if (method === 'POST' && pathname === '/v1/messages') return { kind: 'metered' };
  if (method === 'POST' && pathname === '/v1/messages/count_tokens') return { kind: 'free', why: 'token counting is free of charge' };
  if (method === 'GET' && (pathname === '/v1/models' || /^\/v1\/models\/[A-Za-z0-9._:@-]+$/.test(pathname))) return { kind: 'free', why: 'model metadata' };
  return { kind: 'refused', why: `${method} ${pathname} is not an endpoint the metering proxy serves` };
}

// ---------------------------------------------------------------- the proxy

export type ProxyFatal = 'spend-limit' | 'stopped' | 'launch-final' | 'ledger-down' | 'unpriced-model';

export type Settlement = 'usage' | 'zero' | 'reservation' | 'unmetered' | 'refused' | 'unsettled';

export interface MeteredRequest {
  readonly seq: number;
  readonly reservation: ReservationId | null;
  readonly method: string;
  readonly path: string;
  readonly model: string | null;
  readonly bodyBytes: number;
  readonly maxTokens: number | null;
  readonly reservedMicros: number;
  readonly status: number;
  readonly usage: ApiUsage | null;
  readonly settledMicros: number;
  readonly settlement: Settlement;
  readonly ms: number;
  /** Why a forwarded request was not settled by its usage (finding 9), when it was not. */
  readonly note?: string;
}

export interface ProxyTotals {
  requests: number;
  metered: number;
  refused: number;
  reservedMicros: number;
  settledMicros: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface MeteringProxyOptions {
  readonly launch: LaunchId;
  readonly ledger: SpendLedger;
  readonly config: ModelConfig;
  /** Default https://api.anthropic.com. */
  readonly upstream?: string;
  /** The seat must end (6.5: "宿主用 SDK 的中止信号结束席位"). Called once per reason. */
  readonly onFatal?: (reason: ProxyFatal, detail: string) => void;
  readonly onRequest?: (r: MeteredRequest) => void;
  /**
   * Called right before a request is forwarded (after its reservation is in the ledger), with
   * its body: the startup self-check reads what the seat's Claude Code process actually sends
   * (9.3 items 1-3) and that every reservation precedes forwarding (item 9).
   */
  readonly onForward?: (r: { readonly seq: number; readonly method: string; readonly path: string; readonly body: Buffer; readonly reservation: ReservationId | null; readonly reservedMicros: number }) => void | Promise<void>;
  /** How long the ledger may stay unreachable before the seat is ended (6.1: 10 minutes). */
  readonly ledgerOutageMs?: number;
  readonly maxBodyBytes?: number;
  /** Settlement retries while the ledger is down. */
  readonly settleRetry?: { readonly attempts: number; readonly delayMs: number };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(h: IncomingHttpHeaders, host: string, bodyLength: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === 'host' || k === 'content-length' || k === 'accept-encoding') continue;
    out[k] = v;
  }
  out['host'] = host;
  out['accept-encoding'] = 'identity';
  out['content-length'] = String(bodyLength);
  return out;
}

function responseHeaders(h: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
  return out;
}

function apiError(res: ServerResponse, status: number, type: string, message: string, extra: OutgoingHttpHeaders = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type, message: `metering proxy: ${message}` } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...extra });
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n <= max) chunks.push(c);
    });
    req.on('end', () => resolve(n > max ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Forwarded {
  readonly status: number;
  readonly reader: UsageReader | null;
  /** The connection (and for https the TLS session) was established: the request may have reached the model. */
  readonly sent: boolean;
  /** The upstream answered (status and headers arrived). */
  readonly responded: boolean;
}

export class MeteringProxy {
  readonly launch: LaunchId;
  private readonly opts: MeteringProxyOptions;
  private readonly upstream: URL;
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly fatalSent = new Set<ProxyFatal>();
  private seq = 0;
  private ledgerDownSince: number | null = null;
  private listeningUrl = '';
  readonly log: MeteredRequest[] = [];
  readonly totals: ProxyTotals = {
    requests: 0,
    metered: 0,
    refused: 0,
    reservedMicros: 0,
    settledMicros: 0,
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };

  private constructor(opts: MeteringProxyOptions) {
    this.opts = opts;
    this.launch = opts.launch;
    this.upstream = new URL(opts.upstream ?? 'https://api.anthropic.com');
    this.server = http.createServer((req, res) => {
      const work = this.serve(req, res).catch((e: unknown) => apiError(res, 500, 'api_error', (e as Error).message));
      this.inflight.add(work);
      void work.finally(() => this.inflight.delete(work));
    });
    this.server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
  }

  static async start(opts: MeteringProxyOptions): Promise<MeteringProxy> {
    const p = new MeteringProxy(opts);
    await new Promise<void>((resolve, reject) => {
      p.server.once('error', reject);
      p.server.listen(0, '127.0.0.1', () => {
        p.server.off('error', reject);
        // r7: never an unhandled 'error' event after listening (requests then fail and are reported)
        p.server.on('error', () => undefined);
        resolve();
      });
    });
    const addr = p.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('proxy has no TCP address');
    p.listeningUrl = `http://127.0.0.1:${addr.port}`;
    return p;
  }

  /** ANTHROPIC_BASE_URL for the seat's Claude Code process. */
  get url(): string {
    return this.listeningUrl;
  }

  private fatal(reason: ProxyFatal, detail: string): void {
    if (this.fatalSent.has(reason)) return;
    this.fatalSent.add(reason);
    this.opts.onFatal?.(reason, detail);
  }

  private record(r: MeteredRequest): void {
    if (this.log.length < 100_000) this.log.push(r);
    this.opts.onRequest?.(r);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const seq = ++this.seq;
    this.totals.requests++;
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const pathname = path.split('?')[0] ?? '/';
    const body = await readBody(req, this.opts.maxBodyBytes ?? 64 << 20);
    if (body === null) return apiError(res, 413, 'request_too_large', 'request body over the proxy limit');
    const base = { seq, method, path, bodyBytes: body.length };
    const endpoint = classifyEndpoint(method, pathname);

    // 0. only the listed endpoints (finding 8): an unknown one is never forwarded
    if (endpoint.kind === 'refused') {
      this.totals.refused++;
      apiError(res, 404, 'not_found_error', endpoint.why);
      this.record({ ...base, reservation: null, model: null, maxTokens: null, reservedMicros: 0, status: 404, usage: null, settledMicros: 0, settlement: 'refused', ms: Date.now() - started });
      return;
    }
    if (endpoint.kind === 'free') {
      await this.opts.onForward?.({ seq, method, path, body, reservation: null, reservedMicros: 0 });
      const f = await this.forward(req, res, body, false);
      this.record({ ...base, reservation: null, model: null, maxTokens: null, reservedMicros: 0, status: f.status, usage: null, settledMicros: 0, settlement: 'unmetered', ms: Date.now() - started });
      return;
    }

    this.totals.metered++;
    type RequestBody = { readonly model?: unknown; readonly max_tokens?: unknown };
    let json: RequestBody | null;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as RequestBody) : null;
    } catch {
      json = null;
    }
    const model = typeof json?.model === 'string' ? json.model : '';
    const rawMax = json?.max_tokens;
    const maxTokens = typeof rawMax === 'number' ? rawMax : null;
    const malformed =
      json === null ? 'the body is not a JSON object' : model === '' ? 'no model' : rawMax !== undefined && !(Number.isSafeInteger(rawMax) && (rawMax as number) > 0) ? 'max_tokens is not a positive integer' : null;
    if (malformed !== null) {
      // never forwarded: a request the proxy cannot bound is not a request it can let through
      this.totals.refused++;
      apiError(res, 400, 'invalid_request_error', `${malformed}: the request cannot be bounded`);
      this.record({ ...base, reservation: null, model: model || null, maxTokens, reservedMicros: 0, status: 400, usage: null, settledMicros: 0, settlement: 'refused', ms: Date.now() - started });
      return;
    }
    let bound: number;
    try {
      bound = upperBoundMicros(this.opts.config, model, body.length, maxTokens);
    } catch (e) {
      this.totals.refused++;
      apiError(res, 400, 'invalid_request_error', `${(e as Error).message}: the request cannot be bounded`);
      this.fatal('unpriced-model', `no price for model ${JSON.stringify(model)}`);
      this.record({ ...base, reservation: null, model, maxTokens, reservedMicros: 0, status: 400, usage: null, settledMicros: 0, settlement: 'refused', ms: Date.now() - started });
      return;
    }

    // 1. reserve before forwarding
    const reservation = id<ReservationId>(`${this.launch}.q${seq}`);
    try {
      await this.opts.ledger.reserve(reservation, bound);
      this.ledgerDownSince = null;
    } catch (e) {
      this.totals.refused++;
      const refusal = { ...base, reservation, model, maxTokens, reservedMicros: 0, usage: null, settledMicros: 0, settlement: 'refused' as const, ms: Date.now() - started };
      if (e instanceof SpendRefused) {
        apiError(res, 403, 'permission_error', `${e.code}: ${e.message}`);
        this.fatal(e.code === 'SPEND_LIMIT' ? 'spend-limit' : e.code === 'STOPPED' ? 'stopped' : 'launch-final', e.message);
        this.record({ ...refusal, status: 403 });
        return;
      }
      if (e instanceof SpendLedgerDown) {
        const now = Date.now();
        this.ledgerDownSince ??= now;
        if (now - this.ledgerDownSince >= (this.opts.ledgerOutageMs ?? 600_000)) this.fatal('ledger-down', e.message);
        apiError(res, 503, 'overloaded_error', `the ledger is unavailable (${e.message})`, { 'retry-after': '5' });
        // the reservation may have been committed with its answer lost: the request was provably
        // never forwarded, so it is released at zero (an unknown reservation is simply refused);
        // if the ledger stays away, the supervisor settles it at the reservation when the host ends
        const released = await this.settle(reservation, 0, { attempts: 3, delayMs: 1_000 });
        this.record({ ...refusal, status: 503, note: released ? 'reservation answer lost; released at zero' : 'not reserved (or not released yet)' });
        return;
      }
      throw e;
    }
    this.totals.reservedMicros += bound;

    // 2-3. forward and read the usage
    await this.opts.onForward?.({ seq, method, path, body, reservation, reservedMicros: bound });
    const f = await this.forward(req, res, body, true);
    const reader = f.reader;
    const servedModel = reader?.model ?? model;
    const final = reader?.finalUsage() ?? { usage: null, problem: 'no response' };

    // 4. settle (see the file header)
    let micros: number;
    let settlement: Settlement;
    let usage: ApiUsage | null = null;
    const pricedAs = servedModel === model || this.opts.config.metering.prices[servedModel] !== undefined ? servedModel : null;
    if (final.usage !== null && f.status === 200 && pricedAs !== null) {
      usage = final.usage;
      micros = usageMicros(this.opts.config, pricedAs, usage);
      settlement = 'usage';
    } else if (!f.sent) {
      // never forwarded: no connection (or no TLS session) was made
      micros = 0;
      settlement = 'zero';
    } else if (f.responded && reader !== null && reader.complete && reader.sawStart !== true && reader.errorType !== null && UNCHARGED_ERRORS[f.status] === reader.errorType) {
      // an API error documented as refused before execution and not charged
      micros = 0;
      settlement = 'zero';
    } else {
      // it reached the service and no trustworthy final usage came back
      micros = bound;
      settlement = 'reservation';
    }
    if (usage !== null) {
      this.totals.inputTokens += usage.input_tokens ?? 0;
      this.totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      this.totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      this.totals.outputTokens += usage.output_tokens ?? 0;
    }
    const settled = await this.settle(reservation, micros);
    if (settled) this.totals.settledMicros += micros;
    this.record({
      ...base,
      reservation,
      model: servedModel,
      maxTokens,
      reservedMicros: bound,
      status: f.status,
      usage: usage ?? reader?.usage() ?? null,
      settledMicros: settled ? micros : 0,
      settlement: settled ? settlement : 'unsettled',
      ms: Date.now() - started,
      ...(settlement !== 'usage' && final.problem !== null ? { note: final.problem } : {}),
    });
  }

  /** Settles with retries while the ledger is down; false when it never got through (left at the reservation). */
  private async settle(reservation: ReservationId, micros: number, retry?: { readonly attempts: number; readonly delayMs: number }): Promise<boolean> {
    const attempts = retry?.attempts ?? this.opts.settleRetry?.attempts ?? 10;
    let delay = retry?.delayMs ?? this.opts.settleRetry?.delayMs ?? 1_000;
    for (let i = 1; ; i++) {
      try {
        await this.opts.ledger.settle(reservation, micros);
        return true;
      } catch (e) {
        if (!(e instanceof SpendLedgerDown) || i >= attempts) return false;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private forward(req: IncomingMessage, res: ServerResponse, body: Buffer, readUsage: boolean): Promise<Forwarded> {
    return new Promise((resolve) => {
      const target = new URL(req.url ?? '/', this.upstream);
      const tls = target.protocol === 'https:';
      const mod = tls ? https : http;
      let sent = false;
      let responded = false;
      let done = false;
      let reader: UsageReader | null = null;
      let status = 502;
      const finish = (complete: boolean): void => {
        if (done) return;
        done = true;
        if (reader !== null) {
          reader.complete = complete;
          reader.end();
        }
        resolve({ status, reader, sent, responded });
      };
      const up = mod.request(target, { method: req.method ?? 'GET', headers: forwardHeaders(req.headers, target.host, body.length) }, (ur) => {
        responded = true;
        status = ur.statusCode ?? 502;
        if (readUsage) reader = new UsageReader(ur.headers['content-type']);
        res.writeHead(status, responseHeaders(ur.headers));
        ur.on('data', (c: Buffer) => {
          reader?.push(c);
          if (!res.write(c)) {
            ur.pause();
            res.once('drain', () => ur.resume());
          }
        });
        ur.on('end', () => {
          res.end();
          finish(true);
        });
        ur.on('error', () => {
          res.destroy();
          finish(false);
        });
        ur.on('aborted', () => {
          res.destroy();
          finish(false);
        });
      });
      // the request can reach the service only once the connection (and the TLS session) exists
      up.on('socket', (s: Socket) => {
        const ready = (): void => {
          sent = true;
        };
        if (tls) {
          // a reused keep-alive session has completed (and verified) its handshake already
          if (!s.connecting && (s as Socket & { authorized?: boolean }).authorized === true) ready();
          else s.once('secureConnect', ready);
        } else if (!s.connecting) ready();
        else s.once('connect', ready);
      });
      up.on('error', (e: Error) => {
        if (!res.headersSent) apiError(res, 502, 'api_error', `upstream: ${e.message}`);
        else res.destroy();
        finish(false);
      });
      res.on('close', () => {
        if (!done) {
          up.destroy();
          finish(false);
        }
      });
      up.end(body);
    });
  }

  /** Resolves once every request received so far has been answered, settled and logged. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stops accepting requests; waits (bounded) for requests in flight to finish and settle. */
  async close(timeoutMs = 30_000): Promise<void> {
    // keep-alive connections would hold server.close() open: idle ones go now, busy ones
    // after their request finished (or the timeout)
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeIdleConnections();
    let t: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
    if (t !== undefined) clearTimeout(t);
    this.server.closeAllConnections();
    for (const s of this.sockets) s.destroy();
    await closed;
  }
}
