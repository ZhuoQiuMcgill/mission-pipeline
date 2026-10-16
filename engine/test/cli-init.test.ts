// `mp init` and `mp docs update` (design 4.1 §3.1, §3.3, §4.2, §9): the folder and memory, the role
// descriptions and the PM handbook copied in, a default config.json, the installed version recorded,
// the git exclude line, the optional pointer line (no pipeline rules), the repository layout warning
// (WI-31) that never refuses; `mp docs update` refreshes the copies and removes retired pages.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { WI_41 } from '../src/cli/wi.ts';
import { POINTER_LINE } from '../src/cli/init.ts';
import { cli, gitProject, write } from './cli-fixtures.ts';

describe('mp init', () => {
  const p = gitProject();
  after(() => p.cleanup());
  const mp = join(p.dir, '.mission-pipeline');

  it('creates the memory, copies the roles and the handbook, writes config.json, excludes the folder from git', async () => {
    write(p.dir, 'CLAUDE.md', '# Project notes\n\nUse tabs.\n');
    const r = await cli(p.dir, ['init', '--pointer', 'claude', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.result.memory.created, true);
    assert.ok(existsSync(join(mp, 'memory.db')));
    for (const d of ['words', 'missions', 'roles', 'pm', 'worktrees', 'tmp', 'locks']) assert.ok(existsSync(join(mp, d)), d);
    const roles = readdirSync(join(mp, 'roles')).sort();
    assert.deepEqual(roles, ['architect.md', 'auditor.md', 'calibrator.md', 'constructor.md', 'crititor.md', 'pm.md', 'researcher.md', 'reviewer.md', 'secretary.md', 'stabilizer.md']);
    assert.ok(existsSync(join(mp, 'pm', 'PM.md')));
    assert.deepEqual(readdirSync(join(mp, 'pm', 'wi')).filter((f) => f.startsWith('WI-')).map((f) => f.slice(0, 5)).sort(), [...WI_41].sort());
    assert.ok(existsSync(join(mp, 'pm', 'wi', 'INDEX.md')));
    const installed = JSON.parse(readFileSync(join(mp, 'pm', 'installed.json'), 'utf8')) as { mp: string; files: Record<string, string> };
    assert.equal(installed.mp, '4.1.1');
    assert.ok(Object.keys(installed.files).includes('roles/constructor.md'));
    const cfg = JSON.parse(readFileSync(join(mp, 'config.json'), 'utf8'));
    assert.equal(cfg.format, 'mp41.config.v1');
    assert.equal(cfg.targetBranch, 'main');
    assert.deepEqual(cfg.environment.versionCommands, ['node --version'], 'a package.json declares node');
    assert.deepEqual(cfg.closingChecks, []);
    assert.equal((await cli(p.dir, ['config'])).code, 0);
    assert.match(readFileSync(join(p.dir, '.git', 'info', 'exclude'), 'utf8'), /\.mission-pipeline\//);
    const claude = readFileSync(join(p.dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# Project notes\n\nUse tabs.\n'), 'the file keeps its own content');
    assert.equal(claude.split(POINTER_LINE).length - 1, 1);
    assert.doesNotMatch(claude, /mp pm|dispatch|WI-/, 'the pointer carries no pipeline rules');
    assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.mission-pipeline'], { cwd: p.dir, encoding: 'utf8' }), '', 'the memory is not committed by default');
  });

  it('is idempotent: a second init keeps the memory, the copies and the config; the pointer is added once per file', async () => {
    writeFileSync(join(mp, 'config.json'), readFileSync(join(mp, 'config.json'), 'utf8').replace('"targetBranch": "main"', '"targetBranch": "trunk"'));
    const r = await cli(p.dir, ['init', '--pointer', 'both', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.result.memory.created, false);
    assert.equal(r.json.result.docs.copied.length, 0);
    assert.equal(r.json.result.config, 'present');
    assert.match(readFileSync(join(mp, 'config.json'), 'utf8'), /"trunk"/);
    assert.equal(readFileSync(join(p.dir, 'CLAUDE.md'), 'utf8').split(POINTER_LINE).length - 1, 1);
    assert.equal(readFileSync(join(p.dir, 'AGENTS.md'), 'utf8'), `${POINTER_LINE}\n`);
  });

  it('mp docs update refreshes changed copies and removes pages the installed version retired', async () => {
    writeFileSync(join(mp, 'roles', 'reviewer.md'), '# edited\n');
    rmSync(join(mp, 'pm', 'wi', 'WI-28.md'));
    write(mp, 'pm/wi/WI-15.md', '# WI-15 a retired page\n');
    const r = await cli(p.dir, ['docs', 'update', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.result.updated, ['roles/reviewer.md']);
    assert.deepEqual(r.json.result.copied, ['pm/wi/WI-28.md']);
    assert.deepEqual(r.json.result.removed, ['pm/wi/WI-15.md']);
    assert.doesNotMatch(readFileSync(join(mp, 'roles', 'reviewer.md'), 'utf8'), /^# edited/);
  });
});

describe('mp init in a linked worktree: warns (WI-31), still initializes, changes nothing in the repository', () => {
  const p = gitProject();
  after(() => p.cleanup());

  it('names the common git directory outside the folder', async () => {
    const wt = join(p.base, 'linked');
    p.git('worktree', 'add', '-q', '-b', 'side', wt);
    const r = await cli(wt, ['init', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.json.result.memory.layout.warnings.length > 0);
    assert.match(r.json.result.memory.layout.warnings[0], /outside the project folder/);
    assert.equal(r.json.result.targetBranch, 'side', 'the target branch defaults to the checked-out one');
    const text = await cli(wt, ['init']);
    assert.match(text.out, /WI-31/);
    assert.ok(existsSync(join(wt, '.mission-pipeline', 'memory.db')));
  });
});
