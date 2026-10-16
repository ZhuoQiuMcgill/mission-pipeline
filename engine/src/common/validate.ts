import { missionIdProblem } from './ids.ts';
// Structural validation of records at the memory's boundary (6.1 "发布前复核":
// a record that would make the derived state uncomputable, or a fact the
// labels would read differently from its writer, never enters the log).
//
// Checks shapes and value domains only. Whether referenced data exists, and
// whether ids collide with earlier facts, is checked inside the memory's write
// (memory/data.ts, memory/domain/facts.ts).

import { LOOP_KINDS, RUN_CLASSES, WI_CATALOG, type BaseRecord } from './records.ts';

export class RecordInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordInvalid';
  }
}

type Obj = Record<string, unknown>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/; // as in ids.ts
const HEX64 = /^[0-9a-f]{64}$/;

function fail(kind: string, msg: string): never {
  throw new RecordInvalid(`${kind}: ${msg}`);
}
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function id(r: Obj, k: string, nullable = false): void {
  const v = r[k];
  if (nullable && v === null) return;
  if (typeof v !== 'string' || !ID.test(v)) fail(String(r.kind), `${k} is not a valid id`);
}
function str(r: Obj, k: string, nullable = false): void {
  const v = r[k];
  if (nullable && v === null) return;
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096) fail(String(r.kind), `${k} is not a non-empty string`);
}
const FLOW_EVENT = /^[a-z0-9-]{1,64}$/;
// Printable: no C0/C1 control characters, no lone surrogates.
const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function printable(r: Obj, k: string, max: number): void {
  const v = r[k];
  if (typeof v !== 'string' || v.length === 0 || [...v].length > max || !PRINTABLE.test(v) || LONE_SURROGATE.test(v)) fail(String(r.kind), `${k} is 1 to ${max} printable characters`);
}
function hash(r: Obj, k: string): void {
  if (typeof r[k] !== 'string' || !HEX64.test(r[k] as string)) fail(String(r.kind), `${k} is not a sha256 hex digest`);
}
function nat(r: Obj, k: string, nullable = false): void {
  const v = r[k];
  if (nullable && v === null) return;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(String(r.kind), `${k} is not a non-negative integer`);
}
function list(r: Obj, k: string): void {
  const v = r[k];
  if (!isObj(v) || typeof v.hash !== 'string' || !HEX64.test(v.hash) || typeof v.count !== 'number' || !Number.isSafeInteger(v.count) || v.count < 0) {
    fail(String(r.kind), `${k} is not a list reference`);
  }
}
function oneOf(r: Obj, k: string, values: readonly string[]): void {
  if (!values.includes(r[k] as string)) fail(String(r.kind), `${k} must be one of ${values.join(', ')}`);
}
function strings(r: Obj, k: string, max = 10_000): void {
  const v = r[k];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length > 0)) fail(String(r.kind), `${k} is not a list of strings`);
}
function scope(r: Obj, k: string, nullable: boolean): void {
  const v = r[k];
  if (nullable && (v === null || v === undefined)) return;
  if (!isObj(v)) fail(String(r.kind), `${k} is not a scope`);
  strings(v, 'paths');
  strings(v, 'taskTypes');
  if (v['mission'] !== undefined && missionIdProblem(v['mission']) !== null) fail(String(r.kind), 'scope.mission is not a mission id');
}

/** 4.1 §6.5: an environment identity's parts: bounded strings, at most 64 version commands. */
function environmentParts(v: unknown): void {
  if (!isObj(v)) fail('env.snapshot', 'parts is not an object');
  for (const k of ['os', 'osVersion', 'arch']) {
    if (typeof v[k] !== 'string' || (v[k] as string).length > 512) fail('env.snapshot', `parts.${k} is not a string of at most 512 characters`);
  }
  const versions = v.versions;
  if (!isObj(versions) || Object.keys(versions).length > 64) fail('env.snapshot', 'parts.versions maps at most 64 version commands to their output');
  for (const [cmd, out] of Object.entries(versions)) {
    if (cmd.length === 0 || cmd.length > 1000 || typeof out !== 'string' || out.length > 2000) fail('env.snapshot', 'parts.versions maps a command (1 to 1000 characters) to its output (at most 2000 characters)');
  }
  const digests = v.digests;
  if (digests !== undefined && (!isObj(digests) || !Object.entries(digests).every(([cmd, h]) => Object.hasOwn(versions, cmd) && typeof h === 'string' && HEX64.test(h)))) {
    fail('env.snapshot', 'parts.digests maps each version command to the sha256 of its whole output');
  }
}

