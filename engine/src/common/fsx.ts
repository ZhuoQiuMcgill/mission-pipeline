// Durable file helpers (the memory's own are in memory/fsx.ts).

import { closeSync, fsyncSync, openSync } from 'node:fs';

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
