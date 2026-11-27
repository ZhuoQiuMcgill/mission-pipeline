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
import { channel } from '../src/process/secretary.ts';
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
