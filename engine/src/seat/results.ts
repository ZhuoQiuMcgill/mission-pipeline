// What a seat hands back (design 4.1 §5.3; 4.0 4.2, 8.1): the structured fields of its
// hand-back (`mp seat <id> handback --result <file.json>`), the program's rules for accepting
// them, and the records they become. Here: the Constructor and the Reviewer (their registry
// entries in src/seat/cards/index.ts point at these); every other card kind keeps its shape,
// rules and records in its own card module, and `mp` treats them all alike through the
// registry.
//
// Constructor (4.2): the four completion notes. Its product is the candidate commit `mp`
// collects from its worktree at hand-back (src/git/workspace.ts); the notes are its report and
// these fields.
// Reviewer (8.1): one judgment per standard with evidence pointers, an answer to every
// self-reported gap and open issue, findings outside the standards, and one verdict. It
// becomes a JudgmentRecord bound by the card's contract inputs; each finding becomes an
// IssueRecord (5.6) whose text is a data value of the memory.
//
// Evidence pointers are checked mechanically (8.1 "逐条标准的判断及证据指针"; code review r1
// finding 14): every judgment gives a reason and at least one pointer; "evidence:<id>" must
// name a verification run on the card or a run the Reviewer had `mp` rerun in this dispatch;
// "file:<path>[:<a>[-<b>]]" must name a regular file of the candidate commit, with a line range
// inside the file.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../common/hash.ts';
import type { ContentHash, EvidenceId, IssueId, JudgmentId, ModuleId, ObjectVersionId } from '../common/ids.ts';
import type { IssueRecord, IssueResponse, JudgmentRecord, ListRef, Verdict } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import type { ConstructorCard, ReviewerCard, SeatCard } from './card.ts';

export const ConstructorResultShape = {
  done: z.string().min(1).describe('What you did.'),
  unmet_standards: z
    .array(z.object({ standard: z.string().describe('A standard id from the card.'), why: z.string() }))
    .describe('Standards not met, each with why. Empty when all are met.'),
  unfixed_problems: z.array(z.string()).describe('Problems you noticed but did not fix.'),
  decisions_needed: z.array(z.string()).describe('Questions that need a decision (including "needs more resources").'),
};

export const ReviewerResultShape = {
  judgments: z
    .array(
      z.object({
        standard: z.string().describe('A standard id from the card.'),
        met: z.enum(['yes', 'no', 'unclear']),
        reason: z.string(),
        evidence: z.array(z.string()).describe('Pointers: "evidence:<id>" from the card, or "file:<path>:<line>".'),
      }),
    )
    .describe('Exactly one judgment per standard on the card.'),
  gap_responses: z.array(z.object({ gap: z.string().describe("A gap id from the card."), response: z.string() })),
  issue_responses: z.array(z.object({
    issue: z.string(),
    response: z.enum(['fixed', 'not-fixed', 'deferred']),
    reason: z.string().describe('Why the issue is fixed, not fixed, or deferred; give a non-empty reason for deferred.'),
    owner: z.string().optional().describe('Required for deferred: who owns the issue next. It is shown as "deferred to <owner>", outside the task fix list.'),
  })).describe('Answer every listed issue on this version, including previously deferred issues. For deferred include both owner and reason; repeating a deferral does not require rework.'),
  findings: z.array(z.string()).describe('Problems outside the standards (they become issue records).'),
  verdict: z.enum(['pass', 'rework', 'needs-decision']),
  reopen: z
    .array(z.object({ task: z.string().min(1).describe('A dependency listed on your card.'), issue: z.string().min(1).describe('What is wrong in its work.'), evidence: z.string().optional().describe('The run or file that shows it.') }))
    .optional()
    .describe('Integration tasks only, with verdict "rework": the dependencies whose work causes the failure (a failing full suite included; `mp seat <id> owners <path>` traces a path to its task). Each gets a new attempt with the issue on its card; this task then builds again on their fixed work. A failure no dependency explains: verdict "needs-decision", without reopen.'),
};

