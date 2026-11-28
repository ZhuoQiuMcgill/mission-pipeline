// 4.4.1 (Windows): the one reader of text a person or a seat hands the engine, from a file they name
// (`--file`, `--report`, `--result`, `--notes`, `--request`, `--attempts`, `config.json`) or on the
// standard input (`--stdin`). Windows tools write a UTF-8 byte-order mark (Windows PowerShell 5.1's
// `Set-Content -Encoding UTF8`, many editors) or UTF-16 with one (5.1's `Out-File` and `>`):
//   - a UTF-8 byte-order mark at the start is not part of the text: it is dropped (repeated too, as
//     Windows PowerShell 5.1 pipes it);
//   - UTF-16 with a byte-order mark (little or big endian) is decoded;
//   - bytes that are not UTF-8 are read as U+FFFD, as before, and the command says so in one warning
//     line (no new refusal, R2);
//   - a NUL with no byte-order mark is kept as it is: where it was refused it still is, and the
//     refusal says what to do (the file is probably UTF-16 without a mark).
// With no byte-order mark the text is exactly what 4.4.0 read (Buffer#toString('utf8')). Line ends are
// never changed. Not for what the engine wrote itself, git content, kept evidence or run output:
// those are bytes.

import { Buffer, isUtf8 } from 'node:buffer';
import { readFileSync } from 'node:fs';

export interface InputText {
  readonly text: string;
  /** The byte-order mark the input began with (dropped from the text), or null. */
  readonly bom: 'utf-8' | 'utf-16le' | 'utf-16be' | null;
  /** Bytes that are not valid in the input's encoding were read as U+FFFD. */
  readonly invalid: boolean;
  /** NUL characters in an input with no byte-order mark (probably UTF-16 without one). */
  readonly nul: boolean;
  /** The one warning line a command that goes on prints, or null. */
  readonly warning: string | null;
}

function utf16le(bytes: Uint8Array): { text: string; invalid: boolean } {
  try {
    return { text: new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes), invalid: false };
  } catch {
    return { text: new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes), invalid: true };
  }
}

function swapped(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  const even = bytes.length - (bytes.length % 2);
  for (let i = 0; i < even; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  if (even < bytes.length) out[even] = bytes[even]!;
  return out;
}

/** What a person can do about a NUL in the text (part of a refusal or of a parse error). */
export function nulHint(what: string): string {
  return `${what} holds NUL characters: it is probably UTF-16 without a byte-order mark. Save it as UTF-8 and run the command again`;
}

/** A parse error's addition for an input that holds NUL characters ('' otherwise). */
export function nulNote(t: InputText, what: string): string {
  return t.nul ? ` (${nulHint(what)})` : '';
}

/**
 * The text of an input as the engine reads it. `what` names it in the warning ("the file msg.txt",
 * "the standard input"). A string (a caller that read it already, a test) is taken as it is.
 */
export function decodeInput(input: string | Uint8Array, what: string): InputText {
  let text: string;
  let bom: InputText['bom'] = null;
  let invalid = false;
  if (typeof input === 'string') text = input;
  else {
    const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
      bom = 'utf-8';
      const rest = b.subarray(3);
      text = rest.toString('utf8');
      invalid = !isUtf8(rest);
    } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      bom = 'utf-16le';
      ({ text, invalid } = utf16le(b.subarray(2)));
    } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      bom = 'utf-16be';
      ({ text, invalid } = utf16le(swapped(b.subarray(2))));
    } else {
      // no byte-order mark: 4.4.0's reading, byte for byte
      text = b.toString('utf8');
      invalid = !isUtf8(b);
    }
    // Windows PowerShell 5.1 writes the mark twice to a program's stdin ($OutputEncoding = UTF8): a mark repeated at the start is a mark too
    if (bom !== null) text = text.replace(/^﻿+/, '');
  }
  const nul = bom === null && text.includes('\u0000');
  const warning = invalid
    ? `Warning: ${what} holds bytes that are not ${bom === null || bom === 'utf-8' ? 'UTF-8' : 'UTF-16'}; they are shown as U+FFFD. Save it as UTF-8 and run the command again.`
    : nul
      ? `Warning: ${nulHint(what)}.`
      : null;
  return { text, bom, invalid, nul, warning };
}

/** A file a person or a seat names, read whole (errors as readFileSync throws them). */
export function readInputFile(path: string, what = `the file ${path}`): InputText {
  return decodeInput(readFileSync(path), what);
}
