// The leaves (design 4.1 §3.2 "Writing a leaf", §3.3, §5.2): documents written
// once by temporary name and rename; journal entries appended with an anchor
// derived from the operation id, never twice; written inside the write
// transaction, so a crash before the commit leaves an orphan that is never
// served and is removed by the next write; reads check the hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../src/common/hash.ts';
import { entryText, setMission } from '../src/memory/index.ts';
import { id, type MissionId } from '../src/common/ids.ts';
import { child, project, throwsCode } from './memory-fixtures.ts';

const M = id<MissionId>('m1');
const anchorOf = (op: string, k = 0): string => `e-${sha256(`${op}\n${k}`).slice(0, 16)}`;
const count = (s: string, sub: string): number => s.split(sub).length - 1;

test('documents are written once and read back with their hash; journal entries are anchored blocks', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const out = w.m.write({ op: 'op-1', payload: 1 }, (tx) => ({
      doc: tx.leaves.writeDocument('missions/m1/plans/plan-v1.md', '# Plan v1\n\nBuild it.\n'),
      a: tx.leaves.appendEntry('missions/m1/decisions.md', '## Decision 1\n\nBecause.'),
      b: tx.leaves.appendEntry('missions/m1/decisions.md', '## Decision 2\n\nAlso.\n'),
    }));
    assert.equal(out.doc.leaf, 'missions/m1/plans/plan-v1.md');
    assert.equal(out.a.leaf, `missions/m1/decisions.md#${anchorOf('op-1', 0)}`);
    assert.equal(out.b.anchor, anchorOf('op-1', 1));
    assert.equal(readFileSync(join(root, 'missions', 'm1', 'plans', 'plan-v1.md'), 'utf8'), '# Plan v1\n\nBuild it.\n');
    const journal = readFileSync(join(root, 'missions', 'm1', 'decisions.md'), 'utf8');
    assert.equal(entryText(journal, out.a.anchor!), '## Decision 1\n\nBecause.\n', 'a newline ends every entry');
    assert.match(journal, /^<!-- mp:entry e-[0-9a-f]{16} -->\n## Decision 1/);
    for (const l of [out.doc, out.a, out.b]) assert.equal(w.m.readLeaf(l.leaf)?.status, 'ok');
    assert.deepEqual(readdirSync(join(root, 'missions', 'm1', 'plans')), ['plan-v1.md'], 'no temporary file left');
    // A document is written once: the same text again is its reference; other text is refused.
    assert.deepEqual(w.m.write({ op: 'op-2', payload: 2 }, (tx) => tx.leaves.writeDocument('missions/m1/plans/plan-v1.md', '# Plan v1\n\nBuild it.\n')), out.doc);
    throwsCode(() => w.m.write({ op: 'op-3', payload: 3 }, (tx) => tx.leaves.writeDocument('missions/m1/plans/plan-v1.md', '# changed\n')), 'FACT_CONFLICT', /written once/);
    throwsCode(() => w.m.write({ op: 'op-4', payload: 4 }, (tx) => tx.leaves.writeDocument('missions/m1/decisions.md', 'x')), 'FACT_CONFLICT', /journal leaf/);
    // Paths are portable, relative, Markdown, outside the working areas; a journal entry needs an op id.
    for (const bad of ['../x.md', '/abs.md', 'a//b.md', 'tmp/x.md', 'worktrees/D/x.md', 'x.txt', 'a\\b.md', 'con.md', 'trailing./x.md', 'a:b.md']) {
      throwsCode(() => w.m.write({}, (tx) => tx.leaves.writeDocument(bad, 'x')), 'BAD_REQUEST');
    }
    throwsCode(() => w.m.write({}, (tx) => tx.leaves.appendEntry('constraints.md', 'x')), 'BAD_REQUEST', /operation id/);
    throwsCode(() => w.m.write({ op: 'm', payload: 1 }, (tx) => tx.leaves.appendEntry('constraints.md', 'a <!-- mp:end x --> b')), 'BAD_REQUEST', /markers/);
  } finally {
    w.cleanup();
  }
});

test('a write that rolls back removes its own leaves; a retry neither loses nor doubles them', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const attempt = (fail: boolean) =>
      w.m.write({ op: 'say-1', payload: 1 }, (tx) => {
        tx.leaves.writeDocument('missions/m1/plans/p.md', '# p\n');
        tx.leaves.appendEntry('constraints.md', 'C-1: no network');
        if (fail) throw new Error('refused after the leaves');
        return null;
      });
    assert.throws(() => attempt(true), /refused after the leaves/);
    assert.equal(existsSync(join(root, 'missions', 'm1', 'plans', 'p.md')), false);
    assert.equal(existsSync(join(root, 'constraints.md')), false);
    assert.equal(w.m.status().pendingLeaves, false);
    attempt(false);
    attempt(false);
    assert.equal(count(readFileSync(join(root, 'constraints.md'), 'utf8'), 'C-1: no network'), 1);
  } finally {
    w.cleanup();
  }
});

