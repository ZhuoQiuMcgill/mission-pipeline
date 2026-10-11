#!/usr/bin/env node
// `mp`, the Mission Pipeline command line (design 4.1 §9): a small launcher that runs
// src/cli/main.ts with Node's type stripping, on Linux, Windows and macOS. Installed linked to the
// engine folder: `npm install` then `npm install -g .` in it (npm links the folder and makes the
// `mp` shim, a .cmd one on Windows), or run directly: `node <engine>/bin/mp.mjs …`.
// Node 22.12 or later (the built-in node:sqlite).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`mp needs Node 22.12 or later (this is ${process.versions.node})\n`);
  process.exit(78);
}
if (/[\\/]node_modules[\\/]/.test(main)) {
  // Node strips TypeScript types only outside node_modules: mp runs from its own folder (a linked install)
  process.stderr.write(`mp: this copy lies under node_modules (${main}), where Node does not strip types. Install mp linked to its folder: in the engine folder, \`npm install\` then \`npm install -g .\`\n`);
  process.exit(78);
}
if (!existsSync(main)) {
  process.stderr.write(`mp: the engine is incomplete (${main} is missing)\n`);
  process.exit(78);
}
const flags = [];
// type stripping is on by default from Node 23.6 / 22.18; earlier versions need the flag
if (!process.features.typescript) flags.push('--experimental-strip-types');
if (major === 22 && minor < 13) flags.push('--experimental-sqlite');
flags.push('--disable-warning=ExperimentalWarning');
const r = spawnSync(process.execPath, [...flags, main, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });
if (r.error !== undefined) {
  process.stderr.write(`mp: cannot start Node: ${r.error.message}\n`);
  process.exit(1);
}
process.exit(r.status ?? 1);
