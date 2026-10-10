// The PM's work-instruction handbook as the plugin ships it (design 3.11; maintainer ruling
// 2026-10-09): an INDEX with one line per WI, and one page per WI with its trigger and
// evidence, default action, options with their `mp` commands and outcomes, how to choose and
// when to ask the user. Every WI a program notice can name has a page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WI_CATALOG } from '../src/common/records.ts';
import { REFUSAL_WI } from '../src/ledger/errors.ts';
import { pmCoreText, wiDir, wiPagePath, wiRef, wiTitle } from '../src/cli/wi.ts';
import { COMMANDS } from '../src/cli/main.ts';

const dir = wiDir({});

test('the index has one line per WI in the catalog, and no page detail', () => {
  const idx = readFileSync(join(dir, 'INDEX.md'), 'utf8');
  const lines = idx.split('\n').filter((l) => /^- WI-\d\d: /.test(l));
  assert.deepEqual(lines.map((l) => l.slice(2, 7)), [...WI_CATALOG].sort());
  assert.doesNotMatch(idx, /## /, 'sections belong to the pages');
  assert.ok(idx.length < 4_000, `the index stays short (${idx.length} chars)`);
});

test('every WI has a page with the five parts; every mp command a page names exists', () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  const pages = readdirSync(dir).filter((f) => /^WI-\d\d\.md$/.test(f));
  assert.equal(pages.length, WI_CATALOG.size);
  for (const wi of WI_CATALOG) {
    const page = readFileSync(wiPagePath(wi, {})!, 'utf8');
    for (const h of ['## Trigger and evidence', '## Default action already taken', '## Options and outcomes', '## How to choose', '## When to ask the user']) assert.ok(page.includes(h), `${wi}: ${h}`);
    assert.ok(page.startsWith(`# ${wi} `), wi);
    assert.ok(wiTitle(wi, {}) !== null);
    for (const m of page.matchAll(/`mp ([a-z-]+)/g)) assert.ok(names.has(m[1]!), `${wi} names mp ${m[1]}, which does not exist`);
  }
});

test('every WI the ledger maps a refusal to has a page; a reference names the page', () => {
  for (const wi of Object.values(REFUSAL_WI)) if (wi !== null) assert.ok(WI_CATALOG.has(wi), wi);
  assert.match(wiRef('WI-06', {})!, /^WI-06 A landing did not complete.* \(WI page: .*WI-06\.md\)$/);
  assert.equal(wiRef('WI-99', {}), null);
  assert.equal(wiRef(null, {}), null);
});

test('PM.md: the PM one-page definition, at most two pages, with a core for the standing context; the 4.0 plugin manifest', () => {
  const file = join(dir, '..', 'PM.md');
  const t = readFileSync(file, 'utf8');
  assert.ok(t.split('\n').length <= 120 && t.length <= 7_000, `PM.md stays within two pages (${t.split('\n').length} lines, ${t.length} chars)`);
  const core = pmCoreText({});
  assert.match(core, /Read only the WI index/);
  assert.match(core, /"deliver" \(交付\), that is consent to land/);
  assert.ok(core.length < t.length / 2, 'the core is the short part');
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const m of t.matchAll(/`mp ([a-z-]+)/g)) assert.ok(names.has(m[1]!) || m[1] === 'help', `PM.md names mp ${m[1]}, which does not exist`);
  const manifest = JSON.parse(readFileSync(join(dir, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string };
  assert.deepEqual([manifest.name, manifest.version], ['mission-pipeline', '4.0.0']);
  assert.ok(readdirSync(join(dir, '..', '..', 'bin')).includes('mp'), 'bin/ is on the Bash tool\'s PATH while the plugin is enabled');
});
