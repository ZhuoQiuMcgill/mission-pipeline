// The exploration's cards (design 4.3, 8.2, 6.2): built from the state alone (machine.ts), so a
// restarted flow builds the same card. Every card carries what the ledger knows (the product's
// current version, every finding with its disposition, the evidence executions, the discussion,
// the rulings), so a seat whose session cannot be resumed loses only the conversation, never the
// facts (6.2, WI-17).

import { materialPageCount, type MaterialRef } from '../../seat/cards/common.ts';
import type { CrititorCard, EvidenceItemT, NewVersionT, PriorFindingT } from '../../seat/cards/crititor.ts';
import type { ExperimentCard } from '../../seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard, ReaderCard, RegisteredAttemptT } from '../../seat/cards/researcher.ts';
import { SEAT_CAPABILITIES } from '../context.ts';
import type { FlowContent } from '../ports.ts';
import { xid } from './definition.ts';
import { phaseFindings, type FindingState, type XState } from './machine.ts';

/** Seat limits for exploration cards (6.2, 6.5): declared peaks, the writable area, the export and recovery caps. */
export const EXPLORATION_LIMITS = {
  run: { memoryMax: 1 << 30, timeoutMs: 30 * 60_000 },
  areaBytes: 256 << 20,
  export: { maxLogicalBytes: 64 << 20, maxFiles: 2_000 },
  recoveryStateBytes: 64 << 20,
};

export interface Resume {
  readonly sessionId: string;
  readonly state: string | null;
  readonly evidence: string;
}

class Materials {
  readonly list: MaterialRef[] = [];
  private readonly content: FlowContent;
  constructor(content: FlowContent) {
    this.content = content;
  }
  add(id: string, title: string, ref: string, mustRead: boolean): string {
    if (!this.list.some((m) => m.id === id)) this.list.push({ id, title, ref, pages: materialPageCount(this.content.get(ref)), mustRead });
    return id;
  }
}

function defined(s: XState) {
  if (s.defined === null || s.def === null) throw new Error('exploration not defined');
  return { d: s.defined, def: s.def };
}

function common(s: XState, task: string, duties: string, resume: Resume | null, asyncEvidence: boolean, extraCaps: readonly string[] = []) {
  const { def } = defined(s);
  return {
    format: 'mp4.seat-card.v1' as const,
    launch: task,
    mission: def.mission,
    module: def.module,
    // every seat runs a model (6.4: a stop on model use or on seats covers it), plus the definition's
    capabilities: [...new Set([...SEAT_CAPABILITIES, ...def.capabilities, ...extraCaps])],
    duties,
    decisionQuotes: def.decisionQuotes,
    constraints: def.constraints,
    limits: EXPLORATION_LIMITS,
    ...(asyncEvidence ? { allowAsyncEvidence: true } : {}),
    ...(resume !== null ? { resume } : {}),
  };
}

function readOnlyWorkspace(s: XState) {
  return { snapshot: defined(s).d.snapshot.path, writablePaths: [] as string[] };
}

function explorationRef(s: XState, focus: 'product' | 'method' | 'reasoning') {
  const { def } = defined(s);
  return { id: def.exploration, product: def.product, research: def.research, focus, question: def.question };
}

function focusOf(s: XState): 'product' | 'method' | 'reasoning' {
  return s.phase === 'method' ? 'method' : s.phase === 'reasoning' || s.phase === 'interpret' ? 'reasoning' : 'product';
}

function baseMaterials(s: XState, m: Materials): void {
  const { d, def } = defined(s);
  m.add('definition', 'The exploration definition', d.definitionDoc, false);
  for (const x of def.materials) m.add(`def-${x.id}`, x.title, x.doc, false);
}

function priorFinding(f: FindingState, m: Materials, i: number, mustRead: boolean): PriorFindingT {
  return {
    id: f.id,
    severity: f.severity,
    class: f.class,
    title: f.title,
    round: f.round,
    material: m.add(`finding-${i + 1}`, `Finding ${f.id.slice(0, 20)}: ${f.title}`.slice(0, 200), f.doc, mustRead),
    status: f.status,
    disposition: f.disposition === null ? null : { action: f.disposition.action, note: f.disposition.note, evidence: f.disposition.evidence, question: f.disposition.question },
    ruling: f.ruling,
  };
}

