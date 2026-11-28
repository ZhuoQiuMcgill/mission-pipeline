// Durable file helpers (the memory's own are in memory/fsx.ts).

import { closeSync, fsyncSync, openSync } from 'node:fs';

/**
 * Make a directory's entries durable. 4.4.1 (Windows): a directory cannot be opened for fsync
 * there (EPERM, which failed every LFS object store); NTFS journals the rename itself, so the
 * step is skipped, as memory/fsx.ts syncDir does.
 */
export function fsyncDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
