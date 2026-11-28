// 4.4.1 (Windows): "occurs verbatim in the recorded words" does not depend on the line ending. Text
// piped or read from a file on Windows carries CRLF and is recorded as given (P-3); a quote typed with
// LF that spans a line break must still match it, and the reverse. A CRLF and an LF count as the same
// line break on both sides; what is recorded never changes. A quote that matched before still matches
// (the plain comparison is tried first), so nothing that was accepted is refused (R2).

function lf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** Whether `quote` occurs verbatim in `text`, a CRLF and an LF counting as the same line break. */
export function occursVerbatim(text: string, quote: string): boolean {
  return text.includes(quote) || lf(text).includes(lf(quote));
}
