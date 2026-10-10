// Design 7.1 program tools: path rules, typed results, output caps; and the export rules
// (metered by logical length and file count, refused as a whole over the card's cap).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { HeadCollector, HeadTailCollector, capBytes, utf8Prefix, utf8Suffix } from '../src/exec/caps.ts';
import { detectExecCapabilities, isolationPolicy } from '../src/exec/platform.ts';
import { SandboxError, ToolSandbox, hostSystemEnvironment, normalizeWritablePath } from '../src/exec/sandbox.ts';
import { DEFAULT_TOOL_POLICY, ProgramTools, exportWritable, isWritableRel, meterWritable, resolveSeatPath } from '../src/exec/tools.ts';

const caps = detectExecCapabilities();
const skip = caps.bwrapUsable && caps.nsenter !== null ? false : 'needs a usable bubblewrap and nsenter';
const MiB = 1024 * 1024;
const dirs: string[] = [];
const open: ToolSandbox[] = [];

after(async () => {
  for (const s of open) await s.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function fixture(areaBytes = 4 * MiB, policy = DEFAULT_TOOL_POLICY) {
  const root = mkdtempSync(join(tmpdir(), 'mp-exec-tools-'));
  dirs.push(root);
  const snap = join(root, 'snap');
  mkdirSync(join(snap, 'src', 'lib'), { recursive: true });
  mkdirSync(join(snap, 'docs'));
  writeFileSync(join(snap, 'src', 'main.ts'), 'export const a = 1;\nexport const b = 2;\nconst a2 = "a";\n');
  writeFileSync(join(snap, 'src', 'lib', 'util.ts'), 'export function util() { return "UTIL"; }\n');
  writeFileSync(join(snap, 'docs', 'readme.md'), '# Title\nsome text\n');
  writeFileSync(join(snap, 'notes.txt'), 'top-level, read only\n');
  const session = join(root, 'session');
  mkdirSync(session);
  const sandbox = await ToolSandbox.create(
    { snapshotDir: snap, writablePaths: ['src'], area: { kind: 'tmpfs', bytes: areaBytes }, environment: hostSystemEnvironment(), sessionDir: session },
    { runLayers: null },
  );
  open.push(sandbox);
  return { root, snap, sandbox, tools: new ProgramTools(sandbox, policy) };
}

describe('output caps (pure)', () => {
  test('cuts at the cap, never inside a UTF-8 sequence, and names the original length', () => {
    const s = Buffer.from('ab€cd', 'utf8'); // € is 3 bytes: a b [e2 82 ac] c d
    assert.deepEqual(capBytes(s, 100), { text: 'ab€cd', truncated: false, originalBytes: 7 });
    const c = capBytes(s, 3);
    assert.equal(c.text, 'ab\n[output truncated, original length 7 bytes]');
    assert.equal(c.truncated, true);
    assert.equal(Buffer.from(utf8Prefix(s, 4)).toString(), 'ab');
    assert.equal(Buffer.from(utf8Prefix(s, 5)).toString(), 'ab€');
    assert.equal(Buffer.from(utf8Suffix(s, 3)).toString(), 'cd');
    assert.equal(Buffer.from(utf8Suffix(s, 5)).toString(), '€cd');
  });

  test('stream collector keeps the head and counts everything', () => {
    const h = new HeadCollector(5);
    for (const part of ['abc', 'def', 'ghij']) h.push(Buffer.from(part));
    assert.deepEqual(h.result(), { text: 'abcde\n[output truncated, original length 10 bytes]', truncated: true, originalBytes: 10 });
    const small = new HeadCollector(5);
    small.push(Buffer.from('abc'));
    assert.deepEqual(small.result(), { text: 'abc', truncated: false, originalBytes: 3 });
  });

  test('the unit log keeps head and tail with the marker between', () => {
    const ht = new HeadTailCollector(4, 4);
    for (let i = 0; i < 10; i++) ht.push(Buffer.from(`${i}${i}${i}`));
    const r = ht.result();
    assert.equal(r.text, '0001\n[output truncated, original length 30 bytes]\n8999');
    const short = new HeadTailCollector(4, 4);
    short.push(Buffer.from('short'));
    assert.deepEqual(short.result(), { text: 'short', truncated: false, originalBytes: 5 });
  });
});

describe('path rules (pure)', () => {
  test('seat paths resolve inside the snapshot or are refused', () => {
    assert.deepEqual(resolveSeatPath('src/a.ts', '/work'), { ok: true, abs: '/work/src/a.ts', rel: 'src/a.ts' });
    assert.deepEqual(resolveSeatPath('/work/src/', '/work'), { ok: true, abs: '/work/src', rel: 'src' });
    assert.deepEqual(resolveSeatPath('.', '/work'), { ok: true, abs: '/work', rel: '.' });
    assert.deepEqual(resolveSeatPath('src/../docs', '/work'), { ok: true, abs: '/work/docs', rel: 'docs' });
    for (const bad of ['../etc/passwd', '/etc/passwd', '/workshop/x', 'src/../../x']) {
      const r = resolveSeatPath(bad, '/work');
      assert.equal(r.ok === false && r.error.code, 'outside-snapshot', bad);
    }
    for (const bad of ['', 'a\0b', 42]) {
      const r = resolveSeatPath(bad, '/work');
      assert.equal(r.ok === false && r.error.code, 'invalid-argument');
    }
  });

  test('writable means a card writable path or under one', () => {
    assert.equal(isWritableRel('src', ['src']), true);
    assert.equal(isWritableRel('src/a/b', ['src']), true);
    assert.equal(isWritableRel('srcx', ['src']), false);
    assert.equal(isWritableRel('.', ['src']), false);
    assert.equal(isWritableRel('anything', ['.']), true);
  });

  test('card writable paths are normalized and may not leave the snapshot or name .git', () => {
    assert.equal(normalizeWritablePath('src/'), 'src');
    assert.equal(normalizeWritablePath('./src//lib'), 'src/lib');
    assert.equal(normalizeWritablePath('.'), '.');
    for (const bad of ['', '/abs', '../up', 'a/../../b', '.git', 'sub/.git/hooks']) {
      assert.throws(() => normalizeWritablePath(bad), SandboxError, bad);
    }
  });

  test('platform table (7.1 平台策略)', () => {
    const full = { bwrap: '/usr/bin/bwrap', nsenter: '/usr/bin/nsenter', cgroupV2: true, delegatedControllers: ['cpu', 'memory', 'pids'] };
    assert.deepEqual(isolationPolicy('linux', full).requiresAcceptance, []);
    assert.equal(isolationPolicy('linux', full).toolSandbox, 'bubblewrap');
    assert.deepEqual(isolationPolicy('linux', { ...full, delegatedControllers: [] }).requiresAcceptance, ['resource-limits']);
    assert.notEqual(isolationPolicy('linux', { ...full, bwrap: null }).blocked, null);
    const win = isolationPolicy('win32', full);
    assert.equal(win.runCommand, false);
    assert.equal(win.programVerificationRuns, false);
    assert.deepEqual(win.requiresAcceptance, ['isolation', 'host-write-cap']);
    assert.deepEqual(isolationPolicy('darwin', full).requiresAcceptance, ['host-write-cap']);
  });
});

describe('program tools inside the sandbox', { skip }, () => {
  test('read: content with size; a long file is cut at the cap with the original length', async () => {
    const policy = { ...DEFAULT_TOOL_POLICY, outputCapBytes: 1024 };
    const f = await fixture(4 * MiB, policy);
    const ok = await f.tools.readFile({ path: 'src/main.ts' });
    assert.ok(ok.ok);
    assert.equal(ok.value.content.text, 'export const a = 1;\nexport const b = 2;\nconst a2 = "a";\n');
    assert.equal(ok.value.encoding, 'utf8');

    await f.tools.writeFile({ path: 'src/long.txt', content: 'x'.repeat(100_000) });
    const long = await f.tools.readFile({ path: 'src/long.txt' });
    assert.ok(long.ok);
    assert.equal(long.value.size, 100_000);
    assert.equal(long.value.content.truncated, true);
    assert.equal(long.value.content.text, `${'x'.repeat(1024)}\n[output truncated, original length 100000 bytes]`);
    const tail = await f.tools.readFile({ path: 'src/long.txt', offset: 99_990 });
    assert.ok(tail.ok);
    assert.equal(tail.value.content.text, 'x'.repeat(10));

    const dir = await f.tools.readFile({ path: 'src' });
    assert.equal(dir.ok === false && dir.error.code, 'not-a-file');
    const missing = await f.tools.readFile({ path: 'src/none.ts' });
    assert.equal(missing.ok === false && missing.error.code, 'not-found');
  });

  test('read: binary content comes back as base64', async () => {
    const f = await fixture();
    const r = await f.tools.runCommand({ command: "printf '\\000\\377\\001' > src/bin.dat" });
    assert.ok(r.ok && r.value.status === 'completed');
    const b = await f.tools.readFile({ path: 'src/bin.dat' });
    assert.ok(b.ok);
    assert.equal(b.value.encoding, 'base64');
    assert.equal(b.value.content.text, Buffer.from([0, 255, 1]).toString('base64'));
  });

  test('list: entries with kinds and sizes; capped with a count', async () => {
    const f = await fixture(4 * MiB, { ...DEFAULT_TOOL_POLICY, listCapEntries: 2 });
    const all = await new ProgramTools(f.sandbox).listDirectory({ path: '.' });
    assert.ok(all.ok);
    assert.deepEqual(
      all.value.entries.map((e) => [e.name, e.kind]),
      [
        ['docs', 'dir'],
        ['notes.txt', 'file'],
        ['src', 'dir'],
      ],
    );
    const capped = await f.tools.listDirectory({ path: '.' });
    assert.ok(capped.ok);
    assert.equal(capped.value.truncated, true);
    assert.equal(capped.value.total, 3);
    assert.match(capped.value.text.text, /\[listing truncated: 2 of 3 entries\]/);
  });

  test('search: literal, regex, case-insensitive; capped with a marker', async () => {
    const f = await fixture(4 * MiB, { ...DEFAULT_TOOL_POLICY, searchCapMatches: 2 });
    const lit = await new ProgramTools(f.sandbox).searchContent({ pattern: 'export' });
    assert.ok(lit.ok);
    assert.deepEqual(
      lit.value.matches.map((m) => `${m.path}:${m.line}`),
      ['src/lib/util.ts:1', 'src/main.ts:1', 'src/main.ts:2'],
    );
    const re = await new ProgramTools(f.sandbox).searchContent({ pattern: '^const a\\d', regex: true, path: 'src' });
    assert.ok(re.ok);
    assert.deepEqual(
      re.value.matches.map((m) => m.text),
      ['const a2 = "a";'],
    );
    const cs = await new ProgramTools(f.sandbox).searchContent({ pattern: 'Util', path: 'src/lib' });
    assert.ok(cs.ok);
    assert.equal(cs.value.matches.length, 0, 'case-sensitive by default');
    const ci = await new ProgramTools(f.sandbox).searchContent({ pattern: 'Util', ignoreCase: true, path: 'src/lib' });
    assert.ok(ci.ok);
    assert.deepEqual(
      ci.value.matches.map((m) => `${m.path}:${m.line}`),
      ['src/lib/util.ts:1'],
    );
    const capped = await f.tools.searchContent({ pattern: 'export' });
    assert.ok(capped.ok);
    assert.equal(capped.value.truncated, true);
    assert.match(capped.value.text.text, /\[search truncated after 2 matches/);
    const bad = await f.tools.searchContent({ pattern: '(', regex: true });
    assert.equal(bad.ok === false && bad.error.code, 'invalid-argument');
  });

  test('write: creates parents inside a writable path; refused elsewhere', async () => {
    const f = await fixture();
    const w = await f.tools.writeFile({ path: 'src/deep/er/new.ts', content: 'new\n' });
    assert.deepEqual(w, { ok: true, value: { path: 'src/deep/er/new.ts', bytes: 4, created: true } });
    const again = await f.tools.writeFile({ path: '/work/src/deep/er/new.ts', content: 'newer\n' });
    assert.deepEqual(again, { ok: true, value: { path: 'src/deep/er/new.ts', bytes: 6, created: false } });
    for (const p of ['notes.txt', 'docs/new.md', '../escape.txt', '/tmp/x']) {
      const r = await f.tools.writeFile({ path: p, content: 'x' });
      assert.equal(r.ok, false, p);
    }
    const onDir = await f.tools.writeFile({ path: 'src/lib', content: 'x' });
    assert.equal(onDir.ok === false && onDir.error.code, 'not-a-file');
    assert.equal(existsSync(join(f.snap, 'src', 'deep')), false, 'the host snapshot is never written');
  });

  test('edit: exact replacement of a unique string; not found, not unique, replace all, binary', async () => {
    const f = await fixture();
    const one = await f.tools.editFile({ path: 'src/main.ts', oldString: 'b = 2', newString: 'b = 3' });
    assert.deepEqual(one, { ok: true, value: { path: 'src/main.ts', replacements: 1 } });
    const none = await f.tools.editFile({ path: 'src/main.ts', oldString: 'zzz', newString: 'y' });
    assert.equal(none.ok === false && none.error.code, 'no-match');
    const many = await f.tools.editFile({ path: 'src/main.ts', oldString: 'export const', newString: 'export let' });
    assert.equal(many.ok === false && many.error.code, 'not-unique');
    const all = await f.tools.editFile({ path: 'src/main.ts', oldString: 'export const', newString: 'export let', replaceAll: true });
    assert.deepEqual(all, { ok: true, value: { path: 'src/main.ts', replacements: 2 } });
    const read = await f.tools.readFile({ path: 'src/main.ts' });
    assert.ok(read.ok);
    assert.equal(read.value.content.text, 'export let a = 1;\nexport let b = 3;\nconst a2 = "a";\n');
    const same = await f.tools.editFile({ path: 'src/main.ts', oldString: 'a', newString: 'a' });
    assert.equal(same.ok === false && same.error.code, 'invalid-argument');
    const ro = await f.tools.editFile({ path: 'docs/readme.md', oldString: 'Title', newString: 'T' });
    assert.equal(ro.ok === false && ro.error.code, 'not-writable');
    await f.tools.runCommand({ command: "printf 'a\\377b' > src/bin.dat" });
    const bin = await f.tools.editFile({ path: 'src/bin.dat', oldString: 'a', newString: 'c' });
    assert.equal(bin.ok === false && bin.error.code, 'binary');
  });
});

describe('a card writable path that is a single file', { skip }, () => {
  test('written and edited in place; its siblings stay read-only; exported alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-exec-filew-'));
    dirs.push(root);
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'cfg'), { recursive: true });
    writeFileSync(join(snap, 'cfg', 'app.json'), '{"debug":false}\n');
    writeFileSync(join(snap, 'cfg', 'other.json'), '{}\n');
    const session = join(root, 'session');
    mkdirSync(session);
    const sandbox = await ToolSandbox.create(
      { snapshotDir: snap, writablePaths: ['cfg/app.json'], area: { kind: 'tmpfs', bytes: MiB }, environment: hostSystemEnvironment(), sessionDir: session },
      { runLayers: null },
    );
    open.push(sandbox);
    const tools = new ProgramTools(sandbox);
    const e = await tools.editFile({ path: 'cfg/app.json', oldString: 'false', newString: 'true' });
    assert.deepEqual(e, { ok: true, value: { path: 'cfg/app.json', replacements: 1 } });
    const sib = await tools.writeFile({ path: 'cfg/other.json', content: 'x' });
    assert.equal(sib.ok === false && sib.error.code, 'not-writable');
    const r = await tools.runCommand({ command: 'cat cfg/app.json; echo y > cfg/new.json; echo "rc=$?"' });
    assert.ok(r.ok);
    assert.equal(r.value.stdout.text, '{"debug":true}\nrc=2\n');
    const out = await exportWritable(sandbox, join(root, 'export'), { maxLogicalBytes: MiB, maxFiles: 10 });
    assert.ok(out.ok);
    assert.deepEqual(
      out.manifest.entries.map((x) => x.path),
      ['cfg/app.json'],
    );
    assert.equal(readFileSync(join(snap, 'cfg', 'app.json'), 'utf8'), '{"debug":false}\n', 'the host snapshot is untouched');
  });
});

