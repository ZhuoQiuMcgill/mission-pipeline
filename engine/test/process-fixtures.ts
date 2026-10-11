// Shared helpers of the 4.1 process tests (src/process): a project folder with a git repository
// and its memory, a process context with a fixed environment identity, and a scripted seat that
// reads its materials, writes its hand-back files into tmp/<dispatch>/ and hands back (no model).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import '../src/evaluator/index.ts';
import { forgetObservedEnvironment, type EnvironmentParts } from '../src/evaluator/index.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { initMemory } from '../src/memory/index.ts';
import { openProcess, pmDispatch, pmMission, pmNext, pmPlan, pmRequirement, pmSay, seatHandback, seatRead, type HandBackAnswer, type ProcessContext, type ProcessOptions, type ReadyStep } from '../src/process/index.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import { dispatchView } from '../src/process/seat.ts';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

export function write(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export const ENV_A: EnvironmentParts = { os: 'testos', osVersion: '1', arch: 'x64', versions: { 'node --version': 'v22' } };
export const ENV_B: EnvironmentParts = { os: 'otheros', osVersion: '2', arch: 'arm64', versions: { 'node --version': 'v22' } };

export interface ProcessProject {
  readonly dir: string;
  ctx: ProcessContext;
  /** Close and open again (a new mp process: the environment is observed again, with `env`). */
  reopen(env?: EnvironmentParts, o?: ProcessOptions): ProcessContext;
  git(...args: string[]): string;
  cleanup(): void;
}

/** A project on branch main (README.md, a .gitignore with *.local), its memory, and a context observing `env`. */
export function processProject(o: { files?: Record<string, string>; env?: EnvironmentParts; options?: ProcessOptions } = {}): ProcessProject {
  const base = mkdtempSync(join(tmpdir(), 'mp-proc-'));
  const dir = join(base, 'project');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md', '# the project\n');
  write(dir, '.gitignore', '*.local\n');
  for (const [rel, text] of Object.entries(o.files ?? {})) write(dir, rel, text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');
  const git = PlainGit.create();
  initMemory(dir, { git: git.runner() });
  const open = (env: EnvironmentParts, more: ProcessOptions = {}): ProcessContext => {
    forgetObservedEnvironment();
    return openProcess(dir, { git, observe: () => env, ident: { name: 'mp test', email: 'mp@test' }, ...(o.options ?? {}), ...more });
  };
  const p: ProcessProject = {
    dir,
    ctx: open(o.env ?? ENV_A),
    reopen(env = ENV_A, more = {}) {
      p.ctx.memory.close();
      p.ctx = open(env, more);
      return p.ctx;
    },
    git: (...args) => sh(dir, ...args),
    cleanup() {
      try {
        p.ctx.memory.close();
      } finally {
        forgetObservedEnvironment();
        rmSync(base, { recursive: true, force: true });
      }
    },
  };
  return p;
}

/** Read every page of every material on the dispatch's card (what a diligent seat does). */
export function readAll(ctx: ProcessContext, dispatch: string): void {
  const v = dispatchView(ctx, dispatch);
  for (const m of ((v.card['materials'] as MaterialRef[] | undefined) ?? [])) for (let p = 1; p <= m.pages; p++) seatRead(ctx, dispatch, m.id, p);
}

/** Write the hand-back files into tmp/<dispatch>/ and run `mp seat <id> handback`. */
export async function handBack(ctx: ProcessContext, dispatch: string, fields: unknown, report = `# Report of ${dispatch}\n\nDone as the card says.\n`): Promise<HandBackAnswer> {
  const dir = join(ctx.memory.paths.tmp, dispatch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), report);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(fields));
  return seatHandback(ctx, dispatch, { report: `.mission-pipeline/tmp/${dispatch}/report.md`, result: `.mission-pipeline/tmp/${dispatch}/result.json` });
}

/** The one ready step of a card kind, or throws with what is ready. */
export async function readyOf(ctx: ProcessContext, kind: string): Promise<ReadyStep> {
  const next = await pmNext(ctx);
  const s = next.ready.filter((r) => r.kind === kind);
  if (s.length !== 1) throw new Error(`expected one ready ${kind}, ready: ${next.ready.map((r) => `${r.kind}:${r.step}`).join(', ') || 'none'}; held: ${next.held.map((h) => `${h.kind}: ${h.why}`).join('; ') || 'none'}; errors: ${next.errors.join('; ') || 'none'}`);
  return s[0]!;
}

/** One whole seat step: the one ready step of `kind` dispatched, its materials read, and `fields(card, dispatch)` handed back (refusals throw). */
export async function step(ctx: ProcessContext, kind: string, fields: (card: any, dispatch: string) => unknown, o: { filledBy?: string } = {}): Promise<{ dispatch: string; answer: HandBackAnswer }> {
  const s = await readyOf(ctx, kind);
  const d = pmDispatch(ctx, s.step, { filledBy: o.filledBy ?? 'test-harness/scripted' });
  readAll(ctx, d.dispatch);
  const answer = await handBack(ctx, d.dispatch, fields(dispatchView(ctx, d.dispatch).card, d.dispatch));
  if (answer.kind === 'refused') throw new Error(`the scripted ${kind} hand-back of ${d.dispatch} was refused:\n- ${answer.problems.join('\n- ')}`);
  return { dispatch: d.dispatch, answer };
}

