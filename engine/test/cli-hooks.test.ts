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

function hook(event: string, input: unknown, cwd: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [ADAPTER, event], { cwd, input: JSON.stringify(input), encoding: 'utf8', timeout: 200_000 });
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

  it('records each prompt once; the PM\'s own mp pm say of the same text records nothing new; a seat\'s fixed prompt is never recorded', async () => {
    const r = hook('user-prompt-submit', { prompt: 'Build me a small calculator.', cwd: p.dir }, p.dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /Recorded as W-1/);
    const again = await cli(p.dir, ['pm', 'say', 'Build me a small calculator.', '--json']);
    assert.deepEqual([again.json.result.words, again.json.result.repeated], ['W-1', true]);
    const seat = hook('user-prompt-submit', { prompt: 'You are the Constructor of Mission Pipeline. Your card: `mp seat D-3 card`.', cwd: p.dir }, p.dir);
    assert.equal(seat.code, 0);
    assert.equal(seat.out, '');
    // harness envelopes are not the user's words either
    for (const prompt of [
      '<agent-message from="general-purpose">[Subagent hand-back] The Calibrator passed the plan.</agent-message>',
      '<cross-session-message from="uds:/run/user/1000/sock" from-name="Secretary">Plan passed; D-4 is running.</cross-session-message>',
      '<task-notification><task-id>b1</task-id></task-notification>',
      '<ci-monitor-event>Checks failed on the pull request.</ci-monitor-event>',
      '<system-reminder>context</system-reminder>',
      '<command-name>/clear</command-name>',
      'Note: [Subagent hand-back] from D-2',
    ]) {
      const r2 = hook('user-prompt-submit', { prompt, cwd: p.dir }, p.dir);
      assert.deepEqual(r2, { code: 0, out: '' }, prompt);
    }
    assert.equal(words(p.dir), 1);
  });

  it('4.1.2: at session start, a neutral three-line pointer; no mp command runs (a seat never acts as the PM)', () => {
    const before = [count(p.dir, 'SELECT COUNT(*) AS n FROM log'), count(p.dir, 'SELECT COUNT(*) AS n FROM pm_actions')];
    const r = hook('session-start', { cwd: p.dir }, p.dir);
    assert.equal(r.code, 0);
    assert.equal(
      r.out,
      'This project uses Mission Pipeline.\nIf you are the PM, read the core of `.mission-pipeline/pm/PM.md` and run `mp pm next`.\nIf you were started as a seat, your card (`mp seat <id> card`) is your whole instruction.\n',
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
