// Seat cards (design 4.2 Constructor, 8.1 Reviewer, 2 "每个席位的定义只有一页"). A card is a
// JSON document in the content store, produced by the scheduler for one launch; the seat
// host reads it, gives the seat its one-page definition as the system prompt and the card as
// its first message. The card binds everything the seat may touch: the snapshot and its
// writable paths, its limits, and (Reviewer) the judgment's binding inputs.

import { z } from 'zod';
import type { LaunchId, MissionId, ModuleId } from '../common/ids.ts';

const Item = z.object({ id: z.string().min(1), text: z.string().min(1) });
const Interface = z.object({ name: z.string().min(1), definition: z.string() });
const Command = z.object({ id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional() });
const ListRefSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), count: z.number().int().nonnegative() });
const Workspace = z.object({
  /** The project snapshot (host path, Linux filesystem); mounted read-only in the tool sandbox. */
  snapshot: z.string().startsWith('/'),
  /** Constructor: the paths it may change; their content is exported as its product. */
  writablePaths: z.array(z.string()),
  mountPoint: z.string().startsWith('/').optional(),
});

const Common = {
  format: z.literal('mp4.seat-card.v1'),
  launch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  mission: z.string().min(1),
  module: z.string().nullable(),
  /** Capabilities of this unit, for matching stop scopes (6.4). */
  capabilities: z.array(z.string()),
  /** About ten lines: who the seat is on this task and what it does (4.2). */
  duties: z.string(),
  /** Verbatim decisions that bear on the task. */
  decisionQuotes: z.array(z.string()),
  /** Project constraints filtered for the task (9.5): object constraints and execution instructions. */
  constraints: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(['object', 'instruction']) })),
  workspace: Workspace,
  limits: z.object({
    /** Declared peak of one synchronous run (6.2). */
    run: z.object({ memoryMax: z.number().int().positive(), pidsMax: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }),
    /**
     * The tool sandbox's writable area (a capped tmpfs): the copies of the writable paths
     * (Constructor) or scratch paths (Reviewer), plus /tmp and /dev/shm of its commands.
     * Counted in the unit's reservation (exec/resources.ts UnitDemand.areaBytes).
     */
    areaBytes: z.number().int().positive(),
    /** Export cap (6.5): logical length and file count. */
    export: z.object({ maxLogicalBytes: z.number().int().nonnegative(), maxFiles: z.number().int().nonnegative() }),
    /** Recovery state cap (6.2): reserved at dispatch; async evidence is refused above it. */
    recoveryStateBytes: z.number().int().nonnegative(),
    /** Recovery state file cap (6.2, 6.5: inodes and index records are reserved too). Default RECOVERY_STATE_FILES. */
    recoveryStateFiles: z.number().int().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    wallClockMs: z.number().int().positive().optional(),
  }),
  /** Async evidence allowed for this seat (exploration, 4.3; 6.2 "异步取证"). */
  allowAsyncEvidence: z.boolean().optional(),
  /** A continuation after async evidence: the session to resume, its captured state, and the evidence results. */
  resume: z
    .object({ sessionId: z.string().min(1), state: z.string().regex(/^[0-9a-f]{64}$/).nullable(), evidence: z.string() })
    .optional(),
};

export const ConstructorCardSchema = z.object({
  ...Common,
  seat: z.literal('constructor'),
  goal: z.string().min(1),
  standards: z.array(Item).min(1),
  requirementItems: z.array(Item),
  readableFiles: z.array(z.string()),
  interpreter: z.string(),
  verificationCommands: z.array(Command),
  interfaces: z.object({ implements: z.array(Interface), calls: z.array(Interface) }),
});