// ---------------------------------------------------------------- a small mission (add + check)

export const CHECK_JS = `const fs = require('node:fs');
const { add } = require('./add.js');
console.log('TAP version 13');
console.log(add(2, 3) === 5 ? 'ok 1 - adds two numbers' : 'not ok 1 - adds two numbers');
// only a clean checkout of the candidate lacks the ignored file the Constructor left in its worktree
console.log(fs.existsSync(__dirname + '/data.local') ? 'not ok 2 - clean checkout' : 'ok 2 - clean checkout');
process.exit(add(2, 3) === 5 && !fs.existsSync(__dirname + '/data.local') ? 0 : 1);
`;

export function addPlan(mission: string, words: string): unknown {
  return {
    format: 'mp4.pm-plan.v1',
    mission,
    round: 1,
    order: 'free',
    elements: [{ id: 'e1', kind: 'deliverable', text: 'An add function with a check', provenance: { by: 'user', words, quote: 'an add function' }, after: [], items: ['g1'] }],
    goalsBeyond: [],
    authorizations: ['a1'],
  };
}

export function addDetailedPlan(mission: string, o: { verification?: Array<{ id: string; command: string; sampled?: boolean }> } = {}): unknown {
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched src/: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
    modules: [{ id: 'core', writeScope: ['src/**'], provenance: { planElement: 'e1' } }],
    tasks: [
      {
        id: 'impl',
        kind: 'implementation',
        module: 'core',
        goal: 'Implement add and its check',
        standards: [{ id: 'S1', text: 'add(2, 3) is 5' }],
        requirementItems: [`item.${mission}.g1`],
        writeScope: ['src/**'],
        readableFiles: ['README.md'],
        interpreter: 'node',
        verificationCommands: o.verification ?? [{ id: 'check', command: 'node src/check.js' }],
        implements: ['add'],
        calls: [],
        dependsOn: [],
        exclusive: [],
        estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'a small function' },
        provenance: { planElement: 'e1' },
      },
    ],
    risks: [],
  };
}

/** The mission's words, items and PM plan recorded (the plan waits for Calibrator ①). */
export async function startAddMission(ctx: ProcessContext, mission: string, o: { plan?: unknown } = {}): Promise<string> {
  pmMission(ctx, mission);
  const w = pmSay(ctx, `Please write an add function, with a check that it works. The details are yours to decide. (${mission})`).words;
  await pmRequirement(ctx, { mission, item: 'g1', type: 'goal', text: 'An add function', quote: 'an add function', words: w });
  await pmRequirement(ctx, { mission, item: 'a1', type: 'authorization', text: 'Details are the PM\'s', quote: 'The details are yours to decide', words: w });
  await pmPlan(ctx, { mission, plan: o.plan ?? addPlan(mission, w), words: [w] });
  return w;
}

/** The mission through Calibrator ①, the Architect, Calibrator ② and the Constructor (its candidate handed back). */
export async function addMissionToReview(p: ProcessProject, mission: string, o: { detailed?: unknown } = {}): Promise<{ constructor: string; candidate: string }> {
  const ctx = p.ctx;
  await startAddMission(ctx, mission);
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(ctx, 'architect-decompose', () => o.detailed ?? addDetailedPlan(mission));
  await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
  const s = await readyOf(ctx, 'constructor');
  const d = pmDispatch(ctx, s.step);
  const wt = join(p.dir, d.worktree!);
  write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
  write(wt, 'src/check.js', CHECK_JS);
  const a = await handBack(ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  if (a.kind !== 'recorded' || a.candidate === null) throw new Error(`the Constructor's hand-back was not recorded: ${JSON.stringify(a)}`);
  return { constructor: d.dispatch, candidate: a.candidate.commit };
}

/** A Reviewer's passing hand-back citing every run on its card. */
export function reviewerPass(card: { standards: Array<{ id: string }>; verificationRuns: Array<{ evidence: string }>; selfReportedGaps: Array<{ id: string }>; openIssues: Array<{ issue: string }> }, extra: string[] = []): unknown {
  return {
    judgments: card.standards.map((s) => ({ standard: s.id, met: 'yes', reason: 'checked', evidence: [...card.verificationRuns.map((r) => `evidence:${r.evidence}`), ...extra] })),
    gap_responses: card.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' })),
    issue_responses: card.openIssues.map((i) => ({ issue: i.issue, response: 'fixed', reason: 'checked' })),
    findings: [],
    verdict: 'pass',
  };
}
