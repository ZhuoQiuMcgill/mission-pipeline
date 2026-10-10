// Inbox probes (design v45 6.1 "收件箱探针", "干净退出记录").
//
// One probe per inbox, an independent process the watchdog starts (probe-main.ts):
// it never needs the ledger service, so it keeps working while the service is
// stuck on the ledger's disk.
//   - every interval (10 s) it writes a probe record into one of its two
//     dedicated slots (alternating) and fdatasyncs, then updates its heartbeat in
//     the control plane;
//   - it watches the other probe's heartbeat: stale beyond 20 s → a fault record
//     "the other inbox is faulty since T" in its own inbox;
//   - its own write failing or taking beyond 20 s → once it can write again, a
//     fault record "I could not write from T1 to T2";
//   - "fault ended" only when the faulty side is back AND no stop in the staging
//     copy is uncommitted, and only within the same boot (a new boot lost the
//     staging copy, so it can never prove that);
//   - at a clean shutdown: once the seal is set, every entry registered before it
//     has ended, the staging copy holds no uncommitted stop, and the ledger
//     service has exited cleanly after the seal, it writes "clean exit"; within 30 s
//     of the seal or not at all.
// The probe records of earlier boots its slots held are carried in every new probe
// record, so the startup decision still sees them after the slots are overwritten.

import { mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import { ControlState } from './controlState.ts';
import { encodeSlot, readHeader, readSlotsAsync, writeSlotAsync, type InboxHeader, type InboxName, type InboxRecord } from './inbox.ts';
import { allocateSlot } from './slotAlloc.ts';
import { stagingClean } from './stops.ts';

export interface ProbeConfig {
  readonly inbox: InboxName;
  readonly file: string;
  /** The other configured inbox, whose probe this one watches; null when there is only one. */
  readonly other: InboxName | null;
  readonly controlPlane: string;
  readonly boot: string;
  readonly intervalMs?: number;
  readonly staleMs?: number;
  /** The clean-exit deadline after the seal (30 s). */
  readonly shutdownMs?: number;
  readonly now?: () => number;
}

export interface ProbeHeartbeat {
  readonly inbox: InboxName;
  readonly pid: number;
  readonly boot: string;
  readonly seq: number;
  readonly at: number;
}

export function probeHeartbeatPath(controlPlane: string, inbox: InboxName): string {
  return join(controlPlane, 'probes', `${inbox}.json`);
}

export function readProbeHeartbeat(controlPlane: string, inbox: InboxName): ProbeHeartbeat | null {
  try {
    return JSON.parse(readFileSync(probeHeartbeatPath(controlPlane, inbox), 'utf8')) as ProbeHeartbeat;
  } catch {
    return null;
  }
}

type PendingFault = { subject: 'self' | 'other'; other: InboxName | null; from: number; to: number | null };
interface OpenFault {
  readonly id: string;
  readonly subject: 'self' | 'other';
  recovered: boolean;
}

export class InboxProbe {
  readonly cfg: ProbeConfig;
  private readonly control: ControlState;
  private header: InboxHeader | null = null;
  private seq = 0;
  private carried: Array<{ boot: string; at: number; seq: number }> = [];
  private startedAt = 0;
  private selfFailSince: number | null = null;
  private readonly pending: PendingFault[] = [];
  private readonly open: OpenFault[] = [];
  private otherFault: OpenFault | null = null;
  private otherPending = false;
  private readonly interval: number;
  private readonly stale: number;
  private readonly now: () => number;

  constructor(cfg: ProbeConfig) {
    this.cfg = cfg;
    this.control = new ControlState(cfg.controlPlane);
    this.interval = cfg.intervalMs ?? 10_000;
    this.stale = cfg.staleMs ?? 20_000;
    this.now = cfg.now ?? Date.now;
  }

  get intervalMs(): number {
    return this.interval;
  }

  /** Read the earlier boots' probe records this inbox's probe slots hold, to carry them on. */
  async start(): Promise<void> {
    this.startedAt = this.now();
    try {
      this.header = readHeader(this.cfg.file);
      const slots = await readSlotsAsync(this.cfg.file, this.header, [0, 1]);
      const byBoot = new Map<string, { at: number; seq: number }>();
      const note = (boot: string, at: number, seq: number): void => {
        const cur = byBoot.get(boot);
        if (!cur || at > cur.at) byBoot.set(boot, { at, seq });
      };
      for (const c of slots.values()) {
        if (c.state !== 'record' || c.record.kind !== 'probe') continue;
        if (c.record.boot !== this.cfg.boot) note(c.record.boot, c.record.at, c.record.seq);
        else this.seq = Math.max(this.seq, c.record.seq + 1);
        for (const x of c.record.carried) if (x.boot !== this.cfg.boot) note(x.boot, x.at, x.seq);
      }
      this.carried = [...byBoot.entries()]
        .map(([boot, v]) => ({ boot, ...v }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 8);
    } catch {
      /* unreadable now: the first tick records the fault */
    }
  }

  private heartbeat(at: number): void {
    try {
      mkdirSync(join(this.cfg.controlPlane, 'probes'), { recursive: true });
      const hb: ProbeHeartbeat = { inbox: this.cfg.inbox, pid: process.pid, boot: this.cfg.boot, seq: this.seq, at };
      writeFileAtomic(probeHeartbeatPath(this.cfg.controlPlane, this.cfg.inbox), JSON.stringify(hb));
    } catch {
      /* the other probe then sees this one as faulty */
    }
  }

  /** Allocate a slot and write one record into this probe's inbox. */
  private async writeRecord(make: (seq: number) => InboxRecord): Promise<void> {
    this.header ??= readHeader(this.cfg.file);
    const a = allocateSlot(this.control, { file: this.cfg.file, header: this.header, inbox: this.cfg.inbox, boot: this.cfg.boot, kind: 'probe-record', stop: null, owner: `probe:${this.cfg.inbox}` });
    if (a === 'exhausted') throw new Error('the inbox slots are exhausted');
    await writeSlotAsync(this.cfg.file, this.header, a.slot, encodeSlot(this.header.slotSize, make(a.seq)));
    this.control.markSlot(a.id, 'written');
  }

  /** One probe cycle. */
  async tick(): Promise<void> {
    const { boot, inbox } = this.cfg;
    const t0 = this.now();
    let ok = false;
    try {
      this.header ??= readHeader(this.cfg.file);
      const seq = this.seq++;
      const rec: InboxRecord = { kind: 'probe', boot, seq, at: t0, inbox, carried: this.carried };
      await writeSlotAsync(this.cfg.file, this.header, seq % 2, encodeSlot(this.header.slotSize, rec));
      ok = true;
    } catch {
      ok = false;
    }
    const t1 = this.now();
    if (!ok || t1 - t0 > this.stale) this.selfFailSince ??= t0;
    if (ok) {
      this.heartbeat(t1);
      if (this.selfFailSince !== null) {
        this.pending.push({ subject: 'self', other: null, from: this.selfFailSince, to: t1 });
        this.selfFailSince = null;
      }
    }
    // The other probe.
    if (this.cfg.other !== null) {
      const hb = readProbeHeartbeat(this.cfg.controlPlane, this.cfg.other);
      const last = hb !== null && hb.boot === boot ? hb.at : null;
      const ref = last ?? this.startedAt;
      const stale = this.now() - ref > this.stale;
      if (stale && this.otherFault === null && !this.otherPending) {
        this.pending.push({ subject: 'other', other: this.cfg.other, from: ref, to: null });
        this.otherPending = true;
      }
      if (!stale && this.otherFault !== null) this.otherFault.recovered = true;
    }
    if (!ok) return;
    // Fault records waiting for this inbox to be writable.
    while (this.pending.length > 0) {
      const f = this.pending[0]!;
      const id = `${inbox}-${randomBytes(6).toString('hex')}`;
      try {
        await this.writeRecord((seq) => ({ kind: 'fault', boot, seq, at: this.now(), inbox, fault: id, subject: f.subject, other: f.other, from: f.from, to: f.to }));
      } catch {
        return;
      }
      this.pending.shift();
      const of: OpenFault = { id, subject: f.subject, recovered: f.subject === 'self' };
      this.open.push(of);
      if (f.subject === 'other') {
        this.otherFault = of;
        this.otherPending = false;
      }
    }
    // "Fault ended": the faulty side is back and no staged stop is uncommitted (same boot only: this process).
    const closable = this.open.filter((f) => f.recovered);
    if (closable.length === 0) return;
    let clean = false;
    try {
      clean = stagingClean(this.cfg.controlPlane, this.control);
    } catch {
      clean = false;
    }
    if (!clean) return;
    for (const f of closable) {
      try {
        await this.writeRecord((seq) => ({ kind: 'fault-end', boot, seq, at: this.now(), inbox, fault: f.id }));
      } catch {
        return;
      }
      this.open.splice(this.open.indexOf(f), 1);
      if (this.otherFault === f) this.otherFault = null;
    }
  }

  /** Faults recorded and not yet ended (tests, status). */
  openFaults(): ReadonlyArray<{ id: string; subject: 'self' | 'other'; recovered: boolean }> {
    return this.open.map((f) => ({ ...f }));
  }

  /**
   * Clean shutdown (v45 6.1 step 4): wait for the seal, the entries registered
   * before it, a clean staging copy and the ledger's clean exit after the seal;
   * then write "clean exit". Returns whether it was written (never after the deadline).
   */
  async shutdown(): Promise<boolean> {
    const { boot, inbox } = this.cfg;
    const limit = this.cfg.shutdownMs ?? 30_000;
    const t0 = this.now();
    for (;;) {
      const sealAt = this.control.sealOf(boot);
      const deadline = (sealAt ?? t0) + limit;
      if (this.now() > deadline) return false;
      if (sealAt !== null) {
        const entriesDone = this.control.openEntriesBeforeSeal(boot).length === 0;
        const exit = this.control.ledgerExit(boot);
        const ledgerOk = exit !== null && exit.clean && exit.at >= sealAt;
        let staging = false;
        try {
          staging = stagingClean(this.cfg.controlPlane, this.control);
        } catch {
          staging = false;
        }
        if (entriesDone && ledgerOk && staging) {
          try {
            await this.writeRecord((seq) => ({ kind: 'clean-exit', boot, seq, at: this.now(), inbox, sealedAt: sealAt }));
            return true;
          } catch {
            return false;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.control.close();
  }
}