export const ReviewerCardSchema = z.object({
  ...Common,
  seat: z.literal('reviewer'),
  workspace: Workspace.extend({
    /** A Reviewer changes no file: its product is the judgment. */
    writablePaths: z.array(z.string()).max(0, 'a Reviewer has no writable paths; name scratch paths instead'),
    /**
     * Paths its rerun commands may write into (build output, caches; "." for the whole tree):
     * copies in the writable area, never exported, discarded with the unit.
     */
    scratchPaths: z.array(z.string()).optional(),
  }),
  /** The object version judged, and the review position on it. */
  target: z.string().min(1),
  review: z.string().min(1),
  standards: z.array(Item).min(1),
  interfaces: z.array(Interface),
  candidate: z.object({ changedPaths: z.array(z.string()) }),
  /** The program's verification runs on this candidate: the only evidence (7.2). */
  verificationRuns: z.array(z.object({ evidence: z.string().min(1), command: z.string(), summary: z.string() })),
  /** Commands the Reviewer may have the program rerun (7.1). */
  declaredCommands: z.array(Command),
  selfReportedGaps: z.array(Item),
  openIssues: z.array(z.object({ issue: z.string().min(1), text: z.string() })),
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

/** Default file cap of a recovery state (a Claude Code config directory holds a few dozen files). */
export const RECOVERY_STATE_FILES = 10_000;

export type ConstructorCard = z.infer<typeof ConstructorCardSchema>;
export type ReviewerCard = z.infer<typeof ReviewerCardSchema>;
export type SeatCard = ConstructorCard | ReviewerCard;
export type SeatKind = SeatCard['seat'];

export const SeatCardSchema = z.discriminatedUnion('seat', [ConstructorCardSchema, ReviewerCardSchema]);

export function parseSeatCard(x: unknown): SeatCard {
  return SeatCardSchema.parse(x);
}

/** Any card kind's launch (every kind carries the common fields). */
export function cardLaunch(c: { readonly launch: string }): LaunchId {
  return c.launch as LaunchId;
}

export function cardTag(c: { readonly mission: string; readonly capabilities: readonly string[]; readonly module: string | null }): {
  readonly mission: MissionId;
  readonly capabilities: readonly string[];
  readonly module: ModuleId | null;
} {
  return { mission: c.mission as MissionId, capabilities: c.capabilities, module: c.module as ModuleId | null };
}

// ---------------------------------------------------------------- one-page definitions (system prompts)

const TOOLS_NOTE =
  'Every capability you have is a program tool. They run inside a sandbox that holds the project snapshot at the mount point; paths are relative to it. There is no network, no user to ask, and no repository metadata. Tool output is capped; a cut output says so.';

export const SEAT_DEFINITIONS: Readonly<Record<SeatKind, string>> = {
  constructor: [
    'You are the Constructor seat of a software pipeline. You implement one task, described by the card in the first message, inside the writable paths the card names.',
    TOOLS_NOTE,
    'Work like this: read what you need; change only files under the writable paths (write_file, edit_file); run commands with run_command to build and test. Your own runs are drafts: the program runs the declared verification commands itself, and only those count as evidence.',
    'A run has a declared memory peak; a run over it is ended and reported as "resource exceeded". Nothing a command starts outlives that command: start, use and stop any server within one command. Files you write into the writable area count toward the run that writes them.',
    'When you are done, call submit_result once with the four completion notes: what you did; which standards are not met and why; problems you noticed but did not fix; questions that need a decision. Then end your turn. Do not claim a standard is met unless you checked it.',
    'You do not see the ledger, the plan, other modules or the user. If the card is contradictory or the task needs a decision, say so in the notes rather than guessing.',
  ].join('\n\n'),
  reviewer: [
    'You are the Reviewer seat of a software pipeline. You judge, independently, whether the candidate described by the card in the first message meets each of the card\'s standards.',
    TOOLS_NOTE,
    'You can read, list and search the candidate snapshot, and have the program rerun a declared command (rerun_declared_command). You cannot change files.',
    'Judge each standard on its own, with evidence pointers: "evidence:<id>" for a verification run listed on the card, or "file:<path>:<line>" for code you read. Answer every self-reported gap of the Constructor and respond to every open issue. Record anything wrong outside the standards as a finding.',
    'Give exactly one verdict: "pass" only when every standard is met; "rework" when the Constructor should fix something (your judgments say what); "needs-decision" when the standards themselves are unclear or in conflict.',
    'Call submit_result once with your judgments and verdict, then end your turn. You see neither the Constructor\'s reasoning nor the plan; judge the product against the standards alone.',
  ].join('\n\n'),
};

// ---------------------------------------------------------------- the card as the first message

function list(title: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
}

export function renderCard(c: SeatCard): string {
  const common =
    `# Card for launch ${c.launch}\n\n` +
    (c.duties.trim() !== '' ? `## Your duties on this task\n${c.duties.trim()}\n\n` : '') +
    list('Project constraints', c.constraints.map((k) => `[${k.id}] ${k.text}`)) +
    list('Relevant decisions (verbatim)', c.decisionQuotes);
  if (c.seat === 'constructor') {
    return (
      common +
      `## Goal\n${c.goal}\n\n` +
      list('Acceptance standards', c.standards.map((s) => `[${s.id}] ${s.text}`)) +
      list('Requirement items', c.requirementItems.map((s) => `[${s.id}] ${s.text}`)) +
      list('Writable paths (relative to the snapshot root)', c.workspace.writablePaths) +
      list('Files to read first', c.readableFiles) +
      (c.interpreter !== '' ? `## Interpreter\n${c.interpreter}\n\n` : '') +
      list('Verification commands the program will run', c.verificationCommands.map((v) => `[${v.id}] ${v.command}${v.cwd !== undefined ? ` (in ${v.cwd})` : ''}`)) +
      list('Interfaces to implement', c.interfaces.implements.map((i) => `${i.name}: ${i.definition}`)) +
      list('Interfaces to call', c.interfaces.calls.map((i) => `${i.name}: ${i.definition}`)) +
      'When done, call submit_result with your four completion notes, then end your turn.'
    );
  }
  return (
    common +
    `## Target\n${c.target} (review position: ${c.review})\n\n` +
    list('Acceptance standards (answer every one)', c.standards.map((s) => `[${s.id}] ${s.text}`)) +
    list('Interfaces', c.interfaces.map((i) => `${i.name}: ${i.definition}`)) +
    list('Changed paths in the candidate', c.candidate.changedPaths) +
    list('Verification runs on this candidate (cite as evidence:<id>)', c.verificationRuns.map((r) => `[${r.evidence}] ${r.command}: ${r.summary}`)) +
    list('Commands you may have rerun', c.declaredCommands.map((d) => `[${d.id}] ${d.command}`)) +
    list('Scratch paths (the rerun commands may write here; nothing written is kept)', c.workspace.scratchPaths ?? []) +
    list("The Constructor's self-reported gaps (answer every one)", c.selfReportedGaps.map((g) => `[${g.id}] ${g.text}`)) +
    list('Open issues on this version (respond to every one)', c.openIssues.map((i) => `[${i.issue}] ${i.text}`)) +
    'When done, call submit_result with your judgments and one verdict, then end your turn.'
  );
}
