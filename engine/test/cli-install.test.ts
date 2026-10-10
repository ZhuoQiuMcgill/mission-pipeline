// `mp install` (design 9.6, 6.1, 7.1, 9.3; WI-18): the dry run writes nothing; an install
// into temp dirs writes the engine's configuration and both stop inboxes, records
// degradations only with the user's explicit consent, and the engine it configured
// starts (6.3) and takes the install states; --model puts every seat on one model. No system
// configuration is touched: no user service is installed, the inbox and control plane are temp
// dirs, no model runs.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { probeHeartbeatPath } from '../src/ledger/probe.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/main.ts';
import { loadCliConfig } from '../src/cli/config.ts';
import { chooseBackupInbox, installBlocker, planInstall } from '../src/cli/commands/install.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { readHeader } from '../src/ledger/inbox.ts';
import { engineState } from '../src/scheduler/engine.ts';
import { DEFAULT_MODEL_CONFIG, loadModelConfig } from '../src/seat/modelConfig.ts';
import { cheapestModel } from '../src/seat/selfcheckLive.ts';
import { makeEnv, waitFor } from './scheduler-fixtures.ts';

const dirs: string[] = [];
function temp(prefix: string, base = tmpdir()): string {
  const d = mkdtempSync(join(base, prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function io(cwd: string) {
  return { cwd, env: { ...process.env, MP_CONFIG: '' }, now: Date.now };
}

describe('mp install (9.6)', { timeout: 300_000 }, () => {
  test('--dry-run reports the checks and the plan and writes nothing', async () => {
    const t = temp('mp-cli-install-dry-');
    const root = join(t, 'root');
    const cfg = join(t, 'engine4.json');
    const r = await runCli(['install', '--dry-run', '--root', root, '--config', cfg, '--project', t, '--no-backup-inbox', '--json'], io(t));
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { result: { dryRun: boolean; plan: { checks: Array<{ item: string; ok: boolean }>; files: Record<string, unknown>; backup: { file: string | null } } } };
    assert.equal(out.result.dryRun, true);
    assert.deepEqual(out.result.plan.checks.map((c) => c.item), ['git', 'systemd-user', 'node', 'seat-credentials', 'flow-project', 'dependencies', 'socket-paths', 'cgroup', 'bubblewrap', 'fuse2fs', 'ledger-fs', 'control-plane', 'backup-inbox']);
    assert.equal(out.result.plan.backup.file, null);
    assert.ok(Object.keys(out.result.plan.files).includes(cfg));
    assert.equal(existsSync(root), false, 'nothing written');
    assert.equal(existsSync(cfg), false);
    const text = await runCli(['install', '--dry-run', '--root', root, '--config', cfg, '--no-backup-inbox'], io(t));
    assert.match(text.stdout, /^Install dry run \(nothing was written\): /);
    assert.match(text.stdout, /there is no second volume for the backup stop inbox/, 'the consequence is told (6.1)');
  });

  test('a root whose socket paths would pass 107 bytes is refused with a clear message; the test fixtures fail the same way', async () => {
    const t = temp('mp-cli-install-long-');
    const root = join(t, 'x'.repeat(90));
    const r = await runCli(['install', '--root', root, '--config', join(t, 'c.json'), '--no-backup-inbox', '--no-start', '--skip-selfcheck', '--json'], io(t));
    assert.equal(r.exitCode, 3, r.stdout);
    const err = (JSON.parse(r.stdout) as { error: { code: string; message: string } }).error;
    assert.equal(err.code, 'INSTALL_BLOCKED');
    assert.match(err.message, /scheduler\.sock is \d+ bytes; at most 107 are allowed/);
    assert.match(err.message, /choose a shorter --root$/);
    assert.equal(existsSync(join(t, 'c.json')), false, 'nothing written');
    const saved = process.env['TMPDIR'];
    const long = join(t, 'y'.repeat(80));
    mkdirSync(long);
    process.env['TMPDIR'] = long;
    try {
      assert.throws(() => makeEnv('long'), /at most 107 are allowed: set a shorter TMPDIR/);
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
    }
  });

  test('--credentials api-key:<VAR> is refused in 4.0 (seats use the subscription login), before anything is written', async () => {
    const t = temp('mp-cli-install-apikey-');
    const r = await runCli(['install', '--root', join(t, 'root'), '--config', join(t, 'c.json'), '--credentials', 'api-key:ANTHROPIC_API_KEY', '--no-backup-inbox', '--no-start', '--skip-selfcheck', '--json'], io(t));
    assert.equal(r.exitCode, 64, r.stdout);
    const err = (JSON.parse(r.stdout) as { error: { code: string; message: string } }).error;
    assert.equal(err.code, 'UNSUPPORTED_CREDENTIALS');
    assert.match(err.message, /4\.0 seats use the Claude Code subscription login.*API-key seats come in a later version/);
    assert.equal(existsSync(join(t, 'root')), false, 'nothing written');
    assert.equal((await runCli(['install', '--dry-run', '--root', join(t, 'root'), '--config', join(t, 'c.json'), '--credentials', 'none', '--no-backup-inbox'], io(t))).exitCode, 0, 'none is still accepted');
  });

  test('--model puts every seat on that model (a new file, then the existing one rewritten); a non-Claude id is refused before anything is written', async () => {
    const t = temp('mp-cli-install-model-');
    const root = join(t, 'root');
    const cfg = join(t, 'c.json');
    const models = join(root, 'config', 'model_config.json');
    const common = ['--root', root, '--config', cfg, '--project', t, '--control-plane', join(t, 'cp'), '--no-backup-inbox', '--bin-dir', join(t, 'bin'), '--no-start', '--skip-selfcheck', '--json'];
    // refused before anything is written: a non-Claude id, --effort alone, an unknown effort
    const bad = await runCli(['install', ...common, '--model', 'gpt-5'], io(t));
    assert.equal(bad.exitCode, 64, bad.stdout);
    const err = (JSON.parse(bad.stdout) as { error: { code: string; message: string } }).error;
    assert.equal(err.code, 'BAD_MODEL_CONFIG');
    assert.match(err.message, /--model "gpt-5" cannot be used; nothing was written: .*a seat model is any Claude model id/);
    assert.equal(existsSync(root), false, 'nothing written');
    assert.equal(existsSync(cfg), false);
    assert.equal((await runCli(['install', ...common, '--effort', 'low'], io(t))).exitCode, 64, '--effort goes with --model');
    assert.equal((await runCli(['install', ...common, '--model', 'opus', '--effort', 'extreme'], io(t))).exitCode, 64);
    assert.equal(existsSync(root), false);
    const dry = await runCli(['install', '--dry-run', '--root', root, '--config', cfg, '--no-backup-inbox', '--model', 'sonnet'], io(t));
    assert.equal(dry.exitCode, 0, dry.stdout);
    assert.match(dry.stdout, /model_config\.json \(every seat on sonnet\)/);
    assert.equal(existsSync(root), false, 'the dry run writes nothing');

    // a new install: every seat on the alias, at the given effort
    const r = await runCli(['install', ...common, '--model', 'sonnet', '--effort', 'medium'], io(t));
    assert.equal((JSON.parse(r.stdout) as { result: { installed: boolean } }).result.installed, true, r.stdout);
    type Seats = Record<string, { provider: string; model: string; effort?: string; maxOutputTokens?: number }>;
    const seats = (): Seats => (JSON.parse(readFileSync(models, 'utf8')) as { seats: Seats }).seats;
    assert.deepEqual(Object.keys(seats()), Object.keys(DEFAULT_MODEL_CONFIG.seats));
    for (const [seat, m] of Object.entries(seats())) assert.deepEqual(m, { provider: 'anthropic', model: 'sonnet', effort: 'medium', maxOutputTokens: 32_000 }, seat);
    // the live self-check probes the cheapest seat model: with every seat on one model, that model
    assert.equal(cheapestModel(loadModelConfig(models)).model, 'sonnet');

    // install again with another model: the existing file is rewritten, the effort kept (not given)
    const r2 = await runCli(['install', ...common, '--model', 'claude-haiku-4-5-20251001'], io(t));
    assert.equal((JSON.parse(r2.stdout) as { result: { installed: boolean } }).result.installed, true, r2.stdout);
    for (const m of Object.values(seats())) assert.deepEqual([m.model, m.effort], ['claude-haiku-4-5-20251001', 'medium']);
    // a refused --model leaves the existing file as it was
    const before = readFileSync(models, 'utf8');
    assert.equal((await runCli(['install', ...common, '--model', 'gpt-5'], io(t))).exitCode, 64);
    assert.equal(readFileSync(models, 'utf8'), before);
    // without --model an existing file is left as it is
    await runCli(['install', ...common], io(t));
    assert.equal(readFileSync(models, 'utf8'), before);
  });

  test('git too old or missing, and no systemd user instance, make install refuse early with the fix named', () => {
    const base = { root: '/tmp/mpc-x', configPath: '/tmp/mpc-x/c.json', controlPlane: '/dev/shm/mpc-x', project: null, targetBranch: 'main', backup: { file: null, why: 'none', vhdxDrive: null }, accepted: [], caps: detectExecCapabilities() } as const;
    const old = planInstall({ ...base, wsl: false, git: { path: '/usr/bin/git', version: '2.39.5' }, systemdUser: true });
    const g = installBlocker(old);
    assert.equal(g?.item, 'git');
    assert.match(g!.detail, /git 2\.39\.5 at \/usr\/bin\/git is too old: 2\.44\.0 or later is needed \(--attr-source needs 2\.40, GIT_NO_LAZY_FETCH 2\.44\)/);
    assert.equal(installBlocker(planInstall({ ...base, wsl: false, git: null, systemdUser: true }))?.item, 'git');
    assert.equal(installBlocker(planInstall({ ...base, wsl: false, git: { path: '/usr/bin/git', version: '2.44.0' }, systemdUser: true })), undefined, '2.44.0 is enough');
    const wsl = installBlocker(planInstall({ ...base, wsl: true, git: { path: '/usr/bin/git', version: '2.53.0' }, systemdUser: false }));
    assert.equal(wsl?.item, 'systemd-user');
    assert.match(wsl!.detail, /systemd=true under \[boot\] in \/etc\/wsl\.conf, then run wsl --shutdown/);
    assert.match(installBlocker(planInstall({ ...base, wsl: false, git: { path: '/usr/bin/git', version: '2.53.0' }, systemdUser: false }))!.detail, /loginctl enable-linger/);
  });

  test('the backup inbox is chosen on another device (Linux) or reported missing', () => {
    const c = chooseBackupInbox(join(tmpdir(), 'x', 'ledger'), { wsl: false });
    if (c.file !== null) assert.match(c.file, /backup\.inbox$/);
    else assert.ok(c.why.length > 0);
  });

  test('install into temp dirs: configuration, both inboxes, consented degradations only; the engine it configured starts and takes the install states', async () => {
    const t = temp('mp-cli-install-');
    const backupDir = temp('mp-cli-install-backup-', '/var/tmp');
    const root = join(t, 'root');
    const cfg = join(t, 'engine4.json');
    // the project is a git repository with a commit: the flows compose on it
    const repo = join(t, 'repo');
    mkdirSync(repo);
    const g = (a: string[]): void => void execFileSync('/usr/bin/git', a, { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: t, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.invalid' } });
    g(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g(['add', 'a.txt']);
    g(['commit', '-q', '-m', 'base']);
    const r = await runCli(
      ['install', '--root', root, '--config', cfg, '--project', repo, '--control-plane', join(t, 'cp'), '--backup-inbox', join(backupDir, 'backup.inbox'), '--accept-degradation', 'resource-limits', '--credentials', 'subscription', '--bin-dir', join(t, 'bin'), '--no-start', '--skip-selfcheck', '--json'],
      io(t),
    );
    const out = JSON.parse(r.stdout) as { result: { installed: boolean; accepted: string[] } };
    assert.equal(out.result.installed, true, r.stdout);
    assert.deepEqual(out.result.accepted, ['resource-limits']);
    const c = loadCliConfig(cfg);
    assert.equal(c.backupInbox, join(backupDir, 'backup.inbox'));
    assert.deepEqual(c.projects.map((p) => p.root), [repo]);
    assert.equal(readHeader(join(c.ledgerRoot, 'stop-inbox', 'primary.inbox')).inbox, 'primary');
    assert.equal(readHeader(join(backupDir, 'backup.inbox')).inbox, 'backup');
    const inboxes = JSON.parse(readFileSync(join(c.ledgerRoot, 'stop-inbox', 'inboxes.json'), 'utf8')) as { backup: string };
    assert.equal(inboxes.backup, join(backupDir, 'backup.inbox'));
    const pending = JSON.parse(readFileSync(join(c.stateDir, 'cli', 'install-states-pending.json'), 'utf8')) as Array<{ item: string; accepted: boolean; by: string }>;
    assert.deepEqual(pending.filter((s) => s.accepted).map((s) => [s.item, s.by]), [['degradation:resource-limits', 'user']], 'only what the user accepted');
    const sched = JSON.parse(readFileSync(join(root, 'config', 'scheduler.json'), 'utf8')) as {
      evaluator: { acceptedDegradations: string[] };
      flow?: { repo: string; workDir: string; userHome?: string };
      seats?: { selfCheckDir: string; credentials: { kind: string; source?: string }; modelConfig: string; install: { format: string } };
    };
    assert.deepEqual(sched.evaluator.acceptedDegradations, ['resource-limits']);
    // B1: the flows and the seats are configured (without them the scheduler runs no flow and dispatches no seat)
    assert.deepEqual([sched.flow?.repo, sched.flow?.workDir, sched.flow?.userHome], [repo, join(root, 'flow-work'), process.env['HOME']]);
    assert.equal(sched.seats?.selfCheckDir, c.selfCheckDir);
    assert.equal(sched.seats?.modelConfig, c.modelConfig);
    assert.equal(sched.seats?.credentials.kind, 'subscription');
    assert.equal(sched.seats?.install.format, 'mp4.exec-install.v1');
    // W2: the probes are given as the watchdog reads them
    const wd = JSON.parse(readFileSync(join(root, 'config', 'watchdog.json'), 'utf8')) as { probes: Array<{ inbox: string; file: string; other: string | null }> };
    assert.deepEqual(wd.probes.map((x) => [x.inbox, x.file, x.other]), [['primary', join(c.ledgerRoot, 'stop-inbox', 'primary.inbox'), 'backup'], ['backup', join(backupDir, 'backup.inbox'), 'primary']]);
    assert.match(readlinkSync(join(t, 'bin', 'mp')), /plugin\/bin\/mp$/, 'mp on the PM\'s PATH');

    // without consent, no degradation is recorded as accepted
    const t2 = temp('mp-cli-install-noconsent-');
    const r2 = await runCli(['install', '--root', join(t2, 'root'), '--config', join(t2, 'c.json'), '--project', t2, '--control-plane', join(t2, 'cp'), '--no-backup-inbox', '--bin-dir', join(t2, 'bin'), '--no-start', '--skip-selfcheck', '--json'], io(t2));
    const c2 = loadCliConfig(join(t2, 'c.json'));
    const p2 = JSON.parse(readFileSync(join(c2.stateDir, 'cli', 'install-states-pending.json'), 'utf8')) as Array<{ accepted: boolean }>;
    assert.equal(p2.filter((s) => s.accepted).length, 0, r2.stdout);

    // the engine the install configured starts when the PM opens (6.3), and records the install states
    const env = { ...process.env, MP_CONFIG: cfg };
    const engineCfg = JSON.parse(readFileSync(c.engineConfig!, 'utf8')) as { watchdogConfig: string };
    try {
      const up = await runCli(['ensure-running', '--json'], { cwd: t, env, now: Date.now });
      assert.equal(up.exitCode, 0, up.stdout + up.stderr);
      assert.equal((JSON.parse(up.stdout) as { result: { started: boolean } }).result.started, true);
      // W2: both inbox probes run under the watchdog and beat (the safety net while the ledger is down)
      await waitFor(() => existsSync(probeHeartbeatPath(c.controlPlane, 'primary')) && existsSync(probeHeartbeatPath(c.controlPlane, 'backup')), 30_000, 'both probe heartbeats');
      // B1: the flows composed on the project (the scheduler's flow RPC no longer answers "runs without the flows")
      await waitFor(async () => {
        const l = await runCli(['legalize', 'request', 'm1', 'no-such-object', '--words', 'x', '--json'], { cwd: t, env, now: Date.now });
        return !/runs without the flows/.test(l.stdout);
      }, 30_000, 'the flows composed');
      const st = JSON.parse((await runCli(['status', '--json'], { cwd: t, env, now: Date.now })).stdout) as { result: { ledger: { reachable: boolean }; isolation: { accepted: string[] } } };
      assert.equal(st.result.ledger.reachable, true);
      assert.ok(st.result.isolation.accepted.includes('degradation:resource-limits=accepted'), JSON.stringify(st.result.isolation));
      const left = JSON.parse(readFileSync(join(c.stateDir, 'cli', 'install-states-pending.json'), 'utf8')) as unknown[];
      assert.equal(left.length, 0, 'the ledger took every install state');
      const stop = await runCli(['stop', '停', '--json'], { cwd: t, env, now: Date.now });
      assert.equal(stop.exitCode, 0, 'both inboxes written');
      assert.deepEqual((JSON.parse(stop.stdout) as { result: { inboxes: Record<string, string> } }).result.inboxes.primary === 'written' || (JSON.parse(stop.stdout) as { result: { inboxes: Record<string, string> } }).result.inboxes.backup === 'written', true);
    } finally {
      const s = engineState(engineCfg);
      if (s.watchdogPid !== null) {
        process.kill(s.watchdogPid, 'SIGTERM');
        await waitFor(() => !engineState(engineCfg).running, 60_000, 'the engine stopped');
      }
    }
  });
});
