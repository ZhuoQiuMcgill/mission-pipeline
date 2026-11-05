// 4.1.3 P3 item 1 and 4 (E-4, D-11; field issues #26 and #44): data outside the commit as a pointer,
// data:<absolute path>[:<line>[-<line>]]#sha256=<64 hex>&size=<bytes>.
//   a  the grammar: paths with colons, a line suffix only when the rest is digits, ranges, Windows
//      paths; an incomplete pointer; the same form on the schema descriptions and the card text
//   b  the file check: a full sha256, a partial one for a large file, and every way it cannot be read
//   c  a blind reading cites data: accepted; recorded with its check; labelled on the cards, the
//      hand-off and the reads; `mp read show evidence --check-data`: unchanged, changed, missing
//   d  a mismatch refuses the hand-back with the expected and actual values; the same dispatch then
//      hands back the fixed pointer and it is accepted (the exit of a refusal)
//   e  an experiment: its record is made at the hand-back with the checks; data alone backs a claim
//   f  a file over 2 GiB (sparse): size and the first and last 64 MiB, labelled partial
//   g  the other hand-backs that accept file: (the attacker, the author, the interpreter)
//   h  compatibility: 4.1.2 pointers parse as before; a hand-back with no data pointer is checked as
//      before; an experiment's hand-back recorded by the field's code (no record in it) folds as before

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { EvidenceRecord } from '../src/common/records.ts';
import { checkDataFile, DATA_PARTIAL_OVER, DATA_SAMPLE_BYTES } from '../src/common/dataFile.ts';
import { showEvidence } from '../src/cli/evidence.ts';
import type { Project } from '../src/cli/project.ts';
import { showItem } from '../src/cli/status.ts';
import { buildHandoff, explorationState } from '../src/flow/exploration/flow.ts';
import { appendRecords, dispatchInfo, recordHandback } from '../src/memory/index.ts';
import { ENV_LINE } from '../src/evaluator/index.ts';
import { dispatchRuns, handbackDoc, type HandbackDoc } from '../src/process/ports.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderReaderCard, type AuthorCard, type InterpreterCard, type ReaderCard, type RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import {
  BlindResultShape,
  DATA_LABEL,
  DATA_POINTER_FORM,
  DATA_POINTER_LINE,
  blindEvidenceRecord,
  blindPointers,
  dataPointers,
  incompleteDataPointers,
  renderExperimentCard,
  type BlindResult,
  type ExperimentCard,
} from '../src/seat/cards/experiment.ts';
import { handBackProblems, seatCardEntry } from '../src/seat/cards/index.ts';
import { M, RUN_PLACEHOLDER, attack, cardOf, finding, hand, only, submit, world, type World } from './flow-exploration-fixtures.ts';
import { cli } from './cli-fixtures.ts';
import { processProject } from './process-fixtures.ts';

const DIR = mkdtempSync(join(tmpdir(), 'p413-data-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** A data file outside any repository, and its pointer. */
function dataFile(name: string, text: string): { readonly path: string; readonly sha: string; readonly size: number; ptr(line?: string, o?: { sha?: string; size?: number }): string } {
  const path = join(DIR, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  const s = sha(text);
  const size = Buffer.byteLength(text);
  return { path, sha: s, size, ptr: (line, o = {}) => `data:${path}${line !== undefined ? `:${line}` : ''}#sha256=${o.sha ?? s}&size=${o.size ?? size}` };
}

const REQUEST = { steps: ['read the stored corpus'], data: 'the corpus outside the repository', measure: ['rows'], assertions: ['no row is empty'] };

/** A design exploration whose author asked for a reading (or an experiment): the executor's card is queued. */
async function evidenceQueued(executor: 'reading' | 'experiment', o: { commands?: boolean } = {}): Promise<World> {
  const w = await world();
  await w.advance();
  await hand(w, 'researcher-author', submit('v1'));
  await w.advance();
  await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'an empty row is dropped')]));
  await w.advance();
  const t = only(w, 'researcher-author');
  const req = { ...REQUEST, executor, ...(executor === 'experiment' && o.commands !== false ? { commands: [{ id: 'count', command: 'wc -l corpus.csv' }] } : {}) };
  assert.deepEqual(await w.scheduler.run(t.task, { evidence: req, notes: 'author notes' }), []);
  await w.advance();
  return w;
}

function blindResult(source: string, basis: string = source): BlindResult {
  return { steps: [{ step: 1, done: 'yes', note: 'read it' }], measurements: [{ measure: 'rows', value: '120', source }], assertions: [{ assertion: 1, holds: 'yes', basis }], observations: '' };
}

