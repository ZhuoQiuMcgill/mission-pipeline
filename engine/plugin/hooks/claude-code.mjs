#!/usr/bin/env node
// Optional Claude Code adapter. It never records a prompt or runs mp. MP_SECRETARY
// is the single identity rule: resident sessions (and their seats) receive no reminder.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 4.4.1 (Windows): how to call mp in PowerShell (there `mp` is an alias); the sentence of src/common/powershell.ts. */
export const POWERSHELL_NOTE = "In PowerShell, write `mp.ps1` for `mp` (there `mp` is PowerShell's own alias of Move-ItemProperty); `mp.cmd` called from PowerShell drops double quotes inside an argument.";

/** What every session in a project sees at its start (the PM and a dispatched seat alike); on Windows it ends with POWERSHELL_NOTE. */
export function sessionPointer(platform = process.platform) {
  return [
    'This project uses Mission Pipeline.',
    'If you are the PM, read the core of `.mission-pipeline/pm/PM.md` and run `mp pm session`.',
    'If you were started as a seat, your card (`mp seat <id> card`) is your whole instruction.',
    ...(platform === 'win32' ? [POWERSHELL_NOTE] : []),
  ].join('\n');
}

function inProject(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.mission-pipeline', 'memory.db'))) return true;
    if (dirname(d) === d) return false;
  }
}

function main() {
  const event = process.argv[2] ?? '';
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    input = {};
  }
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  try {
    if (!process.env.MP_SECRETARY && inProject(cwd)) {
      if (event === 'session-start') {
        // no mp command and no PM text: a seat would otherwise see the PM's steps and write as the PM
        process.stdout.write(`${sessionPointer()}\n`);
      } else if (event === 'user-prompt-submit') {
        process.stdout.write('Mission Pipeline: begin your reply with your reading of the message type, in the user’s language.\nRecord the previous message with all its tags if this reply raises no objection; record one-off instructions at once.\n');
      }
    }
  } catch {
    /* never block the session */
  }
  process.exit(0);
}

/** Whether this file is the program Node runs (a test imports it for sessionPointer). */
function isEntry() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (isEntry()) main();
