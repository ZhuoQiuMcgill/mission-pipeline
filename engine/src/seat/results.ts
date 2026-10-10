// What a seat hands back (design 4.2, 8.1): the typed payload of its submit_result tool,
// the program's rules for accepting it, and the ledger records it becomes. Here: the
// Constructor and the Reviewer (their registry entries in src/seat/cards/index.ts point at
// these); every other card kind keeps its shape, rules and records in its own card module, and
// the host treats them all alike through the registry (HandBack, resultDocuments).
//
// Constructor (4.2): the four completion notes. Its product is the export of the writable
// paths, from which the program generates the commit; the notes are a document in the content
// store, referenced by the launch's seat.result record (host.ts).
// Reviewer (8.1): one judgment per standard with evidence pointers, an answer to every
// self-reported gap and open issue, findings outside the standards, and one verdict. It
// becomes a JudgmentRecord bound by the card's contract inputs; each finding becomes an
// IssueRecord (5.6) whose text is a document in the content store. Both seats' results also
// go to the ledger as a seat.result record (host.ts).
//
// Evidence pointers are checked mechanically (8.1 "逐条标准的判断及证据指针"; code review r1
// finding 14): every judgment gives a reason and at least one pointer; "evidence:<id>" must
// name a verification run on the card (the runs bound to this candidate); "file:<path>[:<a>[-<b>]]"
// must name a regular file inside the candidate snapshot, reached without following links,
// with a line range inside the file.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import type { EvidenceId, IssueId, JudgmentId, LaunchId, ModuleId, ObjectVersionId } from '../common/ids.ts';
import type { IssueRecord, IssueResponse, JudgmentRecord, ListRef, Verdict } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import type { ContentStore } from '../ledger/content.ts';
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
  issue_responses: z.array(z.object({ issue: z.string(), response: z.enum(['fixed', 'not-fixed', 'deferred']), reason: z.string() })),
  findings: z.array(z.string()).describe('Problems outside the standards (they become issue records).'),
  verdict: z.enum(['pass', 'rework', 'needs-decision']),
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
    return card.verificationRuns.some((v) => v.evidence === id) ? [] : [`${pointer} is not a verification run on the card`];
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
  if (r.verdict === 'pass' && r.judgments.some((j) => j.met !== 'yes')) out.push('verdict: "pass" leaves a standard not met or unclear');
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
    issues: r.issue_responses.map((i): IssueResponse => ({ issue: i.issue as IssueId, response: i.response })),
    revokes: card.binding.revokes as JudgmentId | null,
    evidenceUse: card.binding.evidenceUse,
    superseded: card.binding.superseded,
    extends: card.binding.extends as JudgmentId | null,
  };
  validateRecord(rec);
  return rec;
}

/**
 * The Reviewer's findings outside the standards as issue records (8.1, 5.6), observed on the
 * judged version. Each finding's words are a document in the content store (`text`); the
 * issue id is `finding:<that hash>`, unique per launch and stable across retries.
 */
/** The document a finding's words become (stored in the content store; its hash names the issue). */
export function findingDocument(card: ReviewerCard, text: string, launch: LaunchId): string {
  return JSON.stringify({ format: 'mp4.finding.v1', text, launch, target: card.target, review: card.review, module: card.module });
}

/**
 * Every document a hand-back stores (the result itself, the findings, and the two id lists),
 * so the host can charge them to the launch's export budget before storing anything.
 */
export function resultDocuments(
  card: { readonly seat: string },
  launch: LaunchId,
  result: HandBack,
  extra: { readonly webFetches?: readonly string[] } = {},
): { readonly documents: readonly string[]; readonly lists: readonly string[] } {
  // the web pages a reading seat fetched (their records' hashes) are part of what it hands back
  const fetched = extra.webFetches !== undefined && extra.webFetches.length > 0 ? { webFetches: extra.webFetches } : {};
  const documents = [JSON.stringify({ format: 'mp4.seat-result.v1', launch, ...result, ...fetched })];
  const lists: string[] = [];
  if (card.seat === 'reviewer' && result.seat === 'reviewer') {
    const c = card as ReviewerCard;
    const r = result.result as ReviewerResult;
    for (const f of r.findings) documents.push(findingDocument(c, f, launch));
    lists.push(JSON.stringify(citedEvidence(c, r)));
    if (r.findings.length > 0) lists.push(JSON.stringify([c.target]));
  }
  return { documents, lists };
}

export function findingRecords(card: ReviewerCard, r: ReviewerResult, content: ContentStore, launch: LaunchId): IssueRecord[] {
  if (r.findings.length === 0) return [];
  const observedOn = content.putList([card.target]);
  return r.findings.map((text) => {
    const doc = content.put(findingDocument(card, text, launch));
    const rec: IssueRecord = { kind: 'issue', issue: `finding:${doc}` as IssueId, module: card.module as ModuleId | null, observedOn, text: doc };
    validateRecord(rec);
    return rec;
  });
}

/** The verification runs a Reviewer cited, as evidence ids (each once, card order). */
export function citedEvidence(card: ReviewerCard, r: ReviewerResult): EvidenceId[] {
  const cited = new Set(r.judgments.flatMap((j) => j.evidence.filter((e) => e.startsWith('evidence:')).map((e) => e.slice('evidence:'.length))));
  return card.verificationRuns.map((v) => v.evidence).filter((e) => cited.has(e)) as EvidenceId[];
}
