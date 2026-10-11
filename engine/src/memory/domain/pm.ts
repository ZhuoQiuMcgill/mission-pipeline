// The PM's own records (design 4.1 §3.2, §6.1, §8): the maintainer's words,
// notices delivered and acknowledged, the PM's actions under a WI, cursors of
// the layered reads. Functions inside the caller's write.
//
// - `mp pm say` records the maintainer's message verbatim before anything else
//   (§6.1): its text is data (the program checks requirement quotes against it,
//   never against a Markdown file), its entry W-<n> a journal leaf in
//   words/<date>.md, and a `user.words` record links the two. Once per message:
//   the same message again returns its entry; other text under the same message
//   id is refused. Never refused by a stop.
// - A requirement item's quote must appear verbatim in the words entry it
//   names (checkQuote, v04 check).
// - Notices: delivered, then acknowledged; never back.
// - PM actions: started, then done or failed; done is final; another command
//   or other arguments under the same action id are OP_CONFLICT.

import { canonicalJson, sha256 } from '../../common/hash.ts';
import type { Revision } from '../../common/ids.ts';
import type { UserWordsRecord } from '../../common/records.ts';
import type { DataStore } from '../data.ts';
import type { Db } from '../db.ts';
import { LedgerError } from '../errors.ts';
import type { LeafRef } from '../leaves.ts';
import type { WriteTx } from '../memory.ts';
import { pmAction, wordsEntry, wordsOfMessage, type WordsEntry } from '../queries.ts';
import { appendFact, checkShape } from './facts.ts';

/** A user message's full text (10.1 item 6). */
const MAX_USER_WORDS_BYTES = 16 * 1024 * 1024;
const MAX_DETAILS_BYTES = 256 * 1024;

function excerptOf(text: string): string {
  let excerpt = '';
  for (const ch of text) {
    if (excerpt.length + ch.length > 280) break;
    excerpt += ch;
  }
  return excerpt;
}

/** The journal file of one day's words (UTC date of the record). */
export function wordsFile(at: number): string {
  return `words/${new Date(at).toISOString().slice(0, 10)}.md`;
}

/**
 * Record one message of the maintainer, verbatim (§6.1; 4.0 recordUserWords).
 * Returns its words entry (W-<n>) and leaf.
 */
export function recordWords(tx: WriteTx, req: { message: string; session: string; at: number; text: string }): { words: string; revision: Revision; leaf: string | null; repeated: boolean } {
  if (!req || typeof req.text !== 'string') throw new LedgerError('BAD_REQUEST', 'user words are { message, session, at, text }');
  if (Buffer.byteLength(req.text, 'utf8') > MAX_USER_WORDS_BYTES) throw new LedgerError('TOO_LARGE', `a user message is at most ${MAX_USER_WORDS_BYTES} bytes`);
  const hash = sha256(req.text);
  const cur = wordsOfMessage(tx, req.message);
  if (cur !== null) {
    if (cur.text === hash) return { words: cur.words, revision: cur.revision, leaf: cur.leaf, repeated: true };
    throw new LedgerError('FACT_CONFLICT', `message ${req.message} is recorded as ${cur.words} with other text`);
  }
  const words = `W-${Number((tx.stmt('SELECT COUNT(*) AS n FROM words').get() as { n: number }).n) + 1}`;
  const base: UserWordsRecord = { kind: 'user.words', message: req.message, session: req.session, at: req.at, text: hash, excerpt: excerptOf(req.text) };
  checkShape(base, new Set(['user.words']), 'recordWords');
  tx.data.put(req.text);
  const when = Number.isSafeInteger(req.at) && req.at > 0 ? req.at : tx.at;
  const leaf: LeafRef = tx.leaves.appendEntry(wordsFile(when), `### ${words} · ${new Date(when).toISOString()} · session ${req.session}\n\n${req.text}`);
  // The entry id and its leaf ride on the record (extra fields the 4.0 type does not name): the projection reads them.
  const rec: UserWordsRecord & { readonly words: string; readonly leaf: string } = { ...base, words, leaf: leaf.leaf };
  const revision = appendFact(tx, rec);
  return { words, revision, leaf: leaf.leaf, repeated: false };
}

/** A requirement item's quote must appear verbatim in the words entry it names (§6.1); RECORD_INVALID otherwise. */
export function checkQuote(db: Db, data: DataStore, words: string, quote: string): WordsEntry {
  const w = wordsEntry(db, words);
  if (w === null) throw new LedgerError('RECORD_INVALID', `no words entry ${words}`);
  if (typeof quote !== 'string' || quote.trim() === '') throw new LedgerError('RECORD_INVALID', 'a quote is non-empty text');
  if (!data.text(w.text).includes(quote)) throw new LedgerError('RECORD_INVALID', `the quote does not appear verbatim in ${w.words}`);
  return w;
}

