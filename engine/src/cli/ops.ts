// Operation ids for state-changing commands (design 3.11 principle 3: the PM's choice per a WI is a record with an
// operation id, open to review; 6.1 business identity and transport identity).
//
// Every state-changing command takes `--op <id>` or generates one, prints it, and
// records the PM's action in the CLI's operation journal (one file per op id in the
// state directory, on a Linux filesystem). Running the same command again with the
// same op id is a retry: a finished operation answers with its recorded result and
// does nothing; an operation that was interrupted runs again, and every engine call
// it makes carries ids derived from the op id, so the engine deduplicates them. The
// same op id with other arguments is refused (OP_CONFLICT).
//
// The journal is the CLI's record; the ledger has no record kind for a PM action yet
// (reported upstream: a `pm.action` record appended through the service).

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../common/hash.ts';
import { writeFileAtomic } from '../common/fsx.ts';
import { CliError, EXIT } from './errors.ts';

const OP_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/;

export function newOpId(command: string, now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const cmd = command.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'op';
  return `${cmd}-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function checkOpId(op: string): string {
  if (!OP_RE.test(op)) throw new CliError('USAGE', `operation id ${JSON.stringify(op)} is malformed (starts with a letter or digit; only A-Z a-z 0-9 . _ : @ -; at most 120 characters)`, { exitCode: EXIT.USAGE });
  return op;
}

/** A sub-id for one engine call of an operation (stable across retries of the same op). */
export function subOp(op: string, part: string): string {
  return `${op}:${part}`;
}

/** A short stable hash of a string, for ids that must fit the engine's id patterns. */
export function shortHash(s: string, n = 16): string {
  return createHash('sha256').update(s).digest('hex').slice(0, n);
}

export interface OpRecord {
  readonly format: 'mp4.cli-op.v1';
  readonly op: string;
  readonly command: string;
  readonly argsHash: string;
  readonly args: unknown;
  /** The WI this action answers (3.11), if any. */
  readonly wi: string | null;
  readonly state: 'started' | 'done' | 'failed';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly result: unknown;
}

export class OpJournal {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, 'cli', 'ops');
  }

  private file(op: string): string {
    return join(this.dir, `${shortHash(op, 40)}.json`);
  }

  get(op: string): OpRecord | null {
    try {
      const r = JSON.parse(readFileSync(this.file(op), 'utf8')) as OpRecord;
      return r.format === 'mp4.cli-op.v1' && r.op === op ? r : null;
    } catch {
      return null;
    }
  }

  private put(r: OpRecord): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file(r.op), `${JSON.stringify(r)}\n`);
  }

  /**
   * Start (or retry) an operation. Returns the recorded result of a finished one
   * (`replay`), or null when the caller should run it. Throws OP_CONFLICT when
   * the op id was used with other arguments.
   */
  begin(op: string, command: string, args: unknown, wi: string | null = null, now: number = Date.now()): { replay: OpRecord | null } {
    const argsHash = shortHash(canonicalJson({ command, args: args ?? null }), 64);
    const prior = this.get(op);
    if (prior !== null) {
      if (prior.command !== command || prior.argsHash !== argsHash) {
        throw new CliError('OP_CONFLICT', `operation id ${op} was already used for another command or other arguments (${prior.command}); use a new operation id, or retry with the original arguments`, {
          exitCode: EXIT.OP_CONFLICT,
          detail: { prior: { command: prior.command, args: prior.args, state: prior.state } },
        });
      }
      if (prior.state === 'done') return { replay: prior };
    }
    this.put({ format: 'mp4.cli-op.v1', op, command, argsHash, args: args ?? null, wi, state: 'started', startedAt: prior?.startedAt ?? now, endedAt: null, result: null });
    return { replay: null };
  }

  finish(op: string, state: 'done' | 'failed', result: unknown, now: number = Date.now()): void {
    const prior = this.get(op);
    if (prior === null) return;
    this.put({ ...prior, state, endedAt: now, result: result ?? null });
  }

  /** Every recorded operation, newest first (for review). */
  list(limit = 50): OpRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: OpRecord[] = [];
    for (const n of names) {
      try {
        const r = JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as OpRecord;
        if (r.format === 'mp4.cli-op.v1') out.push(r);
      } catch {
        /* torn: skipped */
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }
}
