// Code review r1 finding 6 (design 6.2 "交回之后这一回合结束"): the seat's tools are one serialized
// entry; a hand-back closes the round BEFORE its result is persisted; exactly one hand-back
// wins; submit_result against request_evidence is decided by arrival order; a call queued behind
// a hand-back never runs; a call already running is finished before the hand-back is confirmed.
// The handlers called here are the very ones the SDK's MCP server calls (no model, no IPC).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProgramTools } from '../src/exec/tools.ts';
import { parseSeatCard, type SeatCard } from '../src/seat/card.ts';
import { buildSeatServer, type CallToolResult, type EvidenceRequest, type SeatToolHooks } from '../src/seat/mcpTools.ts';
import type { SeatResult } from '../src/seat/results.ts';

const card = (over: Record<string, unknown> = {}): SeatCard =>
  parseSeatCard({
    format: 'mp4.seat-card.v1',
    launch: 'L1',
    mission: 'M1',
    module: null,
    capabilities: [],
    duties: '',
    decisionQuotes: [],
    constraints: [],
    workspace: { snapshot: '/tmp/snap', writablePaths: ['src'] },
    limits: { run: { memoryMax: 1 << 28 }, areaBytes: 1 << 24, export: { maxLogicalBytes: 1 << 20, maxFiles: 10 }, recoveryStateBytes: 1 << 20 },
    seat: 'constructor',
    goal: 'g',
    standards: [{ id: 'S1', text: 's' }],
    requirementItems: [],
    readableFiles: [],
    interpreter: '',
    verificationCommands: [],
    interfaces: { implements: [], calls: [] },
    allowAsyncEvidence: true,
    ...over,
  });

const result = (done: string) => ({ done, unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
const evidenceReq: EvidenceRequest = { steps: ['measure'], data: '', measure: [], assertions: [] };

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** Tools whose write waits for `gate` (an in-flight call), recording what ran and when. */
function fakeTools(events: string[], gate?: Promise<void>): ProgramTools {
  return {
    async writeFile(a: { path: string }) {
      events.push(`write-start ${a.path}`);
      if (gate !== undefined) await gate;
      events.push(`write-end ${a.path}`);
      return { ok: true, value: { path: a.path, bytes: 1, created: true } };
    },
    async readFile(a: { path: string }) {
      events.push(`read ${a.path}`);
      return { ok: true, value: { path: a.path, size: 1, offset: 0, encoding: 'utf8', content: { text: 'x', truncated: false, originalBytes: 1 } } };
    },
  } as unknown as ProgramTools;
}

function server(hooks: Partial<SeatToolHooks>, tools: ProgramTools = fakeTools([])) {
  const full: SeatToolHooks = {
    log: () => undefined,
    context: { snapshot: { lines: () => null } },
    onSubmit: async () => 'ack',
    ...hooks,
  };
  const s = buildSeatServer(card(), tools, full);
  const call = (name: string, args: unknown): Promise<CallToolResult> => (s.handlers.get(name) as (a: unknown) => Promise<CallToolResult>)(args);
  return { ...s, call };
}

const isRefusedAsOver = (r: CallToolResult): boolean => r.isError === true && /This round is over/.test(r.content[0]?.text ?? '');

describe('finding 6: one hand-back wins', () => {
  test("the reviewer's repro: two concurrent submits with a slow persistence; only the first is persisted and acknowledged", async () => {
    const submissions: string[] = [];
    const persist = deferred();
    const s = server({
      async onSubmit(r: SeatResult) {
        submissions.push((r.result as { done: string }).done);
        await persist.promise;
        return 'ack';
      },
    });
    const first = s.call('submit_result', result('first'));
    const second = s.call('submit_result', result('second'));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(submissions, ['first'], 'the second never entered the hand-back while the first was persisting');
    assert.equal(s.closedReason(), 'result submitted', 'closed before the persistence finished');
    persist.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.isError, undefined);
    assert.ok(isRefusedAsOver(b));
    assert.deepEqual(submissions, ['first']);
  });

  test('with an immediate persistence too: one acknowledgement, the second refused, the first result final', async () => {
    let final = '';
    const s = server({
      async onSubmit(r: SeatResult) {
        final = (r.result as { done: string }).done;
        return 'ack';
      },
    });
    const acks = await Promise.all([s.call('submit_result', result('first')), s.call('submit_result', result('second'))]);
    assert.deepEqual(acks.map((r) => r.isError === true), [false, true]);
    assert.equal(final, 'first');
  });

  test('submit against request_evidence: arrival order decides, deterministically, both ways', async () => {
    for (const firstIs of ['submit', 'evidence'] as const) {
      const seen: string[] = [];
      const s = server({
        async onSubmit() {
          seen.push('submit');
          return 'ack';
        },
        async onEvidenceRequest(_r: EvidenceRequest) {
          seen.push('evidence');
          await new Promise((r) => setTimeout(r, 30));
          return { accepted: true, message: 'saved' };
        },
      });
      const calls = firstIs === 'submit' ? [s.call('submit_result', result('x')), s.call('request_evidence', evidenceReq)] : [s.call('request_evidence', evidenceReq), s.call('submit_result', result('x'))];
      const [a, b] = await Promise.all(calls);
      assert.deepEqual(seen, [firstIs], `${firstIs} first`);
      assert.equal(a?.isError, undefined);
      assert.ok(b !== undefined && isRefusedAsOver(b));
      assert.equal(s.closedReason(), firstIs === 'submit' ? 'result submitted' : 'evidence requested');
    }
  });

  test('a call queued behind a hand-back never runs; a call already running finishes before the hand-back is confirmed', async () => {
    const events: string[] = [];
    const writeGate = deferred();
    const s = server(
      {
        async onSubmit() {
          events.push('persist');
          return 'ack';
        },
      },
      fakeTools(events, writeGate.promise),
    );
    const write1 = s.call('write_file', { path: 'src/a', content: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    const submit = s.call('submit_result', result('done'));
    const write2 = s.call('write_file', { path: 'src/b', content: 'b' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, ['write-start src/a'], 'the hand-back waits for the write in flight');
    writeGate.release();
    const [w1, sub, w2] = await Promise.all([write1, submit, write2]);
    assert.equal(w1.isError, undefined);
    assert.equal(sub.isError, undefined);
    assert.ok(isRefusedAsOver(w2), 'the write queued behind the hand-back is refused');
    assert.deepEqual(events, ['write-start src/a', 'write-end src/a', 'persist'], 'src/b was never written');
  });

  test('a persistence failure reopens the round; a refused evidence request too', async () => {
    let n = 0;
    const s = server({
      async onSubmit() {
        if (n++ === 0) throw new Error('the content store is full');
        return 'ack';
      },
      async onEvidenceRequest() {
        return { accepted: false, message: 'Not accepted: over the recovery cap' };
      },
    });
    const ev = await s.call('request_evidence', evidenceReq);
    assert.equal(ev.isError, true);
    assert.equal(s.closedReason(), null);
    const failed = await s.call('submit_result', result('x'));
    assert.equal(failed.isError, true);
    assert.match(failed.content[0]?.text ?? '', /Not recorded: the content store is full/);
    assert.equal(s.closedReason(), null);
    const ok = await s.call('submit_result', result('x'));
    assert.equal(ok.isError, undefined);
    assert.equal(s.closedReason(), 'result submitted');
  });

  test('an invalid hand-back is refused without closing the round', async () => {
    const s = server({});
    const bad = await s.call('submit_result', { done: '', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(bad.isError, true);
    assert.equal(s.closedReason(), null);
  });
});
