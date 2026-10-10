// The user's words (design 3.1, 10.1 item 6): every user message is booked in the ledger, word for word, by the PM session's prompt hook.
//
// The prompt hook books every message once per message id (the ledger's op is
// `user-words:<message>`, so a retry returns the original revision). When the ledger
// service cannot take it now (not running, storage fault), the message waits in the
// CLI's state directory (Linux filesystem) and is booked, in order, by the next hook
// or CLI command that reaches the ledger. The prompt is never failed for this.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import type { LedgerClient } from '../ledger/ipc.ts';
import { ledgerFailure } from './context.ts';

export interface UserWords {
  readonly message: string;
  readonly session: string;
  readonly at: number;
  readonly text: string;
}

/** Hook input fields that identify a message, when Claude Code provides one. */
const ID_FIELDS = ['prompt_id', 'message_id', 'messageId', 'uuid'] as const;

/**
 * The message id of a prompt: Claude Code's own id when the hook input carries
 * one; else a hash of the session, the transcript's size when the hook ran, and
 * the text (a retry of the same hook run sees the same transcript; the same text
 * sent again later does not, the transcript having grown in between).
 */
export function messageIdFor(input: Record<string, unknown>): string {
  for (const f of ID_FIELDS) {
    const v = input[f];
    if (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,150}$/.test(v)) return `cc-${v}`;
  }
  let size = -1;
  const tp = input['transcript_path'];
  if (typeof tp === 'string') {
    try {
      size = statSync(tp).size;
    } catch {
      size = -1;
    }
  }
  const h = createHash('sha256')
    .update(String(input['session_id'] ?? ''))
    .update('\0')
    .update(String(size))
    .update('\0')
    .update(String(input['prompt'] ?? ''))
    .digest('hex')
    .slice(0, 32);
  return `msg-${h}`;
}

function spoolDir(stateDir: string): string {
  return join(stateDir, 'cli', 'user-words');
}

function spoolFile(stateDir: string, message: string): string {
  return join(spoolDir(stateDir), `${createHash('sha256').update(message).digest('hex').slice(0, 40)}.json`);
}

export function spoolUserWords(stateDir: string, w: UserWords): void {
  mkdirSync(spoolDir(stateDir), { recursive: true });
  writeFileAtomic(spoolFile(stateDir, w.message), JSON.stringify({ format: 'mp4.cli-user-words.v1', ...w }));
}

export function spooledUserWords(stateDir: string): UserWords[] {
  let names: string[];
  try {
    names = readdirSync(spoolDir(stateDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  const out: UserWords[] = [];
  for (const n of names) {
    try {
      const w = JSON.parse(readFileSync(join(spoolDir(stateDir), n), 'utf8')) as UserWords & { format?: string };
      if (w.format === 'mp4.cli-user-words.v1' && typeof w.message === 'string' && typeof w.text === 'string') out.push({ message: w.message, session: w.session, at: w.at, text: w.text });
    } catch {
      /* torn: left for the next run */
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export type BookOutcome = { readonly booked: true; readonly revision: number } | { readonly booked: false; readonly spooled: boolean; readonly reason: string };

/** Errors after which waiting cannot help: the message is dropped from the spool and reported. */
const FINAL = new Set(['TOO_LARGE', 'BAD_REQUEST', 'RECORD_INVALID', 'OP_CONFLICT']);

/** Book one message; spool it when the ledger cannot take it now. */
export async function bookUserWords(client: LedgerClient, stateDir: string, w: UserWords): Promise<BookOutcome> {
  try {
    const r = (await client.call('recordUserWords', w)) as { revision: number };
    return { booked: true, revision: Number(r.revision) };
  } catch (e) {
    const f = ledgerFailure('recordUserWords', e);
    if (FINAL.has(f.code)) return { booked: false, spooled: false, reason: f.message };
    try {
      spoolUserWords(stateDir, w);
      return { booked: false, spooled: true, reason: f.message };
    } catch (e2) {
      return { booked: false, spooled: false, reason: `${f.message}; could not keep it for later either: ${(e2 as Error).message}` };
    }
  }
}

/** Book spooled messages in order (at most `max`); stops at the first one the ledger cannot take now. */
export async function flushUserWords(client: LedgerClient, stateDir: string, max = 50): Promise<{ booked: number; left: number }> {
  const all = spooledUserWords(stateDir);
  let booked = 0;
  for (const w of all.slice(0, max)) {
    try {
      await client.call('recordUserWords', w);
    } catch (e) {
      const f = ledgerFailure('recordUserWords', e);
      if (!FINAL.has(f.code)) break;
    }
    try {
      unlinkSync(spoolFile(stateDir, w.message));
    } catch {
      /* gone */
    }
    booked++;
  }
  return { booked, left: all.length - booked };
}
