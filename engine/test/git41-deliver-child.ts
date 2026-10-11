// A child `mp` for the delivery tests: opens the project memory and delivers
// one request with the plain runner (through a git wrapper), then prints the
// result as one JSON line. The test kills it while its git step runs.

import { deliver } from '../src/delivery/delivery.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { openMemory } from '../src/memory/index.ts';
import type { DeliverRequest } from '../src/delivery/delivery.ts';

const a = JSON.parse(process.argv[2] ?? '{}') as { dir: string; gitPath: string; req: DeliverRequest };
const memory = openMemory(a.dir);
try {
  const labels = { revision: memory.head(), recomputing: false, labelOf: () => 'proven' as const, decidingRuns: () => [], recomputingIn: () => false };
  const r = await deliver({ memory, git: PlainGit.create({ gitPath: a.gitPath }) }, a.req, { labels });
  process.stdout.write(`${JSON.stringify(r)}\n`);
} finally {
  memory.close();
}
