// Design 7.1/7.2 environment, W3 (e2e run with real units, release reviews r1 and r2): the user's
// toolchain outside the system directories (here node at ~/.local/node-v22...; nvm, pyenv, a venv)
// is detected at install as a recognized distribution tree only, and FROZEN: a read-only copy
// the program owns (exec/toolfreeze.ts) is mounted at the tool's original path; the live tree is
// never mounted. Checked: detection on fake layouts (never ~/.local, ~/.claude, the home, a tree
// holding credentials); the copy (only what the tool needs; npmrc tokens, .ssh and the like never
// copied; links leaving the tree dropped; read-only; a manifest marker); later changes to the live
// tree reach nothing; the marker checked before every mount; and, on this machine's real
// toolchain, `node --version` and `npm --version` in a tool sandbox and in a verification unit.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { RUN_HOST_JOB_FORMAT, RUN_HOST_MAIN, type RunHostJob } from '../src/exec/run-host.ts';
import { ToolSandbox, checkToolchainEntries, detectToolchain, hostSystemEnvironment, toolchainRootProblem, type SandboxRunResult } from '../src/exec/sandbox.ts';
import { freezeToolchain, freezeTree, readFrozenManifest, removeFrozen, type FrozenTree } from '../src/exec/toolfreeze.ts';
import { killUnit, launchUnitSupervisor, waitUnitInactive } from '../src/exec/supervisor.ts';
import { DEFAULT_TOOL_POLICY, ProgramTools } from '../src/exec/tools.ts';

const MiB = 1024 * 1024;
const caps = detectExecCapabilities();
const canSandbox = caps.bwrapUsable && caps.nsenter !== null;
const canUnit = canSandbox && caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');
const real = detectToolchain();
const hasOwnNode = real.dirs.length > 0 && real.found['node'] !== undefined;
/** This machine's toolchain, frozen once for the tests that run it (set in the first one that needs it). */
let frozenReal: { readonly trees: readonly FrozenTree[] } | null = null;
function frozenToolchain(): { readonly trees: readonly FrozenTree[] } {
  if (frozenReal === null) {
    const d = mkdtempSync(join(tmpdir(), 'mp-exec-toolchain-env-'));
    dirs.push(d);
    const r = freezeToolchain(real, d);
    assert.deepEqual(r.skipped, []);
    frozenReal = { trees: r.trees };
  }
  return frozenReal;
}
const skipSandbox = !canSandbox ? 'needs bubblewrap and nsenter' : !hasOwnNode ? 'node is in the system directories here: nothing outside them to bind' : false;
const skipUnit = !canUnit ? 'needs systemd-run --user with delegated memory and pids, bubblewrap and nsenter' : skipSandbox;

const dirs: string[] = [];
const units: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const u of units) await killUnit(u);
  for (const d of dirs) removeFrozen(d); // frozen copies are read-only
});

