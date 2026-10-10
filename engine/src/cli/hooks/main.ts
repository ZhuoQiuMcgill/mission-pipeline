// Entry of the PM session's Claude Code hooks (plugin/hooks/hooks.json runs it through
// plugin/bin/mp-hook):
//
//   node --experimental-strip-types src/cli/hooks/main.ts session-start|user-prompt-submit < hook-input.json
//
// Reads the hook input (JSON on stdin), prints the hook output (JSON on stdout) and
// always exits 0: a hook of this program never blocks or fails the user's prompt.

import { errorMessage } from '../errors.ts';
import { sessionStartHook, userPromptSubmitHook, type HookRun } from './handlers.ts';

function readStdin(limitMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    const timer = setTimeout(() => resolve(buf), limitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => (buf += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(buf);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? '';
  let input: Record<string, unknown> = {};
  try {
    const raw = await readStdin(2_000);
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    input = {};
  }
  const io = { cwd: process.cwd(), env: process.env, now: Date.now };
  let run: HookRun;
  if (event === 'session-start') run = await sessionStartHook(input, io);
  else if (event === 'user-prompt-submit') run = await userPromptSubmitHook(input, io);
  else return;
  if (process.env['MP_HOOK_DEBUG'] === '1') process.stderr.write(`${JSON.stringify(run.facts)}\n`);
  if (run.output !== null) process.stdout.write(`${JSON.stringify(run.output)}\n`);
}

main()
  .catch((e: unknown) => {
    // Never fail the prompt; say what went wrong in the PM's context.
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: process.argv[2] === 'session-start' ? 'SessionStart' : 'UserPromptSubmit', additionalContext: `[Mission Pipeline 4] hook error: ${errorMessage(e)} (stops can still be sent from the terminal with mp stop)` } })}\n`);
  })
  .finally(() => {
    // Detached stop writers must not keep the hook alive.
    setTimeout(() => process.exit(0), 10).unref();
  });
