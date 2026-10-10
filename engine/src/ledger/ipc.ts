// IPC for the ledger service (6.1: schedulers, seat hosts, supervisors and the
// CLI never write the ledger directly; they send requests to the service).
// Transport: a Unix domain socket, one JSON object per line.
//   request:  {"id": 1, "method": "registerProof", "params": {...}}
//   response: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
// Requests on one connection are answered in order. The service still executes
// everything through its own serial queue, stops first.

import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import type { LoopKind } from '../common/records.ts';
import { LedgerError, REFUSAL_WI, type LedgerErrorCode, type LedgerService, type WorkInstruction } from './service.ts';
import type { LaunchFilter } from './queries.ts';

type P<M extends keyof LedgerService> = LedgerService[M] extends (a: infer A, ...rest: never[]) => unknown ? A : never;

/** The methods exposed over IPC and their parameter shapes. */
export interface LedgerMethods {
  appendRecords: P<'appendRecords'>;
  registerLaunch: P<'registerLaunch'>;
  submitPendingResult: P<'submitPendingResult'>;
  pendingResults: { launch: string };
  registerProof: P<'registerProof'>;
  adopt: P<'adopt'>;
  dispose: P<'dispose'>;
  recordCleanup: P<'recordCleanup'>;
  pendingCleanups: Record<string, never>;
  launchesWithoutCleanup: Record<string, never>;
  cleanupState: { launch: string };
  stop: P<'stop'>;
  drainStops: Record<string, never>;
  releaseStop: { stop: string };
  /** `answer`: the user's WI-12 answer, kept with the cleared pause; `op`: the PM's operation id. Both optional. */
  confirmResume: { op?: string; answer?: string };
  /** 6.4 "再收窄": the narrower stop committed and the old one released in one transaction. */
  narrowStop: P<'narrowStop'>;
  stopInfo: { stop: string };
  authorize: P<'authorize'>;
  markIntentPendingVerify: { intent: string; executor: { pid: number; startTime: string; bootId: string } };
  finishIntent: { intent: string; outcome: 'done' | 'failed'; verified?: { executorGone: boolean; outcomeVerified: boolean } | null };
  intentState: { intent: string };
  /** The evaluator registers for the current scheduler generation, with its process identity (core review r2 F10). */
  beginEvaluator: P<'beginEvaluator'>;
  publish: P<'publish'>;
  commitProofOp: P<'commitProofOp'>;
  /** `op`: one id per failure; a retried call with the same id does not count twice. */
  recordEvaluatorFailure: { op?: string; gen?: number };
  recordEvaluatorSuccess: { epoch?: number };
  evaluatorHealth: Record<string, never>;
  evaluatorInstance: Record<string, never>;
  setEvaluatorFault: { reason: string; gen?: number };
  clearEvaluatorFault: Record<string, never>;
  beginGeneration: Record<string, never>;
  currentGeneration: Record<string, never>;
  setMission: { mission: string; state: 'open' | 'closed' };
  missions: { state?: 'open' | 'closed' | 'all' };
  closeMission: P<'closeMission'>;
  missionCloses: { mission: string };
  markNotice: P<'markNotice'>;
  noticeDeliveries: { notices?: string[] };
  recordPmAction: P<'recordPmAction'>;
  pmAction: { action: string };
  pmActions: { limit?: number; before?: number };
  openLaunches: Record<string, never>;
  dispositionFor: { launch: string };
  proofFor: { launch: string };
  activeStopIds: Record<string, never>;
  publicationFloor: Record<string, never>;
  setSpendLimit: P<'setSpendLimit'>;
  reserveSpend: P<'reserveSpend'>;
  settleSpend: P<'settleSpend'>;
  settleLaunchAtReservation: P<'settleLaunchAtReservation'>;
  spendSummary: { mission: string };
  raiseAlert: P<'raiseAlert'>;
  head: Record<string, never>;
  status: Record<string, never>;
  recordLandingPhase: P<'recordLandingPhase'>;
  /** `loop` is a LoopKind; an unknown kind is refused (BAD_REQUEST). */
  loopState: { lineage: string; loop: LoopKind | (string & {}); failureClass?: string | null };
  recordDelivery: P<'recordDelivery'>;
  /** The user withdrew a delivery: no landing or ref creation of it is authorized again (DELIVERY_NOT_CURRENT). */
  withdrawDelivery: P<'withdrawDelivery'>;
  deliveryInfo: { mission: string; delivery: string };
  currentDelivery: { mission: string };
  intentInfo: { intent: string };
  // The flows' reads (src/flow/RECORDS-NEEDED.md): indexed, paged by `after` (a revision) and `limit` (default 1000, max 10,000).
  flowEvents: { mission: string; line?: string; event?: string; after?: number; limit?: number };
  flowMissions: Record<string, never>;
  recordsByKind: { kinds: string[]; mission?: string; after?: number; limit?: number };
  objectVersion: { object: string };
  judgmentById: { judgment: string };
  landingState: { landing: string };
  unfinishedLandings: Record<string, never>;
  // Queries the scheduler used to read straight from the database (core review r3 follow-up e).
  activeStops: Record<string, never>;
  stopState: { stop: string };
  openIntents: Record<string, never>;
  launches: LaunchFilter;
  missionBlocks: { mission?: string };
  startupDecision: Record<string, never>;
  // 用户原话 (10.1 item 6) and the task queue (4.1).
  recordUserWords: P<'recordUserWords'>;
  latestUserWords: { limit?: number; session?: string };
  queueTask: P<'queueTask'>;
  dequeueTask: P<'dequeueTask'>;
  taskQueue: { mission?: string };
  taskInfo: { task: string };
  recordContinuationCheck: P<'recordContinuationCheck'>;
  recordInstallState: P<'recordInstallState'>;
  installStates: { item?: string };
  dispatchedTasks: { mission?: string; disposed?: boolean };
}

