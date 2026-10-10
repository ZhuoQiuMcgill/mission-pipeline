// The seat host (design 6.2 "席位宿主", 7.1, 9.3): the process the unit supervisor starts
// into the unit's control layer for one seat launch, for a card of ANY kind of the seat-card
// registry (src/seat/cards/registry.ts): the card's kind names its entry, the entry gives the
// one-page definition, the first message, the hand-back's shape and rules, the records it
// becomes and the tool profile; the entry's seat names the model (model_config.json, 9.4). It
//   - refuses to start the seat without a passing startup self-check for the versions in use
//     (9.3; code review r1 finding 7): a system alert with WI-18, an environment failure;
//   - reads its card from the content store; checks the card's materials whole (hash, pages)
//     before the seat starts (WI-20 when they do not match);
//   - serves the tool profile (seat/profiles.ts): no sandbox at all for 'materials' seats;
//     read_material for cards with materials (the must-read list enforced at hand-back);
//     fetch_url for 'read-web' cards: the host fetches, outside the sandbox, only the card's
//     allowed addresses, each fetch authorized by the ledger as an external action (6.1), within
//     size and time caps, and records each page as evidence (seat/web.ts); a refused fetch is a
//     WI notice and the round goes on;
//   - starts the metering proxy (6.5), the seat's tool sandbox (run layers in the unit) on the
//     writable area admission decided (a capped tmpfs, or the fixed-size image of a large-disk
//     unit; without fuse2fs such a unit does not run: WI-10; finding 5), and the enclosure of
//     the Claude Code process (capped config, /tmp and /dev/shm areas);
//   - runs the seat through the Agent SDK with NO built-in tool, no settings or CLAUDE.md,
//     only the program's typed tools (an in-process MCP server, one serialized entry: one
//     hand-back wins, finding 6), its one-page definition as the system prompt and the card as
//     the first message (seat/session.ts);
//   - writes heartbeats to the control plane and ends the seat through the SDK's abort signal
//     on a stop (SIGTERM from the supervisor, or a covering stop in the control-plane spool),
//     a spend refusal, a ledger outage, or the card's time limit;
//   - stores what the launch leaves STREAMED into the content store, all of it within the
//     card's export caps together (finding 4): the result documents, the Constructor's export
//     (whole or refused), the transcript (cut at what is left, marked incomplete), the tool
//     log (cut likewise); and, for async evidence, the recovery state within its own caps,
//     saved BEFORE the request is accepted (finding 13);
//   - records every run layer and the Claude Code process's end as pending results under its
//     launch (with op ids), plus the Reviewer's judgment and findings, and the records any
//     other kind's accepted hand-back becomes (its entry's records()); writes its outcome to
//     <stateDir>/units/<launch>/outcome.json; and raises every exception as a system alert
//     with its WI (3.11; finding 15): locally first, then in the ledger.
//
// Statuses follow the lifecycle of 6.2 (已交回 | 环境失败 | 席位失败 | 已取消 | 超时), plus
// "needs-evidence" (a hand-back that asks for async evidence, 6.2) and "resource-exceeded"
// (7.1: the export over its cap). The exit code says whether the HOST did its job (0: the
// outcome is written and the pending results are in the ledger; 1: it is not), so that the
// supervisor's "normal exit" check (7.1 check 1) means a complete report, whatever the seat did.

