// Design 7.1 "工具在哪里执行": the seat's bubblewrap tool sandbox. These tests run the sandbox
// without run layers (the cgroup side is covered in exec-oom and exec-supervisor), straight
// from the test process: what a command and the file tools can and cannot see or change.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { detectExecCapabilities, which } from '../src/exec/platform.ts';
import {
  SandboxError,
  ToolSandbox,
  environmentFromDirectory,
  hostSystemEnvironment,
  sandboxEnvironment,
  type SandboxSpec,
} from '../src/exec/sandbox.ts';
import { ClaudeCodeEnclosure } from '../src/exec/enclosure.ts';
import { DEFAULT_TOOL_POLICY, ProgramTools } from '../src/exec/tools.ts';

const caps = detectExecCapabilities();
const canRun = caps.bwrapUsable && caps.nsenter !== null;
const skip = canRun ? false : 'needs bubblewrap and nsenter';
const hasPython = which('python3') !== null;

const KiB = 1024;
const MiB = 1024 * KiB;
const dirs: string[] = [];
const open: ToolSandbox[] = [];

after(async () => {
  for (const s of open) await s.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly snap: string;
  readonly secret: string;
  readonly marker: string;
  readonly sandbox: ToolSandbox;
  readonly tools: ProgramTools;
}

/** snapshot: src/a.txt (writable), docs/d.md (read-only); a host secret outside the snapshot. */
async function fixture(spec: Partial<SandboxSpec> = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'mp-exec-sbx-'));
  dirs.push(root);
  const snap = join(root, 'snap');
  mkdirSync(join(snap, 'src'), { recursive: true });
  mkdirSync(join(snap, 'docs'));
  writeFileSync(join(snap, 'src', 'a.txt'), 'original a\n');
  writeFileSync(join(snap, 'docs', 'd.md'), 'read only doc\n');
  const marker = `SECRET-${process.pid}-${Date.now()}`;
  mkdirSync(join(root, 'outside'));
  const secret = join(root, 'outside', 'secret.txt');
  writeFileSync(secret, `${marker}\n`);
  const session = join(root, 'session');
  mkdirSync(session);
  const sandbox = await ToolSandbox.create(
    {
      snapshotDir: snap,
      writablePaths: ['src'],
      area: { kind: 'tmpfs', bytes: 1 * MiB },
      environment: hostSystemEnvironment(),
      sessionDir: session,
      ...spec,
    },
    { runLayers: null },
  );
  open.push(sandbox);
  return { root, snap, secret, marker, sandbox, tools: new ProgramTools(sandbox, { ...DEFAULT_TOOL_POLICY, runTimeoutMs: 20_000 }) };
}

