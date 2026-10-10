// `mp watch-notices` (design 3.9; self-check item 8): the PM session's background monitor.
//
// One-shot (default): blocks until there is something for the PM, prints it and exits 0, so
// a Claude Code background command's completion wakes the PM; the PM handles it and starts
// the watcher again. `--stream`: never exits by itself (until --timeout); prints one line per
// event, for Claude Code's Monitor tool, which delivers each output line to the session.

import { flagBool, flagStr } from '../args.ts';
import type { Command } from '../command.ts';
import { ok } from '../command.ts';
import { usage } from '../errors.ts';
import { renderWatchEvent, watchAndDeliver, watchOnce, type WatchEvent } from '../watch.ts';
import { markDelivered } from '../notices.ts';

function eventJson(e: WatchEvent): unknown {
  switch (e.kind) {
    case 'notices':
      return { event: 'notices', notices: e.notices.map((n) => ({ id: n.id, wi: n.wi, category: n.category, trigger: n.trigger, defaultAction: n.defaultAction, at: n.at })) };
    case 'stops':
      return { event: 'stops', changes: e.changes };
    case 'recovery':
      return { event: 'recovery', recoveryPause: e.to.recoveryPause, storageFault: e.to.storageFault };
    case 'timeout':
      return { event: 'timeout', waitedMs: e.waitedMs };
  }
}

export const watchNoticesCmd: Command = {
  name: 'watch-notices',
  summary: 'the PM\'s background watcher: waits for a new notice, a stop state change or a recovery change, shows it and exits (--stream: one line per event, keeps running)',
  usage: 'mp watch-notices [--timeout <seconds>] [--stream]',
  flags: { timeout: 'string', stream: 'boolean', probe: 'string' },
  changesState: false,
  async run(ctx, args) {
    const t = flagStr(args, 'timeout');
    const timeoutMs = t === null ? null : Number(t) * 1000;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw usage('--timeout is a positive number (seconds)');
    const probe = flagStr(args, 'probe');
    const json = flagBool(args, 'json');
    const onWatching = probe !== null ? () => process.stderr.write('watching\n') : undefined;
    if (!flagBool(args, 'stream')) {
      const r = await watchAndDeliver(ctx.config, ctx.content(), { timeoutMs, probe, ...(onWatching ? { onWatching } : {}) }, ctx.io.env);
      return ok(r.text, eventJson(r.event));
    }
    // --stream: one line per event until the time limit
    const end = timeoutMs === null ? null : Date.now() + timeoutMs;
    for (;;) {
      const left = end === null ? null : end - Date.now();
      if (left !== null && left <= 0) break;
      const e = await watchOnce(ctx.config, ctx.content(), { timeoutMs: left, probe, ...(onWatching ? { onWatching } : {}) });
      if (e.kind === 'timeout') break;
      const r = renderWatchEvent(e, ctx.io.env);
      markDelivered(ctx.config.stateDir, r.delivered, ctx.now);
      process.stdout.write(json ? `${JSON.stringify(eventJson(e))}\n` : `${r.text.replace(/\n/g, ' | ')}\n`);
    }
    return ok('Watching ended (time limit reached); start again: mp watch-notices --stream', { event: 'timeout' });
  },
};
