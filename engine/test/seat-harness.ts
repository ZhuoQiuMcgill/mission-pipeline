// Shared by the seat host tests (offline, test/seat-host.test.ts) and the opt-in live tests
// (test/seat-live.test.ts): a real ledger service, and one seat launch run to its end in a
// real execution unit (transient systemd service + unit supervisor + seat host), with either
// a scripted fake model service or the real one upstream of the metering proxy.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id, type Generation, type LaunchId, type MissionId } from '../src/common/ids.ts';
import type { BaseRecord, TerminationProofRecord } from '../src/common/records.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { LedgerClient, serveLedger } from '../src/ledger/ipc.ts';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { GATE_ITEMS, recordSelfCheck, toolchainVersions, type SelfCheckResult } from '../src/exec/selfcheck.ts';
import { killUnit, launchUnitSupervisor, waitUnitInactive } from '../src/exec/supervisor.ts';
import { seatUnitConfig } from '../src/seat/unit.ts';
import type { SeatCredentialsSpec } from '../src/seat/credentials.ts';
import { heartbeatPath, readSeatHostOutcome, SEAT_HOST_CONFIG_FORMAT, type HostArea, type SeatHostConfig, type SeatHostOutcome } from '../src/seat/host.ts';
import { startFakeModel, type FakeModel, type FakeScript } from './seat-fakemodel.ts';

const SINK_TS = fileURLToPath(new URL('../src/exec/ledgerSink.ts', import.meta.url));

const caps = detectExecCapabilities();
export const UNIT_OK =
  caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids') && caps.bwrapUsable && caps.nsenter !== null;
export const UNIT_SKIP = UNIT_OK ? false : 'needs systemd-run --user with delegated memory and pids controllers, a usable bwrap, and nsenter';

export interface UnitRun {
  readonly launch: LaunchId;
  readonly mission: MissionId;
  readonly state: string;
  readonly control: string;
  readonly snapshot: string;
  readonly unitName: string;
  readonly fake: FakeModel | null;
  /** The host's report (null only when the run allowed a host that died before writing it). */
  readonly outcome: SeatHostOutcome;
  readonly pending: BaseRecord[];
  readonly proof: TerminationProofRecord | null;
  readonly cleanup: string | null;
  readonly phases: readonly string[];
}

export interface RunOptions {
  readonly mission?: MissionId;
  readonly files?: Readonly<Record<string, string>>;
  readonly card: (launch: LaunchId, mission: MissionId, snapshot: string) => Record<string, unknown>;
  /** A scripted fake model; without one, the real model service (or `upstream`) is used. */
  readonly script?: FakeScript;
  readonly upstream?: string;
  readonly credentials?: SeatCredentialsSpec;
  readonly modelConfig?: string;
  readonly before?: (launch: LaunchId, mission: MissionId, dirs: { readonly control: string; readonly state: string }) => Promise<void>;
  readonly during?: (ctx: { launch: LaunchId; mission: MissionId; unitName: string; control: string; state: string; fake: FakeModel | null }) => Promise<void>;
  readonly unitMemoryMax?: number;
  readonly timeoutMs?: number;
  readonly hostConfig?: Partial<SeatHostConfig>;
  /** The writable area admission decided (default: tmpfs). */
  readonly area?: HostArea;
  /** Where the startup self-check evidence is (default: the harness's fixture record). */
  readonly selfCheckDir?: string;
  /** Extra supervisor cleanup resources (e.g. an image and its mount). */
  readonly cleanup?: { readonly fuseMounts?: string[]; readonly images?: string[]; readonly paths?: string[] };
  /** The host may die without a report (a unit killed whole by its memory limit). */
  readonly allowNoOutcome?: boolean;
}

/**
 * Startup self-check evidence for the offline host tests: every gate item recorded as a test
 * fixture (the real offline items run in test/seat-selfcheck.test.ts; the live ones in the
 * opt-in live suite). The hosts accept it only because these tests set acceptFixtures.
 */
export function recordFixtureSelfCheck(dir: string): void {
  const at = new Date().toISOString();
  const items: SelfCheckResult[] = [...GATE_ITEMS, 9].map((item) => ({
    item,
    name: `item ${item}`,
    ok: true,
    detail: 'test fixture for the offline seat host tests (not run)',
    ms: 0,
    mode: 'fixture',
    events: [],
    at,
  }));
  recordSelfCheck(dir, toolchainVersions(), items);
}

export class SeatHarness {
  svc!: LedgerService;
  client!: LedgerClient;
  content!: ContentStore;
  gen!: Generation;
  socketPath = '';
  /** The fixture self-check evidence every run uses unless it names another directory. */
  selfCheckDir = '';
  private server: Server | null = null;
  private readonly dirs: string[] = [];
  private readonly units: string[] = [];
  private readonly fakes: FakeModel[] = [];
  private seq = 0;

  tmp(prefix = 'mp-seat-host-'): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  async start(): Promise<void> {
    const d = this.tmp('mp-seat-ledger-');
    this.svc = new LedgerService({ paths: ledgerPaths(join(d, 'ledger'), join(d, 'control')) });
    this.svc.open();
    this.socketPath = join(d, 'ledger.sock');
    this.server = serveLedger(this.svc, this.socketPath);
    this.client = new LedgerClient(this.socketPath, 10_000);
    this.gen = (await this.client.call('beginGeneration', {})) as Generation;
    this.content = new ContentStore(this.svc.paths.content);
    this.selfCheckDir = this.tmp('mp-seat-selfcheck-');
    recordFixtureSelfCheck(this.selfCheckDir);
  }

