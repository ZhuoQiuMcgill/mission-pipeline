// The project's full test suite (4.1.2, D-4..D-7): config `fullSuite`, or the 4.1.1 key
// `closingChecks` read as its alias when `fullSuite` is absent.
export interface SuiteCommand { readonly id: string; readonly command: string | readonly string[]; readonly cwd?: string }

export function fullSuiteOf(config: { readonly fullSuite?: readonly SuiteCommand[] | undefined; readonly closingChecks?: readonly SuiteCommand[] | undefined }): readonly SuiteCommand[] {
  return config.fullSuite ?? config.closingChecks ?? [];
}

export function normalizeCommand(c: string | readonly string[]): string {
  return (typeof c === 'string' ? c : c.join(' ')).trim().replace(/\s+/g, ' ');
}

/** A working directory relative to the repository root, for comparison only ('.' when none). */
function sameDir(cwd: string | undefined): string {
  if (cwd === undefined) return '.';
  const s = cwd.replace(/\\/g, '/').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return s === '' || s === '.' ? '.' : s;
}

/**
 * True when `command`, run in `cwd`, is one of the full suite's commands: the same normalized text
 * in the same working directory. In a repository with packages, `npm test` at the root (the suite)
 * and `npm test` in `frontend/` (a local test) are different commands.
 */
export function isFullSuiteCommand(suite: readonly SuiteCommand[], command: string | readonly string[], cwd?: string): boolean {
  const n = normalizeCommand(command);
  const d = sameDir(cwd);
  return suite.some((s) => normalizeCommand(s.command) === n && sameDir(s.cwd) === d);
}
