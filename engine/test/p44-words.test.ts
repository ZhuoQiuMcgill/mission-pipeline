// 4.4 (G7): the user's words cost less at each use. Superseding and re-tagging keep the requirement
// items and constraints they do not name, list them, and reads mark them; authorizations and waivers
// are still accounted for one by one; tag and retag take --supersedes; `mp read from W-n` reaches
// constraints, waivers and notes; layer 1 keeps principles first and always counts the inbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, runCli } from '../src/cli/main.ts';
import { pmLayer1, constraintTakesLayer1Line } from '../src/cli/pmMemory.ts';
import { residentRecords, taggedWords, tagWords } from '../src/memory/words.ts';
import { actionArgs, beginAction } from '../src/cli/project.ts';
import { GLOBAL_FLAGS, parseArgs } from '../src/cli/args.ts';
import { flowCtx } from '../src/flow/context.ts';
import { planReviewsWaiver } from '../src/flow/waivers.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { pmSay } from '../src/process/pm.ts';
import { appendRecords } from '../src/memory/index.ts';
import { canonicalJson } from '../src/common/hash.ts';
import type { BasisLineId, ContentHash, MissionId } from '../src/common/ids.ts';
import { ENV_A, addDetailedPlan, startAddMission, step, type ProcessProject } from './process-fixtures.ts';
import { project43, command43, done43 } from './p43-fixtures.ts';

async function text44(p: ProcessProject, args: string[]): Promise<string> {
  const r = await runCli(args, {cwd: p.dir, env: {MP_SECRETARY: ''}, process: {observe: () => ENV_A, ident: {name: 'test', email: 'test@test'}}});
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout;
}
const withdrawn = (p: ProcessProject, line: string) => p.ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'basis.withdrawn' AND json_extract(record, '$.line') = ?").get(line) !== undefined;

test('G7: a supersession keeps the items and constraints it does not name, lists them, and reads mark them', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Build the parser. Keep files small.','--tag','requirement@m1:"Build the parser."','--tag','decision@m1:"Keep files small."']);
    await done43(p, ['pm','requirement','add','m1','parser','--type','goal','--text','a parser','--quote','Build the parser','--words',w.words]);
    await done43(p, ['pm','requirement','add','m1','offline','--type','limit','--text','no network','--quote','Build the parser','--words',w.words]);
    await done43(p, ['pm','constraint','add','small','--kind','object','--text','files stay small','--paths','**','--words',w.words]);
    const out = await text44(p, ['pm','say','Build the parser and a printer.','--tag','requirement@m1','--supersedes',`${w.words}#1`,'--withdraw-items','item.m1.offline']);
    assert.match(out, /Kept, resting on words that were superseded \(reads mark them\): item\.m1\.parser, constraint\.small\./);
    assert.match(out, /Withdrawn: item\.m1\.offline\./);
    assert.equal(withdrawn(p, 'item.m1.parser'), false, 'nothing is withdrawn implicitly');
    assert.equal(withdrawn(p, 'constraint.small'), false);
    assert.equal(withdrawn(p, 'item.m1.offline'), true, '--withdraw-items withdraws');
    const mark = 'rests on words that were superseded (W-1#1, by W-2)';
    const layer1 = pmLayer1(p.ctx);
    assert.ok(layer1.includes(`[item.m1.parser] @m1 requirement goal: a parser — ${mark}`), layer1);
    assert.ok(layer1.includes(`[constraint.small] constraint project: files stay small — ${mark}`), layer1);
    assert.doesNotMatch(layer1, /item\.m1\.offline/);
    const from = await done43(p, ['read','from',w.words]);
    const parser = from.nodes.find((n: any) => n.kind === 'requirement' && n.id.startsWith('item.m1.parser'));
    assert.equal(parser.state, `in force; ${mark}`);
    const small = from.nodes.find((n: any) => n.kind === 'constraint');
    assert.equal(small.state, `recorded; ${mark}`);
    // restated on the new words, the item no longer rests on the superseded entry: the mark goes
    await done43(p, ['pm','requirement','add','m1','parser','--type','goal','--text','a parser and a printer','--quote','Build the parser and a printer','--words','W-2']);
    assert.doesNotMatch(pmLayer1(p.ctx), /\[item\.m1\.parser\][^\n]*superseded/);
    assert.match(pmLayer1(p.ctx), /\[constraint\.small\][^\n]*rests on words that were superseded/);
  } finally {p.cleanup();}
});

