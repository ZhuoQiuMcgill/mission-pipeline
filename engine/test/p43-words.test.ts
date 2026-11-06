import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { planReviewsWaiver } from '../src/flow/waivers.ts';
import { taggedWords, residentRecords, wordsAuthority } from '../src/memory/words.ts';
import { wordsEntry } from '../src/memory/index.ts';
import { pmLayer1 } from '../src/cli/pmMemory.ts';
import { project43, done43, command43, live43 } from './p43-fixtures.ts';
import { startAddMission, step, addDetailedPlan } from './process-fixtures.ts';
import { cal1Pass } from '../src/flow/scripted.ts';

test('tags have stable ids and verbatim quotes; composite instructions record all tags immediately; legacy entries stay untyped', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const legacy = await done43(p, ['pm','say','legacy words']);
    assert.equal(taggedWords(p.ctx.memory, p.ctx.memory.data)[0]?.tags.length, 0);
    const composite = await done43(p, ['pm','say','Stop. Keep the interface small, stable.','--tag','instruction:"Stop."','--tag','principle:"Keep the interface small, stable."','--tag','decision@m1']);
    const tags = taggedWords(p.ctx.memory, p.ctx.memory.data).find((w) => w.words === composite.words)!.tags;
    assert.deepEqual(tags.map((t) => t.id), ['W-2#1','W-2#2','W-2#3']);
    assert.equal(tags[1]?.quote, 'Keep the interface small, stable.');
    assert.doesNotMatch(pmLayer1(p.ctx), /W-2#1/, 'one-off instructions do not remain in layer 1');
    assert.equal((await done43(p, ['read','words','--tag','instruction','--in-force'])).words.length, 0);
    assert.equal((await command43(p, ['pm','tag',legacy.words,'--tag','principle:"invented quote"'])).error.code, 'NOT_ALLOWED');
    await done43(p, ['pm','tag',legacy.words,'--tag','principle']);
    assert.equal((await command43(p, ['pm','tag',legacy.words,'--tag','decision'])).error.code, 'NOT_ALLOWED');
    const read = await done43(p, ['read','words','--tag','principle','--in-force','--grep','small']);
    assert.equal(read.words.length, 1);
    assert.equal((await done43(p, ['read','words','--mission','m1'])).words[0].tags[0].type, 'decision');
    assert.match(JSON.stringify(await done43(p, ['read','show','words',composite.words])), /small, stable/);
  } finally {p.cleanup();}
});

test('entry-level supersession requires explicit withdraw/keep for every item, constraint, authorization and active waiver', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Build the result. Details are yours. Skip plan reviews.','--tag','requirement@m1','--tag','decision@m1']);
    await done43(p, ['pm','requirement','add','m1','goal','--type','goal','--text','result','--quote','Build the result','--words',w.words]);
    await done43(p, ['pm','requirement','add','m1','auth','--type','authorization','--text','details','--quote','Details are yours','--words',w.words]);
    await done43(p, ['pm','constraint','add','small','--kind','object','--text','small','--paths','**','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w.words]);
    const before = Number(p.ctx.memory.head());
    const base = ['pm','say','Build a different result','--tag','requirement@m1','--supersedes',`${w.words}#1`];
    const refused = await command43(p, base);
    assert.equal(refused.error.code, 'NOT_ALLOWED');
    const deps = refused.error.detail?.dependencies;
    assert.ok(deps?.some((d: any) => d.id === 'item.m1.goal'));
    assert.ok(deps?.some((d: any) => d.id === 'item.m1.auth'));
    assert.ok(deps?.some((d: any) => d.id === 'constraint.small'));
    const waiver = deps?.find((d: any) => d.kind === 'waiver').id;
    await done43(p, [...base, '--withdraw-items',`item.m1.goal,${waiver}`, '--keep-items','item.m1.auth,constraint.small']);
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'basis.withdrawn' AND json_extract(record,'$.line') = 'item.m1.goal'").get());
    assert.equal(p.ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'basis.withdrawn' AND json_extract(record,'$.line') = 'item.m1.auth'").get(), undefined);
    assert.equal(await planReviewsWaiver(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'dplan.m1.1.1'), null);
    assert.ok(wordsEntry(p.ctx.memory, w.words), 'the original words and provenance survive');
  } finally {p.cleanup();}
});

test('B.3 kept waiver loses force after its sole tag is superseded; an already effective plan keeps its proof record', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Skip plan reviews','--tag','decision@m1']);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w.words]);
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    assert.equal((await planReviewsWaiver(ctx, 'dplan.m1.1.1'))?.ref, w.words);
    await startAddMission(p.ctx, 'm1');
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m1'));
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'effective' AND key = 'dplan.m1.1.1'").get());
    await done43(p, ['pm','say','Review future plans','--tag','decision@m1','--supersedes',`${w.words}#1`,'--keep-items','waiver:m1:plan-reviews#1']);
    assert.equal(await planReviewsWaiver(ctx, 'dplan.m1.1.2'), null, '4.2 waivers checked no words force');
    assert.equal((await planReviewsWaiver(ctx, 'dplan.m1.1.1'))?.ref, w.words, 'a plan already in effect keeps its honest waiver record');
  } finally {p.cleanup();}
});