const ConstructorResultSchema = z.object(ConstructorResultShape);
const ReviewerResultSchema = z.object(ReviewerResultShape);
export type ConstructorResult = z.infer<typeof ConstructorResultSchema>;
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;
export type SeatResult = { readonly seat: 'constructor'; readonly result: ConstructorResult } | { readonly seat: 'reviewer'; readonly result: ReviewerResult };
/**
 * Any card kind's accepted hand-back (src/seat/cards/registry.ts): its kind (the card's `seat`
 * field) and the result its entry's resultSchema parsed. Constructor and Reviewer hand-backs
 * are SeatResults.
 */
export interface HandBack {
  readonly seat: string;
  readonly result: unknown;
}

/** Read access to the candidate snapshot, for checking file pointers. */
export interface SnapshotFiles {
  /** Lines of the regular file at `rel` (relative to the snapshot root), or null when there is none reachable without links. */
  lines(rel: string): number | null;
}

/** What the program checks a hand-back against besides the card. */
export interface ResultContext {
  readonly snapshot: SnapshotFiles;
  /** The runs this dispatch had `mp` rerun (`mp seat <id> rerun`): citable as evidence:<id>. */
  readonly runs?: ReadonlyArray<{ readonly run: string; readonly completed: boolean }>;
}

/** Where the records' documents and lists go: the memory's data table (DataStore satisfies it). */
export interface RecordContent {
  put(doc: string): string;
  putList(items: readonly string[]): ListRef;
}

const fdPath = (fd: number, name?: string): string => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);

/**
 * The snapshot as a pointer checker: each component opened without following links, relative
 * to the directory before it; a symlink, a non-directory on the way or a non-regular file is
 * "no such file". Lines are counted by newlines (a last line without one counts too).
 */
export function snapshotFiles(root: string): SnapshotFiles {
  return {
    lines(rel: string): number | null {
      const comps = rel.split('/');
      if (rel === '' || comps.some((c) => c === '' || c === '.' || c === '..')) return null;
      let dir: number;
      try {
        dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      } catch {
        return null;
      }
      try {
        for (const c of comps.slice(0, -1)) {
          const next = openSync(fdPath(dir, c), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          closeSync(dir);
          dir = next;
        }
        const fd = openSync(fdPath(dir, comps.at(-1) as string), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) return null;
          const buf = Buffer.alloc(1 << 20);
          let lines = 0;
          let last = -1;
          let total = 0;
          for (;;) {
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n === 0) break;
            for (let i = 0; i < n; i++) if (buf[i] === 0x0a) lines++;
            last = buf[n - 1] ?? -1;
            total += n;
          }
          return total > 0 && last !== 0x0a ? lines + 1 : lines;
        } finally {
          closeSync(fd);
        }
      } catch {
        return null;
      } finally {
        try {
          closeSync(dir);
        } catch {
          /* closed */
        }
      }
    },
  };
}

/** The program's rules (8.1 "程序规则"): what makes a handed-back result acceptable. Empty = acceptable. */
export function resultProblems(card: SeatCard, raw: unknown, ctx: ResultContext): string[] {
  if (card.seat === 'constructor') {
    const r = ConstructorResultSchema.safeParse(raw);
    if (!r.success) return r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return constructorProblems(card, r.data);
  }
  const r = ReviewerResultSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return reviewerProblems(card, r.data, ctx);
}

function constructorProblems(card: ConstructorCard, r: ConstructorResult): string[] {
  const ids = new Set(card.standards.map((s) => s.id));
  return r.unmet_standards.filter((u) => !ids.has(u.standard)).map((u) => `unmet_standards: "${u.standard}" is not a standard on the card`);
}

const FILE_POINTER = /^file:([^\s:]+)(?::(\d+)(?:-(\d+))?)?$/;