test('G7: an authorization and a waiver are still accounted for one by one; nothing else needs naming', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Build it. The details are yours. Skip the plan reviews.','--tag','decision@m1']);
    await done43(p, ['pm','requirement','add','m1','goal','--type','goal','--text','build it','--quote','Build it','--words',w.words]);
    await done43(p, ['pm','requirement','add','m1','auth','--type','authorization','--text','details','--quote','The details are yours','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w.words]);
    const base = ['pm','say','Review the plans again.','--tag','decision@m1','--supersedes',`${w.words}#1`];
    const refused = await command43(p, base);
    assert.equal(refused.error.code, 'NOT_ALLOWED');
    assert.deepEqual([...refused.error.detail.toName].sort(), ['item.m1.auth', 'waiver:m1:plan-reviews#1']);
    assert.match(refused.error.message, /each authorization and waiver/);
    assert.match(refused.error.message, /Requirement items and constraints not named are kept/);
    assert.equal(taggedWords(p.ctx.memory, p.ctx.memory.data).find((x) => x.words === w.words)!.tags[0]!.inForce, true, 'a refusal writes nothing');
    // naming only one of the two is still refused, as in 4.3
    assert.deepEqual((await command43(p, [...base, '--keep-items','item.m1.auth'])).error.detail.toName.length, 2);
    assert.match((await command43(p, [...base, '--keep-items','item.m1.goal','--withdraw-items','item.m1.goal,item.m1.auth,waiver:m1:plan-reviews#1'])).error.message, /item\.m1\.goal/, 'one id kept and withdrawn at once is refused');
    const r = await done43(p, [...base, '--keep-items','item.m1.auth','--withdraw-items','waiver:m1:plan-reviews#1']);
    assert.deepEqual(r.kept.map((d: any) => d.id), ['item.m1.goal', 'item.m1.auth']);
    assert.deepEqual(r.withdrawn.map((d: any) => d.id), ['waiver:m1:plan-reviews#1']);
    assert.match(pmLayer1(p.ctx), /\[item\.m1\.auth\][^\n]*rests on words that were superseded/);
  } finally {p.cleanup();}
});

test('G7: tag and retag take --supersedes; a tagged entry names what it supersedes later with its tags unchanged', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const a = await done43(p, ['pm','say','Use the old format.','--tag','decision@m1']);
    await done43(p, ['pm','constraint','add','fmt','--kind','instruction','--text','old format','--words',a.words]);
    const legacy = await done43(p, ['pm','say','Use the new format.']);
    const tagged = await done43(p, ['pm','tag',legacy.words,'--tag','decision@m1','--supersedes',`${a.words}#1`]);
    assert.deepEqual(tagged.kept.map((d: any) => d.id), ['constraint.fmt']);
    const force = () => new Map(taggedWords(p.ctx.memory, p.ctx.memory.data).flatMap((x) => x.tags.map((t) => [t.id, t] as const)));
    assert.equal(force().get(`${a.words}#1`)!.inForce, false);
    // a message recorded with its tags and no --supersedes: the PM names the supersession afterwards
    const b = await done43(p, ['pm','say','Use a third format.','--tag','decision@m1']);
    const before = force().get(`${b.words}#1`)!;
    assert.equal((await command43(p, ['pm','tag',b.words,'--tag','principle','--supersedes',`${legacy.words}#1`])).error.code, 'NOT_ALLOWED', 'other tags still need the user\'s authorization');
    const later = await done43(p, ['pm','tag',b.words,'--supersedes',`${legacy.words}#1`]);
    assert.deepEqual(later.tags.map((t: any) => t.id), [`${b.words}#1`]);
    assert.equal(force().get(`${legacy.words}#1`)!.inForce, false);
    assert.equal(force().get(`${b.words}#1`)!.fingerprint, before.fingerprint, 'its own tags are unchanged');
    assert.equal((await done43(p, ['pm','tag',b.words,'--supersedes',`${legacy.words}#1`])).kept.length, 0, 'the same supersession again changes nothing');
    // retag with --supersedes; what rests on the re-tagged entry is kept and marked as re-tagged
    const c = await done43(p, ['pm','say','Use a fourth format.','--tag','decision@m1']);
    await done43(p, ['pm','constraint','add','fourth','--kind','instruction','--text','fourth format','--words',c.words]);
    const auth = await done43(p, ['pm','say','Yes, that one is a principle and replaces the third.','--tag','instruction']);
    const out = await text44(p, ['pm','retag',`${c.words}#1`,'--tag','principle','--words',auth.words,'--supersedes',`${b.words}#1`]);
    assert.match(out, /Kept, resting on words that were re-tagged \(reads mark them\): constraint\.fourth\./);
    assert.equal(force().get(`${b.words}#1`)!.inForce, false);
    assert.match(pmLayer1(p.ctx), new RegExp(`\\[constraint\\.fourth\\][^\\n]*rests on words that were re-tagged \\(${c.words}, on ${auth.words}\\)`));
  } finally {p.cleanup();}
});