type Method = keyof LedgerMethods;
type Handler = (svc: LedgerService, params: never) => unknown;

const HANDLERS: { readonly [M in Method]: Handler } = {
  appendRecords: (svc, p) => svc.appendRecords(p),
  registerLaunch: (svc, p) => svc.registerLaunch(p),
  submitPendingResult: (svc, p) => svc.submitPendingResult(p),
  pendingResults: (svc, p: LedgerMethods['pendingResults']) => svc.pendingResults(p.launch as never),
  registerProof: (svc, p) => svc.registerProof(p),
  adopt: (svc, p) => svc.adopt(p),
  dispose: (svc, p) => svc.dispose(p),
  recordCleanup: (svc, p) => svc.recordCleanup(p),
  pendingCleanups: (svc) => svc.pendingCleanups(),
  launchesWithoutCleanup: (svc) => svc.launchesWithoutCleanup(),
  cleanupState: (svc, p: LedgerMethods['cleanupState']) => svc.cleanupState(p.launch as never),
  stop: (svc, p) => svc.stop(p),
  drainStops: (svc) => svc.drainStops(),
  releaseStop: (svc, p: LedgerMethods['releaseStop']) => svc.releaseStop(p.stop as never),
  confirmResume: (svc, p: LedgerMethods['confirmResume']) => svc.confirmResume(p ?? {}),
  narrowStop: (svc, p) => svc.narrowStop(p),
  stopInfo: (svc, p: LedgerMethods['stopInfo']) => svc.stopInfo(p.stop as never),
  authorize: (svc, p) => svc.authorize(p),
  markIntentPendingVerify: (svc, p: LedgerMethods['markIntentPendingVerify']) => svc.markIntentPendingVerify(p.intent, p.executor),
  finishIntent: (svc, p: LedgerMethods['finishIntent']) => svc.finishIntent(p.intent, p.outcome, p.verified ?? null),
  intentState: (svc, p: LedgerMethods['intentState']) => svc.intentState(p.intent),
  beginEvaluator: (svc, p) => svc.beginEvaluator(p),
  publish: (svc, p) => svc.publish(p),
  commitProofOp: (svc, p) => svc.commitProofOp(p),
  recordEvaluatorFailure: (svc, p: LedgerMethods['recordEvaluatorFailure']) => svc.recordEvaluatorFailure((p ?? {}) as never),
  recordEvaluatorSuccess: (svc, p: LedgerMethods['recordEvaluatorSuccess']) => svc.recordEvaluatorSuccess(p ?? {}),
  evaluatorHealth: (svc) => svc.evaluatorHealth(),
  setEvaluatorFault: (svc, p: LedgerMethods['setEvaluatorFault']) => svc.setEvaluatorFault(p.reason, p.gen === undefined ? {} : { gen: p.gen as never }),
  clearEvaluatorFault: (svc) => svc.clearEvaluatorFault(),
  beginGeneration: (svc) => svc.beginGeneration(),
  currentGeneration: (svc) => svc.currentGenerationNumber(),
  setMission: (svc, p: LedgerMethods['setMission']) => svc.setMission(p.mission as never, p.state),
  missions: (svc, p: LedgerMethods['missions']) => svc.missions(p ?? {}),
  closeMission: (svc, p) => svc.closeMission(p),
  missionCloses: (svc, p: LedgerMethods['missionCloses']) => svc.missionCloses(p.mission as never),
  markNotice: (svc, p) => svc.markNotice(p),
  noticeDeliveries: (svc, p: LedgerMethods['noticeDeliveries']) => svc.noticeDeliveries(p ?? {}),
  recordPmAction: (svc, p) => svc.recordPmAction(p),
  pmAction: (svc, p: LedgerMethods['pmAction']) => svc.pmAction(p.action),
  pmActions: (svc, p: LedgerMethods['pmActions']) => svc.pmActions(p ?? {}),
  openLaunches: (svc) => svc.openLaunches(),
  dispositionFor: (svc, p: LedgerMethods['dispositionFor']) => svc.dispositionFor(p.launch as never),
  proofFor: (svc, p: LedgerMethods['proofFor']) => svc.proofFor(p.launch as never),
  activeStopIds: (svc) => svc.activeStopIds(),
  publicationFloor: (svc) => svc.publicationFloor(),
  setSpendLimit: (svc, p) => svc.setSpendLimit(p),
  reserveSpend: (svc, p) => svc.reserveSpend(p),
  settleSpend: (svc, p) => svc.settleSpend(p),
  settleLaunchAtReservation: (svc, p) => svc.settleLaunchAtReservation(p),
  spendSummary: (svc, p: LedgerMethods['spendSummary']) => svc.spendSummary(p.mission as never),
  raiseAlert: (svc, p) => svc.raiseAlert(p),
  head: (svc) => svc.head(),
  recordLandingPhase: (svc, p) => svc.recordLandingPhase(p),
  loopState: (svc, p: LedgerMethods['loopState']) => svc.loopState(p.lineage, p.loop as LoopKind, p.failureClass ?? null),
  recordDelivery: (svc, p) => svc.recordDelivery(p),
  withdrawDelivery: (svc, p) => svc.withdrawDelivery(p),
  deliveryInfo: (svc, p: LedgerMethods['deliveryInfo']) => svc.deliveryInfo(p.mission as never, p.delivery),
  currentDelivery: (svc, p: LedgerMethods['currentDelivery']) => svc.currentDelivery(p.mission as never),
  intentInfo: (svc, p: LedgerMethods['intentInfo']) => svc.intentInfo(p.intent),
  flowEvents: (svc, p: LedgerMethods['flowEvents']) => svc.flowEvents(p as never),
  flowMissions: (svc) => svc.flowMissions(),
  recordsByKind: (svc, p: LedgerMethods['recordsByKind']) => svc.recordsByKind(p as never),
  objectVersion: (svc, p: LedgerMethods['objectVersion']) => svc.objectVersion(p.object),
  judgmentById: (svc, p: LedgerMethods['judgmentById']) => svc.judgmentById(p.judgment),
  landingState: (svc, p: LedgerMethods['landingState']) => svc.landingState(p.landing),
  unfinishedLandings: (svc) => svc.unfinishedLandings(),
  activeStops: (svc) => svc.activeStops(),
  stopState: (svc, p: LedgerMethods['stopState']) => svc.stopState(p.stop as never),
  openIntents: (svc) => svc.openIntents(),
  launches: (svc, p: LedgerMethods['launches']) => svc.launches(p ?? {}),
  missionBlocks: (svc, p: LedgerMethods['missionBlocks']) => svc.missionBlocks(p.mission === undefined ? {} : { mission: p.mission as never }),
  startupDecision: (svc) => svc.startupDecision(),
  recordUserWords: (svc, p) => svc.recordUserWords(p),
  latestUserWords: (svc, p: LedgerMethods['latestUserWords']) => svc.latestUserWords(p ?? {}),
  queueTask: (svc, p) => svc.queueTask(p),
  dequeueTask: (svc, p) => svc.dequeueTask(p),
  taskQueue: (svc, p: LedgerMethods['taskQueue']) => svc.taskQueue(p.mission === undefined ? {} : { mission: p.mission as never }),
  taskInfo: (svc, p: LedgerMethods['taskInfo']) => svc.taskInfo(p.task),
  recordContinuationCheck: (svc, p) => svc.recordContinuationCheck(p),
  recordInstallState: (svc, p) => svc.recordInstallState(p),
  installStates: (svc, p: LedgerMethods['installStates']) => svc.installStates(p ?? {}),
  dispatchedTasks: (svc, p: LedgerMethods['dispatchedTasks']) => svc.dispatchedTasks((p ?? {}) as never),
  evaluatorInstance: (svc) => svc.evaluatorInstance(),
  status: (svc) => svc.status(),
};

