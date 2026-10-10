// Delegated cgroup v2 primitives for execution units (design 6.2, 6.5, 7.1).
//
// Facts this module relies on (probes-4.0, all passed on 2026-10-09):
//  - cgroup v2 with cpu, memory and pids delegated to the user's systemd manager; a
//    transient user service started with Delegate=yes owns its own subtree.
//  - No internal processes: a cgroup that hands controllers to children
//    (cgroup.subtree_control) holds no processes itself. A supervisor therefore moves
//    itself into a leaf before enabling controllers.
//  - memory.oom.group=1: one OOM in a layer makes the kernel kill all of the layer's
//    processes together (the scope of the kill, not one instant).
//  - A layer's own memory.events.local "oom" says ITS limit fired. The hierarchical
//    memory.events "oom_kill" counts processes killed anywhere in its subtree, whatever
//    triggered it: an ancestor's limit shows local oom 0 but oom_kill > 0. A removed
//    child's events stay counted in its ancestors' hierarchical files.
//  - A process joins a cgroup by writing to cgroup.procs; writing "0" moves the writer.
//    The permission check is on the common ancestor, so processes can only be moved
//    by something already inside the delegated subtree.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { TerminationProofRecord } from '../common/records.ts';

export const CGROUP_FS = '/sys/fs/cgroup';

/** How a process ended: exit code, or the terminating signal's name. */
export type ExitStatus = TerminationProofRecord['exit'];

export class CgroupError extends Error {
  override readonly name = 'CgroupError';
}

export interface MemoryEvents {
  readonly low: number;
  readonly high: number;
  readonly max: number;
  readonly oom: number;
  readonly oomKill: number;
  readonly oomGroupKill: number;
}

/** Parses "key value" lines (memory.events, cgroup.events, pids.events ...). */
export function parseKeyedCounters(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const m = /^([A-Za-z0-9_.]+)\s+(\d+)$/.exec(t);
    if (!m) throw new CgroupError(`unparsable counter line: ${JSON.stringify(line)}`);
    out.set(m[1] as string, Number(m[2]));
  }
  return out;
}

export function parseMemoryEvents(text: string): MemoryEvents {
  const m = parseKeyedCounters(text);
  if (!m.has('oom') || !m.has('oom_kill')) throw new CgroupError(`memory.events without oom/oom_kill: ${JSON.stringify(text)}`);
  const get = (k: string): number => m.get(k) ?? 0;
  return {
    low: get('low'),
    high: get('high'),
    max: get('max'),
    oom: get('oom'),
    oomKill: get('oom_kill'),
    oomGroupKill: get('oom_group_kill'),
  };
}

/** Absolute cgroupfs path of a process's cgroup v2 membership. */
export function cgroupPathOfProcess(pid: number | 'self' = 'self'): string {
  const text = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('0::')) {
      const rel = line.slice(3).trim();
      return rel === '/' ? CGROUP_FS : CGROUP_FS + rel;
    }
  }
  throw new CgroupError(`process ${pid} has no cgroup v2 membership (unified hierarchy not mounted?)`);
}

const CHILD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

/** One cgroup v2 directory. Operations are synchronous writes to cgroupfs files. */
export class Cgroup {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static at(path: string): Cgroup {
    const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (p !== CGROUP_FS && !p.startsWith(`${CGROUP_FS}/`)) throw new CgroupError(`not a cgroupfs path: ${path}`);
    if (p.split('/').some((c) => c === '..' || c === '.')) throw new CgroupError(`non-normalized cgroup path: ${path}`);
    return new Cgroup(p);
  }

  static ofProcess(pid: number | 'self' = 'self'): Cgroup {
    return Cgroup.at(cgroupPathOfProcess(pid));
  }

  get name(): string {
    return basename(this.path);
  }

  child(name: string): Cgroup {
    if (!CHILD_NAME.test(name)) throw new CgroupError(`bad cgroup name: ${JSON.stringify(name)}`);
    return new Cgroup(join(this.path, name));
  }

  parent(): Cgroup {
    if (this.path === CGROUP_FS) throw new CgroupError('the root cgroup has no parent');
    return new Cgroup(dirname(this.path));
  }

  exists(): boolean {
    return existsSync(join(this.path, 'cgroup.procs'));
  }

  create(): void {
    mkdirSync(this.path);
  }

  read(file: string): string {
    return readFileSync(join(this.path, file), 'utf8');
  }