function evidenceItems(s: XState, m: Materials, onlyExtra = false, mustRead: ReadonlySet<string> = new Set()): EvidenceItemT[] {
  return [...s.evidence.values()]
    .filter((e) => !onlyExtra || e.attempt === null)
    .sort((a, b) => a.k - b.k)
    .map((e) => ({ id: e.id, status: e.status, summary: e.summary, attempt: e.attempt, material: e.report !== null ? m.add(`evidence-${e.id}`, `Evidence ${e.id} report`, e.report, mustRead.has(e.id)) : null }));
}

function rulings(s: XState): string[] {
  return s.rulings.filter((r) => r.decision !== 'extend' && r.decision !== 'retry' && r.text.trim() !== '').map((r) => `(${r.decision}${r.findings.length > 0 ? ` on ${r.findings.join(', ')}` : ''}, by ${r.by}) ${r.text}`);
}

/** What a version of this phase relies on: a research interpretation, its method version (review r1 #2). */
export function versionReliesOn(s: XState): string[] {
  return (s.phase === 'reasoning' || s.phase === 'interpret') && s.method !== null ? [s.method.version] : [];
}

/**
 * The evidence the current version's standing rests on (review r1 #2): the runs that rebutted
 * findings now resolved, and for a research interpretation every record it cites (each attempt's
 * record and every cited evidence execution).
 */
export function versionEvidence(s: XState, content: FlowContent): string[] {
  const out = new Set<string>();
  for (const f of phaseFindings(s)) if (f.status === 'resolved' && f.disposition?.action === 'rebut' && f.disposition.evidence !== null) out.add(f.disposition.evidence);
  if (s.phase === 'reasoning' && s.version !== null) {
    try {
      const doc = JSON.parse(content.get(s.version.content)) as { conclusions?: Array<{ cites?: string[] }> };
      const byAttempt = new Map([...s.evidence.values()].flatMap((e) => (e.attempt !== null ? [[e.attempt, e.id] as const] : [])));
      for (const c of doc.conclusions ?? []) for (const x of c.cites ?? []) out.add(byAttempt.get(x) ?? x);
    } catch {
      /* not an interpretation document */
    }
    for (const a of s.method?.attempts ?? []) {
      const e = [...s.evidence.values()].find((x) => x.attempt === a.id);
      if (e !== undefined) out.add(e.id);
    }
  }
  return [...out].filter((e) => s.evidence.has(e)).sort();
}

function newVersion(s: XState, n: number): NewVersionT {
  const { d, def } = defined(s);
  const relies = versionReliesOn(s.phase === 'interpret' ? { ...s, phase: 'reasoning' } : s);
  return {
    prefix: xid.versionPrefix(def.mission, def.exploration, n),
    objectKind: 'interpretation',
    scope: { paths: [xid.path(def.mission, def.exploration)], taskType: 'exploration' },
    reviews: [{ review: 'crititor', basisLines: [d.basisLine], reliesOn: relies }],
    predecessor: s.version?.id ?? null,
    prerequisites: relies,
  };
}

const AUTHOR_DUTIES =
  'You own this exploration\'s product. Each turn pick one step: discuss the framing, ask for evidence (request_evidence), or submit a new version with a disposition for every open finding.';

export function authorCard(s: XState, n: number, task: string, content: FlowContent, resume: Resume | null): AuthorCard {
  const { def } = defined(s);
  const m = new Materials(content);
  if (s.version !== null) m.add('version', `Current version ${s.version.id}`, s.version.content, true);
  baseMaterials(s, m);
  const all = [...s.findings.values()];
  const findings = phaseFindings(s);
  const open = findings.filter((f) => f.status === 'open');
  const other = findings.filter((f) => f.status !== 'open');
  return {
    ...common(s, task, def.duties.trim() !== '' ? def.duties : AUTHOR_DUTIES, resume, true),
    seat: 'researcher-author',
    workspace: readOnlyWorkspace(s),
    exploration: explorationRef(s, focusOf(s)),
    goal: def.goal,
    attackScope: def.attackScope,
    decision: def.decision,
    round: s.rounds,
    budgetRounds: def.budget.rounds + s.extraRounds,
    current: s.version === null ? null : { version: s.version.id, content: s.version.content, material: 'version' },
    openFindings: open.map((f) => priorFinding(f, m, all.indexOf(f), true)),
    otherFindings: other.map((f) => priorFinding(f, m, all.indexOf(f), false)),
    evidence: evidenceItems(s, m),
    discussion: [...s.discussion],
    rulings: rulings(s),
    materials: m.list,
    newVersion: newVersion(s, n),
    registerAttempts: s.phase === 'method',
  };
}

