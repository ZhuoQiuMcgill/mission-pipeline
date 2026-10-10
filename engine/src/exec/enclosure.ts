// The outer bubblewrap of a seat's Claude Code process (design 7.1 "宿主一侧的写入也有上限") and
// the session state it leaves behind (6.2 "续接所需的会话状态单独保存，不截断").
//
// The seat host starts Claude Code through the SDK's spawnClaudeCodeProcess with `argv()`:
// the root filesystem read-only, and only three writable places, each a capped tmpfs whose
// pages count toward the unit's memory: its config directory (CLAUDE_CONFIG_DIR, where the
// transcript goes), /tmp and /dev/shm. The network stays: it reaches the metering proxy.
//
// The areas belong to an AreaHolder, not to the Claude Code process, so they outlive it:
//  - when a seat asks for async evidence, the host stores the session state whole, straight
//    into the content store, against the card's recovery-state caps (storeState) BEFORE it
//    accepts the request; over the cap, or not storable, it refuses the request instead (6.2);
//  - when a new unit resumes the session, its enclosure is seeded with that state;
//  - at the end of the unit, the transcript is streamed the same way, within what is left of
//    the launch's export allowance, cut and marked incomplete when it does not fit (storeTranscript).
// The login credentials copied into the config area are never captured (DEFAULT_STATE_EXCLUDES).

import { mkdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  AgentRunner,
  defaultAgentRuntime,
  installAgent,
  type AgentHost,
  type AgentReply,
  type AgentRequest,
  type AgentRuntime,
  type ExportRequest,
  type ExportSink,
} from './agent.ts';
import type { ContentStore } from '../ledger/content.ts';
import { ExportBudget, exportAreas, exportToStore, meterAreas, type ExportCaps, type ExportMeter, type ExportOutcome, type StoreTreeOutcome } from './export.ts';
import { AreaHolder, SandboxError, SerialQueue, type AreaStep } from './holder.ts';
import { findTool } from './platform.ts';

/** Never part of a captured session state: the login credentials Claude Code reads from its config directory. */
export const DEFAULT_STATE_EXCLUDES: readonly string[] = ['.credentials.json'];

const STATE_ROOT = '/state';
const AREAS_ROOT = '/areas';

/** What the Claude Code process left in its three writable places (§14 item 1). */
export interface AreaInventory {
  /** "config/…", "tmp/…", "shm/…" (directories end with "/"), in walk order. */
  readonly paths: readonly string[];
  readonly logicalBytes: number;
  /** False when the walk stopped at maxEntries. */
  readonly complete: boolean;
}

export interface EnclosureSpec {
  /** An existing directory private to this enclosure (Linux filesystem). */
  readonly sessionDir: string;
  /**
   * The path Claude Code sees as CLAUDE_CONFIG_DIR. An existing directory on the host (it
   * stays empty there: the config area is mounted over it inside the enclosure only).
   * Default: <sessionDir>/claude-config.
   */
  readonly configDir?: string;
  readonly configBytes: number;
  readonly tmpBytes: number;
  readonly shmBytes?: number;
  /** Copied into the config area at creation: the seat's login files, or a captured state being resumed. */
  readonly seedConfigFrom?: string;
  /** The file-tool agent's runtime, used to meter and capture the session state. */
  readonly runtime?: AgentRuntime;
  readonly bwrapPath?: string;
  readonly nsenterPath?: string;
}

export class ClaudeCodeEnclosure implements AgentHost {
  /** CLAUDE_CONFIG_DIR inside the enclosure. */
  readonly configDir: string;
  private readonly holder: AreaHolder;
  private readonly agent: AgentRunner;
  /** Read-only view of all three areas, for the inventory. */
  private readonly areasAgent: AgentRunner;
  private readonly agentCopy: string;
  private readonly createdConfigDir: boolean;
  private readonly queue = new SerialQueue();
  private closed = false;

  private constructor(configDir: string, holder: AreaHolder, agent: AgentRunner, areasAgent: AgentRunner, agentCopy: string, createdConfigDir: boolean) {
    this.configDir = configDir;
    this.holder = holder;
    this.agent = agent;
    this.areasAgent = areasAgent;
    this.agentCopy = agentCopy;
    this.createdConfigDir = createdConfigDir;
  }

