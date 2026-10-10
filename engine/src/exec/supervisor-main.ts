// Entry point of the unit supervisor: the main process of a transient systemd user
// service (see supervisor.ts and launchUnitSupervisor). Usage: supervisor-main.ts <config.json>

import { readFileSync } from 'node:fs';
import { parseSupervisorConfig, runSupervisor } from './supervisor.ts';

const configPath = process.argv[2];
let code = 2;
if (configPath === undefined) {
  process.stderr.write('usage: supervisor-main.ts <config.json>\n');
} else {
  try {
    const config = parseSupervisorConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    code = await runSupervisor(config);
  } catch (e) {
    process.stderr.write(`[unit-supervisor] fatal: ${(e as Error).stack ?? String(e)}\n`);
    code = 1;
  }
}
process.exit(code);