export function interpreterCard(s: XState, n: number, task: string, content: FlowContent): InterpreterCard {
  const { def } = defined(s);
  if (s.method === null) throw new Error('interpretation before the method passed');
  const m = new Materials(content);
  const methodVersion = s.versions.find((v) => v.id === s.method?.version);
  if (methodVersion === undefined) throw new Error(`method version ${s.method.version} unknown`);
  m.add('method', `Method ${methodVersion.id}`, methodVersion.content, true);
  const current = s.phase === 'reasoning' ? s.version : null;
  if (current !== null) m.add('version', `Current interpretation ${current.id}`, current.content, true);
  baseMaterials(s, m);
  const findings = s.phase === 'reasoning' ? phaseFindings(s) : [];
  const open = findings.filter((f) => f.status === 'open');
  const other = findings.filter((f) => f.status !== 'open');
  const all = [...s.findings.values()];
  return {
    ...common(s, task, 'Interpret the records of the registered attempts; you took part in none of the executions.', null, false),
    seat: 'researcher-interpreter',
    workspace: readOnlyWorkspace(s),
    exploration: explorationRef(s, 'reasoning'),
    goal: def.goal,
    attackScope: def.attackScope,
    method: { version: methodVersion.id, material: 'method' },
    attempts: s.method.attempts.map((a: RegisteredAttemptT) => {
      const e = [...s.evidence.values()].find((x) => x.attempt === a.id) ?? null;
      return {
        id: a.id,
        kind: a.kind,
        purpose: a.purpose,
        evidence: e?.id ?? null,
        status: e?.status ?? 'not-run',
        summary: e?.summary ?? 'no record',
        material: e !== null && e.report !== null ? m.add(`evidence-${e.id}`, `Attempt ${a.id} record`, e.report, true) : null,
      };
    }),
    evidence: evidenceItems(s, m, true),
    round: s.rounds,
    budgetRounds: def.budget.rounds + s.extraRounds,
    current: current === null ? null : { version: current.id, content: current.content, material: 'version' },
    openFindings: open.map((f) => priorFinding(f, m, all.indexOf(f), true)),
    otherFindings: other.map((f) => priorFinding(f, m, all.indexOf(f), false)),
    rulings: rulings(s),
    materials: m.list,
    newVersion: newVersion(s, n),
  };
}

