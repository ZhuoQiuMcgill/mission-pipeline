// Parity of the program's own eol/ident conversions with git (7.1: "全部由程序自己按
// git 的规则实现"). For every combination of attributes, core.autocrlf, core.eol and
// content, the snapshot the program materializes must equal git's checkout byte for
// byte, and the blob the program generates must equal what `git add` stores
// (including the safer-autocrlf rule that looks at the previously recorded blob).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { discoverRepo, gitOid, readObjects } from '../src/git/objects.ts';
import {
  AttributeEvaluator,
  materializeSnapshot,
  readTransformDescription,
  resolveConversion,
  toRepository,
  type ConversionAttributes,
} from '../src/git/representation.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, readTreeContent, sameTreeContent, type Fixture } from './git-fixtures.test.ts';

const CONTENTS: readonly string[] = [
  'a\nb\n',
  'a\r\nb\r\n',
  'a\r\nb\n',
  'a\rb\n',
  'nul\0\r\nx\n',
  '',
  'x',
  '\r\n',
  'line\r',
  'a\n\r\n\x1a',
  '\x1a',
  '$Id$\n',
  '$Id: deadbeef $\nq\n',
  '$Id: foo bar $\n',
  '$Id$\r\n$Id: x $\r\n',
  '$Id:\nnot an id $\n$Id$',
  '\x01\x02\x03\x04 mostly non-printable \x05\x06\x07\x0e\x0f\x10\x11\x12\n',
  'tab\tand\x0cform\x08feed\x1bescape\n',
];

const ATTRS: readonly string[] = [
  '',
  'text',
  '-text',
  'text=auto',
  'eol=lf',
  'eol=crlf',
  'text eol=crlf',
  'text eol=lf',
  'text=auto eol=crlf',
  'text=auto eol=lf',
  'crlf',
  '-crlf',
  'crlf=input',
  'text=input',
  'ident',
  'ident eol=crlf',
  'ident text=auto',
  'binary',
  '-text eol=crlf',
  'working-tree-encoding=UTF-8',
];

const CONFIGS: readonly { autocrlf: string | null; eol: string | null }[] = [];
for (const autocrlf of [null, 'true', 'input']) for (const eol of [null, 'lf', 'crlf']) (CONFIGS as { autocrlf: string | null; eol: string | null }[]).push({ autocrlf, eol });

function gitattributes(): string {
  return ATTRS.map((a, j) => (a === '' ? '' : `*.a${j} ${a}\n`)).join('');
}

let fx: Fixture;
before(() => {
  fx = makeFixture('parity');
});
after(() => fx.cleanup());

test('materialized snapshots equal git checkout for every attribute, config and content combination', async () => {
  let compared = 0;
  for (const [ci, cfg] of CONFIGS.entries()) {
    const repo = initRepo(fx, `co${ci}`);
    if (cfg.autocrlf !== null) fx.raw(['config', 'core.autocrlf', cfg.autocrlf], repo);
    if (cfg.eol !== null) fx.raw(['config', 'core.eol', cfg.eol], repo);
    const files: Record<string, string> = { '.gitattributes': gitattributes() };
    CONTENTS.forEach((c, i) => ATTRS.forEach((_a, j) => (files[`f${i}.a${j}`] = c)));
    const commit = rawCommit(fx, repo, files, null, 'parity');
    checkoutMain(fx, repo, commit);
    const layout = await discoverRepo(fx.git, repo);
    const d = await readTransformDescription(fx.git, layout, fx.user);
    assert.equal(d.autocrlf, cfg.autocrlf === null ? 'false' : cfg.autocrlf);
    const ev = await AttributeEvaluator.create(fx.git, layout, d, fx.root);
    try {
      const dest = join(fx.root, `snap-co${ci}`);
      const manifest = await materializeSnapshot({ git: fx.git, repo: layout, commit, attributes: ev, dest });
      assert.deepEqual(manifest.unsupported, []);
      const diffs = sameTreeContent(readTreeContent(repo), readTreeContent(dest));
      assert.deepEqual(diffs, [], `config ${JSON.stringify(cfg)}: ${diffs.slice(0, 10).join(', ')}`);
      compared += manifest.entries.length;
    } finally {
      ev.dispose();
    }
  }
  assert.equal(compared, CONFIGS.length * (CONTENTS.length * ATTRS.length + 1));
});

