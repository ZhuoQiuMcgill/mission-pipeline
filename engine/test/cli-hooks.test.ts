// The PM session's Claude Code hooks (design 3.1, 3.9, 6.1, 6.3, 6.4, WI-12; risk 9, risk 28):
// the plugin's hooks.json, the hook input/output JSON, stop detection through the one stop
// entry while the engine is down, the user's words booked once per message id (spooled
// while the ledger cannot take them), the session-start engine start with the layer-0
// summary, the WI-12 question and the risk-28 reminder, and the notices' fallback delivery.

import { afterEach, describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionStartHook, userPromptSubmitHook } from '../src/cli/hooks/handlers.ts';
import { serveLedger } from '../src/ledger/ipc.ts';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { RISK28_REMINDER_EN } from '../src/cli/layer0.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { engineState } from '../src/scheduler/engine.ts';
import { putRecord, tempPair } from './ledger-stops-fixtures.ts';
import { cleanupEnvs, LedgerProc, waitFor, watchdogOptions, writeSchedulerConfig } from './scheduler-fixtures.ts';
import { HOOK_MAIN, PLUGIN_ROOT, cliEnv, ioOf, ledgerCall, runProcess, writeConfig, type CliEnv } from './cli-fixtures.ts';

const procs: LedgerProc[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill();
  await cleanupEnvs();
});

async function ledgerUp(env: CliEnv, o: ConstructorParameters<typeof LedgerProc>[1] = {}): Promise<LedgerProc> {
  const lp = new LedgerProc(env, o);
  await lp.start();
  procs.push(lp);
  return lp;
}

function hookInput(env: CliEnv, event: 'SessionStart' | 'UserPromptSubmit', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: 'sess-1', transcript_path: join(env.root, 'transcript.jsonl'), cwd: env.project, hook_event_name: event, ...extra };
}

function spooled(env: CliEnv): string[] {
  const d = join(env.cliState, 'cli', 'user-words');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')) : [];
}

