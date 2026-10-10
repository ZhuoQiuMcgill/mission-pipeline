// Runs the in-sandbox file-tool agent (fs-agent.ts) for one call: nsenter into an area
// holder, then a fresh nested bubblewrap whose root holds only this program's node runtime
// (host libraries, read-only), the agent file, fresh /dev and /proc, and the caller's view
// (a snapshot, writable areas, a session state). No network, no further user namespaces,
// cleared environment, root and /dev read-only.

import { spawn } from 'node:child_process';
import { copyFileSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadCollector } from './caps.ts';
import { processEnd, type ExitStatus } from './cgroup.ts';
import { HELPER_ENV, ISOLATION, SandboxError, killGroup, settleWithin, type AreaHolder } from './holder.ts';

const AGENT_SOURCE = fileURLToPath(new URL('./fs-agent.ts', import.meta.url));
const AGENT_IN_SANDBOX = '/.mp/fs-agent.mts';
const NODE_IN_SANDBOX = '/.mp/node';

export type AgentRequest =
  | { readonly op: 'read'; readonly path: string; readonly offset: number; readonly maxBytes: number }
  | { readonly op: 'list'; readonly path: string; readonly maxEntries: number }
  | {
      readonly op: 'search';
      readonly path: string;
      readonly pattern: string;
      readonly regex: boolean;
      readonly ignoreCase: boolean;
      readonly maxMatches: number;
      readonly maxLineBytes: number;
      readonly maxFileBytes: number;
      readonly maxFiles: number;
    }
  | { readonly op: 'write'; readonly path: string; readonly content: string; readonly createParents: boolean }
  | {
      readonly op: 'edit';
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
      readonly replaceAll: boolean;
      readonly maxBytes: number;
    }
  /** Entries named in `exclude` (anywhere in the tree) are skipped and counted apart; names in `flag` are reported. */
  | { readonly op: 'meter'; readonly exclude: readonly string[]; readonly flag?: readonly string[] };

export interface ExportRequest {
  readonly op: 'export';
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly exclude: readonly string[];
  /** An entry with one of these names aborts the export. */
  readonly flag?: readonly string[];
}

export type AgentReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Frames of the agent's export stream (see fs-agent.ts). */
export type ExportFrame =
  | { readonly k: 'dir'; readonly p: string; readonly mode: number }
  | { readonly k: 'file'; readonly p: string; readonly mode: number; readonly size: number }
  | { readonly k: 'symlink'; readonly p: string; readonly target: string }
  | { readonly k: 'skip'; readonly p: string; readonly type: string }
  | { readonly k: 'end'; readonly bytes: number; readonly entries: number }
  | { readonly k: 'abort'; readonly reason: string; readonly bytes: number; readonly entries: number }
  | { readonly k: 'error'; readonly code: string; readonly message: string };

export interface ExportSink {
  frame(f: ExportFrame): void;
  data(chunk: Buffer): void;
  fileEnd(): void;
}

/** Whatever can run agent calls: a tool sandbox, a Claude Code enclosure. */
export interface AgentHost {
  callAgent(req: AgentRequest, opts: { readonly timeoutMs: number; readonly maxResponseBytes: number }): Promise<AgentReply>;
  exportStream(req: ExportRequest, sink: ExportSink, timeoutMs: number): Promise<void>;
}

/** What the agent sees besides its runtime, and where requests may point. */
export interface AgentView {
  /** bubblewrap mount arguments (binds of snapshot and areas). */
  readonly mounts: readonly string[];
  /** Every request path must be under this sandbox path. */
  readonly root: string;
  /** Sandbox paths where write and edit are allowed; also the roots meter and export cover. */
  readonly writable: readonly { readonly path: string; readonly kind: 'dir' | 'file' }[];
}

/** Copies the agent into a session directory (pinning its version for the session); returns the copy. */
export function installAgent(sessionDir: string): string {
  const copy = join(sessionDir, 'fs-agent.mts');
  copyFileSync(AGENT_SOURCE, copy);
  return copy;
}

/**
 * The runtime the file-tool agent runs on (v34 9.3 item 10): a node binary and the host paths
 * its dynamic loader needs, bound read-only at the same paths (symlinks recreated). Set in the
 * installation config; the default fits Debian, Ubuntu and similar layouts. Agent sandboxes
 * only: a command never sees it.
 */
export interface AgentRuntime {
  readonly node: string;
  readonly libraryPaths: readonly string[];
}

export const DEFAULT_LIBRARY_PATHS: readonly string[] = ['/usr', '/lib', '/lib32', '/lib64', '/libx32', '/etc/ld.so.cache'];

export function defaultAgentRuntime(): AgentRuntime {
  return { node: realpathSync(process.execPath), libraryPaths: DEFAULT_LIBRARY_PATHS };
}

function runtimeArgs(rt: AgentRuntime): string[] {
  const out: string[] = [];
  for (const d of rt.libraryPaths) {
    if (!isAbsolute(d)) throw new SandboxError(`runtime library path ${d} is not absolute`);
    let st;
    try {
      st = lstatSync(d);
    } catch {
      continue; // optional on this system
    }
    if (st.isSymbolicLink()) out.push('--symlink', readlinkSync(d), d);
    else if (st.isDirectory() || st.isFile()) out.push('--ro-bind', d, d);
  }
  return out;
}

