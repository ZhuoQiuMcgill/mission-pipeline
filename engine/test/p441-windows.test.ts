// 4.4.1: the engine in PowerShell on Windows. A: how a role is told to call `mp` there (the seat's fixed
// prompt, the Secretary's launch, the session pointer, the pages and the card; `plugin/bin/mp.ps1`), each
// with the platform as a parameter so both forms are tested on every system. B: the one reader of text a
// person or a seat hands the engine (a byte-order mark dropped, UTF-16 decoded, bytes that are not UTF-8
// warned about, a NUL refused where it was, with what to do; no byte-order mark: 4.4.0's text and
// identity). C: "occurs verbatim" with a CRLF and an LF as the same line break.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, test } from 'node:test';
import { sha256 } from '../src/common/hash.ts';
import { POWERSHELL_NOTE, psQuote, withPowerShellNote } from '../src/common/powershell.ts';
import { decodeInput, readInputFile } from '../src/common/textInput.ts';
import { occursVerbatim } from '../src/common/verbatim.ts';
import { forgetObservedEnvironment, readEnvironmentConfig } from '../src/evaluator/index.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { readConfig } from '../src/cli/config.ts';
import { COMMANDS, runCli } from '../src/cli/main.ts';
import { parseArgs } from '../src/cli/args.ts';
import { secretaryLaunch } from '../src/cli/commands/secretary.ts';
import { openProcess, seatPrompt } from '../src/process/index.ts';
import { wordsEntry } from '../src/memory/index.ts';
import { residentRecords } from '../src/memory/words.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { addPlan } from './process-fixtures.ts';
import { ENGINE, ENV_A, cardOf, gitProject, materialPages, type TestProject } from './cli-fixtures.ts';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16le = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]);
const CHINESE = '请把导出做成 CSV 格式，列名用中文。';

interface Out { readonly code: number; readonly out: string; readonly json: any }

/** `mp` in this process; the standard input may be bytes, as bin/mp.mjs hands them over. */
async function mp(dir: string, argv: readonly string[], stdin?: string | Uint8Array): Promise<Out> {
  forgetObservedEnvironment();
  const r = await runCli([...argv, '--json'], {
    cwd: dir,
    env: { ...process.env, MP_PROJECT: '', MP_SECRETARY: '' },
    ...(stdin !== undefined ? { stdin: () => stdin } : {}),
    process: { observe: () => ENV_A, git: PlainGit.create(), ident: { name: 'mp test', email: 'mp@test' } },
  });
  const text = r.stdout || r.stderr;
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { code: r.exitCode, out: text, json };
}

async function ok(dir: string, argv: readonly string[], stdin?: string | Uint8Array): Promise<any> {
  const r = await mp(dir, argv, stdin);
  assert.equal(r.code, 0, `mp ${argv.join(' ')} failed (${r.code}): ${r.out}`);
  return r.json;
}

/** The recorded text of a words entry. */
function recorded(dir: string, words: string): string {
  forgetObservedEnvironment();
  const ctx = openProcess(dir, { observe: () => ENV_A });
  try {
    const w = ctx.memory.read((db) => wordsEntry(db, words));
    assert.ok(w !== null, `no words entry ${words}`);
    return ctx.memory.data.text(w.text);
  } finally {
    ctx.memory.close();
  }
}

async function project(): Promise<TestProject> {
  const p = gitProject();
  await ok(p.dir, ['init']);
  await ok(p.dir, ['pm', 'session', '--filled-by', 'test/model']);
  await ok(p.dir, ['pm', 'mission', 'open', 'm1']);
  return p;
}

const PROMPT_440 = 'You are the Calibrator of Mission Pipeline. Your card: `mp seat D-1 card`. Use only the `mp seat D-1` commands listed there. Finish with `mp seat D-1 handback`.';

