// Self-check item 8 (design 9.3: the PM session's monitor is woken by a new notice): the probe the live self-check
// loads (MP_PM_MONITOR_PROBE=<this file>, default export; src/seat/selfcheck.ts checkPmMonitor).
//
// It starts the PM's watcher exactly as the PM does (`mp watch-notices`, its own process), waits
// until its watches are in place, raises a probe notice where real notices arrive (the control
// plane's alert copies), and checks that the watcher exits on it, with the notice in its output.
// Probe notices carry their own id prefix: a real watcher running at the same time ignores them,
// and the probe removes its notice afterwards. Whether Claude Code wakes the PM when the
// background command exits is Claude Code's behavior; this probe proves the command's half.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from '../scheduler/controlPlane.ts';
import type { PmMonitorProbe } from '../seat/selfcheck.ts';
import { findConfigPath, loadCliConfig } from './config.ts';
import { markAcknowledged } from './notices.ts';
import { PROBE_PREFIX } from './watch.ts';

const CLI_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

export interface PmMonitorProbeOptions {
  /** The CLI configuration; default: $MP_CONFIG or the installed one. */
  readonly configPath?: string;
  /** How long the watcher may take to wake (default 10 s). */
  readonly wakeLimitMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function pmMonitorProbe(o: PmMonitorProbeOptions = {}): PmMonitorProbe {
  return async () => {
    const env = o.env ?? process.env;
    const path = o.configPath ?? findConfigPath(null, env);
    if (path === null) return { ok: false, detail: 'no CLI configuration (mp install)', events: [] };
    const cfg = loadCliConfig(path);
    const id = `${PROBE_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}`;
    const limit = o.wakeLimitMs ?? 10_000;
    const events: unknown[] = [];
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_MAIN, 'watch-notices', '--probe', id, '--timeout', String(Math.ceil(limit / 1000) + 30), '--json'], {
      env: { ...env, MP_CONFIG: path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let raisedAt = 0;
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => child.on('exit', (code) => resolve({ code, at: Date.now() })));
    const watching = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      child.stderr.setEncoding('utf8').on('data', (x: string) => {
        if (x.includes('watching')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on('exit', () => resolve(false));
    });
    child.stdout.setEncoding('utf8').on('data', (x: string) => (stdout += x));
    try {
      if (!(await watching)) {
        child.kill('SIGKILL');
        return { ok: false, detail: 'the watcher did not start watching within 15 s', events };
      }
      raisedAt = Date.now();
      new ControlPlane(cfg.controlPlane).putAlert({
        format: 'mp4.alert-copy.v1',
        alert: id,
        category: 'selfcheck-probe',
        wi: null,
        key: id,
        trigger: 'startup self-check item 8: a new notice must wake the PM\'s background watcher',
        defaultAction: null,
        detail: { probe: true },
        source: 'selfcheck',
        at: raisedAt,
        committed: false,
      });
      events.push({ raised: id, at: raisedAt });
      const r = await Promise.race([exited, new Promise<null>((res) => setTimeout(() => res(null), limit))]);
      if (r === null) {
        child.kill('SIGKILL');
        return { ok: false, detail: `the watcher did not wake within ${limit} ms of a new notice`, events };
      }
      events.push({ exited: r.code, at: r.at, stdout: stdout.slice(0, 2000) });
      let out: { ok?: boolean; result?: { event?: string; notices?: Array<{ id: string }> } } = {};
      try {
        out = JSON.parse(stdout) as typeof out;
      } catch {
        return { ok: false, detail: `the watcher exited ${r.code} without its JSON report`, events };
      }
      const woke = r.code === 0 && out.result?.event === 'notices' && (out.result.notices ?? []).some((n) => n.id === id);
      return { ok: woke, detail: woke ? `the watcher woke ${r.at - raisedAt} ms after the notice and reported it` : `the watcher exited ${r.code} with ${JSON.stringify(out.result ?? null)}`, events };
    } finally {
      try {
        unlinkSync(join(cfg.controlPlane, 'alerts', `${id}.json`));
      } catch {
        /* not raised */
      }
      try {
        markAcknowledged(cfg.stateDir, [id]);
      } catch {
        /* best effort */
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };
}

export default pmMonitorProbe();