test('G7: mp read from W-n reaches the constraints, waivers and notes that cite the entry', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Indent with tabs. Skip the plan reviews.','--tag','decision@m1']);
    const c = await done43(p, ['pm','constraint','add','tabs','--kind','instruction','--text','indent with tabs','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w.words]);
    const n1 = await done43(p, ['pm','note','tabs everywhere, also in tests','--words',w.words]);
    const n2 = await done43(p, ['pm','note','tabs everywhere, also in tests and docs','--words',w.words,'--replaces',n1.id]);
    const from = await done43(p, ['read','from',w.words]);
    const keys = from.nodes.map((n: any) => n.key);
    for (const key of [`constraint:${c.version}`, 'waiver:m1:plan-reviews#1', `note:${n1.id}`, `note:${n2.id}`]) assert.ok(keys.includes(key), `${key} in ${keys.join(', ')}`);
    assert.equal(from.nodes.find((n: any) => n.key === 'waiver:m1:plan-reviews#1').state, 'in force');
    assert.equal(from.nodes.find((n: any) => n.key === `note:${n1.id}`).state, `replaced by ${n2.id}`);
    const shown = await text44(p, ['read','from',w.words]);
    assert.match(shown, /constraint constraint\.tabs[^\n]*indent with tabs/);
    assert.match(shown, /waiver m1:plan-reviews#1 — plan reviews waived for every plan of mission m1 not in effect yet/);
    assert.match(shown, new RegExp(`note ${n2.id} — "tabs everywhere, also in tests and docs"`));
    // and back: a note and a waiver rest on the user's words
    assert.equal((await done43(p, ['read','why',n2.id])).reachesWords, true);
    assert.equal((await done43(p, ['read','why','waiver:m1:plan-reviews#1'])).reachesWords, true);
  } finally {p.cleanup();}
});

test('G7: layer 1 keeps principles first and always counts the inbox; constraints of closed missions take no line', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    await done43(p, ['pm','mission','open','m2']);
    const w = await done43(p, ['pm','say','Keep it simple. Close m2.','--tag','principle:"Keep it simple."','--tag','instruction:"Close m2."']);
    assert.match(pmLayer1(p.ctx), /\nPM inbox: nothing waits \(mp pm inbox\)\n/);
    await done43(p, ['pm','constraint','add','everywhere','--kind','instruction','--text','for every mission']);
    await done43(p, ['pm','constraint','add','first','--kind','instruction','--text','for m1 only','--mission','m1']);
    await done43(p, ['pm','constraint','add','second','--kind','instruction','--text','for m2 only','--mission','m2']);
    await done43(p, ['pm','constraint','add','later','--kind','instruction','--text','for a mission not opened yet','--mission','m3']);
    await done43(p, ['pm','close','m2','--words',w.words]);
    const q = await done43(p, ['pm','ask-secretary','how far is the parser?']);
    const text = pmLayer1(p.ctx);
    const at = (s: string) => {const i = text.indexOf(s); assert.ok(i >= 0, `${s} in\n${text}`); return i;};
    assert.ok(at('principle: Keep it simple.') < at('PM inbox: 1 item(s) wait: mp pm inbox'));
    assert.ok(at('PM inbox: 1 item(s) wait: mp pm inbox') < at(`[${q.id}] inbox open: how far is the parser?`));
    assert.ok(at(`[${q.id}] inbox open`) < at('[constraint.everywhere]'), 'what the PM must act on comes before the constraints');
    at('[constraint.first] constraint @m1');
    at('[constraint.later] constraint @m3');
    assert.doesNotMatch(text, /constraint\.second/, 'a constraint whose missions are all closed takes no line');
    assert.equal(constraintTakesLayer1Line({scope: {mission: 'm2'}}, new Set(['m2'])), false);
    assert.equal(constraintTakesLayer1Line({scope: {}}, new Set(['m2'])), true);
    assert.equal(constraintTakesLayer1Line({scope: null}, new Set()), true);
  } finally {p.cleanup();}
});

