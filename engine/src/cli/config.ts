// The project's configuration (design 4.1 §3.1, §6.5, §9): `.mission-pipeline/config.json`,
// hand-editable, validated by `mp config` and read by every `mp` command that needs it. It holds
// what the project declares, nothing about any harness or model account:
//
//   targetBranch            the branch missions deliver to; its head is a mission's base
//   verificationCommands    the project's own test commands, for the PM and the Architect to name
//                           in plans (each task's card carries the commands `mp` runs, §5.3)
//   closingChecks           run by `mp pm deliver` on the delivery candidate's clean checkout (§6.7)
//   commandTimeoutMs        per declared command
//   environment             { versionCommands }: what the environment identity covers (§6.5)
//   exclusiveResources      resources tasks may lease (a database, a device); informational here
//   fillers                 per seat, a filler hint "<harness>/<model>" shown by `mp pm next`
//                           (information only: any filler can fill any seat, §2.1)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { environmentConfig } from '../evaluator/index.ts';
import { CliError, EXIT } from './errors.ts';

export const CONFIG_FORMAT = 'mp41.config.v1';

const Command = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), command: z.union([z.string().min(1).max(4000), z.array(z.string().min(1)).min(1).max(100)]) }).strict();

/** The seats a filler hint can name (role pages under roles/). */
export const SEATS: readonly string[] = ['pm', 'calibrator', 'architect', 'secretary', 'constructor', 'reviewer', 'researcher', 'crititor', 'stabilizer', 'auditor'];

export const ConfigSchema = z
  .object({
    format: z.literal(CONFIG_FORMAT),
    targetBranch: z.string().min(1).max(255).regex(/^[^\s~^:?*[\\]+$/, 'a branch name'),
    verificationCommands: z.array(Command).max(100).default([]),
    closingChecks: z.array(Command).max(100).default([]),
    commandTimeoutMs: z.number().int().min(1_000).max(24 * 3_600_000).default(30 * 60_000),
    environment: z.object({ versionCommands: z.array(z.string().min(1).max(1000)).max(50).default([]) }).strict().default({ versionCommands: [] }),
    exclusiveResources: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)).max(200).default([]),
    fillers: z.record(z.string(), z.string().min(1).max(400).nullable()).default({}),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ConfigSchema>;

export function configPath(projectDir: string): string {
  return join(projectDir, '.mission-pipeline', 'config.json');
}

/** The version commands `mp init` declares for what it finds in the project (the maintainer edits them freely). */
export function detectVersionCommands(projectDir: string): string[] {
  const has = (f: string): boolean => existsSync(join(projectDir, f));
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
    closingChecks: [],
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
