// Frozen toolchain copies (design 7.2: an environment is a read-only copy the program controls,
// never a live user directory; W3, release review r2). At `mp install`, each accepted toolchain
// tree (src/exec/sandbox.ts detectToolchain: a node or python distribution tree) is copied
// under the engine root, <root>/environments/<tool>-<manifest hash>/:
//   tree/          what the tool needs to run; every file read-only (a-w); directories stay
//                  owner-writable only so the engine root can still be removed (rm -rf); inside
//                  the sandboxes the whole copy is a read-only mount
//                    node:   bin/, include/, lib/ (of lib/node_modules only npm and corepack)
//                    python: bin/, include/, lib/, lib64, pyvenv.cfg
//   manifest.json  every entry (path, type, mode, size, content hash or link target) and the
//                  manifest hash; the marker a mount checks
// Left out while copying, at any depth: .npmrc, npmrc, .netrc, .git-credentials, .pypirc,
// pip.conf, *credential*, .ssh, .gnupg (and .claude, .config, .aws, .kube, keyrings); anything
// that is not a regular file, a directory or a link; links that point outside the tree (except
// into the system directories, which the sandbox binds anyway, or into another frozen tree's
// source). The sandboxes mount tree/ read-only AT THE TOOL'S ORIGINAL PATH (shebangs and absolute
// paths keep working); the live path is never mounted, so a change to it after install (a key
// dropped in, a directory swapped for a link) reaches no sandbox. Re-running `mp install`
// refreshes the copy; an upgraded live toolchain is not seen until then.
//
// Threat boundary: the copy is program-owned and read-only, which protects it against seat code
// and the commands seats run (they never see the engine root). It does not protect against other
// processes of the same user, who could change the engine root (and so the program) anyway.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { toolchainLayout, type Toolchain } from './sandbox.ts';

export const FROZEN_FORMAT = 'mp4.frozen-toolchain.v1';
/** A tree over this many bytes is not frozen (skipped with the reason; the system tools still work). */
export const FREEZE_MAX_BYTES = 2 * 1024 ** 3;

export interface FrozenTree {
  readonly tool: 'node' | 'python';
  /** The live tree it was copied from: where it is mounted inside the sandboxes. */
  readonly source: string;
  /** The read-only copy (…/<tool>-<hash>/tree): what is mounted. */
  readonly copy: string;
  /** The manifest hash (sha256 of the entry list), also in <copy>/../manifest.json. */
  readonly manifest: string;
  /** `<bin> --version` of the live tool at freeze time. */
  readonly version: string | null;
  readonly files: number;
  readonly bytes: number;
  /** Entries left out (credential-like names, links leaving the tree, other file types), relative. */
  readonly leftOut: readonly string[];
}

export interface FreezeResult {
  readonly trees: readonly FrozenTree[];
  readonly skipped: readonly { readonly source: string; readonly reason: string }[];
}

