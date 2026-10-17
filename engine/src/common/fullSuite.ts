// The project's full test suite (4.1.2, D-4..D-7): config `fullSuite`, or the 4.1.1 key
// `closingChecks` read as its alias when `fullSuite` is absent.
export interface SuiteCommand { readonly id: string; readonly command: string | readonly string[]; readonly cwd?: string }

export function fullSuiteOf(config: { readonly fullSuite?: readonly SuiteCommand[] | undefined; readonly closingChecks?: readonly SuiteCommand[] | undefined }): readonly SuiteCommand[] {
  return config.fullSuite ?? config.closingChecks ?? [];
}

export function normalizeCommand(c: string | readonly string[]): string {
  return (typeof c === 'string' ? c : c.join(' ')).trim().replace(/\s+/g, ' ');
}

/** True when `command` is one of the full suite's commands (by normalized text). */
export function isFullSuiteCommand(suite: readonly SuiteCommand[], command: string | readonly string[]): boolean {
  const n = normalizeCommand(command);
  return suite.some((s) => normalizeCommand(s.command) === n);
}
