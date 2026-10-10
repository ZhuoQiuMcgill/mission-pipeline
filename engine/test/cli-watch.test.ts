// The PM session's background monitor (design 3.9; self-check item 8): `mp watch-notices`
// wakes on a new notice, a stop's state change, or its time limit, in the hooks' format; it
// is event-driven (inotify), not a poll; `--stream` prints one line per event; and the
// self-check probe proves a new notice makes the watcher exit, while a real watcher running
// at the same time ignores the probe's notice.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runCli } from '../src/cli/main.ts';
import { pmMonitorProbe } from '../src/cli/pmMonitorProbe.ts';
import { ControlPlane, type AlertCopy } from '../src/scheduler/controlPlane.ts';
import { cleanupEnvs, LedgerProc } from './scheduler-fixtures.ts';
import { CLI_MAIN, NODE_ARGS, cliEnv, ioOf, mpJson, type CliEnv } from './cli-fixtures.ts';

const procs: LedgerProc[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill();
  await cleanupEnvs();
});

function alert(env: CliEnv, id: string, wi: string | null = 'WI-14'): void {
  const a: AlertCopy = { format: 'mp4.alert-copy.v1', alert: id, category: 'cleanup-failing', wi, key: id, trigger: `cleanup of ${id} keeps failing`, defaultAction: 'retrying with back-off', detail: {}, source: 'scheduler', at: Date.now(), committed: true };
  new ControlPlane(env.cp).putAlert(a);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('mp watch-notices (3.9)', { timeout: 120_000 }, () => {
  test('blocks until a new notice, prints it in the hooks\' format with its WI page, marks it delivered, exits 0', async () => {
    const env = cliEnv('watch-notice');
    const t0 = Date.now();
    const running = runCli(['watch-notices', '--timeout', '30'], ioOf(env));
    await sleep(300);
    alert(env, 'scheduler.cleanup-failing.1');
    const r = await running;
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(Date.now() - t0 < 5_000, 'woken by the notice, not by the time limit');
    assert.match(r.stdout, /New notices \(1;/);
    assert.match(r.stdout, /scheduler\.cleanup-failing\.1 WI-14 Cleanup keeps failing, or processes cannot be ended \(WI page: .*WI-14\.md\)/);
    assert.match(r.stdout, /start the background watcher again: mp watch-notices/);
    const st = await mpJson(env, 'alerts', '--all', '--json');
    assert.equal(((st.out['result'] as { notices: Array<{ state: string }> }).notices[0]!).state, 'delivered');
  });

  test('a notice already waiting is shown at once; with nothing new the time limit ends it (exit 0, "timeout")', async () => {
    const env = cliEnv('watch-immediate');
    alert(env, 'scheduler.cleanup-failing.2');
    const r = await mpJson(env, 'watch-notices', '--timeout', '30');
    assert.equal((r.out['result'] as { event: string }).event, 'notices');
    const t0 = Date.now();
    const q = await mpJson(env, 'watch-notices', '--timeout', '1');
    assert.equal(q.exitCode, 0);
    assert.equal((q.out['result'] as { event: string }).event, 'timeout');
    assert.ok(Date.now() - t0 >= 900);
  });

  test('a stop\'s state change wakes it (the stop entry, then the ledger committing it)', async () => {
    const env = cliEnv('watch-stop');
    const lp = new LedgerProc(env);
    await lp.start();
    procs.push(lp);
    const running = runCli(['watch-notices', '--timeout', '30', '--json'], ioOf(env));
    await sleep(300);
    const s = await mpJson(env, 'stop', '停');
    assert.equal(s.exitCode, 0);
    const r = JSON.parse((await running).stdout) as { result: { event: string; changes: Array<{ stop: string; to: string }> } };
    assert.equal(r.result.event, 'stops');
    assert.equal(r.result.changes[0]!.stop, (s.out['result'] as { stop: string }).stop);
  });

  test('--stream prints one line per event and keeps watching', async () => {
    const env = cliEnv('watch-stream');
    const child = spawn(process.execPath, [...NODE_ARGS, CLI_MAIN, 'watch-notices', '--stream', '--timeout', '60'], { cwd: env.project, env: ioOf(env).env });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (x: string) => (out += x));
    const lines = (): string[] => out.split('\n').filter((l) => l.startsWith('[Mission Pipeline 4] New notices'));
    const until = async (n: number): Promise<void> => {
      const end = Date.now() + 30_000;
      while (lines().length < n) {
        if (Date.now() > end) throw new Error(`waited for ${n} event lines: ${out}`);
        await sleep(50);
      }
    };
    try {
      alert(env, 'scheduler.cleanup-failing.a');
      await until(1);
      alert(env, 'scheduler.cleanup-failing.b', 'WI-10');
      await until(2);
      assert.match(lines()[0]!, /cleanup-failing\.a WI-14/);
      assert.doesNotMatch(lines()[0]!, /cleanup-failing\.b/);
      assert.match(lines()[1]!, /cleanup-failing\.b WI-10/);
      assert.equal(child.exitCode, null, 'still watching after two events');
    } finally {
      child.kill('SIGTERM');
    }
  });

  test('self-check item 8: the probe proves a new notice makes the watcher exit; a real watcher ignores the probe\'s notice', async () => {
    const env = cliEnv('watch-probe');
    const real = runCli(['watch-notices', '--timeout', '4', '--json'], ioOf(env));
    const r = await pmMonitorProbe({ configPath: env.configPath, env: ioOf(env).env })();
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /woke \d+ ms after the notice/);
    const q = JSON.parse((await real).stdout) as { result: { event: string } };
    assert.equal(q.result.event, 'timeout', 'the probe notice is not shown to the PM');
    const all = await mpJson(env, 'alerts', '--all');
    assert.deepEqual((all.out['result'] as { notices: unknown[] }).notices, [], 'the probe leaves nothing behind');
  });
});
