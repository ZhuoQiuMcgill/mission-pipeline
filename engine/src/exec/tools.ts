// The program tools of a seat (design 7.1 "一切能力都是程序工具"): read file, list directory,
// search content, write file, edit by exact string replacement, run command. Every one
// executes inside the seat's tool sandbox (sandbox.ts); none touches a host path directly.
//
// Path rules, checked here lexically and again inside the sandbox after resolving symlinks:
//  - every path is inside the snapshot (relative to its root, or absolute under the mount point);
//  - write and edit only on the card's writable paths.
// Output caps: every result the seat sees is capped and marked with the original length.
// Export (7.1 "导出规则"): metered by logical length and file count first; over the card's
// export cap, the whole export is refused and nothing is written.

import { posix } from 'node:path';
import { id } from '../common/ids.ts';
import type { RunId, RunLayerRecord, RunStatus } from './acceptance.ts';
import { capText, truncationMarker, type CappedText } from './caps.ts';
import type { ExitStatus, LayerLimits } from './cgroup.ts';
import type { AgentReply, AgentRequest } from './agent.ts';
import type { ContentStore } from '../ledger/content.ts';
import { REFUSED_EXPORT_NAMES, exportAreas, exportToStore, meterAreas, type ExportBudget, type ExportCaps, type ExportMeter, type ExportOutcome, type StoreTreeOutcome } from './export.ts';
import type { ToolSandbox } from './sandbox.ts';

export type { ExportCaps, ExportEntry, ExportManifest, ExportMeter, ExportOutcome } from './export.ts';

export type ToolErrorCode =
  | 'invalid-argument'
  | 'outside-snapshot'
  | 'not-writable'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-directory'
  | 'symlink'
  | 'read-only'
  | 'no-space'
  | 'permission-denied'
  | 'no-match'
  | 'not-unique'
  | 'binary'
  | 'too-large'
  | 'timeout'
  | 'sandbox-error';

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
}

export type ToolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolError };

export interface ToolPolicy {
  /** Cap of every text a seat gets back from one call (7.1). */
  readonly outputCapBytes: number;
  readonly listCapEntries: number;
  readonly searchCapMatches: number;
  readonly searchMaxFileBytes: number;
  readonly searchMaxFiles: number;
  readonly searchMaxLineBytes: number;
  readonly editMaxBytes: number;
  readonly fileToolTimeoutMs: number;
  readonly runTimeoutMs: number;
  /** Each run's declared peak (6.2): its run layer's limits. */
  readonly runLimits: LayerLimits;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  outputCapBytes: 64 * 1024,
  listCapEntries: 1000,
  searchCapMatches: 200,
  searchMaxFileBytes: 1 << 20,
  searchMaxFiles: 20_000,
  searchMaxLineBytes: 500,
  editMaxBytes: 4 << 20,
  fileToolTimeoutMs: 30_000,
  runTimeoutMs: 600_000,
  runLimits: { memoryMax: 512 * 1024 * 1024, pidsMax: 512 },
};

// ---------------------------------------------------------------- path rules

export type ResolvedPath = { readonly ok: true; readonly abs: string; readonly rel: string } | { readonly ok: false; readonly error: ToolError };

/** A seat path, relative to the snapshot root or absolute under the mount point, normalized; never outside. */
export function resolveSeatPath(input: unknown, mountPoint: string): ResolvedPath {
  if (typeof input !== 'string' || input === '' || input.includes('\0')) {
    return { ok: false, error: { code: 'invalid-argument', message: `bad path ${JSON.stringify(input)}` } };
  }
  let abs = posix.normalize(posix.isAbsolute(input) ? input : posix.join(mountPoint, input));
  if (abs.length > 1 && abs.endsWith('/')) abs = abs.slice(0, -1);
  if (abs !== mountPoint && !abs.startsWith(`${mountPoint}/`)) {
    return { ok: false, error: { code: 'outside-snapshot', message: `${input} is outside the snapshot (${mountPoint})` } };
  }
  return { ok: true, abs, rel: abs === mountPoint ? '.' : abs.slice(mountPoint.length + 1) };
}

/** A snapshot-relative path is writable when it is a card writable path or lies under one. */
export function isWritableRel(rel: string, writable: readonly string[]): boolean {
  return writable.some((w) => w === '.' || rel === w || rel.startsWith(`${w}/`));
}

// ---------------------------------------------------------------- results

export interface ReadFileValue {
  readonly path: string;
  readonly size: number;
  readonly offset: number;
  readonly encoding: 'utf8' | 'base64';
  /** The content, capped; when cut, the marker gives the file's full length. */
  readonly content: CappedText;
}

export interface ListEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'symlink' | 'other';
  readonly size: number;
  readonly target?: string;
}