describe('the user toolchain in the sandboxes (W3)', () => {
  const exe = (p: string, body = '#!/bin/sh\necho fake\n'): void => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  const fakeHome = (): { root: string; home: string } => {
    const root = realpathSync(tmp('mp-exec-toolchain-'));
    const home = join(root, 'home', 'u');
    mkdirSync(home, { recursive: true });
    return { root, home };
  };
  /** The official tarball layout: bin/node, bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js, include/node. */
  const nodeTarball = (dir: string): void => {
    exe(join(dir, 'bin', 'node'));
    exe(join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(dir, 'bin', 'npm'));
    mkdirSync(join(dir, 'include', 'node'), { recursive: true });
  };

  test('a tarball-layout node under ~/.local/node-vX is bound (links resolved, npm folded into it); system tools need no bind', () => {
    const { home } = fakeHome();
    const nodeRoot = join(home, '.local', 'node-v9.9.9-linux-x64');
    nodeTarball(nodeRoot);
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(join(nodeRoot, 'bin', 'node'), join(home, '.local', 'bin', 'node'));
    symlinkSync(join(nodeRoot, 'bin', 'npm'), join(home, '.local', 'bin', 'npm'));
    mkdirSync(join(home, '.local', 'share', 'keyrings'), { recursive: true });
    const env = { PATH: [join(home, '.local', 'bin'), '/usr/bin', '/bin'].join(':'), HOME: home };
    const t = detectToolchain({ env, home, tools: ['node', 'npm', 'sh'] });
    assert.deepEqual(t.dirs, [nodeRoot], 'only the node tree: never ~/.local itself');
    assert.deepEqual(t.path, [join(nodeRoot, 'bin')]);
    assert.equal(t.found['node'], join(nodeRoot, 'bin', 'node'));
    assert.equal(t.found['npm'], join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    assert.deepEqual(t.skipped, []);
    assert.equal(t.found['sh'], undefined, 'system tools are bound already');
    // nothing live is ever bound: the environment mounts frozen copies only
    assert.deepEqual(hostSystemEnvironment().path, undefined);
    assert.ok(!hostSystemEnvironment().entries.some((x) => x.kind === 'bind' && x.src.startsWith(home)));
  });

  test('release review layout 1: a plain ~/.local/bin/node selects nothing (never all of ~/.local, keyrings included)', () => {
    const { home } = fakeHome();
    exe(join(home, '.local', 'bin', 'node'));
    // even with an npm beside it (a user-level npm prefix), ~/.local is a direct child of the home
    mkdirSync(join(home, '.local', 'lib', 'node_modules', 'npm'), { recursive: true });
    mkdirSync(join(home, '.local', 'share', 'keyrings'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'keyrings', 'login.keyring'), 'secret');
    const t = detectToolchain({ env: { PATH: join(home, '.local', 'bin'), HOME: home }, home, tools: ['node'] });
    assert.deepEqual(t.dirs, []);
    assert.equal(t.skipped.length, 1);
    assert.match(t.skipped[0]!.reason, /direct child of the home directory/);
  });

  test('release review layout 2: a python3 that resolves into ~/.claude selects nothing (the login stays out)', () => {
    const { home } = fakeHome();
    const claude = join(home, '.claude');
    exe(join(claude, 'bin', 'python3'));
    mkdirSync(join(claude, 'lib', 'python3.12'), { recursive: true });
    writeFileSync(join(claude, '.credentials.json'), '{"claudeAiOauth":{}}');
    exe(join(home, 'tools', 'nested', 'bin', 'unused'));
    mkdirSync(join(home, 'bin'), { recursive: true });
    symlinkSync(join(claude, 'bin', 'python3'), join(home, 'bin', 'python3'));
    const t = detectToolchain({ env: { PATH: join(home, 'bin'), HOME: home }, home, tools: ['python3'] });
    assert.deepEqual(t.dirs, []);
    assert.equal(t.skipped.length, 1);
    assert.match(t.skipped[0]!.reason, /direct child of the home directory|credentials/);
    // a deeper tree that directly holds a credential is refused too (shallow check)
    const deep = join(home, 'opt', 'py');
    exe(join(deep, 'bin', 'python3'));
    mkdirSync(join(deep, 'lib', 'python3.12'), { recursive: true });
    writeFileSync(join(deep, 'aws-credentials'), 'x');
    const t2 = detectToolchain({ env: { PATH: join(deep, 'bin'), HOME: home }, home, tools: ['python3'] });
    assert.deepEqual(t2.dirs, []);
    assert.match(t2.skipped[0]?.reason ?? '', /directly holds aws-credentials/);
    rmSync(join(deep, 'aws-credentials'));
    assert.deepEqual(detectToolchain({ env: { PATH: join(deep, 'bin'), HOME: home }, home, tools: ['python3'] }).dirs, [deep], 'the same tree without it is accepted');
    // and a git outside the system directories is never bound
    exe(join(home, 'opt', 'git', 'bin', 'git'));
    const t3 = detectToolchain({ env: { PATH: join(home, 'opt', 'git', 'bin'), HOME: home }, home, tools: ['git'] });
    assert.deepEqual([t3.dirs, t3.skipped[0]?.tool], [[], 'git']);
    assert.equal(toolchainRootProblem(home, [home]), 'it is the home directory or holds it');
  });

  test('the frozen copy: what node needs only; npmrc tokens, keys and links leaving the tree never copied; read-only; a manifest', () => {
    const { root, home } = fakeHome();
    const nodeRoot = join(home, 'sdk', 'node-v9');
    nodeTarball(nodeRoot);
    // the reviewer's token, and other secrets at any depth
    mkdirSync(join(nodeRoot, 'etc'), { recursive: true });
    writeFileSync(join(nodeRoot, 'etc', 'npmrc'), '//registry.npmjs.org/:_authToken=npm_FAKE_TOKEN\n');
    writeFileSync(join(nodeRoot, 'lib', 'node_modules', 'npm', '.npmrc'), '//r/:_authToken=npm_FAKE_TOKEN2\n');
    mkdirSync(join(nodeRoot, 'lib', 'node_modules', 'npm', '.ssh'));
    writeFileSync(join(nodeRoot, 'lib', 'node_modules', 'npm', '.ssh', 'id_ed25519'), 'KEY');
    writeFileSync(join(nodeRoot, 'include', 'node', 'my-credentials.txt'), 'x');
    // another global package and its bin link: left out; links leaving the tree: dropped
    exe(join(nodeRoot, 'lib', 'node_modules', 'typescript', 'bin', 'tsc'));
    symlinkSync('../lib/node_modules/typescript/bin/tsc', join(nodeRoot, 'bin', 'tsc'));
    symlinkSync(join(home, '.ssh', 'id_ed25519'), join(nodeRoot, 'bin', 'escape'));
    symlinkSync('/etc/passwd', join(nodeRoot, 'lib', 'node_modules', 'npm', 'passwd'));
    symlinkSync('/usr/bin/env', join(nodeRoot, 'bin', 'sysenv'));
    exe(join(nodeRoot, 'share', 'doc', 'readme'));
    const envRoot = join(root, 'environments');
    const f = freezeTree(nodeRoot, envRoot);
    assert.ok(!('skipped' in f), JSON.stringify(f));
    const frozen = f as FrozenTree;
    assert.equal(frozen.tool, 'node');
    assert.equal(frozen.source, nodeRoot);
    assert.match(frozen.copy, new RegExp(`^${envRoot}/node-[0-9a-f]{16}/tree$`));
    const all: string[] = [];
    const walk = (d: string, rel: string): void => {
      for (const n of readdirSync(d)) {
        const r = rel === '' ? n : `${rel}/${n}`;
        all.push(r);
        if (lstatSync(join(d, n)).isDirectory()) walk(join(d, n), r);
      }
    };
    walk(frozen.copy, '');
    assert.deepEqual(readdirSync(frozen.copy).sort(), ['bin', 'include', 'lib'], 'no etc/, no share/');
    for (const bad of ['etc', 'lib/node_modules/npm/.npmrc', 'lib/node_modules/npm/.ssh', 'include/node/my-credentials.txt', 'lib/node_modules/typescript', 'bin/tsc', 'bin/escape', 'lib/node_modules/npm/passwd']) {
      assert.ok(!all.includes(bad), `${bad} is not in the copy`);
    }
    for (const x of all) {
      const pth = join(frozen.copy, x);
      if (lstatSync(pth).isFile()) assert.ok(!readFileSync(pth, 'utf8').includes('FAKE_TOKEN'), `${x} holds no token`);
    }
    assert.ok(all.includes('bin/npm') && all.includes('bin/node') && all.includes('lib/node_modules/npm/bin/npm-cli.js'));
    assert.equal(realpathSync(join(frozen.copy, 'bin', 'npm')), join(frozen.copy, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'a link inside the tree stays inside the copy');
    assert.ok(all.includes('bin/sysenv'), 'a link into the system directories (bound anyway) stays');
    assert.ok(frozen.leftOut.includes('bin/escape') && frozen.leftOut.includes('lib/node_modules/npm/.npmrc'));
    // files read-only (the sandboxes mount the whole copy read-only), and the marker
    for (const x of all) if (lstatSync(join(frozen.copy, x)).isFile()) assert.equal(statSync(join(frozen.copy, x)).mode & 0o222, 0, `${x} is read-only`);
    assert.equal(statSync(frozen.copy).mode & 0o022, 0, 'no group or other write on directories');
    assert.equal(statSync(join(frozen.copy, 'bin', 'node')).mode & 0o111, 0o111, 'executables stay executable');
    assert.equal(readFrozenManifest(frozen.copy)?.manifest, frozen.manifest);
    // the same content frozen again: the same copy
    const again = freezeTree(nodeRoot, envRoot) as FrozenTree;
    assert.equal(again.copy, frozen.copy);
    // over the size cap: not frozen, with the reason
    const capped = freezeTree(nodeRoot, join(root, 'env2'), { maxBytes: 10 });
    assert.ok('skipped' in capped && /over 10 bytes/.test(capped.skipped));
  });

  test('a venv freezes too: its link to the system interpreter kept, pip.conf and .pypirc left out', () => {
    const { root, home } = fakeHome();
    const venv = join(home, 'venvs', 'tools');
    mkdirSync(join(venv, 'bin'), { recursive: true });
    symlinkSync('/usr/bin/python3', join(venv, 'bin', 'python3'));
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages', 'pkg'), { recursive: true });
    writeFileSync(join(venv, 'lib', 'python3.12', 'site-packages', 'pkg', '__init__.py'), 'X = 1\n');
    writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
    writeFileSync(join(venv, 'pip.conf'), '[global]\nindex-url = https://user:pw@example.invalid/simple\n');
    writeFileSync(join(venv, 'lib', 'python3.12', '.pypirc'), 'password = x\n');
    if (!existsSync('/usr/bin/python3')) return; // the venv layout needs an interpreter to link to
    const f = freezeTree(venv, join(root, 'environments'));
    assert.ok(!('skipped' in f), JSON.stringify(f));
    const copy = (f as FrozenTree).copy;
    assert.equal((f as FrozenTree).tool, 'python');
    assert.deepEqual(readdirSync(copy).sort(), ['bin', 'lib', 'pyvenv.cfg']);
    assert.ok(lstatSync(join(copy, 'bin', 'python3')).isSymbolicLink());
    assert.ok(existsSync(join(copy, 'lib', 'python3.12', 'site-packages', 'pkg', '__init__.py')));
    assert.ok(!existsSync(join(copy, 'lib', 'python3.12', '.pypirc')));
  });

  test('a key or a link swapped into the live tree after install reaches nothing; the marker is checked before every mount', () => {
    const { root, home } = fakeHome();
    const nodeRoot = join(home, 'sdk', 'node-v9');
    nodeTarball(nodeRoot);
    const { trees } = freezeToolchain({ dirs: [nodeRoot] }, join(root, 'environments'));
    const t = trees[0] as FrozenTree;
    const entry = (copy: string, manifest = t.manifest, dest = nodeRoot) => ({ entries: [{ kind: 'bind' as const, src: copy, dest, frozen: { manifest } }, { kind: 'bind' as const, src: '/usr', dest: '/usr' }], frozen: false, path: [join(dest, 'bin')] });
    // the live tree changes after install: a key appears, a directory becomes a link to a fake .claude
    mkdirSync(join(nodeRoot, '.ssh'));
    writeFileSync(join(nodeRoot, '.ssh', 'id_ed25519'), 'KEY');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    rmSync(join(nodeRoot, 'include'), { recursive: true });
    symlinkSync(join(home, '.claude'), join(nodeRoot, 'include'));
    // the mount source is the copy: unchanged, and still accepted
    assert.deepEqual(checkToolchainEntries(entry(t.copy)).skipped, []);
    assert.ok(!existsSync(join(t.copy, '.ssh')) && lstatSync(join(t.copy, 'include')).isDirectory() && !existsSync(join(t.copy, 'include', '.credentials.json')));
    // the copy itself tampered with: left out (with its PATH entry)
    const fake = join(root, 'fake-copy');
    symlinkSync(t.copy, fake);
    const c1 = checkToolchainEntries(entry(fake));
    assert.match(c1.skipped[0]?.reason ?? '', /not a real directory/);
    assert.deepEqual(c1.environment.entries.map((e) => (e.kind === 'bind' ? e.src : e.dest)), ['/usr']);
    assert.equal(c1.environment.path, undefined);
    assert.match(checkToolchainEntries(entry(t.copy, 'f'.repeat(64))).skipped[0]?.reason ?? '', /carries manifest/);
    assert.match(checkToolchainEntries(entry(t.copy, t.manifest, '/opt/elsewhere')).skipped[0]?.reason ?? '', /is of .*, not \/opt\/elsewhere/);
    const bare = join(root, 'no-marker', 'tree');
    mkdirSync(bare, { recursive: true });
    assert.match(checkToolchainEntries(entry(bare)).skipped[0]?.reason ?? '', /no manifest marker/);
  });

  test('this machine: node and npm run in a tool sandbox; the home shows only the path to the toolchain', { skip: skipSandbox }, async () => {
    const root = tmp('mp-exec-toolchain-sbx-');
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'src'), { recursive: true });
    writeFileSync(join(snap, 'src', 'a.js'), 'console.log("ran " + (1 + 1));\n');
    const session = join(root, 'session');
    mkdirSync(session);
    const frozen = frozenToolchain();
    const env = hostSystemEnvironment(frozen);
    assert.deepEqual(env.path, real.path);
    // the mount source is the frozen copy, never the live tree
    for (const e of env.entries) if (e.kind === 'bind') assert.ok(!real.dirs.includes(e.src), `${e.src} is not a live tree`);
    assert.deepEqual(env.entries.filter((e) => e.kind === 'bind' && e.frozen !== undefined).map((e) => (e.kind === 'bind' ? [e.src, e.dest] : [])), frozen.trees.map((t) => [t.copy, t.source]));
    const sandbox = await ToolSandbox.create({ snapshotDir: snap, writablePaths: ['src'], area: { kind: 'tmpfs', bytes: 64 * MiB }, environment: env, sessionDir: session }, { runLayers: null });
    try {
      const tools = new ProgramTools(sandbox, DEFAULT_TOOL_POLICY);
      const home = homedir();
      const r = await tools.runCommand({ command: `node --version && npm --version && node src/a.js && echo "PATH=$PATH" && ls -A ${home} && echo --- && ls -A ${home}/.local && echo --- && ls -A ${real.dirs[0]}` });
      assert.ok(r.ok, JSON.stringify(r));
      const out = r.value.stdout.text;
      assert.equal(r.value.status, 'completed', `${out}\n${r.value.stderr.text}`);
      assert.match(out, new RegExp(`^${process.version.replace(/\./g, '\\.')}\n\\d+\\.\\d+\\.\\d+\nran 2\n`));
      assert.ok(out.includes(`PATH=${real.path.join(':')}:`), out);
      // nothing of the home but the components on the way to the toolchain
      const first = real.dirs[0] as string;
      if (first.startsWith(`${home}/`)) {
        const listing = out.slice(out.indexOf(`PATH=`)).split('\n').slice(1).join('\n');
        const [inHome, inLocal, inTree] = listing.split('---\n');
        assert.deepEqual(inTree?.trim().split('\n'), ['bin', 'include', 'lib'], 'the frozen copy: no share/, no README, no etc/');
        const rel = first.slice(home.length + 1).split('/');
        assert.deepEqual(inHome?.trim().split('\n'), [rel[0]], `the home lists only ${rel[0]}`);
        if (rel.length > 1 && rel[0] === '.local') assert.deepEqual(inLocal?.trim().split('\n'), [rel[1]]);
      }
      // without the toolchain the same sandbox setup has no node (control)
      const bare = await ToolSandbox.create(
        { snapshotDir: snap, writablePaths: ['src'], area: { kind: 'tmpfs', bytes: 64 * MiB }, environment: hostSystemEnvironment(), sessionDir: mkdtempSync(join(root, 's2-')) },
        { runLayers: null },
      );
      try {
        const r2 = await new ProgramTools(bare, DEFAULT_TOOL_POLICY).runCommand({ command: 'command -v node || echo no-node' });
        assert.ok(r2.ok);
        if (!existsSync('/usr/bin/node') && !existsSync('/usr/local/bin/node')) assert.equal(r2.value.stdout.text.trim(), 'no-node');
      } finally {
        await bare.close();
      }
      // the re-check runs at every mount: a recorded entry that is not what install accepted is left out and reported
      const skipped: string[] = [];
      const t0 = frozen.trees[0] as FrozenTree;
      const odd = { ...env, entries: [...env.entries, { kind: 'bind' as const, src: t0.copy, dest: '/opt/not-its-own-path', frozen: { manifest: t0.manifest } }] };
      const s3 = await ToolSandbox.create(
        { snapshotDir: snap, writablePaths: ['src'], area: { kind: 'tmpfs', bytes: 64 * MiB }, environment: odd, sessionDir: mkdtempSync(join(root, 's3-')) },
        { runLayers: null, onToolchainSkipped: (x) => skipped.push(...x.map((y) => `${y.src}: ${y.reason}`)) },
      );
      try {
        const r3 = await new ProgramTools(s3, DEFAULT_TOOL_POLICY).runCommand({ command: 'ls /opt/not-its-own-path 2>&1 || echo absent; node --version' });
        assert.ok(r3.ok);
        assert.match(r3.value.stdout.text, /absent/);
        assert.match(r3.value.stdout.text, new RegExp(process.version.replace(/\./g, '\\.')), 'the entry recorded correctly still works');
        assert.equal(skipped.length, 1);
        assert.match(skipped[0] ?? '', new RegExp(`^${t0.copy}: the frozen copy is of ${t0.source}, not /opt/not-its-own-path$`));
      } finally {
        await s3.close();
      }
    } finally {
      await sandbox.close();
    }
  });
});