describe('export (7.1 导出规则)', { skip }, () => {
  test('within the caps: every file of the writable paths, with hashes; symlinks only in the manifest', async () => {
    const f = await fixture();
    await f.tools.writeFile({ path: 'src/added.txt', content: 'added\n' });
    await f.tools.runCommand({ command: 'ln -s main.ts src/alias.ts; chmod +x src/added.txt' });
    const dest = join(f.root, 'export');
    const out = await exportWritable(f.sandbox, dest, { maxLogicalBytes: MiB, maxFiles: 100 });
    assert.ok(out.ok);
    const paths = out.manifest.entries.map((e) => `${e.kind}:${e.path}`);
    assert.deepEqual(paths, ['file:src/added.txt', 'symlink:src/alias.ts', 'dir:src/lib', 'file:src/lib/util.ts', 'file:src/main.ts']);
    const added = out.manifest.entries.find((e) => e.path === 'src/added.txt');
    assert.equal(added?.sha256, createHash('sha256').update('added\n').digest('hex'));
    assert.equal((added?.mode ?? 0) & 0o111, 0o111, 'the executable bit is recorded');
    assert.equal(readFileSync(join(dest, 'src', 'added.txt'), 'utf8'), 'added\n');
    assert.equal(existsSync(join(dest, 'src', 'alias.ts')), false, 'symlinks are not created on the host');
    assert.equal(out.manifest.entries.find((e) => e.kind === 'symlink')?.target, 'main.ts');
  });

  test('a sparse file is metered by its logical length: over the cap, the whole export is refused', async () => {
    const f = await fixture(4 * MiB);
    const r = await f.tools.runCommand({ command: 'truncate -s 1G src/sparse.bin && stat -c "%s %b" src/sparse.bin' });
    assert.ok(r.ok);
    assert.match(r.value.stdout.text, /^1073741824 0\n/, 'the 1 GiB file occupies no blocks in the 4 MiB area');
    const meter = await meterWritable(f.sandbox);
    assert.ok(meter.logicalBytes >= 1073741824);
    const dest = join(f.root, 'export');
    const out = await exportWritable(f.sandbox, dest, { maxLogicalBytes: 16 * MiB, maxFiles: 100 });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 'resource-exceeded');
      assert.ok(out.meter.logicalBytes >= 1073741824);
    }
    assert.equal(existsSync(dest), false, 'nothing was written');
  });

  test('v34: a .git directory or file anywhere in the writable paths refuses the whole export as a seat failure', async () => {
    for (const make of ['mkdir -p src/lib/.git && echo ref > src/lib/.git/HEAD', 'echo "gitdir: ../x" > src/.git']) {
      const f = await fixture();
      const r = await f.tools.runCommand({ command: make });
      assert.ok(r.ok && r.value.status === 'completed');
      const dest = join(f.root, 'export');
      const out = await exportWritable(f.sandbox, dest, { maxLogicalBytes: MiB, maxFiles: 100 });
      assert.equal(out.ok, false);
      if (!out.ok) {
        assert.equal(out.status, 'seat-failure');
        if (out.status === 'seat-failure') assert.match(out.refused.join(), /\.git/);
      }
      assert.equal(existsSync(dest), false, 'nothing was written');
    }
  });

  test('over the file-count cap, the whole export is refused', async () => {
    const f = await fixture();
    await f.tools.runCommand({ command: 'mkdir -p src/many && for i in $(seq 1 40); do : > src/many/f$i; done' });
    const dest = join(f.root, 'export');
    const out = await exportWritable(f.sandbox, dest, { maxLogicalBytes: MiB, maxFiles: 20 });
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.meter.entries > 40);
    assert.equal(existsSync(dest), false);
  });
});
