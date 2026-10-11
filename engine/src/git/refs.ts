// Program refs (design 4.1 §6.7; 4.0 6.1 "git：程序只创建自己命名空间里的引用").
//
// The program only ever creates refs under refs/mission-pipeline/ (the delivery
// ref, delivery.ts), with plain git: `git update-ref <ref> <D> ""`, which
// creates the ref only if it is absent, judged by reading the ref back.
// Landing (land.ts) is the one place that moves a branch.
//
// Ref names: ids may contain characters a ref name cannot (ids.ts allows ':'),
// so each component is percent-encoded over the alphabet [A-Za-z0-9_-].

import type { Brand, MissionId, OpId } from '../common/ids.ts';

export const PROGRAM_REF_NAMESPACE = 'refs/mission-pipeline/';

export type ProgramRefName = Brand<string, 'ProgramRefName'>;

export function encodeRefComponent(s: string): string {
  if (s.length === 0) throw new TypeError('empty ref component');
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /^[A-Za-z0-9_-]$/.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function programRef(...components: readonly string[]): ProgramRefName {
  if (components.length === 0) throw new TypeError('a program ref needs at least one component');
  return (PROGRAM_REF_NAMESPACE + components.map(encodeRefComponent).join('/')) as ProgramRefName;
}

/** refs/mission-pipeline/delivered/<mission>/<op> (6.1, 6.6 step 6). */
export function deliveryRef(mission: MissionId, op: OpId): ProgramRefName {
  return programRef('delivered', mission, op);
}

/** Accepts only names this module could have produced. */
export function asProgramRef(name: string): ProgramRefName {
  if (!name.startsWith(PROGRAM_REF_NAMESPACE)) throw new TypeError(`not a program ref: ${name}`);
  const rest = name.slice(PROGRAM_REF_NAMESPACE.length).split('/');
  if (rest.length === 0 || rest.some((c) => !/^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})+$/.test(c))) {
    throw new TypeError(`program ref has a component outside the encoded alphabet: ${name}`);
  }
  return name as ProgramRefName;
}
