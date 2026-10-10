// Output caps for what a seat gets back from a program tool (design 7.1, "宿主一侧的写入也有上限"):
// every tool result is capped and the cut is marked with the original length; the
// unit's tool-output log keeps its head and its tail.

export interface CappedText {
  /** Decoded text. When truncated, it ends with (or, head+tail, contains) the truncation marker. */
  readonly text: string;
  readonly truncated: boolean;
  /** Length in bytes of the complete output before truncation. */
  readonly originalBytes: number;
}

export function truncationMarker(originalBytes: number): string {
  return `[output truncated, original length ${originalBytes} bytes]`;
}

/** Longest prefix of at most `max` bytes that does not end inside a UTF-8 sequence. */
export function utf8Prefix(buf: Uint8Array, max: number): Uint8Array {
  if (max <= 0) return buf.subarray(0, 0);
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/** Longest suffix of at most `max` bytes that does not start inside a UTF-8 sequence. */
export function utf8Suffix(buf: Uint8Array, max: number): Uint8Array {
  if (max <= 0) return buf.subarray(buf.length);
  if (buf.length <= max) return buf;
  let start = buf.length - max;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

const lossy = new TextDecoder('utf-8');

export function decodeLossy(buf: Uint8Array): string {
  return lossy.decode(buf);
}

export function capBytes(buf: Uint8Array, cap: number): CappedText {
  if (buf.length <= cap) return { text: decodeLossy(buf), truncated: false, originalBytes: buf.length };
  return {
    text: `${decodeLossy(utf8Prefix(buf, cap))}\n${truncationMarker(buf.length)}`,
    truncated: true,
    originalBytes: buf.length,
  };
}

export function capText(s: string, cap: number): CappedText {
  return capBytes(Buffer.from(s, 'utf8'), cap);
}

/** Collects a byte stream, keeping the first `cap` bytes and counting everything. */
export class HeadCollector {
  private readonly cap: number;
  private readonly keep: number;
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private total = 0;

  constructor(cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError(`bad cap ${cap}`);
    this.cap = cap;
    this.keep = cap + 4; // look-ahead so a cut never splits a UTF-8 sequence unnoticed
  }

  push(chunk: Uint8Array): void {
    this.total += chunk.length;
    if (this.kept >= this.keep) return;
    const room = this.keep - this.kept;
    const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(Buffer.from(part));
    this.kept += part.length;
  }

  get totalBytes(): number {
    return this.total;
  }

  result(): CappedText {
    const head = Buffer.concat(this.chunks);
    if (this.total <= this.cap) return { text: decodeLossy(head), truncated: false, originalBytes: this.total };
    return {
      text: `${decodeLossy(utf8Prefix(head, this.cap))}\n${truncationMarker(this.total)}`,
      truncated: true,
      originalBytes: this.total,
    };
  }
}

/**
 * Collects a byte stream keeping its first `headCap` and last `tailCap` bytes (the unit's
 * tool-output log, 7.1: "超出时只保留开头与结尾，并作同样的标记").
 */
export class HeadTailCollector {
  private readonly headCap: number;
  private readonly tailCap: number;
  private all: Buffer[] | null = [];
  private allBytes = 0;
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;

  constructor(headCap: number, tailCap: number) {
    if (!Number.isSafeInteger(headCap) || headCap < 0 || !Number.isSafeInteger(tailCap) || tailCap < 0) {
      throw new RangeError('bad caps');
    }
    this.headCap = headCap;
    this.tailCap = tailCap;
  }

  push(chunk: Uint8Array): void {
    this.total += chunk.length;
    if (this.all !== null) {
      this.all.push(Buffer.from(chunk));
      this.allBytes += chunk.length;
      if (this.allBytes <= this.headCap + this.tailCap + 8) return;
      const whole = Buffer.concat(this.all);
      this.all = null;
      this.head = Buffer.from(whole.subarray(0, this.headCap + 4));
      this.tail = Buffer.from(whole.subarray(Math.max(0, whole.length - (this.tailCap + 4))));
      return;
    }
    const joined = Buffer.concat([this.tail, chunk]);
    this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - (this.tailCap + 4))));
  }

  get totalBytes(): number {
    return this.total;
  }

  result(): CappedText {
    if (this.all !== null) {
      return { text: decodeLossy(Buffer.concat(this.all)), truncated: false, originalBytes: this.total };
    }
    return {
      text: `${decodeLossy(utf8Prefix(this.head, this.headCap))}\n${truncationMarker(this.total)}\n${decodeLossy(
        utf8Suffix(this.tail, this.tailCap),
      )}`,
      truncated: true,
      originalBytes: this.total,
    };
  }
}