/** Problems of one evidence pointer (empty: valid). */
export function pointerProblems(card: ReviewerCard, pointer: string, ctx: ResultContext): string[] {
  if (pointer.startsWith('evidence:')) {
    const id = pointer.slice('evidence:'.length);
    if (card.verificationRuns.some((v) => v.evidence === id) || (ctx.runs ?? []).some((r) => r.run === id)) return [];
    return [`${pointer} is neither a verification run on the card nor a run you had mp rerun`];
  }
  const m = FILE_POINTER.exec(pointer);
  if (m === null) return [`"${pointer}" is neither evidence:<id> nor file:<path>:<line>`];
  const path = m[1] as string;
  if (posix.isAbsolute(path) || posix.normalize(path) !== path || path === '..' || path.startsWith('../') || path.split('/').includes('.git')) {
    return [`${pointer}: the path must be a normalized path inside the snapshot`];
  }
  const lines = ctx.snapshot.lines(path);
  if (lines === null) return [`${pointer}: ${path} is not a file of the candidate snapshot`];
  if (m[2] === undefined) return [];
  const a = Number(m[2]);
  const b = m[3] === undefined ? a : Number(m[3]);
  if (a < 1 || b < a || b > lines) return [`${pointer}: lines ${a}${m[3] !== undefined ? `-${b}` : ''} are not inside ${path} (${lines} line${lines === 1 ? '' : 's'})`];
  return [];
}

function reviewerProblems(card: ReviewerCard, r: ReviewerResult, ctx: ResultContext): string[] {
  const out: string[] = [];
  const standards = card.standards.map((s) => s.id);
  const judged = r.judgments.map((j) => j.standard);
  for (const s of standards) {
    const n = judged.filter((j) => j === s).length;
    if (n === 0) out.push(`judgments: standard "${s}" is not judged`);
    if (n > 1) out.push(`judgments: standard "${s}" is judged ${n} times`);
  }
  for (const j of judged) if (!standards.includes(j)) out.push(`judgments: "${j}" is not a standard on the card`);
  for (const j of r.judgments) {
    if (j.reason.trim() === '') out.push(`judgments[${j.standard}]: give the reason for the judgment`);
    if (j.evidence.length === 0) out.push(`judgments[${j.standard}]: cite at least one evidence pointer (evidence:<id> or file:<path>:<line>)`);
    for (const e of j.evidence) for (const p of pointerProblems(card, e, ctx)) out.push(`judgments[${j.standard}]: ${p}`);
  }
  const gaps = r.gap_responses.map((g) => g.gap);
  for (const g of card.selfReportedGaps) if (!gaps.includes(g.id)) out.push(`gap_responses: gap "${g.id}" is not answered`);
  const issues = r.issue_responses.map((i) => i.issue);
  for (const i of card.openIssues) if (!issues.includes(i.issue)) out.push(`issue_responses: issue "${i.issue}" has no response`);
  for (const i of r.issue_responses) {
    if (i.response === 'deferred' && (!i.owner?.trim() || !i.reason.trim())) out.push(`issue_responses: deferred issue "${i.issue}" needs an owner and a reason`);
  }
  if (r.verdict === 'pass' && r.judgments.some((j) => j.met !== 'yes')) out.push('verdict: "pass" leaves a standard not met or unclear');
  out.push(...reopenProblems(card, r));
  return out;
}

/** 4.1.2 (D-6): the reopen rules of a hand-back. */
function reopenProblems(card: ReviewerCard, r: ReviewerResult): string[] {
  const out: string[] = [];
  const reopen = r.reopen ?? [];
  const g = card.integration;
  if (reopen.length > 0) {
    if (g === undefined) return ['reopen: only an integration task\'s Reviewer reopens a dependency; hand back without reopen'];
    if (r.verdict !== 'rework') out.push('reopen: goes with verdict "rework"');
    const deps = new Set(g.dependencies.map((d) => d.task));
    const named = reopen.map((x) => x.task);
    for (const t of new Set(named)) {
      if (!deps.has(t)) out.push(`reopen: task "${t}" is not a dependency of this integration task with an accepted product (dependencies: ${[...deps].join(', ') || 'none'})`);
      if (named.filter((x) => x === t).length > 1) out.push(`reopen: task "${t}" is named more than once: one entry per task`);
    }
    for (const x of reopen) if (x.issue.trim() === '') out.push(`reopen: give the issue of task "${x.task}"`);
  }
  if (g !== undefined && !g.hasConstructor && r.verdict === 'rework' && reopen.length === 0) {
    out.push('verdict: this integration task writes nothing and has no Constructor: a "rework" must reopen a dependency (reopen: [{ "task", "issue" }]); otherwise hand back "needs-decision"');
  }
  return out;
}

