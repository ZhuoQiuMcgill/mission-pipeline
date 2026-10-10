// The decision after a reboot (design v45 6.1 "开机后的处理", "异常重启后暂停";
// WI-12; risk 28 decided as option A).
//
// After every new boot id, the ledger service first commits every stop both
// inboxes hold, then looks at the evidence each previous boot not yet processed
// left in the inboxes:
//
//   fault evidence: an unended fault record; a torn write; the two inboxes' last
//     probes more than 20 s apart; an inbox that cannot be read
//       → recovery pause when work could advance automatically (WI-12: ask the user)
//   clean exit on every configured inbox, no fault evidence → go on
//   abnormal stop, no fault evidence, a backup inbox configured
//       → go on, and the PM reminds the user (risk 28, option A)
//   abnormal stop, no backup inbox → recovery pause when work could advance
//
// A clean exit of the ledger service alone is not a clean machine shutdown (core
// review r3 #13): only the probes' clean-exit records, written after the seal and
// the ledger's last drain, count.

import type { BootEvidence, StartupBasis } from '../common/records.ts';
import { InboxUnreadable, readInboxSync, type InboxHeader, type InboxName, type SlotContent } from './inbox.ts';

/** WI-12's reminder when going on after an abnormal stop (risk 28, option A). */
export const RISK28_REMINDER = "Any stop sent before the restart that you did not see confirmed as 'persisted' (including ones shown as 'not persisted'): please say it again if you still want it.";

export const PROBE_GAP_LIMIT_MS = 20_000;

export interface InboxScan {
  readonly name: InboxName;
  readonly file: string;
  readonly readable: boolean;
  readonly error: string | null;
  readonly header: InboxHeader | null;
  readonly slots: readonly SlotContent[];
}

export function scanInbox(name: InboxName, file: string): InboxScan {
  try {
    const { header, slots } = readInboxSync(file);
    return { name, file, readable: true, error: null, header, slots };
  } catch (e) {
    return { name, file, readable: false, error: e instanceof InboxUnreadable ? e.message : (e as Error).message, header: null, slots: [] };
  }
}

/** Boots the inboxes hold records (or attributable torn writes) of, other than the current one. */
export function bootsInInboxes(scans: readonly InboxScan[], current: string): Set<string> {
  const out = new Set<string>();
  for (const sc of scans) {
    for (const c of sc.slots) {
      const b = c.state === 'record' ? c.record.boot : c.state === 'torn' ? c.boot : null;
      if (b !== null && b !== current) out.add(b);
      if (c.state === 'record' && c.record.kind === 'probe') for (const x of c.record.carried) if (x.boot !== current) out.add(x.boot);
    }
  }
  return out;
}

/**
 * Torn slots whose boot cannot be read, and that were not allocated in the
 * current boot (a write of this boot may simply be in progress).
 */
export function unattributedTorn(scan: InboxScan, currentSlots: ReadonlySet<number>): number[] {
  const out: number[] = [];
  scan.slots.forEach((c, i) => {
    if (c.state === 'torn' && c.boot === null && !currentSlots.has(i)) out.push(i);
  });
  return out;
}

