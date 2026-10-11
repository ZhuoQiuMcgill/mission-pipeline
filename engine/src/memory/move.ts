// Copying and moving the folder (design 4.1 §3.3; r1 F1, r2 F3, r3 F3, v04
// check B2). A plain copy of the folder is the whole procedure, done while no
// `mp` command runs and no seat is working. On every open, `mp` compares the
// recorded project path and machine with the current ones, and looks for an
// unfinished move. When either changed, or a move is unfinished, it takes the
// folder's maintenance lock and then, before any other command:
//   1. records "move pending" (old and new path and machine) unless recorded;
//   2. runs `git worktree repair` for its worktrees, only when the git common
//      directory lies inside the folder; otherwise it skips this, rewrites
//      nothing, and holds every command that writes to git until the PM
//      confirms (under the WI) that this copy is the one in use;
//   3. verifies the event log's hash chain;
//   4. rebuilds the state tables (and the extensions' tables) from the log;
//   5. checks every leaf reference and every commit the memory names, with the
//      objects it needs;
//   6. records "move done", with what step 5 found, in the transaction that
//      installs the rebuilt tables (steps 4 to 6 are one transaction).
// A crash at any step leaves "move pending", so the next open starts again
// from step 2; a second process that opens meanwhile waits on the maintenance
// lock, or gets MOVING after the busy limit. A broken chain is not rebuilt
// from: the move is finished without an event (writes are refused anyway) and
// the PM follows the WI.
//
// Everything about where this copy lives is kept in `meta`, outside the log:
// the log is the same in every copy; the place is not.

import { hostname } from 'node:os';
import { canonicalJson } from '../common/hash.ts';
import { inspectChain, type ChainReport } from './chain.ts';
import { deleteKey, setKey, type Db } from './db.ts';
import { LedgerError } from './errors.ts';
import type { GitStepOutcome, MoveFindings, Place } from './events.ts';
import { memoryWorktrees, repairWorktrees, repositoryLayout, unreachableCommits } from './git.ts';
import { checkAllLeaves } from './leaves.ts';
import { lock } from './locks.ts';
import type { Memory } from './memory.ts';
import { rebuildState } from './rebuild.ts';

/** Test hooks: called after each step of the recovery (1 to 6); a hook that kills the process simulates a crash there. */
export interface MoveHooks {
  readonly afterMoveStep?: (step: number) => void;
}

/** This machine, as far as a copy of the folder can tell (§3.3): host name, operating system and architecture. */
export function machineIdentity(): string {
  return `${hostname()}/${process.platform}/${process.arch}`;
}

const LIST_CAP = 1000;

/** Commits the core skeleton names: deliveries and their bases, landing and delivery-ref intents, product versions' source commits. */
export function namedCommits(m: Memory, db: Db): string[] {
  const out = new Set<string>();
  for (const r of db.stmt('SELECT commit_id, base FROM deliveries').all() as Array<{ commit_id: string; base: string }>) {
    out.add(r.commit_id);
    out.add(r.base);
  }
  for (const r of db.stmt('SELECT delivery FROM intents WHERE delivery IS NOT NULL').all() as Array<{ delivery: string }>) {
    const d = JSON.parse(r.delivery) as { commit?: string; base?: string };
    if (d.commit) out.add(d.commit);
    if (d.base) out.add(d.base);
  }
  const page = db.stmt("SELECT rev, record FROM log WHERE kind = 'object.version' AND rev > ? ORDER BY rev LIMIT 5000");
  for (let after = 0; ; ) {
    const rows = page.all(after) as Array<{ rev: number; record: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const c = (JSON.parse(r.record) as { source?: { commit?: string } }).source?.commit;
      if (c) out.add(c);
      after = Number(r.rev);
    }
  }
  for (const c of m.extensionCommits(db)) out.add(c);
  return [...out];
}

function needsRecovery(m: Memory, here: Place): boolean {
  return m.getMeta('move') !== null || m.getMeta('project_path') !== here.path || m.getMeta('machine') !== here.machine;
}

