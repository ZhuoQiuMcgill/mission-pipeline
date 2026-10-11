// Shared helpers of the stored-label tests (4.1 §4.1, §6.5): a project memory
// with the labels extension, a mirror that appends resolved record streams to
// it (the rules' tests use the resolved form), and the comparison of the stored
// derived state with the reference semantics (fullCompute).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revision, type Revision } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { continuationCheck, derivedState, drain, forgetObservedEnvironment, LABELS_EXTENSION } from '../src/evaluator/index.ts';
import { fullCompute, type ContinuationRequest, type ContinuationResult, type DerivedState, type ResolvedCommitted, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { identityOf, initMemory, openMemory, type Memory, type OpenOptions, type WriteTx } from '../src/memory/index.ts';

let base: string | null = null;

/** One temp folder per process for the mirrors' memories, removed at exit. */
function baseDir(): string {
  if (base === null) {
    base = mkdtempSync(join(tmpdir(), 'mp-lbl-'));
    const b = base;
    process.on('exit', () => rmSync(b, { recursive: true, force: true }));
  }
  return base;
}

let projects = 0;
let mirrors = 0;

/** A project folder with its memory and the labels extension (no git). */
export function labelProject(opts: OpenOptions = {}): { readonly m: Memory; readonly dir: string; reopen(o?: OpenOptions): Memory; cleanup(): void } {
  const dir = join(baseDir(), `p${++projects}`);
  execFileSync('mkdir', ['-p', dir]);
  const o: OpenOptions = { git: null, extensions: [LABELS_EXTENSION], ...opts };
  initMemory(dir, o);
  let m = openMemory(dir, o);
  return {
    get m() {
      return m;
    },
    dir,
    reopen(more: OpenOptions = {}) {
      m.close();
      m = openMemory(dir, { ...o, ...more });
      return m;
    },
    cleanup() {
      m.close();
      forgetObservedEnvironment(m.projectDir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The list fields of each record kind (resolved form: arrays; stored form: data-table lists). */
const LIST_KEYS: Readonly<Record<string, readonly string[]>> = {
  'basis.version': ['snapshot'],
  'object.version': ['prerequisites'],
  'proof.unit': ['members'],
  judgment: ['evidence', 'bases', 'constraints', 'reliesOn'],
  issue: ['observedOn'],
  'issue.coverage': ['tests', 'inputs'],
  'op.pending': ['objects'],
};

/** A resolved record in its stored form: each list put into the data table. */
export function storedForm(tx: WriteTx, rec: ResolvedRecord | Record<string, unknown>): BaseRecord {
  const r = { ...(rec as Record<string, unknown>) };
  for (const k of LIST_KEYS[String(r.kind)] ?? []) if (Array.isArray(r[k])) r[k] = tx.data.putList(r[k] as string[]);
  // The rules' streams leave out an operation's stop scope (the memory indexes it); it never touches the labels.
  if (r.kind === 'op.pending' && r.scope === undefined) r.scope = { mission: 'm1', capabilities: [] };
  return r as unknown as BaseRecord;
}

/**
 * Appends resolved records to a memory exactly as given (straight to the log,
 * past the domain checks of appendFact, so the stored labels see the same
 * stream as the reference semantics), one write per call, with an operation id
 * (so the write's own propagation runs). A record whose identity is already
 * recorded is ignored, as the in-memory Index ignores it.
 */
export class Mirror {
  readonly m: Memory;
  /** The records appended, with their revisions in the memory's log. */
  readonly accepted: ResolvedCommitted[] = [];
  private ops = 0;
  /** Operation ids unique to this mirror (two mirrors on one memory never answer each other's writes). */
  private readonly prefix = `mirror-${++mirrors}`;

  constructor(m: Memory) {
    this.m = m;
  }

  append(records: ReadonlyArray<ResolvedRecord | Record<string, unknown>>): void {
    const got = this.m.write({ op: `${this.prefix}-${++this.ops}`, payload: this.ops }, (tx) => {
      const out: Array<{ rev: number; i: number }> = [];
      records.forEach((r, i) => {
        const rec = storedForm(tx, r);
        const ident = identityOf(rec);
        if (ident !== null && tx.stmt('SELECT 1 FROM facts WHERE kind = ? AND id = ?').get(rec.kind, ident)) return;
        out.push({ rev: Number(tx.append(rec)), i });
      });
      return out;
    });
    for (const g of got) this.accepted.push({ revision: revision(g.rev), record: records[g.i] as ResolvedRecord });
  }

  /** The stored state after draining the frontier, checked against fullCompute over the same records. */
  state(): DerivedState {
    drain(this.m);
    const stored = this.m.read((db) => derivedState(db));
    const at = (this.accepted.at(-1)?.revision ?? revision(0)) as Revision;
    sameState(stored, fullCompute(this.accepted, at));
    return stored;
  }

  continuation(req: ContinuationRequest): ContinuationResult {
    drain(this.m);
    const r = this.m.read((db) => continuationCheck(db, req)).result;
    assert.notEqual(r.ok === false ? r.reason : null, 'recomputing');
    return r as ContinuationResult;
  }
}

/** The derived state as plain sorted entries, map by map (revision left out: the two number differently). */
export function plainState(s: DerivedState): Record<string, Array<[string, unknown]>> {
  const out: Record<string, Array<[string, unknown]>> = {};
  for (const k of ['basis', 'evidenceApplicable', 'judgmentCurrent', 'positionInEffect', 'targets', 'fixes', 'ops'] as const) {
    out[k] = [...(s[k] as ReadonlyMap<string, unknown>)].map(([key, v]): [string, unknown] => [key, v !== null && typeof v === 'object' ? { ...v } : v]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  return out;
}

export function sameState(stored: DerivedState, oracle: DerivedState, context = ''): void {
  try {
    assert.deepEqual(plainState(stored), plainState(oracle));
  } catch (e) {
    throw new Error(`stored labels differ from the reference semantics${context}\n${(e as Error).message.slice(0, 6000)}`);
  }
}

// ---------------------------------------------------------------- records in their stored form, through the domain checks

/** Builders of base records as the program appends them (lists in the data table), for one memory. */
export function builders(m: Memory) {
  const list = (xs: readonly string[]) => m.data.putList(xs);
  return {
    basis: (line: string, version: string, basisKind = 'requirement'): BaseRecord => ({ kind: 'basis.version', basisKind, line, version, mission: 'm1', scope: null }) as unknown as BaseRecord,
    withdraw: (line: string): BaseRecord => ({ kind: 'basis.withdrawn', line }) as unknown as BaseRecord,
    evidence: (id: string, env: string, runClass: 'declared' | 'sampling' | 'other' = 'declared', fields: Record<string, string> = { exit: '0' }, envLine = 'env'): BaseRecord =>
      ({ kind: 'evidence', evidence: id, envLine, envSnapshot: env, runClass, fields }) as unknown as BaseRecord,
    product: (id: string, o: { prereqs?: string[]; reviews?: Array<{ review: string; basisLines?: string[]; reliesOn?: string[] }>; commit?: string } = {}): BaseRecord =>
      ({
        kind: 'object.version',
        object: id,
        objectKind: 'product',
        mission: 'm1',
        module: null,
        content: m.data.put(`content of ${id}`),
        prerequisites: list(o.prereqs ?? []),
        scope: { paths: [`src/${id}.ts`], taskType: 'construct' },
        reviews: (o.reviews ?? [{ review: 'reviewer' }]).map((r) => ({ review: r.review, basisLines: r.basisLines ?? [], reliesOn: r.reliesOn ?? [] })),
        ...(o.commit !== undefined ? { source: { commit: o.commit, writeScope: [`src/${id}.ts`], transform: '0'.repeat(64) } } : {}),
      }) as unknown as BaseRecord,
    judge: (
      id: string,
      target: string,
      o: { evidence?: string[]; bases?: string[]; reliesOn?: string[]; verdict?: 'pass' | 'fail' | 'undecided'; review?: string; fields?: string[]; statisticalOrExternal?: boolean; issues?: Array<{ issue: string; response: 'fixed' | 'not-fixed' }> } = {},
    ): BaseRecord =>
      ({
        kind: 'judgment',
        judgment: id,
        review: o.review ?? 'reviewer',
        executor: o.review ?? 'reviewer',
        target,
        verdict: o.verdict ?? 'pass',
        evidence: list(o.evidence ?? []),
        bases: list(o.bases ?? []),
        constraints: list([]),
        reliesOn: list(o.reliesOn ?? []),
        issues: o.issues ?? [],
        revokes: null,
        extends: null,
        evidenceUse: { fields: o.fields ?? ['exit'], statisticalOrExternal: o.statisticalOrExternal ?? false },
        superseded: [],
      }) as unknown as BaseRecord,
    pending: (op: string, objects: string[], opKind = 'delivery'): BaseRecord => ({ kind: 'op.pending', op, opKind, objects: list(objects), scope: { mission: 'm1', capabilities: [] } }) as unknown as BaseRecord,
  };
}

/** This machine, as a test describes it: the identity's parts. */
export function machine(os: string, versions: Record<string, string> = { 'node --version': 'v22.17.1' }): () => { os: string; osVersion: string; arch: string; versions: Record<string, string> } {
  return () => ({ os, osVersion: '1', arch: 'x64', versions });
}
