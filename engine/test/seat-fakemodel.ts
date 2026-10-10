// A scripted stand-in for the model service, for offline seat tests: it answers the Messages
// API the way the real service does (SSE when `stream` is set, JSON otherwise) and drives a
// seat's Claude Code process through a fixed sequence of tool calls. Requests that offer the
// seat's submit_result tool are "main" requests and advance the script; anything else (side
// requests Claude Code may make) gets a short text answer.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Record<string, unknown> | null;
  readonly main: boolean;
  /** Assistant messages already in the conversation (the script step for a main request). */
  readonly step: number;
  readonly toolNames: readonly string[];
  readonly system: string;
  /** Every text in the conversation's user turns (tool results included), for assertions. */
  readonly userText: string;
}

export type FakeReply =
  | { readonly kind: 'tool'; readonly name: string; readonly input: unknown; readonly text?: string }
  | { readonly kind: 'text'; readonly text: string }
  /** Never answer (the request stays in flight until the connection closes). */
  | { readonly kind: 'stall' }
  | { readonly kind: 'error'; readonly status: number; readonly type: string; readonly message: string };

export type FakeScript = (req: FakeRequest) => FakeReply;

export interface FakeModel {
  readonly url: string;
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

export const FAKE_USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Record<string, unknown>) => {
      if (b['type'] === 'text') return String(b['text'] ?? '');
      if (b['type'] === 'tool_result') return textOf(b['content']);
      return '';
    })
    .join('\n');
}

function describe(method: string, url: string, headers: IncomingMessage['headers'], raw: Buffer): FakeRequest {
  let body: Record<string, unknown> | null = null;
  try {
    body = raw.length > 0 ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  const tools = Array.isArray(body?.['tools']) ? (body?.['tools'] as Array<{ name?: unknown }>) : [];
  const toolNames = tools.map((t) => String(t.name ?? ''));
  const messages = Array.isArray(body?.['messages']) ? (body?.['messages'] as Array<{ role?: unknown; content?: unknown }>) : [];
  const sys = body?.['system'];
  const system = typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map((b: { text?: unknown }) => String(b.text ?? '')).join('\n') : '';
  return {
    method,
    url,
    headers,
    body,
    main: toolNames.some((n) => n.endsWith('__submit_result')),
    step: messages.filter((m) => m.role === 'assistant').length,
    toolNames,
    system,
    userText: messages
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n'),
  };
}

function sse(model: string, reply: Exclude<FakeReply, { kind: 'stall' } | { kind: 'error' }>, seq: number): string {
  const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  const out = [
    ev('message_start', {
      type: 'message_start',
      message: { id: `msg_fake_${seq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...FAKE_USAGE, output_tokens: 1 } },
    }),
  ];
  let index = 0;
  const text = reply.kind === 'text' ? reply.text : reply.text;
  if (text !== undefined && text !== '') {
    out.push(ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
    out.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }));
    out.push(ev('content_block_stop', { type: 'content_block_stop', index }));
    index++;
  }
  if (reply.kind === 'tool') {
    out.push(ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fake_${seq}`, name: reply.name, input: {} } }));
    out.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } }));
    out.push(ev('content_block_stop', { type: 'content_block_stop', index }));
  }
  out.push(
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: FAKE_USAGE.output_tokens },
    }),
  );
  out.push(ev('message_stop', { type: 'message_stop' }));
  return out.join('');
}

function json(model: string, reply: Exclude<FakeReply, { kind: 'stall' } | { kind: 'error' }>, seq: number): string {
  const content: unknown[] = [];
  const text = reply.kind === 'text' ? reply.text : reply.text;
  if (text !== undefined && text !== '') content.push({ type: 'text', text });
  if (reply.kind === 'tool') content.push({ type: 'tool_use', id: `toolu_fake_${seq}`, name: reply.name, input: reply.input });
  return JSON.stringify({
    id: `msg_fake_${seq}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: FAKE_USAGE,
  });
}

export async function startFakeModel(script: FakeScript): Promise<FakeModel> {
  const requests: FakeRequest[] = [];
  const stalled = new Set<ServerResponse>();
  let seq = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r = describe(req.method ?? 'GET', req.url ?? '', req.headers, Buffer.concat(chunks));
      requests.push(r);
      seq++;
      const path = r.url.split('?')[0] ?? '';
      if (r.method !== 'POST' || path !== '/v1/messages') {
        if (path === '/v1/messages/count_tokens') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 1000 }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fake model: no ${r.method} ${path}` } }));
        return;
      }
      const model = typeof r.body?.['model'] === 'string' ? (r.body['model'] as string) : 'unknown';
      const reply: FakeReply = r.main ? script(r) : { kind: 'text', text: 'ok' };
      if (reply.kind === 'stall') {
        stalled.add(res);
        res.on('close', () => stalled.delete(res));
        return;
      }
      if (reply.kind === 'error') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } }));
        return;
      }
      if (r.body?.['stream'] === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(sse(model, reply, seq));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(json(model, reply, seq));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const r of stalled) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