const SECRET = /^(\.npmrc|npmrc|\.netrc|\.git-credentials|\.pypirc|pip\.conf|\.ssh|\.gnupg|\.claude|\.config|\.aws|\.kube|keyrings)$/;
const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`);

/** What of a tree is copied: top-level names, and for node only npm and corepack of lib/node_modules. */
function selected(tool: 'node' | 'python', rel: string): boolean {
  const parts = rel.split('/');
  const top = parts[0] as string;
  if (tool === 'node') {
    if (!['bin', 'include', 'lib'].includes(top)) return false;
    if (parts[0] === 'lib' && parts[1] === 'node_modules' && parts.length >= 3) return parts[2] === 'npm' || parts[2] === 'corepack';
    return true;
  }
  return ['bin', 'include', 'lib', 'lib64', 'pyvenv.cfg'].includes(top);
}

interface Entry {
  readonly p: string;
  readonly t: 'd' | 'f' | 'l';
  readonly m: number;
  readonly s?: number;
  readonly h?: string;
  readonly l?: string;
}

function copyFileHashed(src: string, dst: string, mode: number): { readonly hash: string; readonly size: number } {
  const h = createHash('sha256');
  const inFd = openSync(src, 'r');
  let size = 0;
  try {
    if (!fstatSync(inFd).isFile()) throw new Error(`${src} is not a regular file`);
    const outFd = openSync(dst, 'wx', 0o600);
    try {
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const n = readSync(inFd, buf, 0, buf.length, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
        let off = 0;
        while (off < n) off += writeSync(outFd, buf, off, n - off);
        size += n;
      }
    } finally {
      closeSync(outFd);
    }
  } finally {
    closeSync(inFd);
  }
  chmodSync(dst, mode & 0o555);
  return { hash: h.digest('hex'), size };
}

/** Makes a copy writable again (to remove it). */
function unfreeze(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const n of readdirSync(dir)) unfreeze(join(dir, n));
}

export function removeFrozen(dir: string): void {
  unfreeze(dir);
  rmSync(dir, { recursive: true, force: true });
}

function versionOf(source: string, tool: 'node' | 'python'): string | null {
  const bin = tool === 'node' ? join(source, 'bin', 'node') : ['python3', 'python'].map((n) => join(source, 'bin', n)).find((p) => existsSync(p));
  if (bin === undefined) return null;
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().slice(0, 100) || null;
  } catch {
    return null;
  }
}

/**
 * Copies one distribution tree into `envRoot` (see the header). `alsoAllowed`: other trees'
 * sources links may point into. Returns the frozen tree, or why it was not frozen.
 */
export function freezeTree(source: string, envRoot: string, o: { readonly maxBytes?: number; readonly alsoAllowed?: readonly string[] } = {}): FrozenTree | { readonly skipped: string } {
  const layout = toolchainLayout(source);
  if (layout === null) return { skipped: `${source} is not a node or python distribution tree` };
  const maxBytes = o.maxBytes ?? FREEZE_MAX_BYTES;
  mkdirSync(envRoot, { recursive: true, mode: 0o700 });
  const work = join(envRoot, `.tmp-${randomBytes(6).toString('hex')}`);
  const tree = join(work, 'tree');
  mkdirSync(tree, { recursive: true, mode: 0o700 });
  const entries: Entry[] = [];
  const leftOut: string[] = [];
  const links: Array<{ readonly rel: string; readonly target: string }> = [];
  const dirs: string[] = [];
  let bytes = 0;
  let files = 0;
  try {
    const walk = (rel: string): void => {
      const src = rel === '' ? source : join(source, rel);
      for (const name of readdirSync(src).sort()) {
        const r = rel === '' ? name : `${rel}/${name}`;
        if (!selected(layout, r)) continue;
        if (SECRET.test(name) || /credential/i.test(name)) {
          leftOut.push(r);
          continue;
        }
        const s = join(source, r);
        const d = join(tree, r);
        const st = lstatSync(s);
        if (st.isDirectory()) {
          mkdirSync(d, { mode: 0o700 });
          entries.push({ p: r, t: 'd', m: st.mode & 0o777 });
          dirs.push(r);
          walk(r);
        } else if (st.isFile()) {
          if (bytes + st.size > maxBytes) throw new FreezeTooLarge(`${source} is over ${maxBytes} bytes`);
          const c = copyFileHashed(s, d, st.mode);
          bytes += c.size;
          files++;
          entries.push({ p: r, t: 'f', m: st.mode & 0o555, s: c.size, h: c.hash });
        } else if (st.isSymbolicLink()) {
          const target = readlinkSync(s);
          const resolved = isAbsolute(target) ? posix.normalize(target) : resolve(dirname(s), target);
          const inside = under(resolved, source);
          const allowed = inside || SYSTEM_DIRS.some((x) => under(resolved, x)) || (o.alsoAllowed ?? []).some((x) => under(resolved, x));
          if (!allowed) {
            leftOut.push(r);
            continue;
          }
          symlinkSync(target, d);
          if (inside) links.push({ rel: r, target: resolved });
          entries.push({ p: r, t: 'l', m: 0o777, l: target });
        } else {
          leftOut.push(r); // sockets, fifos, devices: never copied
        }
      }
    };
    walk('');
    // a link inside the tree must still lead somewhere inside the copy (an excluded package's bin: dropped)
    for (const k of links) {
      const inCopy = join(tree, relative(source, k.target));
      let ok = false;
      try {
        ok = existsSync(inCopy) && realpathInside(join(tree, k.rel), tree, source);
      } catch {
        ok = false;
      }
      if (!ok) {
        rmSync(join(tree, k.rel), { force: true });
        const i = entries.findIndex((e) => e.p === k.rel);
        if (i >= 0) entries.splice(i, 1);
        leftOut.push(k.rel);
      }
    }
    entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    const manifest = createHash('sha256').update(JSON.stringify({ format: FROZEN_FORMAT, tool: layout, source, entries })).digest('hex');
    const version = versionOf(source, layout);
    writeFileSync(join(work, 'manifest.json'), `${JSON.stringify({ format: FROZEN_FORMAT, tool: layout, source, manifest, version, files, bytes, leftOut, entries })}\n`, { mode: 0o400 });
    // files are read-only already (copyFileHashed); directories: no group or other write
    for (const r of [...dirs].reverse()) chmodSync(join(tree, r), 0o755);
    chmodSync(tree, 0o755);
    const final = join(envRoot, `${layout}-${manifest.slice(0, 16)}`);
    if (existsSync(final) && readFrozenManifest(join(final, 'tree'))?.manifest === manifest) {
      removeFrozen(work); // the same content is frozen already
    } else {
      if (existsSync(final)) removeFrozen(final);
      renameSync(work, final);
      chmodSync(final, 0o755);
    }
    return { tool: layout, source, copy: join(final, 'tree'), manifest, version, files, bytes, leftOut };
  } catch (e) {
    removeFrozen(work);
    if (e instanceof FreezeTooLarge) return { skipped: `${e.message}: not frozen (the system ${layout} still works)` };
    return { skipped: `${source} could not be copied: ${(e as Error).message}` };
  }
}

class FreezeTooLarge extends Error {}

/**
 * Whether a link in the copy leads to an entry of the copy: the chain is followed by hand inside
 * it, an absolute target in the live tree read as the same place in the copy (where the copy is
 * mounted, that is what it resolves to); no host path outside the copy is consulted.
 */
function realpathInside(p: string, root: string, source: string): boolean {
  let cur = p;
  for (let i = 0; i < 40; i++) {
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return false;
    }
    if (!st.isSymbolicLink()) return under(cur, root);
    const t = readlinkSync(cur);
    const next = isAbsolute(t) ? posix.normalize(t) : resolve(dirname(cur), t);
    cur = under(next, source) && !under(next, root) ? join(root, relative(source, next)) : next;
    if (!under(cur, root)) return false;
  }
  return false;
}

/** Freezes every accepted tree of a detected toolchain into `envRoot`. */
export function freezeToolchain(toolchain: Pick<Toolchain, 'dirs'>, envRoot: string, o: { readonly maxBytes?: number } = {}): FreezeResult {
  const trees: FrozenTree[] = [];
  const skipped: { source: string; reason: string }[] = [];
  for (const d of toolchain.dirs) {
    const r = freezeTree(d, envRoot, { ...o, alsoAllowed: toolchain.dirs.filter((x) => x !== d) });
    if ('skipped' in r) skipped.push({ source: d, reason: r.skipped });
    else trees.push(r);
  }
  return { trees, skipped };
}

/** The manifest of a frozen copy (…/tree), or null when it has none or it does not parse. */
export function readFrozenManifest(copy: string): { readonly manifest: string; readonly source: string; readonly tool: string; readonly version: string | null } | null {
  try {
    const m = JSON.parse(readFileSync(join(dirname(copy), 'manifest.json'), 'utf8')) as { format?: string; manifest?: string; source?: string; tool?: string; version?: string | null };
    if (m.format !== FROZEN_FORMAT || typeof m.manifest !== 'string' || typeof m.source !== 'string' || typeof m.tool !== 'string') return null;
    return { manifest: m.manifest, source: m.source, tool: m.tool, version: m.version ?? null };
  } catch {
    return null;
  }
}