test('a process killed before the commit leaves orphans: never served, removed by the next write; the retry appends once', async () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const doc = 'missions/m1/dispatches/D-1/report.md';
    const journal = 'missions/m1/notices.md';
    const crashed = child({ action: 'crash-in-write', project: w.dir, op: 'op-crash', document: doc, journal });
    assert.equal(await crashed.exit, -1, 'killed');
    // The files are there, the skeleton names none of them.
    assert.ok(existsSync(join(root, 'missions', 'm1', 'dispatches', 'D-1', 'report.md')));
    assert.match(readFileSync(join(root, 'missions', 'm1', 'notices.md'), 'utf8'), new RegExp(anchorOf('op-crash')));
    assert.equal(w.m.readLeaf(doc), null, 'an orphan is never served');
    assert.equal(w.m.status().pendingLeaves, true);
    // The next write (any) removes them.
    w.m.write({}, (tx) => setMission(tx, M, 'open'));
    assert.equal(existsSync(join(root, 'missions', 'm1', 'dispatches', 'D-1', 'report.md')), false);
    assert.equal(existsSync(join(root, 'missions', 'm1', 'notices.md')), false);
    assert.equal(w.m.status().pendingLeaves, false);
    // The retry of the same operation writes them once.
    const payload = { document: doc, journal };
    for (let i = 0; i < 2; i++) {
      w.m.write({ op: 'op-crash', payload }, (tx) => {
        tx.leaves.writeDocument(doc, '# the document\n');
        tx.leaves.appendEntry(journal, 'the entry');
        return null;
      });
    }
    assert.equal(count(readFileSync(join(root, 'missions', 'm1', 'notices.md'), 'utf8'), `<!-- mp:entry ${anchorOf('op-crash')} -->`), 1);
    assert.equal(w.m.readLeaf(`${journal}#${anchorOf('op-crash')}`)?.status, 'ok');
  } finally {
    w.cleanup();
  }
});

test('a crash after the commit keeps the leaves: a note left behind finds them committed', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const ref = w.m.write({ op: 'op-1', payload: 1 }, (tx) => tx.leaves.appendEntry('constraints.md', 'C-1'));
    // As if the process died between its commit and removing its note.
    const notes = join(root, 'tmp', '.leaves-pending');
    writeFileSync(join(notes, 'dead-1.json'), JSON.stringify({ op: 'op-1', entries: [{ leaf: ref.leaf, kind: 'journal', file: 'constraints.md', anchor: ref.anchor, prefix: 0 }] }));
    w.m.write({}, (tx) => setMission(tx, M, 'open'));
    assert.equal(w.m.readLeaf(ref.leaf)?.status, 'ok');
    assert.deepEqual(readdirSync(notes), []);
  } finally {
    w.cleanup();
  }
});

test('a journal entry already in the file (an attempt that never committed, its note lost) is not appended again', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const a = anchorOf('op-dup');
    writeFileSync(join(root, 'constraints.md'), `<!-- mp:entry ${a} -->\nC-7: keep it\n<!-- mp:end ${a} -->\n`);
    const ref = w.m.write({ op: 'op-dup', payload: 1 }, (tx) => tx.leaves.appendEntry('constraints.md', 'C-7: keep it'));
    assert.equal(ref.anchor, a);
    assert.equal(count(readFileSync(join(root, 'constraints.md'), 'utf8'), `<!-- mp:entry ${a} -->`), 1);
    assert.equal(w.m.readLeaf(ref.leaf)?.status, 'ok');
    // A torn block of a crashed attempt (no end marker) is replaced by the whole entry.
    const b = anchorOf('op-torn');
    writeFileSync(join(root, 'missions', 'n.md'), `earlier text\n\n<!-- mp:entry ${b} -->\nhalf of it`, { flag: 'w' });
    const ref2 = w.m.write({ op: 'op-torn', payload: 1 }, (tx) => tx.leaves.appendEntry('missions/n.md', 'the whole entry'));
    const text = readFileSync(join(root, 'missions', 'n.md'), 'utf8');
    assert.equal(count(text, `<!-- mp:entry ${b} -->`), 1);
    assert.ok(text.startsWith('earlier text\n'), 'text that is not the memory’s stays');
    assert.equal(w.m.readLeaf(ref2.leaf)?.status, 'ok');
  } finally {
    w.cleanup();
  }
});

