// 4.4 (G8): notes that can be replaced and read. A replaced note is shown as replaced and leaves the
// Secretary's current notes; `mp read notes` lists each note with its state; a note that names an open
// escalation warns that it is no answer, and refuses nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli/main.ts';
import { flowCtx } from '../src/flow/context.ts';
import { closeEscalations } from '../src/flow/secretary.ts';
import { channel, pmNotes } from '../src/process/secretary.ts';
import { beginAction, endAction } from '../src/cli/project.ts';
import type { MissionId } from '../src/common/ids.ts';
import { ENV_A, type ProcessProject } from './process-fixtures.ts';
import { project43, command43, done43, live43, escalation43 } from './p43-fixtures.ts';

async function text44(p: ProcessProject, args: string[], identity: string | null = null): Promise<string> {
  const r = await runCli(args, {cwd: p.dir, env: {MP_SECRETARY: identity ?? ''}, process: {observe: () => ENV_A, ident: {name: 'test', email: 'test@test'}}});
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout;
}

test('G8: a replaced note is shown as replaced and is no longer a current note for the Secretary', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    const w = await done43(p, ['pm','say','Hold the parser until Monday','--tag','instruction']);
    const n1 = await done43(p, ['pm','note','hold the parser until Monday','--words',w.words]);
    const other = await done43(p, ['pm','note','the report goes to the docs folder']);
    assert.deepEqual((await done43(p, ['sec','next'], id)).notes.map((n: any) => n.id), [n1.id, other.id]);
    const n2 = await done43(p, ['pm','note','hold the parser until Tuesday','--replaces',n1.id]);
    assert.equal(n2.replaces, n1.id);
    assert.deepEqual((await done43(p, ['sec','next'], id)).notes.map((n: any) => n.id), [other.id, n2.id], 'the replaced note leaves the list; its replacement is current');
    await done43(p, ['sec','ack-note',other.id], id);
    const states = (await done43(p, ['read','notes','--all'])).notes.map((n: any) => [n.id, n.state, n.replacedBy]);
    assert.deepEqual(states, [[n1.id, 'replaced', n2.id], [other.id, 'acknowledged', null], [n2.id, 'current', null]]);
    const shown = await text44(p, ['read','notes']);
    assert.doesNotMatch(shown, new RegExp(`\\[${n1.id}\\]`), 'without --all a replaced note is counted, not listed');
    assert.match(shown, /1 replaced note\(s\): mp read notes --all/);
    assert.match(shown, new RegExp(`\\[${n2.id}\\] current \\(replaces ${n1.id}\\): hold the parser until Tuesday`));
    assert.match(shown, new RegExp(`\\[${other.id}\\] acknowledged: the report goes to the docs folder`));
    assert.match(await text44(p, ['read','notes','--all']), new RegExp(`\\[${n1.id}\\] replaced by ${n2.id} \\(${w.words}\\): hold the parser until Monday`));
    // a replaced note cannot be replaced again: its replacement is the one to replace
    assert.match((await command43(p, ['pm','note','until Wednesday','--replaces',n1.id])).error.message, new RegExp(`already replaced by ${n2.id}`));
    assert.equal((await command43(p, ['pm','note','until Wednesday','--replaces','N-99'])).error.code, 'NOT_ALLOWED');
    // the states survive a rebuild of the tables from the log
    const before = channel(p.ctx);
    p.ctx.memory.rebuild();
    assert.deepEqual(channel(p.ctx), before);
  } finally {p.cleanup();}
});

test('G8: a note is read from a file', async () => {
  const p = project43();
  try {
    const file = join(p.dir, 'note.local');
    writeFileSync(file, 'Run the long suite only at night.\nKeep the day for reviews.\n');
    const n = await done43(p, ['pm','note','--file',file]);
    assert.equal((await done43(p, ['read','notes'])).notes.find((x: any) => x.id === n.id).text, 'Run the long suite only at night.\nKeep the day for reviews.\n');
    assert.equal((await command43(p, ['pm','note','inline','--file',file])).error.code, 'USAGE');
  } finally {p.cleanup();}
});

test('G8: a note that names an open escalation warns that it is no answer, and is recorded', async () => {
  const p = project43();
  try {
    const esc = await escalation43(p, 'rnd.7');
    const named = await done43(p, ['pm','note',`For ${esc}: the user wants the small parser.`]);
    assert.deepEqual(named.escalations, [{mission: 'm1', escalation: esc}]);
    assert.match(named.warnings[0], /reaches no card and is not an answer record/);
    assert.match(named.warnings[0], new RegExp(`mp pm answer m1 ${esc.replace('.', '\\.')}`));
    assert.ok((await done43(p, ['read','notes'])).notes.some((x: any) => x.id === named.id), 'nothing is refused');
    assert.deepEqual((await done43(p, ['pm','note','rnd.70 and rnd.7x are other things'])).escalations, [], 'only a whole id names an escalation');
    await closeEscalations(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'test:close', 'task:t', 'the work it was about changed');
    const after = await done43(p, ['pm','note',`About ${esc} again.`]);
    assert.deepEqual(after.warnings, [], 'an applied escalation is not open');
  } finally {p.cleanup();}
});