/**
 * Bounds on what one client can make the service hold before it parses or
 * answers anything (core review r3 #22): a request line is at most
 * `maxLineBytes`; at most `maxPending` requests of one connection wait for their
 * turn (reading pauses until answers drain); answers wait for the socket to
 * drain; at most `maxConnections` clients.
 */
export interface IpcLimits {
  readonly maxLineBytes: number;
  readonly maxPending: number;
  readonly maxConnections: number;
}

export const DEFAULT_IPC_LIMITS: IpcLimits = { maxLineBytes: 8 * 1024 * 1024, maxPending: 32, maxConnections: 64 };

/** Serve the ledger service on a Unix socket. Returns the server; close it to stop. */
export function serveLedger(svc: LedgerService, socketPath: string, limits: Partial<IpcLimits> & { onPending?: (n: number) => void } = {}): Server {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const l: IpcLimits = { ...DEFAULT_IPC_LIMITS, ...limits };
  const server = createServer((sock) => handleConnection(svc, sock, l, limits.onPending));
  server.maxConnections = l.maxConnections;
  server.listen(socketPath);
  return server;
}

function handleConnection(svc: LedgerService, sock: Socket, limits: IpcLimits, onPending?: (n: number) => void): void {
  let buf = '';
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  sock.setEncoding('utf8');
  const refuse = (message: string): void => {
    if (!sock.destroyed) sock.end(JSON.stringify({ id: null, ok: false, error: { code: 'TOO_LARGE', message, wi: REFUSAL_WI.TOO_LARGE } }) + '\n');
    sock.destroy();
  };
  // Take complete lines while fewer than maxPending wait; the rest stays buffered and the socket paused.
  const take = (): void => {
    let nl: number;
    while (pending < limits.maxPending && (nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) return refuse(`a request line is at most ${limits.maxLineBytes} bytes`);
      if (!line.trim()) continue;
      pending++;
      onPending?.(pending);
      // Answer in order on this connection.
      chain = chain
        .then(() => answer(svc, sock, line))
        .finally(() => {
          pending--;
          if (!sock.destroyed) take();
        });
    }
    if (pending >= limits.maxPending) sock.pause();
    else if (sock.isPaused() && !sock.destroyed) sock.resume();
    const tail = buf.lastIndexOf('\n') === -1 ? buf : buf.slice(buf.lastIndexOf('\n') + 1);
    if (Buffer.byteLength(tail, 'utf8') > limits.maxLineBytes) refuse(`a request line is at most ${limits.maxLineBytes} bytes`);
  };
  sock.on('data', (chunk: string) => {
    buf += chunk;
    take();
  });
  sock.on('error', () => sock.destroy());
}

