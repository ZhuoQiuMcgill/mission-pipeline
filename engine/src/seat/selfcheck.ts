// The seat side of the startup self-check (design 9.3 "启动自检（放行测试）"; code review r1
// finding 7). exec/selfcheck.ts holds the evidence record and the gate and the isolation items
// (4, 5, 6, 10); here:
//   - items 1, 2, 3 through a probe session that runs Claude Code exactly as a seat runs
//     (seat/session.ts: same SDK options, same enclosure, same metering proxy) and reads every
//     request the process sends through the proxy:
//       1  a CLAUDE.md with a secret, in the user config directory and in the working
//          directory, never reaches the model;
//       2  after the session has waited (the probe tool sleeps), the tool list is read again
//          and still holds only the program's tools: nothing attached asynchronously;
//       3  the tool list never holds a built-in tool or any other MCP server's tool;
//     Offline (a scripted model service on the loopback, a fake key) these prove the session
//     options; the account connectors that appear only under the real subscription login are
//     proved by the same items in a live run (test/seat-selfcheck-live.test.ts), which the gate
//     requires for 1, 2 and 3;
//   - item 7 against a throwaway ledger service: an unrecognized launch cannot publish; the
//     same launch retrieves its original result by its operation id after handing back;
//   - item 8 (the PM session's monitor is woken by a new notice) and item 9 (metering against
//     the account's own usage) need the PM's session and the account: they run only with a
//     probe supplied by the caller (live), and fail without one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { id, type Generation, type LaunchId, type MissionId } from '../common/ids.ts';
import type { BaseRecord, TerminationProofRecord } from '../common/records.ts';
import { HeadTailCollector } from '../exec/caps.ts';
import { ClaudeCodeEnclosure } from '../exec/enclosure.ts';
import {
  recordSelfCheck,
  runExecSelfCheck,
  toolchainVersions,
  type ExecInstallConfig,
  type SelfCheckMode,
  type SelfCheckRecord,
  type SelfCheckResult,
  type ToolchainVersions,
} from '../exec/selfcheck.ts';
import { LedgerClient, RemoteLedgerError, serveLedger } from '../ledger/ipc.ts';
import { LedgerService, ledgerPaths } from '../ledger/service.ts';
import { prepareCredentials, type SeatCredentialsSpec } from './credentials.ts';
import { SEAT_MCP_SERVER } from './mcpTools.ts';
import type { ModelConfig, SeatModel } from './modelConfig.ts';
import { MeteringProxy, ledgerSpend, type MeteredRequest, type SpendLedger } from './proxy.ts';
import { seatSessionOptions } from './session.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PROGRAM_PREFIX = `mcp__${SEAT_MCP_SERVER}__`;
const PROBE_TOOL = `${PROGRAM_PREFIX}probe_wait`;

// ---------------------------------------------------------------- the probe session

export interface ProbeRequest {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly at: number;
  readonly toolNames: readonly string[];
  /** The request body as sent (for the secret search). */
  readonly body: string;
  readonly reservation: string | null;
  readonly reservedMicros: number;
}

export interface ProbeSession {
  readonly requests: readonly ProbeRequest[];
  readonly secrets: readonly string[];
  /** When the probe tool returned (the tool list read after this is item 2's second look). */
  readonly probeReturnedAt: number | null;
  readonly proxyLog: readonly MeteredRequest[];
  readonly proxyTotals: MeteringProxy['totals'];
  readonly sdkResult: { readonly subtype: string; readonly usage: unknown; readonly totalCostUsd: number | null } | null;
  readonly fatal: string | null;
  readonly error: string | null;
}

export interface ProbeSessionOptions {
  readonly upstream: string;
  readonly credentials: SeatCredentialsSpec;
  readonly model: SeatModel;
  readonly models: ModelConfig;
  /** Item 2: how long the probe tool waits before the session reads its tool list again. */
  readonly waitMs: number;
  readonly install?: Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter'>;
  readonly ledger?: SpendLedger;
  readonly launch?: LaunchId;
  readonly claudeExecutable?: string;
  readonly timeoutMs?: number;
  /** Called when a request is about to be forwarded (after its reservation). */
  readonly onForward?: (r: ProbeRequest) => void | Promise<void>;
}

