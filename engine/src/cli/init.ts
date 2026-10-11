// `mp init` and `mp docs update` (design 4.1 §3.1, §4.2, §9):
//
//   mp init   creates `.mission-pipeline/` (A1 initMemory: the folders, memory.db, the git exclude
//             line), copies the role descriptions (`plugin/roles/*.md` → `roles/`) and the PM
//             handbook with its work instructions (`plugin/pm/**` → `pm/`), writes a default
//             `config.json`, records the installed `mp` version (`pm/installed.json`), optionally
//             adds the one pointer line to CLAUDE.md / AGENTS.md, and reports the repository
//             layout warnings (WI-31). Idempotent: files already there are kept.
//   mp docs update   refreshes roles/ and pm/ from the installed `mp`; pages this version retired
//             are removed from the copy.
//
// The pointer line carries no pipeline rules (v51: the project's instruction file must carry none,
// because seats may load the same file).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../common/hash.ts';
import { PlainGit } from '../git/plainGit.ts';
import { initMemory, type InitReport } from '../memory/index.ts';
import { configPath, defaultConfig, detectVersionCommands, writeConfig } from './config.ts';

/** The installed package root (`engine/`). */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The installed documents: role pages and the PM handbook. */
export const INSTALLED_PLUGIN = join(PACKAGE_ROOT, 'plugin');

/** The installed `mp` version (package.json). */
export function mpVersion(): string {
  try {
    return String((JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export const POINTER_LINE = 'If you are acting as the Mission Pipeline PM, read `.mission-pipeline/pm/PM.md`.';

export type PointerTarget = 'claude' | 'agents' | 'both' | 'none';

const POINTER_FILES: Readonly<Record<Exclude<PointerTarget, 'none'>, readonly string[]>> = { claude: ['CLAUDE.md'], agents: ['AGENTS.md'], both: ['CLAUDE.md', 'AGENTS.md'] };

/** Every file under a directory, relative, with "/" separators. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(/[\\/]/).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The documents `mp init` copies: target path under `.mission-pipeline/` → source file. */
export function installedDocs(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of filesUnder(join(INSTALLED_PLUGIN, 'roles'))) if (f.endsWith('.md') && !f.includes('/')) m.set(`roles/${f}`, join(INSTALLED_PLUGIN, 'roles', f));
  for (const f of filesUnder(join(INSTALLED_PLUGIN, 'pm'))) if (f.endsWith('.md')) m.set(`pm/${f}`, join(INSTALLED_PLUGIN, 'pm', ...f.split('/')));
  return m;
}

export interface DocsReport {
  readonly copied: readonly string[];
  readonly updated: readonly string[];
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly version: string;
}

/** Copy the role pages and the handbook into the project (`refresh`: overwrite what differs and remove retired pages). */
export function copyDocs(projectDir: string, o: { readonly refresh: boolean; readonly now?: number }): DocsReport {
  const root = join(projectDir, '.mission-pipeline');
  const docs = installedDocs();
  const copied: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  const removed: string[] = [];
  for (const [rel, src] of docs) {
    const dst = join(root, ...rel.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      copied.push(rel);
    } else if (sha256(readFileSync(dst)) === sha256(readFileSync(src))) kept.push(rel);
    else if (o.refresh) {
      copyFileSync(src, dst);
      updated.push(rel);
    } else kept.push(rel);
  }
  if (o.refresh) {
    // pages of earlier versions that this one retired: only the program's own file names
    for (const f of filesUnder(join(root, 'pm', 'wi'))) {
      const rel = `pm/wi/${f}`;
      if (/^WI-\d{2,3}\.md$/.test(f) && !docs.has(rel)) {
        rmSync(join(root, 'pm', 'wi', f));
        removed.push(rel);
      }
    }
    for (const f of filesUnder(join(root, 'roles'))) {
      const rel = `roles/${f}`;
      if (/^[a-z][a-z0-9-]*\.md$/.test(f) && !docs.has(rel)) {
        rmSync(join(root, 'roles', f));
        removed.push(rel);
      }
    }
  }
  const version = mpVersion();
  const files = Object.fromEntries([...docs.keys()].map((rel) => [rel, sha256(readFileSync(join(root, ...rel.split('/'))))]));
  writeFileSync(join(root, 'pm', 'installed.json'), `${JSON.stringify({ mp: version, copiedAt: new Date(o.now ?? Date.now()).toISOString(), files }, null, 2)}\n`);
  return { copied, updated, kept, removed, version };
}

/** Add the pointer line to the harness instruction files (once). */
export function addPointer(projectDir: string, target: PointerTarget): Array<{ file: string; state: 'added' | 'present' }> {
  if (target === 'none') return [];
  return POINTER_FILES[target].map((name) => {
    const file = join(projectDir, name);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (text.includes(POINTER_LINE)) return { file: name, state: 'present' as const };
    writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${text === '' ? '' : '\n'}${POINTER_LINE}\n`);
    return { file: name, state: 'added' as const };
  });
}

function currentBranch(git: PlainGit, dir: string): string | null {
  const r = git.runSync(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir });
  const b = r.stdout.toString('utf8').trim();
  return r.code === 0 && b !== '' ? b : null;
}

export interface MpInitReport {
  readonly project: string;
  readonly memory: InitReport;
  readonly docs: DocsReport;
  readonly config: 'written' | 'present';
  readonly targetBranch: string | null;
  readonly pointer: ReadonlyArray<{ file: string; state: 'added' | 'present' }>;
}

export function mpInit(projectDir: string, o: { readonly pointer: PointerTarget; readonly targetBranch?: string | null; readonly git?: PlainGit; readonly now?: number }): MpInitReport {
  const git = o.git ?? PlainGit.create();
  const memory = initMemory(projectDir, { git: git.runner() });
  const docs = copyDocs(projectDir, { refresh: false, ...(o.now !== undefined ? { now: o.now } : {}) });
  let config: 'written' | 'present' = 'present';
  let branch: string | null = null;
  if (!existsSync(configPath(projectDir))) {
    branch = o.targetBranch ?? currentBranch(git, projectDir) ?? 'main';
    writeConfig(projectDir, defaultConfig({ targetBranch: branch, versionCommands: detectVersionCommands(projectDir) }));
    config = 'written';
  }
  return { project: projectDir, memory, docs, config, targetBranch: branch, pointer: addPointer(projectDir, o.pointer) };
}
