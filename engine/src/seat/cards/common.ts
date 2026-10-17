// Shared pieces of every seat card (design 4.1 §5.2, §5.4; 4.0 2, 7.1, 9.3). The card fields
// here mirror src/seat/card.ts (Constructor, Reviewer) so `mp` can treat every card kind alike:
// format, task, mission, module, capabilities (stop scopes, 6.4), duties, verbatim decisions,
// filtered constraints (9.5), async evidence and its continuation (§5.4). A card kind adds its
// own fields and declares its tool profile (which `mp seat <id>` commands it gets).
//
// 4.1: the seat works with its harness's own tools and `mp seat <id>` commands. A card names
// what the seat reads by commit (or a project-relative path), never a host path; there are no
// sandbox limits, no session to resume (a continuation is a new card with the previous
// hand-back, the notes and the evidence), and materials are leaves read page by page with
// `mp seat <id> read`, hash-checked on every read.

import { z } from 'zod';

export const CARD_FORMAT = 'mp41.seat-card.v1' as const;

export const Item = z.object({ id: z.string().min(1), text: z.string().min(1) });
export const Interface = z.object({ name: z.string().min(1), definition: z.string() });
/** A command the card declares (§6.5: `sampled` makes its runs sampling runs; `network` makes them other runs). */
export const Command = z.object({ id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional(), sampled: z.boolean().optional(), network: z.boolean().optional() });
export const ListRefSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), count: z.number().int().nonnegative() });
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);

/** Absolute paths (POSIX or Windows) are host paths: a card never names one (§9: stored relative). */
const HOST_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * What a seat reads or works on (§5.2): `snapshot` is the commit the seat reads (`mp seat <id>
 * checkout` materializes it; a Constructor's worktree is created at it), or a path relative to
 * the project folder. `writablePaths` are write-path patterns ("dir/**", an exact path, "**").
 */
export const Workspace = z.object({
  snapshot: z.string().min(1).refine((s) => !HOST_PATH.test(s), 'the snapshot is a commit or a project-relative path, never a host path'),
  /** Constructor-like seats only; read-only seats have none. */
  writablePaths: z.array(z.string()),
  /** Paths the declared commands of a rerun may write into in their clean checkout (never kept). */
  scratchPaths: z.array(z.string()).optional(),
});

/** A read-only workspace: no writable path at all. */
export const ReadOnlyWorkspace = Workspace.extend({
  writablePaths: z.array(z.string()).max(0, 'this seat has no writable paths'),
});

/**
 * A material the seat reads with `mp seat <id> read <material> [--page <n>]` (§5.2): its text is
 * written as a leaf when the card is dispatched, and every read checks the leaf's hash (a missing
 * or edited leaf is reported, never served). `mustRead` materials form the must-read list: the
 * hand-back is refused until every page of each was read.
 */
export const Material = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** The text's sha256 in the memory's data table (the leaf holds the same text). */
  ref: Hash,
  pages: z.number().int().positive(),
  mustRead: z.boolean(),
  /**
   * What the material is, set by the program (code review r1 #11): "user-words" is the user's
   * own booked words; "authorizations" the recorded authorizations; "plan", "requirements" and
   * "record" are the PM's or the program's own documents. Rules that need a source check it.
   */
  role: z.enum(['user-words', 'authorizations', 'requirements', 'plan', 'record']).optional(),
});
export type MaterialRef = z.infer<typeof Material>;

/** Bytes per material page (a material's text is split by this size, UTF-8 safe). */
export const MATERIAL_PAGE_BYTES = 16 * 1024;

/** The number of pages a material document has (at least one). */
export function materialPageCount(doc: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(doc, 'utf8') / MATERIAL_PAGE_BYTES));
}