/** Incremental parser of the export stream: JSON header lines, raw bytes after "file" headers. */
export class FrameParser {
  private readonly sink: ExportSink;
  private buf: Buffer = Buffer.alloc(0);
  private remaining = 0;
  finished = false;

  constructor(sink: ExportSink) {
    this.sink = sink;
  }

  push(chunk: Buffer): void {
    let c = chunk;
    while (c.length > 0) {
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, c.length);
        this.sink.data(c.subarray(0, n));
        this.remaining -= n;
        c = c.subarray(n);
        if (this.remaining === 0) this.sink.fileEnd();
        continue;
      }
      const nl = c.indexOf(0x0a);
      if (nl === -1) {
        this.buf = Buffer.concat([this.buf, c]);
        if (this.buf.length > 1 << 20) throw new SandboxError('export header line too long');
        return;
      }
      const line = Buffer.concat([this.buf, c.subarray(0, nl)]).toString('utf8');
      this.buf = Buffer.alloc(0);
      c = c.subarray(nl + 1);
      const f = JSON.parse(line) as ExportFrame;
      this.sink.frame(f);
      if (f.k === 'file') {
        this.remaining = f.size;
        if (f.size === 0) this.sink.fileEnd();
      } else if (f.k === 'end' || f.k === 'abort' || f.k === 'error') {
        this.finished = true;
      }
    }
  }
}

export class AgentRunner {
  private readonly holder: AreaHolder;
  private readonly runtime: AgentRuntime;
  private readonly agentCopy: string;
  private readonly view: AgentView;

  constructor(holder: AreaHolder, runtime: AgentRuntime, agentCopy: string, view: AgentView) {
    this.holder = holder;
    this.runtime = runtime;
    this.agentCopy = agentCopy;
    this.view = view;
  }

  argv(): string[] {
    return [
      ...this.holder.enterBwrap(),
      ...ISOLATION,
      '--clearenv',
      ...runtimeArgs(this.runtime),
      '--ro-bind',
      this.runtime.node,
      NODE_IN_SANDBOX,
      '--ro-bind',
      this.agentCopy,
      AGENT_IN_SANDBOX,
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...this.view.mounts,
      '--remount-ro',
      '/dev',
      '--remount-ro',
      '/',
      '--chdir',
      this.view.root,
      '--',
      NODE_IN_SANDBOX,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--max-old-space-size=512',
      AGENT_IN_SANDBOX,
    ];
  }

  async call(req: AgentRequest, opts: { readonly timeoutMs: number; readonly maxResponseBytes: number }): Promise<AgentReply> {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const errs = new HeadCollector(16 * 1024);
    const end = await this.spawn(
      req,
      (c) => {
        size += c.length;
        if (size > opts.maxResponseBytes) overflow = true;
        else chunks.push(c);
      },
      (c) => errs.push(c),
      opts.timeoutMs,
    );
    if (end.timedOut) throw new SandboxError(`file tool timed out after ${opts.timeoutMs} ms`);
    if (overflow) throw new SandboxError(`file tool answer exceeded ${opts.maxResponseBytes} bytes`);
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text) as AgentReply;
    } catch {
      throw new SandboxError(`file tool failed (${end.status.code ?? end.status.signal}): ${errs.result().text.trim() || text.slice(0, 500)}`);
    }
  }

  async stream(req: ExportRequest, sink: ExportSink, timeoutMs: number): Promise<void> {
    const parser = new FrameParser(sink);
    const errs = new HeadCollector(16 * 1024);
    let failure: unknown = null;
    const end = await this.spawn(
      req,
      (c) => {
        if (failure !== null) return;
        try {
          parser.push(c);
        } catch (e) {
          failure = e;
        }
      },
      (c) => errs.push(c),
      timeoutMs,
    );
    if (failure !== null) throw failure;
    if (end.timedOut) throw new SandboxError(`export timed out after ${timeoutMs} ms`);
    if (!parser.finished) {
      throw new SandboxError(`export stream ended early (${end.status.code ?? end.status.signal}): ${errs.result().text.trim()}`);
    }
  }

  private async spawn(
    req: AgentRequest | ExportRequest,
    onOut: (c: Buffer) => void,
    onErr: (c: Buffer) => void,
    timeoutMs: number,
  ): Promise<{ status: ExitStatus; timedOut: boolean }> {
    const argv = this.argv();
    const child = spawn(argv[0] as string, argv.slice(1), { env: { ...HELPER_ENV }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const ended = processEnd(child);
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify({ root: this.view.root, writable: this.view.writable, req }));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    const end = await ended;
    clearTimeout(timer);
    await settleWithin(closed, 5_000);
    if (end.error !== null) throw new SandboxError(`cannot start the file tool: ${end.error.message}`);
    return { status: end.status, timedOut };
  }
}