async function answer(svc: LedgerService, sock: Socket, line: string): Promise<void> {
  let id: unknown = null;
  let out: string;
  try {
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      throw new LedgerError('BAD_REQUEST', 'the request is not JSON');
    }
    id = req.id ?? null;
    if (typeof req.method !== 'string' || !Object.hasOwn(HANDLERS, req.method)) {
      throw new LedgerError('BAD_REQUEST', `unknown method ${String(req.method)}`);
    }
    const result = await HANDLERS[req.method as Method](svc, (req.params ?? {}) as never);
    out = JSON.stringify({ id, ok: true, result: result ?? null });
  } catch (e) {
    // Every refusal keeps its own code and WI; anything else is a defect inside the service, not a bad request (core review r3 #18).
    const code: LedgerErrorCode = e instanceof LedgerError ? e.code : 'INTERNAL_ERROR';
    const wi = e instanceof LedgerError ? e.wi : REFUSAL_WI.INTERNAL_ERROR;
    const message = e instanceof Error ? e.message : String(e);
    out = JSON.stringify({ id, ok: false, error: { code, message, wi } });
  }
  if (sock.destroyed) return;
  if (!sock.write(out + '\n')) await new Promise<void>((r) => {
    sock.once('drain', () => r());
    sock.once('close', () => r());
  });
}