export function parseSeatResult(card: SeatCard, raw: unknown): SeatResult {
  if (card.seat === 'constructor') return { seat: 'constructor', result: ConstructorResultSchema.parse(raw) };
  return { seat: 'reviewer', result: ReviewerResultSchema.parse(raw) };
}

const VERDICTS: Readonly<Record<ReviewerResult['verdict'], Verdict>> = { pass: 'pass', rework: 'fail', 'needs-decision': 'undecided' };

/**
 * The Reviewer's judgment as a base record: the card's binding (contract inputs) plus the
 * seat's verdict, the verification runs it cited, and its issue responses.
 */
export function judgmentRecord(card: ReviewerCard, r: ReviewerResult, evidenceList: ListRef): JudgmentRecord {
  const rec: JudgmentRecord = {
    kind: 'judgment',
    judgment: card.binding.judgment as JudgmentId,
    review: card.review,
    executor: 'reviewer',
    target: card.target as ObjectVersionId,
    verdict: VERDICTS[r.verdict],
    evidence: evidenceList,
    bases: card.binding.bases as ListRef,
    constraints: card.binding.constraints as ListRef,
    reliesOn: card.binding.reliesOn as ListRef,
    issues: r.issue_responses.map((i): IssueResponse => ({
      issue: i.issue as IssueId,
      response: i.response,
      ...(i.response === 'deferred' ? { owner: i.owner!, reason: sha256(deferredReasonDocument(i)) as ContentHash } : {}),
    })),
    revokes: card.binding.revokes as JudgmentId | null,
    evidenceUse: card.binding.evidenceUse,
    superseded: card.binding.superseded,
    extends: card.binding.extends as JudgmentId | null,
  };
  validateRecord(rec);
  return rec;
}

/** The reason is content-addressed in the judgment and saved with the hand-back's findings. */
function deferredReasonDocument(i: ReviewerResult['issue_responses'][number]): string {
  return canonicalJson({ format: 'mp4.issue-deferral.v1', issue: i.issue, owner: i.owner, reason: i.reason });
}

/** The document a finding's words become (a data value; its hash names the issue). `dispatch`: the dispatch that found it. */
export function findingDocument(card: ReviewerCard, text: string, dispatch: string): string {
  return JSON.stringify({ format: 'mp4.finding.v1', text, launch: dispatch, target: card.target, review: card.review, module: card.module });
}

/**
 * The Reviewer's findings outside the standards as issue records (8.1, 5.6), observed on the
 * judged version. Each finding's words are a data value (`text`); the issue id is
 * `finding:<that hash>`, unique per dispatch and stable across retries.
 */
export function findingRecords(card: ReviewerCard, r: ReviewerResult, content: RecordContent, dispatch: string): IssueRecord[] {
  // recordsOf builds both judgment and findings in the hand-back's write. Store the reason
  // documents here even when the Reviewer has no new findings (judgmentRecord remains pure).
  for (const i of r.issue_responses) if (i.response === 'deferred') content.put(deferredReasonDocument(i));
  if (r.findings.length === 0) return [];
  const observedOn = content.putList([card.target]);
  return r.findings.map((text) => {
    const doc = content.put(findingDocument(card, text, dispatch));
    const rec: IssueRecord = { kind: 'issue', issue: `finding:${doc}` as IssueId, module: card.module as ModuleId | null, observedOn, text: doc as never };
    validateRecord(rec);
    return rec;
  });
}

/** The runs a Reviewer cited, as evidence ids (each once: the card's verification runs in card order, then its own reruns in run order). */
export function citedEvidence(card: ReviewerCard, r: ReviewerResult, runs: ReadonlyArray<{ readonly run: string }> = []): EvidenceId[] {
  const cited = new Set(r.judgments.flatMap((j) => j.evidence.filter((e) => e.startsWith('evidence:')).map((e) => e.slice('evidence:'.length))));
  const order = [...card.verificationRuns.map((v) => v.evidence), ...runs.map((x) => x.run)];
  return [...new Set(order.filter((e) => cited.has(e)))] as EvidenceId[];
}
