// The optional Claude Code adapter (plugin/hooks/claude-code.mjs; design 4.1 §6.1, decision 9):
// a prompt is recorded with `mp pm say` and the PM's own `mp pm say` of the same text records
// nothing new; the fixed prompt of a dispatched seat is never recorded as the user's words; outside
// a project it does nothing and never blocks; at session start it prints the handbook core and
// `mp pm next`.

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
  const db = new DatabaseSync(join(dir, '.mission-pipeline', 'memory.db'), { readOnly: true });
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM words').get() as { n: number }).n);
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
      '<task-notification><task-id>b1</task-id></task-notification>',
      '<system-reminder>context</system-reminder>',
      '<command-name>/clear</command-name>',
      'Note: [Subagent hand-back] from D-2',
    ]) {
      const r2 = hook('user-prompt-submit', { prompt, cwd: p.dir }, p.dir);
      assert.deepEqual(r2, { code: 0, out: '' }, prompt);
    }
    assert.equal(words(p.dir), 1);
  });

  it('at session start: the handbook core and mp pm next', () => {
    const r = hook('session-start', { cwd: p.dir }, p.dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /If you are acting as the Mission Pipeline PM/);
    assert.match(r.out, /mp pm say/);
    assert.match(r.out, /\$ mp pm next\n[\s\S]*Notices \(first\)/);
  });

  it('outside a project it prints nothing and exits 0', () => {
    const r = hook('user-prompt-submit', { prompt: 'hello', cwd: p.base }, p.base);
    assert.deepEqual(r, { code: 0, out: '' });
  });
});