const evidenceRecords = async (w: World): Promise<EvidenceRecord[]> => (await w.ledger.records(['evidence'])).map((c) => c.record).filter((r) => r.evidence.startsWith('xpe.'));

function project(w: World): Project {
  return { ctx: w.ports.ctx, dir: w.ports.dir } as unknown as Project;
}

// ---------------------------------------------------------------- a

describe('a: the data pointer grammar', () => {
  const h = 'ab'.repeat(32);
  test('a path with colons, a line or a range only when the rest is digits, a Windows path, upper-case hex', () => {
    const ps = dataPointers(`at data:/runs/a:b/out.csv:12#sha256=${h}&size=9, data:/runs/x:y#sha256=${h.toUpperCase()}&size=3 and data:/runs/r:12:4-8#sha256=${h}&size=1. Also data:C:\\runs\\w.csv:7#sha256=${h}&size=0`);
    assert.deepEqual(
      ps.map((p) => [p.path, p.line, p.sha256, p.size]),
      [
        ['/runs/a:b/out.csv', '12', h, 9],
        ['/runs/x:y', null, h, 3],
        ['/runs/r:12', '4-8', h, 1],
        ['C:\\runs\\w.csv', '7', h, 0],
      ],
    );
    assert.equal(ps[0]?.text, `data:/runs/a:b/out.csv:12#sha256=${h}&size=9`, 'the pointer as written, without the trailing comma');
  });
  test('an incomplete pointer is found (a pointer field refuses it); prose and data URLs are not pointers', () => {
    assert.deepEqual(incompleteDataPointers(`data:/runs/out.csv and data:/runs/ok#sha256=${h}&size=1, data: the corpus, data:text/plain;base64,AA`), ['data:/runs/out.csv']);
    assert.deepEqual(dataPointers(`data:/runs/short#sha256=abc&size=1 data:/runs/nosize#sha256=${h}`), []);
  });
  test('the same form on the hand-back schema, the attacker\'s basis and the reader, executor and author cards', async () => {
    assert.equal(DATA_POINTER_FORM, 'data:<absolute path>[:<line>[-<line>]]#sha256=<64 hex>&size=<bytes>');
    assert.ok(BlindResultShape.measurements.element.shape.source.description?.includes(DATA_POINTER_FORM));
    assert.ok(BlindResultShape.assertions.element.shape.basis.description?.includes(DATA_POINTER_FORM));
    const w = await evidenceQueued('reading');
    const reader = cardOf<ReaderCard>(w, 'researcher-reader');
    assert.ok(renderReaderCard(reader).includes(`cite it as ${DATA_POINTER_FORM}`), 'the reader card says which pointer to use, in one line');
    const w2 = await evidenceQueued('experiment');
    assert.ok(renderExperimentCard(cardOf<ExperimentCard>(w2, 'constructor-experiment')).includes(`cite it as ${DATA_POINTER_FORM}`), 'the executor card too');
    const w3 = await world();
    await w3.advance();
    const author = seatCardEntry('researcher-author').render(cardOf<AuthorCard>(w3, 'researcher-author'));
    assert.ok(author.includes(`cite it as ${DATA_POINTER_FORM}`), 'the author card too');
  });
});

// ---------------------------------------------------------------- b

describe('b: the file check', () => {
  test('a full check: size and sha256; a relative path, a missing file, a directory, a FIFO are named', async () => {
    const f = dataFile('b/corpus.csv', 'a,b\n1,2\n');
    const c = await checkDataFile(f.path);
    assert.deepEqual([c.state, c.size, c.check, c.sha256, c.sample], ['ok', f.size, 'full', f.sha, null]);
    assert.equal((await checkDataFile('b/corpus.csv')).state, 'not-absolute');
    assert.equal((await checkDataFile(join(DIR, 'b/none.csv'))).state, 'missing');
    assert.equal((await checkDataFile(join(DIR, 'b'))).state, 'not-a-file');
    const fifo = join(DIR, 'b/pipe');
    let made = true;
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      made = false;
    }
    if (made) assert.equal((await checkDataFile(fifo)).state, 'not-a-file', 'never opened for reading: it would block');
  });
  test('a partial check hashes the first and last bytes together, and checks the size', async () => {
    const text = 'HEAD-' + 'x'.repeat(100) + '-TAIL';
    const f = dataFile('b/large.bin', text);
    const c = await checkDataFile(f.path, { partialOver: 50, sampleBytes: 5 });
    assert.deepEqual([c.state, c.size, c.check, c.sha256], ['ok', f.size, 'partial', null]);
    assert.equal(c.sample, sha('HEAD--TAIL'));
    const forced = await checkDataFile(f.path, { kind: 'full', partialOver: 50 });
    assert.equal(forced.sha256, f.sha, 'a later check repeats the kind recorded');
    assert.equal(DATA_PARTIAL_OVER, 2 * 1024 ** 3);
    assert.equal(DATA_SAMPLE_BYTES, 64 * 1024 ** 2);
  });
});