test('G7: when principles overflow layer 1, the inbox line still shows and the lines after it are counted', async () => {
  const p = project43();
  try {
    for (let i = 0; i < 60; i++) await done43(p, ['pm','say',`principle ${i}: ${'x'.repeat(300)}`,'--tag','principle']);
    const q = await done43(p, ['pm','ask-secretary','what is running?']);
    const r = await done43(p, ['pm','session','--filled-by','harness/pm']);
    assert.ok(Buffer.byteLength(r.layer1, 'utf8') <= 8192);
    assert.match(r.layer1, /more principles in force: mp read words --tag principle --in-force/);
    assert.match(r.layer1, /\nPM inbox: 1 item\(s\) wait: mp pm inbox\n/);
    assert.doesNotMatch(r.layer1, new RegExp(`\\[${q.id}\\]`));
    assert.match(r.layer1, /1 more mission\/project entries/);
  } finally {p.cleanup();}
});

test('G7 compatibility: a tags record in the 4.3 shape (no kept) reads as before and marks nothing', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Build the parser.','--tag','requirement@m1']);
    await done43(p, ['pm','requirement','add','m1','parser','--type','goal','--text','a parser','--quote','Build the parser','--words',w.words]);
    const w2 = await done43(p, ['pm','say','Build the printer.']);
    // what 4.3 wrote for `mp pm say --supersedes W-1#1 --keep-items item.m1.parser`: no `kept`
    p.ctx.memory.write({op: 'legacy-tags', payload: {}}, (tx) => {tx.append({kind: 'user.words-tags', words: w2.words, tags: [{id: `${w2.words}#1`, type: 'requirement', mission: 'm1', quote: null}], supersedes: [`${w.words}#1`], authorizedBy: null});});
    assert.equal(taggedWords(p.ctx.memory, p.ctx.memory.data).find((x) => x.words === w.words)!.tags[0]!.inForce, false);
    assert.match(pmLayer1(p.ctx), /\[item\.m1\.parser\] @m1 requirement goal: a parser\n/);
    const parser = (await done43(p, ['read','from',w.words])).nodes.find((n: any) => n.kind === 'requirement');
    assert.equal(parser.state, 'in force');
  } finally {p.cleanup();}
});

// ---- review round 1 of p4

test('G7 (review p4-1): an authorization is never kept implicitly; one the PM keeps by name still grants a waiver, as in 4.3', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','The details are yours.','--tag','decision@m1']);
    await done43(p, ['pm','requirement','add','m1','auth','--type','authorization','--text','details','--quote','The details are yours','--words',w.words]);
    const base = ['pm','say','Fewer details are yours now.','--tag','decision@m1','--supersedes',`${w.words}#1`];
    const refused = await command43(p, base);
    assert.equal(refused.error.code, 'NOT_ALLOWED');
    assert.deepEqual(refused.error.detail.toName, ['item.m1.auth']);
    assert.equal(withdrawn(p, 'item.m1.auth'), false);
    await done43(p, [...base, '--keep-items','item.m1.auth']);
    await done43(p, ['pm','waive','m1','plan-reviews','--authority','auth']);
    assert.equal((await planReviewsWaiver(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'dplan.m1.1.1'))?.by, 'authority');
  } finally {p.cleanup();}
});

test('G7 (review p4-2): a waiver granted under an authorization on the entry is accounted for by name', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','The details are yours.','--tag','decision@m1']);
    await done43(p, ['pm','requirement','add','m1','auth','--type','authorization','--text','details','--quote','The details are yours','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--authority','auth']);
    const base = ['pm','say','Fewer details are yours now.','--tag','decision@m1','--supersedes',`${w.words}#1`];
    const refused = await command43(p, [...base, '--withdraw-items','item.m1.auth']);
    assert.equal(refused.error.code, 'NOT_ALLOWED', 'the waiver under the authorization is not passed over');
    assert.deepEqual([...refused.error.detail.toName].sort(), ['item.m1.auth', 'waiver:m1:plan-reviews#1']);
    assert.match(refused.error.message, /waiver:m1:plan-reviews#1/);
    const out = await text44(p, [...base, '--withdraw-items','item.m1.auth,waiver:m1:plan-reviews#1']);
    assert.match(out, /Withdrawn: item\.m1\.auth \(authorization\), waiver:m1:plan-reviews#1 \(waiver under item\.m1\.auth\)\./);
    assert.equal(await planReviewsWaiver(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'dplan.m1.1.1'), null, 'the next plan gets its reviews');
  } finally {p.cleanup();}
});

