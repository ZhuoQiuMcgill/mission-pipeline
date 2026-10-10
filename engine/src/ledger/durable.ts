// Durable directory creation (design 6.1, 10.1; core review r2 F15).
//
// A new directory exists after a power loss only if its entry in the parent
// directory has been made durable, and the parent itself only if its own entry
// is durable, and so on up the chain. `mkdirSync({ recursive: true })` makes no
// such promise. mkdirDurable creates the missing levels one at a time and
// fsyncs each new level's parent before creating the next, so every committed
// record that refers to a file under the chain can find it after a crash.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fsyncDir } from '../common/fsx.ts';

export type FsyncDir = (dir: string) => void;

/**
 * Create `dir` and every missing ancestor, fsyncing the parent of each newly
 * created level, level by level from the top. Returns the directories it
 * created (top first). Existing directories are left alone.
 */
export function mkdirDurable(dir: string, fsync: FsyncDir = fsyncDir): string[] {
  const target = resolve(dir);
  const missing: string[] = [];
  let cur = target;
  while (!existsSync(cur)) {
    missing.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  missing.reverse();
  for (const d of missing) {
    try {
      mkdirSync(d);
    } catch (e) {
      // Another process created it meanwhile: its entry may not be durable yet, so sync anyway.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    fsync(dirname(d));
  }
  return missing;
}
