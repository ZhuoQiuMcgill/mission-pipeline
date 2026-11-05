// 4.1.3 P3 item 2 (E-4; field issue #45): the executor's report reaches the interpreter and the attacker.
//   a  an experiment's report is kept with its evidence record, as a value of its own (the record
//      stays small); the attacker's and the author's cards serve it as a readable material
//   b  a research exploration: the interpreter reads each attempt's report; the next blind
//      executor's card never carries one
//   c  a report over 256 KiB is cut on a character boundary, with a note of its full size and sha256
//   d  no report (blank, or only the fenced fields): nothing changes

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { EvidenceRecord } from '../src/common/records.ts';
import { EXECUTOR_REPORT_LIMIT, executorReportOf, keptExecutorReport, type BlindResult, type ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard, InterpreterCard, ReaderCard, RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import { seatCardEntry } from '../src/seat/cards/index.ts';
import { splitStdinDocument } from '../src/cli/commands/seat.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, finding, hand, only, submit, world, type World } from './flow-exploration-fixtures.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const REQUEST = { steps: ['run the probe'], data: 'the fixture', measure: ['status'], assertions: ['the status is failed'], executor: 'experiment' as const, commands: [{ id: 'probe', command: 'node probe.js' }] };
const REPORT = '# Report\n\nI ran the probe twice.\n\n## Appendix A: the full table\n\n| run | status |\n|---|---|\n| 1 | failed |\n| 2 | failed |\n';

const evidenceRecords = async (w: World): Promise<EvidenceRecord[]> => (await w.ledger.records(['evidence'])).map((c) => c.record).filter((r) => r.evidence.startsWith('xpe.'));

/** An experiment's hand-back as a scripted seat gives it, with its claims citing a run of its dispatch, and a report. */
async function handExperiment(w: World, report: string): Promise<void> {
  const t = only(w, 'constructor-experiment');
  const d = w.scheduler.dispatchOf(t.task);
  const run = w.scheduler.rerun(d, 'probe', true);
  const fields = JSON.parse(JSON.stringify(blind(t.card as unknown as ExperimentCard)).split(RUN_PLACEHOLDER).join(`run:${run}`)) as BlindResult;
  assert.deepEqual(await w.scheduler.run(t.task, { handBack: fields, report }), []);
}

/** A design exploration whose attacker raised a finding and whose author asked for an experiment, now handed back with `report`. */
async function evidenceHandedBack(report: string): Promise<World> {
  const w = await world();
  await w.advance();
  await hand(w, 'researcher-author', submit('v1'));
  await w.advance();
  await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'a lost run leaves no record')]));
  await w.advance();
  assert.deepEqual(await w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, notes: 'notes' }), []);
  await w.advance();
  await handExperiment(w, report);
  await w.advance();
  return w;
}

