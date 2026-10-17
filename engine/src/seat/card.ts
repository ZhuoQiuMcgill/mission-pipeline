// Seat cards (design 4.1 §5.2; 4.0 4.2 Constructor, 8.1 Reviewer, 2 "每个席位的定义只有一页"). A
// card is the seat's birth package: the flow builds its fields (a JSON document in the memory's
// data table, the task's spec), and `mp pm dispatch` renders it as the leaf
// `missions/<m>/dispatches/<d>/card.md` (renderSeatCard): the seat's one-page role description
// (roles/<seat>.md, the single source), the task's fixed fields, the materials, the seat's
// `mp seat <id>` commands, and the hand-back section with the JSON schema of the structured
// fields and the two file paths. A card names what the seat reads by commit; the Constructor
// works in its own worktree, created at that commit.

import { z } from 'zod';
import type { MissionId, ModuleId } from '../common/ids.ts';
import { Command, Continuation, Interface, Item, ListRefSchema, Workspace, commonCardFields, list, renderCommon } from './cards/common.ts';
import { SEAT_COMMANDS, seatCardEntry, type SeatCommand } from './cards/registry.ts';
import { roleText } from './cards/roles.ts';
import type { SuiteCommand } from '../common/fullSuite.ts';

export { Continuation };

export const ConstructorCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('constructor'),
  /** snapshot: the base commit its worktree is created at; writablePaths: the write paths (§5.3). */
  workspace: Workspace,
  goal: z.string().min(1),
  standards: z.array(Item).min(1),
  requirementItems: z.array(Item),
  readableFiles: z.array(z.string()),
  interpreter: z.string(),
  verificationCommands: z.array(Command),
  interfaces: z.object({ implements: z.array(Interface), calls: z.array(Interface) }),
  /** Exclusive resources the task needs (§6.2): leased to the dispatch while it is in flight. */
  exclusive: z.array(z.string()).optional(),
});

export const ReviewerCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('reviewer'),
  workspace: Workspace.extend({
    /** A Reviewer changes no file: its product is the judgment. */
    writablePaths: z.array(z.string()).max(0, 'a Reviewer has no writable paths; name scratch paths instead'),
  }),
  /** The object version judged, and the review position on it. */
  target: z.string().min(1),
  review: z.string().min(1),
  standards: z.array(Item).min(1),
  interfaces: z.array(Interface),
  candidate: z.object({ changedPaths: z.array(z.string()) }),
  /** The program's verification runs on this candidate: the only evidence besides the Reviewer's own reruns (7.2). */
  verificationRuns: z.array(z.object({ evidence: z.string().min(1), command: z.string(), summary: z.string() })),
  /** Commands the Reviewer may have `mp` rerun on the candidate (`mp seat <id> rerun`). */
  declaredCommands: z.array(Command),
  selfReportedGaps: z.array(Item),
  openIssues: z.array(z.object({ issue: z.string().min(1), text: z.string() })),
  /** 4.1.2: the previous Reviewer of this task: its verdict, each standard it found unmet or unclear with the reason, and its findings. */
  previousReview: z
    .object({
      review: z.string().min(1),
      attempt: z.number().int().positive(),
      verdict: z.enum(['pass', 'rework', 'needs-decision']),
      unmet: z.array(z.object({ standard: z.string(), met: z.enum(['no', 'unclear']), reason: z.string() })),
      findings: z.array(z.string()),
    })
    .optional(),
  /**
   * 4.1.2 (D-5, D-6): an integration task's review; the Reviewer judges the whole. When the project
   * declares a full suite, its card offers `mp seat <id> full-run` (last, once nothing visible is
   * wrong), and a pass cites a passing full run of the candidate. `hasConstructor` false: the task writes nothing, so no
   * Constructor ran and the candidate is its start snapshot (its dependencies' products laid over the
   * base). `dependencies`: each dependency (direct or not) with its accepted product and the paths that
   * product changed; a rework may reopen one of them (`reopen` in the hand-back).
   */
  integration: z
    .object({
      hasConstructor: z.boolean(),
      dependencies: z.array(z.object({ task: z.string().min(1), product: z.string().min(1), attempt: z.number().int().positive(), direct: z.boolean(), changedPaths: z.array(z.string()) })),
    })
    .optional(),
  /** The judgment's binding inputs, fixed by the card's contract (5.2). */
  binding: z.object({
    judgment: z.string().min(1),
    bases: ListRefSchema,
    constraints: ListRefSchema,
    reliesOn: ListRefSchema,
    revokes: z.string().nullable(),
    extends: z.string().nullable(),
    evidenceUse: z.object({ fields: z.array(z.string()), statisticalOrExternal: z.boolean() }),
    superseded: z.array(z.object({ input: z.string(), by: z.string() })),
  }),
});

