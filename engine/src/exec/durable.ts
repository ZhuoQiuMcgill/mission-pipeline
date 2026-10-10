// Durable files and directory chains of the execution layer (design 7.1 "证明安全落盘后才删除",
// 6.3 proof files, v35 cleanup state files; code review r1 finding 12).
//
// A proof file is only "safe on disk" when every directory entry leading to it is durable:
// the file's own data (fsync), its name in its directory (directory fsync after the rename),
// and, for a directory created on the way, that directory's name in ITS parent. A new
// `proofs/` directory whose entry in the state directory was never synced can vanish with a
// power loss even though the proof inside it was fsynced. So the chains are created and
// synced once at the supervisor's start (prepareStateDirs), before any unit runs, and every
// later write re-checks the chain cheaply (an existing chain is not walked again).
//
// The steps are observable (DurableOps) so tests can record their order and inject a
// supervisor death at each step of the atomic write (design §14 item 9: "在临时文件写入、改名、
// 目录落盘之前被结束").

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/** The steps of an atomic durable write, in order. */
export type DurableStep = 'temp-write' | 'temp-fsync' | 'rename' | 'dir-sync';

/** The primitive operations, replaceable to record their order or to inject faults. */
export interface DurableOps {
  mkdir(dir: string): void;
  fsyncDir(dir: string): void;
  /** Called before each step of writeDurable; a test may end the process here. */
  before?(step: DurableStep, path: string): void;
}

function fsyncDirReal(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const REAL_DURABLE_OPS: DurableOps = {
  mkdir: (dir) => mkdirSync(dir, { mode: 0o700 }),
  fsyncDir: fsyncDirReal,
};

/**
 * Makes `dir` exist durably, with every level from `anchor` down: each missing level is
 * created, and each level of the chain is synced together with its parent, so the names of
 * the whole chain are durable afterwards ("each new directory and its parent"). Levels above
 * `anchor` that are missing are created the same way (and their parents synced). `anchor`
 * must be `dir` or one of its ancestors. Returns the directories it created, top first.
 */
export function ensureDirChainDurable(dir: string, anchor: string, ops: DurableOps = REAL_DURABLE_OPS): string[] {
  const target = resolve(dir);
  const top = resolve(anchor);
  if (target !== top && !target.startsWith(`${top}/`)) throw new RangeError(`${anchor} is not an ancestor of ${dir}`);
  // missing ancestors of the anchor: create top-down, syncing each new level's parent
  const created: string[] = [];
  const above: string[] = [];
  for (let cur = dirname(top); !existsSync(cur); cur = dirname(cur)) {
    above.push(cur);
    if (dirname(cur) === cur) break;
  }
  for (const d of above.reverse()) {
    mkdirOnce(d, ops);
    ops.fsyncDir(dirname(d));
    created.push(d);
  }
  // the chain itself: anchor, ..., dir; each level created if missing, then synced with its parent
  const levels: string[] = [];
  for (let cur = target; ; cur = dirname(cur)) {
    levels.push(cur);
    if (cur === top) break;
  }
  levels.reverse();
  for (const d of levels) {
    if (!existsSync(d)) {
      mkdirOnce(d, ops);
      created.push(d);
    } else if (!statSync(d).isDirectory()) {
      throw Object.assign(new Error(`${d} is not a directory`), { code: 'ENOTDIR' });
    }
    ops.fsyncDir(dirname(d));
    ops.fsyncDir(d);
  }
  return created;
}

function mkdirOnce(d: string, ops: DurableOps): void {
  try {
    ops.mkdir(d);
  } catch (e) {
    // another process created it meanwhile: its entry may not be durable yet, the caller syncs anyway
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * tmp file in the same directory, write, fsync, rename, directory fsync. The file either
 * exists complete or not at all; a crash before the rename leaves only a dot-named temporary
 * file that readers ignore. The directory must already be durable (ensureDirChainDurable).
 */
export function writeDurable(path: string, data: string | Uint8Array, ops: DurableOps = REAL_DURABLE_OPS): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  ops.before?.('temp-write', tmp);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    ops.before?.('temp-fsync', tmp);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  closeSync(fd);
  ops.before?.('rename', path);
  renameSync(tmp, path);
  ops.before?.('dir-sync', dir);
  ops.fsyncDir(dir);
}

/** Removes a file and makes the removal durable (its directory synced). */
export function unlinkDurable(path: string, ops: DurableOps = REAL_DURABLE_OPS): boolean {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  ops.fsyncDir(dirname(path));
  return true;
}

/**
 * A fault plan for tests (design §14 item 9): the process ends itself with SIGKILL right
 * before `step` of the write of a file whose name matches. Production configurations never
 * carry one.
 */
export interface FaultPlan {
  readonly dieBefore: DurableStep;
  /** Basename prefix of the file whose write is cut (e.g. the proof file's "<launch>.json"). */
  readonly file: string;
}

export function opsWithFault(plan: FaultPlan | undefined, base: DurableOps = REAL_DURABLE_OPS): DurableOps {
  if (plan === undefined) return base;
  return {
    ...base,
    before(step, path) {
      base.before?.(step, path);
      const name = basename(path);
      const target = step === 'temp-write' || step === 'temp-fsync' ? name.startsWith(`.${plan.file}.`) : step === 'rename' ? name === plan.file : true;
      if (step === plan.dieBefore && target) process.kill(process.pid, 'SIGKILL');
    },
  };
}
