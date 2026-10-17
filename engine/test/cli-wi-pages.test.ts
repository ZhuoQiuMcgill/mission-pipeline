// The PM's handbook and work instructions as 4.1 ships them (design 4.1 §6.9; U-8): an INDEX with
// one line per WI, one page per WI with its trigger and evidence, default action, options with
// their `mp` commands and outcomes, how to choose and when to ask the user. Every `mp` command a
// page, the handbook or a role description names exists; every WI the program can name has a
// page, and the CLI never names a page that does not exist.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WI_CATALOG } from '../src/common/records.ts';
import { REFUSAL_WI } from '../src/memory/index.ts';
import { WI as FLOW_WI } from '../src/flow/wi.ts';
import { COMMANDS } from '../src/cli/main.ts';
import { toCliError, wi41 } from '../src/cli/errors.ts';
import { INSTALLED_PM_DIR, WI_41, isWi, pmCoreText, wiDir, wiPagePath, wiRef, wiTitle } from '../src/cli/wi.ts';

const dir = wiDir(null);
const PLUGIN = join(INSTALLED_PM_DIR, '..');

/** Every `mp …` command line named in a text, as [group, name] (admin commands: ['admin', name]). */
function named(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of text.matchAll(/`mp ((?:pm|read) [a-z-]+|seat <[a-z]+>(?: [a-z-]+)?|[a-z-]+)/g)) {
    const words = m[1]!.split(' ');
    if (words[0] === 'pm' || words[0] === 'read') {
      // "every `mp pm` command": the group itself
      if (words[1] !== undefined) out.push([words[0], words[1]]);
    }
    else if (words[0] === 'seat') {
      // "the `mp seat <id>` commands": the group itself
      if (words[2] !== undefined) out.push(['seat', words[2]]);
    }
    else out.push(['admin', words[0]!]);
  }
  return out;
}

function exists([group, name]: [string, string]): boolean {
  if (group === 'admin' && name === 'help') return true;
  return COMMANDS.some((c) => c.group === group && c.name[0] === name);
}

test('the 4.1 set: the catalog, the CLI and the index agree (01-08, 13, 16, 19-21, 23-26, 28-34)', () => {
  assert.deepEqual([...WI_CATALOG].sort(), [...WI_41].sort());
  assert.equal(WI_41.length, 24);
  const idx = readFileSync(join(dir, 'INDEX.md'), 'utf8');
  const lines = idx.split('\n').filter((l) => /^- WI-\d\d: /.test(l));
  assert.deepEqual(lines.map((l) => l.slice(2, 7)), [...WI_41]);
  assert.doesNotMatch(idx, /## /, 'sections belong to the pages');
  assert.ok(idx.length < 4_000, `the index stays short (${idx.length} chars)`);
  assert.equal(isWi('WI-15'), false);
  assert.equal(isWi('WI-29'), true);
});

test('every WI has a page with the five parts, and every mp command a page names exists', () => {
  const pages = readdirSync(dir).filter((f) => /^WI-\d\d\.md$/.test(f));
  assert.deepEqual(pages.map((f) => f.slice(0, 5)).sort(), [...WI_41].sort());
  for (const wi of WI_41) {
    const page = readFileSync(wiPagePath(wi, null)!, 'utf8');
    for (const h of ['## Trigger and evidence', '## Default action already taken', '## Options and outcomes', '## How to choose', '## When to ask the user']) assert.ok(page.includes(h), `${wi}: ${h}`);
    assert.ok(page.startsWith(`# ${wi} `), wi);
    assert.ok(wiTitle(wi, null) !== null);
    for (const n of named(page)) assert.ok(exists(n), `${wi} names mp ${n.join(' ')}, which does not exist`);
    assert.doesNotMatch(page, /sandbox|systemd|watchdog|self-check|spend limit|metering/i, `${wi} names a removed 4.0 part`);
  }
});

test('the handbook and the role descriptions name only commands that exist', () => {
  const pm = readFileSync(join(INSTALLED_PM_DIR, 'PM.md'), 'utf8');
  for (const n of named(pm)) assert.ok(exists(n), `PM.md names mp ${n.join(' ')}`);
  assert.match(pm, /mp pm session --filled-by/, 'the handbook starts a session (decision 8)');
  const core = pmCoreText(null);
  assert.match(core, /mp pm say/);
  assert.match(core, /consent to land/);
  assert.ok(core.length < pm.length / 2, 'the core is the short part');
  for (const f of readdirSync(join(PLUGIN, 'roles'))) {
    const t = readFileSync(join(PLUGIN, 'roles', f), 'utf8');
    for (const n of named(t)) assert.ok(exists(n), `roles/${f} names mp ${n.join(' ')}`);
  }
});

test('every WI the program can name is a 4.1 page: the flows and the memory\'s refusals directly, the process actions through the CLI', () => {
  for (const wi of Object.values(FLOW_WI)) assert.ok(isWi(wi), `the flows name ${wi}`);
  for (const [code, wi] of Object.entries(REFUSAL_WI)) {
    assert.ok(wi === null || isWi(wi), `${code} names ${wi}`);
    assert.equal(toCliError(Object.assign(new Error(`${code}: x`), { name: 'LedgerError', code, wi })).wi, wi, `${code} keeps its WI through the CLI`);
  }
  assert.equal(toCliError(Object.assign(new Error('CHAIN_BROKEN: x'), { name: 'LedgerError', code: 'CHAIN_BROKEN', wi: REFUSAL_WI.CHAIN_BROKEN })).wi, 'WI-29');
  assert.equal(toCliError(Object.assign(new Error('GIT_WRITES_HELD: x'), { name: 'LedgerError', code: 'GIT_WRITES_HELD', wi: REFUSAL_WI.GIT_WRITES_HELD })).wi, 'WI-31');
  assert.equal(toCliError(Object.assign(new Error('LEAF_MISSING: x'), { name: 'ProcessError', code: 'LEAF_MISSING', wi: 'WI-30' })).wi, 'WI-30');
  assert.equal(toCliError(Object.assign(new Error('the objects are missing'), { code: 'missing-objects' })).wi, 'WI-13', 'a process action error');
  assert.equal(toCliError(Object.assign(new Error('BUSY: x'), { name: 'LedgerError', code: 'BUSY', wi: null })).exitCode, 75);
  assert.equal(wi41('WI-15'), null, 'a retired number is never shown');
  assert.equal(wi41('WI-28'), 'WI-28');
  assert.match(wiRef('WI-06', null)!, /^WI-06 A landing did not complete.* \(page: .*WI-06\.md\)$/);
  assert.equal(wiRef('WI-99', null), null);
});

test('the Claude Code plugin is an optional adapter of 4.1', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string; description: string };
  assert.deepEqual([manifest.name, manifest.version], ['mission-pipeline', '4.1.2']);
  assert.match(manifest.description, /Optional/i);
  const hooks = readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8');
  assert.match(hooks, /claude-code\.mjs/);
  assert.doesNotMatch(hooks, /mp-hook|engine4|ensure-running/);
});