const NULL_LEDGER: SpendLedger = { reserve: async () => undefined, settle: async () => undefined };

function toolNamesOf(body: string): string[] {
  try {
    const j = JSON.parse(body) as { tools?: { name?: unknown }[] };
    return Array.isArray(j.tools) ? j.tools.map((t) => String(t.name ?? '')) : [];
  } catch {
    return [];
  }
}

/** One short session run exactly as a seat runs, against `upstream`, recording every request. */
export async function runProbeSession(o: ProbeSessionOptions): Promise<ProbeSession> {
  const root = mkdtempSync(join(tmpdir(), 'mp-selfcheck-seat-'));
  const tag = `${process.pid}-${Date.now()}`;
  const secrets = [`SECRET-USER-CLAUDE-MD-${tag}`, `SECRET-PROJECT-CLAUDE-MD-${tag}`, `SECRET-MCP-${tag}`];
  const requests: ProbeRequest[] = [];
  let probeReturnedAt: number | null = null;
  let fatal: string | null = null;
  let error: string | null = null;
  let sdkResult: ProbeSession['sdkResult'] = null;
  let proxy: MeteringProxy | null = null;
  let enclosure: ClaudeCodeEnclosure | null = null;
  const abort = new AbortController();
  try {
    // what must not reach the model: the user's and the project's CLAUDE.md, MCP servers of both
    const seed = join(root, 'seed');
    const project = join(root, 'project');
    mkdirSync(seed);
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(seed, 'CLAUDE.md'), `# Memory\nThe secret word is ${secrets[0]}.\n`);
    writeFileSync(join(seed, '.claude.json'), JSON.stringify({ mcpServers: { 'leak-user': { type: 'stdio', command: '/bin/echo', args: [secrets[2]] } } }));
    writeFileSync(join(project, 'CLAUDE.md'), `# Project\nThe secret word is ${secrets[1]}.\n`);
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'leak-project': { type: 'stdio', command: '/bin/echo', args: [secrets[2]] } } }));
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const creds = prepareCredentials(o.credentials, seed);
    const session = join(root, 'session');
    mkdirSync(session);
    enclosure = await ClaudeCodeEnclosure.create({
      sessionDir: session,
      configBytes: 64 << 20,
      tmpBytes: 64 << 20,
      shmBytes: 4 << 20,
      seedConfigFrom: seed,
      ...(o.install?.agentRuntime !== undefined ? { runtime: o.install.agentRuntime } : {}),
      ...(o.install?.bwrap !== undefined ? { bwrapPath: o.install.bwrap } : {}),
      ...(o.install?.nsenter !== undefined ? { nsenterPath: o.install.nsenter } : {}),
    });
    proxy = await MeteringProxy.start({
      launch: o.launch ?? id<LaunchId>(`selfcheck-${tag}`),
      ledger: o.ledger ?? NULL_LEDGER,
      config: o.models,
      upstream: o.upstream,
      onFatal: (reason, detail) => {
        fatal = `${reason}: ${detail}`;
        abort.abort(new Error(fatal));
      },
      onForward: async (r) => {
        const pr: ProbeRequest = { seq: r.seq, method: r.method, path: r.path, at: Date.now(), toolNames: toolNamesOf(r.body.toString('utf8')), body: r.body.toString('utf8'), reservation: r.reservation, reservedMicros: r.reservedMicros };
        requests.push(pr);
        await o.onForward?.(pr);
      },
    });
    const server = createSdkMcpServer({
      name: SEAT_MCP_SERVER,
      version: '1.0.0',
      tools: [
        tool('probe_wait', 'A self-check tool: waits a moment, then answers ok. Call it exactly once.', {}, async () => {
          await sleep(o.waitMs);
          probeReturnedAt = Date.now();
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        }),
      ],
    });
    const timer = setTimeout(() => abort.abort(new Error('the probe session timed out')), o.timeoutMs ?? 180_000);
    try {
      const q = query({
        prompt: 'This is a self-check. Call the probe_wait tool exactly once. When it has answered, reply with the single word DONE and nothing else.',
        options: seatSessionOptions({
          model: o.model,
          systemPrompt: 'You are a self-check session. Do exactly what the user message says.',
          server,
          toolNames: [PROBE_TOOL],
          maxTurns: 4,
          cwd: project,
          ...(o.claudeExecutable !== undefined ? { claudeExecutable: o.claudeExecutable } : {}),
          abort,
          proxyUrl: proxy.url,
          credentialEnv: creds.env,
          enclosure,
          stderr: new HeadTailCollector(8 * 1024, 8 * 1024),
        }),
      });
      for await (const m of q) {
        if (m.type === 'result') {
          const r = m as SDKResultMessage;
          sdkResult = { subtype: r.subtype, usage: r.usage, totalCostUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null };
        }
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    await proxy.drain();
    return { requests, secrets, probeReturnedAt, proxyLog: [...proxy.log], proxyTotals: { ...proxy.totals }, sdkResult, fatal, error };
  } finally {
    await proxy?.close(5_000).catch(() => undefined);
    await enclosure?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Items 1, 2 and 3 from one probe session (what the process sent through the proxy). */
export function judgeProbeSession(s: ProbeSession, mode: SelfCheckMode, ms: number): SelfCheckResult[] {
  const at = new Date().toISOString();
  const main = s.requests.filter((r) => r.method === 'POST' && r.path.split('?')[0] === '/v1/messages');
  const events = s.requests.map((r) => ({ seq: r.seq, path: r.path, at: r.at, tools: r.toolNames, bytes: r.body.length }));
  const ran = main.length > 0 && s.error === null && s.fatal === null;
  const why = !ran ? `the probe session did not run (${s.error ?? s.fatal ?? 'no model request'})` : null;
  const leaked = s.requests.flatMap((r) => s.secrets.filter((x) => r.body.includes(x)).map((x) => `${x.split('-').slice(0, 3).join('-')} in request ${r.seq}`));
  const item1 = why ?? (leaked.length > 0 ? `the context carried ${leaked.join(', ')}` : null);
  const first = main.find((r) => r.toolNames.length > 0);
  const later = s.probeReturnedAt === null ? [] : main.filter((r) => r.at > (s.probeReturnedAt as number));
  const foreign = (names: readonly string[]): string[] => names.filter((n) => !n.startsWith(PROGRAM_PREFIX));
  const item2 =
    why ??
    (s.probeReturnedAt === null
      ? 'the probe tool never ran, so the tool list was not read again after the wait'
      : later.length === 0
        ? 'no model request after the wait'
        : later.some((r) => foreign(r.toolNames).length > 0 || JSON.stringify([...r.toolNames].sort()) !== JSON.stringify([...(first?.toolNames ?? [])].sort()))
          ? `the tool list changed after the wait: ${JSON.stringify(later.map((r) => r.toolNames))}`
          : null);
  const allForeign = [...new Set(main.flatMap((r) => foreign(r.toolNames)))];
  const item3 =
    why ?? (first === undefined || !first.toolNames.includes(PROBE_TOOL) ? 'the program tool is not in the tool list' : allForeign.length > 0 ? `tools other than the program's: ${allForeign.join(', ')}` : null);
  const res = (item: number, name: string, failure: string | null): SelfCheckResult => ({ item, name, ok: failure === null, detail: failure ?? 'passed', ms, mode, events, at });
  return [
    res(1, 'a CLAUDE.md with a secret does not reach the seat context', item1),
    res(2, 'after a wait the tool list still has no external connection', item2),
    res(3, 'the tool list holds no built-in tool, only the program tools', item3),
  ];
}

// ---------------------------------------------------------------- a scripted model service (offline items 1-3)

/** A loopback stand-in for the model service: the probe tool on the first turn, then DONE. */
export async function startProbeUpstream(): Promise<{ readonly url: string; close(): Promise<void>; failure(): Error | null }> {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      let body: { model?: string; stream?: boolean; messages?: { role?: string; content?: unknown }[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        /* not JSON */
      }
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such endpoint' } }));
        return;
      }
      const answered = JSON.stringify(body.messages ?? []).includes('tool_result');
      const offersProbe = toolNamesOf(Buffer.concat(chunks).toString('utf8')).includes(PROBE_TOOL);
      const block = !answered && offersProbe ? { type: 'tool_use', id: `toolu_probe_${Date.now()}`, name: PROBE_TOOL, input: {} } : { type: 'text', text: 'DONE' };
      const stop = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
      const model = body.model ?? 'unknown';
      if (body.stream === true) {
        const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          [
            ev('message_start', { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model, content: [], usage: { ...usage, output_tokens: 1 } } }),
            ev('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } }),
            ev('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'DONE' },
            }),
            ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
            ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }),
            ev('message_stop', { type: 'message_stop' }),
          ].join(''),
        );
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
      }
    });
  });
  // r7: a listen error (also an asynchronous one) rejects; one after listening is kept and
  // reported by the caller: never an unhandled 'error' event
  let failure: Error | null = null;
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => {
      server.close();
      reject(e);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      server.on('error', (e: Error) => {
        failure ??= e;
      });
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
    failure: () => failure,
  };
}

