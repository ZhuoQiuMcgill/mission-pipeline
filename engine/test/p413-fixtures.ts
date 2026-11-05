// Shared helpers of the 4.1.3 P4 tests (runs, detached runs, constraints).

import assert from 'node:assert/strict';
import { cal1Pass } from '../src/flow/scripted.ts';
import { pmDispatch, pmMission, pmPlan, pmRequirement, pmSay, type ProcessContext } from '../src/process/index.ts';
import { recordEvidenceRequest } from '../src/process/seat.ts';
import { readAll, readyOf, step } from './process-fixtures.ts';

/** A mission whose exploration X1 asks for an experiment running `command`: the experiment executor's dispatch. */
export async function experimentDispatch(ctx: ProcessContext, m: string, command: string): Promise<string> {
  pmMission(ctx, m);
  const w = pmSay(ctx, `Find a cache design with no obvious logical hole. The details are yours to decide. (${m})`).words;
  await pmRequirement(ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  await pmPlan(ctx, {
    mission: m,
    words: [w],
    plan: {
      format: 'mp4.pm-plan.v1',
      mission: m,
      round: 1,
      order: 'free',
      elements: [
        {
          id: 'x',
          kind: 'exploration',
          text: 'Design the cache',
          provenance: { by: 'user', words: w, quote: 'Find a cache design' },
          exploration: { id: 'X1', deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: 'structure' }, budget: { rounds: 3, micros: null }, stop: '', research: false },
          after: [],
          items: [],
        },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
  const s = await readyOf(ctx, 'researcher-author');
  const author = pmDispatch(ctx, s.step);
  readAll(ctx, author.dispatch);
  const a = await recordEvidenceRequest(ctx, author.dispatch, { request: { steps: ['run the probe'], data: 'the repository', measure: ['status'], assertions: ['the probe prints a status'], executor: 'experiment', commands: [{ id: 'probe', command }] }, notes: 'need a run' });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  const x = await readyOf(ctx, 'constructor-experiment');
  const d = pmDispatch(ctx, x.step);
  readAll(ctx, d.dispatch);
  return d.dispatch;
}

