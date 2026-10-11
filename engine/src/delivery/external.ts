// WI-03 at a delivery and at a landing (design 4.1 §6.7; WI-03): an external
// worktree or branch that changed paths inside the write scope of a module of a
// mission in flight. Default action (the WI page): nothing is merged or
// adopted, the pipeline goes on; the PM gets a notice with the worktree, the
// branch, the overlapping paths and the inferred origin. Found only at these
// two moments, never by a periodic scan.
//
// The write scopes are those recorded on the product versions of the missions
// in flight (the open missions, and the mission delivering), per module.

import { canonicalJson, sha256 } from '../common/hash.ts';
import type { AlertId, GitOid, MissionId } from '../common/ids.ts';
import type { ObjectVersionRecord } from '../common/records.ts';
import { externalOverlaps, type ExternalOverlap, type WriteScopeOf } from '../git/externalWorktrees.ts';
import type { GitContext } from '../git/workspace.ts';
import { listMissions, raiseAlert, recordsByKind, type Db } from '../memory/index.ts';
import { realpathSync } from 'node:fs';

/** The write scopes of the modules of the missions in flight (and of `mission`), from their product versions. */
export function writeScopesInFlight(db: Db, mission: MissionId): WriteScopeOf[] {
  const missions = new Set<string>([mission, ...listMissions(db, 'open').map((x) => x.mission)]);
  const byModule = new Map<string, { mission: string; module: string | null; patterns: Set<string> }>();
  for (const m of missions) {
    for (let after = 0; ; ) {
      const page = recordsByKind(db, { kinds: ['object.version'], mission: m as MissionId, after, limit: 1000 });
      if (page.length === 0) break;
      after = Number(page[page.length - 1]!.revision);
      for (const c of page) {
        const r = c.record as ObjectVersionRecord;
        if (r.source === undefined) continue;
        const key = JSON.stringify([m, r.module]);
        let e = byModule.get(key);
        if (e === undefined) byModule.set(key, (e = { mission: m, module: r.module, patterns: new Set() }));
        for (const p of r.source.writeScope) e.patterns.add(p);
      }
    }
  }
  return [...byModule.values()].map((e) => ({ mission: e.mission, module: e.module, writeScope: [...e.patterns].sort() }));
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Look for WI-03 overlaps against `base` and, when there are any, raise one
 * notice (once per distinct finding). Never refuses and never throws: the
 * check is for explanation only, and a failure to read is no finding.
 */
export async function noticeExternalWork(ctx: GitContext, o: { readonly mission: MissionId; readonly delivery: string; readonly base: GitOid; readonly targetBranch: string; readonly at: 'delivery' | 'landing' }): Promise<readonly ExternalOverlap[]> {
  const m = ctx.memory;
  try {
    const scopes = m.read((db) => writeScopesInFlight(db, o.mission));
    if (scopes.length === 0) return [];
    const commonDir = real(ctx.git.textSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: m.projectDir }));
    const own = real(ctx.git.textSync(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd: m.projectDir }));
    const overlaps = await externalOverlaps(ctx.git, { commonDir, base: o.base, targetBranch: o.targetBranch, own, pipelineDir: real(m.paths.worktrees), scopes });
    if (overlaps.length === 0) return [];
    const alert = `wi03.${o.at}.${o.mission}.${o.delivery}.${sha256(canonicalJson({ base: o.base, overlaps })).slice(0, 16)}`;
    m.write({}, (tx) => {
      if (tx.stmt("SELECT 1 FROM log WHERE kind = 'alert' AND record LIKE ? LIMIT 1").get(`%"alert":"${alert}"%`) !== undefined) return;
      raiseAlert(tx, {
        alert: alert as AlertId,
        category: 'external-work-in-write-scope',
        wi: 'WI-03',
        body: tx.data.put(
          canonicalJson({
            trigger: `at the ${o.at} of ${o.mission}/${o.delivery}: external work changed paths inside the write scope of a mission in flight: ${overlaps.map((x) => `${x.worktree ?? x.branch} (${x.paths.length} path(s), ${x.mission}${x.module !== null ? `/${x.module}` : ''})`).join('; ')}`,
            facts: { base: o.base, overlaps },
            defaultAction: 'nothing is merged or adopted; the pipeline goes on; external work is seen only once it enters the target branch, as the new base',
          }),
        ),
      });
    });
    return overlaps;
  } catch {
    return [];
  }
}