  async close(): Promise<void> {
    for (const u of this.units) await killUnit(u);
    for (const f of this.fakes) await f.close();
    this.client?.close();
    const server = this.server;
    if (server !== null) await new Promise<void>((r) => server.close(() => r()));
    this.svc?.close();
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
  }

  /** model_config.json naming one model for both seats. */
  modelConfigFile(model: string, maxOutputTokens: number): string {
    const p = join(this.tmp('mp-seat-models-'), 'model_config.json');
    const seat = { provider: 'anthropic', model, maxOutputTokens };
    writeFileSync(p, JSON.stringify({ format: 'mp4.model-config.v1', seats: { constructor: seat, reviewer: seat } }));
    return p;
  }

  diag(state: string, launch: LaunchId): string {
    const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8').slice(-4000) : '');
    return [
      `supervisor.log:\n${read(join(state, 'supervisor.log'))}`,
      `host stderr:\n${read(join(state, 'host.err'))}`,
      `claude stderr:\n${read(join(state, 'units', launch, 'claude-stderr.txt'))}`,
    ].join('\n');
  }

  async run(o: RunOptions): Promise<UnitRun> {
    this.seq++;
    const mission = o.mission ?? id<MissionId>(`mission-seat-${process.pid}-${this.seq}`);
    const launch = id<LaunchId>(`launch-seat-${process.pid}-${this.seq}`);
    await this.client.call('registerLaunch', { op: `reg:${launch}`, gen: this.gen, launch, tag: { mission, capabilities: [] } });
    const state = this.tmp();
    const control = join(state, 'control');
    await o.before?.(launch, mission, { control, state });
    const snapshot = join(state, 'snap');
    mkdirSync(join(snapshot, 'src'), { recursive: true });
    for (const [p, data] of Object.entries(o.files ?? { 'src/a.txt': 'alpha\n' })) {
      mkdirSync(dirname(join(snapshot, p)), { recursive: true });
      writeFileSync(join(snapshot, p), data);
    }
    mkdirSync(join(state, 'home'));
    const fake = o.script !== undefined ? await startFakeModel(o.script) : null;
    if (fake !== null) this.fakes.push(fake);
    const card = this.content.put(JSON.stringify(o.card(launch, mission, snapshot)));
    const upstream = fake?.url ?? o.upstream;
    const hostConfig: SeatHostConfig = {
      format: SEAT_HOST_CONFIG_FORMAT,
      card,
      contentRoot: this.svc.paths.content,
      ledgerSocket: this.socketPath,
      controlPlane: control,
      stateDir: state,
      sessionDir: join(state, 'session'),
      ...(o.modelConfig !== undefined ? { modelConfig: o.modelConfig } : {}),
      ...(upstream !== undefined ? { upstream } : {}),
      credentials: o.credentials ?? { kind: 'fake-api-key', key: 'sk-ant-api03-fake' },
      heartbeatMs: 200,
      area: o.area ?? { kind: 'tmpfs' },
      selfCheck: { dir: o.selfCheckDir ?? this.selfCheckDir, acceptFixtures: true },
      ...o.hostConfig,
    };
    const hostPath = join(state, 'host.json');
    writeFileSync(hostPath, JSON.stringify(hostConfig));
    const unitName = `mp-seat-test-${process.pid}-${this.seq}.service`;
    this.units.push(unitName);

    const phases = new Set<string>();
    const sampler = setInterval(() => {
      try {
        const hb = JSON.parse(readFileSync(heartbeatPath(control, launch), 'utf8')) as { launch: string; phase: string };
        if (hb.launch === launch) phases.add(hb.phase);
      } catch {
        /* not yet, or gone */
      }
    }, 50);
    try {
      await launchUnitSupervisor({
        config: seatUnitConfig({
          launch,
          stateDir: state,
          hostConfigPath: hostPath,
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(state, 'home'), LANG: 'C.UTF-8' },
          cwd: state,
          stdoutPath: join(state, 'host.out'),
          stderrPath: join(state, 'host.err'),
          unit: { memoryMax: o.unitMemoryMax ?? 2 * 1024 * 1024 * 1024, pidsMax: 2048 },
          sink: { module: SINK_TS, options: { socketPath: this.socketPath, contentRoot: this.svc.paths.content } },
          retry: { initialDelayMs: 50, maxDelayMs: 200, totalMs: 5_000 },
          contentRoot: this.svc.paths.content,
          ...(o.cleanup !== undefined ? { cleanup: o.cleanup } : {}),
        }),
        unitName,
        logPath: join(state, 'supervisor.log'),
      });
      await o.during?.({ launch, mission, unitName, control, state, fake });
      const done = await waitUnitInactive(unitName, o.timeoutMs ?? 180_000);
      assert.ok(done, `unit still active\n${this.diag(state, launch)}`);
    } finally {
      clearInterval(sampler);
    }
    const outcome = readSeatHostOutcome(state, launch);
    if (o.allowNoOutcome !== true) assert.ok(outcome !== null, `no outcome\n${this.diag(state, launch)}`);
    return {
      launch,
      mission,
      state,
      control,
      snapshot,
      unitName,
      fake,
      outcome: outcome as SeatHostOutcome,
      pending: this.svc.pendingResults(launch),
      proof: this.svc.proofFor(launch),
      cleanup: this.svc.cleanupState(launch),
      phases: [...phases],
    };
  }
}

export function recordsOf<K extends BaseRecord['kind']>(r: UnitRun, kind: K): Extract<BaseRecord, { kind: K }>[] {
  return r.pending.filter((x): x is Extract<BaseRecord, { kind: K }> => x.kind === kind);
}

export async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
