// Conservative stop detection in the user's words (design 6.4: wider rather than narrower, 3.1; risk 9):
// table tests in both languages, the scope rules, and scope parsing and narrowing.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeScope, detectStop, parseScope, scopeWithin, stopScopeFor } from '../src/cli/stopDetect.ts';
import { conservativeScope, knownMissions } from '../src/cli/commands/stops.ts';
import type { Ctx } from '../src/cli/context.ts';

/** A Ctx whose ledger answers each query from `answers` (a function that throws stands for a failed or timed-out query). */
function fakeCtx(answers: Record<string, () => unknown>): Ctx {
  const client = {
    call: async (method: string) => {
      const a = answers[method];
      if (a === undefined) throw new Error(`no ${method}`);
      return a();
    },
    close: () => undefined,
  };
  return { ledger: () => client, config: {} } as unknown as Ctx;
}
const timeout = (): never => {
  throw Object.assign(new Error('the ledger did not answer in time'), { code: 'TIMEOUT' });
};

const POSITIVE_ZH = [
  '停',
  '停一下',
  '先停止所有工作',
  '暂停这个 mission',
  '别做了',
  '别再改这个文件',
  '不要再跑测试了',
  '不要用全局变量',
  '撤回刚才那条需求',
  '撤销上一步',
  '取消这个任务',
  '不许联网',
  '不准推送到 main',
  '禁止删除用户数据',
  '中止交付',
  '终止所有任务',
  '回滚那个改动',
  '算了，先别交付',
  '打住',
];

const POSITIVE_EN = [
  'stop',
  'Stop everything now',
  'please halt the mission',
  'cancel that task',
  "don't push to main",
  'dont touch the database',
  'do not use the network',
  'revert the last change',
  'roll back the delivery',
  'abort',
  'pause the work for a while',
  'withdraw requirement 3',
  'kill it',
  'You must not delete files',
  'no more deliveries today',
  'STOPPED? no, I said stopping now',
];

const NEGATIVE_ZH = ['继续', '现在进度怎么样了', '帮我看一下这个函数', '交付 mission-a', '这个设计很好，按你说的做', '要不要加一个测试？', '把日志格式改成 JSON', '详细说明一下任务 t1'];

const NEGATIVE_EN = ['continue', 'what is the status?', 'deliver mission-a please', 'looks good, go ahead', 'add a stopwatch widget', 'write the tests first', 'the parking lot is full', 'include the details of t1'];

describe('stop detection (6.4: bias to detecting; false positives accepted, misses not)', () => {
  test('Chinese stop, forbid and withdraw phrases are detected', () => {
    for (const s of POSITIVE_ZH) assert.equal(detectStop(s).detected, true, s);
  });
  test('English stop, forbid and withdraw phrases are detected', () => {
    for (const s of POSITIVE_EN) assert.equal(detectStop(s).detected, true, s);
  });
  test('ordinary Chinese messages are not stops', () => {
    for (const s of NEGATIVE_ZH) assert.equal(detectStop(s).detected, false, s);
  });
  test('ordinary English messages are not stops', () => {
    for (const s of NEGATIVE_EN) assert.equal(detectStop(s).detected, false, s);
  });
  test('the triggers are named for the PM', () => {
    assert.deepEqual(detectStop('不许联网').triggers, ['不许']);
    assert.ok(detectStop("don't stop").triggers.includes('stop'));
  });
});

