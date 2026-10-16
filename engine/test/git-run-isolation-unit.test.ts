import test from 'node:test';
import assert from 'node:assert/strict';
import { PlainGit, withoutRepositoryLocators } from '../src/git/plainGit.ts';
import { reusableMethodRun, RUN_FIELD } from '../src/evaluator/runs.ts';
import { currentEnvironment } from '../src/evaluator/index.ts';
import { appendRecords } from '../src/memory/index.ts';
import { builders, labelProject, machine } from './labels-fixtures.ts';

test('repository/object/history locators are removed, and variable names fold only on Windows', () => {
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_QUARANTINE_PATH', 'GIT_IMPLICIT_WORK_TREE', 'GIT_ATTR_SOURCE'];
  const env = { ...Object.fromEntries(names.map((n) => [n, 'elsewhere'])), git_dir: 'ordinary-linux-name', GIT_CEILING_DIRECTORIES: '/bound', PATH: 'path' };
  const posix = withoutRepositoryLocators(env, 'linux');
  assert.deepEqual(posix, { git_dir: 'ordinary-linux-name', GIT_CEILING_DIRECTORIES: '/bound', PATH: 'path' });
  assert.deepEqual(withoutRepositoryLocators(env, 'win32'), { GIT_CEILING_DIRECTORIES: '/bound', PATH: 'path' });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    for (const platform of ['linux', 'win32'] as const) {
      const built = PlainGit.create({ platform }).buildEnv();
      for (const n of names) assert.equal(built[n], undefined, `${platform}: ${n}`);
      assert.equal(built['git_dir'], platform === 'win32' ? undefined : 'ordinary-linux-name');
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('reuse requires v2, retains old evidence, and finds v2 even if a legacy record arrived later', () => {
  const p = labelProject();
  try {
    const environment = currentEnvironment(p.m, { observe: machine('linux') }).identity;
    const b = builders(p.m);
    const fields = { candidate: 'c'.repeat(40), command: 'check', cwd: '.', status: 'completed', exit: '0' };
    const key = { candidate: fields.candidate, command: fields.command, cwd: '.', environment };
    for (const method of [undefined, 'v1', 'v2', undefined]) {
      const n = Number((p.m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence'").get() as { n: number }).n);
      p.m.write({}, (tx) => appendRecords(tx, [b.evidence(`E${n}`, environment, 'declared', { ...fields, ...(method === undefined ? {} : { [RUN_FIELD.method]: method }) })]));
      assert.equal(p.m.read((db) => reusableMethodRun(db, key))?.evidence ?? null, n < 2 ? null : 'E2');
    }
    assert.equal((p.m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence'").get() as { n: number }).n, 4);
    assert.equal((p.m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence.revoked'").get() as { n: number }).n, 0);
  } finally { p.cleanup(); }
});


test('a Constructor hand-back surfaces setup-only failures as notes without changing the recorded verification result', async () => {
  const { memoryPorts, say } = await import('./flow-memory-fixtures.ts');
  const { FlowEngine } = await import('../src/flow/engine.ts');
  const { seedMission, pmPlan, SEED_TEXT, drive, happyScript } = await import('../src/flow/scripted.ts');
  const { submitPmBatch } = await import('../src/flow/planning.ts');
  const mission = 'm1' as import('../src/common/ids.ts').MissionId;
  const ports = memoryPorts();
  const note = 'Setup-only execution of install failed (exit 1); evidence A is unchanged; later commands still ran.';
  ports.scheduler.actions = { verify: async () => [{ evidence: 'A', command: 'install', summary: 'completed; exit 0', passed: true, setupFailure: note }] };
  say(ports, SEED_TEXT);
  await seedMission(ports, mission);
  await submitPmBatch(ports, { mission, plan: pmPlan(mission), userWords: ['W-1'], mode: 'fast' });
  const script = happyScript(mission);
  await drive(new FlowEngine(ports), ports.scheduler, (task, state) => task.card.seat === 'reviewer' ? null : script(task, state));
  const answer = ports.scheduler.answers.get('con.m1.iface.1');
  assert.equal(answer?.kind, 'recorded');
  if (answer?.kind !== 'recorded') return;
  assert.ok(answer.notes.includes(note));
  assert.equal(answer.verification?.[0]?.passed, true);
});

test('scratch attribute setup also suppresses hooks, including bare init, without changing its runner', async () => {
  const { checkoutSetupGit } = await import('../src/git/checkoutRepository.ts');
  const { AttributeEvaluator } = await import('../src/git/representation.ts');
  const { readdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./memory-fixtures.ts');
  const root = tempDir('mp-attr-hooks-');
  const gitDir = join(root, '.git');
  const hooks = join(gitDir, 'mp-empty-hooks');
  const calls: string[][] = [];
  const run = async (args: readonly string[], opts: import('../src/git/plainGit.ts').GitRunOptions): Promise<import('../src/git/plainGit.ts').GitResult> => {
    assert.equal(new Map(opts.config).get('core.hooksPath'), hooks);
    assert.deepEqual(readdirSync(hooks), []);
    calls.push([...args]);
    return { argv: ['git', ...args], code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), durationMs: 0 };
  };
  const fake: import('../src/git/plainGit.ts').GitExec = { run, ok: run, text: async (args, at) => (await run(args, at)).stdout.toString(), withLocators: () => fake };
  const description = { rulesVersion: '1', objectFormat: 'sha1' as const, autocrlf: 'false' as const, eol: 'lf' as const, ignoreCase: false, symlinks: true, fileMode: true, attributes: { info: null, global: null, system: null } };
  try {
    const git = checkoutSetupGit(fake, gitDir);
    const attributes = await AttributeEvaluator.create(git, { gitDir, commonDir: gitDir, worktree: root, bare: false, objectFormat: 'sha1' }, description, root);
    assert.deepEqual(calls[0]?.slice(0, 5), ['init', '--bare', '--quiet', '--template=', '--object-format=sha1']);
    await attributes.atTree('c'.repeat(40), ['file.txt']);
    // The last config pair must win, and rebinding must keep suppression.
    const at = { cwd: root, config: [['core.hooksPath', 'project-hooks']] as const };
    await git.run(['version'], at);
    await git.ok(['version'], at);
    await git.text(['version'], at);
    await git.withLocators({ gitDir }).ok(['version'], at);
    assert.equal(fake.run, run, 'the runner used by declared commands is unchanged');
    attributes.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AttributeEvaluator shields bare init itself for callers with an ordinary git runner', async () => {
  const { AttributeEvaluator } = await import('../src/git/representation.ts');
  const { readdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./memory-fixtures.ts');
  const root = tempDir('mp-attr-own-hooks-');
  let init = false;
  const run = async (args: readonly string[], opts: import('../src/git/plainGit.ts').GitRunOptions): Promise<import('../src/git/plainGit.ts').GitResult> => {
    const hooks = new Map(opts.config).get('core.hooksPath');
    if (args[0] === 'init') {
      init = true;
      assert.equal(hooks, join(opts.cwd, 'empty-hooks'));
      assert.deepEqual(readdirSync(hooks!), []);
    } else assert.equal(hooks, undefined, 'the override is limited to init');
    return { argv: ['git', ...args], code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), durationMs: 0 };
  };
  const git: import('../src/git/plainGit.ts').GitExec = { run, ok: run, text: async () => '', withLocators: () => git };
  try {
    const attributes = await AttributeEvaluator.create(git, { gitDir: root, commonDir: root, worktree: root, bare: false, objectFormat: 'sha1' }, { rulesVersion: '1', objectFormat: 'sha1', autocrlf: 'false', eol: 'lf', ignoreCase: false, symlinks: true, fileMode: true, attributes: { info: null, global: null, system: null } }, root);
    assert.equal(init, true);
    attributes.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every setup git command has an empty portable hooks path; LFS clean remains internal and other filters are off', async () => {
  const { attachCheckoutRepository } = await import('../src/git/checkoutRepository.ts');
  const { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./memory-fixtures.ts');
  const root = tempDir('mp-setup-');
  const dir = join(root, 'checkout');
  const commonDir = join(root, 'project.git');
  mkdirSync(dir);
  const calls: string[] = [];
  const run = async (args: readonly string[], opts: import('../src/git/plainGit.ts').GitRunOptions): Promise<import('../src/git/plainGit.ts').GitResult> => {
    calls.push(args[0]!);
    const config = new Map(opts.config);
    const hooks = join(dir, '.git', 'mp-empty-hooks');
    assert.equal(config.get('core.hooksPath'), hooks);
    assert.deepEqual(readdirSync(hooks), []);
    if (args[0] === 'init') {
      assert.equal(opts.locators?.gitDir, join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'config'), '[core]\n repositoryformatversion = 0\n');
    }
    if (args[0] === 'update-index') {
      assert.match(config.get('filter.lfs.clean')!, /--lfs-clean/);
      assert.match(config.get('filter.lfs.process')!, /--lfs-filter-process/);
      assert.equal(config.get('filter.lfs.required'), 'false');
      assert.equal(config.get('filter.probe.clean'), '');
      assert.equal(config.get('filter.probe.smudge'), '');
    }
    return { argv: ['git', ...args], code: 0, signal: null, stdout: Buffer.from(args[0] === 'config' ? 'filter.lfs.clean\0filter.probe.clean\0' : ''), stderr: Buffer.alloc(0), durationMs: 0 };
  };
  const fake: import('../src/git/plainGit.ts').GitExec = { run, ok: run, text: async (args, opts) => (await run(args, opts)).stdout.toString(), withLocators: () => fake };
  try {
    await attachCheckoutRepository(fake, { gitDir: commonDir, commonDir, worktree: root, bare: false, objectFormat: 'sha1' }, { dir, commit: 'c'.repeat(40) as never, description: { rulesVersion: '1', objectFormat: 'sha1', autocrlf: 'false', eol: 'lf', ignoreCase: false, symlinks: true, fileMode: true, attributes: { info: null, global: null, system: null } } });
    assert.deepEqual(calls, ['init', 'update-ref', 'read-tree', 'config', 'update-index']);
    assert.doesNotMatch(readFileSync(join(dir, '.git', 'config'), 'utf8'), /hooksPath/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the method upgrade makes old proof need renewal, retains its judgment, and renews only equal declared fields from v2', async () => {
  const { canonicalJson, sha256 } = await import('../src/common/hash.ts');
  const { recordEnvironment, decisionLabels, recordRenewedRun, renewalCandidates } = await import('../src/evaluator/index.ts');
  for (const exit of ['0', '1']) {
    const p = labelProject();
    try {
      const parts = machine('linux')();
      const legacyIdentity = sha256(canonicalJson(parts));
      const b = builders(p.m);
      const fields = { candidate: 'c'.repeat(40), command: 'check', cwd: '.', status: 'completed', exit: '0' };
      p.m.write({}, (tx) => {
        recordEnvironment(tx, { identity: legacyIdentity as never, parts });
        appendRecords(tx, [b.product('P'), b.evidence('old', legacyIdentity, 'declared', fields), b.judge('J', 'P', { evidence: ['old'], fields: ['exit'] })]);
      });
      const current = currentEnvironment(p.m, { observe: () => parts });
      assert.notEqual(current.identity, legacyIdentity, 'upgrading the run method changes applicability');
      assert.notEqual(p.m.read((db) => decisionLabels(db, ['P']))['P'], 'proven');
      assert.equal(p.m.read((db) => renewalCandidates(db)).candidates[0]!.evidence, 'old');
      const result = p.m.write({}, (tx) => recordRenewedRun(tx, { original: 'old' as never, run: b.evidence('v2', current.identity, 'declared', { ...fields, [RUN_FIELD.method]: 'v2', exit }) as import('../src/common/records.ts').EvidenceRecord }));
      assert.equal(result.renewed.length, exit === '0' ? 1 : 0);
      assert.equal(p.m.read((db) => decisionLabels(db, ['P']))['P'] === 'proven', exit === '0');
      assert.equal((p.m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'judgment'").get() as { n: number }).n, 1, 'no program judgment replaces the seat');
      assert.equal((p.m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence.revoked'").get() as { n: number }).n, 0);
    } finally { p.cleanup(); }
  }
});
