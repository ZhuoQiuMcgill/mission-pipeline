// The optional Claude Code adapter (plugin/hooks/claude-code.mjs; design 4.1 §6.1, decision 9):
// a prompt is recorded with `mp pm say` and the PM's own `mp pm say` of the same text records
// nothing new; the fixed prompt of a dispatched seat is never recorded as the user's words; outside
// a project it does nothing and never blocks; at session start (every session, a seat's included)
// it prints a neutral three-line pointer and runs no `mp` command (4.1.2).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ENGINE, cli, gitProject, type TestProject } from './cli-fixtures.ts';

const ADAPTER = join(ENGINE, 'plugin', 'hooks', 'claude-code.mjs');

function hook(event: string, input: unknown, cwd: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(process.execPath, [ADAPTER, event], { cwd, env: {...process.env, MP_SECRETARY: '', ...env}, input: JSON.stringify(input), encoding: 'utf8', timeout: 200_000 });
  return { code: r.status ?? -1, out: r.stdout };
}

function words(dir: string): number {
  return count(dir, 'SELECT COUNT(*) AS n FROM words');
}

function count(dir: string, sql: string): number {
  const db = new DatabaseSync(join(dir, '.mission-pipeline', 'memory.db'), { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe('the optional Claude Code adapter', () => {
  let p: TestProject;
  before(async () => {
    p = gitProject();
    await cli(p.dir, ['init']);
  });
  after(() => p.cleanup());

  it('4.3: only a two-line type/recording reminder; neither prompts nor harness envelopes are recorded', async () => {
    const before = words(p.dir);
    for (const prompt of ['Build me a small calculator.', 'You are the Constructor of Mission Pipeline. Your card: `mp seat D-3 card`.', '<agent-message>hand-back</agent-message>']) {
      const r = hook('user-prompt-submit', {prompt, cwd: p.dir}, p.dir);
      assert.equal(r.code, 0);
      assert.equal(r.out.trim().split('\n').length, 2);
      assert.match(r.out, /message type/);
      assert.match(r.out, /previous message/);
    }
    assert.equal(words(p.dir), before, '4.2 recorded the prompt immediately; 4.3 defers recording to the PM');
    const own = await cli(p.dir, ['pm', 'say', 'Build me a small calculator.', '--json']);
    assert.deepEqual([own.json.result.words, own.json.result.repeated], ['W-1', false]);
  });

  it('B.6: MP_SECRETARY alone controls silence; MP_ROLE has no effect', () => {
    for (const event of ['user-prompt-submit', 'session-start']) {
      assert.deepEqual(hook(event, {prompt: 'hello', cwd: p.dir}, p.dir, {MP_SECRETARY: 'S-1'}), {code: 0, out: ''});
    }
    assert.match(hook('user-prompt-submit', {prompt: 'hello', cwd: p.dir}, p.dir, {MP_ROLE: 'secretary'}).out, /message type/);
  });

  it('4.1.2: at session start, a neutral three-line pointer; no mp command runs (a seat never acts as the PM)', () => {
    const before = [count(p.dir, 'SELECT COUNT(*) AS n FROM log'), count(p.dir, 'SELECT COUNT(*) AS n FROM pm_actions')];
    const r = hook('session-start', { cwd: p.dir }, p.dir);
    assert.equal(r.code, 0);
    assert.equal(
      r.out,
      'This project uses Mission Pipeline.\nIf you are the PM, read the core of `.mission-pipeline/pm/PM.md` and run `mp pm session`.\nIf you were started as a seat, your card (`mp seat <id> card`) is your whole instruction.\n',
    );
    assert.doesNotMatch(r.out, /Notices \(first\)|Ready steps/, 'no PM steps are shown');
    assert.deepEqual([count(p.dir, 'SELECT COUNT(*) AS n FROM log'), count(p.dir, 'SELECT COUNT(*) AS n FROM pm_actions')], before, 'nothing was written: no mp pm next ran');
    // from inside a seat's folder under the project, the same pointer
    const nested = hook('session-start', { cwd: join(p.dir, '.mission-pipeline', 'tmp') }, p.dir);
    assert.equal(nested.out, r.out);
  });

  it('outside a project it prints nothing and exits 0', () => {
    const r = hook('user-prompt-submit', { prompt: 'hello', cwd: p.base }, p.base);
    assert.deepEqual(r, { code: 0, out: '' });
  });
});
