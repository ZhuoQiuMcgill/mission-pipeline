// The seats' one-page role descriptions (design 4.1 §1.2, §5.2): `roles/<seat>.md`, the single
// source of every card's role text. `mp init` copies the installed pages into the project
// folder (`.mission-pipeline/roles/`), so a project reads its own copy (the version it was
// initialized or refreshed with); without one, the installed page is used.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed role pages (`plugin/roles/` of this `mp`). */
export const INSTALLED_ROLES_DIR = fileURLToPath(new URL('../../../plugin/roles/', import.meta.url));

const SEAT = /^[a-z][a-z0-9-]{0,63}$/;
const cache = new Map<string, string>();

/** The file of a seat's role page: the project's copy when it has one, else the installed page. */
export function rolePagePath(seat: string, projectDir?: string | null): string {
  if (!SEAT.test(seat)) throw new Error(`not a seat name: ${JSON.stringify(seat)}`);
  if (projectDir !== undefined && projectDir !== null) {
    const own = join(projectDir, '.mission-pipeline', 'roles', `${seat}.md`);
    if (existsSync(own)) return own;
  }
  return join(INSTALLED_ROLES_DIR, `${seat}.md`);
}

/** A seat's one-page role description, as text (throws when no page exists: a seat without a role page is a program defect). */
export function roleText(seat: string, projectDir?: string | null): string {
  const path = rolePagePath(seat, projectDir);
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`the role page of the ${seat} seat is missing (${path}): ${(e as Error).message}`);
  }
  // A project's own copy may be refreshed (`mp docs update`): only the installed pages are cached.
  if (path.startsWith(INSTALLED_ROLES_DIR)) cache.set(path, text);
  return text;
}
