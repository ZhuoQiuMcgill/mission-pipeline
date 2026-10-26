#!/usr/bin/env node
// Optional Claude Code adapter (design 4.1 §6.1, §9): nothing in Mission Pipeline needs it.
//
//   session-start        prints a neutral three-line pointer, and runs nothing: every session starts
//                        here, a dispatched seat's included, so it never acts as the PM (4.1.2)
//   user-prompt-submit   records the user's message verbatim with `mp pm say --stdin`; the PM's own
//                        `mp pm say` of the same text then records nothing new (decision 9)
//
// It reads the hook's JSON on stdin, runs `mp` in the session's folder, and never blocks a prompt:
// outside a project with .mission-pipeline/, or when `mp` fails, it prints nothing and exits 0.
// Text the harness injects is never recorded as the user's words: the fixed prompt the PM gives a
// dispatched seat ("You are the <seat> of Mission Pipeline. …") and the harness's envelopes
// (<agent-message …>, <cross-session-message …>, <task-notification>, <ci-monitor-event>,
// <system-reminder>, <command-…>, "[Subagent hand-back]").
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const event = process.argv[2] ?? '';
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}
const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();

/** The engine next to this plugin (a clone), else `mp` from the PATH. */
function mp(args, stdin) {
  const local = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'mp.mjs');
  const r = existsSync(local)
    ? spawnSync(process.execPath, [local, ...args], { cwd, input: stdin, encoding: 'utf8', timeout: 100_000 })
    : spawnSync('mp', args, { cwd, input: stdin, encoding: 'utf8', timeout: 100_000, shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Text the harness injected, not the user's words: the fixed prompt of a dispatched seat, and the
 * harness's envelopes (a sub-agent's hand-back, a message from another session, a task
 * notification, a pull-request monitor's event, a system reminder, a slash command's expansion).
 */
function harnessText(prompt) {
  const t = prompt.trim();
  if (/^You are the [A-Za-z ]+ of Mission Pipeline\./.test(t)) return true;
  if (/^<(agent-message|cross-session-message|task-notification|ci-monitor-event|system-reminder|command-)/.test(t)) return true;
  return t.includes('[Subagent hand-back]');
}

/** What every session in a project sees at its start (the PM and a dispatched seat alike). */
const SESSION_POINTER = [
  'This project uses Mission Pipeline.',
  'If you are the PM, read the core of `.mission-pipeline/pm/PM.md` and run `mp pm next`.',
  'If you were started as a seat, your card (`mp seat <id> card`) is your whole instruction.',
].join('\n');

function inProject(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.mission-pipeline', 'memory.db'))) return true;
    if (dirname(d) === d) return false;
  }
}

try {
  if (inProject(cwd)) {
    if (event === 'session-start') {
      // no mp command and no PM text: a seat would otherwise see the PM's steps and write as the PM
      process.stdout.write(`${SESSION_POINTER}\n`);
    } else if (event === 'user-prompt-submit') {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (prompt.trim() !== '' && !harnessText(prompt)) {
        const out = mp(['pm', 'say', '--stdin'], prompt);
        if (out !== null) process.stdout.write(`(Mission Pipeline: ${out.split('\n')[0]})\n`);
      }
    }
  }
} catch {
  /* never block the session */
}
process.exit(0);