// ---------------------------------------------------------------- c, d

describe('c, d: a blind reading cites data outside the commit', () => {
  test('c: accepted, recorded with its check, labelled on the cards, the hand-off and the reads; checked again later', async () => {
    const f = dataFile('c/corpus.csv', 'id,value\n1,4\n2,5\n');
    const w = await evidenceQueued('reading');
    await hand(w, 'researcher-reader', blindResult(`counted in ${f.ptr('2-3')}`));
    const [rec] = await evidenceRecords(w);
    assert.equal(rec?.fields['status'], 'completed', 'a checked data pointer is a record the claim rests on');
    assert.equal(rec?.fields['data'], '1');
    assert.equal(rec?.fields['data:1'], `${f.path}:2-3 sha256=${f.sha} size=${f.size} check=full`);
    const doc = JSON.parse(w.ledger.content.get(rec!.fields['report']!)) as { data: Array<Record<string, unknown>> };
    assert.deepEqual(doc.data, [{ pointer: f.ptr('2-3'), path: f.path, line: '2-3', sha256: f.sha, size: f.size, check: 'full', label: DATA_LABEL.full }]);
    assert.equal(DATA_LABEL.full, 'outside the commit (sha256 checked at hand-back)');
    // the cards and the hand-off carry the label with the evidence's summary
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.match(a.evidence[0]?.summary ?? '', new RegExp(`data file outside the commit: ${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2-3 \\(sha256 checked at hand-back\\)`));
    assert.match(a.continuation?.evidence ?? '', /sha256 checked at hand-back/, 'and the continuation that brings the evidence back');
    const s = await explorationState({ ledger: w.ledger }, M, w.x);
    assert.match(buildHandoff(s, 'converged', null).evidence[0]?.summary ?? '', /outside the commit: .*\(sha256 checked at hand-back\)/);
    // mp read show exploration and mp read show evidence
    const x = await showItem(project(w), 'exploration', w.x);
    assert.ok(x?.text.includes(`evidence ${rec?.evidence}: data outside the commit (1;`), x?.text);
    assert.ok(x?.text.includes(`${f.path}:2-3 — ${f.size} bytes, sha256 ${f.sha.slice(0, 16)}…; outside the commit (sha256 checked at hand-back)`), x?.text);
    const e = await showEvidence(project(w), rec!.evidence);
    assert.ok(e?.text.includes('data outside the commit (1):'), e?.text);
    assert.ok(e?.text.includes('outside the commit (sha256 checked at hand-back)'));
    // --check-data: read-only, per file
    const head = w.memory.read((db) => (db.stmt('SELECT MAX(rev) AS r FROM log').get() as { r: number }).r);
    assert.match((await showEvidence(project(w), rec!.evidence, { checkData: true }))?.text ?? '', new RegExp(`${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: unchanged`));
    writeFileSync(f.path, 'id,value\n1,4\n2,6\n');
    const changed = await showEvidence(project(w), rec!.evidence, { checkData: true });
    assert.match(changed?.text ?? '', /: changed \(the sha256 is now/);
    writeFileSync(f.path, 'id,value\n');
    assert.match((await showEvidence(project(w), rec!.evidence, { checkData: true }))?.text ?? '', /: changed \(the size is now 9 bytes/);
    rmSync(f.path);
    const missing = await showEvidence(project(w), rec!.evidence, { checkData: true });
    assert.match(missing?.text ?? '', /: missing \(no such file\)/);
    assert.deepEqual((missing?.json as { checked: Array<{ state: string }> }).checked.map((c) => c.state), ['missing']);
    assert.equal(w.memory.read((db) => (db.stmt('SELECT MAX(rev) AS r FROM log').get() as { r: number }).r), head, '--check-data writes nothing');
  });

  test('d: a mismatch refuses the hand-back with the expected and the actual values; the same dispatch then hands back the fixed pointer', async () => {
    const f = dataFile('d/corpus.csv', 'id\n1\n2\n');
    const w = await evidenceQueued('reading');
    const t = only(w, 'researcher-reader');
    const d = w.scheduler.dispatchOf(t.task);
    const wrongSha = 'f'.repeat(64);
    const cases: Array<[string, RegExp]> = [
      [f.ptr(undefined, { size: f.size + 1 }), new RegExp(`the pointer says size=${f.size + 1}; the file has ${f.size} bytes`)],
      [f.ptr(undefined, { sha: wrongSha }), new RegExp(`the pointer says sha256=${wrongSha}; the file's sha256 is ${f.sha}`)],
      [`data:${join(DIR, 'd/none.csv')}#sha256=${f.sha}&size=1`, /no such file \(a data pointer names a regular file mp can read, by its absolute path\)/],
      [`data:${join(DIR, 'd')}#sha256=${f.sha}&size=1`, /it is a directory, not a regular file/],
      [`data:/${'d/corpus.csv'}`, /is not a complete data pointer/],
    ];
    for (const [ptr, why] of cases) {
      const problems = await w.scheduler.run(t.task, { handBack: blindResult(`counted in ${ptr} and ${f.ptr()}`) });
      assert.ok(problems.some((p) => why.test(p)), `${ptr}: ${problems.join('; ')}`);
      assert.equal(w.scheduler.dispatchOf(t.task), d, 'refused: the dispatch stays in flight');
    }
    // a relative path is not a pointer to an absolute path: the claim cites no record, and is refused as such
    const rel = await w.scheduler.run(t.task, { handBack: blindResult(`data:d/corpus.csv#sha256=${f.sha}&size=${f.size}`) });
    assert.ok(rel.some((p) => /the path is not absolute/.test(p)), rel.join('; '));
    assert.equal((await evidenceRecords(w)).length, 0, 'nothing recorded');
    // the exit: the seat fixes it in the same dispatch
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: blindResult(f.ptr()) }), []);
    assert.equal(w.scheduler.tasks.get(t.task)?.dispatches.length, 1, 'one dispatch');
    assert.equal((await evidenceRecords(w))[0]?.fields['status'], 'completed');
  });
});

