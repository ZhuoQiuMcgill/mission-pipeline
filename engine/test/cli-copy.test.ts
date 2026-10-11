// Copying the folder (design 4.1 §3.3, §11.8, §11.15; WI-30, WI-31; decision 3): the first `mp`
// command in a copy recovers it and says what it found. A copy whose git common directory lies
// outside the folder (a linked worktree) shares one repository with the source: git writes are held
// until the PM confirms with `mp pm confirm-copy` that this copy is the one in use. A leaf edited
// by hand before the copy is reported (WI-30) and does not stop the memory.

import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cli, gitProject } from './cli-fixtures.ts';

describe('a copy of a linked worktree\'s folder: git writes held until mp pm confirm-copy (WI-31)', () => {
  const p = gitProject();
  after(() => p.cleanup());

  it('reports the hold and the layout; confirm-copy releases it; the source is untouched', async () => {
    const wt = join(p.base, 'linked');
    p.git('worktree', 'add', '-q', '-b', 'work', wt);
    assert.equal((await cli(wt, ['init'])).code, 0);
    await cli(wt, ['pm', 'mission', 'open', 'm1']);
    const w = (await cli(wt, ['pm', 'say', 'Keep the words of this copy.', '--json'])).json.result.words as string;
    // a leaf edited by hand before the copy
    const day = readFileSync(join(wt, '.mission-pipeline', 'words', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
    writeFileSync(join(wt, '.mission-pipeline', 'words', `${new Date().toISOString().slice(0, 10)}.md`), day.replace('Keep the words', 'Change the words'));

    const copy = join(p.base, 'linked-copy');
    cpSync(wt, copy, { recursive: true });
    const st = await cli(copy, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.code, 0, st.err);
    const codes = (st.json.problems as Array<{ code: string; wi: string | null }>).map((x) => `${x.code}:${x.wi}`);
    for (const c of ['MOVED:null', 'GIT_WRITES_HELD:WI-31', 'LAYOUT:WI-31', 'LEAVES:WI-30']) assert.ok(codes.includes(c), `${c} in ${codes.join(', ')}`);
    // the memory keeps working: words are recorded, the edited leaf is shown as edited
    assert.equal((await cli(copy, ['pm', 'say', 'More words in the copy.', '--json'])).code, 0);
    const leaf = await cli(copy, ['read', 'leaf', w]);
    assert.match(leaf.out, /EDITED AFTER IT WAS RECORDED/);
    const conf = await cli(copy, ['pm', 'confirm-copy', '--json']);
    assert.equal(conf.code, 0, conf.err);
    assert.equal(conf.json.result.released, true);
    const after2 = await cli(copy, ['read', 'status', '--json', '--no-mark']);
    assert.ok(!(after2.json.problems as Array<{ code: string }>).some((x) => x.code === 'GIT_WRITES_HELD'));
    assert.equal((await cli(copy, ['pm', 'confirm-copy', '--json'])).json.result.released, false);
    // the text form names the move once
    const copy2 = join(p.base, 'linked-copy-2');
    cpSync(copy, copy2, { recursive: true });
    const text = await cli(copy2, ['read', 'status', '--no-mark']);
    assert.equal(text.out.split('was copied or moved').length - 1, 1, text.out);
    const src = await cli(wt, ['read', 'status', '--json', '--no-mark']);
    assert.ok(!(src.json.problems as Array<{ code: string }>).some((x) => x.code === 'GIT_WRITES_HELD' || x.code === 'MOVED'), 'the source folder is not a copy');
  });
});
