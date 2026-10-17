// The project's configuration (design 4.1 §3.1, §6.5, §9): `.mission-pipeline/config.json`,
// hand-editable, validated by `mp config` and read by every `mp` command that needs it. It holds
// what the project declares, nothing about any harness or model account:
//
//   targetBranch            the branch missions deliver to; its head is a mission's base
//   verificationCommands    the project's local tests, for the PM and the Architect to name in
//                           plans (each task's card carries the commands `mp` runs, §5.3)
//   fullSuite               the project's full test suite (4.1.2, D-4..D-7): run by `mp` for an
//                           integration Reviewer (`mp seat <id> full-run`), by the PM's decision
//                           (`mp pm full-run`), and by the delivery; optional, with no default
//   closingChecks           the 4.1.1 key, read as a deprecated alias of `fullSuite` when that is
//                           absent (fullSuiteOf, src/common/fullSuite.ts); `mp config` says which
//   commandTimeoutMs        per declared command
//   environment             { versionCommands }: what the environment identity covers (§6.5)
//   exclusiveResources      resources tasks may lease (a database, a device); informational here
//   fillers                 per seat, a filler hint "<harness>/<model>" shown by `mp pm next`
//                           (information only: any filler can fill any seat, §2.1)
//   commit                  { author?, committer? } as "Name <email>": the identity of the commits
//                           `mp` writes (4.1.2); default Mission Pipeline <mp@localhost>; the
//                           committer defaults to the author

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { environmentConfig } from '../evaluator/index.ts';
import type { Ident } from '../git/objects.ts';
import { CliError, EXIT } from './errors.ts';

export const CONFIG_FORMAT = 'mp41.config.v1';

const CommandId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const CommandLine = z.union([z.string().min(1).max(4000), z.array(z.string().min(1)).min(1).max(100)]);
const Command = z.object({ id: CommandId, command: CommandLine }).strict();
/** A full-suite command (COMMON `fullSuite`: `{ id, command, cwd? }`; cwd relative to the repository root). */
const SuiteCommandSchema = z.object({ id: CommandId, command: CommandLine, cwd: z.string().min(1).max(1000).optional() }).strict();
/** A commit identity "Name <email>" (git's ident rules: no angle brackets or line breaks in the name, none and no spaces in the email). */
const IDENT_TEXT = /^([^<>\r\n]*[^<>\s][^<>\r\n]*?)\s*<([^<>\s]+)>$/;
const IdentText = z.string().max(400).regex(IDENT_TEXT, 'a commit identity "Name <email>"');

/** The seats a filler hint can name (role pages under roles/). */
export const SEATS: readonly string[] = ['pm', 'calibrator', 'architect', 'secretary', 'constructor', 'reviewer', 'researcher', 'crititor', 'stabilizer', 'auditor'];

export const ConfigSchema = z
  .object({
    format: z.literal(CONFIG_FORMAT),
    targetBranch: z.string().min(1).max(255).regex(/^[^\s~^:?*[\\]+$/, 'a branch name'),
    verificationCommands: z.array(Command).max(100).default([]),
    // optional with no default, so that the alias works: fullSuiteOf(config) reads fullSuite, else closingChecks
    fullSuite: z.array(SuiteCommandSchema).max(100).optional(),
    closingChecks: z.array(Command).max(100).optional(),
    commandTimeoutMs: z.number().int().min(1_000).max(24 * 3_600_000).default(30 * 60_000),
    environment: z.object({ versionCommands: z.array(z.string().min(1).max(1000)).max(50).default([]) }).strict().default({ versionCommands: [] }),
    exclusiveResources: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)).max(200).default([]),
    fillers: z.record(z.string(), z.string().min(1).max(400).nullable()).default({}),
    commit: z.object({ author: IdentText.optional(), committer: IdentText.optional() }).strict().optional(),
  })
  .strict();

/** The default identity of the commits `mp` writes (process/context.ts DEFAULT_IDENT). */
export const DEFAULT_COMMIT_IDENT = 'Mission Pipeline <mp@localhost>';