  static async create(spec: EnclosureSpec): Promise<ClaudeCodeEnclosure> {
    const sessionDir = realpathSync(spec.sessionDir);
    if (!statSync(sessionDir).isDirectory()) throw new SandboxError(`session directory ${sessionDir} is not a directory`);
    let configDir: string;
    let createdConfigDir = false;
    if (spec.configDir === undefined) {
      configDir = join(sessionDir, 'claude-config');
      mkdirSync(configDir);
      createdConfigDir = true;
    } else {
      if (!isAbsolute(spec.configDir)) throw new SandboxError('configDir must be absolute');
      configDir = realpathSync(spec.configDir);
      if (!statSync(configDir).isDirectory()) throw new SandboxError(`configDir ${configDir} is not a directory`);
    }
    const bwrap = findTool('bwrap', [spec.bwrapPath]);
    const nsenter = findTool('nsenter', [spec.nsenterPath]);
    if (bwrap === null || nsenter === null) throw new SandboxError('bubblewrap (bwrap) and nsenter are required');
    const runtime = spec.runtime ?? defaultAgentRuntime();
    const base = join(sessionDir, 'claude-areas');
    mkdirSync(base);
    const steps: AreaStep[] = spec.seedConfigFrom === undefined ? [] : [{ op: 'copy-dir', from: realpathSync(spec.seedConfigFrom), at: 'config' }];
    const holder = await AreaHolder.start({
      base,
      tmpfs: [
        { at: 'config', bytes: spec.configBytes },
        { at: 'tmp', bytes: spec.tmpBytes },
        { at: 'shm', bytes: spec.shmBytes ?? 1024 * 1024 },
      ],
      steps,
      bwrap,
      nsenter,
    });
    const agentCopy = installAgent(sessionDir);
    const agent = new AgentRunner(holder, runtime, agentCopy, {
      mounts: ['--bind', holder.path('config'), STATE_ROOT],
      root: STATE_ROOT,
      writable: [{ path: STATE_ROOT, kind: 'dir' }],
    });
    const areas = ['config', 'tmp', 'shm'] as const;
    const areasAgent = new AgentRunner(holder, runtime, agentCopy, {
      mounts: areas.flatMap((a) => ['--ro-bind', holder.path(a), `${AREAS_ROOT}/${a}`]),
      root: AREAS_ROOT,
      writable: areas.map((a) => ({ path: `${AREAS_ROOT}/${a}`, kind: 'dir' as const })),
    });
    return new ClaudeCodeEnclosure(configDir, holder, agent, areasAgent, agentCopy, createdConfigDir);
  }

  /** The holder process (its pid identity is a cleanup resource, v35). */
  get holderPid(): number {
    return this.holder.pid;
  }

  /**
   * argv that runs `command` (the Claude Code executable and its arguments) inside the
   * enclosure. Its environment is the caller's (the SDK's) with CLAUDE_CONFIG_DIR and TMPDIR set.
   */
  argv(command: readonly string[]): string[] {
    if (this.closed) throw new SandboxError('enclosure is closed');
    if (command.length === 0) throw new SandboxError('empty command');
    return [
      ...this.holder.enterBwrap(),
      '--die-with-parent',
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--bind',
      this.holder.path('shm'),
      '/dev/shm',
      '--proc',
      '/proc',
      '--bind',
      this.holder.path('tmp'),
      '/tmp',
      '--bind',
      this.holder.path('config'),
      this.configDir,
      '--remount-ro',
      '/dev',
      '--setenv',
      'CLAUDE_CONFIG_DIR',
      this.configDir,
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--',
      ...command,
    ];
  }

  /** Logical size of the session state (6.2: checked against the card's cap before accepting async evidence). */
  meterState(exclude: readonly string[] = DEFAULT_STATE_EXCLUDES): Promise<ExportMeter> {
    return meterAreas(this, { exclude });
  }

  /** Captures the whole session state into `dest`, or refuses as a whole over the cap (never truncated). */
  captureState(dest: string, caps: ExportCaps, exclude: readonly string[] = DEFAULT_STATE_EXCLUDES): Promise<ExportOutcome> {
    return exportAreas(this, dest, caps, { exclude });
  }