/** The offline parts of items 1-3: the probe session against the scripted model service. */
export async function checkSessionOffline(o: { readonly models: ModelConfig; readonly install?: ProbeSessionOptions['install']; readonly claudeExecutable?: string }): Promise<SelfCheckResult[]> {
  const t0 = Date.now();
  const up = await startProbeUpstream();
  try {
    const model = Object.keys(o.models.metering.prices)[0] ?? 'claude-haiku-5-5';
    const s = await runProbeSession({
      upstream: up.url,
      credentials: { kind: 'fake-api-key', key: 'sk-ant-api03-selfcheck' },
      model: { provider: 'anthropic', model, maxOutputTokens: 1024 },
      models: o.models,
      waitMs: 1_500,
      ...(o.install !== undefined ? { install: o.install } : {}),
      ...(o.claudeExecutable !== undefined ? { claudeExecutable: o.claudeExecutable } : {}),
      timeoutMs: 120_000,
    });
    const f = up.failure();
    if (f !== null) throw new Error(`the scripted model service failed: ${f.message}`);
    return judgeProbeSession(s, 'offline', Date.now() - t0);
  } finally {
    await up.close();
  }
}

// ---------------------------------------------------------------- item 7

/**
 * 9.3 item 7, against a throwaway ledger service: a launch not recognized by the current
 * generation cannot have its result accepted (published); an unregistered launch cannot hand
 * back at all; after handing back, the same launch retrieves its original result by the same
 * operation id (and a different payload under it is refused).
 */
