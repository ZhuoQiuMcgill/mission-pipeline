// The PM's work instructions (design 4.1 §6.9; U-8): the PM's standing context holds only the
// INDEX (one line per WI); each page (trigger and evidence, the default action already taken, the
// options with their `mp` commands and outcomes, how to choose, when to ask the user) is opened
// only when a notice names it. Notices and refusals print the WI number, its title and the page.
//
// Pages: the project's copy `.mission-pipeline/pm/wi/` (what `mp init` and `mp docs update` copy
// in), else the pages installed with this `mp` (`plugin/pm/wi/`).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed handbook (`plugin/pm/` of this `mp`). */
export const INSTALLED_PM_DIR = fileURLToPath(new URL('../../plugin/pm/', import.meta.url)).replace(/[\\/]$/, '');

/** The 4.1 work instructions (numbers of retired WIs are not reused). */
export const WI_41: readonly string[] = ['01', '02', '03', '04', '05', '06', '07', '08', '13', '16', '19', '20', '21', '23', '24', '25', '26', '28', '29', '30', '31', '32', '33', '34'].map((n) => `WI-${n}`);

const WI_SET: ReadonlySet<string> = new Set(WI_41);

export function isWi(wi: string | null | undefined): wi is string {
  return typeof wi === 'string' && WI_SET.has(wi);
}

/** The directory holding INDEX.md and the WI pages: the project's copy when it has one, else the installed pages. */
export function wiDir(projectDir?: string | null): string {
  if (projectDir !== undefined && projectDir !== null) {
    const own = join(projectDir, '.mission-pipeline', 'pm', 'wi');
    if (existsSync(join(own, 'INDEX.md'))) return own;
  }
  return join(INSTALLED_PM_DIR, 'wi');
}

/** The page of one WI, or null for something that is not a 4.1 WI number. */
export function wiPagePath(wi: string | null | undefined, projectDir?: string | null): string | null {
  return isWi(wi) ? join(wiDir(projectDir), `${wi}.md`) : null;
}

/** The page as the project refers to it: relative to the project folder when it is the project's copy. */
export function wiPageRef(wi: string | null | undefined, projectDir?: string | null): string | null {
  const p = wiPagePath(wi, projectDir);
  if (p === null) return null;
  if (projectDir !== undefined && projectDir !== null && p.startsWith(join(projectDir, '.mission-pipeline'))) return `.mission-pipeline/pm/wi/${wi}.md`;
  return p;
}

const titles = new Map<string, string>();

/** The WI's title (the page's first heading), or null. */
export function wiTitle(wi: string | null | undefined, projectDir?: string | null): string | null {
  const p = wiPagePath(wi, projectDir);
  if (p === null) return null;
  const cached = titles.get(p);
  if (cached !== undefined) return cached;
  try {
    const first = readFileSync(p, 'utf8').split('\n', 1)[0] ?? '';
    const t = first.replace(/^#\s*WI-\d+\s*/, '').trim();
    titles.set(p, t);
    return t;
  } catch {
    return null;
  }
}

/** "WI-06 A landing did not complete... (page: .mission-pipeline/pm/wi/WI-06.md)", or null. */
export function wiRef(wi: string | null | undefined, projectDir?: string | null): string | null {
  if (!isWi(wi)) return null;
  const t = wiTitle(wi, projectDir);
  return `${wi}${t !== null ? ` ${t}` : ''} (page: ${wiPageRef(wi, projectDir)})`;
}

/** The index for the PM's standing context. */
export function wiIndexText(projectDir?: string | null): string {
  const dir = wiDir(projectDir);
  try {
    return readFileSync(join(dir, 'INDEX.md'), 'utf8').trim();
  } catch {
    return `(the WI index cannot be read: ${join(dir, 'INDEX.md')})`;
  }
}

/** The PM handbook's file: the project's copy, else the installed one. */
export function pmHandbookPath(projectDir?: string | null): string {
  if (projectDir !== undefined && projectDir !== null) {
    const own = join(projectDir, '.mission-pipeline', 'pm', 'PM.md');
    if (existsSync(own)) return own;
  }
  return join(INSTALLED_PM_DIR, 'PM.md');
}

/** The core of the PM handbook (PM.md between the core markers): what the PM reads at every session start. */
export function pmCoreText(projectDir?: string | null): string {
  const file = pmHandbookPath(projectDir);
  try {
    const t = readFileSync(file, 'utf8');
    const a = t.indexOf('<!-- core:start -->');
    const b = t.indexOf('<!-- core:end -->');
    if (a === -1 || b === -1 || b < a) return `(the core section of the PM handbook is missing: ${file})`;
    return t.slice(a + '<!-- core:start -->'.length, b).trim();
  } catch {
    return `(the PM handbook cannot be read: ${file})`;
  }
}
