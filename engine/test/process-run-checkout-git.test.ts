// A run checkout is a git repository at its candidate (design 4.1 §5.3, Appendix G). A run's
// checkout lies inside the project's work tree, under `.mission-pipeline/`, which `mp init`
// excludes; a checkout with no repository of its own made every git question of a declared command
// an answer about the enclosing project: no tracked file, the whole checkout ignored, the
// enclosing branch's history. These tests run a probe as a declared command that records what git
// answers in its working directory (into a file outside the project), and check:
//   - a verification run (at the checkout root and in a subdirectory): HEAD is the candidate,
//     detached; the tracked files are the candidate's; `git status` is empty and `git diff-index
//     --quiet HEAD` finds the tree clean; the history is the
//     candidate's ancestry; `git diff <base>..HEAD` and `git diff <base>` are the candidate's
//     change; the checkout's own .gitignore decides what is ignored; variables that would point git
//     elsewhere (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE) do not reach the command;
//   - the project's repository gains no ref, worktree, configuration entry or object, and the
//     checkout, its .git included, is gone afterwards;
//   - a Constructor's verification, a Reviewer's `mp seat <id> rerun` and a delivery's closing
//     checks see their own candidates the same way.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import { pmDeliver, pmDispatch, pmNext, pmSay, seatRerun } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { addDetailedPlan, addMissionToReview, handBack, processProject, readyOf, reviewerPass, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;

let p: ProcessProject | null = null;

afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

const PROBE = `const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [outDir, base, rel] = process.argv.slice(2);
const root = fs.realpathSync(rel === '.' ? process.cwd() : path.resolve(process.cwd(), ...rel.split('/').map(() => '..')));
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return 'FAILED: ' + String(e.stderr || e.message).trim();
  }
};
const real = (s) => {
  try {
    return fs.realpathSync(s);
  } catch {
    return s;
  }
};
const z = (s) => (s.startsWith('FAILED') ? [s] : s.split('\\0').filter((x) => x !== ''));
const out = {
  cwd: process.cwd(),
  root,
  env: ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_SHALLOW_FILE'].filter((k) => process.env[k] !== undefined),
  toplevel: real(git('rev-parse', '--show-toplevel').trim()),
  prefix: git('rev-parse', '--show-prefix').trim(),
  head: git('rev-parse', 'HEAD').trim(),
  branch: git('branch', '--show-current').trim(),
  tracked: z(git('ls-files', '-z', '--full-name', '--', ':/')),
  status: git('status', '--porcelain', '--untracked-files=all'),
  // plumbing that reads the index's stat data without refreshing them ("is the tree clean?")
  quiet: git('diff-index', '--quiet', 'HEAD', '--'),
  files: git('diff-files', '--name-only'),
  log: git('log', '--format=%H').trim().split('\\n'),
  committed: git('diff', '--stat', base + '..HEAD'),
  changed: git('diff', '--name-status', base, '--', ':/'),
};
// new files: the checkout's own .gitignore decides (*.local, build/)
fs.writeFileSync(path.join(root, 'probe.local'), 'ignored\\n');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'out.txt'), 'ignored\\n');
fs.writeFileSync(path.join(root, 'fresh.txt'), 'not ignored\\n');
out.others = z(git('ls-files', '-z', '--full-name', '--others', '--exclude-standard', '--', ':/'));
out.ignored = git('check-ignore', '--', ...['probe.local', 'build/out.txt', 'fresh.txt'].map((f) => path.relative(process.cwd(), path.join(root, f)))).trim().split('\\n').filter((x) => x !== '');
for (const f of ['probe.local', 'fresh.txt']) fs.rmSync(path.join(root, f));
fs.rmSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, String(fs.readdirSync(outDir).length + 1).padStart(3, '0') + '.json'), JSON.stringify(out));
console.log('ok 1 - probed');
`;

interface ProbeAnswer {
  cwd: string;
  root: string;
  env: string[];
  toplevel: string;
  prefix: string;
  head: string;
  branch: string;
  tracked: string[];
  status: string;
  quiet: string;
  files: string;
  log: string[];
  committed: string;
  changed: string;
  others: string[];
  ignored: string[];
}

/** The probe as a declared command: its answers go to `<base>/probe-out/`, outside the project. */
function probe(q: ProcessProject, base: string, rel = '.'): { readonly command: string; readonly answers: () => ProbeAnswer[] } {
  const where = dirname(q.dir);
  const script = join(where, 'probe.cjs');
  const outDir = join(where, 'probe-out');
  writeFileSync(script, PROBE);
  return {
    command: `node ${JSON.stringify(script)} ${JSON.stringify(outDir)} ${base} ${rel}`,
    answers: () => (existsSync(outDir) ? readdirSync(outDir).sort().map((f) => JSON.parse(readFileSync(join(outDir, f), 'utf8')) as ProbeAnswer) : []),
  };
}