export async function checkLedgerRecognition(): Promise<SelfCheckResult> {
  const t0 = Date.now();
  const name = 'an unrecognized launch cannot publish; a hand-back is retrieved by its operation id';
  const root = mkdtempSync(join(tmpdir(), 'mp-selfcheck-ledger-'));
  const events: unknown[] = [];
  const svc = new LedgerService({ paths: ledgerPaths(join(root, 'ledger'), join(root, 'control')) });
  let server: Server | null = null;
  let client: LedgerClient | null = null;
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof RemoteLedgerError ? e.code : `error: ${(e as Error).message}`;
    }
  };
  try {
    svc.open();
    server = serveLedger(svc, join(root, 'ledger.sock'));
    // r7: the ledger server's errors (its listen is asynchronous) end the check as a failure
    const serverError = new Promise<never>((_, reject) => (server as Server).on('error', reject));
    void serverError.catch(() => undefined);
    await Promise.race([new Promise<void>((r) => (server as Server).once('listening', () => r())), serverError]);
    client = new LedgerClient(join(root, 'ledger.sock'), 10_000);
    const gen1 = (await client.call('beginGeneration', {})) as Generation;
    const mission = id<MissionId>('selfcheck-mission');
    const launch = id<LaunchId>(`selfcheck-launch-${process.pid}`);
    await client.call('registerLaunch', { op: `reg:${launch}`, gen: gen1, launch, tag: { mission, capabilities: [] } });
    const records: BaseRecord[] = [{ kind: 'claude-code.exit', launch, exit: { code: 0, signal: null } }];
    const first = await client.call('submitPendingResult', { op: `host-result:${launch}`, launch, records });
    const again = await client.call('submitPendingResult', { op: `host-result:${launch}`, launch, records });
    const pending = svc.pendingResults(launch);
    const conflict = await code(client.call('submitPendingResult', { op: `host-result:${launch}`, launch, records: [{ kind: 'claude-code.exit', launch, exit: { code: 1, signal: null } }] }));
    const unknown = await code(client.call('submitPendingResult', { op: 'host-result:never', launch: id<LaunchId>('selfcheck-never-registered'), records }));
    const proof: TerminationProofRecord = { kind: 'termination.proof', launch, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 };
    await client.call('registerProof', proof);
    const gen2 = (await client.call('beginGeneration', {})) as Generation;
    const unrecognized = await code(client.call('dispose', { gen: gen2, launch, disposition: 'accepted', reason: 'selfcheck: not adopted by this generation' }));
    events.push({ first, again, pendingCopies: pending.length, conflict, unknown, unrecognized });
    const problems: string[] = [];
    if (JSON.stringify(first) !== JSON.stringify(again)) problems.push('a retried hand-back did not return the original result');
    if (pending.length !== 1) problems.push(`the retried hand-back is stored ${pending.length} times`);
    if (conflict !== 'OP_CONFLICT') problems.push(`a different payload under the same operation id was ${conflict}`);
    if (unknown !== 'UNKNOWN_LAUNCH') problems.push(`an unregistered launch handing back was ${unknown}`);
    if (unrecognized !== 'UNRECOGNIZED_LAUNCH') problems.push(`publishing an unrecognized launch was ${unrecognized}`);
    return { item: 7, name, ok: problems.length === 0, detail: problems.join('; ') || 'passed', ms: Date.now() - t0, mode: 'offline', events, at: new Date().toISOString() };
  } catch (e) {
    return { item: 7, name, ok: false, detail: `the check could not run: ${(e as Error).message}`, ms: Date.now() - t0, mode: 'offline', events, at: new Date().toISOString() };
  } finally {
    client?.close();
    if (server !== null) await new Promise<void>((r) => (server as Server).close(() => r()));
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- items 8 and 9 (live, with probes supplied by the caller)

export interface PmMonitorProbe {
  /** Raises a new notice where the PM's monitor watches and reports whether (and how fast) it woke. */
  (): Promise<{ readonly ok: boolean; readonly detail: string; readonly events: readonly unknown[] }>;
}

/** 9.3 item 8: the PM session's monitor is woken by a new notice. Needs the PM's session (live). */
export async function checkPmMonitor(probe: PmMonitorProbe | undefined): Promise<SelfCheckResult> {
  const t0 = Date.now();
  const name = "the PM session's monitor is woken by a new notice";
  if (probe === undefined) {
    return { item: 8, name, ok: false, detail: 'no PM monitor probe was supplied: this item needs the PM session (live)', ms: 0, mode: 'live', events: [], at: new Date().toISOString() };
  }
  try {
    const r = await probe();
    return { item: 8, name, ok: r.ok, detail: r.detail, ms: Date.now() - t0, mode: 'live', events: r.events, at: new Date().toISOString() };
  } catch (e) {
    return { item: 8, name, ok: false, detail: (e as Error).message, ms: Date.now() - t0, mode: 'live', events: [], at: new Date().toISOString() };
  }
}

export interface AccountUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface MeteringCheckOptions extends Omit<ProbeSessionOptions, 'ledger' | 'launch' | 'onForward'> {
  /**
   * The account's own usage between two instants (e.g. tokenhud's view of the account's
   * window, measured in a quiet period). Without it item 9 fails: 6.5 "金额模式以实测为前提".
   */
  readonly accountUsage?: (from: number, to: number) => Promise<AccountUsage | null>;
}

/**
 * 9.3 item 9 (live): every model request of the seat goes through the proxy and is reserved in
 * the ledger before it is forwarded; the proxy's count equals the account's own usage (not just
 * the SDK's reading of the same responses); at the limit the request is refused and the seat
 * is ended. Its result decides only the money form of spend_limit.
 */
export async function checkMetering(o: MeteringCheckOptions): Promise<SelfCheckResult> {
  const t0 = Date.now();
  const name = 'metering: every request through the proxy, reserved first, equal to the account usage, refused at the limit';
  const root = mkdtempSync(join(tmpdir(), 'mp-selfcheck-meter-'));
  const svc = new LedgerService({ paths: ledgerPaths(join(root, 'ledger'), join(root, 'control')) });
  let server: Server | null = null;
  const clients: LedgerClient[] = [];
  const events: unknown[] = [];
  const problems: string[] = [];
  try {
    svc.open();
    server = serveLedger(svc, join(root, 'ledger.sock'));
    const client = new LedgerClient(join(root, 'ledger.sock'), 10_000);
    clients.push(client);
    const gen = (await client.call('beginGeneration', {})) as Generation;
    const mission = id<MissionId>(`selfcheck-meter-${process.pid}`);
    const launch = id<LaunchId>(`selfcheck-meter-${process.pid}-1`);
    await client.call('registerLaunch', { op: `reg:${launch}`, gen, launch, tag: { mission, capabilities: [] } });
    const before = Date.now();
    const unreserved: number[] = [];
    const s = await runProbeSession({
      ...o,
      ledger: ledgerSpend(client, launch),
      launch,
      onForward: (r) => {
        if (r.reservation !== null && svc.spendSummary(mission).inflight < r.reservedMicros) unreserved.push(r.seq);
      },
    });
    const afterRun = Date.now();
    const spend = svc.spendSummary(mission);
    const sdk = (s.sdkResult?.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    events.push({ requests: s.proxyLog.map((r) => ({ seq: r.seq, path: r.path, settlement: r.settlement, reserved: r.reservedMicros, settled: r.settledMicros })), totals: s.proxyTotals, sdk, spend, unreserved });
    if (s.error !== null || s.fatal !== null) problems.push(`the session failed: ${s.error ?? s.fatal}`);
    if (s.proxyLog.filter((r) => r.reservation !== null).length === 0) problems.push('no model request went through the proxy');
    if (unreserved.length > 0) problems.push(`requests ${unreserved.join(', ')} were forwarded before their reservation was in the ledger`);
    if (spend.inflight !== 0 || spend.spent !== s.proxyTotals.settledMicros) problems.push(`the ledger (${JSON.stringify(spend)}) and the proxy (${s.proxyTotals.settledMicros}) disagree`);
    if (s.proxyLog.some((r) => r.settlement !== 'usage' && r.settlement !== 'unmetered')) problems.push('a request was not settled by its usage');
    if ((sdk.input_tokens ?? -1) !== s.proxyTotals.inputTokens || (sdk.output_tokens ?? -1) !== s.proxyTotals.outputTokens) {
      problems.push(`the proxy's tokens (${s.proxyTotals.inputTokens} in, ${s.proxyTotals.outputTokens} out) differ from the SDK's (${sdk.input_tokens} in, ${sdk.output_tokens} out)`);
    }
    if (o.accountUsage === undefined) problems.push('no account-side usage source: the proxy is not checked against the account (6.5)');
    else {
      await sleep(5_000);
      const acct = await o.accountUsage(before, afterRun);
      events.push({ account: acct });
      if (acct === null) problems.push('the account-side usage could not be read');
      else if (
        acct.inputTokens !== s.proxyTotals.inputTokens ||
        acct.outputTokens !== s.proxyTotals.outputTokens ||
        acct.cacheReadTokens !== s.proxyTotals.cacheReadTokens ||
        acct.cacheWriteTokens !== s.proxyTotals.cacheWriteTokens
      ) {
        problems.push(`the account's usage ${JSON.stringify(acct)} differs from the proxy's ${JSON.stringify(s.proxyTotals)}`);
      }
    }
    // at the limit: refused before forwarding, the seat ended
    const limited = id<MissionId>(`selfcheck-meter-limit-${process.pid}`);
    const launch2 = id<LaunchId>(`selfcheck-meter-${process.pid}-2`);
    await client.call('setSpendLimit', { op: `limit:${limited}`, mission: limited, micros: 1 });
    await client.call('registerLaunch', { op: `reg:${launch2}`, gen, launch: launch2, tag: { mission: limited, capabilities: [] } });
    const forwarded: number[] = [];
    const s2 = await runProbeSession({ ...o, ledger: ledgerSpend(client, launch2), launch: launch2, onForward: (r) => void (r.reservation !== null && forwarded.push(r.seq)) });
    events.push({ limit: { forwarded, fatal: s2.fatal, log: s2.proxyLog.map((r) => ({ seq: r.seq, settlement: r.settlement, status: r.status })), spend: svc.spendSummary(limited) } });
    if (forwarded.length > 0) problems.push('a request over the limit was forwarded');
    if (s2.fatal === null || !s2.fatal.startsWith('spend-limit')) problems.push(`the seat was not ended at the limit (${s2.fatal ?? 'no fatal'})`);
    return { item: 9, name, ok: problems.length === 0, detail: problems.join('; ') || 'passed', ms: Date.now() - t0, mode: 'live', events, at: new Date().toISOString() };
  } catch (e) {
    return { item: 9, name, ok: false, detail: `the check could not run: ${(e as Error).message}`, ms: Date.now() - t0, mode: 'live', events, at: new Date().toISOString() };
  } finally {
    for (const c of clients) c.close();
    if (server !== null) await new Promise<void>((r) => (server as Server).close(() => r()));
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the offline run

export interface OfflineSelfCheckOptions {
  readonly dir: string;
  readonly models: ModelConfig;
  readonly install?: Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter'>;
  readonly claudeExecutable?: string;
  readonly versions?: ToolchainVersions;
}

/**
 * Runs every item that needs no model (4, 5, 6, 7, 10 and the offline parts of 1-3) and
 * records the evidence for the current versions. Returns the record and whether every item passed.
 */
export async function runOfflineSelfCheck(o: OfflineSelfCheckOptions): Promise<{ readonly record: SelfCheckRecord; readonly results: readonly SelfCheckResult[]; readonly ok: boolean }> {
  const versions = o.versions ?? toolchainVersions(o.claudeExecutable !== undefined ? { claudeExecutable: o.claudeExecutable } : {});
  const results = [
    ...(await checkSessionOffline({ models: o.models, ...(o.install !== undefined ? { install: o.install } : {}), ...(o.claudeExecutable !== undefined ? { claudeExecutable: o.claudeExecutable } : {}) })),
    ...(await runExecSelfCheck(o.install ?? {})),
    await checkLedgerRecognition(),
  ];
  const record = recordSelfCheck(o.dir, versions, results);
  return { record, results, ok: results.every((r) => r.ok) };
}