export type ConstructorCard = z.infer<typeof ConstructorCardSchema>;
export type ReviewerCard = z.infer<typeof ReviewerCardSchema>;
export type SeatCard = ConstructorCard | ReviewerCard;
export type SeatKind = SeatCard['seat'];

export const SeatCardSchema = z.discriminatedUnion('seat', [ConstructorCardSchema, ReviewerCardSchema]);

export function parseSeatCard(x: unknown): SeatCard {
  return SeatCardSchema.parse(x);
}

export function cardTag(c: { readonly mission: string; readonly capabilities: readonly string[]; readonly module: string | null }): {
  readonly mission: MissionId;
  readonly capabilities: readonly string[];
  readonly module: ModuleId | null;
} {
  return { mission: c.mission as MissionId, capabilities: c.capabilities, module: c.module as ModuleId | null };
}

// ---------------------------------------------------------------- the task-specific bodies

export function renderCard(c: SeatCard): string {
  if (c.seat === 'constructor') {
    return (
      renderCommon(c) +
      `## Goal\n${c.goal}\n\n` +
      list('Acceptance standards', c.standards.map((s) => `[${s.id}] ${s.text}`)) +
      list('Requirement items', c.requirementItems.map((s) => `[${s.id}] ${s.text}`)) +
      (c.workspace.writablePaths.length > 0
        ? list('Write paths (relative to the repository root)', c.workspace.writablePaths)
        : '## Write paths\nNone: this task only reads and runs. Change no file; a hand-back with any change is refused.\n\n') +
      list('Files to read first', c.readableFiles) +
      (c.interpreter !== '' ? `## Interpreter\n${c.interpreter}\n\n` : '') +
      list('Verification commands mp runs on your candidate', c.verificationCommands.map((v) => `[${v.id}] ${v.command}${v.cwd !== undefined ? ` (in ${v.cwd})` : ''}`)) +
      list('Interfaces to implement', c.interfaces.implements.map((i) => `${i.name}: ${i.definition}`)) +
      list('Interfaces to call', c.interfaces.calls.map((i) => `${i.name}: ${i.definition}`)) +
      list('Exclusive resources leased to you', c.exclusive ?? [])
    );
  }
  return (
    renderCommon(c) +
    `## Target\n${c.target} (review position: ${c.review})\n\n` +
    list('Acceptance standards (answer every one)', c.standards.map((s) => `[${s.id}] ${s.text}`)) +
    list('Interfaces', c.interfaces.map((i) => `${i.name}: ${i.definition}`)) +
    list('Changed paths in the candidate', c.candidate.changedPaths) +
    list('Verification runs mp made on this candidate (cite as evidence:<id>)', c.verificationRuns.map((r) => `[${r.evidence}] ${r.command}: ${r.summary}`)) +
    list('Declared commands you may rerun (by id)', c.declaredCommands.map((d) => `[${d.id}] ${d.command}`)) +
    list('Scratch paths (a rerun may write here; nothing written is kept)', c.workspace.scratchPaths ?? []) +
    list("The Constructor's self-reported gaps (answer every one)", c.selfReportedGaps.map((g) => `[${g.id}] ${g.text}`)) +
    list('Open issues on this version (respond to every one)', c.openIssues.map((i) => `[${i.issue}] ${i.text}`)) +
    renderPreviousReview(c) +
    renderIntegration(c)
  );
}

function renderPreviousReview(c: ReviewerCard): string {
  const p = c.previousReview;
  if (p === undefined) return '';
  return (
    `## The previous review of this task\n${p.review} (attempt ${p.attempt}) handed back "${p.verdict}".\n` +
    (p.unmet.length > 0 ? `${p.unmet.map((u) => `- [${u.standard}] ${u.met === 'no' ? 'not met' : 'unclear'}: ${u.reason}`).join('\n')}\n` : '') +
    (p.findings.length > 0 ? `${p.findings.map((f) => `- finding: ${f}`).join('\n')}\n` : '') +
    '\n'
  );
}

