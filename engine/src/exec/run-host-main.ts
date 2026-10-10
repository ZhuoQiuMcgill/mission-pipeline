// Entry point of a verification-run host (run-host.ts), started by the unit supervisor into
// the unit's control layer. Usage: run-host-main.ts <job.json>

import { readRunHostJob, runHostJob } from './run-host.ts';

const jobPath = process.argv[2];
let code = 2;
if (jobPath === undefined) {
  process.stderr.write('usage: run-host-main.ts <job.json>\n');
} else {
  try {
    code = await runHostJob(readRunHostJob(jobPath));
  } catch (e) {
    process.stderr.write(`[run-host] fatal: ${(e as Error).stack ?? String(e)}\n`);
    code = 1;
  }
}
process.exit(code);
