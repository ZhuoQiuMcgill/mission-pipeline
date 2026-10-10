// An exploration's definition (design 4.3 "定义（决策层，PM 与用户）"): what is produced, the user's
// fuzzy acceptance goal (verbatim), the attack scope, the decision served and its type (3.10),
// the budget (rounds; 6.5 spend applies through the mission's limit), and the seat settings the
// flow fills cards with. The decision layer defines it; the exploration flow runs it.

import { z } from 'zod';
import { idPart } from '../../common/ids.ts';
import { DEFAULT_ATTACK_SCOPE } from '../../seat/cards/crititor.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const ExplorationDefinitionSchema = z.object({
  format: z.literal('mp4.exploration-definition.v1'),
  /** Unique within the mission; used in task, version, judgment and evidence ids. */
  exploration: z.string().regex(SAFE_ID, 'an exploration id is letters, digits, ".", "_" and "-" (at most 64)'),
  mission: z.string().min(1),
  module: z.string().nullable(),
  /** What is produced (4.3): a design, a method, an analysis, or the answer to a question. */
  product: z.enum(['design', 'method', 'analysis', 'answer']),
  /** A research exploration (4.3): the product is an answer; method first, registered attempts, a separate interpreter. */
  research: z.boolean(),
  /** Research: the question. */
  question: z.string().nullable(),
  /** Required: the user's fuzzy acceptance goal, verbatim. */
  goal: z.string().min(1),
  /** What counts as a hole (4.3 default list, extended or narrowed per product type). */
  attackScope: z.array(z.string().min(1)).min(1),
  /** The decision served and its type (3.10): direction goes to the user, structure to the Secretary (8.2 验收). */
  decision: z.object({ type: z.enum(['direction', 'structure']), text: z.string().min(1), /** The decision's id in the PM plan (plandoc.ts), when it comes from one. */ id: z.string().min(1).optional() }),
  budget: z.object({
    /** Exploration rounds (6.5: an exploration's rounds are capped by its budget): attacker turns. */
    rounds: z.number().int().positive(),
    /** Informational: the mission's spend limit applies (6.5); the flow does not meter. */
    spendMicros: z.number().int().nonnegative().nullable(),
  }),
  /** Which blind executor runs an evidence request when the request does not say (4.3 证据执行). */
  evidenceExecutor: z.enum(['experiment', 'reading']),
  /** Addresses a blind reading may fetch (4.3 "阅读调查可按卡联网"); empty: none. */
  readingNetwork: z.array(z.string()),
  /**
   * Paths of the snapshot a blind experiment may change (copies, never exported as a product).
   * They must exist in the snapshot (the sandbox refuses a missing writable path, 7.1). Empty:
   * the experiment writes only through its commands, into /tmp.
   */
  experimentPaths: z.array(z.string().min(1)),
  /**
   * Evidence runs one seat turn may ask for before it must hand back (6.5: every automatic loop
   * has a cap). Past it the request is recorded as not run (WI-08) and the seat resumes.
   */
  evidencePerTurn: z.number().int().positive(),
  /** Capabilities of the exploration's units (stop scopes, 6.4). */
  capabilities: z.array(z.string()),
  /** About ten lines of duties for the author (the attacker's duties are its definition). */
  duties: z.string(),
  decisionQuotes: z.array(z.string()),
  constraints: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(['object', 'instruction']) })),
  /** Materials every card of this exploration carries (e.g. the document under exploration). */
  materials: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), doc: z.string().regex(/^[0-9a-f]{64}$/) })),
  /** Priority of the exploration's tasks (higher first). */
  priority: z.number().int(),
  mode: z.enum(['stable', 'fast']),
});
export type ExplorationDefinition = z.infer<typeof ExplorationDefinitionSchema>;

/** A definition with the defaults of 4.3 filled in. */
export function explorationDefinition(d: Omit<Partial<ExplorationDefinition>, 'budget'> & Pick<ExplorationDefinition, 'exploration' | 'mission' | 'product' | 'goal' | 'decision'> & { budget: { rounds: number; spendMicros?: number | null } }): ExplorationDefinition {
  return ExplorationDefinitionSchema.parse({
    format: 'mp4.exploration-definition.v1',
    module: null,
    research: d.product === 'answer' && d.research !== false,
    question: null,
    attackScope: [...DEFAULT_ATTACK_SCOPE],
    evidenceExecutor: 'experiment',
    readingNetwork: [],
    experimentPaths: [],
    evidencePerTurn: 3,
    capabilities: [],
    duties: '',
    decisionQuotes: [],
    constraints: [],
    materials: [],
    priority: 0,
    mode: 'stable',
    ...d,
    budget: { rounds: d.budget.rounds, spendMicros: d.budget.spendMicros ?? null },
  });
}

/**
 * The mission and exploration as one token: exploration ids are unique within a mission only
 * (review r1 #17). The mission has no "." (MISSION_ID, checked where it enters); the exploration
 * id is encoded injectively (idPart, review r2: "a.b" and "a-2eb" no longer meet). The plan's id
 * is kept as is for the flow line and the "settled" key (plandoc.ts).
 */
export const tok = (m: string, x: string): string => `${m}.${idPart(x)}`;

/** The ids the flow derives from (mission, exploration) (all valid ledger and launch ids; global, so the mission is in each). */
export const xid = {
  line: (x: string) => `exploration:${x}`,
  /** Op ids of the flow's appends. */
  op: (m: string, x: string, what: string) => `xp:${tok(m, x)}:${what}`,
  lineage: (m: string, x: string) => `xp.${tok(m, x)}`,
  evidenceLineage: (m: string, x: string, k: number) => `xp.${tok(m, x)}.ev${k}`,
  task: (m: string, x: string, n: number, role: string) => `xp.${tok(m, x)}.${n}.${role}`,
  judgment: (m: string, x: string, n: number) => `xpj.${tok(m, x)}.${n}`,
  evidence: (m: string, x: string, k: number) => `xpe.${tok(m, x)}.${k}`,
  versionPrefix: (m: string, x: string, n: number) => `xpv.${tok(m, x)}.${n}`,
  basisLine: (m: string, x: string) => `xpdef.${tok(m, x)}`,
  basisVersion: (m: string, x: string, v: number) => `xpdef.${tok(m, x)}.v${v}`,
  envLine: (m: string, x: string) => `xpenv.${tok(m, x)}`,
  envSnapshot: (m: string, x: string, h: string) => `xpenv.${tok(m, x)}.${h.slice(0, 16)}`,
  /** The object path of the exploration's product (5.2 v33: a concrete document path). */
  path: (m: string, x: string) => `exploration/${tok(m, x)}`,
};
