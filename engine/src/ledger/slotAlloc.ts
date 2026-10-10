// Slot allocation with its first-use scan (design v45 6.1 "槽位协议"): the first
// writer of a boot reads the inbox's free slots outside the control-plane lock,
// then allocates under it. Shared by the stop writers and the probes.

import type { ControlState } from './controlState.ts';
import { freeSlots, readInboxSync, type InboxHeader, type InboxName } from './inbox.ts';
import { putControlAlert } from './stops.ts';

export type Allocated = { readonly id: number; readonly slot: number; readonly seq: number } | 'exhausted';

export function allocateSlot(
  control: ControlState,
  req: { file: string; header: InboxHeader; inbox: InboxName; boot: string; kind: string; stop: string | null; owner: string },
): Allocated {
  const ask = (free: readonly number[] | null) => control.allocate({ inbox: req.inbox, boot: req.boot, kind: req.kind, stop: req.stop, owner: req.owner, now: Date.now(), free });
  let r = ask(null);
  if ('needInit' in r) r = ask(freeSlots(req.header, readInboxSync(req.file).slots));
  if ('needInit' in r) throw new Error('slot allocation was not initialized');
  if ('exhausted' in r) {
    // 6.1: a boot that used up the slots fails further writes and raises a WI-12 alert.
    putControlAlert(control.controlPlane, {
      alert: `inbox-slots-exhausted-${req.inbox}-${req.boot.slice(0, 36)}`,
      category: 'inbox-slots-exhausted',
      trigger: `the ${req.inbox} stop inbox used up its slots in boot ${req.boot} (6.1 slot protocol)`,
      defaultAction: 'further writes to this inbox fail and are reported as "not persisted"; stops still take effect through the control plane; the slots are reclaimed at the next start once this boot is processed',
      detail: { inbox: req.inbox, file: req.file, slots: req.header.slots },
      source: req.owner,
    });
    return 'exhausted';
  }
  return r;
}
