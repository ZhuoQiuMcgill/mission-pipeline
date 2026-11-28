// 4.4.1 (Windows): whether this account may create a symbolic link to a file. Windows allows it only
// with Developer Mode or the "create symbolic links" privilege; a test that needs one is skipped there
// with this reason, and runs everywhere else.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let probed: boolean | null = null;

export function canSymlink(): boolean {
  if (probed !== null) return probed;
  const dir = mkdtempSync(join(tmpdir(), 'mp-link-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    probed = true;
  } catch {
    probed = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return probed;
}

/** The skip option of a test that creates a symbolic link to a file. */
export function needsSymlink(): { readonly skip: string | false } {
  return { skip: canSymlink() ? false : 'this account may not create symbolic links (Windows without Developer Mode or the privilege)' };
}