/** Error returned by the remote service, with the service's error code and the PM's work instruction for it (3.11). */
export class RemoteLedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly wi: WorkInstruction | null;
  constructor(code: LedgerErrorCode, message: string, wi?: WorkInstruction | null) {
    super(message);
    this.name = 'RemoteLedgerError';
    this.code = code;
    this.wi = wi === undefined ? (REFUSAL_WI[code] ?? null) : wi;
  }
}

/** Errors meaning "the service could not be reached or did not answer": retryable. */
export class LedgerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerUnavailable';
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

/**
 * A client. Concurrent first calls share one connection attempt; each
 * connection has its own buffer and outstanding requests, so a closing old
 * connection only fails the requests sent on it (core review r1 #23).
 */
export class LedgerClient {
  private conn: Conn | null = null;
  private connecting: Promise<Conn> | null = null;
  private nextId = 1;
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 10_000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  private connect(): Promise<Conn> {
    if (this.conn && !this.conn.sock.destroyed) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    const attempt = new Promise<Conn>((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      const conn: Conn = { sock, buf: '', waiting: new Map() };
      let connected = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => {
        connected = true;
        this.conn = conn;
        resolve(conn);
      });
      sock.on('error', (e) => {
        failAll(conn, new LedgerUnavailable(e.message));
        if (!connected) reject(new LedgerUnavailable(e.message));
      });
      sock.on('close', () => {
        failAll(conn, new LedgerUnavailable('connection closed'));
        if (this.conn === conn) this.conn = null;
      });
      sock.on('data', (chunk: string) => onData(conn, chunk));
    });
    this.connecting = attempt;
    const clear = (): void => {
      if (this.connecting === attempt) this.connecting = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  async call<M extends Method>(method: M, params: LedgerMethods[M]): Promise<unknown> {
    const conn = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.waiting.delete(id);
        reject(new LedgerUnavailable(`${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      conn.waiting.set(id, { resolve, reject, timer });
      conn.sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.conn?.sock.end();
    this.conn = null;
  }
}

function onData(conn: Conn, chunk: string): void {
  conn.buf += chunk;
  let nl: number;
  while ((nl = conn.buf.indexOf('\n')) !== -1) {
    const line = conn.buf.slice(0, nl);
    conn.buf = conn.buf.slice(nl + 1);
    let msg: { id: number; ok: boolean; result?: unknown; error?: { code: LedgerErrorCode; message: string; wi?: WorkInstruction | null } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      continue;
    }
    const w = conn.waiting.get(msg.id);
    if (!w) continue;
    clearTimeout(w.timer);
    conn.waiting.delete(msg.id);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(new RemoteLedgerError(msg.error!.code, msg.error!.message, msg.error!.wi));
  }
}

function failAll(conn: Conn, e: Error): void {
  for (const [, w] of conn.waiting) {
    clearTimeout(w.timer);
    w.reject(e);
  }
  conn.waiting.clear();
}
