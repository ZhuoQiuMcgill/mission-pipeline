// The program's verification runs on a product version (design 4.1 "验证命令由程序在沙箱中执行并
// 记录，这是唯一算证据的运行", 7.1, 7.2, 6.5).
//
// One verification unit per product version: the scheduler queues it like any execution unit
// (admission 6.5, stop checks 6.4, the supervisor's termination proof, takeover 6.3, the
// environment-retry loop 6.5 with WI-15/WI-08), and its host (verify-host-main.ts → run-host.ts)
// runs every declared command in its own run layer of one tool sandbox on the canonical
// candidate (7.1: never on the seat's raw bytes), with no network. When the attempt is accepted
// the program records one evidence record per command (7.2): the environment line and its
// current snapshot, the run class (closed only in a frozen environment, 7.3), and the fields a
// judgment may use (status, exit, output hashes, duration as a timing field, 5.3).
//
// Until the unit's attempt is accepted the answer is "pending" (failures are the scheduler's:
// retried, or exhausted with its WI notice and the Secretary).

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../common/hash.ts';
import { writeFileAtomic } from '../../common/fsx.ts';
import type { EnvLineId, EnvSnapshotId, EvidenceId, MissionId } from '../../common/ids.ts';
import type { BaseRecord, EvidenceRecord } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import type { LayerLimits } from '../../exec/cgroup.ts';
import type { RunHostRun } from '../../exec/run-host.ts';
import { hostSystemEnvironment, type EnvironmentRoot, type SandboxRunResult, type SandboxSpec } from '../../exec/sandbox.ts';
import { transformDescriptionHash } from '../../git/representation.ts';
import type { TaskSpec } from '../../scheduler/tasks.ts';
import { idPart, safeId, shortHash } from '../context.ts';
import type { FlowTaskState, VerificationRun, VerifyRequest } from '../ports.ts';
import { ActionError, type ActionContext } from './context.ts';

export const VERIFY_TEMPLATE_FORMAT = 'mp4.verify-template.v1';
export const VERIFY_HOST_MAIN = fileURLToPath(new URL('./verify-host-main.ts', import.meta.url));

/** The job of a verification unit, before the scheduler gives its launch an id. */
export interface VerifyTemplate {
  readonly format: typeof VERIFY_TEMPLATE_FORMAT;
  readonly dir: string;
  readonly sandbox: Omit<SandboxSpec, 'sessionDir'>;
  readonly runs: readonly RunHostRun[];
  readonly ledgerSocket?: string;
}

/** Where verification units are queued (the in-process scheduler: schedulerVerifyUnits). */
export interface VerifyUnits {
  submit(spec: TaskSpec): Promise<void>;
  status(task: string): Promise<{ readonly state: FlowTaskState; readonly launches: readonly string[] } | null>;
}

export interface VerifyOptions {
  readonly units: VerifyUnits;
  /** The environment commands run on (7.2). Default: the host's system directories (open runs). */
  readonly environment?: EnvironmentRoot;
  /** The environment line of the evidence (7.2). Default "env.host-system". */
  readonly envLine?: string;
  /** The ledger service's socket: the run layers go there as pending results (acceptance, 7.1 check 3). */
  readonly ledgerSocket?: string;
  /** Each run's declared peak (6.2). Default 1 GiB, 256 processes. */
  readonly runLimits?: LayerLimits;
  /** The sandbox's writable area (a capped tmpfs holding the copied tree and /tmp). Default 512 MiB. */
  readonly areaBytes?: number;
  /** The host's own memory (node, the sandbox helpers). Default 256 MiB. */
  readonly hostBytes?: number;
  /** Per run. Default 30 minutes. */
  readonly runTimeoutMs?: number;
  readonly nodePath?: string;
  readonly install?: { readonly bwrap?: string; readonly nsenter?: string };
}

const MiB = 1024 * 1024;

/** The environment snapshot id (7.2): what the commands ran on, the platform, and the bound transform description. */
export function environmentSnapshot(ctx: ActionContext, env: EnvironmentRoot): string {
  return safeId(`snap.${shortHash({ entries: env.entries, frozen: env.frozen, platform: process.platform, release: release(), transform: transformDescriptionHash(ctx.description) })}`);
}

export function verificationLineage(mission: string): string {
  return safeId(`verify.${mission}`);
}

export function verificationTask(object: string): string {
  return safeId(`verify.${object}`);
}