test('generated blobs equal what git add stores, including the safer-autocrlf rule', async () => {
  // The previously recorded blob matters for text=auto and autocrlf (has_crlf_in_index).
  const BASES: readonly (string | null)[] = [null, 'a\nb\n', 'a\r\nb\r\n', 'x\r\ny\n', 'bin\0\r\n'];
  let compared = 0;
  for (const [ci, cfg] of CONFIGS.entries()) {
    const repo = initRepo(fx, `add${ci}`);
    if (cfg.autocrlf !== null) fx.raw(['config', 'core.autocrlf', cfg.autocrlf], repo);
    if (cfg.eol !== null) fx.raw(['config', 'core.eol', cfg.eol], repo);
    fx.raw(['config', 'core.safecrlf', 'false'], repo);
    const base: Record<string, string> = { '.gitattributes': gitattributes() };
    const paths: { path: string; baseContent: string | null; next: string; attr: number }[] = [];
    BASES.forEach((b, bi) =>
      CONTENTS.forEach((c, k) =>
        ATTRS.forEach((_a, j) => {
          const path = `b${bi}/n${k}.a${j}`;
          if (b !== null) base[path] = b;
          paths.push({ path, baseContent: b, next: c, attr: j });
        }),
      ),
    );
    const commit = rawCommit(fx, repo, base, null, 'base');
    checkoutMain(fx, repo, commit);
    for (const p of paths) {
      mkdirSync(join(repo, p.path, '..'), { recursive: true });
      writeFileSync(join(repo, p.path), p.next);
    }
    fx.raw(['add', '-A'], repo);
    const staged = new Map<string, ReturnType<typeof gitOid>>();
    for (const rec of execFileSync('/usr/bin/git', ['ls-files', '-s', '-z'], { cwd: repo, env: fx.env }).toString('utf8').split('\0')) {
      if (rec === '') continue;
      const tab = rec.indexOf('\t');
      staged.set(rec.slice(tab + 1), gitOid(rec.slice(0, tab).split(' ')[1] as string));
    }
    const layout = await discoverRepo(fx.git, repo);
    const d = await readTransformDescription(fx.git, layout, fx.user);
    const ev = await AttributeEvaluator.create(fx.git, layout, d, fx.root);
    try {
      const attrs = await ev.atTree(commit, paths.map((p) => p.path));
      const blobs = new Map<string, Buffer>();
      await readObjects(fx.git, layout, [...staged.values()], (oid, _t, c) => {
        blobs.set(oid, c);
      });
      const mismatches: string[] = [];
      for (const p of paths) {
        const conv = resolveConversion(attrs.get(p.path) as ConversionAttributes, d);
        const ours = toRepository(Buffer.from(p.next, 'latin1'), conv, p.baseContent === null ? null : Buffer.from(p.baseContent, 'latin1')).blob;
        const theirs = blobs.get(staged.get(p.path) as string) as Buffer;
        if (!ours.equals(theirs)) mismatches.push(`${p.path} [${ATTRS[p.attr]}] base=${JSON.stringify(p.baseContent)} ours=${JSON.stringify(ours.toString('latin1'))} git=${JSON.stringify(theirs.toString('latin1'))}`);
        compared++;
      }
      assert.deepEqual(mismatches, [], `config ${JSON.stringify(cfg)}:\n${mismatches.slice(0, 8).join('\n')}`);
    } finally {
      ev.dispose();
    }
  }
  assert.equal(compared, CONFIGS.length * BASES.length * CONTENTS.length * ATTRS.length);
});