function renderIntegration(c: ReviewerCard): string {
  const g = c.integration;
  if (g === undefined) return '';
  return (
    `## This is an integration task\n${g.hasConstructor ? 'Its Constructor laid its own change over its dependencies\' work.' : 'It writes nothing, so no Constructor ran: the candidate is its start snapshot, its dependencies\' accepted products laid over the base. A rework cannot fix it here: name the dependency to reopen.'}\n` +
    'When a failure traces to a dependency, hand back verdict "rework" with `reopen`: [{ "task": "<id>", "issue": "<what is wrong>", "evidence": "<run or file>" }]: that task gets a new attempt with the issue on its card, and this task builds again on its fixed work. The original task fixes it; this task does not absorb the fix. `mp seat <id> owners <path>...` lists which accepted products changed a path.\n\n' +
    list('Dependencies and the paths their accepted products changed', g.dependencies.map((d) => `${d.task}${d.direct ? '' : ' (indirect)'}: ${d.product} (attempt ${d.attempt}): ${d.changedPaths.join(', ') || 'no path'}`))
  );
}

// ---------------------------------------------------------------- the whole card (§5.2)

/** Where a dispatch's hand-back files live (decision 7): `.mission-pipeline/tmp/<dispatch>/`, relative to the project folder. */
export function handBackFiles(dispatch: string): { readonly dir: string; readonly report: string; readonly result: string; readonly request: string; readonly notes: string } {
  const dir = `.mission-pipeline/tmp/${dispatch}`;
  return { dir, report: `${dir}/report.md`, result: `${dir}/result.json`, request: `${dir}/request.json`, notes: `${dir}/notes.md` };
}

/** The JSON schema of a card kind's structured hand-back fields (printed on the card). */
export function handBackSchema(kind: string): unknown {
  const e = seatCardEntry(kind);
  return z.toJSONSchema(e.resultSchema as z.ZodType, { unrepresentable: 'any' });
}