// ---------------------------------------------------------------- e, f

describe('e, f: an experiment cites data', () => {
  test('e: its record is made at the hand-back with the checks; the flow writes no second one; data alone backs a claim', async () => {
    const f = dataFile('e/out.csv', 'run,ms\n1,20\n');
    const w = await evidenceQueued('experiment');
    const t = await hand(w, 'constructor-experiment', blindResult(`${RUN_PLACEHOLDER} printed it; stored in ${f.ptr('2')}`, `the rows of ${f.ptr()}`));
    const hb = w.scheduler.tasks.get(t.task)?.handBack;
    const inHandBack = hb?.records.filter((r) => r.kind === 'evidence') as EvidenceRecord[];
    assert.equal(inHandBack.length, 1, 'the record comes with the hand-back');
    assert.equal(inHandBack[0]?.fields['data'], '2', 'one file, cited by two pointers (a line and the whole file): each is recorded');
    await w.advance();
    const recs = await evidenceRecords(w);
    assert.equal(recs.length, 1, 'the flow writes no second record');
    assert.equal(recs[0]?.fields['status'], 'completed', 'the assertion rests on the data alone, and that counts');
    assert.equal(recs[0]?.fields['run:1']?.endsWith('completed'), true);
  });

  test('f: a file over 2 GiB (sparse): its size and the first and last 64 MiB, labelled partial; a later check compares the same', async () => {
    const path = join(DIR, 'f/huge.bin');
    mkdirSync(join(DIR, 'f'), { recursive: true });
    const size = DATA_PARTIAL_OVER + 4096;
    const fd = openSync(path, 'w');
    writeSync(fd, Buffer.from('the head'), 0, 8, 0);
    writeSync(fd, Buffer.from('the tail'), 0, 8, size - 8);
    closeSync(fd);
    const w = await evidenceQueued('experiment', { commands: false });
    const madeUp = '0'.repeat(64);
    await hand(w, 'constructor-experiment', blindResult(`data:${path}#sha256=${madeUp}&size=${size}`));
    const [rec] = await evidenceRecords(w);
    assert.equal(rec?.fields['status'], 'completed');
    assert.match(rec?.fields['data:1'] ?? '', new RegExp(`sha256=${madeUp} size=${size} check=partial sample=[0-9a-f]{64}$`));
    const doc = JSON.parse(w.ledger.content.get(rec!.fields['report']!)) as { data: Array<{ label: string; check: string }> };
    assert.equal(doc.data[0]?.label, 'outside the commit (size checked at hand-back; only its first and last 64 MiB were hashed, so its sha256 was not checked)');
    await w.advance();
    assert.match(cardOf<AuthorCard>(w, 'researcher-author').evidence[0]?.summary ?? '', /\(size checked at hand-back; only its first and last 64 MiB were hashed/);
    assert.match((await showEvidence(project(w), rec!.evidence, { checkData: true }))?.text ?? '', /unchanged \(the size and the first and last 64 MiB as recorded \(a partial check\)\)/);
    const fd2 = openSync(path, 'r+');
    writeSync(fd2, Buffer.from('THE TAIL'), 0, 8, size - 8);
    closeSync(fd2);
    assert.match((await showEvidence(project(w), rec!.evidence, { checkData: true }))?.text ?? '', /changed \(the first or last 64 MiB changed\)/);
    // a wrong size is still refused at hand-back
    const w2 = await evidenceQueued('experiment', { commands: false });
    const t2 = only(w2, 'constructor-experiment');
    assert.ok((await w2.scheduler.run(t2.task, { handBack: blindResult(`data:${path}#sha256=${madeUp}&size=${size - 1}`) })).some((p) => /the pointer says size=/.test(p)));
  });
});

// ---------------------------------------------------------------- g

describe('g: the other hand-backs that accept file:', () => {
  test('the attacker\'s basis: a wrong pointer is refused, the fixed one accepted', async () => {
    const f = dataFile('g/table.csv', 'k,v\n');
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    const t = only(w, 'crititor');
    const bad = { ...finding('serious', 'internal contradiction', 'the table contradicts the text'), basis: `see ${f.ptr(undefined, { size: 99 })}` };
    const problems = await w.scheduler.run(t.task, { handBack: attack([bad]) });
    assert.ok(problems.some((p) => p.startsWith('findings[0].basis: ') && /size=99; the file has 4 bytes/.test(p)), problems.join('; '));
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: attack([{ ...bad, basis: `see ${f.ptr()}` }]) }), []);
  });

  test('the author\'s version, its notes and an attempt\'s data; the interpreter\'s conclusions (checked before the write)', async () => {
    const f = dataFile('g/method.csv', 'x\n');
    const wrong = f.ptr(undefined, { sha: '1'.repeat(64) });
    const w = await world();
    await w.advance();
    const t = only(w, 'researcher-author');
    const refused = await w.scheduler.run(t.task, { handBack: submit(`v1 reads ${wrong}`) });
    assert.ok(refused.some((p) => p.startsWith('artifact: ') && /the file's sha256 is/.test(p)), refused.join('; '));
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: submit(`v1 reads ${f.ptr()}`) }), []);
    // the rules themselves, as each card kind applies them to its texts
    const attempt: RegisteredAttemptT = { id: 'A1', kind: 'reading', purpose: 'p', steps: ['read'], data: `the table ${wrong}`, measure: ['m'], assertions: [] };
    const authorCard = { seat: 'researcher-author', registerAttempts: true, current: null, openFindings: [], evidence: [], exploration: { id: 'E1' } } as unknown as AuthorCard;
    const ps = handBackProblems(authorCard, submit('method', [], { attempts: [attempt] }), {});
    assert.ok(ps.some((p) => p.startsWith('attempts[A1].data: ') && p.includes('the file was not checked')), ps.join('; '));
    const interp = { seat: 'researcher-interpreter', attempts: [{ id: 'A1', kind: 'reading', purpose: 'p', evidence: null, status: 'completed', summary: '', material: null }], evidence: [], openFindings: [], current: null, exploration: { id: 'E1' }, method: { version: 'v' } } as unknown as InterpreterCard;
    const r = { answer: 'yes', conclusions: [{ id: 'C1', text: `rests on ${wrong}`, cites: ['A1'], standing: 'standing', key: true }], message: '', dispositions: [] };
    const checks = new Map([[f.path, await checkDataFile(f.path)]]);
    assert.ok(handBackProblems(interp, r, { data: checks }).some((p) => p.startsWith('conclusions[C1]: ') && /the pointer says sha256=1{64}/.test(p)));
    assert.deepEqual(handBackProblems(interp, { ...r, conclusions: [{ ...r.conclusions[0]!, text: `rests on ${f.ptr()}` }] }, { data: checks }), []);
  });
});

