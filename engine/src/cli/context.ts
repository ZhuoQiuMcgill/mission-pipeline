// What every command works with: the configuration, clients for the ledger
// service, the scheduler and the evaluator (each created on first use, with the
// configured time limits), the operation journal and the clock.
//
// The CLI never writes the ledger itself (6.1): every write is a request to the
// ledger service. Reads go to the service, to the scheduler or the evaluator, or,
// for layer 2 and while the service is down, read-only to the files (10.2, 6.1).

import { existsSync } from 'node:fs';
import { RpcClient, RpcError, RpcUnavailable } from '../common/rpc.ts';
import { ContentStore } from '../ledger/content.ts';
import { LedgerClient, LedgerUnavailable, RemoteLedgerError, type LedgerMethods } from '../ledger/ipc.ts';
import { ledgerPathsOf, timeoutOf, type CliConfig } from './config.ts';
import { CliError, EXIT, errorMessage } from './errors.ts';
import { OpJournal } from './ops.ts';

export interface CliIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
}

export class Ctx {
  readonly config: CliConfig;
  readonly configPath: string;
  readonly io: CliIo;
  readonly journal: OpJournal;
  private ledgerClient: LedgerClient | null = null;
  private schedClient: RpcClient | null = null;
  private evalClient: RpcClient | null = null;
  private contentStore: ContentStore | null = null;
  /** Clients with their own time limit, closed with the context. */
  private readonly extra: LedgerClient[] = [];

  constructor(config: CliConfig, configPath: string, io: CliIo) {
    this.config = config;
    this.configPath = configPath;
    this.io = io;
    this.journal = new OpJournal(config.stateDir);
  }

  get now(): number {
    return this.io.now();
  }

  ledger(timeoutMs?: number): LedgerClient {
    if (timeoutMs !== undefined) {
      const c = new LedgerClient(this.config.ledgerSocket, timeoutMs);
      this.extra.push(c);
      return c;
    }
    this.ledgerClient ??= new LedgerClient(this.config.ledgerSocket, timeoutOf(this.config, 'ledgerMs'));
    return this.ledgerClient;
  }

  /** A ledger call; a refusal keeps its code and WI, an unreachable service is UNAVAILABLE. */
  async call<M extends keyof LedgerMethods>(method: M, params: LedgerMethods[M], client: LedgerClient = this.ledger()): Promise<unknown> {
    try {
      return await client.call(method, params);
    } catch (e) {
      throw ledgerFailure(method, e);
    }
  }

  /** A ledger read that answers null when the service is unreachable (status while it is down). */
  async tryCall<M extends keyof LedgerMethods>(method: M, params: LedgerMethods[M], client: LedgerClient = this.ledger()): Promise<{ ok: true; value: unknown } | { ok: false; error: CliError }> {
    try {
      return { ok: true, value: await this.call(method, params, client) };
    } catch (e) {
      return { ok: false, error: e instanceof CliError ? e : new CliError('FAILED', errorMessage(e)) };
    }
  }

  scheduler(): RpcClient | null {
    if (this.config.schedulerSocket === null) return null;
    this.schedClient ??= new RpcClient(this.config.schedulerSocket, timeoutOf(this.config, 'schedulerMs'));
    return this.schedClient;
  }

  /** A scheduler RPC; UNAVAILABLE when it is not configured or not running. */
  async sched(method: string, params: unknown = {}): Promise<unknown> {
    const c = this.scheduler();
    if (c === null) throw new CliError('UNAVAILABLE', 'no scheduler RPC socket is configured (schedulerSocket)', { exitCode: EXIT.UNAVAILABLE });
    try {
      return await c.call(method, params);
    } catch (e) {
      if (e instanceof RpcUnavailable) throw new CliError('UNAVAILABLE', `the scheduler did not answer (${method}): ${e.message}`, { exitCode: EXIT.UNAVAILABLE, wi: 'WI-22' });
      if (e instanceof RpcError) throw new CliError(e.code, `the scheduler refused ${method}: ${e.message}`, { exitCode: e.code === 'BAD_REQUEST' ? EXIT.FAILED : EXIT.REFUSED });
      throw e;
    }
  }

  evaluator(): RpcClient | null {
    if (this.config.evaluatorSocket === null || !existsSync(this.config.evaluatorSocket)) return null;
    this.evalClient ??= new RpcClient(this.config.evaluatorSocket, timeoutOf(this.config, 'evaluatorMs'));
    return this.evalClient;
  }

  content(): ContentStore {
    this.contentStore ??= new ContentStore(ledgerPathsOf(this.config).content);
    return this.contentStore;
  }

  close(): void {
    for (const c of this.extra.splice(0)) c.close();
    this.ledgerClient?.close();
    this.schedClient?.close();
    this.evalClient?.close();
  }
}

export function ledgerFailure(method: string, e: unknown): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof RemoteLedgerError) {
    const exit = e.code === 'OP_CONFLICT' ? EXIT.OP_CONFLICT : e.code === 'STORAGE_FAULT' ? EXIT.UNAVAILABLE : e.code === 'INTERNAL_ERROR' ? EXIT.FAILED : EXIT.REFUSED;
    return new CliError(e.code, `the ledger service refused ${method}: ${e.message}`, { exitCode: exit, wi: e.wi });
  }
  if (e instanceof LedgerUnavailable || (e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') {
    return new CliError('UNAVAILABLE', `the ledger service did not answer (${method}): ${errorMessage(e)}`, { exitCode: EXIT.UNAVAILABLE, wi: 'WI-22' });
  }
  return new CliError('FAILED', `${method} failed: ${errorMessage(e)}`, { exitCode: EXIT.FAILED, wi: 'WI-20' });
}
