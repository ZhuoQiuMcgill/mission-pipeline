// The PM's work-instruction handbook (design 3.11, WI-01 to WI-22), as the plugin ships it
// (maintainer ruling 2026-10-09): the PM's standing context holds only the INDEX (one line
// per WI); each WI's page (trigger and evidence, the default action already taken, the
// options with their `mp` commands and outcomes, how to choose, when to ask the user) is a
// separate file the PM opens only when a notice names that WI. Notices and refusals print
// the WI number, its title and the page's path; the pages are the only place the details
// live.
//
// Pages: plugin/pm/wi/INDEX.md and plugin/pm/wi/WI-NN.md, found under $CLAUDE_PLUGIN_ROOT
// (an installed plugin) or next to this engine (engine/plugin).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLED = fileURLToPath(new URL('../../plugin/pm/wi/', import.meta.url));

/** The directory holding INDEX.md and the WI pages. */
export function wiDir(env: NodeJS.ProcessEnv = process.env): string {
  const pr = env['CLAUDE_PLUGIN_ROOT'];
  if (pr !== undefined && pr !== '' && existsSync(join(pr, 'pm', 'wi', 'INDEX.md'))) return join(pr, 'pm', 'wi');
  return BUNDLED.replace(/\/$/, '');
}

export function isWi(wi: string | null | undefined): wi is string {
  return typeof wi === 'string' && /^WI-(0[1-9]|1\d|2[0-7])$/.test(wi);
}

/** The page of one WI, or null for something that is not a WI number. */
export function wiPagePath(wi: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  return isWi(wi) ? join(wiDir(env), `${wi}.md`) : null;
}

const titles = new Map<string, string>();

/** The WI's title (the page's first heading), or null. */
export function wiTitle(wi: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const p = wiPagePath(wi, env);
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

/** "WI-11 The evaluator is in its fault state... (WI page: <path>)" */
export function wiRef(wi: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isWi(wi)) return null;
  const t = wiTitle(wi, env);
  return `${wi}${t !== null ? ` ${t}` : ''} (WI page: ${wiPagePath(wi, env)})`;
}

/** The index for the PM's standing context, with where the pages are. */
export function wiIndexText(env: NodeJS.ProcessEnv = process.env): string {
  const dir = wiDir(env);
  try {
    return `${readFileSync(join(dir, 'INDEX.md'), 'utf8').trim()}\n(WI pages: ${dir})`;
  } catch {
    return `(the WI index cannot be read: ${join(dir, 'INDEX.md')})`;
  }
}

/**
 * The PM's one-page definition, its core only (plugin/pm/PM.md between the core markers): what
 * the session-start hook puts into the PM's standing context next to the WI index.
 */
export function pmCoreText(env: NodeJS.ProcessEnv = process.env): string {
  const file = join(wiDir(env), '..', 'PM.md');
  try {
    const t = readFileSync(file, 'utf8');
    const a = t.indexOf('<!-- core:start -->');
    const b = t.indexOf('<!-- core:end -->');
    if (a === -1 || b === -1 || b < a) return `(the core section of the PM handbook is missing: ${file})`;
    return `${t.slice(a + '<!-- core:start -->'.length, b).trim()}\n(the full PM handbook: ${file})`;
  } catch {
    return `(the PM handbook cannot be read: ${file})`;
  }
}