// ---------------------------------------------------------------- h

/** blindPointers as 4.1.2 had it (engine 32a74ea), the reference for every text without a complete data pointer. */
function legacyPointers(text: string): Array<{ kind: string; text: string; path: string }> {
  const out: Array<{ kind: string; text: string; path: string }> = [];
  for (const m of text.matchAll(/\brun:([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])|\burl:(\S+)|\bfile:([^\s:,;]+)(?::\d+(?:-\d+)?)?/g)) {
    if (m[1] !== undefined) out.push({ kind: 'run', text: m[0], path: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'url', text: m[0], path: m[2].replace(/[),.;]+$/, '') });
    else out.push({ kind: 'file', text: m[0], path: m[3] as string });
  }
  return out;
}

describe('h: compatibility', () => {
  test('pointers recorded before 4.1.3 parse as before (and a data: word in prose is not a pointer)', () => {
    const corpus = [
      'stdout of run:rerun-1a2b3c.step',
      'exit code of run:rerun-abc:def and run:x',
      'url:https://docs.example.org/page#frag, quoted: "the lock holds".',
      'file:src/lock.ts:12-20; file:README.md:3 and file:a/b.ts',
      'the field cited data:/home/u/runs/out.csv in prose, plus file:src/a.ts:1',
      'url:file:///home/u/runs/out.csv (read-only)',
      'data: the corpus; run:r1',
      '',
    ];
    for (const t of corpus) assert.deepEqual(blindPointers(t), legacyPointers(t), t);
  });

  test('a hand-back with no data pointer is checked as before: no file is read, the same problems, the record as 4.1.2 made it', async () => {
    const card = { seat: 'researcher-reader', task: 't', steps: ['s'], data: '', measure: ['rows'], assertions: ['a'], network: { allowed: ['https://docs.example.org/'] }, evidence: { id: 'xpe.M1.E1.9', envLine: 'L', envSnapshot: 'S', attempt: null } } as unknown as ReaderCard;
    const ok = blindResult('url:https://docs.example.org/x "passage"');
    const bad = blindResult('read data:/somewhere in prose');
    const entry = seatCardEntry('researcher-reader');
    assert.deepEqual(entry.dataTexts?.(ok).length, 2, 'its texts are scanned');
    for (const r of [ok, bad]) assert.deepEqual(handBackProblems(card, r, {}), handBackProblems(card, r, { data: new Map() }), 'no data context, no difference');
    assert.deepEqual(handBackProblems(card, ok, {}), []);
    const content = new Map<string, string>();
    const ctx = { content: { put: (d: string) => (content.set(sha(d), d), sha(d)), putList: () => ({ hash: '0'.repeat(64), count: 0 }) as never, getList: () => [] } };
    const rec = blindEvidenceRecord(card, ok, 'reading', ctx);
    assert.deepEqual(Object.keys(rec.fields).filter((k) => k.startsWith('data') || k.startsWith('executorReport')), []);
    const doc = JSON.parse(content.get(rec.fields['report']!)!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(doc).sort(), ['asked', 'attempt', 'cited', 'evidence', 'executor', 'format', 'result', 'task', 'unbacked']);
  });

  test("an experiment's hand-back recorded by the field's code (no record in it) folds as before: the flow writes its record from the runs", async () => {
    const w = await evidenceQueued('experiment');
    const t = only(w, 'constructor-experiment');
    const d = w.scheduler.dispatchOf(t.task);
    const run = w.scheduler.rerun(d, 'count', true);
    const fields = blindResult(`stdout of run:${run}`);
    const v = dispatchView(w.ports.ctx, d);
    // what the field's 4.1.2-based code wrote: the hand-back document with no evidence record in it
    w.memory.write({ op: `handback:${d}`, payload: { field: true } }, (tx) => {
      const runs = dispatchRuns(tx, tx.data, v.info);
      const doc: HandbackDoc = { format: 'mp41.handback.v1', kind: 'handed-back', seat: sha(canonicalJson({ report: 'r', fields })), fields, records: [], candidate: null, request: null, notes: null, runs };
      recordHandback(tx, { dispatch: d, report: 'the field wrote this', result: doc });
    });
    await w.advance();
    const recs = await evidenceRecords(w);
    assert.equal(recs.length, 1, 'the flow wrote it, as before');
    assert.equal(recs[0]?.fields['status'], 'completed');
    assert.equal(recs[0]?.fields['executorReport'], undefined, 'the field\'s hand-back kept no report with it');
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.evidence[0]?.executorReport, undefined);
    assert.equal(a.materials.some((m) => m.id.endsWith('-executor')), false);
  });
});