export interface ListValue {
  readonly path: string;
  readonly entries: readonly ListEntry[];
  readonly total: number;
  readonly truncated: boolean;
  readonly text: CappedText;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchValue {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly skippedLarge: number;
  readonly skippedBinary: number;
  readonly text: CappedText;
}

export interface WriteValue {
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
}

export interface EditValue {
  readonly path: string;
  readonly replacements: number;
}

export interface RunValue {
  readonly run: RunId;
  readonly status: RunStatus;
  readonly exit: ExitStatus;
  readonly stdout: CappedText;
  readonly stderr: CappedText;
  readonly durationMs: number;
  /** false when the run exceeded its peak or failed for environment reasons: its output is not evidence (6.2). */
  readonly evidenceEligible: boolean;
  readonly layer: RunLayerRecord | null;
}

const AGENT_CODES: ReadonlySet<string> = new Set<ToolErrorCode>([
  'invalid-argument',
  'outside-snapshot',
  'not-writable',
  'not-found',
  'not-a-file',
  'not-a-directory',
  'symlink',
  'read-only',
  'no-space',
  'permission-denied',
  'no-match',
  'not-unique',
  'binary',
  'too-large',
]);

function fail<T>(code: ToolErrorCode, message: string): ToolResult<T> {
  return { ok: false, error: { code, message } };
}

function fromReply<T>(reply: AgentReply): ToolResult<T> {
  if (reply.ok) return { ok: true, value: reply.result as T };
  const code = AGENT_CODES.has(reply.error.code) ? (reply.error.code as ToolErrorCode) : 'sandbox-error';
  return { ok: false, error: { code, message: reply.error.message } };
}

// ---------------------------------------------------------------- the tools

export class ProgramTools {
  private readonly sandbox: ToolSandbox;
  private readonly policy: ToolPolicy;
  private readonly runPrefix: string;
  private runSeq = 0;

  constructor(sandbox: ToolSandbox, policy: ToolPolicy = DEFAULT_TOOL_POLICY, opts: { readonly runPrefix?: string } = {}) {
    this.sandbox = sandbox;
    this.policy = policy;
    this.runPrefix = opts.runPrefix ?? 'run';
  }

  private async agent<T>(req: AgentRequest): Promise<ToolResult<T>> {
    try {
      const reply = await this.sandbox.callAgent(req, {
        timeoutMs: this.policy.fileToolTimeoutMs,
        maxResponseBytes: 4 * this.policy.outputCapBytes + (1 << 20),
      });
      return fromReply<T>(reply);
    } catch (e) {
      const msg = (e as Error).message;
      return fail(/timed out/.test(msg) ? 'timeout' : 'sandbox-error', msg);
    }
  }

  private writableTarget(path: unknown): ResolvedPath {
    const r = resolveSeatPath(path, this.sandbox.mountPoint);
    if (!r.ok) return r;
    if (!isWritableRel(r.rel, this.sandbox.writableRels)) {
      return { ok: false, error: { code: 'not-writable', message: `${r.rel} is not on the card's writable paths (${this.sandbox.writableRels.join(', ')})` } };
    }
    return r;
  }

  async readFile(args: { readonly path: string; readonly offset?: number }): Promise<ToolResult<ReadFileValue>> {
    const r = resolveSeatPath(args.path, this.sandbox.mountPoint);
    if (!r.ok) return r;
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) return fail('invalid-argument', `bad offset ${offset}`);
    const res = await this.agent<{ size: number; offset: number; bytes: number; truncated: boolean; encoding: 'utf8' | 'base64'; content: string }>({
      op: 'read',
      path: r.abs,
      offset,
      maxBytes: this.policy.outputCapBytes,
    });
    if (!res.ok) return res;
    const v = res.value;
    const content: CappedText = v.truncated
      ? { text: `${v.content}\n${truncationMarker(v.size)}`, truncated: true, originalBytes: v.size }
      : { text: v.content, truncated: false, originalBytes: v.size };
    return { ok: true, value: { path: r.rel, size: v.size, offset: v.offset, encoding: v.encoding, content } };
  }

  async listDirectory(args: { readonly path?: string }): Promise<ToolResult<ListValue>> {
    const r = resolveSeatPath(args.path ?? '.', this.sandbox.mountPoint);
    if (!r.ok) return r;
    const res = await this.agent<{ total: number; truncated: boolean; entries: ListEntry[] }>({
      op: 'list',
      path: r.abs,
      maxEntries: this.policy.listCapEntries,
    });
    if (!res.ok) return res;
    const { entries, total, truncated } = res.value;
    const lines = entries.map((e) =>
      e.kind === 'dir' ? `${e.name}/` : e.kind === 'symlink' ? `${e.name} -> ${e.target ?? ''}` : `${e.name}\t${e.size}`,
    );
    if (truncated) lines.push(`[listing truncated: ${entries.length} of ${total} entries]`);
    return { ok: true, value: { path: r.rel, entries, total, truncated, text: capText(lines.join('\n'), this.policy.outputCapBytes) } };
  }