test('G8 compatibility: a note in the 4.3 shape (no replaces) reads as current and behaves as in 4.3', async () => {
  const p = project43();
  try {
    const id = await live43(p);
    p.ctx.memory.write({op: 'legacy-note', payload: {}}, (tx) => {tx.append({kind: 'pm.note', id: 'N-1', text: 'a 4.3 instruction', words: null, acknowledged: false});});
    assert.deepEqual((await done43(p, ['read','notes'])).notes.map((n: any) => [n.id, n.state, n.replaces]), [['N-1', 'current', null]]);
    assert.deepEqual((await done43(p, ['sec','next'], id)).notes.map((n: any) => n.id), ['N-1']);
    await done43(p, ['sec','ack-note','N-1'], id);
    assert.deepEqual((await done43(p, ['sec','next'], id)).notes, []);
    assert.equal((await done43(p, ['read','notes'])).notes[0].state, 'acknowledged');
    const n2 = await done43(p, ['pm','note','a 4.4 instruction','--replaces','N-1']);
    assert.equal((await done43(p, ['read','notes','--all'])).notes.find((n: any) => n.id === 'N-1').replacedBy, n2.id);
  } finally {p.cleanup();}
});

// ---- review round 1 of p4

test('G8 (review p4-5): an inline note recorded by 4.3 replays in 4.4 with the same operation id, done or interrupted', async () => {
  const p = project43();
  try {
    // what 4.3 recorded for `mp pm note "Hold builds" --op hold1`: its action arguments and its write payload
    const args43 = {positionals: ['Hold builds'], flags: {}};
    const record43 = (op: string, id: string) => p.ctx.memory.write({op: `note:${op}`, payload: {op, text: 'Hold builds', words: null}, command: 'note'}, (tx) => {tx.append({kind: 'pm.note', id, text: 'Hold builds', words: null, acknowledged: false}); return id;});
    beginAction(p.ctx.memory, {op: 'hold1', command: 'note', args: args43, filler: null});
    record43('hold1', 'N-1');
    endAction(p.ctx.memory, {op: 'hold1', command: 'note', args: args43}, {exitCode: 0, text: 'Note N-1 recorded.', json: {id: 'N-1'}}, false);
    const done = await command43(p, ['pm','note','Hold builds','--op','hold1']);
    assert.equal(done.code, 0, JSON.stringify(done));
    assert.equal(done.replayed, true);
    // interrupted after the note's write, before the action was marked done: the write's receipt answers
    beginAction(p.ctx.memory, {op: 'hold2', command: 'note', args: args43, filler: null});
    record43('hold2', 'N-2');
    const resumed = await command43(p, ['pm','note','Hold builds','--op','hold2']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.result.id, 'N-2');
    assert.deepEqual((await done43(p, ['read','notes'])).notes.map((n: any) => n.id), ['N-1', 'N-2'], 'nothing was recorded twice');
    // a note from a file is identified by its text too: the same id with another text is another operation
    const file = join(p.dir, 'note.local');
    writeFileSync(file, 'first text');
    await done43(p, ['pm','note','--file',file,'--op','file1']);
    writeFileSync(file, 'second text');
    assert.equal((await command43(p, ['pm','note','--file',file,'--op','file1'])).error.code, 'OP_CONFLICT');
  } finally {p.cleanup();}
});

test('G8 (review p4-6): a read derives the notes and their replacements from one read of the records', () => {
  const n1 = {kind: 'pm.note', id: 'N-1', text: 'hold the release', words: null, acknowledged: false};
  const n2 = {kind: 'pm.note', id: 'N-2', text: 'hold the release until Friday', words: null, acknowledged: false, replaces: 'N-1'};
  // a memory in which N-2 is committed between a reader's first and second query
  const racing = () => {let reads = 0; return {stmt: () => ({all: (kind: string) => (kind !== 'pm.note' ? [] : reads++ === 0 ? [n1] : [n1, n2]).map((r) => ({record: JSON.stringify(r)}))})};};
  assert.deepEqual(pmNotes(racing() as never).map((n) => [n.id, n.state, n.replacedBy]), [['N-1', 'current', null]]);
  assert.deepEqual(channel({memory: racing()} as never).notes.map((n) => n.id), ['N-1'], 'the Secretary still sees one current note');
});