describe('a verification unit sees the toolchain (W3)', { skip: skipUnit }, () => {
  let sinkModule = '';
  before(() => {
    const d = tmp('mp-exec-toolchain-sink-');
    sinkModule = join(d, 'sink.mjs');
    writeFileSync(sinkModule, `import { writeFileSync } from 'node:fs';\nexport function createProofSink(o) { return { async submit(proof) { writeFileSync(o.ledgerPath, JSON.stringify(proof)); return { kind: 'registered', ack: 'ack', duplicate: false }; } }; }\n`);
  });

  test('`node --version` and `npm --version` from a toolchain outside /usr succeed in a run-host unit started with a minimal PATH', async () => {
    const t = tmp('mp-exec-toolchain-unit-');
    const snap = join(t, 'snap');
    mkdirSync(join(snap, 'out'), { recursive: true });
    writeFileSync(join(snap, 'package.json'), '{"name":"t","version":"1.0.0","scripts":{"test":"node -e \\"console.log(42)\\""}}\n');
    const session = join(t, 'session');
    mkdirSync(session);
    const launch = id<LaunchId>(`launch-toolchain-${process.pid}`);
    const job: RunHostJob = {
      format: RUN_HOST_JOB_FORMAT,
      launch,
      sandbox: { snapshotDir: snap, writablePaths: ['.'], area: { kind: 'tmpfs', bytes: 64 * MiB }, environment: hostSystemEnvironment(frozenToolchain()), sessionDir: session },
      runs: [
        { run: 'v1-node', command: 'node --version', limits: { memoryMax: 512 * MiB, pidsMax: 128 } },
        { run: 'v2-npm', command: 'npm test --silent', limits: { memoryMax: 512 * MiB, pidsMax: 128 } },
      ],
      recordsPath: join(t, 'records.jsonl'),
      resultsPath: join(t, 'results.json'),
    };
    writeFileSync(join(t, 'job.json'), JSON.stringify(job));
    const unitName = `mp-exec-test-toolchain-${process.pid}.service`;
    units.push(unitName);
    await launchUnitSupervisor({
      config: {
        launch,
        stateDir: t,
        host: {
          argv: [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', RUN_HOST_MAIN, join(t, 'job.json')],
          env: { PATH: '/usr/bin:/bin', HOME: t },
          cwd: t,
          stdoutPath: join(t, 'host.out'),
          stderrPath: join(t, 'host.err'),
        },
        unit: { memoryMax: 1024 * MiB, pidsMax: 256 },
        sink: { module: sinkModule, options: { ledgerPath: join(t, 'ledger.json') } },
        retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 },
      },
      unitName,
      logPath: join(t, 'supervisor.log'),
    });
    assert.ok(await waitUnitInactive(unitName, 120_000), 'unit still active');
    const diag = (): string => ['supervisor.log', 'host.err'].filter((f) => existsSync(join(t, f))).map((f) => `--- ${f}\n${readFileSync(join(t, f), 'utf8')}`).join('\n');
    assert.ok(existsSync(job.resultsPath), diag());
    const [node, npm] = JSON.parse(readFileSync(job.resultsPath, 'utf8')) as SandboxRunResult[];
    assert.deepEqual([node?.status, node?.exit, node?.stdout.text], ['completed', { code: 0, signal: null }, `${process.version}\n`], JSON.stringify(node));
    assert.deepEqual([npm?.status, npm?.exit.code], ['completed', 0], `${npm?.stdout.text}\n${npm?.stderr.text}`);
    assert.match(npm?.stdout.text ?? '', /42/);
  });
});
