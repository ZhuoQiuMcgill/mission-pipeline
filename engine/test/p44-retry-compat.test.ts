// 4.4 compatibility: a command repeated with the same --op is matched against the receipt the earlier
// run stored. For every command p2 touched, a receipt with the identity 4.3 computed (its arguments
// without the new options) replays under 4.4: no OP_CONFLICT, and the recorded result is printed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginAction, endAction } from '../src/cli/project.ts';
import type { ProcessProject } from './process-fixtures.ts';
import { project43, command43, live43, escalation43 } from './p43-fixtures.ts';

async function retried43(p: ProcessProject, identity: string | null, command: string, args43: unknown, argv: string[]): Promise<void> {
  const op = `old-${command.replace(/ /g, '-')}`;
  const action = { op, command, args: identity === null ? args43 : { generation: identity, args: args43 } };
  assert.equal(beginAction(p.ctx.memory, { ...action, filler: null }), null);
  endAction(p.ctx.memory, action, { exitCode: 0, text: `recorded by 4.3 for ${command}`, json: { recorded: command } }, false);
  const r = await command43(p, [...argv, '--op', op], identity);
  assert.equal(r.code, 0, `${command}: ${JSON.stringify(r)}`);
  assert.equal(r.replayed, true, command);
  assert.deepEqual(r.result, { recorded: command });
}

test('compatibility: Secretary commands p2 touched replay a 4.3 receipt with the same --op', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    await retried43(p, id, 'sec next', { positionals: [], flags: {} }, ['sec', 'next']);
    await retried43(p, id, 'sec wait', { positionals: [], flags: { since: '0', timeout: '0' } }, ['sec', 'wait', '--since', '0', '--timeout', '0']);
    await retried43(p, id, 'sec alerts', { positionals: [], flags: {} }, ['sec', 'alerts']);
    await retried43(p, id, 'sec renew', { positionals: [], flags: {} }, ['sec', 'renew']);
    await retried43(p, id, 'sec card', { positionals: ['choice'], flags: {} }, ['sec', 'card', 'choice']);
    await retried43(p, id, 'sec dispatch', { positionals: ['sec.choice'], flags: {} }, ['sec', 'dispatch', 'sec.choice']);
  } finally {
    p.cleanup();
  }
});

test('compatibility: PM commands p2 touched replay a 4.3 receipt with the same --op', async () => {
  const p = project43();
  try {
    await retried43(p, null, 'renew', { positionals: [], flags: {} }, ['pm', 'renew']);
    await retried43(p, null, 'alerts', { positionals: [], flags: {} }, ['pm', 'alerts']);
    await retried43(p, null, 'dispatch', { positionals: ['some.step'], flags: {} }, ['pm', 'dispatch', 'some.step']);
    await retried43(p, null, 'secretary stop', { positionals: ['stop'], flags: { gone: true } }, ['pm', 'secretary', 'stop', '--gone']);
  } finally {
    p.cleanup();
  }
});