function identOf(text: string): Ident {
  const m = IDENT_TEXT.exec(text)!;
  return { name: m[1]!.trim(), email: m[2]! };
}

/** The commit identities config.json declares (`commit.author`, `commit.committer`); absent: the process defaults (the committer falls back to the author). */
export function commitIdentities(c: ProjectConfig): { readonly author?: Ident; readonly committer?: Ident } {
  return {
    ...(c.commit?.author !== undefined ? { author: identOf(c.commit.author) } : {}),
    ...(c.commit?.committer !== undefined ? { committer: identOf(c.commit.committer) } : {}),
  };
}

export type ProjectConfig = z.infer<typeof ConfigSchema>;

export function configPath(projectDir: string): string {
  return join(projectDir, '.mission-pipeline', 'config.json');
}

/** Folders `mp init` never looks into for version markers (dependencies, build output, tools' state). */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'venv']);

/**
 * The version commands `mp init` declares for what it finds in the project, at its root and in its
 * first-level folders (`frontend/package.json` and the like), each command once (the maintainer
 * edits them freely).
 */
export function detectVersionCommands(projectDir: string): string[] {
  const dirs = [projectDir];
  try {
    for (const e of readdirSync(projectDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) dirs.push(join(projectDir, e.name));
    }
  } catch {
    /* an unreadable folder: the root alone */
  }
  const has = (f: string): boolean => dirs.some((d) => existsSync(join(d, f)));
  const out: string[] = [];
  if (has('package.json')) out.push('node --version');
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) out.push('python3 --version');
  if (has('Cargo.toml')) out.push('cargo --version');
  if (has('go.mod')) out.push('go version');
  return out;
}

/** The configuration `mp init` writes. */
export function defaultConfig(o: { readonly targetBranch: string; readonly versionCommands: readonly string[] }): ProjectConfig {
  return {
    format: CONFIG_FORMAT,
    targetBranch: o.targetBranch,
    verificationCommands: [],
    fullSuite: [],
    commandTimeoutMs: 30 * 60_000,
    environment: { versionCommands: [...o.versionCommands] },
    exclusiveResources: [],
    fillers: Object.fromEntries(SEATS.map((s) => [s, null])),
  };
}

/** Parse and validate a config document; every problem in one message. */
export function parseConfig(raw: unknown): ProjectConfig {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new CliError('BAD_CONFIG', `.mission-pipeline/config.json: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, { exitCode: EXIT.REFUSED });
  }
  // the environment entry as the labels package reads it (one validator for both)
  environmentConfig(raw);
  for (const seat of Object.keys(r.data.fillers)) {
    if (!SEATS.includes(seat)) throw new CliError('BAD_CONFIG', `.mission-pipeline/config.json: fillers.${seat}: not a seat (seats: ${SEATS.join(', ')})`, { exitCode: EXIT.REFUSED });
  }
  return r.data;
}

/**
 * Which key the full suite was read from (COMMON: `fullSuite`, else the deprecated alias
 * `closingChecks`), and whether both are present (then `fullSuite` wins and `mp config` warns).
 */
export function fullSuiteSource(c: Pick<ProjectConfig, 'fullSuite' | 'closingChecks'>): { readonly key: 'fullSuite' | 'closingChecks' | null; readonly both: boolean } {
  const both = c.fullSuite !== undefined && c.closingChecks !== undefined;
  return { key: c.fullSuite !== undefined ? 'fullSuite' : c.closingChecks !== undefined ? 'closingChecks' : null, both };
}

/** The project's configuration; a missing file is the defaults with branch "main" (a project initialized by hand). */
export function readConfig(projectDir: string): ProjectConfig {
  const file = configPath(projectDir);
  if (!existsSync(file)) return defaultConfig({ targetBranch: 'main', versionCommands: [] });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError('BAD_CONFIG', `.mission-pipeline/config.json is not JSON: ${(e as Error).message}`, { exitCode: EXIT.REFUSED });
  }
  return parseConfig(raw);
}

export function writeConfig(projectDir: string, c: ProjectConfig): void {
  writeFileSync(configPath(projectDir), `${JSON.stringify(c, null, 2)}\n`);
}
