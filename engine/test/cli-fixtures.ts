// Shared helpers of the 4.1 CLI tests: a project folder with a git repository; `mp` run in this
// process (runCli, with a fixed environment observation) or from a shell (bin/mp.mjs, as any
// harness runs it); and scripted seats that read their card's fields, write their hand-back files
// into tmp/<dispatch>/ and hand back with `mp seat`.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/evaluator/index.ts';
import { forgetObservedEnvironment, type EnvironmentParts } from '../src/evaluator/index.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { runCli } from '../src/cli/main.ts';
import { openProcess } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';

export const ENGINE = fileURLToPath(new URL('..', import.meta.url));
export const MP_BIN = join(ENGINE, 'bin', 'mp.mjs');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const ENV_A: EnvironmentParts = { os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } };

export function write(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export interface TestProject {
  readonly base: string;
  readonly dir: string;
  git(...args: string[]): string;
  cleanup(): void;
}

/** A git repository on branch main (README.md, a .gitignore with *.local, a package.json), one commit. */
export function gitProject(o: { files?: Record<string, string> } = {}): TestProject {
  const base = mkdtempSync(join(tmpdir(), 'mp-cli-'));
  const dir = join(base, 'project');
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
  git('init', '-q', '-b', 'main');
  write(dir, 'README.md', '# the project\n');
  write(dir, '.gitignore', '*.local\n');
  write(dir, 'package.json', '{ "name": "the-project", "private": true }\n');
  for (const [rel, text] of Object.entries(o.files ?? {})) write(dir, rel, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return { base, dir, git, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** The parsed --json answer, when the command was asked for one. */
  readonly json: any;
}

/** `mp` in this process: a new "process" each call (the environment is observed again). */
export async function cli(cwd: string, argv: readonly string[], o: { env?: EnvironmentParts; stdin?: string; now?: () => number } = {}): Promise<Ran> {
  forgetObservedEnvironment();
  const env = o.env ?? ENV_A;
  const r = await runCli(argv, {
    cwd,
    env: { ...process.env, MP_PROJECT: '' },
    ...(o.stdin !== undefined ? { stdin: () => o.stdin! } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    process: { observe: () => env, git: PlainGit.create(), ident: { name: 'mp test', email: 'mp@test' } },
  });
  let json: any = null;
  if (argv.includes('--json')) {
    try {
      json = JSON.parse(r.stdout || r.stderr);
    } catch {
      json = null;
    }
  }
  return { code: r.exitCode, out: r.stdout, err: r.stderr, json };
}

/** `mp` from a shell, as a harness runs it (bin/mp.mjs, a new Node process). */
export function sh(cwd: string, argv: readonly string[], o: { input?: string; env?: Record<string, string> } = {}): Ran {
  const r = spawnSync(process.execPath, [MP_BIN, ...argv], { cwd, encoding: 'utf8', input: o.input ?? '', env: { ...process.env, ...GIT_ENV, MP_PROJECT: '', ...(o.env ?? {}) }, timeout: 300_000 });
  let json: any = null;
  if (argv.includes('--json')) {
    try {
      json = JSON.parse(r.stdout || r.stderr);
    } catch {
      json = null;
    }
  }
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, json };
}

/** A seat's card fields (what a scripted seat works from; a real seat reads `mp seat <id> card`). */
export function cardOf(dir: string, dispatch: string): any {
  forgetObservedEnvironment();
  const ctx = openProcess(dir, { observe: () => ENV_A });
  try {
    return dispatchView(ctx, dispatch).card;
  } finally {
    ctx.memory.close();
  }
}

/** The material pages a diligent seat reads: every page of every material. */
export function materialPages(card: any): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of ((card.materials ?? []) as MaterialRef[])) for (let p = 1; p <= m.pages; p++) out.push([m.id, p]);
  return out;
}

/** Write a seat's hand-back files into `.mission-pipeline/tmp/<dispatch>/`; returns their project-relative paths. */
export function handBackFiles(dir: string, dispatch: string, fields: unknown, report = `# Report of ${dispatch}\n\nDone as the card says.\n`): { report: string; result: string } {
  const rel = `.mission-pipeline/tmp/${dispatch}`;
  write(dir, `${rel}/report.md`, report);
  write(dir, `${rel}/result.json`, JSON.stringify(fields));
  return { report: `${rel}/report.md`, result: `${rel}/result.json` };
}
