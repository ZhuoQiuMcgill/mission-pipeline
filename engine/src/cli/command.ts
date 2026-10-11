// The shape of an `mp` command (design 4.1 §4.1): grouped by role (`mp pm …` for the PM,
// `mp seat <dispatch> …` for a dispatched seat, `mp read …` for anyone) plus the project's own
// commands (`mp init`, `mp config`, `mp recompute`, `mp docs update`, `mp help`).

import type { FlagKind, ParsedArgs } from './args.ts';
import type { CliIo, Project } from './project.ts';

export interface CommandResult {
  readonly exitCode: number;
  /** Text for people (the default output). */
  readonly text: string;
  /** The machine form (`--json`). */
  readonly json: unknown;
}

export interface RunContext {
  readonly io: CliIo;
  /** The open project (null for the commands that run without one: init, help). */
  readonly project: Project | null;
  /** The PM command's operation id, or null. */
  readonly op: string | null;
  readonly now: number;
}

export type Group = 'pm' | 'seat' | 'read' | 'admin';

export interface Command {
  readonly group: Group;
  /** The words after the group (and after the dispatch id for `mp seat`), e.g. ['requirement', 'add']. */
  readonly name: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly flags: Readonly<Record<string, FlagKind>>;
  /** Runs without an initialized project (init, help). */
  readonly noProject?: boolean;
  /** Decides on labels: the environment identity is observed first (§6.5). */
  readonly decides?: boolean;
  /**
   * A stop (Appendix E, v06): the memory is opened and the stop written directly; no landing
   * recovery, label batch, PM action or environment observation goes before it.
   */
  readonly stop?: boolean;
  /** A PM command that is not recorded as a PM action (it cannot write: continue-from on a broken chain). */
  readonly unrecorded?: boolean;
  /** What identifies the operation for a retry (default: positionals and command flags). */
  readonly identity?: (args: ParsedArgs) => unknown;
  run(c: RunContext, args: ParsedArgs): Promise<CommandResult>;
}

export function ok(text: string, json: unknown, exitCode = 0): CommandResult {
  return { exitCode, text, json };
}

export function commandName(c: Command): string {
  return [c.group === 'admin' ? null : c.group, ...(c.group === 'seat' ? ['<dispatch>'] : []), ...c.name].filter((x) => x !== null).join(' ');
}
