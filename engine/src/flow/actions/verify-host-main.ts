// Entry point of a verification unit the flows queue (design 4.1 "验证命令由程序在沙箱中执行并
// 记录", 7.1 "程序的验证运行也是执行单元"). The scheduler assigns each launch its id
// (MP_LAUNCH_ID, set by the unit supervisor); the job template holds everything else. This
// stamps the template with the launch (its own session directory, records and results under
// runs/<launch>/) and runs it with the program's run host (src/exec/run-host.ts): one sandbox,
// each declared command in its own run layer, every run layer recorded under the launch.
// Usage: verify-host-main.ts <template.json>

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { id, type LaunchId } from '../../common/ids.ts';
import { RUN_HOST_JOB_FORMAT, runHostJob, type RunHostJob } from '../../exec/run-host.ts';
import { VERIFY_TEMPLATE_FORMAT, type VerifyTemplate } from './verify.ts';

const path = process.argv[2];
let code = 2;
try {
  if (path === undefined) throw new Error('usage: verify-host-main.ts <template.json>');
  const t = JSON.parse(readFileSync(path, 'utf8')) as VerifyTemplate;
  if (t.format !== VERIFY_TEMPLATE_FORMAT) throw new Error(`unknown template format ${JSON.stringify(t.format)}`);
  const launch = id<LaunchId>(process.env['MP_LAUNCH_ID'] ?? '');
  const dir = join(t.dir, 'runs', launch);
  const sessionDir = join(dir, 'session');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const job: RunHostJob = {
    format: RUN_HOST_JOB_FORMAT,
    launch,
    sandbox: { ...t.sandbox, sessionDir },
    runs: t.runs,
    recordsPath: join(dir, 'records.jsonl'),
    resultsPath: join(dir, 'results.json'),
    ...(t.ledgerSocket !== undefined ? { ledgerSocket: t.ledgerSocket } : {}),
  };
  code = await runHostJob(job);
} catch (e) {
  process.stderr.write(`[verify-host] fatal: ${(e as Error).stack ?? String(e)}\n`);
  code = 1;
}
process.exit(code);
