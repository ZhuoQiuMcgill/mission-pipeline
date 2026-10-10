// The host of a program verification run (design 7.1: "程序的验证运行也是执行单元"; 7.3 closed
// runs). It is the process the unit supervisor starts into the unit's control layer for a
// unit without a seat: it creates the tool sandbox, runs each declared command in its own
// run layer, records every run layer once (bound to the launch and the run), writes the
// results, closes the sandbox and exits 0. A seat host does the same for "run command".
//
// Each run layer is recorded once: appended to a JSON-lines file and, when the job names
// the ledger's socket, submitted as a pending result under the launch (op id per run), which
// is where the acceptance check reads it (7.1 check 3).

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLineDurable, writeFileAtomic } from '../common/fsx.ts';
import { id, type LaunchId, type RunId } from '../common/ids.ts';
import type { BaseRecord, RunLayerRecord } from '../common/records.ts';
import { LedgerClient, RemoteLedgerError } from '../ledger/ipc.ts';
import { unitCgroupFromEnv, type LayerLimits } from './cgroup.ts';
import { ToolSandbox, type SandboxRunResult, type SandboxSpec } from './sandbox.ts';

export const RUN_HOST_MAIN = fileURLToPath(new URL('./run-host-main.ts', import.meta.url));
export const RUN_HOST_JOB_FORMAT = 'mp4.run-host-job.v1';

export interface RunHostRun {
  readonly run: string;
  readonly command: string;
  /** Relative to the snapshot root. Default: the root. */
  readonly cwd?: string;
  /** The run's declared peak. */
  readonly limits: LayerLimits;
  readonly timeoutMs?: number;
  readonly outputCapBytes?: number;
}

export interface RunHostJob {
  readonly format: typeof RUN_HOST_JOB_FORMAT;
  readonly launch: LaunchId;
  readonly sandbox: SandboxSpec;
  readonly runs: readonly RunHostRun[];
  /** One JSON line per run layer (the host's record of 7.1 check 3). */
  readonly recordsPath: string;
  /** The ledger service's socket: run layers are also submitted there as pending results. */
  readonly ledgerSocket?: string;
  /** All run results as JSON, written when every run has ended. */
  readonly resultsPath: string;
}

export function readRunHostJob(path: string): RunHostJob {
  const j = JSON.parse(readFileSync(path, 'utf8')) as RunHostJob;
  if (j.format !== RUN_HOST_JOB_FORMAT) throw new TypeError(`unknown job format ${JSON.stringify(j.format)}`);
  id<LaunchId>(j.launch);
  if (!isAbsolute(j.recordsPath) || !isAbsolute(j.resultsPath)) throw new TypeError('records and results paths must be absolute');
  if (!Array.isArray(j.runs)) throw new TypeError('runs must be a list');
  return j;
}

export async function runHostJob(job: RunHostJob, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const envLaunch = env['MP_LAUNCH_ID'];
  if (envLaunch !== undefined && envLaunch !== job.launch) {
    throw new TypeError(`job is for launch ${job.launch} but the unit runs launch ${envLaunch}`);
  }
  const unit = unitCgroupFromEnv(env);
  const ledger = job.ledgerSocket !== undefined ? new LedgerClient(job.ledgerSocket) : null;
  const sandbox = await ToolSandbox.create(job.sandbox, {
    // W3: a recorded toolchain tree that failed its check is left out; the runs that need it fail as usual
    onToolchainSkipped: (skipped) => process.stderr.write(`[alert WI-18] toolchain-unavailable ${job.launch}: ${skipped.map((x) => `${x.src} (${x.reason})`).join('; ')}\n`),
    runLayers: {
      unit,
      launch: job.launch,
      record: async (r: RunLayerRecord) => {
        appendLineDurable(job.recordsPath, JSON.stringify(r));
        if (ledger !== null) await submitWithRetry(ledger, { op: `run-layer:${r.launch}:${r.run}`, launch: r.launch, records: [r] });
      },
    },
  });
  const results: SandboxRunResult[] = [];
  try {
    for (const r of job.runs) {
      const cwd = r.cwd === undefined || r.cwd === '.' ? sandbox.mountPoint : `${sandbox.mountPoint}/${r.cwd}`;
      results.push(
        await sandbox.runCommand({
          run: id<RunId>(r.run),
          command: r.command,
          cwd,
          timeoutMs: r.timeoutMs ?? 600_000,
          outputCapBytes: r.outputCapBytes ?? 64 * 1024,
          limits: r.limits,
        }),
      );
    }
  } finally {
    await sandbox.close();
    ledger?.close();
  }
  writeFileAtomic(job.resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  return 0;
}

/** submitPendingResult with a few retries; the op id makes a retry return the original result. */
export async function submitWithRetry(
  client: LedgerClient,
  req: { readonly op: string; readonly launch: LaunchId; readonly records: readonly BaseRecord[] },
  attempts = 5,
): Promise<void> {
  let delay = 500;
  for (let i = 1; ; i++) {
    try {
      await client.call('submitPendingResult', { op: req.op, launch: req.launch, records: req.records });
      return;
    } catch (e) {
      if (e instanceof RemoteLedgerError && e.code !== 'STORAGE_FAULT') throw e;
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

export function readRunRecords(path: string): RunLayerRecord[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunLayerRecord);
}
