// Shared pieces of every seat card (design 2 "每个席位的定义只有一页", 7.1, 9.3). The card
// fields here mirror src/seat/card.ts (Constructor, Reviewer) so the seat host can treat every
// card kind alike: format, launch, mission, module, capabilities (stop scopes, 6.4), duties,
// verbatim decisions, filtered constraints (9.5), limits (6.2, 6.5), async evidence and resume
// (6.2). A card kind adds its own fields and declares its tool profile (7.1).

import { z } from 'zod';

export const CARD_FORMAT = 'mp4.seat-card.v1' as const;

export const Item = z.object({ id: z.string().min(1), text: z.string().min(1) });
export const Interface = z.object({ name: z.string().min(1), definition: z.string() });
export const Command = z.object({ id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional() });
export const ListRefSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), count: z.number().int().nonnegative() });
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);

/** A snapshot the seat reads (7.1): mounted read-only in its tool sandbox. */
export const Workspace = z.object({
  snapshot: z.string().startsWith('/'),
  /** Constructor-like seats only; read-only seats have none. */
  writablePaths: z.array(z.string()),
  mountPoint: z.string().startsWith('/').optional(),
  /** Paths rerun commands may write into (copies, never exported). */
  scratchPaths: z.array(z.string()).optional(),
});

/** A read-only workspace: no writable path at all. */
export const ReadOnlyWorkspace = Workspace.extend({
  writablePaths: z.array(z.string()).max(0, 'this seat has no writable paths'),
});

export const Limits = z.object({
  run: z.object({ memoryMax: z.number().int().positive(), pidsMax: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }),
  areaBytes: z.number().int().positive(),
  export: z.object({ maxLogicalBytes: z.number().int().nonnegative(), maxFiles: z.number().int().nonnegative() }),
  recoveryStateBytes: z.number().int().nonnegative(),
  recoveryStateFiles: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  wallClockMs: z.number().int().positive().optional(),
});

/**
 * A material the seat reads through the material tool (7.1 "材料工具"): an immutable document
 * in the content store, read page by page. `mustRead` materials form the must-read list: the
 * program refuses the hand-back until every page of each was read (7.1, 第六轮第 4 条).
 */
export const Material = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
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

/** Bytes per material page (the host splits a material document by this size, UTF-8 safe). */
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

/** The key the host records when a page is read: `${material}#${page}`. */
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

/** Fields every card kind carries (same names and rules as src/seat/card.ts). */
export const commonCardFields = {
  format: z.literal(CARD_FORMAT),
  launch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  mission: z.string().min(1),
  module: z.string().nullable(),
  capabilities: z.array(z.string()),
  duties: z.string(),
  decisionQuotes: z.array(z.string()),
  constraints: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(['object', 'instruction']) })),
  limits: Limits,
  allowAsyncEvidence: z.boolean().optional(),
  resume: z.object({ sessionId: z.string().min(1), state: Hash.nullable(), evidence: z.string() }).optional(),
};

export const TOOLS_NOTE_SNAPSHOT =
  'Every capability you have is a program tool. They run inside a sandbox that holds the project snapshot at the mount point; paths are relative to it. There is no network, no user to ask, and no repository metadata. Tool output is capped; a cut output says so.';

export const TOOLS_NOTE_MATERIALS =
  'You have no file tools and no shell. Every capability you have is a program tool: read_material reads one page of a material listed on the card (by its id and page number), and submit_result hands back your result. Read every page of every material marked "must read" before you hand back: the program refuses the result otherwise.';

/** "## Title\n- a\n- b" (empty string when there is nothing to list). */
export function list(title: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
}

/** The common head of every card's first message. */
export function renderCommon(c: { launch: string; duties: string; constraints: readonly { id: string; text: string }[]; decisionQuotes: readonly string[] }): string {
  return (
    `# Card for launch ${c.launch}\n\n` +
    (c.duties.trim() !== '' ? `## Your duties on this task\n${c.duties.trim()}\n\n` : '') +
    list('Project constraints', c.constraints.map((k) => `[${k.id}] ${k.text}`)) +
    list('Relevant decisions (verbatim)', c.decisionQuotes)
  );
}

export function renderMaterials(materials: readonly MaterialRef[]): string {
  return list(
    'Materials (read with read_material; "must read" ones completely)',
    materials.map((m) => `[${m.id}] ${m.title}: ${m.pages} page${m.pages === 1 ? '' : 's'}${m.mustRead ? ' (must read)' : ''}`),
  );
}

/** zod issues as "path: message" lines. */
export function zodProblems(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}
