// A second `mp` process for the run-lock tests: opens the project's process context (the same
// environment observation as the test's) and either verifies a candidate (what a flow step that
// advances does) or hands a dispatch back (`mp seat <id> handback`). It prints its answer as one
// JSON line; the test may kill it while its command runs.

import type { MissionId } from '../src/common/ids.ts';
import type { EnvironmentParts } from '../src/evaluator/index.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { openProcess, seatHandback } from '../src/process/index.ts';

type Action =
  | { readonly action: 'verify'; readonly dir: string; readonly env: EnvironmentParts; readonly mission: string; readonly object: string; readonly commit: string; readonly commands: ReadonlyArray<{ id: string; command: string; cwd?: string }> }
  | { readonly action: 'handback'; readonly dir: string; readonly env: EnvironmentParts; readonly dispatch: string; readonly report: string; readonly result: string };

const a = JSON.parse(process.argv[2] ?? '{}') as Action;
const ctx = openProcess(a.dir, { git: PlainGit.create(), observe: () => a.env, ident: { name: 'mp test', email: 'mp@test' } });
try {
  if (a.action === 'verify') {
    const r = await ctx.actions().verify({ mission: a.mission as MissionId, object: a.object, snapshot: a.commit, commands: a.commands });
    process.stdout.write(`${JSON.stringify(r === 'pending' ? { pending: true } : { runs: r })}\n`);
  } else {
    const r = await seatHandback(ctx, a.dispatch, { report: a.report, result: a.result });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  }
} finally {
  ctx.memory.close();
}
