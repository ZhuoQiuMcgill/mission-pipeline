// 4.4 (G7): the user's words cost less at each use. Superseding and re-tagging keep the requirement
// items and constraints they do not name, list them, and reads mark them; authorizations and waivers
// are still accounted for one by one; tag and retag take --supersedes; `mp read from W-n` reaches
// constraints, waivers and notes; layer 1 keeps principles first and always counts the inbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { pmLayer1, constraintTakesLayer1Line } from '../src/cli/pmMemory.ts';
import { taggedWords } from '../src/memory/words.ts';
import { ENV_A, type ProcessProject } from './process-fixtures.ts';
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