export async function runVerification(ctx: ActionContext, o: VerifyOptions, req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'> {
  // one evidence record per command id: a repeated id would record two different facts under one id (release review r4)
  const ids = req.commands.map((c) => c.id);
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  if (dup.length > 0) throw new ActionError('conflict', `the verification commands of ${req.object} repeat ids (${dup.join(', ')}); nothing was run or recorded`, { object: req.object, duplicates: dup });
  const dir = join(ctx.workDir, 'verify', safeId(req.object));
  const done = join(dir, 'runs.json');
  if (existsSync(done)) return JSON.parse(readFileSync(done, 'utf8')) as VerificationRun[];
  const task = verificationTask(req.object);
  const env = o.environment ?? hostSystemEnvironment();
  const st = await o.units.status(task);
  if (st === null) {
    await submitUnit(ctx, o, req, dir, task, env);
    return 'pending';
  }
  // a unit that ended without an accepted attempt is not "pending" forever (code review r1 #15): the
  // flow routes it like any failed task (restart, grant, abandon, re-plan: WI-15 / WI-08)
  if (st.state === 'needs-disposition' || st.state === 'exhausted' || st.state === 'abandoned') {
    throw new ActionError('verification-failed', `the verification unit ${task} of ${req.object} ended ${st.state}`, { task, lineage: verificationLineage(req.mission), state: st.state });
  }
  if (st.state !== 'done') return 'pending';
  const launch = st.launches.at(-1);
  if (launch === undefined) return 'pending';
  const results = JSON.parse(readFileSync(join(dir, 'runs', launch, 'results.json'), 'utf8')) as SandboxRunResult[];
  const envLine = o.envLine ?? 'env.host-system';
  const snapshot = environmentSnapshot(ctx, env);
  // the environment's snapshot (7.2), registered once per (line, snapshot) in its own op, so a
  // retried evidence op after a restart has exactly the same payload
  const current = (await ctx.ledger.records(['env.snapshot'])).filter((c) => c.record.line === envLine).at(-1)?.record.snapshot ?? null;
  if (current !== snapshot) await ctx.ledger.append(`flow:env-snapshot:${envLine}:${snapshot}`, { records: [{ kind: 'env.snapshot', line: envLine as EnvLineId, snapshot: snapshot as EnvSnapshotId }] });
  const records: BaseRecord[] = [];
  const runs: VerificationRun[] = [];
  req.commands.forEach((c, i) => {
    const r = results[i];
    const evidence = safeId(`ev.${req.object}.${idPart(c.id)}`);
    const exit = r === undefined ? 'not-run' : r.exit.signal !== null ? `signal:${r.exit.signal}` : String(r.exit.code);
    const status = r === undefined ? 'not-run' : r.notStarted !== null ? 'not-started' : r.status;
    const fields: Record<string, string> = {
      status,
      exit,
      command: c.command.slice(0, 500),
      launch,
      ...(r !== undefined ? { stdout: sha256(r.stdout.text), stderr: sha256(r.stderr.text), durationMs: String(r.durationMs) } : {}),
    };
    const rec: EvidenceRecord = { kind: 'evidence', evidence: evidence as EvidenceId, envLine: envLine as EnvLineId, envSnapshot: snapshot as EnvSnapshotId, runClass: env.frozen ? 'closed' : 'open', fields };
    validateRecord(rec);
    records.push(rec);
    const out = r === undefined ? '' : r.stdout.text.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    runs.push({
      evidence,
      command: c.command,
      summary: r === undefined ? 'not run' : `${status}; exit ${exit}; ${r.durationMs} ms${out !== '' ? `; output: ${out}` : ''}`,
      passed: status === 'completed' && exit === '0',
    });
  });
  await ctx.ledger.append(`flow:evidence:${req.mission}:${req.object}`, { records });
  writeFileAtomic(done, JSON.stringify(runs));
  return runs;
}

async function submitUnit(ctx: ActionContext, o: VerifyOptions, req: VerifyRequest, dir: string, task: string, env: EnvironmentRoot): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const limits = o.runLimits ?? { memoryMax: 1024 * MiB, pidsMax: 256 };
  const areaBytes = o.areaBytes ?? 512 * MiB;
  const hostBytes = o.hostBytes ?? 256 * MiB;
  const template: VerifyTemplate = {
    format: VERIFY_TEMPLATE_FORMAT,
    dir,
    sandbox: {
      snapshotDir: req.snapshot,
      // the commands may write (build output, caches): copies in the area, never exported
      writablePaths: ['.'],
      area: { kind: 'tmpfs', bytes: areaBytes },
      environment: env,
      ...(o.install?.bwrap !== undefined ? { bwrapPath: o.install.bwrap } : {}),
      ...(o.install?.nsenter !== undefined ? { nsenterPath: o.install.nsenter } : {}),
    },
    runs: req.commands.map((c, i) => ({
      run: safeId(`v${i + 1}-${c.id}`),
      command: c.command,
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      limits,
      timeoutMs: o.runTimeoutMs ?? 30 * 60_000,
    })),
    ...(o.ledgerSocket !== undefined ? { ledgerSocket: o.ledgerSocket } : {}),
  };
  const templatePath = join(dir, 'template.json');
  writeFileAtomic(templatePath, JSON.stringify(template));
  const memory = hostBytes + limits.memoryMax + areaBytes;
  await o.units.submit({
    task,
    lineage: verificationLineage(req.mission),
    mission: req.mission as MissionId,
    capabilities: ['run-commands'],
    priority: 55,
    dependsOn: [],
    paid: false,
    estimateMicros: 0,
    demand: { memoryBytes: memory, diskBytes: 64 * MiB, inodes: 10_000 },
    unit: {
      host: {
        argv: [o.nodePath ?? process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', VERIFY_HOST_MAIN, templatePath],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
        cwd: dir,
        stdoutPath: join(dir, 'host.out'),
        stderrPath: join(dir, 'host.err'),
      },
      limits: { memoryMax: memory, pidsMax: (limits.pidsMax ?? 256) + 64 },
      seatUnit: false,
      heartbeat: false,
    },
    mode: 'fast',
  });
}
