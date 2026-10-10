// Shared fixtures for the git subsystem tests. This file holds helpers only (no
// tests); it is named *.test.ts because the git tests live under test/git-*.test.ts.
//
// Fixture setup uses RAW git (child_process) with an isolated environment, so
// tests can build exact objects and reproduce hazards the engine's wrapper is
// designed to prevent. Engine code never does this: it goes through SafeGit.
// Everything lives under os.tmpdir() (a Linux filesystem), never under /mnt.

import type { GitOid } from '../src/common/ids.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOid } from '../src/git/objects.ts';
import { SafeGit, type UserGitEnvironment } from '../src/git/safeGit.ts';
import type { Generation } from '../src/common/ids.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { LedgerClient, serveLedger } from '../src/ledger/ipc.ts';
import { LedgerService, ledgerPaths, type LedgerPaths } from '../src/ledger/service.ts';

export interface Fixture {
  readonly root: string;
  /** Fake HOME for raw git and for the "user" scope of the transform description. */
  readonly home: string;
  readonly env: Record<string, string>;
  readonly git: SafeGit;
  readonly user: UserGitEnvironment;
  /** Raw git for fixture setup. Returns stdout (trimmed). Throws on failure. */
  raw(args: readonly string[], cwd: string, opts?: { input?: string | Buffer; env?: Record<string, string> }): string;
  /** Raw git, returning the exit status and output instead of throwing. */
  rawStatus(args: readonly string[], cwd: string, opts?: { env?: Record<string, string> }): { code: number; stdout: string; stderr: string };
  cleanup(): void;
}

