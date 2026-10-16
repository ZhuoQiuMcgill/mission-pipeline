import assert from 'node:assert/strict';
import type { GitOid, ObjectVersionId } from '../src/common/ids.ts';
import { startHolds, versionOrigin } from '../src/delivery/candidate.ts';
import { stackOrder, prerequisiteClosure } from '../src/delivery/manifest.ts';
import { memoryProofView } from '../src/delivery/memoryView.ts';
import { inWriteScope, writeScopeDocument } from '../src/delivery/writeScope.ts';
import type { RepoLayout, TreeEntry } from '../src/git/objects.ts';
import type { GitExec } from '../src/git/plainGit.ts';
import { compose } from '../src/process/actions.ts';
import { labelView } from '../src/process/labelView.ts';
import { FAKE_BASE, memoryPorts } from './flow-memory-fixtures.ts';

export const oid = (n: number) => n.toString(16).padStart(40, '0') as GitOid;
export const repo = { gitDir: '/unused', commonDir: '/unused' } as RepoLayout;
export const tree = (files: Record<string, number>): TreeEntry[] => Object.entries(files).map(([path, n]) => ({ path, mode: '100644', type: 'blob', oid: oid(n) }));

/** Object-level git, including raw commit parents so versionOrigin follows the actual lineage. */
export class ObjectGit {
  readonly trees = new Map<string, readonly TreeEntry[]>([[FAKE_BASE, tree({ 'index.ts': 999 })]]);
  readonly parents = new Map<string, string | null>();
  private serial = 1000;
  put(entries: readonly TreeEntry[], parent: string | null = FAKE_BASE, commit = oid(this.serial++)): GitOid {
    this.trees.set(commit, entries);
    this.parents.set(commit, parent);
    return commit as GitOid;
  }
  readonly git = { ok: async (args: readonly string[], opts?: { input?: string | Buffer }) => {
    if (args.includes('ls-tree')) {
      const entries = this.trees.get(args.at(-1)!);
      assert.ok(entries, `unknown tree ${args.at(-1)}`);
      return { stdout: Buffer.from(entries.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}\0`).join('')) };
    }
    assert.ok(args.includes('cat-file'));
    const ids = String(opts!.input).trim().split('\n');
    const raw = (id: string) => Buffer.from(`tree ${oid(900)}\n${this.parents.get(id) ? `parent ${this.parents.get(id)}\n` : ''}\nfixture\n`);
    if (args.includes('--batch-check')) return { stdout: Buffer.from(ids.map((id) => this.trees.has(id) ? `${id} commit ${raw(id).length}\n` : `${id} missing\n`).join('')) };
    assert.ok(args.includes('--batch'));
    return { stdout: Buffer.concat(ids.flatMap((id) => [Buffer.from(`${id} commit ${raw(id).length}\n`), raw(id), Buffer.from('\n')])) };
  } } as unknown as GitExec;
}

/** SQLite/labels/flow with tree placements and the production start resolver. */
export function provenancePorts() {
  const ports = memoryPorts();
  const objects = new ObjectGit();
  const recorded = new Map<string, readonly string[]>();
  const checks = new Map<string, number>();
  ports.scheduler.knobs.files = (commit) => ({ lines: (path) => objects.trees.get(commit)?.some((e) => e.path === path) ? 1 : null });
  let blob = 1;
  const view = () => memoryProofView(ports.memory, labelView(ports.ctx));
  const entries = (commit: string) => {
    const found = objects.trees.get(commit);
    assert.ok(found, `missing fixture commit ${commit}`);
    return found;
  };
  const laid = (products: readonly string[]) => {
    const manifest = compose(view(), products);
    const files = new Map<string, TreeEntry>(entries(FAKE_BASE).map((e) => [e.path, e]));
    const byId = new Map(manifest.entries.map((e) => [e.object.id, e.object]));
    const order = stackOrder([...byId.keys()], prerequisiteClosure([...byId.values()], (u) => view().unitMembers(u)));
    for (const id of order) {
      const v = byId.get(id)!;
      if (v.tree === null) continue;
      for (const path of files.keys()) if (inWriteScope(v.tree.writeScope, path)) files.delete(path);
      for (const e of entries(v.tree.commit)) if (inWriteScope(v.tree.writeScope, e.path)) files.set(e.path, e);
    }
    return { products: manifest.entries.filter((e) => e.object.kind === 'product').map((e) => e.object.id), entries: [...files.values()] };
  };
  ports.scheduler.actions = {
    async snapshot(req) {
      const next = laid(req.carry?.products ?? req.products ?? []);
      let commit = next.products.length === 0 ? FAKE_BASE as GitOid : objects.put(next.entries);
      let origin: GitOid | undefined;
      if (req.carry !== undefined) {
        const v = view().object(req.carry.version as ObjectVersionId)!;
        const from = await versionOrigin(objects.git, repo, v, (id) => view().object(id));
        const previous = req.commit!;
        const before = new Map((from === null ? [] : entries(from)).map((e) => [e.path, e]));
        const after = new Map(entries(v.tree!.commit).map((e) => [e.path, e]));
        if (JSON.stringify([...before.values()]) === JSON.stringify(next.entries)) commit = previous as GitOid;
        else {
          origin = commit;
          const files = new Map(next.entries.map((e) => [e.path, e]));
          for (const path of new Set([...before.keys(), ...after.keys()])) {
            if (!inWriteScope(v.tree!.writeScope, path) || JSON.stringify(before.get(path)) === JSON.stringify(after.get(path))) continue;
            const e = after.get(path);
            if (e === undefined) files.delete(path); else files.set(path, e);
          }
          commit = objects.put([...files.values()], origin);
        }
      }
      return { path: commit, commit, products: next.products, ...(origin !== undefined ? { origin } : {}) };
    },
    async product(req) {
      const object = `prod.${req.task}`;
      const known = await ports.ledger.objectVersion(object);
      const paths = req.writeScope.map((p) => p.endsWith('/**') ? `${p.slice(0, -3)}/index.ts` : p);
      if (known === null) {
        const files = new Map(entries(req.base).map((e) => [e.path, e]));
        for (const path of paths) files.set(path, { path, mode: '100644', type: 'blob', oid: oid(blob++) });
        objects.put([...files.values()], req.base, req.candidate as GitOid);
        await ports.ledger.append(`fixture:placed:${object}`, { records: [{
          kind: 'object.version', object: object as ObjectVersionId, objectKind: 'product', mission: req.mission, module: req.module as never,
          content: ports.memory.data.put(writeScopeDocument([...files.values()], req.writeScope)),
          prerequisites: ports.memory.data.putList(recorded.get(req.task) ?? req.prerequisites),
          scope: { paths, taskType: req.taskType }, reviews: [...req.reviews],
          source: { commit: req.candidate as GitOid, writeScope: req.writeScope, transform: ports.memory.data.put('transform'), ...(req.origin !== undefined ? { origin: req.origin as GitOid } : {}) },
          ...(req.predecessor !== null ? { predecessor: req.predecessor as ObjectVersionId } : {}),
        }] });
      }
      return { object, commit: req.candidate, snapshot: req.candidate, changedPaths: paths };
    },
    async startHolds(product) {
      checks.set(product, (checks.get(product) ?? 0) + 1);
      return startHolds(objects.git, repo, view(), view().object(product as ObjectVersionId)!);
    },
  };
  return { ports, objects, recorded, checks, view, entries };
}
