// The shape of a CLI command (design 9.2: the PM command group).

import type { FlagKind, ParsedArgs } from './args.ts';
import type { Ctx } from './context.ts';

export interface CommandResult {
  readonly exitCode: number;
  /** Human-readable Chinese text (the default output). */
  readonly text: string;
  /** The machine form (`--json`). */
  readonly json: unknown;
}

export interface Command {
  readonly name: string;
  /** One line, Chinese. */
  readonly summary: string;
  readonly usage: string;
  readonly flags: Readonly<Record<string, FlagKind>>;
  /** State-changing: carries an operation id, recorded in the journal (3.11 principle 3). */
  readonly changesState: boolean;
  /** The WI this command answers, for the journal. */
  readonly wi?: string;
  /** Runs without a configuration (install). */
  readonly noConfig?: boolean;
  /** The arguments that identify the operation (for the journal's conflict check); default: positionals and flags. */
  readonly identity?: (args: ParsedArgs) => unknown;
  run(ctx: Ctx, args: ParsedArgs, op: string | null): Promise<CommandResult>;
}

export function ok(text: string, json: unknown, exitCode = 0): CommandResult {
  return { exitCode, text, json };
}