async function sh(f: Fixture, command: string, timeoutMs?: number) {
  const r = await f.tools.runCommand({ command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

describe('tool sandbox isolation (bubblewrap)', { skip }, () => {
  test('cannot read a host file outside the snapshot: by path, by command, through a planted symlink', async () => {
    const f = await fixture();
    const byRel = await f.tools.readFile({ path: '../outside/secret.txt' });
    assert.equal(byRel.ok === false && byRel.error.code, 'outside-snapshot');
    const byAbs = await f.tools.readFile({ path: f.secret });
    assert.equal(byAbs.ok === false && byAbs.error.code, 'outside-snapshot');

    const r = await sh(f, `cat ${f.secret}; ls ${f.root}; ln -s ${f.secret} src/link; cat src/link; echo done`);
    assert.equal(r.status, 'completed');
    assert.ok(r.stdout.text.endsWith('done\n'));
    assert.equal(r.stdout.text.includes(f.marker), false);
    assert.match(r.stderr.text, /No such file or directory/);

    // the planted link dangles inside the file-tool sandbox too
    const viaLink = await f.tools.readFile({ path: 'src/link' });
    assert.equal(viaLink.ok, false);
    assert.equal(JSON.stringify(viaLink).includes(f.marker), false);

    // a link to something that does exist in the file-tool sandbox (its runtime) is refused after resolution
    await sh(f, 'ln -s /usr/bin/env src/runtime-link');
    const viaRuntime = await f.tools.readFile({ path: 'src/runtime-link' });
    assert.equal(viaRuntime.ok === false && viaRuntime.error.code, 'outside-snapshot');
  });

  test('cannot write a read-only path: the snapshot, the root, the environment; not through a symlink either', async () => {
    const f = await fixture();
    const r = await sh(f, 'echo x > docs/d.md; echo "rc=$?"; touch /newfile; echo "rc=$?"; touch /usr/x; echo "rc=$?"; touch /dev/x; echo "rc=$?"');
    assert.equal(r.stdout.text, 'rc=2\nrc=1\nrc=1\nrc=1\n');
    assert.match(r.stderr.text, /Read-only file system/);

    const w = await f.tools.writeFile({ path: 'docs/d.md', content: 'x' });
    assert.equal(w.ok === false && w.error.code, 'not-writable');
    await sh(f, 'ln -s ../docs/d.md src/to-doc');
    const viaLink = await f.tools.writeFile({ path: 'src/to-doc', content: 'x' });
    assert.equal(viaLink.ok === false && viaLink.error.code, 'symlink');
    const editLink = await f.tools.editFile({ path: 'src/to-doc', oldString: 'read', newString: 'write' });
    assert.equal(editLink.ok === false && editLink.error.code, 'symlink');
    assert.equal(readFileSync(join(f.snap, 'docs', 'd.md'), 'utf8'), 'read only doc\n');
  });

  test('no network: only loopback exists; neither the internet nor a model service on the host loopback is reachable', { skip: hasPython ? false : 'needs python3' }, async () => {
    // a stand-in for the metering proxy / model service listening on the host's loopback
    const server = createServer((sock) => sock.end('MODEL-SERVICE\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const f = await fixture();
      const r = await sh(
        f,
        `python3 -c "
import socket
print(sorted(n for _, n in socket.if_nameindex()))
for host, port in (('1.1.1.1', 53), ('127.0.0.1', ${port})):
    try:
        s = socket.create_connection((host, port), timeout=2); print('CONNECTED', host, s.recv(64))
    except OSError as e: print('blocked', host, e.errno)
"`,
      );
      assert.match(r.stdout.text, /\['lo'\]/);
      assert.match(r.stdout.text, /blocked 1\.1\.1\.1/);
      assert.match(r.stdout.text, /blocked 127\.0\.0\.1/, 'the host loopback is another network namespace');
      assert.equal(r.stdout.text.includes('CONNECTED'), false);
    } finally {
      server.close();
    }
  });

  test('a fake credentials file in $HOME and secrets in the environment are invisible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-exec-home-'));
    dirs.push(root);
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const marker = `CRED-${Date.now()}`;
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ token: marker }));
    const saved = { HOME: process.env['HOME'], TOK: process.env['MP_EXEC_TEST_SECRET_TOKEN'] };
    process.env['MP_EXEC_TEST_SECRET_TOKEN'] = marker;
    try {
      // HOME passed through by name: the path exists on the host, not in the sandbox
      process.env['HOME'] = home;
      const f = await fixture({ env: { pass: ['HOME'] } });
      const r = await sh(f, 'echo "home=$HOME"; cat "$HOME/.claude/.credentials.json"; ls -a / /home 2>&1; env; cat /proc/1/environ; echo end');
      assert.ok(r.stdout.text.startsWith(`home=${home}\n`));
      assert.ok(r.stdout.text.endsWith('end\n'));
      assert.equal(`${r.stdout.text}${r.stderr.text}`.includes(marker), false);
      assert.match(r.stderr.text, /\.credentials\.json: No such file or directory/);
      // a credential-like name is refused outright
      assert.throws(() => sandboxEnvironment({ pass: ['MP_EXEC_TEST_SECRET_TOKEN'] }), SandboxError);
      assert.throws(() => sandboxEnvironment({ pass: ['ANTHROPIC_API_KEY'] }), SandboxError);
      assert.throws(() => sandboxEnvironment({ pass: ['SSH_AUTH_SOCK'] }), SandboxError);
    } finally {
      if (saved.HOME === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved.HOME;
      delete process.env['MP_EXEC_TEST_SECRET_TOKEN'];
    }
  });

  test('compound shell commands and subprocesses cannot escape', async () => {
    const f = await fixture();
    const s = f.secret;
    const cmd = [
      'echo start',
      `cat ${s}`,
      'echo x > docs/d.md && echo WROTE',
      `(cat ${s}) | cat`,
      `echo "$(cat ${s})"`,
      `sh -c 'cat ${s}; echo y > /work/docs/d.md && echo WROTE2'`,
      `python3 -c "print(open('${s}').read())" 2>/dev/null || true`,
      `cat ${s} & wait`,
      'ls /home /root /run /mnt /sys 2>&1 | head -5',
      'unshare -U true 2>&1 || echo "no-userns"',
      'echo end',
    ].join('; ');
    const r = await sh(f, cmd);
    const all = `${r.stdout.text}${r.stderr.text}`;
    assert.ok(r.stdout.text.startsWith('start\n'));
    assert.ok(r.stdout.text.endsWith('end\n'));
    assert.equal(all.includes(f.marker), false);
    assert.equal(all.includes('WROTE'), false);
    assert.match(r.stdout.text, /no-userns/);
    assert.equal(readFileSync(join(f.snap, 'docs', 'd.md'), 'utf8'), 'read only doc\n');
  });

  test('nothing a command starts survives its call', async () => {
    const f = await fixture();
    const marker = `mp-bg-${process.pid}-${Date.now()}`;
    const r = await sh(f, `sh -c 'sleep 30; true ${marker}' >/dev/null 2>&1 & echo started`);
    assert.equal(r.stdout.text, 'started\n');
    const found = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
    assert.equal(found.stdout.trim(), '', 'the background process died with the call');
  });

  test('a snapshot containing .git is refused; the ledger and the repository are not mounted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-exec-git-'));
    dirs.push(root);
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'src', 'vendored'), { recursive: true });
    writeFileSync(join(snap, 'src', 'vendored', '.git'), 'gitdir: ../../.git/modules/x\n');
    const session = join(root, 'session');
    mkdirSync(session);
    await assert.rejects(
      ToolSandbox.create(
        { snapshotDir: snap, writablePaths: ['src'], area: { kind: 'tmpfs', bytes: MiB }, environment: hostSystemEnvironment(), sessionDir: session },
        { runLayers: null },
      ),
      /\.git/,
    );

    const f = await fixture();
    const ledger = join(f.root, 'ledger');
    mkdirSync(ledger);
    writeFileSync(join(ledger, 'main.sqlite'), f.marker);
    const r = await sh(f, `ls ${ledger}; cat ${ledger}/main.sqlite; ls -a /work; echo end`);
    assert.equal(r.stdout.text, '.\n..\ndocs\nsrc\nend\n');
    assert.equal(r.stderr.text.includes(f.marker), false);
  });

  test('writable paths: a tmpfs pre-filled with the original content, persistent across calls, invisible on the host', async () => {
    const f = await fixture();
    const r1 = await sh(f, 'cat src/a.txt; echo changed > src/a.txt; mkdir -p src/new && echo n > src/new/n.txt; echo t > /tmp/t');
    assert.equal(r1.stdout.text, 'original a\n');
    const r2 = await sh(f, 'cat src/a.txt src/new/n.txt /tmp/t');
    assert.equal(r2.stdout.text, 'changed\nn\nt\n');
    const read = await f.tools.readFile({ path: 'src/new/n.txt' });
    assert.equal(read.ok && read.value.content.text, 'n\n');
    // the host's snapshot is untouched, and the host's view of the area is an empty mount point
    assert.equal(readFileSync(join(f.snap, 'src', 'a.txt'), 'utf8'), 'original a\n');
    assert.deepEqual(readdirSync(join(f.root, 'session', 'area')), []);
  });

  test('tmpfs size cap: writes stop at the area size with ENOSPC (commands, /tmp and the write tool)', async () => {
    const f = await fixture();
    const r = await sh(f, 'dd if=/dev/zero of=src/big bs=64k count=64 2>&1 | tail -1; stat -c %s src/big; dd if=/dev/zero of=/tmp/big2 bs=64k count=64 2>&1 | tail -1');
    assert.match(r.stdout.text, /No space left on device/);
    const size = Number(r.stdout.text.split('\n')[1]);
    assert.ok(size <= MiB, `write stopped at ${size}`);
    await sh(f, 'rm -f src/big /tmp/big2');
    const big = await f.tools.writeFile({ path: 'src/huge.txt', content: 'z'.repeat(2 * MiB) });
    assert.equal(big.ok === false && big.error.code, 'no-space');
  });

  test('a run that outlives its timeout is killed and reported as timed out', async () => {
    const f = await fixture();
    const t0 = Date.now();
    const r = await sh(f, 'echo begin; sleep 30; echo never', 400);
    assert.equal(r.status, 'timed-out');
    assert.equal(r.stdout.text, 'begin\n');
    assert.ok(Date.now() - t0 < 5_000);
  });

  test('command output is capped with an explicit truncation marker', async () => {
    const f = await fixture();
    const tools = new ProgramTools(f.sandbox, { ...DEFAULT_TOOL_POLICY, outputCapBytes: 1000 });
    const r = await tools.runCommand({ command: "head -c 200000 /dev/zero | tr '\\0' a; echo err >&2" });
    assert.ok(r.ok);
    assert.equal(r.value.stdout.truncated, true);
    assert.equal(r.value.stdout.originalBytes, 200000);
    assert.ok(r.value.stdout.text.startsWith('a'.repeat(1000)));
    assert.ok(r.value.stdout.text.endsWith('[output truncated, original length 200000 bytes]'));
    assert.equal(r.value.stderr.text, 'err\n');
  });

  test('an environment root given as a directory: only its entries exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-exec-env-'));
    dirs.push(root);
    // a tiny "frozen environment": its own usr (bound from the host's), bin/lib as symlinks, and a marker file
    const env = join(root, 'rootfs');
    mkdirSync(env);
    for (const n of ['bin', 'lib', 'lib64', 'sbin']) {
      try {
        const t = execFileSync('readlink', [`/${n}`], { encoding: 'utf8' }).trim();
        if (t !== '') symlinkSync(t, join(env, n));
      } catch {
        /* not a symlink on this host */
      }
    }
    mkdirSync(join(env, 'etc'));
    writeFileSync(join(env, 'etc', 'frozen-marker'), 'frozen\n');
    const e = environmentFromDirectory(env);
    const usr = { kind: 'bind' as const, src: '/usr', dest: '/usr' };
    const f = await fixture({ environment: { entries: [...e.entries, usr], frozen: true } });
    const r = await sh(f, 'cat /etc/frozen-marker; ls /etc');
    assert.equal(r.stdout.text, 'frozen\nfrozen-marker\n');
  });
});

