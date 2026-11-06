#!/usr/bin/env node
// Optional Claude Code adapter. It never records a prompt or runs mp. MP_SECRETARY
// is the single identity rule: resident sessions (and their seats) receive no reminder.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const event = process.argv[2] ?? '';
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}
const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();

/** What every session in a project sees at its start (the PM and a dispatched seat alike). */
const SESSION_POINTER = [
  'This project uses Mission Pipeline.',
  'If you are the PM, read the core of `.mission-pipeline/pm/PM.md` and run `mp pm session`.',
  'If you were started as a seat, your card (`mp seat <id> card`) is your whole instruction.',
].join('\n');

function inProject(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.mission-pipeline', 'memory.db'))) return true;
    if (dirname(d) === d) return false;
  }
}

try {
  if (!process.env.MP_SECRETARY && inProject(cwd)) {
    if (event === 'session-start') {
      // no mp command and no PM text: a seat would otherwise see the PM's steps and write as the PM
      process.stdout.write(`${SESSION_POINTER}\n`);
    } else if (event === 'user-prompt-submit') {
      process.stdout.write('Mission Pipeline: begin your reply with your reading of the message type, in the user’s language.\nRecord the previous message with all its tags if this reply raises no objection; record one-off instructions at once.\n');
    }
  }
} catch {
  /* never block the session */
}
process.exit(0);