/** Steps 2 to 6; "move pending" is already recorded. */
function recover(m: Memory, from: Place, here: Place): void {
  const hook = m.hooks?.afterMoveStep;
  // 2. git
  let gitStep: GitStepOutcome;
  const layout = repositoryLayout(m.git, m.projectDir);
  if (m.git === null || !layout.repository) gitStep = { kind: 'no-repository' };
  else if (layout.commonDirOutside) {
    gitStep = { kind: 'held', reason: `the repository's common git directory ${layout.commonDir} lies outside the folder, so this copy may share it with the original` };
  } else {
    const worktrees = memoryWorktrees(m.paths.worktrees);
    const r = worktrees.length === 0 ? { code: 0, stdout: '', stderr: '' } : repairWorktrees(m.git, m.projectDir, worktrees);
    gitStep = r.code === 0 ? { kind: 'repaired', worktrees: worktrees.length } : { kind: 'held', reason: `git worktree repair failed: ${r.stderr.trim().slice(0, 500)}` };
  }
  hook?.(2);
  // 3. the chain
  // The recovery's own, controlled verification: a broken chain is recorded below, with the move.
  const chain: ChainReport = m.read((db) => inspectChain(db));
  hook?.(3);
  // 4 to 6: one transaction.
  m.maintenance(
    (tx) => {
      if (chain.ok) rebuildState(tx, m.extensions);
      hook?.(4);
      const leaves = checkAllLeaves(m.paths.root, tx, LIST_CAP);
      const named = namedCommits(m, tx);
      const commits = m.git === null || !layout.repository ? null : unreachableCommits(m.git, m.projectDir, named);
      const findings: MoveFindings = {
        chain: { ok: chain.ok, lastValid: chain.lastValid, brokenAt: chain.brokenAt, reason: chain.reason },
        git: gitStep,
        leaves,
        commits:
          commits === null
            ? { checked: 0, unreachable: [], unreachableCount: 0, skipped: 'no repository' }
            : { checked: named.length, unreachable: commits.slice(0, LIST_CAP), unreachableCount: commits.length, skipped: null },
        layout: layout.warnings,
      };
      hook?.(5);
      if (chain.ok) tx.append({ kind: 'memory.moved', from, to: here, findings });
      setKey(tx, 'meta', 'project_path', here.path);
      setKey(tx, 'meta', 'machine', here.machine);
      setKey(tx, 'meta', 'last_move', canonicalJson({ from, to: here, at: tx.at, findings }));
      if (gitStep.kind === 'held') setKey(tx, 'meta', 'git_hold', canonicalJson({ reason: gitStep.reason, since: tx.at }));
      else deleteKey(tx, 'meta', 'git_hold');
      if (chain.ok) deleteKey(tx, 'meta', 'chain_broken');
      else setKey(tx, 'meta', 'chain_broken', canonicalJson(chain));
      deleteKey(tx, 'meta', 'move');
    },
    { chain: false },
  );
  hook?.(6);
}

/**
 * The check every open makes (§3.3): when the folder was copied or moved, or a
 * recovery is unfinished, recover it under the maintenance lock before the
 * caller does anything else.
 */
export function recoverIfMoved(m: Memory, here: Place): void {
  if (!needsRecovery(m, here)) return;
  let held;
  try {
    held = lock(m.paths.locks, 'maintenance', { waitMs: m.busyTimeoutMs });
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'LOCKED') throw new LedgerError('MOVING', `another mp process is recovering this folder after a move (waited ${m.busyTimeoutMs} ms): retry`);
    throw e;
  }
  try {
    // Another process may have finished it while this one waited.
    if (!needsRecovery(m, here)) return;
    const pending = m.getMeta('move');
    let from: Place;
    if (pending === null) {
      from = { path: m.getMeta('project_path') ?? '', machine: m.getMeta('machine') ?? '' };
      // 1. move pending
      m.maintenance((tx) => setKey(tx, 'meta', 'move', canonicalJson({ from, to: here, startedAt: tx.at })), { chain: false });
    } else {
      const p = JSON.parse(pending) as { from: Place; to: Place };
      from = p.from;
      // A recovery left unfinished at another place (copied again mid-recovery) restarts for this one.
      if (p.to.path !== here.path || p.to.machine !== here.machine) m.maintenance((tx) => setKey(tx, 'meta', 'move', canonicalJson({ from, to: here, startedAt: tx.at })), { chain: false });
    }
    m.hooks?.afterMoveStep?.(1);
    recover(m, from, here);
  } finally {
    held.release();
  }
}