import { type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { writeFileAtomic } from '../common/fsx.ts';
import { contentHash, type ContentHash, type Generation, type LaunchId } from '../common/ids.ts';
import type { BaseRecord, ClaudeCodeExitRecord, ListRef, RunLayerRecord, SeatResultRecord } from '../common/records.ts';
import { ContentStore } from '../ledger/content.ts';
import { LedgerClient } from '../ledger/ipc.ts';
import { stagedStopsInForce, stopCovers } from '../ledger/stops.ts';
import { DeliveringAlertSink, execAlert, type ExecAlertKind } from '../exec/alerts.ts';
import { HeadTailCollector, decodeLossy, utf8Prefix, utf8Suffix } from '../exec/caps.ts';
import { unitCgroupFromEnv, type Cgroup, type ExitStatus } from '../exec/cgroup.ts';
import { completeCleanup, formatCleanupResource, recordIdentities } from '../exec/cleanup.ts';
import { ClaudeCodeEnclosure } from '../exec/enclosure.ts';
import { ExportBudget, exportTempDir, exportTempPath, putEmptyTree, putWithin, type ExportCaps } from '../exec/export.ts';
import { findFuse2fs } from '../exec/platform.ts';
import { runAreaBytesFor, treeAreaBytes } from '../exec/resources.ts';
import { recordEndedByStop } from '../exec/stopcause.ts';
import { submitWithRetry } from '../exec/run-host.ts';
import { ToolSandbox, hostSystemEnvironment, type EnvironmentRoot, type WritableArea } from '../exec/sandbox.ts';
import { seatGatePolicy, selfCheckGate, toolchainVersions, type ExecInstallConfig, type GateVerdict } from '../exec/selfcheck.ts';
import { processIdentity, unitHoldersPath } from '../exec/supervisor.ts';
import { DEFAULT_TOOL_POLICY, ProgramTools, storeWritable } from '../exec/tools.ts';
import { RECOVERY_STATE_FILES, cardLaunch, cardTag, type ReviewerCard } from './card.ts';
import { parseAnyCard, seatCardEntry, type CardRecordContext, type SeatCardEntry } from './cards/index.ts';
import { loginTextChanged, prepareCredentials, type SeatCredentialsSpec } from './credentials.ts';
import { buildSeatServer, type EvidenceRequest } from './mcpTools.ts';
import { DEFAULT_MODEL_CONFIG, loadModelConfig, seatModelFor, type ModelConfig, type SeatModel } from './modelConfig.ts';
import { MaterialShelf, hostCardView, needsSandbox, sandboxPaths, type HostCard } from './profiles.ts';
import { MeteringProxy, ledgerSpend, servedModels, type MeteredRequest, type ProxyFatal, type ProxyTotals } from './proxy.ts';
import { citedEvidence, findingRecords, judgmentRecord, resultDocuments, snapshotFiles, type HandBack, type ReviewerResult, type SnapshotFiles } from './results.ts';
import { seatSessionOptions } from './session.ts';
import { restoreTree } from './tree.ts';
import { allowedBy, fetchAllowed, isTextual, webAllowance, type WebAllowance } from './web.ts';

export const SEAT_HOST_CONFIG_FORMAT = 'mp4.seat-host.v1';

/** The writable area admission decided (exec/resources.ts planUnitArea); the host honours it. */
export type HostArea =
  | { readonly kind: 'tmpfs' }
  /** A fixed-size image created and fully allocated at admission (7.1 step 1), mounted here with fuse2fs. */
  | { readonly kind: 'image'; readonly image: string; readonly mountDir: string };

export interface SeatHostConfig {
  readonly format: typeof SEAT_HOST_CONFIG_FORMAT;
  /** The card's hash in the content store. */
  readonly card: string;
  readonly contentRoot: string;
  readonly ledgerSocket: string;
  readonly controlPlane: string;
  /** Program state directory (outcome, holders and stderr files under units/<launch>/). */
  readonly stateDir: string;
  /** Scratch directory of this host (Linux filesystem); removed by the host at the end. */
  readonly sessionDir: string;
  /** The writable area admission decided (finding 5). Required: the host never picks one itself. */
  readonly area: HostArea;
  /** Where the startup self-check evidence is (9.3). Required: no seat starts without a passing record. */
  readonly selfCheck: {
    readonly dir: string;
    /** Tests only: accept live items recorded as fixtures. Production configurations never set it. */
    readonly acceptFixtures?: boolean;
  };
  /** model_config.json (9.3); default DEFAULT_MODEL_CONFIG. */
  readonly modelConfig?: string;
  /** The model service. Default https://api.anthropic.com. */
  readonly upstream?: string;
  readonly credentials: SeatCredentialsSpec;
  /** The environment commands run on (7.2). Default: the host's system directories (open runs). */
  readonly environment?: EnvironmentRoot;
  readonly install?: Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter' | 'fuse2fs'>;
  readonly enclosure?: { readonly configBytes: number; readonly tmpBytes: number; readonly shmBytes?: number };
  readonly heartbeatMs?: number;
  /** Run without run layers (only outside an execution unit, e.g. diagnostics). */
  readonly allowNoUnit?: boolean;
  /** The Claude Code executable; default: the SDK's own. */
  readonly claudeExecutable?: string;
  /**
   * The scheduler generation that dispatched this launch: the ledger authorizes each web fetch
   * of a 'read-web' seat as an external action of the launch (6.1), which needs it. Without
   * it every fetch is refused (WI notice); nothing else uses it.
   */
  readonly generation?: Generation;
  /**
   * Tests only: modules (absolute paths) that register extra card kinds, imported before the
   * card is read. Production configurations never set it: src/seat/cards/index.ts registers
   * every kind.
   */
  readonly cardModules?: readonly string[];
  /**
   * Tests only: finishingDelayMs delays the finishing phase before the transcript capture (a
   * slow capture); webAllowPrivate lets fetch_url reach a local test server.
   */
  readonly testHooks?: { readonly finishingDelayMs?: number; readonly webAllowPrivate?: boolean };
}

export type HostStatus =
  | 'handed-back'
  | 'needs-evidence'
  | 'seat-failure'
  | 'resource-exceeded'
  | 'cancelled'
  | 'timed-out'
  | 'environment-failure';

/** Why the host ended the seat early, if it did ("wedged": a run's processes outlived it, WI-14). */
export type EndedBy = 'stop' | 'timeout' | 'wedged' | ProxyFatal;

export interface SdkResultSummary {
  readonly subtype: string;
  readonly isError: boolean;
  readonly numTurns: number;
  readonly totalCostUsd: number | null;
  readonly usage: unknown;
  readonly modelUsage: unknown;
}

/** One web page a reading seat fetched (its record in the content store is the evidence). */
export interface WebFetchSummary {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly bytes: number;
  readonly truncated: boolean;
  /** The fetch record (mp4.web-fetch.v1: address, status, headers, body hash). */
  readonly record: ContentHash;
}

export interface SeatHostOutcome {
  readonly format: 'mp4.seat-host-outcome.v1';
  readonly launch: LaunchId;
  /** The card's kind (its `seat` field; also the seat.result record's `seat`). */
  readonly seat: string;
  /** The seat of design 2 the kind belongs to (the model configuration key), when known. */
  readonly seatName: string | null;
  /** The model the seat ran on, and whether model_config.json named it or the default applied. */
  readonly model: { readonly name: string; readonly source: 'config' | 'default' } | null;
  /**
   * The distinct model ids the metering proxy saw in the seat's metered requests (proxy.ts
   * servedModels). Differs from `model.name` for an alias, a dated id, or a retired model that
   * Claude Code redirected to the current model of its family. Absent in older outcomes.
   */
  readonly served?: readonly string[];
  readonly status: HostStatus;
  readonly endedBy: EndedBy | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
  /** The seat's accepted result document (content store). */
  readonly result: ContentHash | null;
  /** The Constructor's export of its writable paths (tree document). */
  readonly export: ContentHash | null;
  /** The audit copy of the config area: transcript and logs (tree document; login excluded). */
  readonly transcript: ContentHash | null;
  /** Why the transcript is cut or missing (7.1 "对话记录不完整"), or null when it is whole. */
  readonly transcriptIncomplete: string | null;
  /** 6.2: the session state a resumed seat continues from (tree document), or null. */
  readonly recoveryState: ContentHash | null;
  /** Which state was kept: the final one, or (over the cap after acceptance) the one saved at acceptance. */
  readonly recoveryStateNote: string | null;
  /** Async evidence requests refused in this round, and why (WI-17: the PM is told from the second on). */
  readonly evidenceRefusals: readonly string[];
  /** Attempts that saved (or began to save) the session state for an evidence request; all share one reserved copy. */
  readonly recoveryStateSaves: number;
  readonly evidenceRequest: ContentHash | null;
  /** 6.2: this round could not continue the earlier session and started a new one. */
  readonly resumeDegraded: string | null;
  readonly claudeExit: ExitStatus | null;
  readonly sdkResult: SdkResultSummary | null;
  readonly metering: ProxyTotals;
  /** The capped log of every tool call's output (7.1). */
  readonly toolLog: ContentHash | null;
  /** Why the tool log is cut or missing, or null when it is whole. */
  readonly toolLogIncomplete: string | null;
  /** What the launch stored against its export caps. */
  readonly exportUsed: { readonly bytes: number; readonly entries: number; readonly objects: number; readonly index: number };
  /** The writable area the seat ran on. */
  readonly area: HostArea['kind'] | null;
  /** The startup self-check record (version key) the seat started under. */
  readonly selfCheck: string | null;
  /** The seat's copy of the login changed (a refresh happened inside the seat). */
  readonly loginChanged: boolean;
  /** Every path the Claude Code process left in its config, tmp and shm areas (§14 item 1). */
  readonly claudeWrites: readonly string[];
  readonly claudeWritesComplete: boolean;
  /** Op ids of the pending results this host submitted. */
  readonly pendingResults: readonly string[];
  /** Material pages the seat read (`${material}#${page}`). */
  readonly materialsRead: readonly string[];
  /** Web pages the seat had fetched, each recorded as evidence. */
  readonly webFetches: readonly WebFetchSummary[];
  /** Fetches refused (address, redirect or authorization), with why. */
  readonly webRefusals: readonly string[];
  /** Fetch authorizations the host could not finish in the ledger (they stay "result undetermined", 6.1). */
  readonly webUnsettled: readonly string[];
  /** Why the seat was never started, with the WI the host raised (null: it was started, or the host failed). */
  readonly notStarted?: { readonly cause: 'self-check' | 'resource-blocked' | 'card-materials'; readonly wi: 'WI-10' | 'WI-18' | 'WI-20' } | null;
}

export function outcomePath(stateDir: string, launch: LaunchId): string {
  return join(stateDir, 'units', launch, 'outcome.json');
}

export function heartbeatPath(controlPlane: string, launch: LaunchId): string {
  return join(controlPlane, 'heartbeats', `${launch}.json`);
}

/**
 * Room the session state must leave below the recovery cap when async evidence is asked for:
 * the turn that hands it back (the tool result and the seat's last words) still adds to it.
 */
export const RECOVERY_MARGIN_BYTES = 256 * 1024;
export const RECOVERY_MARGIN_FILES = 16;
const MAX_LISTED_WRITES = 20_000;

/** WI-15: the default action differs by cause (v42 6.2, 6.3, 7.1). */
const ATTEMPT_DEFAULT: Readonly<Record<'environment-failure' | 'seat-failure' | 'resource-exceeded', string>> = {
  'environment-failure': 'reported as a pending result and not accepted; the scheduler re-dispatches it, counted in the 6.5 environment-failure retries',
  'resource-exceeded': 'reported as a pending result and not accepted; not re-dispatched as it is (it would exceed again): the task needs a decision (larger declaration or export cap, or a smaller task)',
  'seat-failure': 'reported as a pending result and not accepted; the task needs a decision (restart, change the card, or escalate), counted in the 6.5 restarts',
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Claude Code's message when the selected model does not exist or the login has no access to it. */
export const MODEL_UNAVAILABLE_TEXT = /issue with the selected model|may not exist or you may not have access/i;

/**
 * WI-09 "a seat's model not available": the seat's model is retired or not in this login's plan.
 * Recognized by Claude Code's message in the SDK failure, or (a second signal) by the last
 * metered request answered HTTP 404 with a not_found_error. Returns the message to report, or
 * null when neither signal is there.
 */
export function modelUnavailable(failure: string | null, log: readonly MeteredRequest[]): string | null {
  if (failure !== null && MODEL_UNAVAILABLE_TEXT.test(failure)) return failure;
  const last = [...log].reverse().find((r) => r.reservation !== null);
  if (last !== undefined && last.status === 404 && last.errorType === 'not_found_error') {
    return failure ?? `the model service answered HTTP 404 (not_found_error) for model ${last.model ?? '(unknown)'}`;
  }
  return null;
}

export function parseSeatHostConfig(x: unknown): SeatHostConfig {
  const c = x as Partial<SeatHostConfig> | null;
  if (c === null || typeof c !== 'object' || c.format !== SEAT_HOST_CONFIG_FORMAT) throw new TypeError('not a seat host config');
  for (const k of ['card', 'contentRoot', 'ledgerSocket', 'controlPlane', 'stateDir', 'sessionDir'] as const) {
    if (typeof c[k] !== 'string' || c[k] === '') throw new TypeError(`seat host config: ${k} is required`);
  }
  if (c.credentials === undefined) throw new TypeError('seat host config: credentials is required');
  const a = c.area as Partial<{ kind: string; image: string; mountDir: string }> | undefined;
  if (a === undefined || (a.kind !== 'tmpfs' && a.kind !== 'image')) throw new TypeError('seat host config: area (the writable area admission decided) is required');
  if (a.kind === 'image' && (typeof a.image !== 'string' || !a.image.startsWith('/') || typeof a.mountDir !== 'string' || !a.mountDir.startsWith('/'))) {
    throw new TypeError('seat host config: an image area needs absolute image and mountDir paths');
  }
  if (c.selfCheck === undefined || typeof c.selfCheck.dir !== 'string' || !c.selfCheck.dir.startsWith('/')) {
    throw new TypeError('seat host config: selfCheck.dir (the startup self-check evidence) is required');
  }
  return c as SeatHostConfig;
}

export function readSeatHostOutcome(stateDir: string, launch: LaunchId): SeatHostOutcome | null {
  try {
    return JSON.parse(readFileSync(outcomePath(stateDir, launch), 'utf8')) as SeatHostOutcome;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** A card of any registered kind, parsed by its kind's schema. */
export type AnyCard = { readonly seat: string } & Record<string, unknown>;

/** Tests only: imports the config's extra card modules (they register their kinds). */
export async function loadCardModules(config: SeatHostConfig): Promise<void> {
  for (const m of config.cardModules ?? []) {
    if (!isAbsolute(m)) throw new Error(`seat host config: card module ${m} is not an absolute path`);
    await import(pathToFileURL(m).href);
  }
}

/** Reads the card a host config names (host-main uses it to report a failure under the right launch). */
export function loadCard(config: SeatHostConfig): AnyCard {
  const content = new ContentStore(config.contentRoot);
  return parseAnyCard(JSON.parse(content.get(contentHash(config.card)).toString('utf8')));
}

/** The recovery state's caps (6.2): its own budget, reserved at dispatch. */
export function recoveryCaps(card: { readonly limits: { readonly recoveryStateBytes: number; readonly recoveryStateFiles?: number | undefined } }): ExportCaps {
  return { maxLogicalBytes: card.limits.recoveryStateBytes, maxFiles: card.limits.recoveryStateFiles ?? RECOVERY_STATE_FILES };
}

/** Runs one seat launch to its end; returns the host's exit code. */
export async function runSeatHost(config: SeatHostConfig, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const content = new ContentStore(config.contentRoot);
  await loadCardModules(config);
  const card = loadCard(config);
  const entry = seatCardEntry(card.seat);
  const view = hostCardView(card);
  const launch = cardLaunch(view);
  const envLaunch = env['MP_LAUNCH_ID'];
  if (envLaunch !== undefined && envLaunch !== launch) throw new Error(`the card is for launch ${launch}, the unit runs ${envLaunch}`);
  const models: ModelConfig = config.modelConfig !== undefined ? loadModelConfig(config.modelConfig) : DEFAULT_MODEL_CONFIG;
  // 9.4: the model per seat of design 2 (the entry's seat), not per card kind
  const seatModel = seatModelFor(models, entry.seat);
  if (seatModel === null) throw new Error(`model_config.json names no model for the ${entry.seat} seat (card kind ${card.seat})`);
  mkdirSync(join(config.stateDir, 'units', launch), { recursive: true, mode: 0o700 });
  mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });

  const host = new SeatHostRun(config, content, { card, entry, view }, launch, models, seatModel, env);
  try {
    return await host.run();
  } catch (e) {
    await host.fail((e as Error).message).catch(() => undefined);
    throw e;
  } finally {
    await host.dispose();
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Cuts a text to `max` bytes, keeping its head and its tail with a marker; null when not even the marker fits. */
function fitText(text: string, max: number): { readonly text: string; readonly cut: boolean } | null {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, cut: false };
  const marker = `\n[log cut to the launch's export allowance: original ${buf.length} bytes]\n`;
  const room = max - Buffer.byteLength(marker);
  if (room < 0) return null;
  const head = utf8Prefix(buf, Math.floor(room / 2));
  const tail = utf8Suffix(buf, room - head.length);
  return { text: `${decodeLossy(head)}${marker}${decodeLossy(tail)}`, cut: true };
}

/**
 * The content store as a card entry's records() sees it: every document and id list it stores is
 * charged to the launch's export caps first (finding 4); over the caps, storing throws.
 */
function chargingStore(content: ContentStore, budget: ExportBudget): CardRecordContext['content'] {
  return {
    getList: (ref: ListRef): string[] => content.getList(ref),
    put(doc: string): string {
      if (!budget.charge({ bytes: Buffer.byteLength(doc), docs: 1 })) throw new Error(`a ${Buffer.byteLength(doc)}-byte document does not fit in this card's export allowance (${budget.describe()})`);
      return content.put(doc);
    },
    putList(items: readonly string[]): ListRef {
      const bytes = Buffer.byteLength(JSON.stringify(items));
      if (!budget.charge({ index: bytes, docs: 1 })) throw new Error(`a list of ${items.length} ids does not fit in this card's export allowance (${budget.describe()})`);
      return content.putList(items);
    },
  };
}

/** Bytes of page text one fetch_url answer shows (the rest is read with offset, from the record). */
export const WEB_PAGE_WINDOW = 32 * 1024;
/** Distinct pages one launch may have fetched (each is a ledger authorization and an evidence record). */
export const MAX_WEB_FETCHES = 200;

class SeatHostRun {
  private readonly ledger: LedgerClient;
  private readonly abort = new AbortController();
  private readonly alerts: DeliveringAlertSink;
  /** Everything the launch stores counts against the card's export caps together (finding 4). */
  private readonly budget: ExportBudget;
  private readonly tempPath: string;
  private readonly ownDirs: { readonly resources: readonly string[]; readonly roots: readonly string[] };
  private endedBy: EndedBy | null = null;
  private endDetail: string | null = null;
  private phase = 'starting';
  private proxy: MeteringProxy | null = null;
  private sandbox: ToolSandbox | null = null;
  private enclosure: ClaudeCodeEnclosure | null = null;
  private beats: NodeJS.Timeout | null = null;
  private wall: NodeJS.Timeout | null = null;
  private readonly onSignal = (sig: NodeJS.Signals): void => this.end('stop', `${sig}: the supervisor stops the unit`);
  /** Run records whose submission failed, retried at the end. */
  private readonly unsentRuns = new Map<string, RunLayerRecord>();
  private readonly submittedRuns: string[] = [];
  /** How the Claude Code process ended, once it has. */
  private claudeExit: ExitStatus | null = null;
  /** The launch's seat.result is in the ledger (as a pending result). */
  private resultSubmitted = false;
  /** fetch_url: pages already fetched (by requested and final address), served again from their record. */
  private readonly webCache = new Map<string, { readonly summary: WebFetchSummary; readonly body: ContentHash; readonly contentType: string | null; readonly redirects: readonly string[] }>();
  private readonly webFetches: WebFetchSummary[] = [];
  private readonly webRefusals: string[] = [];
  private readonly webUnsettled: string[] = [];
  private webRequests = 0;

  private readonly config: SeatHostConfig;
  private readonly content: ContentStore;
  /** The card as its kind's schema parsed it (what the entry's functions get). */
  private readonly card: AnyCard;
  private readonly entry: SeatCardEntry;
  /** The fields the host reads of any kind (seat/profiles.ts). */
  private readonly view: HostCard;
  private readonly launch: LaunchId;
  private readonly models: ModelConfig;
  private readonly seatModel: { readonly model: SeatModel; readonly source: 'config' | 'default' };
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    config: SeatHostConfig,
    content: ContentStore,
    card: { readonly card: AnyCard; readonly entry: SeatCardEntry; readonly view: HostCard },
    launch: LaunchId,
    models: ModelConfig,
    seatModel: { readonly model: SeatModel; readonly source: 'config' | 'default' },
    env: Readonly<Record<string, string | undefined>>,
  ) {
    this.config = config;
    this.content = content;
    this.card = card.card;
    this.entry = card.entry;
    this.view = card.view;
    this.launch = launch;
    this.models = models;
    this.seatModel = seatModel;
    this.env = env;
    this.ledger = new LedgerClient(config.ledgerSocket);
    this.alerts = new DeliveringAlertSink(config.stateDir, 'seat', { client: this.ledger, content });
    this.budget = new ExportBudget(this.view.limits.export);
    this.tempPath = exportTempPath(content.root, launch);
    // the host's own scratch: created now if the supervisor did not, and bound to its identity,
    // so that removing it at the end can only remove these very directories (r2 finding 1)
    const exportDir = exportTempDir(content.root, launch);
    mkdirSync(exportDir, { recursive: true, mode: 0o700 });
    this.ownDirs = { resources: recordIdentities([`path:${config.sessionDir}`, `path:${exportDir}`], { roots: [config.sessionDir, exportDir] }), roots: [config.sessionDir, exportDir] };
  }

  private end(by: EndedBy, detail: string): void {
    if (this.endedBy !== null) return;
    this.endedBy = by;
    this.endDetail = detail;
    this.abort.abort(new Error(`${by}: ${detail}`));
  }

  /** 3.11: an exception with its WI, the trigger facts and the default action already taken. */
  private raise(kind: ExecAlertKind, detail: string, trigger: Readonly<Record<string, unknown>>, defaultAction: string, key?: string): void {
    void this.alerts.alert(execAlert(kind, this.launch, detail, { launch: this.launch, seat: this.card.seat, mission: this.view.mission, ...trigger }, defaultAction, key));
  }

  private beat(): void {
    const { config, launch, card, view } = this;
    try {
      mkdirSync(join(config.controlPlane, 'heartbeats'), { recursive: true });
      const self = processIdentity(process.pid);
      writeFileAtomic(
        heartbeatPath(config.controlPlane, launch),
        JSON.stringify({ format: 'mp4.heartbeat.v1', launch, seat: card.seat, ...self, at: Date.now(), phase: this.phase, requests: this.proxy?.totals.requests ?? 0 }),
      );
    } catch {
      /* the control plane only speeds things up */
    }
    try {
      const tag = cardTag(view);
      // the spool only (the durable inbox is the ledger's; the supervisor watches the spool too), minus released stops
      const stops = stagedStopsInForce({ inbox: join(config.controlPlane, 'stops', '.no-inbox'), controlPlane: config.controlPlane });
      const covering = stops.find((s) => stopCovers(s.scope, tag));
      if (covering !== undefined && this.endedBy === null) {
        // 6.4: ended because a stop covers it: stopped, not an environment failure (stopcause.ts)
        recordEndedByStop(config.stateDir, launch, { by: 'host', via: 'spool', stops: [covering.stop], detail: `stop ${covering.stop} covers this unit` });
        this.end('stop', `stop ${covering.stop} covers this unit`);
      }
    } catch {
      /* no spool */
    }
  }

  /** The startup self-check gate (9.3): no seat without a passing record for the versions in use. */
  private gate(): GateVerdict {
    const versions = toolchainVersions(this.config.claudeExecutable !== undefined ? { claudeExecutable: this.config.claudeExecutable } : {});
    const v = selfCheckGate(this.config.selfCheck.dir, versions, seatGatePolicy(this.config.selfCheck));
    if (!v.seatsAllowed) {
      this.raise(
        'selfcheck-failed',
        v.reason ?? 'the startup self-check did not pass',
        { versions, key: v.key, missing: v.missing, failed: v.failed, evidence: this.config.selfCheck.dir },
        'the seat was not started; this launch ends as an environment failure; other work that needs no seat continues',
        `selfcheck:${v.key}`,
      );
    }
    return v;
  }

  /** The writable area admission decided; a large-disk unit without fuse2fs or its image is a resource block. */
  private area(): WritableArea | { readonly blocked: string } {
    const a = this.config.area;
    const bytes = this.view.limits.areaBytes;
    if (a.kind === 'tmpfs') return { kind: 'tmpfs', bytes };
    // an installation that names fuse2fs means that one (a broken path is not silently replaced)
    const configured = this.config.install?.fuse2fs;
    const fuse2fs = configured !== undefined ? (isExecutableFile(configured) ? configured : null) : findFuse2fs();
    const missing = [fuse2fs === null ? 'fuse2fs' : null, existsSync('/dev/fuse') ? null : '/dev/fuse'].filter((m): m is string => m !== null);
    let image: string | null = null;
    try {
      const st = statSync(a.image);
      if (!st.isFile()) image = `${a.image} is not a regular file`;
      else if (st.blocks * 512 < st.size) image = `${a.image} is not fully allocated (${st.blocks * 512} of ${st.size} bytes)`;
    } catch (e) {
      image = `${a.image}: ${(e as Error).message}`;
    }
    if (missing.length > 0 || image !== null) {
      const why = `resource-blocked: this large-disk unit needs its image area, and ${[missing.length > 0 ? `this machine lacks ${missing.join(', ')}` : null, image].filter(Boolean).join('; ')} (7.1: no other degradation path)`;
      this.raise(
        'area-unavailable',
        why,
        { areaBytes: bytes, image: a.image, mountDir: a.mountDir, missing, imageProblem: image },
        'the seat was not started (never on a tmpfs in place of the image); this launch ends without running; other work continues',
      );
      return { blocked: why };
    }
    return { kind: 'image', image: a.image, mountDir: a.mountDir, fuse2fs: fuse2fs as string };
  }

  async run(): Promise<number> {
    const { config, content, card, view, entry, launch, models, seatModel } = this;
    const profile = entry.toolProfile;
    process.on('SIGTERM', this.onSignal);
    process.on('SIGINT', this.onSignal);
    this.beat();
    this.beats = setInterval(() => this.beat(), config.heartbeatMs ?? 5_000);
    if (view.limits.wallClockMs !== undefined) this.wall = setTimeout(() => this.end('timeout', "the card's time limit"), view.limits.wallClockMs);

    // ---------------- before anything: the self-check gate, the area admission decided, the materials
    const gate = this.gate();
    if (!gate.seatsAllowed) return this.notStarted(gate.reason ?? 'no passing startup self-check', gate.key, null, { cause: 'self-check', wi: 'WI-18' });
    // a 'materials' seat has no file tool and no shell: no sandbox, no writable area
    let area: WritableArea | null = null;
    if (needsSandbox(profile)) {
      const a = this.area();
      if ('blocked' in a) return this.notStarted(a.blocked, gate.key, null, { cause: 'resource-blocked', wi: 'WI-10' }, 'resource-exceeded');
      area = a;
      // the copies of the writable paths must fit the card's area (7.1): refused up front, with
      // the cause, instead of failing mid-copy as an environment failure
      const paths = sandboxPaths(profile, view);
      if (paths !== null && paths.writablePaths.length > 0) {
        const cap = view.limits.areaBytes;
        const need = treeAreaBytes(paths.snapshot, paths.writablePaths, cap);
        if (need.bytes > cap) {
          const why = `resource-blocked: the writable paths take ${need.complete ? '' : 'more than '}${need.bytes} bytes in the writable area, and the card's area is ${cap} bytes (7.1: the area is capped; nothing runs on an uncapped one). The card needs a larger area (at least ${runAreaBytesFor(need.bytes)} bytes) or a smaller writable scope`;
          this.raise('area-unavailable', why, { areaBytes: cap, needBytes: need.bytes, complete: need.complete, writablePaths: paths.writablePaths }, 'the seat was not started; this launch ends as "resource exceeded" (not retried as it is); other work continues');
          return this.notStarted(why, gate.key, a.kind, { cause: 'resource-blocked', wi: 'WI-10' }, 'resource-exceeded');
        }
      }
    }
    const shelf = new MaterialShelf(content, view.materials ?? []);
    {
      const broken = shelf.check();
      if (broken.length > 0) {
        const why = `the card's materials do not match the content store: ${broken.join('; ')}`;
        this.raise(
          'card-materials-invalid',
          why,
          { problems: broken, materials: shelf.materials.map((m) => ({ id: m.id, ref: m.ref, pages: m.pages })) },
          'the seat was not started (it could never complete its must-read list, or would read other words than the card names); this launch ends as an environment failure; other work continues',
        );
        return this.notStarted(why, gate.key, area?.kind ?? null, { cause: 'card-materials', wi: 'WI-20' });
      }
    }
    const web: WebAllowance | null = profile === 'read-web' ? webAllowance(view.network) : null;

    // ---------------- the metering proxy (6.5)
    const proxy = await MeteringProxy.start({
      launch,
      ledger: ledgerSpend(this.ledger, launch),
      config: models,
      ...(config.upstream !== undefined ? { upstream: config.upstream } : {}),
      onFatal: (reason: ProxyFatal, detail: string) => this.end(reason, detail),
    });
    this.proxy = proxy;

    // ---------------- the tool sandbox (file-tool profiles); run layers recorded as pending results (7.1 check 3)
    let unit: Cgroup | null = null;
    try {
      unit = unitCgroupFromEnv(this.env);
    } catch (e) {
      if (config.allowNoUnit !== true) throw e;
    }
    const mounts = sandboxPaths(profile, view);
    let sandbox: ToolSandbox | null = null;
    if (mounts !== null && area !== null) {
      sandbox = await ToolSandbox.create(
        {
          snapshotDir: mounts.snapshot,
          // 'write': the writable paths (the Constructor's are exported). 'read-rerun': scratch for its
          // rerun commands (never exported). Other read profiles: nothing writable.
          writablePaths: mounts.writablePaths,
          ...(mounts.mountPoint !== undefined ? { mountPoint: mounts.mountPoint } : {}),
          area,
          environment: config.environment ?? hostSystemEnvironment(),
          sessionDir: mkdtempSync(join(config.sessionDir, 'tools-')),
          ...(config.install?.agentRuntime !== undefined ? { runtime: config.install.agentRuntime } : {}),
          ...(config.install?.bwrap !== undefined ? { bwrapPath: config.install.bwrap } : {}),
          ...(config.install?.nsenter !== undefined ? { nsenterPath: config.install.nsenter } : {}),
        },
        {
          // a recorded toolchain tree that is no longer safe to show is left out (W3 release review)
          onToolchainSkipped: (skipped) =>
            this.raise(
              'toolchain-unavailable',
              `toolchain trees left out of the sandbox: ${skipped.map((x) => `${x.src} (${x.reason})`).join('; ')}`,
              { skipped },
              'the sandbox was built without them: commands that need them fail (the failure is reported as usual); run mp install again after fixing the toolchain',
              `${launch}:toolchain`,
            ),
          // r2 finding 5: a run's processes outlived it: the sandbox blocks itself; tell the PM, end the seat
          onWedged: (w) => {
            this.raise(
              'unkillable-processes',
              w.reason,
              { run: w.run, layer: w.layer, pids: w.pids },
              "the sandbox is blocked: no more tool calls, runs, export or hand-back; the seat is ended; the layer stays (its processes keep their memory counted) and is killed again every 5 s; the supervisor ends the unit's processes before its proof",
              `${launch}:wedged:${w.run}`,
            );
            this.end('wedged', w.reason);
          },
          runLayers:
            unit === null
              ? null
              : {
                  unit,
                  launch,
                  record: async (r: RunLayerRecord) => {
                    const op = `run-layer:${launch}:${r.run}`;
                    try {
                      await submitWithRetry(this.ledger, { op, launch, records: [r] }, 3);
                      this.submittedRuns.push(op);
                    } catch {
                      this.unsentRuns.set(op, r);
                    }
                  },
                },
        },
      );
      this.sandbox = sandbox;
    }

    // ---------------- the Claude Code enclosure, seeded with the login (and the resumed state)
    const seed = mkdtempSync(join(config.sessionDir, 'seed-'));
    let resumeDegraded: string | null = null;
    const resume = view.resume;
    if (resume !== undefined) {
      if (resume.state === null) resumeDegraded = 'no recovery state was kept';
      else {
        try {
          // checked against THIS card's recovery caps before anything reaches the host disk (r2 finding 6)
          restoreTree(content, contentHash(resume.state), seed, recoveryCaps(view));
        } catch (e) {
          resumeDegraded = `the recovery state is unusable or over this card's recovery cap (${(e as Error).message})`;
          rmSync(seed, { recursive: true, force: true });
          mkdirSync(seed, { mode: 0o700 });
        }
      }
      if (resumeDegraded !== null) {
        this.raise(
          'recovery-state-degraded',
          resumeDegraded,
          { sessionId: resume.sessionId, state: resume.state },
          'a new session starts with the card and what the ledger holds (the product, the findings, the evidence results); only the conversation is lost (6.2)',
        );
      }
    }
    const creds = prepareCredentials(config.credentials, seed);
    const seedLogin = creds.seedFile !== null ? readFileSync(creds.seedFile, 'utf8') : null;
    let enclosure: ClaudeCodeEnclosure;
    try {
      enclosure = await ClaudeCodeEnclosure.create({
        sessionDir: mkdtempSync(join(config.sessionDir, 'claude-')),
        configBytes: config.enclosure?.configBytes ?? 256 << 20,
        tmpBytes: config.enclosure?.tmpBytes ?? 256 << 20,
        shmBytes: config.enclosure?.shmBytes ?? 16 << 20,
        seedConfigFrom: seed,
        ...(config.install?.agentRuntime !== undefined ? { runtime: config.install.agentRuntime } : {}),
        ...(config.install?.bwrap !== undefined ? { bwrapPath: config.install.bwrap } : {}),
        ...(config.install?.nsenter !== undefined ? { nsenterPath: config.install.nsenter } : {}),
      });
    } finally {
      // the enclosure holds its own copy: the login and the restored state leave the host disk now
      rmSync(seed, { recursive: true, force: true });
    }
    this.enclosure = enclosure;
    // the holders (and an image's fuse2fs) become cleanup resources if they ever outlive the unit (v35)
    const holders = [...(sandbox !== null ? [sandbox.holderPid] : []), enclosure.holderPid, ...(sandbox?.fusePid != null ? [sandbox.fusePid] : [])]
      .map((pid) => processIdentity(pid))
      .filter((i): i is NonNullable<typeof i> => i !== null)
      .map((i) => formatCleanupResource({ kind: 'holder', pid: i.pid, startTime: i.startTime, bootId: i.bootId }));
    writeFileAtomic(unitHoldersPath(config.stateDir, launch), JSON.stringify(holders));

    // ---------------- the seat's tools and hand-back (one serialized entry, finding 6)
    const toolLog = new HeadTailCollector(256 * 1024, 256 * 1024);
    let submitted: { hash: ContentHash; result: HandBack; records: readonly BaseRecord[] } | null = null;
    let evidence: { request: ContentHash; savedState: ContentHash } | null = null;
    const evidenceRefusals: string[] = [];
    const rcaps = recoveryCaps(view);
    /** The state saved before an evidence request is accepted: one reserved copy for every attempt of the round. */
    const acceptanceBudget = new ExportBudget(rcaps);
    let stateSaves = 0;
    const tools =
      sandbox === null
        ? null
        : new ProgramTools(
            sandbox,
            {
              ...DEFAULT_TOOL_POLICY,
              runLimits: { memoryMax: view.limits.run.memoryMax, ...(view.limits.run.pidsMax !== undefined ? { pidsMax: view.limits.run.pidsMax } : {}) },
              runTimeoutMs: view.limits.run.timeoutMs ?? DEFAULT_TOOL_POLICY.runTimeoutMs,
            },
            { runPrefix: 'run' },
          );
    const snapshot: SnapshotFiles = view.workspace !== undefined ? snapshotFiles(view.workspace.snapshot) : { lines: () => null };
    const seatServer = buildSeatServer(card, tools, {
      context: { snapshot },
      blocked: () => sandbox?.wedged?.reason ?? null,
      log: (name, text) => toolLog.push(Buffer.from(`\n### ${name}\n${text}\n`)),
      ...(shelf.materials.length > 0
        ? {
            readMaterial: (id: string, page: number) => {
              const r = shelf.page(id, page);
              if (!r.ok && r.broken !== undefined) {
                this.raise('card-materials-invalid', r.broken, { material: id, page }, 'the page was not served; the seat was told; its must-read list cannot complete, so its hand-back will be refused', `${launch}:material:${id}`);
              }
              return r;
            },
          }
        : {}),
      ...(web !== null ? { fetchUrl: (url: string, offset: number) => this.fetchUrl(web, url, offset) } : {}),
      onSubmit: async (result) => {
        // the records the hand-back becomes first (their documents are charged as they are stored;
        // what was stored stays counted even if the hand-back is then refused)...
        const store = chargingStore(content, this.budget);
        let records: BaseRecord[];
        try {
          // webFetches: not (yet) in the registry's context; a reading entry may cite its pages
          const ctx: CardRecordContext & { readonly webFetches: readonly WebFetchSummary[] } = { launch, content: store, webFetches: this.webFetches };
          records = entry.records(card, result.result, ctx);
        } catch (e) {
          throw new Error(`your result could not be turned into the program's records: ${(e as Error).message}`);
        }
        // ...then every document of the hand-back, charged to the launch's export caps before it is stored
        const docs = resultDocuments(card, launch, result, { webFetches: this.webFetches.map((f) => f.record) });
        const bytes = docs.documents.reduce((n, d) => n + Buffer.byteLength(d), 0);
        const index = docs.lists.reduce((n, d) => n + Buffer.byteLength(d), 0);
        if (!this.budget.charge({ bytes, docs: docs.documents.length + docs.lists.length, index })) {
          throw new Error(`your result is ${bytes} bytes in ${docs.documents.length} documents; this card's export allowance has ${this.budget.describe()}. Shorten it (fewer, shorter findings).`);
        }
        const [first, ...rest] = docs.documents;
        const hash = content.put(first as string);
        for (const d of rest) content.put(d);
        submitted = { hash, result, records };
        return `Recorded as ${hash.slice(0, 12)}.`;
      },
      onEvidenceRequest: async (req: EvidenceRequest) => {
        const refuse = (why: string, facts: Readonly<Record<string, unknown>>): { accepted: false; message: string } => {
          // WI-17: the seat is told; the PM is told when it happens again (the scheduler counts across rounds)
          evidenceRefusals.push(why);
          if (evidenceRefusals.length === 2) {
            this.raise('async-evidence-refused', why, { ...facts, refusals: evidenceRefusals }, 'the request was not accepted and the round goes on: the seat was told to hand back its result or use a synchronous run (6.2)', `${launch}:evidence`);
          }
          return { accepted: false, message: `Not accepted: ${why}. Hand back this round's result with submit_result, or use a synchronous run instead.` };
        };
        // 6.2: the state must fit with room for the turn that hands it back...
        const m = await enclosure.meterState();
        if (m.logicalBytes + RECOVERY_MARGIN_BYTES > rcaps.maxLogicalBytes || m.entries + RECOVERY_MARGIN_FILES > rcaps.maxFiles) {
          return refuse(`your session state is ${m.logicalBytes} bytes in ${m.entries} entries; with a ${RECOVERY_MARGIN_BYTES}-byte margin that is over this card's recovery cap (${rcaps.maxLogicalBytes} bytes, ${rcaps.maxFiles} files)`, { meter: m, caps: rcaps });
        }
        // the request document's allowance first: nothing is saved for a request that cannot be stored
        const doc = JSON.stringify({ format: 'mp4.evidence-request.v1', launch, ...req });
        const docCharge = { bytes: Buffer.byteLength(doc), docs: 1 };
        if (!this.budget.charge(docCharge)) return refuse(`the request does not fit in this card's export allowance (${this.budget.describe()})`, { left: this.budget.used });
        // ...and the state is SAVED, whole, before the request is accepted and the turn ends (r1
        // finding 13), within ONE copy's reservation for all attempts of this round together:
        // a refused or failed attempt's objects stay counted, so they can never add up past the
        // reserved copies (r2 finding 3)
        let saved;
        stateSaves++;
        try {
          saved = await enclosure.storeState(content, acceptanceBudget, this.tempPath);
        } catch (e) {
          this.budget.refund(docCharge);
          return refuse(`the session state could not be saved (${(e as Error).message})`, { error: (e as Error).message, saveAllowanceLeft: acceptanceBudget.used });
        }
        if (!saved.ok) {
          this.budget.refund(docCharge);
          return refuse(`the session state could not be saved whole within its reservation (${saved.status === 'resource-exceeded' ? saved.reason : 'refused'})`, { outcome: saved });
        }
        const request = content.put(doc);
        evidence = { request, savedState: saved.tree };
        return { accepted: true, message: `Evidence request recorded as ${request.slice(0, 12)}; your session state is saved.` };
      },
    });
    const { server, names } = seatServer;

    // ---------------- run the seat
    let child: ChildProcess | null = null;
    let sessionId: string | null = resume?.sessionId ?? null;
    let sdkResult: SdkResultSummary | null = null;
    const stderrTail = new HeadTailCollector(16 * 1024, 16 * 1024);
    let failure: string | null = null;
    const resuming = resume !== undefined && resumeDegraded === null;
    const prompt =
      resume !== undefined && resuming
        ? `The evidence you asked for has run. Results:\n\n${resume.evidence}\n\nContinue from where you were.`
        : (resumeDegraded !== null ? `(This continues an earlier round whose session could not be resumed: ${resumeDegraded}. The card holds what the ledger knows.)\n\n` : '') +
          entry.render(card) +
          (resume !== undefined ? `\n\n## Evidence results from your earlier request\n${resume.evidence}` : '');
    this.phase = 'running';
    try {
      // a stop or a spend refusal during the setup: the seat never starts
      if (this.endedBy !== null) throw new Error(`ended before the seat started (${this.endedBy})`);
      const q = query({
        prompt,
        options: seatSessionOptions({
          model: seatModel.model,
          systemPrompt: entry.definition,
          server,
          toolNames: names,
          maxTurns: view.limits.maxTurns ?? 200,
          cwd: '/',
          ...(resume !== undefined && resuming ? { resumeSessionId: resume.sessionId } : {}),
          ...(config.claudeExecutable !== undefined ? { claudeExecutable: config.claudeExecutable } : {}),
          abort: this.abort,
          proxyUrl: proxy.url,
          credentialEnv: creds.env,
          enclosure,
          stderr: stderrTail,
          onChild: (c) => {
            child = c;
          },
          onExit: (e) => {
            this.claudeExit = e;
          },
        }),
      });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
        if (m.type === 'result') {
          const r = m as SDKResultMessage;
          sessionId = r.session_id;
          sdkResult = {
            subtype: r.subtype,
            isError: r.is_error,
            numTurns: r.num_turns,
            totalCostUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
            usage: r.usage,
            modelUsage: r.modelUsage,
          };
        }
      }
    } catch (e) {
      if (this.endedBy === null) failure = (e as Error).message;
    }
    this.phase = 'finishing';

    // the Claude Code process's end (7.1 check 1)
    const proc = child as ChildProcess | null;
    for (let i = 0; i < 150 && proc !== null && this.claudeExit === null; i++) await sleep(100);
    if (proc !== null && this.claudeExit === null) {
      proc.kill('SIGKILL');
      for (let i = 0; i < 50 && this.claudeExit === null; i++) await sleep(100);
    }
    await proxy.drain();

    // ---------------- what the seat leaves
    const sub = submitted as { hash: ContentHash; result: HandBack; records: readonly BaseRecord[] } | null;
    const ev = evidence as { request: ContentHash; savedState: ContentHash } | null;
    let status: HostStatus;
    let reason: string | null = null;
    /** WI-09: the seat's model is not available to this login (Claude Code's message). */
    let unavailable: string | null = null;
    const endedBy = this.endedBy as EndedBy | null;
    if (endedBy !== null) {
      status = endedBy === 'timeout' ? 'timed-out' : endedBy === 'ledger-down' || endedBy === 'unpriced-model' || endedBy === 'wedged' ? 'environment-failure' : 'cancelled';
      reason = `${endedBy}: ${this.endDetail ?? ''}`;
      if (endedBy === 'spend-limit') {
        this.raise(
          'spend-refused',
          `the metering proxy refused a request at the spend limit: ${this.endDetail ?? ''}`,
          { metering: { ...proxy.totals }, lastRequests: proxy.log.slice(-3) },
          'the request was not forwarded and the seat was ended; no further paid seat starts for this mission until the limit or the plan changes (6.5 budget block)',
        );
      }
    } else if (ev !== null) status = 'needs-evidence';
    else if (sub !== null) status = 'handed-back';
    else {
      const last = proxy.log.at(-1);
      unavailable = modelUnavailable(failure, proxy.log);
      if (unavailable !== null) {
        // still an environment failure (the scheduler's retry loop is unchanged); the reason and
        // the WI-09 notice below say what fixes it: another model for this seat
        status = 'environment-failure';
        reason = `model-unavailable: ${seatModel.model.model}: ${unavailable}`;
      } else if (failure !== null) {
        status = 'environment-failure';
        reason = `the SDK failed: ${failure}`;
      } else if (last !== undefined && (last.status === 401 || last.status === 429 || last.status >= 500)) {
        status = 'environment-failure';
        reason = `the model service failed (HTTP ${last.status})`;
      } else {
        status = 'seat-failure';
        reason = `the seat ended without handing back a result${sdkResult !== null ? ` (${(sdkResult as SdkResultSummary).subtype})` : ''}`;
      }
    }

    // the product first: whole, within the export caps, or refused (7.1). Only kinds whose registry
    // entry says `exportsProduct` (the Constructor) export their writable paths; other 'write' kinds
    // (a blind experiment) write scratch.
    let exportHash: ContentHash | null = null;
    if (status === 'handed-back' && seatCardEntry(card.seat).exportsProduct === true && sandbox !== null) {
      try {
        const out = await storeWritable(sandbox, content, this.budget, this.tempPath);
        if (out.ok) exportHash = out.tree;
        else if (out.status === 'seat-failure') {
          status = 'seat-failure';
          reason = `the writable paths contain repository metadata (${out.refused.join(', ')})`;
        } else {
          status = 'resource-exceeded';
          reason = `the export is over the card's cap: ${out.reason}`;
        }
      } catch (e) {
        status = 'environment-failure';
        reason = `the export failed: ${(e as Error).message}`;
      }
    }

    // §14 item 1: everything the Claude Code process left in its writable places
    const inventory = await enclosure.inventory().catch((e: Error) => ({ paths: [`(inventory failed: ${e.message})`], logicalBytes: 0, complete: false }));
    // the audit copy of the transcript and logs (7.1 "结束时"), login excluded, within what is left
    let transcript: ContentHash | null = null;
    let transcriptIncomplete: string | null = null;
    {
      const delay = config.testHooks?.finishingDelayMs ?? 0;
      if (delay > 0) await sleep(delay);
      try {
        const out = await enclosure.storeTranscript(content, this.budget, this.tempPath);
        if (out.ok) {
          transcript = out.tree;
          transcriptIncomplete = out.incomplete?.reason ?? null;
        } else transcriptIncomplete = out.status === 'resource-exceeded' ? out.reason : 'refused';
      } catch (e) {
        transcriptIncomplete = `the capture failed: ${(e as Error).message}`;
        transcript = putEmptyTree(content, this.budget, transcriptIncomplete);
      }
    }
    // 6.2: the recovery state, whole: the final one if it fits, else the one saved at acceptance
    let recoveryState: ContentHash | null = null;
    let recoveryStateNote: string | null = null;
    if (status === 'needs-evidence' && ev !== null) {
      let finalState: ContentHash | null = null;
      let why = '';
      try {
        const out = await enclosure.storeState(content, rcaps, this.tempPath);
        if (out.ok) finalState = out.tree;
        else why = out.status === 'resource-exceeded' ? out.reason : 'refused';
      } catch (e) {
        why = (e as Error).message;
      }
      if (finalState !== null) recoveryState = finalState;
      else {
        recoveryState = ev.savedState;
        recoveryStateNote = `the final session state was not kept (${why}); the state saved when the request was accepted is the recovery state`;
        this.raise('recovery-state-fallback', recoveryStateNote, { savedState: ev.savedState, caps: rcaps }, 'the next round resumes from the state saved at acceptance (it lacks only the hand-back turn)');
      }
    }
    // the tool log, within what is left (cut, with its head and tail, when it does not fit)
    let toolLogHash: ContentHash | null = null;
    let toolLogIncomplete: string | null = null;
    {
      const log = toolLog.result();
      const fit = this.budget.objects >= 1 ? fitText(log.text, this.budget.bytes) : null;
      if (fit === null) toolLogIncomplete = `no export allowance left for the tool log (${Buffer.byteLength(log.text)} bytes)`;
      else {
        toolLogHash = putWithin(content, this.budget, fit.text);
        if (toolLogHash === null) toolLogIncomplete = 'no export allowance left for the tool log';
        else if (fit.cut) toolLogIncomplete = `cut to the export allowance (${Buffer.byteLength(log.text)} bytes)`;
        else if (log.truncated) toolLogIncomplete = `cut at the log cap (${log.originalBytes} bytes)`;
      }
    }
    const finalLogin = await enclosure.readStateFile('.credentials.json').catch(() => null);
    const changedLogin = loginTextChanged(seedLogin, finalLogin);

    // ---------------- facts to the ledger as pending results under the launch
    const pendingOps: string[] = [...this.submittedRuns];
    let complete = true;
    for (const [op, r] of this.unsentRuns) {
      try {
        await submitWithRetry(this.ledger, { op, launch, records: [r] });
        this.unsentRuns.delete(op);
        pendingOps.push(op);
      } catch (e) {
        complete = false;
        reason = `${reason !== null ? `${reason}; ` : ''}run record ${op} not submitted: ${(e as Error).message}`;
      }
    }
    const exit = this.claudeExit;
    const records: BaseRecord[] = [];
    if (status === 'handed-back' && sub !== null) {
      if (card.seat === 'reviewer') {
        const rc = card as unknown as ReviewerCard;
        const rr = sub.result.result as ReviewerResult;
        records.push(judgmentRecord(rc, rr, content.putList(citedEvidence(rc, rr))));
        records.push(...findingRecords(rc, rr, content, launch));
      }
      // any kind: the records its entry made of the accepted hand-back (5.2, 10.1)
      records.push(...sub.records);
    }
    const seatResult: SeatResultRecord = {
      kind: 'seat.result',
      launch,
      seat: card.seat,
      status,
      result: sub?.hash ?? null,
      export: exportHash,
      transcript,
      recoveryState,
      evidenceRequest: ev?.request ?? null,
    };
    try {
      await this.submitHostResult([...records, seatResult]);
      pendingOps.push(`host-result:${launch}`);
    } catch (e) {
      complete = false;
      reason = `the pending results were not submitted: ${(e as Error).message}`;
      status = 'environment-failure';
      // the facts that let the unit be judged at all, if the ledger takes them now
      if (await this.submitFailureResult().catch(() => false)) pendingOps.push(`host-result:${launch}`);
    }
    const served = servedModels(proxy.log);
    if (unavailable !== null && status === 'environment-failure' && reason?.startsWith('model-unavailable:') === true) {
      // WI-09 instead of the host's WI-15 notice: WI-15's options (retry, restart, change the card)
      // cannot fix it; the scheduler's own WI-15 notice still tells the retry count and exhaustion
      const seatName = entry.seat;
      this.raise(
        'model-unavailable',
        `the ${seatName} seat's model ${seatModel.model.model} is not available to this login: ${unavailable}`,
        { seatName, model: seatModel.model.model, modelSource: seatModel.source, served, message: unavailable, status, reason, claudeExit: exit, lastModelStatus: proxy.log.at(-1)?.status ?? null },
        `the attempt ended as an environment failure; automatic retries fail the same way until this seat's model changes: \`mp model-config set ${seatName}|all --model <a model this login can use>\`; when the lineage is exhausted meanwhile, WI-08`,
      );
    } else if (status === 'environment-failure' || status === 'seat-failure' || status === 'resource-exceeded') {
      this.raise('attempt-failed', `${status}: ${reason ?? ''}`, { status, reason, endedBy, claudeExit: exit, lastModelStatus: proxy.log.at(-1)?.status ?? null }, ATTEMPT_DEFAULT[status]);
    }

    const outcome: SeatHostOutcome = {
      format: 'mp4.seat-host-outcome.v1',
      launch,
      seat: card.seat,
      seatName: entry.seat,
      model: { name: seatModel.model.model, source: seatModel.source },
      served,
      status,
      endedBy,
      reason,
      sessionId,
      result: sub?.hash ?? null,
      export: exportHash,
      transcript,
      transcriptIncomplete,
      recoveryState,
      recoveryStateNote,
      evidenceRefusals,
      recoveryStateSaves: stateSaves,
      evidenceRequest: ev?.request ?? null,
      resumeDegraded,
      claudeExit: exit,
      sdkResult,
      metering: { ...proxy.totals },
      toolLog: toolLogHash,
      toolLogIncomplete,
      exportUsed: this.budget.used,
      area: area?.kind ?? null,
      selfCheck: gate.key,
      loginChanged: changedLogin,
      claudeWrites: inventory.paths.slice(0, MAX_LISTED_WRITES),
      claudeWritesComplete: inventory.complete && inventory.paths.length <= MAX_LISTED_WRITES,
      pendingResults: pendingOps,
      materialsRead: [...seatServer.materialsRead()].sort(),
      webFetches: this.webFetches,
      webRefusals: this.webRefusals,
      webUnsettled: this.webUnsettled,
    };
    if (stderrTail.totalBytes > 0) writeFileSync(join(config.stateDir, 'units', launch, 'claude-stderr.txt'), stderrTail.result().text);
    writeFileAtomic(outcomePath(config.stateDir, launch), `${JSON.stringify(outcome, null, 2)}\n`);
    await this.alerts.flush();
    return complete ? 0 : 1;
  }

  /**
   * fetch_url (7.1 "阅读调查的网页抓取由程序在沙箱外按放行名单代为执行"): only an address the card
   * allows; each fetch is an external action the ledger authorizes for this launch first (6.1:
   * stop restrictions re-checked, the intent persisted) and is finished there after; the page is
   * recorded as evidence (its body and a fetch record, both within the export caps) and served
   * again from that record for later offsets. Refused fetches are a WI notice (once per launch;
   * all of them in the outcome); the round goes on.
   */
  private async fetchUrl(allowance: WebAllowance, url: string, offset: number): Promise<{ readonly ok: boolean; readonly text: string }> {
    const cached = this.webCache.get(url);
    if (cached !== undefined) return { ok: true, text: this.renderPage(cached, offset) };
    const refuse = (why: string, facts: Readonly<Record<string, unknown>> = {}): { ok: false; text: string } => {
      this.webRefusals.push(`${url.slice(0, 300)}: ${why}`);
      if (this.webRefusals.length === 1) {
        this.raise(
          'web-fetch-refused',
          why,
          { url: url.slice(0, 2048), allowed: allowance.rules.map((r) => r.entry), invalidEntries: allowance.invalid, ...facts },
          'the fetch was not made and the seat was told to record "not obtained" for what it needed there; the reading goes on; every refused address is listed in the launch outcome',
          `${this.launch}:web-refused`,
        );
      }
      return { ok: false, text: `Refused: ${why}. Only the addresses on your card can be read; record "not obtained: <why>" for what you needed from it.` };
    };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, text: 'error: not an absolute http(s) address' };
    }
    if (allowedBy(allowance, u) === null) return refuse(`${u.toString().slice(0, 300)} is not an address this card allows`);
    if (this.webRequests >= MAX_WEB_FETCHES) return { ok: false, text: `error: this launch has fetched ${MAX_WEB_FETCHES} pages, the most one reading may; record what you have` };
    const gen = this.config.generation;
    if (gen === undefined) return refuse('the program cannot authorize network access for this launch (the seat host was started without its scheduler generation)');
    this.webRequests++;
    // an external action of this launch (6.1): authorized by the ledger before any byte leaves
    const intent = `web:${createHash('sha256').update(this.launch).digest('hex').slice(0, 16)}:${this.webRequests}:${randomBytes(4).toString('hex')}`;
    try {
      await this.ledger.call('authorize', {
        op: intent,
        gen,
        launch: this.launch,
        intent,
        kind: 'web-fetch',
        domain: intent,
        tag: { mission: this.view.mission, capabilities: [...this.view.capabilities] } as never,
        details: { url: u.toString().slice(0, 2048) },
      });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'STOPPED') {
        this.webRefusals.push(`${url.slice(0, 300)}: a stop restriction covers this unit`);
        return { ok: false, text: 'Refused: a stop restriction covers network access for this unit. End your turn.' };
      }
      return refuse(`the ledger did not authorize the fetch (${typeof code === 'string' ? `${code}: ` : ''}${(e as Error).message})`, { code: code ?? null });
    }
    const out = await fetchAllowed(u.toString(), allowance, { allowPrivate: this.config.testHooks?.webAllowPrivate === true, signal: this.abort.signal });
    try {
      await this.ledger.call('finishIntent', { intent, outcome: out.kind === 'fetched' ? 'done' : 'failed' });
    } catch (e) {
      this.webUnsettled.push(`${intent}: ${(e as Error).message}`);
    }
    if (out.kind === 'refused') return refuse(out.reason);
    if (out.kind === 'failed') return { ok: false, text: `The fetch failed: ${out.reason}. You may try again, or record "not obtained: <why>".` };
    // recorded as evidence: the body, then the fetch record, within the launch's export caps
    const tooBig = `The page (${out.body.length} bytes) does not fit in this card's export allowance (${this.budget.describe()}); it was not kept and cannot be shown. Record "not obtained: <why>" or read a narrower address.`;
    const body = putWithin(this.content, this.budget, out.body);
    if (body === null) return { ok: false, text: tooBig };
    const doc = JSON.stringify({
      format: 'mp4.web-fetch.v1',
      launch: this.launch,
      url: out.url,
      finalUrl: out.finalUrl,
      redirects: out.redirects,
      status: out.status,
      contentType: out.contentType,
      contentEncoding: out.contentEncoding,
      address: out.address,
      bytes: out.body.length,
      truncated: out.truncated,
      body,
      intent,
      ms: out.ms,
      fetchedAt: new Date().toISOString(),
    });
    const record = putWithin(this.content, this.budget, doc);
    if (record === null) return { ok: false, text: tooBig };
    const summary: WebFetchSummary = { url: out.url, finalUrl: out.finalUrl, status: out.status, bytes: out.body.length, truncated: out.truncated, record };
    this.webFetches.push(summary);
    const entry = { summary, body, contentType: out.contentType, redirects: out.redirects };
    this.webCache.set(url, entry);
    this.webCache.set(out.finalUrl, entry);
    return { ok: true, text: this.renderPage(entry, offset) };
  }

  private renderPage(e: { readonly summary: WebFetchSummary; readonly body: ContentHash; readonly contentType: string | null; readonly redirects: readonly string[] }, offset: number): string {
    const s = e.summary;
    const head =
      `fetched ${s.finalUrl} (HTTP ${s.status}, ${e.contentType ?? 'no content type'}, ${s.bytes} bytes${s.truncated ? ', cut at the size cap' : ''}); recorded as web:${s.record}` +
      (e.redirects.length > 0 ? `\nredirected via: ${e.redirects.join(' -> ')}` : '');
    const body = this.content.get(e.body);
    if (!isTextual(e.contentType, body)) return `${head}\nbinary content: not shown (recorded).`;
    if (offset >= body.length && body.length > 0) return `${head}\nno text from byte ${offset}: the page has ${body.length} bytes.`;
    const end = Math.min(body.length, offset + WEB_PAGE_WINDOW);
    const slice = utf8Prefix(body.subarray(offset), end - offset);
    const next = offset + slice.length;
    return `${head}\n--- bytes ${offset}-${next} of ${body.length}\n${decodeLossy(slice)}${next < body.length ? `\n--- more: call fetch_url again with offset=${next}` : ''}`;
  }

  /**
   * The seat was never started: an environment failure (no passing self-check, the card's
   * materials), or, for an area that cannot be had or does not fit, "resource exceeded" (not
   * re-dispatched as it is; code review M2: the acceptance check sees a seat that never ran,
   * not a missing Claude Code exit). The cause and its WI are in the outcome.
   */
  private async notStarted(
    reason: string,
    selfCheck: string | null,
    area: HostArea['kind'] | null,
    notStarted: NonNullable<SeatHostOutcome['notStarted']>,
    status: 'environment-failure' | 'resource-exceeded' = 'environment-failure',
  ): Promise<number> {
    this.phase = 'finishing';
    const submitted = await this.submitFailureResult(status).catch(() => false);
    writeFailedOutcome(this.config.stateDir, this.launch, this.card.seat, reason, submitted ? [`host-result:${this.launch}`] : [], null, { selfCheck, area, seatName: this.entry.seat, notStarted, status });
    await this.alerts.flush();
    return submitted ? 0 : 1;
  }

  /** One batch per launch: the Claude Code exit, the seat's records, and its seat.result. */
  private async submitHostResult(records: readonly BaseRecord[], attempts = 5): Promise<void> {
    const exit = this.claudeExit;
    const all: BaseRecord[] = exit === null ? [...records] : [{ kind: 'claude-code.exit', launch: this.launch, exit } satisfies ClaudeCodeExitRecord, ...records];
    await submitWithRetry(this.ledger, { op: `host-result:${this.launch}`, launch: this.launch, records: all }, attempts);
    this.resultSubmitted = true;
  }

  /** A seat.result saying only "environment failure" (the host could not report the seat), or "resource exceeded" (its area). */
  private async submitFailureResult(status: 'environment-failure' | 'resource-exceeded' = 'environment-failure'): Promise<boolean> {
    if (this.resultSubmitted) return true;
    const rec: SeatResultRecord = {
      kind: 'seat.result',
      launch: this.launch,
      seat: this.card.seat,
      status,
      result: null,
      export: null,
      transcript: null,
      recoveryState: null,
      evidenceRequest: null,
    };
    await this.submitHostResult([rec], 2);
    return true;
  }

  /** The host itself failed: report it to the ledger (best effort) and in the outcome file. */
  async fail(reason: string): Promise<void> {
    const submitted = await this.submitFailureResult().catch(() => false);
    this.raise('attempt-failed', `the host failed: ${reason}`, { reason }, ATTEMPT_DEFAULT['environment-failure']);
    if (readSeatHostOutcome(this.config.stateDir, this.launch) === null) {
      writeFailedOutcome(this.config.stateDir, this.launch, this.card.seat, `the host failed: ${reason}`, submitted ? [`host-result:${this.launch}`] : [], this.claudeExit, { seatName: this.entry.seat });
    }
    await this.alerts.flush();
  }

  async dispose(): Promise<void> {
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
    if (this.beats !== null) clearInterval(this.beats);
    if (this.wall !== null) clearTimeout(this.wall);
    await this.proxy?.close(5_000).catch(() => undefined);
    await this.sandbox?.close().catch(() => undefined);
    await this.enclosure?.close().catch(() => undefined);
    await this.alerts.flush(5_000);
    this.ledger.close();
    try {
      rmSync(heartbeatPath(this.config.controlPlane, this.launch), { force: true });
    } catch {
      /* the control plane only speeds things up */
    }
    // identity-bound removal; what is left (busy, replaced) stays for the unit's cleanup
    await completeCleanup(this.ownDirs.resources, { roots: this.ownDirs.roots }).catch(() => undefined);
  }
}