test('a leaf edited by hand or deleted is reported, not served silently', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const refs = w.m.write({ op: 'op-1', payload: 1 }, (tx) => ({
      card: tx.leaves.writeDocument('missions/m1/dispatches/D-1/card.md', '# card\n'),
      entry: tx.leaves.appendEntry('missions/m1/requirements.md', 'R-1 v1: the quote'),
      other: tx.leaves.appendEntry('missions/m1/requirements.md', 'R-2 v1: another'),
    }));
    writeFileSync(join(root, 'missions', 'm1', 'dispatches', 'D-1', 'card.md'), '# card, edited\n');
    const req = join(root, 'missions', 'm1', 'requirements.md');
    writeFileSync(req, readFileSync(req, 'utf8').replace('the quote', 'a changed quote'));
    const card = w.m.readLeaf(refs.card.leaf)!;
    assert.deepEqual([card.status, card.text], ['edited', '# card, edited\n']);
    assert.equal(w.m.readLeaf(refs.entry.leaf)?.status, 'edited');
    assert.equal(w.m.readLeaf(refs.other.leaf)?.status, 'ok', 'only the edited entry is reported');
    writeFileSync(req, '');
    assert.deepEqual([w.m.readLeaf(refs.entry.leaf)?.status, w.m.readLeaf(refs.entry.leaf)?.text], ['missing', null]);
    assert.equal(w.m.readLeaf('missions/m1/none.md'), null);
  } finally {
    w.cleanup();
  }
});

test('review #6: a leaf whose name differs only in letter case from a recorded one is refused, and the recorded one is never touched', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    w.m.write({ op: 'a', payload: 1 }, (tx) => tx.leaves.writeDocument('missions/m1/dispatches/D-a/card.md', '# a\n'));
    throwsCode(() => w.m.write({ op: 'b', payload: 1 }, (tx) => tx.leaves.writeDocument('missions/m1/dispatches/D-A/card.md', '# A\n')), 'FACT_CONFLICT', /differs only in letter case/);
    throwsCode(() => w.m.write({ op: 'c', payload: 1 }, (tx) => tx.leaves.appendEntry('Missions/m1/dispatches/D-a/card.md', 'x')), 'FACT_CONFLICT');
    assert.equal(readFileSync(join(root, 'missions', 'm1', 'dispatches', 'D-a', 'card.md'), 'utf8'), '# a\n');
    assert.equal(w.m.readLeaf('missions/m1/dispatches/D-a/card.md')?.status, 'ok');
    // A dead writer's note naming the alias never removes the recorded file (one file on Windows and macOS).
    const notes = join(root, 'tmp', '.leaves-pending');
    mkdirSync(join(root, 'missions', 'm1', 'dispatches', 'D-A'), { recursive: true });
    writeFileSync(join(root, 'missions', 'm1', 'dispatches', 'D-A', 'card.md'), '# A\n');
    writeFileSync(join(notes, 'dead-2.json'), JSON.stringify({ op: 'x', entries: [{ leaf: 'missions/m1/dispatches/D-A/card.md', kind: 'document', file: 'missions/m1/dispatches/D-A/card.md', anchor: null, prefix: 0 }] }));
    w.m.write({}, (tx) => setMission(tx, M, 'open'));
    assert.equal(w.m.readLeaf('missions/m1/dispatches/D-a/card.md')?.status, 'ok');
    assert.ok(existsSync(join(root, 'missions', 'm1', 'dispatches', 'D-A', 'card.md')), 'the cleanup leaves a file that is a recorded leaf in another case alone');
  } finally {
    w.cleanup();
  }
});

test('review round 2 #3: a dead writer’s note naming a journal entry in another letter case never removes the committed entry', () => {
  const w = project();
  try {
    const root = join(w.dir, '.mission-pipeline');
    const ref = w.m.write({ op: 'entry', payload: 1 }, (tx) => tx.leaves.appendEntry('constraints.md', 'committed text'));
    // On Windows and macOS, Constraints.md is constraints.md: here a copy of it stands for that one file.
    const committed = readFileSync(join(root, 'constraints.md'), 'utf8');
    writeFileSync(join(root, 'Constraints.md'), committed);
    const notes = join(root, 'tmp', '.leaves-pending');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'old-case-note.json'), JSON.stringify({ entries: [{ leaf: `Constraints.md#${ref.anchor}`, file: 'Constraints.md', anchor: ref.anchor, kind: 'journal', prefix: 0 }] }));
    w.m.write({}, (tx) => setMission(tx, M, 'open'));
    assert.equal(readFileSync(join(root, 'Constraints.md'), 'utf8'), committed, 'the entry stays');
    assert.equal(w.m.readLeaf(ref.leaf)?.status, 'ok');
    assert.deepEqual(readdirSync(notes), []);
  } finally {
    w.cleanup();
  }
});