/**
 * A notice's delivery state (3.9): delivered, then acknowledged (which implies
 * delivered); never back. Absent: undelivered. Marking a state already reached
 * records nothing (`changed: false`).
 */
export function markNotice(tx: WriteTx, req: { notice: string; state: 'delivered' | 'acknowledged' }): { state: 'delivered' | 'acknowledged'; changed: boolean } {
  if (!req || typeof req.notice !== 'string' || req.notice === '' || [...req.notice].length > 200 || /[\u0000-\u001f\u007f]/.test(req.notice)) throw new LedgerError('BAD_REQUEST', 'notice is 1 to 200 printable characters');
  if (req.state !== 'delivered' && req.state !== 'acknowledged') throw new LedgerError('BAD_REQUEST', 'state is delivered or acknowledged');
  const cur = tx.stmt('SELECT state FROM notice_deliveries WHERE notice = ?').get(req.notice) as { state: 'delivered' | 'acknowledged' } | undefined;
  if (cur?.state === 'acknowledged' || (cur?.state === 'delivered' && req.state === 'delivered')) return { state: cur.state, changed: false };
  tx.append({ kind: 'notice.delivery', notice: req.notice, state: req.state });
  return { state: req.state, changed: true };
}

/**
 * A PM action under a WI (3.11 principle 3), by the PM's action id: `started`
 * when the command begins (again after a failure), then `done` or `failed`
 * with its result. `args` and `result` are stored as canonical JSON data.
 */
export function recordPmAction(
  tx: WriteTx,
  req: { action: string; command: string; args: unknown; wi?: string | null; state: 'started' | 'done' | 'failed'; result?: unknown },
): { state: 'started' | 'done' | 'failed'; revision: Revision | null } {
  if (typeof req.action !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(req.action)) throw new LedgerError('BAD_REQUEST', 'action is an operation id');
  if (typeof req.command !== 'string' || req.command === '' || req.command.length > 200) throw new LedgerError('BAD_REQUEST', 'command is 1 to 200 characters');
  if (!['started', 'done', 'failed'].includes(req.state)) throw new LedgerError('BAD_REQUEST', 'state is started, done or failed');
  const wi = req.wi ?? null;
  if (wi !== null && (typeof wi !== 'string' || !/^WI-\d{2,3}$/.test(wi))) throw new LedgerError('BAD_REQUEST', 'wi is a work instruction number (WI-nn) or null');
  const argsJson = canonicalJson({ command: req.command, args: req.args ?? null });
  const resultJson = req.state === 'started' ? null : canonicalJson(req.result ?? null);
  for (const j of [argsJson, resultJson]) if (j !== null && Buffer.byteLength(j, 'utf8') > MAX_DETAILS_BYTES) throw new LedgerError('TOO_LARGE', 'the action’s arguments or result are too large');
  const argsHash = sha256(argsJson);
  const result = resultJson === null ? null : sha256(resultJson);
  const cur = pmAction(tx, req.action);
  if (cur !== null && (cur.command !== req.command || cur.argsHash !== argsHash)) throw new LedgerError('OP_CONFLICT', `PM action ${req.action} was recorded for another command or other arguments (${cur.command})`);
  if (cur !== null && (cur.state === 'done' || (cur.state === req.state && (req.state === 'started' || cur.result === result)))) return { state: cur.state, revision: null };
  const args = tx.data.put(argsJson);
  if (resultJson !== null) tx.data.put(resultJson);
  // An end without a recorded start (the start mark was lost) is recorded as it is.
  const revision = tx.append({ kind: 'pm.action', action: req.action, command: req.command, argsHash, args, wi, state: req.state, result });
  return { state: req.state, revision };
}

/** Move a cursor of the layered reads (§3.2 item 7, §8), e.g. "since the maintainer last asked", to a revision (default: the head). */
export function setCursor(tx: WriteTx, req: { cursor: string; rev?: number }): { rev: number } {
  if (typeof req.cursor !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(req.cursor)) throw new LedgerError('BAD_REQUEST', 'a cursor is 1 to 64 lowercase letters, digits, "." and "-"');
  const head = Number(tx.head());
  const rev = req.rev ?? head;
  if (!Number.isSafeInteger(rev) || rev < 0 || rev > head) throw new LedgerError('BAD_REQUEST', `a cursor's revision is 0 to the head (${head})`);
  tx.append({ kind: 'cursor.set', cursor: req.cursor, rev });
  return { rev };
}

