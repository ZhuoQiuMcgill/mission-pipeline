// A small argument parser: positionals and flags (`--name value`, `--name=value`,
// boolean `--name`, repeatable list flags). Unknown flags are usage errors, so a
// mistyped option never silently changes what a state-changing command does.

import { missionIdProblem } from '../common/ids.ts';
import { usage } from './errors.ts';

export type FlagKind = 'string' | 'boolean' | 'list';

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

/** Flags every command takes. */
export const GLOBAL_FLAGS: Readonly<Record<string, FlagKind>> = { json: 'boolean', config: 'string', op: 'string', help: 'boolean' };

export function parseArgs(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>): ParsedArgs {
  const all: Record<string, FlagKind> = { ...GLOBAL_FLAGS, ...spec };
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (onlyPositional || !a.startsWith('--') || a === '--') {
      if (a === '--' && !onlyPositional) {
        onlyPositional = true;
        continue;
      }
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    const kind = all[name];
    if (kind === undefined) throw usage(`unknown option --${name}`);
    if (kind === 'boolean') {
      if (eq !== -1) throw usage(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value: string;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined) throw usage(`--${name} needs a value`);
      value = next;
      i++;
    }
    if (kind === 'list') {
      const prev = flags[name];
      const items = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
      flags[name] = [...(Array.isArray(prev) ? prev : []), ...items];
    } else {
      if (flags[name] !== undefined) throw usage(`--${name} may be given only once`);
      flags[name] = value;
    }
  }
  return { positionals, flags };
}

export function flagStr(a: ParsedArgs, name: string): string | null {
  const v = a.flags[name];
  return typeof v === 'string' ? v : null;
}

export function flagBool(a: ParsedArgs, name: string): boolean {
  return a.flags[name] === true;
}

export function flagList(a: ParsedArgs, name: string): readonly string[] {
  const v = a.flags[name];
  return Array.isArray(v) ? v : [];
}

export function positional(a: ParsedArgs, i: number, what: string): string {
  const v = a.positionals[i];
  if (v === undefined || v === '') throw usage(`missing argument: ${what}`);
  return v;
}

/** A mission id argument: refused with the rule when it could make derived ids collide (review r1 #17). */
export function missionArg(a: ParsedArgs, i: number): string {
  const v = positional(a, i, 'mission');
  const bad = missionIdProblem(v);
  if (bad !== null) throw usage(bad);
  return v;
}