/** One page of a material document (1-based), cut on byte boundaries without splitting a character. */
export function materialPage(doc: string, page: number): string {
  const buf = Buffer.from(doc, 'utf8');
  let start = (page - 1) * MATERIAL_PAGE_BYTES;
  let end = Math.min(buf.length, page * MATERIAL_PAGE_BYTES);
  // move both cuts back to a character boundary (never inside a UTF-8 sequence)
  while (start > 0 && start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start--;
  while (end < buf.length && end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return buf.subarray(start, end).toString('utf8');
}

/** The key `mp` records when a page is read: `${material}#${page}`. */
export function materialPageKey(material: string, page: number): string {
  return `${material}#${page}`;
}

/** Must-read pages not read yet (empty: the must-read list is complete). */
export function unreadMustRead(materials: readonly MaterialRef[], read: ReadonlySet<string> | undefined): string[] {
  const out: string[] = [];
  for (const m of materials) {
    if (!m.mustRead) continue;
    for (let p = 1; p <= m.pages; p++) if (!read?.has(materialPageKey(m.id, p))) out.push(materialPageKey(m.id, p));
  }
  return out;
}

/**
 * The judgment's binding inputs (5.2), fixed by the card's contract: as on the Reviewer card.
 * The seat never sees or changes them; the program builds the judgment record from them.
 */
export const Binding = z.object({
  judgment: z.string().min(1),
  bases: ListRefSchema,
  constraints: ListRefSchema,
  reliesOn: ListRefSchema,
  revokes: z.string().nullable(),
  extends: z.string().nullable(),
  evidence: ListRefSchema.optional(),
  evidenceUse: z.object({ fields: z.array(z.string()), statisticalOrExternal: z.boolean() }),
  superseded: z.array(z.object({ input: z.string(), by: z.string() })),
});
export type CardBinding = z.infer<typeof Binding>;

/**
 * A continuation after async evidence (§5.4, v51 6.2): the seat that asked gets a new card with
 * its previous hand-back (the notes it saved, a material) and the evidence results. Nothing
 * depends on a harness session.
 */
export const Continuation = z.object({
  /** The task whose hand-back asked for the evidence. */
  previous: z.string().min(1),
  /** The material holding the notes it handed back, or null when it left none. */
  notes: z.string().nullable(),
  /** The evidence results, in words (their full records are materials). */
  evidence: z.string(),
});
export type ContinuationT = z.infer<typeof Continuation>;

/** Fields every card kind carries (same names and rules as src/seat/card.ts). */
export const commonCardFields = {
  format: z.literal(CARD_FORMAT),
  /** The task this card is for (the dispatch that claims it is named when it is dispatched). */
  task: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  mission: z.string().min(1),
  module: z.string().nullable(),
  /** Capabilities of this task, for matching stop scopes (6.4). */
  capabilities: z.array(z.string()),
  /** About ten lines: who the seat is on this task and what it does. */
  duties: z.string(),
  /** Verbatim decisions that bear on the task. */
  decisionQuotes: z.array(z.string()),
  authorizations: z.array(z.object({ id: z.string(), quote: z.string(), version: z.string().optional(), notifyCondition: z.string().nullable() })).optional(),
  /** Project constraints filtered for the task (9.5): object constraints and execution instructions. */
  constraints: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(['object', 'instruction']) })),
  /** Async evidence allowed for this seat (exploration, v51 4.3, 6.2): `mp seat <id> request-evidence`. */
  allowAsyncEvidence: z.boolean().optional(),
  continuation: Continuation.optional(),
  /** 4.1.2 (D-10): the repairs this work answers: the user's reason verbatim, its kind and words entry. */
  repairs: z.array(z.object({ id: z.string().min(1), kind: z.string().min(1), text: z.string().min(1), words: z.string().min(1) })).optional(),
};

/** "## Title\n- a\n- b" (empty string when there is nothing to list). */
export function list(title: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
}

/** The common head of every card body. */
export function renderCommon(c: { duties: string; constraints: readonly { id: string; text: string; kind?: string }[]; decisionQuotes: readonly string[]; seat?: string; authorizations?: readonly { id: string; quote: string; notifyCondition: string | null }[]; continuation?: ContinuationT | undefined; repairs?: readonly { id: string; kind: string; text: string; words: string }[] | undefined }): string {
  const k = c.continuation;
  return (
    (c.duties.trim() !== '' ? `## Your duties on this task\n${c.duties.trim()}\n\n` : '') +
    list("Repairs this work answers (the user's reason, verbatim)", (c.repairs ?? []).map((r) => `[${r.id}] ${r.kind} (${r.words}): "${r.text}"`)) +
    (k !== undefined
      ? `## This card continues task ${k.previous}\nYou asked for evidence; here is what came back. Your previous notes${k.notes !== null ? ` are material ${k.notes}` : ' were not saved'}.\n\n${k.evidence.trim()}\n\n`
      : '') +
    list('Project constraints', c.constraints.map((x) => `[${x.id}] ${x.kind === 'instruction' ? 'Instruction (context only; not a proof input): ' : ''}${x.text}`)) +
    list('Relevant decisions (verbatim)', c.decisionQuotes) +
    (c.seat === 'secretary' ? '' : list('Authorizations currently in force (verbatim)', (c.authorizations ?? []).map((a) => `[${a.id}] "${a.quote}"${a.notifyCondition === null ? '' : ` (tell the user when: ${a.notifyCondition})`}`)))
  );
}

export function renderMaterials(materials: readonly MaterialRef[]): string {
  return list(
    'Materials (read each page with the read command below; read every page of the "must read" ones)',
    materials.map((m) => `[${m.id}] ${m.title}: ${m.pages} page${m.pages === 1 ? '' : 's'}${m.mustRead ? ' (must read)' : ''}`),
  );
}

/** zod issues as "path: message" lines. */
export function zodProblems(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}