test('G7 (review p4-3): the read calls a waiver in force only where the planner applies it', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Skip the reviews. Keep it small.','--tag','decision@m1:"Skip the reviews."','--tag','decision@m1:"Keep it small."']);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--plan','dplan.m1.1.1','--words',w.words]);
    const sup = await done43(p, ['pm','say','Review the plans.','--tag','decision@m1','--supersedes',`${w.words}#1`,'--withdraw-items','waiver:m1:plan-reviews#1','--keep-items','waiver:m1:plan-reviews#2']);
    // 4.3 behaviour, unchanged: a withdrawal for the whole mission covers the plan-specific waiver too
    assert.equal(await planReviewsWaiver(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'dplan.m1.1.1'), null);
    const nodes = (await done43(p, ['read','from',w.words])).nodes;
    const state = (key: string) => nodes.find((n: any) => n.key === key)?.state as string;
    assert.match(state('waiver:m1:plan-reviews#2'), /^kept, but the planner does not apply it/);
    assert.match(state('waiver:m1:plan-reviews#1'), new RegExp(`^withdrawn on ${sup.words} \\(plan-reviews#3\\)`));
  } finally {p.cleanup();}
});

test('G7 (review p4-4): repeating a recorded supersession with --withdraw-items withdraws, and records the supersession once', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const a = await done43(p, ['pm','say','Use tabs.','--tag','decision@m1']);
    await done43(p, ['pm','constraint','add','c','--kind','instruction','--text','tabs','--words',a.words]);
    const b = await done43(p, ['pm','say','Use spaces.','--tag','decision@m1']);
    assert.deepEqual((await done43(p, ['pm','tag',b.words,'--supersedes',`${a.words}#1`])).kept.map((d: any) => d.id), ['constraint.c']);
    const again = await done43(p, ['pm','tag',b.words,'--supersedes',`${a.words}#1`,'--withdraw-items','constraint.c']);
    assert.deepEqual(again.withdrawn.map((d: any) => d.id), ['constraint.c']);
    assert.equal(withdrawn(p, 'constraint.c'), true);
    assert.equal(residentRecords(p.ctx.memory, 'user.words-tags').filter((r) => r.words === b.words && r.supersedes.includes(`${a.words}#1`)).length, 1);
    assert.equal((await command43(p, ['pm','tag',b.words,'--supersedes',`${a.words}#1`,'--withdraw-items','constraint.nope'])).error.code, 'NOT_ALLOWED', 'an unknown id is still refused');
  } finally {p.cleanup();}
});

test('G7 (review p4-5): tag and retag operations recorded by 4.3 replay in 4.4 with the same operation id', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','An older rule.']);
    const auth = await done43(p, ['pm','say','Yes, make it a principle.','--tag','instruction']);
    // what 4.3 recorded for `mp pm tag W-1 --tag decision --op tag1`, interrupted before its action was marked done
    beginAction(p.ctx.memory, {op: 'tag1', command: 'tag', args: {positionals: [w.words], flags: {tag: ['decision']}}, filler: null});
    const tags43 = [{id: `${w.words}#1`, type: 'decision' as const, mission: null, quote: null}];
    p.ctx.memory.write({op: 'words:tags:tag1', payload: {op: 'tag1', words: w.words, tags: ['decision']}, command: 'tag'}, (tx) => {tx.append({kind: 'user.words-tags', words: w.words, tags: tags43, supersedes: [], authorizedBy: null}); return tags43;});
    const tag = await command43(p, ['pm','tag',w.words,'--tag','decision','--op','tag1']);
    assert.equal(tag.code, 0, JSON.stringify(tag));
    assert.deepEqual(tag.result.tags.map((t: any) => t.id), [`${w.words}#1`]);
    // and `mp pm retag W-1#1 --tag principle --words W-2 --op retag1`, interrupted the same way
    beginAction(p.ctx.memory, {op: 'retag1', command: 'retag', args: {positionals: [`${w.words}#1`], flags: {tag: ['principle'], words: auth.words}}, filler: null});
    const retag43 = [{id: `${w.words}#1`, type: 'principle' as const, mission: null, quote: null}];
    p.ctx.memory.write({op: 'words:tags:retag1', payload: {op: 'retag1', words: w.words, retag: `${w.words}#1`, authorizedBy: auth.words, tags: ['principle'], withdraw: [], keep: []}, command: 'retag'}, (tx) => {tx.append({kind: 'user.words-tags', words: w.words, tags: retag43, supersedes: [], authorizedBy: auth.words}); return retag43;});
    const retag = await command43(p, ['pm','retag',`${w.words}#1`,'--tag','principle','--words',auth.words,'--op','retag1']);
    assert.equal(retag.code, 0, JSON.stringify(retag));
    assert.equal(residentRecords(p.ctx.memory, 'user.words-tags').filter((r) => r.words === w.words).length, 2, 'nothing ran twice');
  } finally {p.cleanup();}
});