  write(file: string, value: string): void {
    try {
      writeFileSync(join(this.path, file), value);
    } catch (e) {
      throw new CgroupError(`writing ${JSON.stringify(value)} to ${join(this.path, file)} failed: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }

  controllers(): Set<string> {
    return new Set(this.read('cgroup.controllers').split(/\s+/).filter(Boolean));
  }

  subtreeControl(): Set<string> {
    return new Set(this.read('cgroup.subtree_control').split(/\s+/).filter(Boolean));
  }

  enableControllers(names: Iterable<string>): void {
    const s = [...names].map((n) => `+${n}`).join(' ');
    if (s !== '') this.write('cgroup.subtree_control', s);
  }

  setMemoryMax(v: number | 'max'): void {
    this.write('memory.max', String(v));
  }

  /** memory.swap.max; a kernel without swap accounting has no file and nothing to limit. */
  setSwapMax(v: number | 'max'): void {
    if (!existsSync(join(this.path, 'memory.swap.max'))) return;
    this.write('memory.swap.max', String(v));
  }

  setPidsMax(v: number | 'max'): void {
    this.write('pids.max', String(v));
  }

  setOomGroup(on: boolean): void {
    this.write('memory.oom.group', on ? '1' : '0');
  }

  setCpuMax(quotaUs: number | 'max', periodUs: number): void {
    this.write('cpu.max', `${quotaUs} ${periodUs}`);
  }

  /** 'local': this layer's own memory.events.local; 'hierarchical': memory.events, descendants included. */
  memoryEvents(scope: 'local' | 'hierarchical'): MemoryEvents {
    return parseMemoryEvents(this.read(scope === 'local' ? 'memory.events.local' : 'memory.events'));
  }

  populated(): boolean {
    const v = parseKeyedCounters(this.read('cgroup.events')).get('populated');
    if (v === undefined) throw new CgroupError(`${this.path}/cgroup.events has no "populated" line`);
    return v !== 0;
  }

  procs(): number[] {
    return this.read('cgroup.procs')
      .split('\n')
      .filter(Boolean)
      .map(Number);
  }

  /** Every process in this cgroup and its descendants (diagnostics). */
  allProcs(): number[] {
    const out = this.exists() ? this.procs() : [];
    for (const c of this.children()) out.push(...c.allProcs());
    return out;
  }

  /** Moves a whole process (all threads) into this cgroup. */
  attach(pid: number): void {
    this.write('cgroup.procs', String(pid));
  }

  /** SIGKILLs every process in this cgroup and its descendants (cgroup.kill). */
  kill(): void {
    this.write('cgroup.kill', '1');
  }

  children(): Cgroup[] {
    if (!existsSync(this.path)) return [];
    return readdirSync(this.path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => new Cgroup(join(this.path, d.name)));
  }

  /** Resolves true once nothing is left in the subtree (or it no longer exists), false on timeout. */
  async waitEmpty(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let wait = 5;
    for (;;) {
      if (!this.exists() || !this.populated()) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(wait, left));
      wait = Math.min(wait * 2, 100);
    }
  }

  /** Removes this (empty, childless) cgroup. Retries briefly on EBUSY right after its last process exits. */
  async rmdir(): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        rmdirSync(this.path);
        return;
      } catch (e) {
        if (errnoOf(e) === 'ENOENT') return;
        if (errnoOf(e) !== 'EBUSY' || i >= 50) {
          throw new CgroupError(`rmdir ${this.path} failed: ${(e as Error).message}`, { cause: e });
        }
        await sleep(20);
      }
    }
  }

  /** Kills everything left in the subtree, waits until it is empty and removes it bottom-up. */
  async destroy(timeoutMs: number): Promise<void> {
    if (!this.exists()) return;
    if (this.populated()) {
      this.kill();
      if (!(await this.waitEmpty(timeoutMs))) {
        throw new CgroupError(`${this.path} still holds processes ${this.allProcs().join(' ')} after cgroup.kill`);
      }
    }
    for (const c of this.children()) await c.destroy(timeoutMs);
    await this.rmdir();
  }
}

// ---------------------------------------------------------------- limits

export interface CpuLimit {
  readonly quotaUs: number;
  readonly periodUs: number;
}

/** Limits of one layer (execution unit or run layer). */
export interface LayerLimits {
  /** memory.max in bytes: the declared peak (6.2, 7.1). */
  readonly memoryMax: number;
  readonly pidsMax?: number;
  readonly cpu?: CpuLimit;
}

export function validateLimits(l: LayerLimits): void {
  if (!Number.isSafeInteger(l.memoryMax) || l.memoryMax <= 0) throw new RangeError(`bad memoryMax ${l.memoryMax}`);
  if (l.pidsMax !== undefined && (!Number.isSafeInteger(l.pidsMax) || l.pidsMax <= 0)) {
    throw new RangeError(`bad pidsMax ${l.pidsMax}`);
  }
  if (l.cpu !== undefined) {
    const { quotaUs, periodUs } = l.cpu;
    if (!Number.isSafeInteger(quotaUs) || quotaUs <= 0 || !Number.isSafeInteger(periodUs) || periodUs <= 0) {
      throw new RangeError('bad cpu limit');
    }
  }
}

/** memory.max, memory.swap.max=0 (an overrun must kill, not swap), pids.max, cpu.max, memory.oom.group=1. */
export function applyLayerLimits(cg: Cgroup, l: LayerLimits): void {
  validateLimits(l);
  cg.setMemoryMax(l.memoryMax);
  cg.setSwapMax(0);
  if (l.pidsMax !== undefined) cg.setPidsMax(l.pidsMax);
  if (l.cpu !== undefined) cg.setCpuMax(l.cpu.quotaUs, l.cpu.periodUs);
  cg.setOomGroup(true);
}

// ---------------------------------------------------------------- spawning into a cgroup

/**
 * v34 (7.1): every process of an execution unit (host, Claude Code, runs) carries
 * oom_score_adj=1000, so an ancestor's or the machine's OOM picks the unit before its
 * supervisor (which keeps the default). Raising the value needs no privilege; it is inherited.
 */
export const UNIT_OOM_SCORE_ADJ = 1000;

/**
 * Moves itself into the cgroup named by $0 BEFORE exec'ing the command, so nothing the
 * command does ever runs outside it, and sets its oom_score_adj ($1, "-" to leave it).
 * "joined" on fd 3 tells the parent both worked; fd 3 is closed before exec.
 */
const JOIN_AND_EXEC = [
  'procs=$0; adj=$1; shift',
  'echo 0 > "$procs" || exit 125',
  'if [ "$adj" != - ]; then echo "$adj" > /proc/self/oom_score_adj || exit 126; fi',
  'echo joined >&3; exec 3>&-; exec "$@"',
].join('\n');

export type StdioTarget = 'ignore' | 'pipe' | 'inherit' | number;

export interface SpawnInCgroupOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stdio?: readonly [StdioTarget, StdioTarget, StdioTarget];
  readonly detached?: boolean;
  /** Host shell used for the join trampoline. */
  readonly shell?: string;
  /** /proc/self/oom_score_adj for the process (and, by inheritance, everything it starts). */
  readonly oomScoreAdj?: number;
}

export interface ProcessEnd {
  readonly status: ExitStatus;
  /** Set when the process could not be started at all. */
  readonly error: Error | null;
}

export interface CgroupChild {
  readonly child: ChildProcess;
  /** true once the process is inside the cgroup; false if the trampoline failed before exec. */
  readonly joined: Promise<boolean>;
  readonly exited: Promise<ProcessEnd>;
}

export function processEnd(child: ChildProcess): Promise<ProcessEnd> {
  return new Promise((resolve) => {
    let done = false;
    child.once('error', (e) => {
      if (done) return;
      done = true;
      resolve({ status: { code: null, signal: null }, error: e });
    });
    child.once('exit', (code, signal) => {
      if (done) return;
      done = true;
      resolve({ status: { code, signal }, error: null });
    });
  });
}

export function spawnInCgroup(cg: Cgroup, argv: readonly string[], opts: SpawnInCgroupOptions): CgroupChild {
  if (argv.length === 0) throw new TypeError('empty argv');
  const stdio = opts.stdio ?? ['ignore', 'ignore', 'ignore'];
  const adj = opts.oomScoreAdj;
  if (adj !== undefined && (!Number.isSafeInteger(adj) || adj < -1000 || adj > 1000)) throw new RangeError(`bad oom_score_adj ${adj}`);
  const child = spawn(opts.shell ?? '/bin/sh', ['-c', JOIN_AND_EXEC, join(cg.path, 'cgroup.procs'), adj === undefined ? '-' : String(adj), ...argv], {
    env: { ...opts.env },
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdio: [stdio[0], stdio[1], stdio[2], 'pipe'],
    detached: opts.detached ?? false,
  });
  const exited = processEnd(child);
  const joined = new Promise<boolean>((resolve) => {
    const s = child.stdio[3] as Readable | null | undefined;
    if (!s) {
      resolve(false);
      return;
    }
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
    });
    s.on('error', () => resolve(buf.includes('joined')));
    s.on('close', () => resolve(buf.includes('joined')));
  });
  return { child, joined, exited };
}

// ---------------------------------------------------------------- the execution unit's subtree

export interface UnitTree {
  /** The transient service's own cgroup (Delegate=yes). Holds no processes once built. */
  readonly service: Cgroup;
  /** Leaf holding the supervisor itself, beside the unit subtree. */
  readonly supervisorLeaf: Cgroup;
  /** The execution unit: memory.max = the card's peak, memory.oom.group=1. */
  readonly unit: Cgroup;
  /** Control layer: the seat host and the Claude Code process. */
  readonly control: Cgroup;
  readonly controllers: readonly string[];
}

/**
 * Builds the two sibling subtrees of 7.1 inside the calling process's own (delegated)
 * cgroup: a leaf for the caller, and the unit with its control layer. The caller moves
 * itself into the leaf first: a cgroup that hands out controllers may hold no processes.
 */
export function buildUnitTree(service: Cgroup, limits: LayerLimits): UnitTree {
  validateLimits(limits);
  const available = service.controllers();
  for (const c of ['memory', 'pids']) {
    if (!available.has(c)) throw new CgroupError(`controller "${c}" is not delegated to ${service.path}`);
  }
  if (limits.cpu !== undefined && !available.has('cpu')) {
    throw new CgroupError(`controller "cpu" is not delegated to ${service.path}`);
  }
  const controllers = ['memory', 'pids', ...(available.has('cpu') ? ['cpu'] : [])];
  const supervisorLeaf = service.child('sup');
  supervisorLeaf.create();
  supervisorLeaf.attach(process.pid);
  const strays = service.procs();
  if (strays.length > 0) throw new CgroupError(`${service.path} still holds processes ${strays.join(' ')}`);
  service.enableControllers(controllers);
  const unit = service.child('unit');
  unit.create();
  applyLayerLimits(unit, limits);
  unit.enableControllers(controllers);
  const control = unit.child('ctl');
  control.create();
  return { service, supervisorLeaf, unit, control, controllers };
}

/** The unit cgroup a host runs in: MP_UNIT_CGROUP, else the parent of the host's own "ctl" leaf. */
export function unitCgroupFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Cgroup {
  const fromEnv = env['MP_UNIT_CGROUP'];
  if (fromEnv) return Cgroup.at(fromEnv);
  const own = Cgroup.ofProcess('self');
  if (own.name !== 'ctl') throw new CgroupError(`not inside an execution unit's control layer (${own.path})`);
  return own.parent();
}

// ---------------------------------------------------------------- run layers

export interface LayerCounters {
  /** Own-limit OOM events during this layer's life (memory.events.local "oom", delta). */
  readonly oom: number;
  /** Processes killed by any OOM in this layer (hierarchical "oom_kill", delta). */
  readonly oomKill: number;
  readonly finalOom: number;
  readonly finalOomKill: number;
}

export function runLayerName(run: string): string {
  return `run-${run.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

/** One synchronous run's layer under the unit (6.2): own memory.max = the run's declared peak. */
export class RunLayer {
  readonly cgroup: Cgroup;
  private readonly initialOom: number;
  private readonly initialOomKill: number;

  private constructor(cgroup: Cgroup, initialOom: number, initialOomKill: number) {
    this.cgroup = cgroup;
    this.initialOom = initialOom;
    this.initialOomKill = initialOomKill;
  }

  static create(unit: Cgroup, run: string, limits: LayerLimits): RunLayer {
    const cg = unit.child(runLayerName(run));
    cg.create();
    try {
      applyLayerLimits(cg, limits);
      return new RunLayer(cg, cg.memoryEvents('local').oom, cg.memoryEvents('hierarchical').oomKill);
    } catch (e) {
      try {
        rmdirSync(cg.path);
      } catch {
        /* best effort */
      }
      throw e;
    }
  }

  /** Starts a run's process into this layer, with the unit's oom_score_adj (v34). */
  spawn(argv: readonly string[], opts: SpawnInCgroupOptions): CgroupChild {
    return spawnInCgroup(this.cgroup, argv, { oomScoreAdj: UNIT_OOM_SCORE_ADJ, ...opts });
  }

  /**
   * After the run's main process has exited: waits `graceMs` for the layer to empty, kills
   * what is left, waits until it is empty, then reads the final counters. Results are only
   * valid once the layer holds no process (7.1).
   */
  async settle(graceMs: number, unkillableMs: number): Promise<LayerCounters> {
    if (!(await this.cgroup.waitEmpty(graceMs))) {
      this.cgroup.kill();
      if (!(await this.cgroup.waitEmpty(unkillableMs))) {
        throw new CgroupError(`run layer ${this.cgroup.path} still holds ${this.cgroup.allProcs().join(' ')} after cgroup.kill`);
      }
    }
    const finalOom = this.cgroup.memoryEvents('local').oom;
    const finalOomKill = this.cgroup.memoryEvents('hierarchical').oomKill;
    return {
      oom: finalOom - this.initialOom,
      oomKill: finalOomKill - this.initialOomKill,
      finalOom,
      finalOomKill,
    };
  }

  async remove(): Promise<void> {
    await this.cgroup.rmdir();
  }
}
