// Shared helpers for the stop inbox suites (test/ledger-stops-*.test.ts). Not a test file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSlot, readHeader, writeSlotSync, type InboxRecord } from '../src/ledger/inbox.ts';

export const ENGINE_SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** A primary location on /tmp (tmpfs here) and a backup location on /var/tmp (another filesystem: ext4 here). */
export function tempPair(): { primaryDir: string; backupDir: string; cleanup: () => void } {
  const primaryDir = mkdtempSync(join(tmpdir(), 'mp-stops-'));
  const backupDir = mkdtempSync(join('/var/tmp', 'mp-stops-backup-'));
  return {
    primaryDir,
    backupDir,
    cleanup: () => {
      rmSync(primaryDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    },
  };
}

/** Write one record straight into a slot (to build the evidence a previous boot left). */
export function putRecord(file: string, slot: number, record: InboxRecord): void {
  const h = readHeader(file);
  writeSlotSync(file, h, slot, encodeSlot(h.slotSize, record));
}

export async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killQuietly(pids: readonly number[]): void {
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/** A small script that imports engine modules by absolute path (for child processes). */
export function script(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body.replaceAll('@src/', ENGINE_SRC));
  return file;
}
