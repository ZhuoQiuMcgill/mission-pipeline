// A minimal host for the scheduler tests (not a test file): the process a unit supervisor
// starts into the unit's control layer. It behaves like a seat host as far as the scheduler
// can see: control-plane heartbeats with its identity, pending results under its launch
// (with op ids), and an exit code. Usage: scheduler-fixture-host.ts <job.json>
//
// Job fields:
//   controlPlane, ledgerSocket       where heartbeats go, where results are submitted
//   heartbeatMs (default 200)        0: no heartbeats at all
//   goFile                           wait until this file exists before handing back
//   submit: 'end' | 'sigterm' | 'none'   when to submit the pending results (default 'end')
//   seat                             also record the Claude Code process's end (7.1 check 1)
//   seatStatus                       a seat.result record with this status
//   records                          extra pending records (JSON BaseRecords; "$LAUNCH" is replaced)
//   exitCode (default 0)
//   pidDir                           write <pidDir>/<launch>.pid (pid and start time)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/common/fsx.ts';
import type { LaunchId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { processIdentity } from '../src/exec/supervisor.ts';
import { LedgerClient } from '../src/ledger/ipc.ts';

interface Job {
  readonly controlPlane: string;
  readonly ledgerSocket: string;
  readonly heartbeatMs?: number;
  readonly goFile?: string;
  readonly submit?: 'end' | 'sigterm' | 'none';
  readonly seat?: boolean;
  readonly seatStatus?: string;
  readonly records?: readonly unknown[];
  readonly exitCode?: number;
  readonly pidDir?: string;
}

const job = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Job;
const launch = (process.env['MP_LAUNCH_ID'] ?? 'unknown') as LaunchId;
const self = processIdentity(process.pid);
const beatMs = job.heartbeatMs ?? 200;

function beat(phase: string): void {
  if (beatMs === 0) return;
  try {
    mkdirSync(join(job.controlPlane, 'heartbeats'), { recursive: true });
    writeFileAtomic(join(job.controlPlane, 'heartbeats', `${launch}.json`), JSON.stringify({ format: 'mp4.heartbeat.v1', launch, seat: 'test', ...self, at: Date.now(), phase }));
  } catch {
    /* best effort */
  }
}

beat('start');
const timer = beatMs > 0 ? setInterval(() => beat('running'), beatMs) : null;

async function submit(): Promise<void> {
  const recs: BaseRecord[] = [];
  for (const r of job.records ?? []) recs.push(JSON.parse(JSON.stringify(r).replaceAll('$LAUNCH', launch)) as BaseRecord);
  if (job.seat) recs.push({ kind: 'claude-code.exit', launch, exit: { code: 0, signal: null } });
  if (job.seatStatus !== undefined) {
    recs.push({ kind: 'seat.result', launch, seat: 'test', status: job.seatStatus as never, result: null, export: null, transcript: null, recoveryState: null, evidenceRequest: null } as BaseRecord);
  }
  if (recs.length === 0) return;
  const c = new LedgerClient(job.ledgerSocket, 10_000);
  for (let i = 0; ; i++) {
    try {
      await c.call('submitPendingResult', { op: `result:${launch}`, launch, records: recs });
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  c.close();
}

let ending = false;
async function end(code: number): Promise<void> {
  if (ending) return;
  ending = true;
  if (timer) clearInterval(timer);
  process.exit(code);
}

process.on('SIGTERM', () => {
  if ((job.submit ?? 'end') === 'sigterm') {
    void submit().then(
      () => end(0),
      () => end(1),
    );
  } else {
    void end(143);
  }
});

// The pid file is written only once the SIGTERM handler is in place: a test that suspends the
// host as soon as it sees the file must not catch it before the handler exists.
if (job.pidDir !== undefined) {
  mkdirSync(job.pidDir, { recursive: true });
  writeFileSync(join(job.pidDir, `${launch}.pid`), JSON.stringify(self));
}

async function main(): Promise<void> {
  if (job.goFile !== undefined) while (!existsSync(job.goFile)) await new Promise((r) => setTimeout(r, 50));
  beat('handing-back');
  if ((job.submit ?? 'end') === 'end') await submit();
  await end(job.exitCode ?? 0);
}

main().catch((e: unknown) => {
  process.stderr.write(`[test-host] ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