/** The JSON schema of an evidence request (`mp seat <id> request-evidence`, decision 13). */
export const EvidenceRequestSchema = z.object({
  steps: z.array(z.string().min(1)).min(1).describe('The steps, in order, written for a blind executor (no expectation in them).'),
  data: z.string().describe('The data the steps use.'),
  measure: z.array(z.string().min(1)).describe('The quantities to record (may be empty only when there are assertions).'),
  assertions: z.array(z.string().min(1)).describe('The assertions to check (holds / does not hold / not checked).'),
  executor: z.enum(['experiment', 'reading']).optional().describe('experiment: commands are run; reading: sources are read.'),
  commands: z.array(Command).optional().describe('experiment: the commands the steps run (the executor runs each with mp seat <id> rerun <command-id>).'),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

const SEAT_TITLE: Readonly<Record<string, string>> = {
  calibrator: 'Calibrator',
  architect: 'Architect',
  secretary: 'Secretary',
  constructor: 'Constructor',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  crititor: 'Crititor',
  stabilizer: 'Stabilizer',
  auditor: 'Auditor',
};

/** What the project declares that changes a card's commands: its full suite (config.json `fullSuite`, fullSuiteOf). */
export interface CardProject {
  readonly fullSuite?: readonly SuiteCommand[];
}

/** An integration task's Reviewer card in a project that declares a full suite: it gets `mp seat <id> full-run` (4.1.2). */
export function offersFullRun(card: { readonly seat: string } & Readonly<Record<string, unknown>>, o: CardProject = {}): boolean {
  return isIntegrationCard(card) && (o.fullSuite?.length ?? 0) > 0;
}

/** An integration task's Reviewer card: the flow gives it the field `integration` (its dependencies, D-6). */
export function isIntegrationCard(card: { readonly seat: string } & Readonly<Record<string, unknown>>): boolean {
  const x = card['integration'];
  return card.seat === 'reviewer' && x !== undefined && x !== null && x !== false;
}

/** The `mp seat <id>` commands a card's seat gets (§4.1: the command list is part of its card). */
export function seatCommandsOf(card: { readonly seat: string } & Readonly<Record<string, unknown>>, o: CardProject = {}): SeatCommand[] {
  const e = seatCardEntry(card.seat);
  const out = new Set<SeatCommand>(SEAT_COMMANDS[e.toolProfile]);
  // a seat that reads a commit and works in no worktree of its own can check it out
  if (card['workspace'] !== undefined && e.exportsProduct !== true) out.add('checkout');
  const materials = (card['materials'] as readonly unknown[] | undefined) ?? [];
  if (materials.length === 0) out.delete('read');
  if (e.toolProfile === 'read-evidence' && card['allowAsyncEvidence'] === false) out.delete('request-evidence');
  if (card['allowAsyncEvidence'] === true) out.add('request-evidence');
  if (rerunCommands(card).length > 0) out.add('rerun');
  else out.delete('rerun');
  if (offersFullRun(card, o)) out.add('full-run');
  // 4.1.2: which accepted products changed a path, for tracing a failure (an integration review, a repair)
  if (isIntegrationCard(card) || card.seat === 'architect-repair') out.add('owners');
  const order: readonly SeatCommand[] = ['card', 'read', 'checkout', 'rerun', 'owners', 'request-evidence', 'full-run', 'handback'];
  return order.filter((c) => out.has(c));
}

/** The commands a seat may have `mp` run with `mp seat <id> rerun <command-id>` (declared on its card). */
export function rerunCommands(card: Readonly<Record<string, unknown>>): Array<{ readonly id: string; readonly command: string; readonly cwd?: string }> {
  const declared = card['declaredCommands'] ?? card['commands'];
  return Array.isArray(declared) ? (declared as Array<{ id: string; command: string; cwd?: string }>) : [];
}

function commandLines(card: { readonly seat: string } & Readonly<Record<string, unknown>>, dispatch: string, o: CardProject = {}): string[] {
  const f = handBackFiles(dispatch);
  const ws = card['workspace'] as { snapshot?: string } | undefined;
  const lines: string[] = [];
  for (const c of seatCommandsOf(card, o)) {
    switch (c) {
      case 'card':
        lines.push(`\`mp seat ${dispatch} card\`: this card.`);
        break;
      case 'read':
        lines.push(`\`mp seat ${dispatch} read <material> [--page <n>]\`: one page of a material (page 1 by default); it reports a missing or edited material instead of serving it.`);
        break;
      case 'checkout':
        lines.push(`\`mp seat ${dispatch} checkout\`: prints the path of a read-only directory holding ${ws?.snapshot !== undefined ? `commit ${ws.snapshot}` : 'the commit this card names'}; read the project there. Other seats reading the same commit share it: never write there.`);
        break;
      case 'rerun':
        lines.push(`\`mp seat ${dispatch} rerun <command-id>\`: \`mp\` runs a declared command (ids: ${rerunCommands(card).map((x) => x.id).join(', ')}) on a clean checkout; every rerun executes and gets a new run id, which you may cite.`);
        break;
      case 'owners':
        lines.push(`\`mp seat ${dispatch} owners <path>...\`: which accepted products of this mission changed each path (a path, or a directory ending in "/"), with their task and attempt.`);
        break;
      case 'full-run':
        lines.push(`\`mp seat ${dispatch} full-run\`: \`mp\` runs the project's full suite (${(o.fullSuite ?? []).map((x) => x.id).join(', ')}) in order on a clean checkout of this candidate and records it with a full-run marker; a passing full run already recorded on the same tree and environment is reused (nothing runs). Cite its runs as evidence:<id>. Run it last, only when nothing visible is wrong.`);
        break;
      case 'request-evidence':
        lines.push(`\`mp seat ${dispatch} request-evidence --stdin\`: ask for an evidence execution: your notes (what you need to continue) on stdin, ending with the request as a fenced json block (the JSON schema below); or \`mp seat ${dispatch} request-evidence --request ${f.request} --notes ${f.notes}\` with two files. It ends this dispatch; a new card brings your notes back with the results.`);
        break;
      case 'handback':
        lines.push(`\`mp seat ${dispatch} handback --stdin\`: once, when you are done: your report on stdin, ending with the structured fields as a fenced json block (see the hand-back section; or the two files form there).`);
        break;
    }
  }
  return lines;
}

/**
 * The card as the seat receives it (§5.2): written by `mp pm dispatch` as the leaf
 * `dispatches/<dispatch>/card.md`, printed by `mp seat <dispatch> card`. `projectDir`: the
 * project whose role pages are used (its own copy, else the installed page).
 */
export function renderSeatCard(card: { readonly seat: string } & Readonly<Record<string, unknown>>, o: { readonly dispatch: string; readonly projectDir?: string | null } & CardProject): string {
  const e = seatCardEntry(card.seat);
  const parsed = e.schema.parse(card) as { readonly seat: string; readonly task: string; readonly mission: string; readonly workspace?: { snapshot: string; writablePaths: readonly string[] } };
  const f = handBackFiles(o.dispatch);
  const role = roleText(e.seat, o.projectDir ?? null).trim();
  const ws = parsed.workspace;
  const where =
    e.exportsProduct === true && ws !== undefined
      ? `## Your worktree\n\`.mission-pipeline/worktrees/${o.dispatch}/\`, created at commit ${ws.snapshot}. Work there with your harness's own tools and leave your changes as files: at hand-back \`mp\` collects every change git does not ignore (modified, deleted and new files, without \`git add\`); inside the write paths they become your candidate commit, a change outside them refuses the hand-back with the paths listed. Ignored files are never collected. Do not commit, stage, reset, stash or switch branches there.\n\n`
      : ws !== undefined && ws.snapshot !== ''
        ? `## What you read\nThe project at commit ${ws.snapshot}: run \`mp seat ${o.dispatch} checkout\`, which prints the directory that holds it.\n\n`
        : '';
  const fullRun = offersFullRun(card, o)
    ? `\n\n## The full suite (an integration task)\nYou judge the whole change. Check the cheapest things first:\n- look at the change and the local results above first;\n- if something is visibly wrong, hand back "rework" (or "needs-decision") without a full run;\n- only when nothing visible is wrong, run \`mp seat ${o.dispatch} full-run\` (the full suite: ${(o.fullSuite ?? []).map((x) => `[${x.id}] ${typeof x.command === 'string' ? x.command : x.command.join(' ')}`).join('; ')}), and cite its runs as evidence:<id>.\nA "pass" must cite a passing full run of this candidate; without one the hand-back is refused. When the full suite fails, trace the failure to the task whose change caused it (the run summary keeps the last 400 lines of each failing command), name that task in your findings and hand back "needs-decision": the fix belongs to that task, and this integration task does not absorb it.`
    : '';
  const evidence = seatCommandsOf(card, o).includes('request-evidence') ? `\nAn evidence request (the last fenced json block of your notes on \`mp seat ${o.dispatch} request-evidence --stdin\`, or the file \`${f.request}\`) matches this JSON schema:\n\n\`\`\`json\n${JSON.stringify(z.toJSONSchema(EvidenceRequestSchema), null, 2)}\n\`\`\`\n` : '';
  return [
    `# ${SEAT_TITLE[e.seat] ?? e.seat} card: dispatch ${o.dispatch}`,
    '',
    `Task ${parsed.task} of mission ${parsed.mission}; card kind ${e.kind}.`,
    '',
    '## Your role',
    '',
    role.replace(/^# [^\n]*\n+/, ''),
    '',
    '---',
    '',
    '# This task',
    '',
    `${where}${e.render(parsed)}`.trimEnd() + fullRun,
    '',
    '## Your commands',
    '',
    ...commandLines(card, o.dispatch, o).map((l) => `- ${l}`),
    '',
    'Use only these `mp` commands; read and write files with your harness\'s own tools.',
    '',
    '## Hand-back',
    '',
    `Hand back once, when you are done: your report in Markdown, ending with the structured fields as a fenced json block (the last one in the document), on the standard input of \`mp seat ${o.dispatch} handback --stdin\`. Nothing else is needed; \`mp\` files both. For example:`,
    '',
    `    mp seat ${o.dispatch} handback --stdin <<'EOF'`,
    '    # Report',
    '    What you did, your reasoning, what is not met, the questions that need a decision.',
    '',
    '    ```json',
    '    { "...": "the fields, matching the schema below" }',
    '    ```',
    '    EOF',
    '',
    'The fields match this JSON schema:',
    '',
    '```json',
    JSON.stringify(handBackSchema(e.kind), null, 2),
    '```',
    '',
    `Or with two files (never inside a worktree): the report in \`${f.report}\`, the fields in \`${f.result}\`, then \`mp seat ${o.dispatch} handback --report ${f.report} --result ${f.result}\`.`,
    '',
    'When it refuses, it says why: fix it and run it again. A hand-back is recorded once.',
    evidence,
  ].join('\n');
}