describe('A: everyone told to run mp on Windows is told how in PowerShell', () => {
  it("the seat's fixed prompt: 4.4.0's byte for byte on Linux and macOS; on Windows it ends with the PowerShell sentence", () => {
    assert.equal(seatPrompt('Calibrator', 'D-1', 'linux'), PROMPT_440);
    assert.equal(seatPrompt('Calibrator', 'D-1', 'darwin'), PROMPT_440);
    assert.equal(seatPrompt('Calibrator', 'D-1', 'win32'), `${PROMPT_440} ${POWERSHELL_NOTE}`);
    assert.match(POWERSHELL_NOTE, /`mp\.ps1` for `mp`/);
    assert.match(POWERSHELL_NOTE, /`mp\.cmd` called from PowerShell drops double quotes inside an argument/);
    assert.equal(withPowerShellNote('x', 'linux'), 'x');
  });

  it("mp pm secretary start: 4.4.0's prompt and hint elsewhere; on Windows the prompt carries the sentence and a PowerShell hint sets MP_SECRETARY for the launch only", () => {
    const g = { generation: 'S-2', name: "it's-Secretary" };
    const linux = secretaryLaunch(g, 'linux');
    const prompt440 = "You are it's-Secretary, the resident Secretary of Mission Pipeline. Run mp sec session first; then read your handbook (mp sec handbook) and loop on mp sec next / mp sec wait.";
    assert.equal(linux.prompt, prompt440);
    assert.equal(linux.launch, `MP_SECRETARY=S-2 claude --bg -n 'it'"'"'s-Secretary' '${prompt440.replace(/'/g, `'"'"'`)}'`);
    assert.equal(linux.launchPowerShell, null);
    const win = secretaryLaunch(g, 'win32');
    assert.equal(win.prompt, `${prompt440} ${POWERSHELL_NOTE}`);
    assert.ok(win.launch.startsWith('MP_SECRETARY=S-2 claude --bg -n '), 'the existing hint stays beside it');
    assert.equal(win.launchPowerShell, `try { $env:MP_SECRETARY = 'S-2'; claude --bg -n 'it''s-Secretary' ${psQuote(win.prompt)} } finally { Remove-Item Env:MP_SECRETARY }`);
    assert.equal(psQuote('a’b'), "'a’’b'", 'PowerShell reads a typographic quote as a quote too');
  });

  const shell = ['pwsh', 'powershell.exe'].find((s) => spawnSync(s, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 60_000 }).status === 0);
  it('the PowerShell launch hint parses, passes the name and the prompt as given, and leaves MP_SECRETARY unset after the launch', { skip: shell === undefined ? 'no PowerShell on this machine' : false }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-ps-'));
    try {
      const hint = secretaryLaunch({ generation: 'S-3', name: "it's-Secretary" }, 'win32').launchPowerShell!;
      // a stand-in for claude: prints its arguments and the variable it sees, one per line
      const script = ["function claude { [Console]::Out.WriteLine(\"env=$env:MP_SECRETARY\"); foreach ($a in $args) { [Console]::Out.WriteLine(\"arg=$a\") } }", hint, '[Console]::Out.WriteLine("after=[$env:MP_SECRETARY]")'].join('\n');
      writeFileSync(join(dir, 'launch.ps1'), `﻿${script}\n`);
      const r = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'launch.ps1')], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, MP_SECRETARY: '' } });
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.split(/\r?\n/).filter((l) => l !== '');
      assert.deepEqual(lines, ['env=S-3', 'arg=--bg', 'arg=-n', "arg=it's-Secretary", `arg=${secretaryLaunch({ generation: 'S-3', name: "it's-Secretary" }, 'win32').prompt}`, 'after=[]']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the Claude Code hook: the session pointer of 4.4.0 elsewhere; on Windows it ends with the same sentence', async () => {
    const hook = (await import(pathToFileURL(join(ENGINE, 'plugin', 'hooks', 'claude-code.mjs')).href)) as { POWERSHELL_NOTE: string; sessionPointer(platform?: string): string };
    const pointer440 = 'This project uses Mission Pipeline.\nIf you are the PM, read the core of `.mission-pipeline/pm/PM.md` and run `mp pm session`.\nIf you were started as a seat, your card (`mp seat <id> card`) is your whole instruction.';
    assert.equal(hook.sessionPointer('linux'), pointer440);
    assert.equal(hook.sessionPointer('win32'), `${pointer440}\n${POWERSHELL_NOTE}`);
    assert.equal(hook.POWERSHELL_NOTE, POWERSHELL_NOTE, 'the hook says what the engine says');
  });

  it('the pages: one line marked "PowerShell:" where each seat lists its mp seat commands, in both handbooks, and beside the here-document and the VAR=value launch', () => {
    const plugin = join(ENGINE, 'plugin');
    for (const role of ['architect', 'auditor', 'calibrator', 'constructor', 'crititor', 'researcher', 'reviewer', 'stabilizer']) {
      const page = readFileSync(join(plugin, 'roles', `${role}.md`), 'utf8');
      const commands = page.slice(page.indexOf('## Your commands'));
      const lines = commands.split('\n').filter((l) => l.includes('PowerShell:'));
      assert.equal(lines.length, 1, `roles/${role}.md: one PowerShell line in its commands`);
      assert.match(lines[0]!, /`mp\.ps1` for `mp`/, role);
      assert.match(lines[0]!, /`'@ \| mp\.ps1 seat <id> handback --stdin`/, `${role}: the stdin hand-back as a here-string`);
    }
    const pm = readFileSync(join(plugin, 'pm', 'PM.md'), 'utf8');
    const core = pm.slice(pm.indexOf('<!-- core:start -->'), pm.indexOf('<!-- core:end -->'));
    assert.equal(core.split('\n').filter((l) => l.includes('PowerShell:')).length, 1, 'the PM core, where its first command is');
    assert.match(pm, /PowerShell: `try \{ \$env:MP_SECRETARY = 'S-<n>'; claude --bg/, 'the launch beside the VAR=value form');
    const sec = readFileSync(join(plugin, 'secretary', 'SECRETARY.md'), 'utf8');
    const identity = sec.slice(sec.indexOf('## Session and identity'), sec.indexOf('## The dispatch loop'));
    assert.equal(identity.split('\n').filter((l) => l.startsWith('PowerShell:')).length, 1, 'the Secretary handbook, where its first command is');
  });

  it('plugin/bin/mp.ps1: the PowerShell entry beside mp and mp.cmd, with LF line ends', () => {
    const text = readFileSync(join(ENGINE, 'plugin', 'bin', 'mp.ps1'), 'utf8');
    assert.doesNotMatch(text, /\r/);
    assert.match(text, /\$MyInvocation\.ExpectingInput/);
    assert.match(text, /exit \$LASTEXITCODE/);
  });

  it('plugin/bin/mp.ps1 called by its full path: arguments with quotes reach the engine intact, piped input passes through, the exit code is the launcher\'s', { skip: process.platform !== 'win32' ? 'mp.ps1 is the Windows entry' : shell === undefined ? 'no PowerShell on this machine' : false }, async () => {
    const p = await project();
    try {
      const entry = join(ENGINE, 'plugin', 'bin', 'mp.ps1');
      const quoted = 'x "quoted" y & 100% ^ <a> | b';
      const script = [
        `& '${entry}' pm say '${quoted}' --tag principle | Out-Null`,
        '[Console]::Out.WriteLine("say=$LASTEXITCODE")',
        `'piped text' | & '${entry}' pm say --stdin --tag principle | Out-Null`,
        '[Console]::Out.WriteLine("stdin=$LASTEXITCODE")',
        `& '${entry}' nosuch 2>$null | Out-Null`,
        '[Console]::Out.WriteLine("unknown=$LASTEXITCODE")',
      ].join('\n');
      writeFileSync(join(p.base, 'entry.ps1'), `${script}\n`);
      const r = spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(p.base, 'entry.ps1')], { cwd: p.dir, encoding: 'utf8', timeout: 300_000, env: { ...process.env, MP_PROJECT: '', MP_SECRETARY: '' } });
      assert.deepEqual(r.stdout.split(/\r?\n/).filter((l) => l !== ''), ['say=0', 'stdin=0', 'unknown=64'], r.stderr);
      // PowerShell 7 passes the quotes; Windows PowerShell 5.1 drops them on its way to any native program (the README says so)
      if (shell === 'pwsh') assert.equal(recorded(p.dir, 'W-1'), quoted);
      assert.equal(recorded(p.dir, 'W-2').trimEnd(), 'piped text');
    } finally {
      p.cleanup();
    }
  });
});

describe('B: one reader for text a person or a seat hands the engine', () => {
  it('no byte-order mark: exactly what 4.4.0 read (bytes that are not UTF-8 too), line ends kept', () => {
    for (const bytes of [Buffer.from(`a\r\nb\n${CHINESE}`), Buffer.from([0x61, 0xff, 0x62, 0xc3]), Buffer.from(''), Buffer.from('﻿not at the start? no: it is', 'utf8').subarray(3)]) {
      const r = decodeInput(bytes, 'x');
      assert.equal(r.text, bytes.toString('utf8'));
      assert.equal(r.bom, null);
    }
    assert.equal(decodeInput(Buffer.from('a\r\nb'), 'x').text, 'a\r\nb', 'line ends are not changed');
    assert.equal(decodeInput('as given\r\n', 'x').text, 'as given\r\n', 'a string is taken as it is');
  });

  it('a UTF-8 byte-order mark is dropped; UTF-16 with a mark (little or big endian) is decoded', () => {
    const text = `${CHINESE}\r\nline two`;
    for (const [bytes, bom] of [[Buffer.concat([BOM, Buffer.from(text)]), 'utf-8'], [utf16le(text), 'utf-16le'], [utf16be(text), 'utf-16be']] as const) {
      const r = decodeInput(bytes, 'x');
      assert.deepEqual([r.text, r.bom, r.invalid, r.nul, r.warning], [text, bom, false, false, null]);
    }
    // Windows PowerShell 5.1 with $OutputEncoding = UTF8 pipes the mark twice
    assert.equal(decodeInput(Buffer.concat([BOM, BOM, Buffer.from(text)]), 'x').text, text);
    assert.equal(decodeInput(Buffer.from(`﻿${text}`, 'utf8').subarray(3), 'x').text, text);
    assert.equal(decodeInput(Buffer.from(`a﻿`, 'utf8'), 'x').text, 'a﻿', 'a U+FEFF after the start is text');
    const dir = mkdtempSync(join(tmpdir(), 'mp-read-'));
    try {
      writeFileSync(join(dir, 'f.txt'), utf16le('from a file'));
      assert.equal(readInputFile(join(dir, 'f.txt')).text, 'from a file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bytes that are not UTF-8: read as U+FFFD as before, with one warning line; a NUL with no mark: a warning that says what to do', () => {
    const bad = decodeInput(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'the file cafe.txt');
    assert.equal(bad.text, 'caf�');
    assert.equal(bad.invalid, true);
    assert.equal(bad.warning, 'Warning: the file cafe.txt holds bytes that are not UTF-8; they are shown as U+FFFD. Save it as UTF-8 and run the command again.');
    const nul = decodeInput(Buffer.from('hi', 'utf16le'), 'the standard input');
    assert.equal(nul.nul, true);
    assert.match(nul.warning!, /NUL characters: it is probably UTF-16 without a byte-order mark\. Save it as UTF-8/);
    assert.equal(decodeInput(utf16le('a\u0000b'), 'x').nul, false, 'with a mark a NUL is the text');
  });

  it('mp pm say --file with a byte-order mark records the same entry as without one; UTF-16 and a BOM on stdin too; the identity without a mark is 4.4.0\'s', async () => {
    const p = await project();
    try {
      const text = `${CHINESE}\r\nsecond line`;
      writeFileSync(join(p.base, 'plain.txt'), text);
      writeFileSync(join(p.base, 'bom.txt'), Buffer.concat([BOM, Buffer.from(text)]));
      writeFileSync(join(p.base, 'utf16.txt'), utf16le(text));
      const first = await ok(p.dir, ['pm', 'say', '--file', join(p.base, 'plain.txt')]);
      assert.deepEqual([first.result.words, first.result.repeated], ['W-1', false]);
      assert.equal(recorded(p.dir, 'W-1'), text, 'recorded as given, CRLF included');
      for (const f of ['bom.txt', 'utf16.txt']) {
        const again = await ok(p.dir, ['pm', 'say', '--file', join(p.base, f)]);
        assert.deepEqual([again.result.words, again.result.repeated], ['W-1', true], `${f}: the same text, the same entry`);
      }
      const piped = await ok(p.dir, ['pm', 'say', '--stdin'], Buffer.concat([BOM, Buffer.from(text)]));
      assert.deepEqual([piped.result.words, piped.result.repeated], ['W-1', true], 'a BOM on the standard input is dropped');
      // a note and a summary from a file: the same reader
      await ok(p.dir, ['pm', 'note', '--file', join(p.base, 'utf16.txt')]);
      assert.equal((await ok(p.dir, ['read', 'notes'])).result.notes[0].text, text);
      await ok(p.dir, ['pm', 'tag', 'W-1', '--tag', 'principle']);
      await ok(p.dir, ['pm', 'summary', '--file', join(p.base, 'bom.txt'), '--covers', 'W-1#1']);
      forgetObservedEnvironment();
      const ctx = openProcess(p.dir, { observe: () => ENV_A });
      try {
        assert.equal(residentRecords(ctx.memory, 'words.summary')[0]?.text, text);
      } finally {
        ctx.memory.close();
      }
      // without a mark, what the operation is identified by is 4.4.0's: the file's text as Node reads it
      const plan = COMMANDS.find((c) => c.group === 'pm' && c.name[0] === 'plan')!;
      const args = parseArgs(['submit', 'm1', '--file', join(p.base, 'plain.txt')], plan.flags);
      assert.equal((plan.identity!(args) as { plan: string }).plan, sha256(readFileSync(join(p.base, 'plain.txt'), 'utf8')));
    } finally {
      p.cleanup();
    }
  });

  it('mp pm say: bytes that are not UTF-8 are recorded as U+FFFD with a warning line (no new refusal); a NUL with no mark stays refused and says what to do', async () => {
    const p = await project();
    try {
      writeFileSync(join(p.base, 'cp.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]));
      const r = await mp(p.dir, ['pm', 'say', '--file', join(p.base, 'cp.txt')]);
      assert.equal(r.code, 0);
      assert.equal(recorded(p.dir, r.json.result.words), 'caf� ok');
      const text = await runCli(['pm', 'say', '--file', join(p.base, 'cp.txt'), '--op', 'again-1'], { cwd: p.dir, env: { ...process.env, MP_PROJECT: '', MP_SECRETARY: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } });
      assert.match(text.stdout, /Already recorded as W-1[^\n]*\nWarning: the file .*cp\.txt holds bytes that are not UTF-8; they are shown as U\+FFFD/);
      writeFileSync(join(p.base, 'nobom16.txt'), Buffer.from('words', 'utf16le'));
      const nul = await mp(p.dir, ['pm', 'say', '--file', join(p.base, 'nobom16.txt')]);
      assert.equal(nul.code, 3);
      assert.equal(nul.json.error.code, 'BAD_REQUEST');
      assert.match(nul.json.error.message, /probably UTF-16 without a byte-order mark\. Save it as UTF-8/);
    } finally {
      p.cleanup();
    }
  });

  it('a plan JSON with a byte-order mark is read; config.json with a byte-order mark is read by every reader of it', async () => {
    const p = await project();
    try {
      const w = (await ok(p.dir, ['pm', 'say', 'Please write an add function, with a check that it works. The details are yours to decide.'])).result.words as string;
      await ok(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'an add function', '--words', w]);
      await ok(p.dir, ['pm', 'requirement', 'add', 'm1', 'a1', '--type', 'authorization', '--text', "Details are the PM's", '--quote', 'The details are yours to decide', '--words', w]);
      writeFileSync(join(p.base, 'plan16.json'), Buffer.from(JSON.stringify(addPlan('m1', w)), 'utf16le'));
      const nul = await mp(p.dir, ['pm', 'plan', 'submit', 'm1', '--file', join(p.base, 'plan16.json'), '--words', w]);
      assert.equal(nul.code, 64, 'refused as 4.4.0 refused it (not JSON)');
      assert.match(nul.json.error.message, /cannot read the plan .*\(it holds NUL characters: it is probably UTF-16 without a byte-order mark/);
      writeFileSync(join(p.base, 'plan.json'), Buffer.concat([BOM, Buffer.from(JSON.stringify(addPlan('m1', w), null, 2))]));
      const plan = await ok(p.dir, ['pm', 'plan', 'submit', 'm1', '--file', join(p.base, 'plan.json'), '--words', w]);
      assert.equal(plan.result.plan, 'pmplan.m1.1');
      const cfg = join(p.dir, '.mission-pipeline', 'config.json');
      const json = JSON.parse(readFileSync(cfg, 'utf8'));
      writeFileSync(cfg, Buffer.concat([BOM, Buffer.from(JSON.stringify({ ...json, projectName: 'bom-project', environment: { versionCommands: ['node --version'] } }, null, 2))]));
      assert.equal(readConfig(p.dir).projectName, 'bom-project');
      assert.deepEqual(readEnvironmentConfig(p.dir).versionCommands, ['node --version']);
      const shown = await mp(p.dir, ['config']);
      assert.equal(shown.code, 0, shown.out);
      assert.equal(shown.json.result.projectName, 'bom-project');
      assert.equal((await mp(p.dir, ['read', 'status'])).code, 0);
      // a name saved in the system code page: read with U+FFFD, and mp config says so
      const [head, tail] = JSON.stringify({ ...json, projectName: 'caf\u0001' }).split('\\u0001');
      writeFileSync(cfg, Buffer.concat([Buffer.from(head!), Buffer.from([0xe9]), Buffer.from(tail!)]));
      const warned = await runCli(['config'], { cwd: p.dir, env: { ...process.env, MP_PROJECT: '', MP_SECRETARY: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } });
      assert.equal(warned.exitCode, 0, warned.stderr);
      assert.match(warned.stdout, /config\.json is valid\.\nWarning: \.mission-pipeline\/config\.json holds bytes that are not UTF-8; they are shown as U\+FFFD/);
      assert.equal(readConfig(p.dir).projectName, 'caf�');
    } finally {
      p.cleanup();
    }
  });

  it('a seat hands back on stdin with a byte-order mark; its card shows the PowerShell form of the hand-back', async () => {
    const p = await project();
    try {
      const w = (await ok(p.dir, ['pm', 'say', 'Please write an add function, with a check that it works. The details are yours to decide.'])).result.words as string;
      await ok(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'An add function', '--quote', 'an add function', '--words', w]);
      await ok(p.dir, ['pm', 'requirement', 'add', 'm1', 'a1', '--type', 'authorization', '--text', "Details are the PM's", '--quote', 'The details are yours to decide', '--words', w]);
      writeFileSync(join(p.base, 'plan.json'), JSON.stringify(addPlan('m1', w)));
      await ok(p.dir, ['pm', 'plan', 'submit', 'm1', '--file', join(p.base, 'plan.json'), '--words', w]);
      const step = (await ok(p.dir, ['pm', 'next'])).result.ready[0].step as string;
      const d = (await ok(p.dir, ['pm', 'dispatch', step, '--filled-by', 'test/model'])).result.dispatch as string;
      const card = await runCli(['seat', d, 'card'], { cwd: p.dir, env: { ...process.env, MP_PROJECT: '', MP_SECRETARY: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } });
      assert.ok(card.stdout.includes(`PowerShell: the same document between a line \`@'\` and a line \`'@ | mp.ps1 seat ${d} handback --stdin\` (a here-string, piped).`), card.stdout.slice(-3000));
      for (const [m, page] of materialPages(cardOf(p.dir, d))) await ok(p.dir, ['seat', d, 'read', m, '--page', String(page)]);
      // the file form: a report in the system code page and fields in UTF-16 are read (4.4.0: "not JSON"); fields that do not fit the card are refused, with the reader's warning
      const tmp = join(p.dir, '.mission-pipeline', 'tmp', d);
      writeFileSync(join(tmp, 'report.md'), Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]));
      writeFileSync(join(tmp, 'result.json'), utf16le('{"verdict": "not a verdict"}'));
      const refusedFiles = await mp(p.dir, ['seat', d, 'handback', '--report', join(tmp, 'report.md'), '--result', join(tmp, 'result.json')]);
      assert.equal(refusedFiles.code, 3, refusedFiles.out);
      const problems = refusedFiles.json.result.problems as string[];
      assert.ok(!problems.some((x) => /not JSON/.test(x)), problems.join('\n'));
      assert.ok(problems.some((x) => /^Warning: the report file .*report\.md holds bytes that are not UTF-8/.test(x)), problems.join('\n'));
      const doc = `# Report\r\n\r\nDone.\r\n\r\n\`\`\`json\r\n${JSON.stringify(cal1Pass(cardOf(p.dir, d)))}\r\n\`\`\`\r\n`;
      const r = await ok(p.dir, ['seat', d, 'handback', '--stdin'], Buffer.concat([BOM, Buffer.from(doc)]));
      assert.equal(r.result.kind, 'recorded', JSON.stringify(r.result));
    } finally {
      p.cleanup();
    }
  });
});