describe("the executor's report", () => {
  test('a: kept with the evidence record as a value of its own; served to the author and the attacker, readable', async () => {
    const w = await evidenceHandedBack(REPORT);
    const [rec] = await evidenceRecords(w);
    assert.ok(rec !== undefined);
    const ref = rec.fields['executorReport'];
    assert.equal(w.ledger.content.get(ref!), REPORT, 'the report, as the seat wrote it');
    assert.equal(rec.fields['executorReportCut'], undefined);
    const doc = w.ledger.content.get(rec.fields['report']!);
    assert.deepEqual(executorReportOf(doc), { ref, bytes: Buffer.byteLength(REPORT), sha256: sha(REPORT), leaf: `missions/${M}/dispatches/${w.memory.read((db) => (db.stmt("SELECT dispatch FROM dispatches WHERE task LIKE '%executor'").get() as { dispatch: string }).dispatch)}/report.md` });
    assert.ok(canonicalJson(rec).length < 4096, 'the record stays small: the report is a value of its own');
    // the author continues: the report is a readable material, named on the evidence line
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const m = a.materials.find((x) => x.id === `evidence-${rec.evidence}-executor`);
    assert.deepEqual([m?.ref, m?.mustRead], [ref, false]);
    assert.equal(a.evidence[0]?.executorReport, m?.id);
    assert.ok(seatCardEntry('researcher-author').render(a).includes(`(the executor's report: material evidence-${rec.evidence}-executor)`));
    // the rebuttal goes to the attacker, who reads it too
    await hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'the run shows it', evidence: rec.evidence }]));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    const cm = c.materials.find((x) => x.id === `evidence-${rec.evidence}-executor`);
    assert.deepEqual([cm?.ref, cm?.mustRead], [ref, false]);
    assert.equal(c.evidence.find((e) => e.id === rec.evidence)?.executorReport, cm?.id);
  });

  test('b: a research exploration: the interpreter reads each attempt\'s report; a blind executor never does', async () => {
    const URL = 'https://docs.example.org/';
    const ATTEMPTS: RegisteredAttemptT[] = [
      { id: 'A1', kind: 'experiment', purpose: 'does it survive', steps: ['run the crash script'], data: 'the repository', measure: ['survivals'], assertions: [], commands: [{ id: 'probe', command: 'sh crash.sh' }] },
      { id: 'A2', kind: 'reading', purpose: 'what is documented', steps: ['read the documentation'], data: URL, measure: ['guarantee'], assertions: [] },
    ];
    const w = await world({ product: 'answer', research: true, question: 'Does the lock survive a crash?', decision: { type: 'structure', text: 'which lock' }, readingNetwork: [URL] });
    await w.advance();
    await hand(w, 'researcher-author', submit('method v1', [], { attempts: ATTEMPTS }));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    await handExperiment(w, '# A1\n\nAppendix: 20 of 20 survived.\n');
    await w.advance();
    // the reading's card is blind: no evidence, no report, nothing of A1's run
    const reader = cardOf<ReaderCard>(w, 'researcher-reader');
    assert.deepEqual(reader.materials, []);
    assert.ok(!JSON.stringify(reader).includes('20 of 20'));
    assert.deepEqual(await w.scheduler.run(only(w, 'researcher-reader').task, { handBack: blind(reader), report: '# A2\n\nThe page says it holds.\n' }), []);
    await w.advance();
    const i = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    for (const [id, text] of [['A1', '20 of 20 survived'], ['A2', 'The page says it holds']] as const) {
      const at = i.attempts.find((a) => a.id === id);
      const m = i.materials.find((x) => x.id === at?.executorReport);
      assert.equal(m?.mustRead, false, `${id}: readable, not must-read`);
      assert.ok(w.ledger.content.get(m!.ref).includes(text), id);
      assert.ok(seatCardEntry('researcher-interpreter').render(i).includes(`(the executor's report: material ${m!.id})`));
    }
  });

  test('c: a report over 256 KiB is cut on a character boundary, with a note of its full size and sha256', () => {
    const big = `# Report\n\n${'é'.repeat(EXECUTOR_REPORT_LIMIT)}`;
    const k = keptExecutorReport(big, 'missions/M1/dispatches/D-9/report.md');
    assert.ok(k !== null && k.kept !== undefined);
    assert.equal(k.bytes, Buffer.byteLength(big));
    assert.ok(k.kept <= EXECUTOR_REPORT_LIMIT && k.kept > EXECUTOR_REPORT_LIMIT - 4);
    assert.ok(!k.text.includes('�'), 'no broken character');
    assert.match(k.text, new RegExp(`\\[mp: the report was cut here: ${k.kept} of ${k.bytes} bytes kept\\. The full report has sha256 ${sha(big)}; it is the hand-back's report leaf missions/M1/dispatches/D-9/report\\.md\\.\\]\\n$`));
    assert.ok(Buffer.byteLength(k.text) < EXECUTOR_REPORT_LIMIT + 400);
  });

  test('c: through a hand-back: the record names the cut, and stays small', async () => {
    const big = `# Report\n\n${'x'.repeat(EXECUTOR_REPORT_LIMIT + 10_000)}`;
    const w = await evidenceHandedBack(big);
    const [rec] = await evidenceRecords(w);
    assert.match(rec?.fields['executorReportCut'] ?? '', new RegExp(`^${EXECUTOR_REPORT_LIMIT} of ${Buffer.byteLength(big)} bytes kept; the full report has sha256 ${sha(big)}$`));
    assert.ok(canonicalJson(rec).length < 4096);
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.match(a.materials.find((x) => x.id.endsWith('-executor'))?.title ?? '', /the executor's report \(cut at 262144 of \d+ bytes\)/);
  });

  test('d: no report, or only the fenced fields: nothing changes', async () => {
    const result = { steps: [] };
    assert.equal(keptExecutorReport('   \n', null), null);
    assert.equal(keptExecutorReport('```json\n{"steps":[]}\n```\n', null, { fields: [result] }), null, 'the block that holds the fields is not report');
    for (const report of ['', 'RESULT']) {
      const w = await world();
      await w.advance();
      await hand(w, 'researcher-author', submit('v1'));
      await w.advance();
      await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'a lost run leaves no record')]));
      await w.advance();
      assert.deepEqual(await w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, notes: 'notes' }), []);
      await w.advance();
      const t = only(w, 'constructor-experiment');
      const run = w.scheduler.rerun(w.scheduler.dispatchOf(t.task), 'probe', true);
      const fields = JSON.parse(JSON.stringify(blind(t.card as unknown as ExperimentCard)).split(RUN_PLACEHOLDER).join(`run:${run}`)) as BlindResult;
      // the stdin form with no Markdown: the CLI files the whole document, the fields' block, as the report
      const doc = `\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n`;
      const split = splitStdinDocument(doc, null);
      assert.equal(split?.report, doc);
      assert.deepEqual(await w.scheduler.run(t.task, { handBack: fields, report: report === '' ? '' : split!.report }), []);
      await w.advance();
      const [rec] = await evidenceRecords(w);
      assert.equal(rec?.fields['executorReport'], undefined, report);
      assert.equal(executorReportOf(w.ledger.content.get(rec!.fields['report']!)), null);
      const a = cardOf<AuthorCard>(w, 'researcher-author');
      assert.equal(a.materials.some((m) => m.id.endsWith('-executor')), false);
      assert.equal(a.evidence[0]?.executorReport, undefined);
    }
  });

  test('e: a report that is only a json table plus the fields (the stdin form) keeps the table', async () => {
    const table = '```json\n[{"run":1,"status":"failed"},{"run":2,"status":"failed"}]\n```';
    assert.ok(keptExecutorReport(`${table}\n`, null, { fields: [{ steps: [] }] }) !== null, 'a json block that is not the fields is report');
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'a lost run leaves no record')]));
    await w.advance();
    assert.deepEqual(await w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, notes: 'notes' }), []);
    await w.advance();
    const t = only(w, 'constructor-experiment');
    const run = w.scheduler.rerun(w.scheduler.dispatchOf(t.task), 'probe', true);
    const fields = JSON.parse(JSON.stringify(blind(t.card as unknown as ExperimentCard)).split(RUN_PLACEHOLDER).join(`run:${run}`)) as BlindResult;
    const split = splitStdinDocument(`${table}\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\`\n`, null);
    assert.ok(split !== null && split.report.includes('"run":2'), 'the CLI keeps the appendix in the report');
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: JSON.parse(split.json), report: split.report }), []);
    await w.advance();
    const [rec] = await evidenceRecords(w);
    assert.ok(w.ledger.content.get(rec!.fields['executorReport']!).includes('"run":2,"status":"failed"'));
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.evidence[0]?.executorReport, `evidence-${rec!.evidence}-executor`, 'served with the evidence');
  });
});