export function evaluateBoot(boot: string, scans: readonly InboxScan[], opts: { backupConfigured: boolean; currentSlots: ReadonlyMap<InboxName, ReadonlySet<number>>; probeGapMs?: number }): BootEvidence {
  const limit = opts.probeGapMs ?? PROBE_GAP_LIMIT_MS;
  const cleanExit: string[] = [];
  const openFaults: string[] = [];
  const unreadable: string[] = [];
  const lastProbes: Record<string, number | null> = {};
  let torn = 0;
  let unattributed = 0;
  let stops = 0;
  for (const sc of scans) {
    if (!sc.readable || sc.header === null) {
      unreadable.push(sc.name);
      lastProbes[sc.name] = null;
      continue;
    }
    const faults = new Set<string>();
    const ended = new Set<string>();
    let last: number | null = null;
    sc.slots.forEach((c, i) => {
      if (c.state === 'torn') {
        if (c.boot === boot) torn++;
        else if (c.boot === null && !(opts.currentSlots.get(sc.name)?.has(i) ?? false)) unattributed++;
        return;
      }
      if (c.state !== 'record') return;
      const r = c.record;
      if (r.kind === 'probe') {
        if (r.boot === boot) last = Math.max(last ?? r.at, r.at);
        for (const x of r.carried) if (x.boot === boot) last = Math.max(last ?? x.at, x.at);
        return;
      }
      if (r.boot !== boot) return;
      if (r.kind === 'clean-exit') cleanExit.push(sc.name);
      else if (r.kind === 'fault') faults.add(r.fault);
      else if (r.kind === 'fault-end') ended.add(r.fault);
      else if (r.kind === 'stop') stops++;
    });
    for (const f of faults) if (!ended.has(f)) openFaults.push(`${sc.name}:${f}`);
    lastProbes[sc.name] = last;
  }
  // Probe gap: only when both inboxes are configured; one with probes and the other without is a gap too.
  let probeGapMs: number | null = null;
  let oneSided = false;
  if (opts.backupConfigured && unreadable.length === 0) {
    const p = lastProbes.primary ?? null;
    const b = lastProbes.backup ?? null;
    if (p !== null && b !== null) probeGapMs = Math.abs(p - b);
    else if ((p === null) !== (b === null)) oneSided = true;
  }
  const fault = unreadable.length > 0 || openFaults.length > 0 || torn > 0 || unattributed > 0 || oneSided || (probeGapMs !== null && probeGapMs > limit);
  const configured = scans.map((s) => s.name);
  const clean = configured.every((n) => cleanExit.includes(n));
  const row: BootEvidence['row'] = fault ? 'fault-evidence' : clean ? 'clean-shutdown' : opts.backupConfigured ? 'abnormal-stop-spare-inbox' : 'abnormal-stop-no-spare-inbox';
  return { boot, row, cleanExit, openFaults, tornWrites: torn, unattributedTorn: unattributed, lastProbes, probeGapMs, probesOneSided: oneSided, unreadable, stops };
}

const SEVERITY: Readonly<Record<BootEvidence['row'], number>> = {
  'clean-shutdown': 0,
  'abnormal-stop-spare-inbox': 1,
  'abnormal-stop-no-spare-inbox': 2,
  'fault-evidence': 3,
};

/** The decision over every boot processed now: the most severe row decides. */
export function decideStartup(
  evidence: readonly BootEvidence[],
  work: StartupBasis['work'],
): { pause: boolean; row: StartupBasis['evidence']; reminder: string | null } {
  let row: BootEvidence['row'] = 'clean-shutdown';
  for (const e of evidence) if (SEVERITY[e.row] > SEVERITY[row]) row = e.row;
  const anyWork = work.openMission || work.undecidedLaunch || work.unsettledIntent || work.queuedTask;
  const pause = anyWork && (row === 'fault-evidence' || row === 'abnormal-stop-no-spare-inbox');
  const reminder = !pause && evidence.some((e) => e.row === 'abnormal-stop-spare-inbox') ? RISK28_REMINDER : null;
  return { pause, row, reminder };
}

/** Slots of the processed boots to zero (reclaim, 6.1): their records, attributable torn writes, and unattributed torn writes counted now. */
export function reclaimableSlots(scan: InboxScan, processed: ReadonlySet<string>, currentSlots: ReadonlySet<number>, includeUnattributed: boolean): number[] {
  const out: number[] = [];
  if (!scan.readable || scan.header === null) return out;
  scan.slots.forEach((c, i) => {
    if (i < scan.header!.probeSlots) return; // the probe's own slots alternate; their content is carried, never reclaimed
    if (c.state === 'record' && processed.has(c.record.boot)) out.push(i);
    else if (c.state === 'torn' && c.boot !== null && processed.has(c.boot)) out.push(i);
    else if (c.state === 'torn' && c.boot === null && includeUnattributed && !currentSlots.has(i)) out.push(i);
  });
  return out;
}