describe('the plugin (Claude Code plugin hooks format)', () => {
  test('hooks.json: SessionStart and UserPromptSubmit run the launcher from ${CLAUDE_PLUGIN_ROOT} with time limits', () => {
    const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>> };
    assert.deepEqual(Object.keys(h.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
    for (const [event, groups] of Object.entries(h.hooks)) {
      const c = groups[0]!.hooks[0]!;
      assert.equal(c.type, 'command');
      assert.match(c.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/mp-hook/);
      assert.match(c.command, event === 'SessionStart' ? /session-start$/ : /user-prompt-submit$/);
      assert.ok(Number.isInteger(c.timeout) && c.timeout > 0);
    }
    assert.ok(h.hooks['UserPromptSubmit']![0]!.hooks[0]!.timeout <= 30, 'a prompt is never held long');
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string };
    assert.equal(manifest.name, 'mission-pipeline');
    accessSync(join(PLUGIN_ROOT, 'bin', 'mp-hook'), constants.X_OK);
  });

  test('the launcher, outside a PM session: no output, exit 0, stdin consumed', async () => {
    const env = cliEnv('hook-outside');
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(join(PLUGIN_ROOT, 'bin', 'mp-hook'), ['user-prompt-submit'], { cwd: '/', env: { ...process.env, MP_CONFIG: join(env.root, 'missing.json'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
      let stdout = '';
      c.stdout.setEncoding('utf8').on('data', (x: string) => (stdout += x));
      c.on('exit', (code) => resolve({ code, stdout }));
      c.stdin.end(JSON.stringify({ session_id: 's', cwd: '/', hook_event_name: 'UserPromptSubmit', prompt: '停' }));
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, '');
  });
});

describe('the plugin launcher in a PM session', { timeout: 60_000 }, () => {
  test('mp-hook user-prompt-submit, as Claude Code runs it: a stop goes out with the engine down and the hook output is the documented JSON', async () => {
    const env = cliEnv('hook-launcher');
    const lp = await ledgerUp(env);
    await lp.kill();
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn(join(PLUGIN_ROOT, 'bin', 'mp-hook'), ['user-prompt-submit'], { cwd: env.project, env: { ...process.env, MP_CONFIG: env.configPath, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, MP_PM_SESSION: '' } });
      let stdout = '';
      let stderr = '';
      c.stdout.setEncoding('utf8').on('data', (x: string) => (stdout += x));
      c.stderr.setEncoding('utf8').on('data', (x: string) => (stderr += x));
      c.on('exit', (code) => resolve({ code, stdout, stderr }));
      c.stdin.end(JSON.stringify({ session_id: 's', transcript_path: join(env.root, 't.jsonl'), cwd: env.project, hook_event_name: 'UserPromptSubmit', prompt: 'stop everything' }));
    });
    assert.equal(out.code, 0, out.stderr);
    const j = JSON.parse(out.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string }; systemMessage?: string };
    assert.deepEqual(Object.keys(j).sort(), ['hookSpecificOutput', 'systemMessage']);
    assert.deepEqual(Object.keys(j.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    assert.match(j.hookSpecificOutput.additionalContext, /Fast notice sent; persisted \(awaiting commit\)\./);
  });
});

describe('UserPromptSubmit (3.1, 6.4)', { timeout: 120_000 }, () => {
  test('a stop with the engine down: the entry\'s exact message in the PM context and to the user, within the 2 s bound; the words wait, then are booked once', async () => {
    const env = cliEnv('ups-down');
    // install the inbox by opening the ledger once, then take it down
    const lp = await ledgerUp(env);
    await lp.kill();
    const input = { ...hookInput(env, 'UserPromptSubmit'), prompt: '停，先别交付' };
    const r = await runProcess(HOOK_MAIN, ['user-prompt-submit'], { input: JSON.stringify(input), cwd: env.project, env: ioOf(env).env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 8_000, `took ${r.ms} ms`);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string }; systemMessage: string; decision?: unknown };
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out.decision, undefined, 'never blocks the prompt');
    assert.match(out.hookSpecificOutput.additionalContext, /\nFast notice sent; persisted \(awaiting commit\)\.\n/);
    assert.match(out.hookSpecificOutput.additionalContext, /scope: everything/);
    assert.match(out.hookSpecificOutput.additionalContext, /mp stop-release/);
    assert.equal(out.systemMessage, 'Stop: Fast notice sent; persisted (awaiting commit).');
    assert.equal(spooled(env).length, 1, 'the words wait for the ledger');
    // the ledger comes back: the stop is committed from the inbox, the words are booked by the next prompt
    await ledgerUp(env);
    const stops = (await ledgerCall(env, 'activeStops', {})) as Array<{ words: string; scope: { kind: string } }>;
    assert.ok(stops.some((s) => s.words === '停，先别交付' && s.scope.kind === 'all'), JSON.stringify(stops));
    writeFileSync(join(env.root, 'transcript.jsonl'), 'grown\n');
    const next = await userPromptSubmitHook({ ...hookInput(env, 'UserPromptSubmit'), prompt: '继续' }, ioOf(env));
    assert.equal(next.output, null, 'nothing to add: no stop, no notice');
    assert.equal(spooled(env).length, 0);
    const words = (await ledgerCall(env, 'latestUserWords', { limit: 10 })) as Array<{ excerpt: string }>;
    assert.deepEqual(words.map((w) => w.excerpt).sort(), ['停，先别交付', '继续'].sort());
  });

  test('the same message (same transcript) is booked once; a capability stop with the ledger up is committed with its scope', async () => {
    const env = cliEnv('ups-up', { extra: { taggedCapabilities: ['network'] } });
    await ledgerUp(env);
    const input = { ...hookInput(env, 'UserPromptSubmit'), prompt: '不许联网' };
    const a = await userPromptSubmitHook(input, ioOf(env));
    const b = await userPromptSubmitHook(input, ioOf(env));
    assert.equal(a.facts['message'], b.facts['message']);
    assert.match(a.output!.hookSpecificOutput.additionalContext, /scope: capability network/);
    const words = (await ledgerCall(env, 'latestUserWords', { limit: 10 })) as Array<{ message: string }>;
    assert.equal(words.filter((w) => w.message === a.facts['message']).length, 1);
    const stop = (a.facts['stop'] as { stop: string }).stop;
    await waitFor(async () => (await ledgerCall(env, 'stopState', { stop })) === 'active', 10_000, 'committed');
    const stops = (await ledgerCall(env, 'activeStops', {})) as Array<{ stop: string; scope: unknown }>;
    assert.deepEqual(stops.find((s) => s.stop === stop)?.scope, { kind: 'capability', capability: 'network' });
  });

  test('with exactly one open mission, an ordinary prohibition stops that mission, not everything (6.4 "the related mission")', async () => {
    const env = cliEnv('ups-one-mission');
    await ledgerUp(env);
    await ledgerCall(env, 'setMission', { mission: 'm1', state: 'open' });
    for (const prompt of ["Don't change the public API.", '不要改测试文件']) {
      writeFileSync(join(env.root, 'transcript.jsonl'), `${prompt}\n`);
      const r = await userPromptSubmitHook({ ...hookInput(env, 'UserPromptSubmit'), prompt }, ioOf(env));
      assert.deepEqual((r.facts['stop'] as { scope: unknown }).scope, { kind: 'mission', mission: 'm1' }, prompt);
      assert.match(r.output!.hookSpecificOutput.additionalContext, /scope: mission m1 \(a generic stop: restricts all production and delivery of the related mission, m1/);
    }
    await ledgerCall(env, 'setMission', { mission: 'm2', state: 'open' });
    writeFileSync(join(env.root, 'transcript.jsonl'), 'two\n');
    const two = await userPromptSubmitHook({ ...hookInput(env, 'UserPromptSubmit'), prompt: '停' }, ioOf(env));
    assert.deepEqual((two.facts['stop'] as { scope: unknown }).scope, { kind: 'all' }, 'two missions, none named: everything');
  });

  test('outside a registered project the hook does nothing (the session marker, 3.9)', async () => {
    const env = cliEnv('ups-outside');
    const r = await userPromptSubmitHook({ ...hookInput(env, 'UserPromptSubmit'), cwd: env.root, prompt: '停' }, ioOf(env, env.root));
    assert.equal(r.output, null);
    assert.equal(r.facts['pm'], false);
  });

  test('undelivered notices come with the next prompt once (3.9 fallback delivery)', async () => {
    const env = cliEnv('ups-notice');
    await ledgerUp(env);
    new ControlPlane(env.cp).putAlert({ format: 'mp4.alert-copy.v1', alert: 'watchdog.service-restarted.x', category: 'service-restarted', wi: 'WI-22', key: 'k', trigger: 'scheduler restarted by the watchdog: heartbeat lost', defaultAction: 'restarted after the back-off', detail: {}, source: 'watchdog', at: Date.now(), committed: false });
    const a = await userPromptSubmitHook({ ...hookInput(env, 'UserPromptSubmit'), prompt: '进度怎么样' }, ioOf(env));
    assert.match(a.output!.hookSpecificOutput.additionalContext, /WI-22 The watchdog restarted the ledger service or the scheduler/);
    writeFileSync(join(env.root, 'transcript.jsonl'), 'grown\n');
    const b = await userPromptSubmitHook({ ...hookInput(env, 'UserPromptSubmit'), prompt: '好的' }, ioOf(env));
    assert.equal(b.output, null);
  });
});

describe('SessionStart (6.3, WI-12, risk 28)', { timeout: 240_000 }, () => {
  test('starts the engine when the PM opens, then gives layer 0 in the PM context', async () => {
    const env = cliEnv('ss-start');
    const lp = new LedgerProc(env);
    const schedCfg = writeSchedulerConfig(env);
    const wdCfg = join(env.root, 'watchdog.json');
    writeFileSync(wdCfg, JSON.stringify(watchdogOptions(env, lp, schedCfg)));
    const engineCfg = join(env.root, 'engine.json');
    const ec = { watchdogConfig: wdCfg, startTimeoutMs: 60_000, logPath: join(env.root, 'watchdog.log') };
    writeFileSync(engineCfg, JSON.stringify(ec));
    writeConfig(env, { engineConfig: engineCfg });
    let pid: number | null = null;
    try {
      const r = await sessionStartHook(hookInput(env, 'SessionStart', { source: 'startup' }), ioOf(env));
      assert.ok(r.output !== null, JSON.stringify(r.facts));
      const engine = r.facts['engine'] as { started: boolean; running: boolean; watchdogPid: number };
      pid = engine.watchdogPid;
      assert.equal(engine.started, true);
      assert.equal(r.output.hookSpecificOutput.hookEventName, 'SessionStart');
      const ctx = r.output.hookSpecificOutput.additionalContext;
      assert.match(ctx, /The engine was just started/);
      assert.match(ctx, /Engine: running; ledger service available/);
      assert.match(ctx, /Stops: none/);
      // only the handbook's index (maintainer ruling 2026-10-09): one line per WI, and where the pages are
      assert.match(ctx, /# PM work instructions \(WI\): index/);
      assert.match(ctx, /- WI-22: The watchdog restarted the ledger service or scheduler, or restarts are exhausted/);
      assert.match(ctx, /- WI-27: A web fetch was refused/);
      assert.match(ctx, /\(WI pages: .*plugin\/pm\/wi\)/);
      assert.doesNotMatch(ctx, /## Options and outcomes/, 'no page in the standing context');
      // the PM handbook's core only, and the background monitor to start
      assert.match(ctx, /You are the only PM/);
      assert.match(ctx, /mp watch-notices --stream/);
      assert.match(ctx, /\(the full PM handbook: .*plugin\/pm\/PM\.md\)/);
      assert.doesNotMatch(ctx, /## Aligning with the user/, 'the rest of PM.md stays in the file');
      const again = await sessionStartHook(hookInput(env, 'SessionStart', { source: 'resume' }), ioOf(env));
      assert.equal((again.facts['engine'] as { started: boolean }).started, false, 'already running: nothing done');
    } finally {
      if (pid !== null) {
        process.kill(pid, 'SIGTERM');
        await waitFor(() => !engineState(ec).running, 30_000, 'the engine stopped');
      }
    }
  });

  test('a recovery pause: the WI-12 question for the user, never answered by the PM', async () => {
    const env = cliEnv('ss-pause');
    const bootFile = join(env.root, 'boot-id');
    writeFileSync(bootFile, 'boot-A\n');
    const a = await ledgerUp(env, { bootIdFile: bootFile });
    await ledgerCall(env, 'setMission', { mission: 'm1', state: 'open' });
    await a.kill();
    rmSync(env.cp, { recursive: true, force: true });
    writeFileSync(bootFile, 'boot-B\n');
    await ledgerUp(env, { bootIdFile: bootFile });
    const r = await sessionStartHook(hookInput(env, 'SessionStart', { source: 'startup' }), ioOf(env), { start: false });
    const ctx = r.output!.hookSpecificOutput.additionalContext;
    assert.equal(r.facts['wi12'], 'pause');
    assert.match(ctx, /WI-12: after the restart the engine is in the recovery pause/);
    assert.match(ctx, /did you ask to stop or withdraw anything in the PM session or the terminal\?/);
    assert.match(ctx, /While the user is away the pause stays; never answer for the user/);
  });

  test('risk 28 (option A): after an abnormal stop without fault evidence the PM reminds the user, once', async () => {
    const t = tempPair();
    const env = cliEnv('ss-risk28', { backupInbox: join(t.backupDir, 'backup.inbox') });
    const paths = ledgerPaths(env.ledgerRoot, env.cp, { backupInbox: join(t.backupDir, 'backup.inbox') });
    try {
      const a = new LedgerService({ paths, bootId: () => 'boot-A', watchStops: false, inboxSlots: 34 });
      a.open();
      await a.setMission('m1' as never, 'open');
      a.unwatchStops();
      const x = a as unknown as { lock: { release(): void }; store: { close(): void } | null; control: { close(): void } | null };
      x.control?.close();
      x.store?.close();
      x.store = null;
      x.lock.release();
      rmSync(env.cp, { recursive: true, force: true });
      // both probes ran to the end together, no clean exit: an abnormal stop without fault evidence
      putRecord(paths.inbox, 0, { kind: 'probe', boot: 'boot-A', seq: 40, at: 100_000, inbox: 'primary', carried: [] });
      putRecord(join(t.backupDir, 'backup.inbox'), 0, { kind: 'probe', boot: 'boot-A', seq: 41, at: 104_000, inbox: 'backup', carried: [] });
      const b = new LedgerService({ paths, bootId: () => 'boot-B', watchStops: false, inboxSlots: 34 });
      assert.equal(b.open().recoveryPause, false);
      const server = serveLedger(b, env.socket);
      try {
        const r = await sessionStartHook(hookInput(env, 'SessionStart', { source: 'startup' }), ioOf(env), { start: false });
        assert.equal(r.facts['wi12'], 'reminder');
        assert.ok(r.output!.hookSpecificOutput.additionalContext.includes(RISK28_REMINDER_EN));
        const again = await sessionStartHook(hookInput(env, 'SessionStart', { source: 'resume' }), ioOf(env), { start: false });
        assert.equal(again.facts['wi12'], undefined, 'reminded once');
        assert.match(again.output!.hookSpecificOutput.additionalContext, /Went on by itself after the restart \(risk 28, option A\)/, 'level 0 keeps showing it');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        b.close();
      }
    } finally {
      t.cleanup();
    }
  });
});