// ---------------------------------------------------------------- i

describe('i: the command line', () => {
  test('mp read show evidence <id> [--check-data]: its data, checked again read-only; --check-data goes with evidence only', async () => {
    const p = processProject();
    try {
      const f = dataFile('i/corpus.csv', 'a\n1\n');
      const card = { seat: 'researcher-reader', task: 't', steps: ['s'], data: '', measure: ['rows'], assertions: ['a'], network: { allowed: [] }, evidence: { id: 'xpe.m1.X1.1', envLine: ENV_LINE, envSnapshot: p.ctx.environment().identity, attempt: null } } as unknown as ReaderCard;
      const data = p.ctx.memory.data;
      const checks = new Map([[f.path, await checkDataFile(f.path)]]);
      const rec = blindEvidenceRecord(card, blindResult(f.ptr()), 'reading', { content: { put: (d) => data.put(d), putList: (xs) => data.putList(xs), getList: (r) => data.getList(r) }, data: checks, report: { text: '# the reader\'s report\n', leaf: null } });
      p.ctx.memory.write({}, (tx) => appendRecords(tx, [rec]));
      const shown = await cli(p.dir, ['read', 'show', 'evidence', 'xpe.m1.X1.1']);
      assert.equal(shown.code, 0, shown.err);
      assert.match(shown.out, /data outside the commit \(1\):/);
      assert.match(shown.out, new RegExp(`the executor's report: ${Buffer.byteLength("# the reader's report\n")} bytes`));
      const again = await cli(p.dir, ['read', 'show', 'evidence', 'xpe.m1.X1.1', '--check-data', '--json']);
      assert.equal(again.code, 0, again.err);
      assert.deepEqual(again.json?.result?.checked?.map((c: { state: string }) => c.state), ['unchanged']);
      assert.match((await cli(p.dir, ['read', 'show', 'evidence', 'xpe.m1.X1.1', '--check-data'])).out, /: unchanged \(size and sha256 as recorded\)/);
      writeFileSync(f.path, 'a\n2\n');
      assert.match((await cli(p.dir, ['read', 'show', 'evidence', 'xpe.m1.X1.1', '--check-data'])).out, /: changed \(the sha256 is now /);
      const wrong = await cli(p.dir, ['read', 'show', 'run', 'xpe.m1.X1.1', '--check-data']);
      assert.notEqual(wrong.code, 0);
      assert.match(wrong.err + wrong.out, /--check-data goes with mp read show evidence <id>/);
      assert.notEqual((await cli(p.dir, ['read', 'show', 'evidence', 'xpe.none'])).code, 0);
    } finally {
      p.cleanup();
    }
  });
});

// ---------------------------------------------------------------- j (code review r1)

describe('j: every seat keeps the check it cited; a path with a space', () => {
  test("the attacker's and the author's data, with the check kind, the sample and the label, kept with the hand-back; shown by the reads", async () => {
    const path = join(DIR, 'j/huge.bin');
    mkdirSync(join(DIR, 'j'), { recursive: true });
    const size = DATA_PARTIAL_OVER + 4096;
    const fd = openSync(path, 'w');
    writeSync(fd, Buffer.from('head'), 0, 4, 0);
    writeSync(fd, Buffer.from('tail'), 0, 4, size - 4);
    closeSync(fd);
    const small = dataFile('j/small.csv', 'k\n1\n');
    const w = await world();
    await w.advance();
    const at = only(w, 'researcher-author');
    const ad = w.scheduler.dispatchOf(at.task);
    assert.deepEqual(await w.scheduler.run(at.task, { handBack: submit(`v1 reads ${small.ptr('2')}`) }), []);
    await w.advance();
    const t = only(w, 'crititor');
    const d = w.scheduler.dispatchOf(t.task);
    const ptr = `data:${path}#sha256=${'0'.repeat(64)}&size=${size}`;
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: attack([{ ...finding('general', 'cost out of control', 'the corpus is huge'), basis: `see ${ptr}` }]) }), []);
    const docOf = (dispatch: string) => w.memory.read((db) => handbackDoc(w.memory.data, dispatchInfo(db, dispatch)!));
    const [att] = docOf(d)?.data ?? [];
    assert.deepEqual([att?.pointer, att?.path, att?.size, att?.check, att?.label], [ptr, path, size, 'partial', DATA_LABEL.partial]);
    assert.match(att?.sample ?? '', /^[0-9a-f]{64}$/, 'the sample a later check compares');
    const [aut] = docOf(ad)?.data ?? [];
    assert.deepEqual([aut?.path, aut?.line, aut?.sha256, aut?.check, aut?.label, aut?.sample], [small.path, '2', small.sha, 'full', DATA_LABEL.full, undefined]);
    // the reads: the dispatch, again read-only, and the exploration
    const shown = await showItem(project(w), 'dispatch', d, { checkData: true });
    assert.ok(shown?.text.includes(`${path} — ${size} bytes, sha256 ${'0'.repeat(16)}…; ${DATA_LABEL.partial}`), shown?.text);
    assert.match(shown?.text ?? '', /: unchanged \(the size and the first and last 64 MiB as recorded \(a partial check\)\)/);
    const x = await showItem(project(w), 'exploration', w.x);
    assert.ok(x?.text.includes(`attacker hand-back ${d} (task ${t.task}): data outside the commit (1;`), x?.text);
    assert.ok(x?.text.includes(`author hand-back ${ad} (task ${at.task}): data outside the commit (1;`), x?.text);
    // a hand-back that cites none keeps none (the document as before)
    const w2 = await world();
    await w2.advance();
    const t2 = only(w2, 'researcher-author');
    const d2 = w2.scheduler.dispatchOf(t2.task);
    assert.deepEqual(await w2.scheduler.run(t2.task, { handBack: submit('v1, no data') }), []);
    assert.equal(w2.memory.read((db) => handbackDoc(w2.memory.data, dispatchInfo(db, d2)!))?.data, undefined);
  });

  test('a path with a space is written %20 (a % as %25); the card line says so', async () => {
    const h = 'cd'.repeat(32);
    assert.deepEqual(dataPointers(`data:/runs/my%20data/out%25.csv:3#sha256=${h}&size=1 data:/r/ends%3A12#sha256=${h}&size=1 data:/r/raw%zz#sha256=${h}&size=1`).map((p) => [p.path, p.line]), [
      ['/runs/my data/out%.csv', '3'],
      ['/r/ends:12', null],
      ['/r/raw%zz', null],
    ]);
    assert.match(DATA_POINTER_LINE, /write a space in the path as %20, a % as %25/);
    const f = dataFile('j/with space/table.csv', 'a b\n');
    const w = await evidenceQueued('reading');
    const t = only(w, 'researcher-reader');
    const raw = `data:${f.path}#sha256=${f.sha}&size=${f.size}`;
    const refused = await w.scheduler.run(t.task, { handBack: blindResult(`${raw} and ${f.ptr().replace(/ /g, '%20')}`) });
    assert.ok(refused.some((p) => /is not a complete data pointer .*a space in the path is written %20/.test(p)), refused.join('; '));
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: blindResult(`data:${f.path.replace(/ /g, '%20')}#sha256=${f.sha}&size=${f.size}`) }), []);
    const [rec] = await evidenceRecords(w);
    assert.equal(rec?.fields['status'], 'completed');
    assert.match(rec?.fields['data:1'] ?? '', /^\S+ sha256=/, 'the field keeps a path without spaces: the pointer as written');
  });
});