describe('the conservative scope', () => {
  test('a capability-specific form restricts that capability when units are tagged with it', () => {
    const d = detectStop('不许联网');
    assert.equal(d.capability, 'network');
    assert.deepEqual(stopScopeFor('不许联网', d, { tagged: ['network'] }).scope, { kind: 'capability', capability: 'network' });
    assert.deepEqual(stopScopeFor('do not use the network', detectStop('do not use the network'), { tagged: ['network'] }).scope, { kind: 'capability', capability: 'network' });
    // the default: no shared capability vocabulary yet, so it widens (a capability stop could match nothing)
    assert.deepEqual(stopScopeFor('不许联网', d).scope, { kind: 'all' });
  });
  test('a capability units are not reliably tagged with widens to the generic scope (wider rather than narrower)', () => {
    const d = detectStop('不许交付');
    assert.equal(d.capability, 'delivery');
    const s = stopScopeFor('不许交付', d);
    assert.deepEqual(s.scope, { kind: 'all' });
    assert.match(s.why, /widened/);
    // ...unless the installation says units carry it
    assert.deepEqual(stopScopeFor('不许交付', d, { tagged: ['network', 'delivery'] }).scope, { kind: 'capability', capability: 'delivery' });
  });
  test('generic "停": the one mission the words name, else everything', () => {
    const known = ['mission-a', 'mission-b'];
    const o = { knownMissions: known, complete: true };
    assert.deepEqual(stopScopeFor('停 mission-a', detectStop('停 mission-a'), o).scope, { kind: 'mission', mission: 'mission-a' });
    assert.deepEqual(stopScopeFor('停', detectStop('停'), o).scope, { kind: 'all' });
    assert.deepEqual(stopScopeFor('停 mission-a 和 mission-b', detectStop('停 mission-a 和 mission-b'), o).scope, { kind: 'all' });
    assert.deepEqual(stopScopeFor('stop mission-z', detectStop('stop mission-z'), o).scope, { kind: 'all' }, 'an unknown mission is unclear');
    assert.deepEqual(stopScopeFor('停 m10', detectStop('停 m10'), { knownMissions: ['m1', 'm10'], complete: true }).scope, { kind: 'mission', mission: 'm10' }, 'a whole token: "m10" does not name "m1"');
  });
  test('generic "停" with no mission named and exactly one open mission: that mission (missions query)', () => {
    assert.deepEqual(stopScopeFor('停', detectStop('停'), { knownMissions: ['m1'], openMissions: ['m1'], complete: true }).scope, { kind: 'mission', mission: 'm1' });
    assert.deepEqual(stopScopeFor('停', detectStop('停'), { knownMissions: ['m1', 'm2'], openMissions: ['m1', 'm2'], complete: true }).scope, { kind: 'all' });
    assert.deepEqual(stopScopeFor('停 m2', detectStop('停 m2'), { knownMissions: ['m1', 'm2'], openMissions: ['m1'], complete: true }).scope, { kind: 'mission', mission: 'm2' }, 'a named mission wins');
  });
  test('never narrow on doubt: without complete answers, every generic stop is everything (review r1)', () => {
    assert.deepEqual(stopScopeFor('停', detectStop('停'), { knownMissions: ['m1'], openMissions: ['m1'] }).scope, { kind: 'all' }, 'complete defaults to false');
    assert.deepEqual(stopScopeFor('停 m1', detectStop('停 m1'), { knownMissions: ['m1'], openMissions: ['m1'], complete: false }).scope, { kind: 'all' });
  });
  test('reviewer repro: M1 and M2 open, the missions query times out, taskQueue has only M1, no launches: everything', async () => {
    const ctx = fakeCtx({ missions: timeout, taskQueue: () => [{ mission: 'M1' }], launches: () => [] });
    const k = await knownMissions(ctx, 50);
    assert.deepEqual(k, { known: ['M1'], open: ['M1'], complete: false });
    const d = await conservativeScope(ctx, '停');
    assert.deepEqual(d.scope, { kind: 'all' });
    assert.match(d.why, /did not say in time/);
  });
  test('an explicit mission name with failed queries: everything', async () => {
    const ctx = fakeCtx({ missions: timeout, taskQueue: () => [{ mission: 'M1' }], launches: timeout });
    assert.deepEqual((await conservativeScope(ctx, 'stop M1')).scope, { kind: 'all' });
    assert.deepEqual((await conservativeScope(fakeCtx({ missions: () => [{ mission: 'M1' }], taskQueue: () => { throw new Error('boom'); }, launches: () => [] }), '停 M1')).scope, { kind: 'all' }, 'any failed query');
  });
  test('every query answers and one mission is related: that mission; a named one of two: that one', async () => {
    const one = fakeCtx({ missions: () => [{ mission: 'M1' }], taskQueue: () => [{ mission: 'M1' }], launches: () => [] });
    assert.equal((await knownMissions(one, 50)).complete, true);
    assert.deepEqual((await conservativeScope(one, '停')).scope, { kind: 'mission', mission: 'M1' });
    const two = fakeCtx({ missions: () => [{ mission: 'M1' }, { mission: 'M2' }], taskQueue: () => [], launches: () => [{ tag: { mission: 'M2' } }] });
    assert.deepEqual((await conservativeScope(two, '停')).scope, { kind: 'all' });
    assert.deepEqual((await conservativeScope(two, 'stop M2 please')).scope, { kind: 'mission', mission: 'M2' });
  });
  test('two capabilities named: generic', () => {
    const d = detectStop('不许联网也不许交付');
    assert.equal(d.capability, null);
    assert.deepEqual(stopScopeFor('不许联网也不许交付', d).scope, { kind: 'all' });
  });
});

describe('scope parsing and narrowing (6.4 "再收窄")', () => {
  test('parse', () => {
    assert.deepEqual(parseScope('all'), { kind: 'all' });
    assert.deepEqual(parseScope('mission:m1'), { kind: 'mission', mission: 'm1' });
    assert.deepEqual(parseScope('capability:network'), { kind: 'capability', capability: 'network' });
    assert.equal(parseScope('everything'), null);
    assert.equal(describeScope({ kind: 'mission', mission: 'm1' as never }), 'mission m1');
  });
  test('only inside the old scope', () => {
    assert.equal(scopeWithin({ kind: 'mission', mission: 'm1' as never }, { kind: 'all' }), true);
    assert.equal(scopeWithin({ kind: 'capability', capability: 'network' }, { kind: 'all' }), true);
    assert.equal(scopeWithin({ kind: 'all' }, { kind: 'mission', mission: 'm1' as never }), false);
    assert.equal(scopeWithin({ kind: 'mission', mission: 'm2' as never }, { kind: 'mission', mission: 'm1' as never }), false);
  });
});