  /**
   * 6.2: the whole session state into the content store within its recovery allowance (caps: a
   * fresh one; a budget: shared, e.g. by every attempt of one round), or refused as a whole.
   */
  storeState(content: ContentStore, allowance: ExportCaps | ExportBudget, tempPath: string, exclude: readonly string[] = DEFAULT_STATE_EXCLUDES): Promise<StoreTreeOutcome> {
    const budget = allowance instanceof ExportBudget ? allowance : new ExportBudget(allowance);
    return exportToStore(this, content, budget, { mode: 'whole', tempPath, exclude });
  }

  /** 7.1 "结束时": the transcript and logs into the content store, cut at what `budget` has left (marked incomplete). */
  storeTranscript(content: ContentStore, budget: ExportBudget, tempPath: string, exclude: readonly string[] = DEFAULT_STATE_EXCLUDES): Promise<StoreTreeOutcome> {
    return exportToStore(this, content, budget, { mode: 'truncate', tempPath, exclude });
  }

  /**
   * Every entry of the config, tmp and shm areas: the only places the Claude Code process can
   * write (its root is read-only). Contents are read through and discarded, never kept.
   */
  inventory(maxEntries = 100_000, timeoutMs = 120_000): Promise<AreaInventory> {
    return this.queue.run(async () => {
      if (this.closed) throw new SandboxError('enclosure is closed');
      const paths: string[] = [];
      let logicalBytes = 0;
      let complete = true;
      let failure: string | null = null;
      const sink: ExportSink = {
        frame: (f) => {
          if (f.k === 'dir') paths.push(`${f.p}/`);
          else if (f.k === 'file') {
            paths.push(f.p);
            logicalBytes += f.size;
          } else if (f.k === 'symlink') paths.push(`${f.p} -> ${f.target}`);
          else if (f.k === 'skip') paths.push(`${f.p} (${f.type})`);
          else if (f.k === 'abort') complete = false;
          else if (f.k === 'error') failure = `${f.code}: ${f.message}`;
        },
        data: () => undefined,
        fileEnd: () => undefined,
      };
      await this.areasAgent.stream({ op: 'export', maxBytes: Number.MAX_SAFE_INTEGER, maxEntries, exclude: [] }, sink, timeoutMs);
      if (failure !== null) throw new SandboxError(`inventory failed: ${failure}`);
      return { paths, logicalBytes, complete };
    });
  }

  /** One file of the config area as text (null when absent or not text), e.g. the login after the seat. */
  async readStateFile(name: string, maxBytes = 1 << 20): Promise<string | null> {
    if (name.includes('/') || name === '' || name === '.' || name === '..') throw new SandboxError(`bad state file name ${JSON.stringify(name)}`);
    const r = await this.callAgent({ op: 'read', path: `${STATE_ROOT}/${name}`, offset: 0, maxBytes }, { timeoutMs: 30_000, maxResponseBytes: 2 * maxBytes + 4096 });
    if (!r.ok) return null;
    const v = r.result as { encoding?: string; content?: string; truncated?: boolean };
    return v.encoding === 'utf8' && v.truncated !== true && typeof v.content === 'string' ? v.content : null;
  }

  callAgent(req: AgentRequest, opts: { readonly timeoutMs: number; readonly maxResponseBytes: number }): Promise<AgentReply> {
    return this.queue.run(async () => {
      if (this.closed) throw new SandboxError('enclosure is closed');
      return await this.agent.call(req, opts);
    });
  }

  exportStream(req: ExportRequest, sink: ExportSink, timeoutMs: number): Promise<void> {
    return this.queue.run(async () => {
      if (this.closed) throw new SandboxError('enclosure is closed');
      await this.agent.stream(req, sink, timeoutMs);
    });
  }

  /** Discards the areas. Capture what must be kept first. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.drain();
    await this.holder.close();
    for (const d of [this.holder.path('config'), this.holder.path('tmp'), this.holder.path('shm'), this.holder.base, ...(this.createdConfigDir ? [this.configDir] : [])]) {
      try {
        rmdirSync(d);
      } catch {
        /* left for the session directory's owner */
      }
    }
    try {
      unlinkSync(this.agentCopy);
    } catch {
      /* already gone */
    }
  }
}
