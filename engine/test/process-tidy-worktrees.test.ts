// `mp pm next` tidies the worktrees of dispatches that are over (src/process/pm.ts tidyWorktrees):
// a folder a crash after the hand-back left is removed; a dispatch whose folder is already gone
// costs no removal (each removal asks git for its worktree list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCandidate, ensureWorkspace, releaseWorkspace, removeWorkspace, workspaceDir } from '../src/git/workspace.ts';
import { pmNext, type ProcessContext } from '../src/process/index.ts';
import { ENV_A, addMissionToReview, processProject } from './process-fixtures.ts';

test('pm next: a finished dispatch whose worktree folder is gone is skipped; a leftover folder is removed', async () => {
  const p = processProject();
  try {
    const { constructor: dispatch } = await addMissionToReview(p, 'm1');
    const folder = workspaceDir(p.ctx.memory.paths, dispatch);
    assert.equal(existsSync(folder), false, 'removed at its hand-back');
    let removals = 0;
    const ctx = p.reopen(ENV_A, {
      workspaces: (c: ProcessContext) => ({
        ensure: (d, base) => ensureWorkspace(c.gitCtx, { dispatch: d, base }),
        remove: (d) => {
          removals++;
          return removeWorkspace(c.gitCtx, d);
        },
        release: (d, how) => releaseWorkspace(c.gitCtx, d, how),
        collect: (req) => collectCandidate(c.gitCtx, req),
      }),
    });
    await pmNext(ctx);
    assert.equal(removals, 0, 'no folder: nothing to remove, no removal started');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'left.txt'), 'a crash after the hand-back left this\n');
    await pmNext(ctx);
    assert.equal(removals, 1);
    assert.equal(existsSync(folder), false, 'the leftover folder is removed');
  } finally {
    p.cleanup();
  }
});
