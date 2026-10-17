// A second `mp` process for the disk housekeeping tests (4.1.2, card P2). It opens the project's
// process context and either
//   own-run         makes a run's clean checkout (checkoutCommit, as runs.ts does) and stays alive
//                   holding it, or
//   stall-checkout  runs `mp seat <id> checkout` and stalls for good once it writes the first
//                   README.md of the tree (an interrupted build),
// then writes `marker` and waits; the test kills it by its process id.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { EnvironmentParts } from '../src/evaluator/index.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { checkoutCommit, runCheckoutDir } from '../src/git/workspace.ts';
import { openProcess, seatCheckout } from '../src/process/index.ts';

type Action =
  | { readonly action: 'own-run'; readonly dir: string; readonly env: EnvironmentParts; readonly commit: string; readonly run: string; readonly marker: string }
  | { readonly action: 'stall-checkout'; readonly dir: string; readonly env: EnvironmentParts; readonly dispatch: string; readonly marker: string };

const a = JSON.parse(process.argv[2] ?? '{}') as Action;
const ctx = openProcess(a.dir, { git: PlainGit.create(), observe: () => a.env, ident: { name: 'mp test', email: 'mp@test' } });
const stayAlive = (): void => {
  setInterval(() => {}, 1 << 30);
};
if (a.action === 'own-run') {
  await checkoutCommit(ctx.gitCtx, { commit: a.commit, dir: runCheckoutDir(ctx.memory.paths, a.run), repository: true });
  fs.writeFileSync(a.marker, 'ready');
  stayAlive();
} else {
  const write = fs.writeFileSync;
  const tmp = ctx.memory.paths.tmp;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    write(file, data, options);
    if (typeof file === 'string' && file.startsWith(tmp) && file.endsWith('README.md')) {
      write(a.marker, 'stalled');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // blocks here until killed
    }
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  await seatCheckout(ctx, a.dispatch);
  write(a.marker, 'finished without stalling');
  stayAlive();
}