describe('C: "occurs verbatim" does not depend on the line ending', () => {
  test('a CRLF and an LF count as the same line break, on both sides; a quote that matched before still matches', () => {
    assert.equal(occursVerbatim('one\r\ntwo three', 'one\ntwo'), true);
    assert.equal(occursVerbatim('one\ntwo three', 'one\r\ntwo'), true);
    assert.equal(occursVerbatim('one\r\ntwo', 'one\r\ntwo'), true);
    assert.equal(occursVerbatim('one\r\ntwo', 'one\r'), true, 'a match of the plain comparison stands');
    assert.equal(occursVerbatim('one two', 'one\ntwo'), false);
    assert.equal(occursVerbatim('one\rtwo', 'one\ntwo'), false, 'a lone CR is not a line break here');
  });

  it('words recorded with CRLF: a tag quote, a requirement quote and a stop typed with LF across the break are accepted; what is recorded is unchanged', async () => {
    const p = await project();
    try {
      const text = 'Export the report as CSV,\r\nwith the column names in Chinese.\r\nStop the old export.';
      const quote = 'as CSV,\nwith the column names';
      const said = await ok(p.dir, ['pm', 'say', '--stdin', '--tag', `requirement@m1:"${quote}"`], Buffer.from(text));
      assert.equal(said.result.words, 'W-1');
      assert.equal(recorded(p.dir, 'W-1'), text);
      const tags = (await ok(p.dir, ['read', 'words', '--mission', 'm1'])).result.words[0].tags;
      assert.equal(tags[0].quote, quote, 'the quote is recorded as given');
      await ok(p.dir, ['pm', 'requirement', 'add', 'm1', 'g1', '--type', 'goal', '--text', 'CSV export', '--quote', 'Chinese.\nStop the old', '--words', 'W-1']);
      await ok(p.dir, ['pm', 'stop', 'Chinese.\nStop the old export.', '--scope', 'mission:m1']);
      const next = await ok(p.dir, ['pm', 'next']);
      assert.equal(next.result.stops[0].wordsEntry, 'W-1', 'the stop rests on the entry that holds its words');
      const refusedQuote = await mp(p.dir, ['pm', 'requirement', 'add', 'm1', 'g2', '--type', 'goal', '--text', 'x', '--quote', 'CSV with', '--words', 'W-1']);
      assert.equal(refusedQuote.code, 3, 'a quote that is not there is still refused');
    } finally {
      p.cleanup();
    }
  });
});