/** Validate one base record's shape. Throws RecordInvalid. */
export function validateRecord(rec: unknown): asserts rec is BaseRecord {
  if (!isObj(rec) || typeof rec.kind !== 'string') throw new RecordInvalid('not a record');
  const r = rec;
  switch (r.kind) {
    case 'basis.version':
      oneOf(r, 'basisKind', ['requirement', 'requirement-set', 'authorization', 'constraint', 'instruction', 'standard']);
      id(r, 'line');
      id(r, 'version');
      id(r, 'mission', true);
      scope(r, 'scope', true);
      if ((r.basisKind === 'constraint' || r.basisKind === 'instruction') === false && r.scope !== null) fail('basis.version', 'only constraints and instructions have a scope');
      if (r.snapshot !== undefined) {
        if (r.basisKind !== 'requirement-set') fail('basis.version', 'only requirement-set versions have a snapshot');
        list(r, 'snapshot');
      } else if (r.basisKind === 'requirement-set') {
        fail('basis.version', 'a requirement-set version needs its snapshot (v31 5.2)');
      }
      return;
    case 'constraint.scope':
      id(r, 'line');
      scope(r, 'scope', false);
      return;
    case 'basis.withdrawn':
      id(r, 'line');
      return;
    case 'env.snapshot':
      id(r, 'line');
      id(r, 'snapshot');
      if (r.parts !== undefined) environmentParts(r.parts);
      return;
    case 'evidence': {
      id(r, 'evidence');
      id(r, 'envLine');
      id(r, 'envSnapshot');
      oneOf(r, 'runClass', RUN_CLASSES);
      const f = r.fields;
      if (!isObj(f) || !Object.values(f).every((x) => typeof x === 'string')) fail('evidence', 'fields must map names to strings');
      return;
    }
    case 'evidence.revoked':
      id(r, 'evidence');
      return;
    case 'evidence.renewal':
      id(r, 'judgment');
      id(r, 'original');
      id(r, 'replacement');
      if (r.original === r.replacement) fail('evidence.renewal', 'replacement equals original');
      return;
    case 'object.version': {
      id(r, 'object');
      oneOf(r, 'objectKind', ['product', 'interface', 'plan', 'interpretation', 'chain-acceptance']);
      id(r, 'mission');
      id(r, 'module', true);
      hash(r, 'content');
      list(r, 'prerequisites');
      const sc = r.scope;
      if (!isObj(sc)) fail('object.version', 'scope is missing');
      strings(sc, 'paths');
      if (typeof sc.taskType !== 'string') fail('object.version', 'scope.taskType is missing');
      contracts(r);
      if (r.predecessor !== undefined) id(r, 'predecessor');
      for (const p of sc.paths as string[]) {
        if (p.includes('*') || p.startsWith('/') || p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
          fail('object.version', `scope path ${JSON.stringify(p)} is not a concrete normalized repository path (v33 5.2)`);
        }
      }
      if (r.source !== undefined) {
        const src = r.source;
        if (!isObj(src) || typeof src.commit !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(src.commit)) fail('object.version', 'source.commit is not a git object id');
        strings(src, 'writeScope');
        hash(src, 'transform');
        if (src.origin !== undefined && (typeof src.origin !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(src.origin))) fail('object.version', 'source.origin is not a git object id');
      }
      return;
    }
    case 'proof.unit':
      id(r, 'unit');
      list(r, 'members');
      contracts(r);
      return;
    case 'judgment': {
      id(r, 'judgment');
      str(r, 'review');
      str(r, 'executor');
      id(r, 'target');
      oneOf(r, 'verdict', ['pass', 'fail', 'undecided']);
      for (const k of ['evidence', 'bases', 'constraints', 'reliesOn']) list(r, k);
      if (!Array.isArray(r.issues) || !r.issues.every((x) => isObj(x) && typeof x.issue === 'string' && ['fixed', 'not-fixed', 'deferred'].includes(x.response as string))) {
        fail('judgment', 'issues is malformed');
      }
      for (const x of r.issues as Obj[]) {
        if (x.response === 'deferred' && (typeof x.owner !== 'string' || x.owner.length === 0 || typeof x.reason !== 'string' || !HEX64.test(x.reason))) {
          fail('judgment', 'a deferred issue response needs an owner and a reason (5.6)');
        }
      }
      id(r, 'revokes', true);
      id(r, 'extends', true);
      const use = r.evidenceUse;
      if (!isObj(use) || typeof use.statisticalOrExternal !== 'boolean') fail('judgment', 'evidenceUse is malformed');
      strings(use, 'fields');
      if (!Array.isArray(r.superseded) || !r.superseded.every((x) => isObj(x) && typeof x.input === 'string' && typeof x.by === 'string' && x.input !== x.by)) {
        fail('judgment', 'superseded is malformed');
      }
      if (r.superseded.length > 0 && r.extends === null) fail('judgment', 'only a continuation judgment supersedes inputs');
      return;
    }
    case 'issue':
      id(r, 'issue');
      id(r, 'module', true);
      list(r, 'observedOn');
      if (r.text !== undefined) hash(r, 'text');
      return;
    case 'seat.result':
      id(r, 'launch');
      str(r, 'seat');
      oneOf(r, 'status', ['handed-back', 'needs-evidence', 'seat-failure', 'environment-failure', 'resource-exceeded', 'cancelled', 'timed-out']);
      for (const k of ['result', 'export', 'transcript', 'recoveryState', 'evidenceRequest']) if (r[k] !== null) hash(r, k);
      for (const k of ['transcriptIncomplete', 'toolLogIncomplete']) if (r[k] !== undefined && typeof r[k] !== 'boolean') fail('seat.result', `${k} is a boolean`);
      if (r.toolLog !== undefined && r.toolLog !== null) hash(r, 'toolLog');
      if (r.toolLogIncomplete === true && (r.toolLog === undefined || r.toolLog === null)) fail('seat.result', 'toolLogIncomplete needs the tool log');
      if (r.transcriptIncomplete === true && r.transcript === null) fail('seat.result', 'transcriptIncomplete needs the transcript');
      if (r.sessionId !== undefined) id(r, 'sessionId', true);
      return;
    case 'issue.coverage':
      id(r, 'issue');
      id(r, 'version');
      id(r, 'evidence');
      str(r, 'command');
      list(r, 'tests');
      list(r, 'inputs');
      if ((r.tests as { count: number }).count === 0) fail('issue.coverage', 'a regression registration names at least one test');
      // The prefixes of the input entries are checked inside the write after resolving the list (memory/data.ts checkCoverageInputs).
      return;
    case 'op.pending':
      id(r, 'op');
      oneOf(r, 'opKind', ['stable-dispatch', 'legalization', 'delivery', 'full-close']);
      list(r, 'objects');
      if (!isObj(r.scope)) fail('op.pending', 'scope is missing');
      id(r.scope, 'mission');
      if (!Array.isArray(r.scope.capabilities) || !r.scope.capabilities.every((c) => typeof c === 'string')) fail('op.pending', 'scope.capabilities is malformed');
      return;
    case 'op.executed':
      id(r, 'op');
      nat(r, 'asOf');
      return;
    case 'episode.batch':
      id(r, 'batch');
      nat(r, 'publishes');
      list(r, 'changes');
      return;
    case 'notice':
      str(r, 'notice');
      oneOf(r, 'audience', ['pm']);
      hash(r, 'body');
      if (r.trigger !== undefined) str(r, 'trigger');
      if (r.defaultAction !== undefined) str(r, 'defaultAction');
      return;
    case 'continuation.check':
      id(r, 'judgment');
      id(r, 'extends');
      id(r, 'target');
      nat(r, 'revision');
      if (typeof r.ok !== 'boolean') fail('continuation.check', 'ok is a boolean');
      str(r, 'reason', true);
      if (r.ok === (r.reason !== null)) fail('continuation.check', 'a failed check gives its reason, a passing one none');
      if (r.ok === true) hash(r, 'inputs');
      else if (r.inputs !== null) fail('continuation.check', 'a failed check has no merged inputs');
      return;
    case 'alert':
      id(r, 'alert');
      str(r, 'category');
      if (r.wi !== undefined && (typeof r.wi !== 'string' || !WI_CATALOG.has(r.wi))) fail('alert', `wi must be one of the 4.1 work instructions (${[...WI_CATALOG].join(', ')})`);
      if (r.informational !== undefined && r.informational !== true) fail('alert', 'informational is true or absent');
      if ((r.wi === undefined) !== (r.informational === true)) fail('alert', 'an exception alert names its WI (3.11); a notice that is not an exception says informational: true, without a WI');
      hash(r, 'body');
      return;
    case 'loop.attempt':
      str(r, 'lineage');
      oneOf(r, 'loop', LOOP_KINDS);
      str(r, 'failureClass', true);
      str(r, 'signature');
      return;
    case 'loop.grant':
      str(r, 'lineage');
      oneOf(r, 'loop', LOOP_KINDS);
      oneOf(r, 'by', ['secretary', 'user']);
      nat(r, 'extra');
      if (r.by === 'secretary' && (r.extra as number) > 2) fail('loop.grant', 'Secretary grants at most 2 extra attempts');
      hash(r, 'reason');
      return;
    case 'user.words':
      id(r, 'message');
      str(r, 'session');
      nat(r, 'at');
      hash(r, 'text');
      if (typeof r.excerpt !== 'string' || r.excerpt.length > 280) fail('user.words', 'excerpt is a string of at most 280 characters');
      return;
    case 'flow.event':
      id(r, 'mission');
      printable(r, 'line', 200);
      if (typeof r.event !== 'string' || !FLOW_EVENT.test(r.event)) fail('flow.event', 'event is 1 to 64 characters of a-z, 0-9 and -');
      printable(r, 'key', 200);
      hash(r, 'body');
      return;
    case 'task.queued':
      id(r, 'task');
      str(r, 'lineage');
      id(r, 'mission');
      hash(r, 'card');
      if (r.queuedBy !== undefined) {
        const q = r.queuedBy;
        if (!isObj(q)) fail('task.queued', 'queuedBy is { dispatch, task, objects, step }');
        if (q.dispatch !== null && (typeof q.dispatch !== 'string' || q.dispatch.length === 0 || q.dispatch.length > 200)) fail('task.queued', 'queuedBy.dispatch is a dispatch id or null');
        if (q.task !== null && (typeof q.task !== 'string' || q.task.length === 0 || q.task.length > 200)) fail('task.queued', 'queuedBy.task is a task id or null');
        if (!Array.isArray(q.objects) || q.objects.length > 32 || !q.objects.every((o) => typeof o === 'string' && o.length > 0 && o.length <= 200)) fail('task.queued', 'queuedBy.objects lists at most 32 ids');
        if (typeof q.step !== 'string' || q.step.length === 0 || q.step.length > 300) fail('task.queued', 'queuedBy.step is 1 to 300 characters');
      }
      return;
    case 'task.dequeued':
      id(r, 'task');
      oneOf(r, 'reason', ['dispatched', 'cancelled', 'superseded']);
      id(r, 'launch', true);
      id(r, 'by', true);
      if ((r.reason === 'dispatched') !== (r.launch !== null)) fail('task.dequeued', 'a dispatched task names its launch, and only then');
      if ((r.reason === 'superseded') !== (r.by !== null)) fail('task.dequeued', 'a superseded task names the task replacing it, and only then');
      return;
    case 'mission.block':
      id(r, 'mission');
      oneOf(r, 'reason', ['budget', 'resource']);
      oneOf(r, 'state', ['blocked', 'released']);
      hash(r, 'report');
      return;
    default:
      // Service events are written by the service itself and never validated as input.
      fail(String(r.kind), 'unknown or reserved record kind');
  }
}

function contracts(r: Obj): void {
  const v = r.reviews;
  if (!Array.isArray(v) || v.length > 64) fail(String(r.kind), 'reviews is malformed');
  const seen = new Set<string>();
  for (const c of v) {
    if (!isObj(c) || typeof c.review !== 'string' || c.review.length === 0) fail(String(r.kind), 'a review contract is malformed');
    if (seen.has(c.review)) fail(String(r.kind), `review ${c.review} appears twice`);
    seen.add(c.review);
    strings(c, 'basisLines', 1000);
    strings(c, 'reliesOn', 1000);
  }
}