test('G7 (review p4-7): mp read from W-n reaches the constraints and waivers withdrawn on the entry', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Use tabs. Skip the reviews. Keep it small.','--tag','decision@m1']);
    const c = await done43(p, ['pm','constraint','add','c','--kind','instruction','--text','tabs','--words',w.words]);
    const d = await done43(p, ['pm','constraint','add','d','--kind','instruction','--text','small','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w.words]);
    const drop = await done43(p, ['pm','say','Drop the tabs rule and the skipped reviews.','--tag','instruction']);
    await done43(p, ['pm','constraint','withdraw','c','--words',drop.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--withdraw','--words',drop.words]);
    const nodes = (await done43(p, ['read','from',drop.words])).nodes;
    const state = (key: string) => nodes.find((n: any) => n.key === key)?.state;
    assert.equal(state(`constraint:${c.version}`), `withdrawn on ${drop.words}`);
    assert.equal(state('waiver:m1:plan-reviews#1'), `withdrawn on ${drop.words} (plan-reviews#2)`);
    // a withdrawal named in a supersession is reached from the superseding words too
    const sup = await done43(p, ['pm','say','Big files are fine.','--tag','decision@m1','--supersedes',`${w.words}#1`,'--withdraw-items','constraint.d']);
    assert.equal((await done43(p, ['read','from',sup.words])).nodes.find((n: any) => n.key === `constraint:${d.version}`)?.state, `withdrawn on ${sup.words}`);
  } finally {p.cleanup();}
});

test('G7 (review p4-8): a mission tree marks only the constraint version that rests on the superseded words', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    await done43(p, ['pm','mission','open','m2']);
    const a = await done43(p, ['pm','say','Format A.','--tag','decision@m1']);
    const v1 = await done43(p, ['pm','constraint','add','m1','fmt','--kind','instruction','--text','format A','--words',a.words]);
    const b = await done43(p, ['pm','say','Format B.','--tag','decision@m2']);
    const v2 = await done43(p, ['pm','constraint','add','m2','fmt','--kind','instruction','--text','format B','--words',b.words]);
    assert.notEqual(v1.version, v2.version);
    await done43(p, ['pm','say','Format C.','--tag','decision@m2','--supersedes',`${b.words}#1`]);
    assert.doesNotMatch(await text44(p, ['read','tree','m1']), /constraint\.fmt[^\n]*superseded/, 'the m1 version cites W-1, which nothing superseded');
    assert.match(await text44(p, ['read','tree','m2']), new RegExp(`${v2.version.replace(/\./g, '\\.')}[^\\n]*rests on words that were superseded \\(${b.words}#1`));
  } finally {p.cleanup();}
});

// ---- review round 2 of p4

/** The action identity the CLI records for a PM command line (as cli/main.ts computes it). */
function identityOf(argv: string[]): unknown {
  const cmd = COMMANDS.find((c) => c.group === 'pm' && c.name[0] === argv[1])!;
  const args = parseArgs(argv.slice(2), {...cmd.flags, 'filled-by': 'string'});
  return actionArgs(cmd.identity !== undefined ? cmd.identity(args) : {positionals: args.positionals, flags: Object.fromEntries(Object.entries(args.flags).filter(([k]) => !(k in GLOBAL_FLAGS) && k !== 'filled-by'))});
}