  async searchContent(args: {
    readonly pattern: string;
    readonly path?: string;
    readonly regex?: boolean;
    readonly ignoreCase?: boolean;
  }): Promise<ToolResult<SearchValue>> {
    if (typeof args.pattern !== 'string' || args.pattern === '') return fail('invalid-argument', 'empty pattern');
    const r = resolveSeatPath(args.path ?? '.', this.sandbox.mountPoint);
    if (!r.ok) return r;
    const res = await this.agent<Omit<SearchValue, 'text'>>({
      op: 'search',
      path: r.abs,
      pattern: args.pattern,
      regex: args.regex ?? false,
      ignoreCase: args.ignoreCase ?? false,
      maxMatches: this.policy.searchCapMatches,
      maxLineBytes: this.policy.searchMaxLineBytes,
      maxFileBytes: this.policy.searchMaxFileBytes,
      maxFiles: this.policy.searchMaxFiles,
    });
    if (!res.ok) return res;
    const v = res.value;
    const lines = v.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
    if (v.truncated) lines.push(`[search truncated after ${v.matches.length} matches in ${v.filesScanned} files]`);
    return { ok: true, value: { ...v, text: capText(lines.join('\n'), this.policy.outputCapBytes) } };
  }

  async writeFile(args: { readonly path: string; readonly content: string }): Promise<ToolResult<WriteValue>> {
    if (typeof args.content !== 'string') return fail('invalid-argument', 'content must be a string');
    const r = this.writableTarget(args.path);
    if (!r.ok) return r;
    const res = await this.agent<WriteValue>({ op: 'write', path: r.abs, content: args.content, createParents: true });
    if (!res.ok) return res;
    return { ok: true, value: { ...res.value, path: r.rel } };
  }

  async editFile(args: {
    readonly path: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll?: boolean;
  }): Promise<ToolResult<EditValue>> {
    if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
      return fail('invalid-argument', 'oldString and newString must be strings');
    }
    const r = this.writableTarget(args.path);
    if (!r.ok) return r;
    const res = await this.agent<EditValue>({
      op: 'edit',
      path: r.abs,
      oldString: args.oldString,
      newString: args.newString,
      replaceAll: args.replaceAll ?? false,
      maxBytes: this.policy.editMaxBytes,
    });
    if (!res.ok) return res;
    return { ok: true, value: { ...res.value, path: r.rel } };
  }

  async runCommand(args: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number }): Promise<ToolResult<RunValue>> {
    if (typeof args.command !== 'string' || args.command.trim() === '') return fail('invalid-argument', 'empty command');
    const r = resolveSeatPath(args.cwd ?? '.', this.sandbox.mountPoint);
    if (!r.ok) return r;
    const timeoutMs = Math.min(args.timeoutMs ?? this.policy.runTimeoutMs, this.policy.runTimeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return fail('invalid-argument', `bad timeout ${args.timeoutMs}`);
    this.runSeq++;
    const run = id<RunId>(`${this.runPrefix}-${this.runSeq}`);
    try {
      const res = await this.sandbox.runCommand({
        run,
        command: args.command,
        cwd: r.abs,
        timeoutMs,
        outputCapBytes: this.policy.outputCapBytes,
        limits: this.policy.runLimits,
      });
      return {
        ok: true,
        value: {
          run,
          status: res.status,
          exit: res.exit,
          stdout: res.stdout,
          stderr: res.stderr,
          durationMs: res.durationMs,
          evidenceEligible: res.status === 'completed',
          layer: res.layer,
        },
      };
    } catch (e) {
      return fail('sandbox-error', (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------- export

/** Meters the card writable paths (logical length and entry count) without exporting anything. */
export function meterWritable(sandbox: ToolSandbox, timeoutMs = 120_000): Promise<ExportMeter> {
  return meterAreas(sandbox, { timeoutMs, refuseNames: REFUSED_EXPORT_NAMES });
}

/**
 * Takes the content of the card writable paths out into `dest` (a new host directory).
 * Metered first; over either cap the whole export is refused before anything is written.
 */
export function exportWritable(sandbox: ToolSandbox, dest: string, caps: ExportCaps, timeoutMs = 600_000): Promise<ExportOutcome> {
  return exportAreas(sandbox, dest, caps, { timeoutMs, refuseNames: REFUSED_EXPORT_NAMES });
}

/**
 * 7.1, 6.5: the card writable paths streamed into the content store as a tree, within the
 * launch's export budget; over it, the whole export is refused before anything is stored.
 */
export function storeWritable(sandbox: ToolSandbox, content: ContentStore, budget: ExportBudget, tempPath: string, timeoutMs = 600_000): Promise<StoreTreeOutcome> {
  return exportToStore(sandbox, content, budget, { mode: 'whole', tempPath, timeoutMs, refuseNames: REFUSED_EXPORT_NAMES });
}