/** The outcome of a host that failed (or did not start the seat) before it could report: an environment failure. */
export function writeFailedOutcome(
  stateDir: string,
  launch: LaunchId,
  seat: string,
  reason: string,
  pendingResults: readonly string[] = [],
  claudeExit: ExitStatus | null = null,
  extra: {
    readonly selfCheck?: string | null;
    readonly area?: HostArea['kind'] | null;
    readonly seatName?: string | null;
    readonly notStarted?: SeatHostOutcome['notStarted'];
    readonly status?: 'environment-failure' | 'resource-exceeded';
  } = {},
): void {
  const outcome: SeatHostOutcome = {
    format: 'mp4.seat-host-outcome.v1',
    launch,
    seat,
    seatName: extra.seatName ?? null,
    model: null,
    status: extra.status ?? 'environment-failure',
    endedBy: null,
    reason,
    sessionId: null,
    result: null,
    export: null,
    transcript: null,
    transcriptIncomplete: null,
    recoveryState: null,
    recoveryStateNote: null,
    evidenceRefusals: [],
    recoveryStateSaves: 0,
    evidenceRequest: null,
    resumeDegraded: null,
    claudeExit,
    sdkResult: null,
    metering: { requests: 0, metered: 0, refused: 0, reservedMicros: 0, settledMicros: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    toolLog: null,
    toolLogIncomplete: null,
    exportUsed: { bytes: 0, entries: 0, objects: 0, index: 0 },
    area: extra.area ?? null,
    selfCheck: extra.selfCheck ?? null,
    loginChanged: false,
    claudeWrites: [],
    claudeWritesComplete: false,
    pendingResults,
    materialsRead: [],
    webFetches: [],
    webRefusals: [],
    webUnsettled: [],
    notStarted: extra.notStarted ?? null,
  };
  mkdirSync(join(stateDir, 'units', launch), { recursive: true, mode: 0o700 });
  writeFileAtomic(outcomePath(stateDir, launch), `${JSON.stringify(outcome, null, 2)}\n`);
}