export function attackerCard(s: XState, n: number, task: string, content: FlowContent, mode: 'attack' | 'discuss', fresh: boolean, resume: Resume | null): CrititorCard {
  const { d, def } = defined(s);
  const m = new Materials(content);
  const target = s.version;
  if (mode === 'attack' && target === null) throw new Error('attack without a version');
  if (target !== null) m.add('version', `Version ${target.id} (attacked)`, target.content, mode === 'attack');
  const idx = target === null ? -1 : s.versions.findIndex((v) => v.id === target.id);
  const previous = idx > 0 ? (s.versions[idx - 1] ?? null) : null;
  if (previous !== null) m.add('previous', `Previous version ${previous.id}`, previous.content, false);
  baseMaterials(s, m);
  const all = [...s.findings.values()];
  const mine = phaseFindings(s);
  // the closing attacker gets a fresh view: only what is still to be checked, not the history
  const shown = fresh ? mine.filter((f) => f.status !== 'resolved') : mine;
  return {
    ...common(s, task, 'Attack the version adversarially and re-check every finding marked awaiting-recheck.', resume, true),
    seat: 'crititor',
    workspace: readOnlyWorkspace(s),
    exploration: explorationRef(s, focusOf(s)),
    goal: def.goal,
    attackScope: def.attackScope,
    mode,
    fresh,
    round: s.rounds + 1,
    target: target?.id ?? null,
    review: 'crititor',
    previousTarget: previous?.id ?? null,
    priorFindings: shown.map((f) => priorFinding(f, m, all.indexOf(f), f.status === 'awaiting-recheck')),
    // a rebuttal's evidence report must be read before its re-check (8.2: does it cover the counterexample?)
    evidence: evidenceItems(s, m, false, new Set(shown.flatMap((f) => (f.status === 'awaiting-recheck' && f.disposition?.evidence != null ? [f.disposition.evidence] : [])))),
    discussion: fresh ? [] : [...s.discussion],
    rulings: rulings(s),
    materials: m.list,
    binding:
      mode === 'attack' && target !== null
        ? {
            judgment: xid.judgment(def.mission, def.exploration, n),
            bases: content.putList([d.basisVersion]),
            constraints: content.putList([]),
            // the contract's objects (a research interpretation: its method version)
            reliesOn: content.putList(versionReliesOn(s)),
            revokes: s.negations.get(target.id) ?? null,
            extends: null,
            evidenceUse: { fields: ['record'], statisticalOrExternal: true },
            superseded: [],
          }
        : null,
    requiredEvidence: mode === 'attack' ? versionEvidence(s, content) : [],
  };
}

/** An evidence request as the seat host stores it (src/seat/host.ts: mp4.evidence-request.v1). */
export interface EvidenceRequestDoc {
  readonly steps: readonly string[];
  readonly data: string;
  readonly measure: readonly string[];
  readonly assertions: readonly string[];
  readonly executor?: 'experiment' | 'reading';
}

export function parseEvidenceRequest(doc: string): EvidenceRequestDoc | null {
  try {
    const v = JSON.parse(doc) as Record<string, unknown>;
    const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string');
    if (!strings(v['steps']) || v['steps'].length === 0 || typeof v['data'] !== 'string' || !strings(v['measure']) || !strings(v['assertions'])) return null;
    const ex = v['executor'];
    return { steps: v['steps'], data: v['data'], measure: v['measure'], assertions: v['assertions'], ...(ex === 'experiment' || ex === 'reading' ? { executor: ex } : {}) };
  } catch {
    return null;
  }
}

/** A blind executor's card (4.3: steps, data, quantities, assertions; no expectation). */
export function executorCard(
  s: XState,
  task: string,
  content: FlowContent,
  req: EvidenceRequestDoc,
  executor: 'experiment' | 'reading',
  evidence: { readonly id: string; readonly attempt: string | null },
): ExperimentCard | ReaderCard {
  const { d, def } = defined(s);
  // blind (4.3, review r1 #19): no material of the exploration (not the PM plan, not the document
  // under exploration, not the findings), no decision quotes; only the request's own data
  const m = new Materials(content);
  const blind = {
    steps: [...req.steps],
    data: req.data,
    measure: [...req.measure],
    assertions: [...req.assertions],
    evidence: { id: evidence.id, envLine: d.envLine, envSnapshot: d.envSnapshot, attempt: evidence.attempt },
    materials: m.list,
  };
  const duties = 'Carry out the evidence run exactly as the steps say and record what happened.';
  // execution instructions only: object constraints and decision quotes carry intent, not steps
  const blindCommon = (extra: readonly string[]) => ({ ...common(s, task, duties, null, false, extra), decisionQuotes: [], constraints: def.constraints.filter((k) => k.kind === 'instruction') });
  if (executor === 'reading') {
    const net = def.readingNetwork.length > 0 ? ['net'] : [];
    return { ...blindCommon(net), seat: 'researcher-reader', workspace: readOnlyWorkspace(s), network: { allowed: [...def.readingNetwork] }, ...blind };
  }
  return { ...blindCommon([]), seat: 'constructor-experiment', workspace: { snapshot: d.snapshot.path, writablePaths: [...def.experimentPaths] }, interpreter: '', ...blind };
}
