// The detached inbox writer for one stop request and one inbox (design v45 6.1
// "停止请求的送达" steps 1-3).
//
//   node --experimental-strip-types src/ledger/stopWriter.ts <job JSON>
//
// stopEntry starts one per configured inbox and waits at most 2 seconds for any
// of them. The writer takes its slot under the control-plane lock (once; it never
// writes another slot), writes the record and fdatasyncs, and marks the write in
// the control plane. A failed attempt is marked at once (so the entry can stop
// waiting when every inbox failed) and retried with backoff until it succeeds or
// the machine stops (the memory filesystem of the control plane disappears).

import { existsSync } from 'node:fs';
import { ControlState } from './controlState.ts';
import { encodeSlot, readHeader, stopRecord, writeSlotSync, type InboxHeader, type InboxName } from './inbox.ts';
import { allocateSlot } from './slotAlloc.ts';
import type { StopRequest } from './stopTypes.ts';

export interface StopWriterJob {
  readonly controlPlane: string;
  readonly boot: string;
  readonly entry: string;
  readonly inbox: InboxName;
  readonly file: string;
  readonly request: StopRequest;
  /** Tests: wait this long before the first write (a hanging disk). */
  readonly delayMs?: number;
  /** Tests: give up after this long. */
  readonly lifetimeMs?: number | null;
}

const CELL = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => void Atomics.wait(CELL, 0, 0, ms);

function main(): void {
  const job = JSON.parse(process.argv[2] ?? '{}') as StopWriterJob;
  const started = Date.now();
  let control: ControlState | null = null;
  let header: InboxHeader | null = null;
  let alloc: { id: number; slot: number; seq: number } | null = null;
  let failedOnce = false;
  if ((job.delayMs ?? 0) > 0) sleep(job.delayMs ?? 0);
  for (let delay = 100; ; delay = Math.min(delay * 2, 5_000)) {
    if (!existsSync(job.controlPlane)) process.exit(0); // the machine is stopping: the memory filesystem is gone
    if (job.lifetimeMs !== null && job.lifetimeMs !== undefined && Date.now() - started > job.lifetimeMs) process.exit(4);
    try {
      control ??= new ControlState(job.controlPlane);
      if (!failedOnce) control.setWrite(job.entry, job.inbox, 'started', null, Date.now());
      header ??= readHeader(job.file);
      if (alloc === null) {
        const a = allocateSlot(control, { file: job.file, header, inbox: job.inbox, boot: job.boot, kind: 'stop', stop: job.request.stop, owner: `entry:${job.entry}` });
        if (a === 'exhausted') {
          control.setWrite(job.entry, job.inbox, 'exhausted', null, Date.now());
          process.exit(3);
        }
        alloc = a;
      }
      const rec = stopRecord(header.slotSize, { boot: job.boot, seq: alloc.seq, at: Date.now(), inbox: job.inbox, entry: job.entry }, job.request);
      writeSlotSync(job.file, header, alloc.slot, encodeSlot(header.slotSize, rec));
      control.markSlot(alloc.id, 'written');
      control.setWrite(job.entry, job.inbox, 'written', alloc.id, Date.now());
      process.exit(0);
    } catch {
      if (!failedOnce) {
        failedOnce = true;
        try {
          control?.setWrite(job.entry, job.inbox, 'failed', alloc?.id ?? null, Date.now());
          if (alloc) control?.markSlot(alloc.id, 'failed');
        } catch {
          /* the entry then waits out its limit */
        }
      }
      sleep(delay);
    }
  }
}

main();