/** What the project's repository holds that a checkout must not change. */
function repositoryState(q: ProcessProject) {
  const gitDir = join(q.dir, '.git');
  return {
    refs: q.git('for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: q.git('worktree', 'list', '--porcelain'),
    config: q.git('config', '--local', '--list'),
    admin: existsSync(join(gitDir, 'worktrees')) ? readdirSync(join(gitDir, 'worktrees')) : [],
    objects: q.git('count-objects', '-v'),
    head: q.git('rev-parse', 'HEAD'),
    status: q.git('status', '--porcelain', '--untracked-files=all'),
  };
}

/** A commit on `parent` with `files` (null: deleted), written with a temporary index; no ref names it. */
function commitOn(q: ProcessProject, parent: string, files: Record<string, string | null>, message: string): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(dirname(q.dir), 'probe-index'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (args: string[], input?: string) => execFileSync('git', args, { cwd: q.dir, env, encoding: 'utf8', ...(input !== undefined ? { input } : {}) }).trim();
  run(['read-tree', parent]);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) run(['update-index', '--force-remove', '--', path]);
    else run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${path}`]);
  }
  return run(['commit-tree', run(['write-tree']), '-p', parent, '-m', message]);
}

function treeFiles(q: ProcessProject, commit: string): string[] {
  return q.git('ls-tree', '-r', '-z', '--name-only', commit).split('\0').filter((x) => x !== '');
}

/** Every answer about the candidate as git gives it in a repository positioned at `commit`. */
function assertSeesCandidate(q: ProcessProject, a: ProbeAnswer, commit: string, base: string, rel = '.'): void {
  assert.equal(a.toplevel, a.root, 'the checkout is the top of its own repository');
  assert.equal(a.prefix, rel === '.' ? '' : `${rel}/`);
  assert.ok(a.root.includes(join('.mission-pipeline', 'tmp')), a.root);
  assert.equal(a.head, commit, 'HEAD is the candidate');
  assert.equal(a.branch, '', 'HEAD is detached');
  assert.deepEqual(a.tracked, treeFiles(q, commit), "the tracked files are the candidate's");
  assert.equal(a.status, '', 'a pristine checkout has nothing to report');
  assert.equal(a.quiet, '', '`git diff-index --quiet HEAD` finds the tree clean (the index has stat data)');
  assert.equal(a.files, '');
  assert.deepEqual(a.log, q.git('rev-list', commit).split('\n'), "the history is the candidate's ancestry");
  assert.equal(a.committed.trim(), q.git('diff', '--stat', `${base}..${commit}`), "the change against the base is the candidate's");
  assert.equal(a.changed.trim(), q.git('diff', '--name-status', base, commit), 'the files against the base are the candidate’s change');
  assert.deepEqual(a.others, ['fresh.txt'], "a new file is untracked; the checkout's own .gitignore ignores the others");
  assert.deepEqual(a.ignored.map((x) => x.replace(/\\/g, '/').replace(/^(\.\.\/)+/, '')).sort(), ['build/out.txt', 'probe.local']);
  assert.deepEqual(a.env, [], 'no variable that points git elsewhere reaches the command');
}

describe('a run checkout is a git repository at its candidate', () => {
  it('a declared verification command asks git about the candidate, at the root and in a subdirectory; the project repository is unchanged; the checkout goes', async () => {
    p = processProject({ files: { 'src/lib.js': 'exports.v = 1;\n', 'docs/guide.md': '# guide\n' } });
    write(p.dir, '.gitignore', '*.local\nbuild/\n');
    write(p.dir, 'src/util.js', 'exports.u = 1;\n');
    p.git('add', '-A');
    p.git('commit', '-q', '-m', 'second');
    const base = p.git('rev-parse', 'HEAD');
    // the candidate: one commit on the base that no ref names
    const candidate = commitOn(p, base, { 'src/feature.js': 'exports.f = 1;\n', 'src/lib.js': 'exports.v = 2;\n', 'docs/guide.md': null }, 'the candidate');
    // the enclosing branch moves on: its history and files are not the candidate's
    write(p.dir, 'later.txt', 'on main only\n');
    p.git('add', '-A');
    p.git('commit', '-q', '-m', 'later on main');
    const atRoot = probe(p, base);
    const inSrc = probe(p, base, 'src');
    const before = repositoryState(p);
    const saved = { GIT_DIR: process.env['GIT_DIR'], GIT_INDEX_FILE: process.env['GIT_INDEX_FILE'], GIT_WORK_TREE: process.env['GIT_WORK_TREE'], GIT_SHALLOW_FILE: process.env['GIT_SHALLOW_FILE'] };
    let runs;
    try {
      // inherited variables that would point git at the project (a hook, a harness) never reach the commands
      process.env['GIT_DIR'] = join(p.dir, '.git');
      process.env['GIT_INDEX_FILE'] = join(p.dir, '.git', 'index');
      process.env['GIT_WORK_TREE'] = p.dir;
      process.env['GIT_SHALLOW_FILE'] = join(p.dir, '.git', 'inherited-shallow');
      writeFileSync(process.env['GIT_SHALLOW_FILE'], `${base}\n`);
      runs = await p.ctx.actions().verify({
        mission: M,
        object: 'prod.git-probe',
        snapshot: candidate,
        commands: [
          { id: 'probe', command: atRoot.command },
          { id: 'probe-src', command: inSrc.command, cwd: 'src' },
        ],
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    assert.ok(runs !== 'pending' && runs.length === 2 && runs.every((r) => r.passed), JSON.stringify(runs));
    const answers = atRoot.answers();
    assert.equal(answers.length, 2, 'both commands ran');
    assertSeesCandidate(p, answers[0]!, candidate, base);
    assertSeesCandidate(p, answers[1]!, candidate, base, 'src');
    assert.equal(answers[0]!.root, answers[1]!.root, 'one checkout per run');
    assert.deepEqual(repositoryState(p), before, 'no ref, worktree, configuration entry or object in the project; its work tree untouched');
    assert.ok(!existsSync(answers[0]!.root), 'the checkout, its .git included, is removed after the run');
    assert.deepEqual(readdirSync(p.ctx.memory.paths.tmp).filter((n) => n.startsWith('run-')), []);
  });

  it("a Constructor's verification, a Reviewer's rerun and a delivery's closing checks each see their own candidate", async () => {
    p = processProject({ files: { '.gitignore': '*.local\nbuild/\n' } });
    const base = p.git('rev-parse', 'HEAD');
    const pr = probe(p, base);
    const { candidate } = await addMissionToReview(p, M, {
      detailed: addDetailedPlan(M, { verification: [{ id: 'check', command: 'node src/check.js' }, { id: 'probe', command: pr.command }] }),
    });
    const ctx = p.ctx;
    const verified = pr.answers();
    assert.equal(verified.length, 1, "the Constructor's hand-back ran the verification once");
    assertSeesCandidate(p, verified[0]!, candidate, base);

    const s = await readyOf(ctx, 'reviewer');
    const d = pmDispatch(ctx, s.step);
    const card = dispatchView(ctx, d.dispatch).card as unknown as ReviewerCard;
    const rerun = await seatRerun(ctx, d.dispatch, 'probe');
    assert.ok(rerun.passed, rerun.summary);
    const reran = pr.answers();
    assert.equal(reran.length, 2, 'the rerun executed');
    assertSeesCandidate(p, reran[1]!, candidate, base);
    assert.notEqual(reran[1]!.root, reran[0]!.root, 'in a checkout of its own');

    const a = await handBack(ctx, d.dispatch, reviewerPass(card));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    await pmNext(ctx);
    const product = `prod.con.${M}.impl.1` as ObjectVersionId;
    const w = pmSay(ctx, 'Deliver it.');
    const configBefore = p.git('config', '--local', '--list');
    const del = await pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: product }], closingChecks: [{ id: 'probe', command: pr.command }], words: w.words });
    assert.equal(del.kind, 'delivered', JSON.stringify(del));
    if (del.kind !== 'delivered') return;
    assert.equal(del.record.checks[0]?.passed, true);
    const closing = pr.answers();
    assert.equal(closing.length, 3, 'the closing check ran');
    assertSeesCandidate(p, closing[2]!, del.record.commit, base);
    assert.equal(closing[2]!.log[1], base, "the delivery candidate's parent is the target branch");
    assert.ok(!existsSync(closing[2]!.root), "the delivery's run directory is removed");
    assert.equal(p.git('config', '--local', '--list'), configBefore);
    assert.ok(!p.git('worktree', 'list', '--porcelain').includes(join('.mission-pipeline', 'tmp')), 'no checkout is a registered worktree');
    assert.deepEqual(readdirSync(join(p.dir, '.mission-pipeline', 'tmp')).filter((n) => /^(run|rerun|deliver)-/.test(n)), [], 'no run checkout is left');
  });
});
