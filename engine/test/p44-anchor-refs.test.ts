// 4.4 (F19, #64): candidate and accepted commits must survive `git gc --prune=now` before delivery.
// The test runs git gc only inside the scratch repository processProject makes under the system's
// temporary folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { acceptedProduct } from '../src/flow/execution.ts';
import { flowCtx } from '../src/flow/context.ts';
import type { MissionId } from '../src/common/ids.ts';
import { anchorCommit, anchorMarker } from '../src/process/actions.ts';
import { setCursor } from '../src/memory/index.ts';
import { pmNext } from '../src/process/pm.ts';
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

/** As 4.3 left it: no kept ref for the candidate, and no anchor marker for the mission. */
function as43(p: ReturnType<typeof processProject>, commit: string): void {
  p.git('update-ref', '-d', `refs/mission-pipeline/kept/m1/${commit}`);
  p.ctx.memory.write({}, (tx) => {setCursor(tx, { cursor: anchorMarker('m1'), rev: 0 });});
}

test('#64 (review p2-1): a product recorded under 4.3 is anchored when it is accepted under 4.4', async () => {
  const p = processProject();
  try {
    const { candidate } = await addMissionToReview(p, 'm1');
    as43(p, candidate);
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    assert.equal(p.git('for-each-ref', '--format=%(objectname)', 'refs/mission-pipeline/kept/m1/'), candidate, 'acceptance only appended its event');
    p.git('gc', '--prune=now', '--quiet');
    assert.ok(exists(p.dir, candidate));
  } finally {
    p.cleanup();
  }
});

test('#64 (review p2-1): a reconciliation anchors accepted products of an upgraded mission once, then lists nothing; a failed write is retried', async () => {
  const p = processProject();
  try {
    const { candidate } = await addMissionToReview(p, 'm1');
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    // an upgraded mission's accepted, undelivered product, while git writes are held: nothing is written, nothing is lost
    as43(p, candidate);
    p.ctx.memory.connection.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('git_hold', ?)").run(JSON.stringify({ reason: 'the folder was moved' }));
    await pmNext(p.ctx);
    assert.equal(p.git('for-each-ref', 'refs/mission-pipeline/kept/'), '');
    p.ctx.memory.connection.prepare("DELETE FROM meta WHERE key = 'git_hold'").run();
    await pmNext(p.ctx);
    assert.equal(p.git('for-each-ref', '--format=%(objectname)', 'refs/mission-pipeline/kept/m1/'), candidate);
    // anchored: later passes make no git call for it
    const git = p.ctx.git as unknown as { runSync: (args: readonly string[], o: unknown) => unknown };
    const runSync = git.runSync.bind(p.ctx.git);
    let listings = 0;
    git.runSync = (args, o) => {if (args[0] === 'for-each-ref') listings++; return runSync(args, o);};
    await pmNext(p.ctx);
    await pmNext(p.ctx);
    assert.equal(listings, 0);
    p.git('gc', '--prune=now', '--quiet');
    assert.ok(exists(p.dir, candidate));
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