test('retag requires user authorization and entry-level dispositions; mission closure ends scoped tags without changing history', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Make it small','--tag','principle','--tag','requirement@m1']);
    await done43(p, ['pm','requirement','add','m1','small','--type','goal','--text','small','--quote','small','--words',w.words]);
    const auth = await done43(p, ['pm','say','You may change that tag','--tag','instruction']);
    assert.equal((await command43(p, ['pm','retag',`${w.words}#1`,'--tag','decision@m1','--words',auth.words])).error.code, 'NOT_ALLOWED');
    await done43(p, ['pm','retag',`${w.words}#1`,'--tag','decision@m1','--words',auth.words,'--keep-items','item.m1.small']);
    assert.equal(residentRecords(p.ctx.memory, 'user.words-tags').filter((r) => r.words === w.words).length, 2);
    await done43(p, ['pm','close','m1','--words',auth.words]);
    assert.equal(taggedWords(p.ctx.memory, p.ctx.memory.data).find((x) => x.words === w.words)!.tags.some((t) => t.inForce), false);
    assert.doesNotMatch(pmLayer1(p.ctx), /W-1#/);
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'basis.version' AND json_extract(record,'$.line') = 'item.m1.small'").get());
  } finally {p.cleanup();}
});

test('summaries bind to tag force and retag state; stale summaries show surviving originals; summaries cannot be cited as words', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const a = await done43(p, ['pm','say','Choice A','--tag','decision@m1']);
    const b = await done43(p, ['pm','say','Choice B','--tag','decision@m1']);
    const summary = await done43(p, ['pm','summary','The PM summarizes A and B','--covers',`${a.words}#1,${b.words}#1`]);
    assert.match(pmLayer1(p.ctx), /PM summary/); assert.doesNotMatch(pmLayer1(p.ctx), /\[W-1#1\]/);
    assert.equal(wordsAuthority(p.ctx.memory, p.ctx.memory.data, summary.id), null);
    const auth = await done43(p, ['pm','say','Retag choice A','--tag','instruction']);
    await done43(p, ['pm','retag',`${a.words}#1`,'--tag','requirement@m1','--words',auth.words]);
    const text = pmLayer1(p.ctx);
    assert.match(text, /Stale summaries/); assert.match(text, /W-1#1/); assert.match(text, /W-2#1/); assert.doesNotMatch(text, /The PM summarizes/);
    await done43(p, ['pm','say','A different choice','--tag','decision@m1','--supersedes',`${a.words}#1`]);
    assert.doesNotMatch(pmLayer1(p.ctx), /\[W-1#1\]/);
    assert.match(pmLayer1(p.ctx), /\[W-2#1\]/, 'surviving originals replace a stale summary');
  } finally {p.cleanup();}
});

test('B.5 layer 1 never exceeds 8 KiB, including principles-only overflow; newest principles load first', async () => {
  const p = project43();
  try {
    // Seed through the real words writer/tagger in one CLI call per user message.
    for (let i = 0; i < 60; i++) await done43(p, ['pm','say',`principle ${i}: ${'字'.repeat(170)}`,'--tag','principle']);
    const r = await done43(p, ['pm','session','--filled-by','harness/pm']);
    assert.ok(Buffer.byteLength(r.layer1, 'utf8') <= 8192);
    assert.ok(r.layer1.indexOf('[W-60#1]') < r.layer1.indexOf('[W-59#1]'));
    assert.match(r.layer1, /more principles in force: mp read words --tag principle --in-force/);
    assert.match(r.layer1, /Read ALL before a PM-class decision/);
    assert.equal((await done43(p, ['read','words','--tag','principle','--in-force'])).words.length, 60);
    p.ctx.memory.rebuild();
    assert.equal(taggedWords(p.ctx.memory, p.ctx.memory.data).length, 60, 'new facts rebuild without a schema migration');
  } finally {p.cleanup();}
});
