// A child `mp` for the landing tests: opens the project memory and lands one
// delivery with the plain runner (optionally through a git wrapper), then
// prints the result as one JSON line. The test kills it mid-landing.

import { land } from '../src/git/land.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { openMemory } from '../src/memory/index.ts';
import type { MissionId } from '../src/common/ids.ts';

const a = JSON.parse(process.argv[2] ?? '{}') as { dir: string; mission: string; delivery: string; words: string; gitPath?: string; env?: Record<string, string> };
const memory = openMemory(a.dir);
try {
  const git = PlainGit.create({ ...(a.gitPath !== undefined ? { gitPath: a.gitPath } : {}), ...(a.env !== undefined ? { env: a.env } : {}) });
  const r = await land({ memory, git }, { mission: a.mission as MissionId, delivery: a.delivery, words: a.words });
  process.stdout.write(`${JSON.stringify(r)}\n`);
} finally {
  memory.close();
}