describe('the Claude Code process enclosure (7.1 "宿主一侧的写入也有上限", 6.2 recovery state)', { skip }, () => {
  test('only the config directory, /tmp and /dev/shm are writable, each capped; the state outlives the process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-exec-encl-'));
    dirs.push(root);
    const session = join(root, 'session');
    mkdirSync(session);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    const credMarker = `OAUTH-${Date.now()}`;
    writeFileSync(join(seed, 'settings.json'), '{"seeded":true}');
    writeFileSync(join(seed, '.credentials.json'), JSON.stringify({ token: credMarker }));
    const outsideTmp = `/var/tmp/mp-encl-test-${process.pid}-${Date.now()}`;
    const enc = await ClaudeCodeEnclosure.create({
      sessionDir: session,
      configBytes: 256 * KiB,
      tmpBytes: 256 * KiB,
      shmBytes: 64 * KiB,
      seedConfigFrom: seed,
    });
    try {
      // a shell stands in for the Claude Code executable
      const argv = enc.argv([
        '/bin/sh',
        '-c',
        [
          'cat "$CLAUDE_CONFIG_DIR/settings.json"; echo',
          'test -s "$CLAUDE_CONFIG_DIR/.credentials.json" && echo login-present',
          'mkdir -p "$CLAUDE_CONFIG_DIR/projects" && echo \'{"turn":1}\' > "$CLAUDE_CONFIG_DIR/projects/session.jsonl" && echo transcript-ok',
          `echo x > ${outsideTmp}; echo "host rc=$?"`,
          `echo x > ${root}/private-tmp-file && echo private-tmp-ok`,
          'dd if=/dev/zero of="$CLAUDE_CONFIG_DIR/big" bs=64k count=16 2>&1 | tail -1; rm -f "$CLAUDE_CONFIG_DIR/big"',
          'dd if=/dev/zero of=/tmp/big bs=64k count=16 2>&1 | tail -1',
          'dd if=/dev/zero of=/dev/shm/big bs=64k count=16 2>&1 | tail -1',
        ].join('; '),
      ]);
      const r = spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8' });
      let leaked = false;
      try {
        statSync(outsideTmp);
        leaked = true;
        rmSync(outsideTmp, { force: true });
      } catch {
        /* not there: good */
      }
      assert.equal(leaked, false, 'the read-only root kept the write off the host');
      assert.match(r.stdout, /\{"seeded":true\}/);
      assert.match(r.stdout, /login-present/);
      assert.match(r.stdout, /transcript-ok/);
      assert.match(r.stdout, /host rc=[12]/);
      assert.match(r.stdout, /private-tmp-ok/, '/tmp is private and writable');
      assert.equal(r.stdout.match(/No space left on device/g)?.length, 3, r.stdout);
      // nothing reached the host's view of the config directory or of /tmp
      assert.deepEqual(readdirSync(enc.configDir), []);
      assert.throws(() => statSync(join(root, 'private-tmp-file')));

      // 6.2: after the process ended, the state is still there; metered without the credentials
      const meter = await enc.meterState();
      assert.equal(meter.excluded, 1);
      assert.ok(meter.logicalBytes < 1024, `small state: ${meter.logicalBytes}`);
      // over the recovery-state cap: refused whole, nothing written
      const refused = await enc.captureState(join(root, 'too-small'), { maxLogicalBytes: 8, maxFiles: 10 });
      assert.equal(refused.ok, false);
      assert.equal(existsSync(join(root, 'too-small')), false);
      // within the cap: captured whole, credentials left out
      const captured = await enc.captureState(join(root, 'state'), { maxLogicalBytes: 64 * KiB, maxFiles: 100 });
      assert.ok(captured.ok);
      assert.deepEqual(
        captured.manifest.entries.map((e) => e.path),
        ['projects', 'projects/session.jsonl', 'settings.json'],
      );
      assert.equal(existsSync(join(root, 'state', '.credentials.json')), false);
      assert.equal(readFileSync(join(root, 'state', 'projects', 'session.jsonl'), 'utf8'), '{"turn":1}\n');

      // §14 item 1: every path the process left in its three areas, and nothing else
      const inv = await enc.inventory();
      assert.ok(inv.complete);
      for (const p of ['config/projects/', 'config/projects/session.jsonl', 'config/settings.json', 'config/.credentials.json', 'tmp/big', 'shm/big']) {
        assert.ok(inv.paths.includes(p), `${p} in ${inv.paths.join(', ')}`);
      }
      assert.ok(inv.paths.some((p) => p.startsWith('tmp/') && p.endsWith('/private-tmp-file')));
      assert.ok(inv.paths.every((p) => /^(config|tmp|shm)\//.test(p)), inv.paths.join(', '));
      // the login as the process left it (the host compares it with what it gave, for refreshes)
      assert.equal(await enc.readStateFile('.credentials.json'), JSON.stringify({ token: credMarker }));
      assert.equal(await enc.readStateFile('missing.json'), null);
      await assert.rejects(enc.readStateFile('../escape'));
    } finally {
      await enc.close();
    }

    // resuming in a new unit: the captured state seeds the new enclosure
    const session2 = join(root, 'session2');
    mkdirSync(session2);
    const enc2 = await ClaudeCodeEnclosure.create({ sessionDir: session2, configBytes: 256 * KiB, tmpBytes: 64 * KiB, seedConfigFrom: join(root, 'state') });
    try {
      const argv = enc2.argv(['/bin/sh', '-c', 'cat "$CLAUDE_CONFIG_DIR/projects/session.jsonl"']);
      assert.equal(spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8' }).stdout, '{"turn":1}\n');
    } finally {
      await enc2.close();
    }
    assert.equal(readFileSync(join(seed, '.credentials.json'), 'utf8').includes(credMarker), true, 'the seed itself is untouched');
  });
});