// ---------------------------------------------------------------- k (code review r2)

describe('k: the cards built afterwards label each data pointer with its check', () => {
  test("an author's partial and an attacker's full pointer reach the attacker's, the Stabilizer's and the next author's cards, and the hand-off; never a blind card", async () => {
    const path = join(DIR, 'k/huge.bin');
    mkdirSync(join(DIR, 'k'), { recursive: true });
    const size = DATA_PARTIAL_OVER + 1;
    const fd = openSync(path, 'w');
    writeSync(fd, Buffer.from('x'), 0, 1, size - 1);
    closeSync(fd);
    const big = `data:${path}#sha256=${'9'.repeat(64)}&size=${size}`;
    const small = dataFile('k/table.csv', 'k,v\n1,2\n');
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit(`v1 rests on the corpus ${big}`));
    await w.advance();
    // the attacker reads the version: the pointer is in its material, its check on its card
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(c.dataChecked, [{ pointer: big, check: 'partial', label: DATA_LABEL.partial }]);
    const text = seatCardEntry('crititor').render(c);
    assert.ok(text.includes(`## Data outside the commit cited in the materials (each as mp checked it at hand-back)\n- ${big} — ${DATA_LABEL.partial}`), text);
    await hand(w, 'crititor', attack([{ ...finding('serious', 'internal contradiction', 'the table contradicts it'), basis: `see ${small.ptr('2')}` }]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.deepEqual(a.dataChecked?.map((d) => [d.pointer, d.check]), [[big, 'partial'], [small.ptr('2'), 'full']]);
    assert.ok(seatCardEntry('researcher-author').render(a).includes(`- ${small.ptr('2')} — ${DATA_LABEL.full}`));
    await hand(w, 'researcher-author', submit('v2', a.openFindings.map((f) => ({ finding: f.id, action: 'revise' as const, note: 'fixed' }))));
    await w.advance();
    const st = cardOf<CrititorCard>(w, 'stabilizer') as unknown as { dataChecked?: Array<{ check: string }> };
    assert.deepEqual(st.dataChecked?.map((d) => d.check), ['partial', 'full']);
    const s = await explorationState({ ledger: w.ledger }, M, w.x);
    assert.deepEqual(buildHandoff(s, 'converged', null).dataChecked?.map((d) => [d.check, d.label]), [['partial', DATA_LABEL.partial], ['full', DATA_LABEL.full]]);
    // a blind executor's card never carries them
    const e = await evidenceQueued('experiment');
    assert.equal((cardOf<ExperimentCard>(e, 'constructor-experiment') as unknown as { dataChecked?: unknown }).dataChecked, undefined);
    // an exploration whose hand-backs cite none: no field (its cards as before)
    assert.equal(cardOf<CrititorCard>(await (async () => { const z = await world(); await z.advance(); await hand(z, 'researcher-author', submit('v1')); await z.advance(); return z; })(), 'crititor').dataChecked, undefined);
  });
});