test('G7 (review p4-r2-1): an interrupted say, tag or retag retried unchanged accepts the withdrawal it recorded and returns it', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Use tabs.','--tag','decision@m1']);
    await done43(p, ['pm','constraint','add','c','--kind','instruction','--text','tabs','--words',w.words]);
    // `mp pm say … --op drop-c`, interrupted after its words and its withdrawal committed, before its action was done
    const say = ['pm','say','Drop C.','--tag','decision@m1','--supersedes',`${w.words}#1`,'--withdraw-items','constraint.c','--op','drop-c'];
    beginAction(p.ctx.memory, {op: 'drop-c', command: 'say', args: identityOf(say), filler: null});
    pmSay(p.ctx, 'Drop C.', {op: 'drop-c', tags: ['decision@m1'], supersedes: [`${w.words}#1`], withdraw: ['constraint.c'], keep: []});
    assert.equal(withdrawn(p, 'constraint.c'), true);
    const retried = await command43(p, say);
    assert.equal(retried.code, 0, JSON.stringify(retried));
    assert.deepEqual(retried.result.withdrawn.map((d: any) => d.id), ['constraint.c']);
    // the same for tag and retag: the retry finds the write's receipt
    const a = await done43(p, ['pm','say','Use two spaces.','--tag','decision@m1']);
    await done43(p, ['pm','constraint','add','e','--kind','instruction','--text','two spaces','--words',a.words]);
    const b = await done43(p, ['pm','say','Use four spaces.','--tag','decision@m1']);
    const tag = ['pm','tag',b.words,'--supersedes',`${a.words}#1`,'--withdraw-items','constraint.e','--op','tag-e'];
    beginAction(p.ctx.memory, {op: 'tag-e', command: 'tag', args: identityOf(tag), filler: null});
    tagWords(p.ctx.memory, {op: 'tag-e', words: b.words, tags: [], supersedes: [`${a.words}#1`], withdraw: ['constraint.e']});
    const tagged = await command43(p, tag);
    assert.equal(tagged.code, 0, JSON.stringify(tagged));
    assert.deepEqual(tagged.result.withdrawn.map((d: any) => d.id), ['constraint.e']);
    const c = await done43(p, ['pm','say','Tabs, again.','--tag','decision@m1']);
    await done43(p, ['pm','constraint','add','f','--kind','instruction','--text','tabs again','--words',c.words]);
    const auth = await done43(p, ['pm','say','Make that a principle and drop rule f.','--tag','instruction']);
    const retag = ['pm','retag',`${c.words}#1`,'--tag','principle','--words',auth.words,'--withdraw-items','constraint.f','--op','retag-f'];
    beginAction(p.ctx.memory, {op: 'retag-f', command: 'retag', args: identityOf(retag), filler: null});
    tagWords(p.ctx.memory, {op: 'retag-f', words: c.words, retag: `${c.words}#1`, authorizedBy: auth.words, tags: ['principle'], withdraw: ['constraint.f'], keep: []});
    const retagged = await command43(p, retag);
    assert.equal(retagged.code, 0, JSON.stringify(retagged));
    assert.deepEqual(retagged.result.withdrawn.map((d: any) => d.id), ['constraint.f']);
  } finally {p.cleanup();}
});