export function makeFixture(prefix: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `mp-git-${prefix}-`)));
  const home = join(root, 'home');
  mkdirSync(home);
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_DATE: '1700000000 +0000',
  };
  const git = SafeGit.create({ stateDir: join(root, 'state') });
  const raw = (args: readonly string[], cwd: string, opts: { input?: string | Buffer; env?: Record<string, string> } = {}): string => {
    const out = execFileSync('/usr/bin/git', [...args], {
      cwd,
      env: { ...env, ...(opts.env ?? {}) },
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.toString('utf8').trim();
  };
  const rawStatus = (args: readonly string[], cwd: string, opts: { env?: Record<string, string> } = {}) => {
    const r = spawnSync('/usr/bin/git', [...args], { cwd, env: { ...env, ...(opts.env ?? {}) }, encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    root,
    home,
    env,
    git,
    user: { home },
    raw,
    rawStatus,
    cleanup(): void {
      // The safe-git state directories are read-only; make everything writable first.
      spawnSync('chmod', ['-R', 'u+w', root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type FileSpec = string | Buffer | { readonly link: string } | { readonly exec: string | Buffer } | { readonly gitlink: string };

/** Creates a repository with branch main (no commit yet). */
export function initRepo(fx: Fixture, name = 'r', extraInit: readonly string[] = []): string {
  const dir = join(fx.root, name);
  fx.raw(['init', '-q', '-b', 'main', ...extraInit, dir], fx.root);
  return dir;
}

/** Builds a commit with EXACT blob bytes (no filters, no eol conversion) through a temporary index. */
export function rawCommit(fx: Fixture, repo: string, files: Readonly<Record<string, FileSpec>>, parent: string | null, message = 'commit'): GitOid {
  const idx = join(fx.root, `idx-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: idx };
  const lines: string[] = [];
  const cache = new Map<string, string>();
  for (const [path, spec] of Object.entries(files)) {
    let mode = '100644';
    let content: string | Buffer;
    if (typeof spec === 'string' || Buffer.isBuffer(spec)) content = spec;
    else if ('link' in spec) {
      mode = '120000';
      content = spec.link;
    } else if ('exec' in spec) {
      mode = '100755';
      content = spec.exec;
    } else {
      lines.push(`160000 ${spec.gitlink}\t${path}`);
      continue;
    }
    const key = Buffer.from(content).toString('base64');
    let oid = cache.get(key);
    if (oid === undefined) {
      oid = fx.raw(['-c', 'core.hooksPath=/dev/null', 'hash-object', '-w', '--no-filters', '--stdin'], repo, { input: content });
      cache.set(key, oid);
    }
    lines.push(`${mode} ${oid}\t${path}`);
  }
  // Fixture setup never runs repository hooks (tests install hooks to prove the engine does not run them).
  const noHooks = ['-c', 'core.hooksPath=/dev/null'];
  if (lines.length > 0) fx.raw([...noHooks, 'update-index', '--add', '--index-info'], repo, { input: lines.join('\n') + '\n', env });
  else fx.raw([...noHooks, 'read-tree', '--empty'], repo, { env });
  const tree = fx.raw([...noHooks, 'write-tree'], repo, { env });
  rmSync(idx, { force: true });
  return gitOid(fx.raw([...noHooks, 'commit-tree', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message], repo));
}

/** Points main at `commit` and checks it out with git's own conversions (raw git, hooks off). */
export function checkoutMain(fx: Fixture, repo: string, commit: string): void {
  fx.raw(['update-ref', 'refs/heads/main', commit], repo);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'reset', '-q', '--hard', commit], repo);
}

export function blobOf(fx: Fixture, repo: string, commit: string, path: string): Buffer {
  return execFileSync('/usr/bin/git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: repo, env: fx.env });
}

export type TreeContent = Map<string, Buffer | { readonly link: Buffer }>;

/** Every file under `dir` (except .git), byte for byte; symlinks by target. */
export function readTreeContent(dir: string, rel = '', out: TreeContent = new Map()): TreeContent {
  for (const name of readdirSync(join(dir, rel))) {
    if (rel === '' && name === '.git') continue;
    const p = rel === '' ? name : `${rel}/${name}`;
    const abs = join(dir, p);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.set(p, { link: readlinkSync(abs, { encoding: 'buffer' }) });
    else if (st.isDirectory()) readTreeContent(dir, p, out);
    else out.set(p, readFileSync(abs));
  }
  return out;
}

export function sameTreeContent(a: TreeContent, b: TreeContent): string[] {
  const diffs: string[] = [];
  for (const [p, va] of a) {
    const vb = b.get(p);
    if (vb === undefined) diffs.push(`${p}: only in first`);
    else if (Buffer.isBuffer(va) !== Buffer.isBuffer(vb)) diffs.push(`${p}: kind differs`);
    else if (Buffer.isBuffer(va) && !va.equals(vb as Buffer)) diffs.push(`${p}: bytes differ`);
    else if (!Buffer.isBuffer(va) && !va.link.equals((vb as { link: Buffer }).link)) diffs.push(`${p}: link differs`);
  }
  for (const p of b.keys()) if (!a.has(p)) diffs.push(`${p}: only in second`);
  return diffs;
}

/** Runs fn with extra variables in process.env, restoring them afterwards. */
export async function withProcessEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

export function gitLfsAvailable(): string | null {
  for (const d of ['/usr/bin', '/usr/local/bin', '/bin']) {
    const p = join(d, 'git-lfs');
    try {
      lstatSync(p);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** A real ledger service on a Unix socket, as the engine runs it (6.1), for adapter tests. */
export interface LedgerHarness {
  readonly svc: LedgerService;
  readonly client: LedgerClient;
  readonly content: ContentStore;
  readonly paths: LedgerPaths;
  readonly gen: Generation;
  /** The ledger's IPC socket (for other processes such as the evaluator). */
  readonly socket: string;
  close(): Promise<void>;
}

export async function startLedger(root: string): Promise<LedgerHarness> {
  mkdirSync(root, { recursive: true });
  const paths = ledgerPaths(join(root, 'ledger'), join(root, 'control'));
  const svc = new LedgerService({ paths });
  svc.open();
  const sock = join(root, 'ledger.sock');
  const server = serveLedger(svc, sock);
  const client = new LedgerClient(sock, 10_000);
  const gen = (await client.call('beginGeneration', {})) as Generation;
  return {
    svc,
    client,
    content: new ContentStore(paths.content),
    paths,
    gen,
    socket: sock,
    async close(): Promise<void> {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
      svc.close();
      // A ledger's content store holds 65,536 fan-out directories: free them now, not at the end of the file.
      rmSync(root, { recursive: true, force: true });
    },
  };
}
