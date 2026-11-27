// 4.4 (F19, #64): candidate and accepted commits must survive `git gc --prune=now` before delivery.
// The test runs git gc only inside the scratch repository processProject makes under the system's
// temporary folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { acceptedProduct } from '../src/flow/execution.ts';
import { flowCtx } from '../src/flow/context.ts';
import type { MissionId } from '../src/common/ids.ts';
import { anchorCommit } from '../src/process/actions.ts';
import { addMissionToReview, processProject, reviewerPass, step } from './process-fixtures.ts';

function exists(dir: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('#64: an accepted product\'s commit survives git gc --prune=now before delivery', async () => {
  const p = processProject();
  try {
    const { candidate } = await addMissionToReview(p, 'm1');
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    const product = await acceptedProduct(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'impl');
    assert.ok(product !== null, 'accepted');
    const source = (p.ctx.memory.stmt("SELECT json_extract(record, '$.source.commit') AS c FROM log WHERE kind = 'object.version' AND json_extract(record, '$.object') = ?").get(product) as { c: string }).c;
    assert.equal(source, candidate);
    assert.ok(exists(p.dir, candidate));
    p.git('gc', '--prune=now', '--quiet');
    assert.ok(exists(p.dir, candidate), 'the accepted commit was pruned: nothing held it before delivery');
    // the anchor is a program ref: no branch, no tag
    assert.equal(p.git('rev-parse', `refs/mission-pipeline/kept/m1/${candidate}`), candidate);
    assert.equal(p.git('branch', '--list', '--all', '--format=%(refname)'), 'refs/heads/main');
    assert.equal(p.git('tag', '--list'), '');
  } finally {
    p.cleanup();
  }
});

test('#64: no anchor while git writes are held after a move; nothing is refused', async () => {
  const p = processProject();
  try {
    const head = p.git('rev-parse', 'HEAD');
    p.ctx.memory.connection.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('git_hold', ?)").run(JSON.stringify({ reason: 'the folder was moved' }));
    assert.equal(anchorCommit(p.ctx, 'm1', head), false);
    assert.equal(p.git('for-each-ref', 'refs/mission-pipeline/'), '');
  } finally {
    p.cleanup();
  }
});
