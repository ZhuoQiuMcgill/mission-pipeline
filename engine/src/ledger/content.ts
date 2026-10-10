// Content store: content-addressed, append-only, written outside the ledger
// service's serial queue (6.1). Files live under <root>/<aa>/<bb>/<sha256>.
// The two-level directories are created once at init, so storing an object never
// creates a directory (6.5).
//
// Durability of the layout (core review r2 F15): the root chain is created level
// by level with each new level's parent fsynced; each level-1 directory is
// fsynced after its 256 children exist, the root after its 256 children exist.
// A marker written last says the layout is complete; a crash in the middle of
// init leaves no marker, and the next init finishes the job.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../common/hash.ts';
import { fsyncDir, writeFileAtomic } from '../common/fsx.ts';
import type { ContentHash } from '../common/ids.ts';
import type { ListRef } from '../common/records.ts';
import { mkdirDurable, type FsyncDir } from './durable.ts';

const LAYOUT_MARKER = '.layout-v1';

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function mkdirIfMissing(dir: string): void {
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

export class ContentStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Create the fan-out directories durably. Idempotent; a completed layout is not walked again. */
  init(fsync: FsyncDir = fsyncDir): void {
    if (existsSync(join(this.root, LAYOUT_MARKER))) return;
    mkdirDurable(this.root, fsync);
    for (let a = 0; a < 256; a++) {
      const da = join(this.root, hex2(a));
      mkdirIfMissing(da);
      for (let b = 0; b < 256; b++) mkdirIfMissing(join(da, hex2(b)));
      fsync(da);
    }
    fsync(this.root);
    fsync(dirname(this.root));
    writeFileAtomic(join(this.root, LAYOUT_MARKER), 'content-store layout v1\n');
  }

  path(hash: ContentHash): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  has(hash: ContentHash): boolean {
    return existsSync(this.path(hash));
  }

  put(data: string | Uint8Array): ContentHash {
    const hash = sha256(data);
    const p = this.path(hash);
    if (existsSync(p)) return hash;
    try {
      writeFileAtomic(p, data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirDurable(dirname(p)); // a fan-out directory went missing: recreate it durably
      writeFileAtomic(p, data);
    }
    return hash;
  }

  /** put() without blocking the event loop on the disk (used before a request enters the serial queue). */
  async putAsync(data: string | Uint8Array): Promise<ContentHash> {
    const hash = sha256(data);
    const p = this.path(hash);
    try {
      await stat(p);
      return hash;
    } catch {
      /* not there yet */
    }
    try {
      await writeFileAtomicAsync(p, data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirDurable(dirname(p));
      await writeFileAtomicAsync(p, data);
    }
    return hash;
  }

  get(hash: ContentHash): Buffer {
    const buf = readFileSync(this.path(hash));
    if (sha256(buf) !== hash) throw new Error(`content store corruption: ${hash}`);
    return buf;
  }

  /** Store an id list (dependency lists, evidence lists...). */
  putList(items: readonly string[]): ListRef {
    return { hash: this.put(JSON.stringify(items)), count: items.length };
  }

  getList(ref: ListRef): string[] {
    const items: unknown = JSON.parse(this.get(ref.hash).toString('utf8'));
    if (!Array.isArray(items) || items.length !== ref.count || !items.every((x) => typeof x === 'string')) {
      throw new Error(`list ${ref.hash} does not match its reference`);
    }
    return items as string[];
  }
}

/** The asynchronous twin of writeFileAtomic: tmp file, fsync, rename, directory fsync. */
async function writeFileAtomicAsync(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fh.close();
  await rename(tmp, path);
  const dh = await open(dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}