test('G7 (review p4-r2-2): repeating a supersession with a new one asks about what gives power and came since, reports only what it names, and records a named keep', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w1 = await done43(p, ['pm','say','Skip the reviews. Keep it small.','--tag','decision@m1:"Skip the reviews."','--tag','decision@m1:"Keep it small."']);
    await done43(p, ['pm','constraint','add','small','--kind','instruction','--text','small','--words',w1.words]);
    const w2 = await done43(p, ['pm','say','Use the old parser.','--tag','decision@m1']);
    const w3 = await done43(p, ['pm','say','Use the new parser.','--tag','decision@m1']);
    assert.deepEqual((await done43(p, ['pm','tag',w3.words,'--supersedes',`${w1.words}#1`])).kept.map((d: any) => d.id), ['constraint.small']);
    // granted and recorded on W-1 after its first supersession (W-1#2 keeps W-1 in force)
    await done43(p, ['pm','waive','m1','plan-reviews','--words',w1.words]);
    await done43(p, ['pm','constraint','add','later','--kind','instruction','--text','later','--words',w1.words]);
    const base = ['pm','tag',w3.words,'--supersedes',`${w1.words}#1,${w2.words}#1`];
    const refused = await command43(p, base);
    assert.equal(refused.error.code, 'NOT_ALLOWED', 'a waiver that came to rest on the repeated entry is asked about');
    assert.deepEqual(refused.error.detail.toName, ['waiver:m1:plan-reviews#1']);
    const r = await done43(p, [...base, '--keep-items','waiver:m1:plan-reviews#1,constraint.later']);
    assert.deepEqual(r.kept.map((d: any) => d.id).sort(), ['constraint.later', 'waiver:m1:plan-reviews#1'], 'an unmentioned dependent of the repeated entry is not reported as kept');
    const nodes = (await done43(p, ['read','from',w1.words])).nodes;
    const mark = `rests on words that were superseded (${w1.words}#1, by ${w3.words})`;
    assert.equal(nodes.find((n: any) => n.key === 'waiver:m1:plan-reviews#1').state, `in force; ${mark}`, 'the named keep is recorded and read');
    assert.match(nodes.find((n: any) => n.kind === 'constraint' && n.id.startsWith('constraint.later')).state, new RegExp(mark.replace(/[()#.]/g, '\\$&')));
    assert.equal(residentRecords(p.ctx.memory, 'user.words-tags').filter((x) => x.supersedes.includes(`${w1.words}#1`)).length, 1, 'the supersession is still recorded once');
  } finally {p.cleanup();}
});

test('G7 (review p4-r2-3): for a plan in effect the waiver read shows the outcome recorded with that plan', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Skip the reviews of the first plan.','--tag','decision@m1']);
    await done43(p, ['pm','waive','m1','plan-reviews','--plan','dplan.m1.1.1','--words',w.words]);
    await startAddMission(p.ctx, 'm1');
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m1'));
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'effective' AND key = 'dplan.m1.1.1'").get());
    const later = await done43(p, ['pm','say','Skip the reviews of later plans too.','--tag','decision@m1']);
    await done43(p, ['pm','waive','m1','plan-reviews','--words',later.words]);
    const state = async (words: string, key: string) => (await done43(p, ['read','from',words])).nodes.find((n: any) => n.key === key)?.state;
    assert.equal(await state(w.words, 'waiver:m1:plan-reviews#1'), 'dplan.m1.1.1 took effect on it');
    assert.equal(await state(later.words, 'waiver:m1:plan-reviews#2'), 'in force', 'a mission-wide waiver is read for the plans not in effect yet');
  } finally {p.cleanup();}
});

test('G7 (review p4-2): a waiver granted under an authorization withdrawn on its own is still asked about when the entry changes', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','The details are yours.','--tag','decision@m1']);
    await done43(p, ['pm','requirement','add','m1','auth','--type','authorization','--text','details','--quote','The details are yours','--words',w.words]);
    await done43(p, ['pm','waive','m1','plan-reviews','--authority','auth']);
    const drop = await done43(p, ['pm','say','Take that authorization back.','--tag','instruction']);
    await done43(p, ['pm','requirement','withdraw','m1','auth','--words',drop.words]);
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    assert.equal((await planReviewsWaiver(ctx, 'dplan.m1.1.1'))?.by, 'authority', '4.3: the planner still applies it');
    const base = ['pm','say','Fewer details are yours now.','--tag','decision@m1','--supersedes',`${w.words}#1`];
    const refused = await command43(p, base);
    assert.equal(refused.error.code, 'NOT_ALLOWED');
    assert.deepEqual(refused.error.detail.toName, ['waiver:m1:plan-reviews#1']);
    await done43(p, [...base, '--withdraw-items','waiver:m1:plan-reviews#1']);
    assert.equal(await planReviewsWaiver(ctx, 'dplan.m1.1.1'), null);
  } finally {p.cleanup();}
});

test('G7 (review p4-7): a constraint withdrawal a 4.3 tagging recorded in its reason is reached from those words', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Use tabs.','--tag','decision@m1']);
    const c = await done43(p, ['pm','constraint','add','c','--kind','instruction','--text','tabs','--words',w.words]);
    const by = await done43(p, ['pm','say','Use spaces.','--tag','decision@m1']);
    // what 4.3 wrote for `mp pm say … --supersedes W-1#1 --withdraw-items constraint.c`: the words only in the reason
    p.ctx.memory.write({op: 'legacy-withdrawal', payload: {}}, (tx) => {
      appendRecords(tx, [{kind: 'basis.withdrawn', line: 'constraint.c' as BasisLineId}, {kind: 'flow.event', mission: 'project' as MissionId, line: 'requirements', event: 'constraint-withdrawn', key: 'constraint.c', body: tx.data.put(canonicalJson({line: 'constraint.c', reason: `withdrawn with words tags by ${by.words}`})) as ContentHash}]);
    });
    assert.equal((await done43(p, ['read','from',by.words])).nodes.find((n: any) => n.key === `constraint:${c.version}`)?.state, `withdrawn on ${by.words}`);
  } finally {p.cleanup();}
});
