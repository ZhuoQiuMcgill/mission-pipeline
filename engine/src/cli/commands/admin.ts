// The project's own commands (design 4.1 §3.1, §4.1, §9): `mp init`, `mp config`, `mp recompute`,
// `mp docs update`.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { recompute } from '../../evaluator/index.ts';
import { flagBool, flagStr, positional } from '../args.ts';
import { ok, type Command, type RunContext } from '../command.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import { configPath, fullSuiteSource, parseConfig, readConfig } from '../config.ts';
import { fullSuiteOf } from '../../common/fullSuite.ts';
import { copyDocs, mpInit, mpVersion, type PointerTarget } from '../init.ts';
import type { Project } from '../project.ts';
import { section } from '../render.ts';
import { wiText } from '../render.ts';

function P(c: RunContext): Project {
  if (c.project === null) throw new CliError('NOT_INITIALIZED', 'no project', { exitCode: EXIT.NO_PROJECT });
  return c.project;
}

const init: Command = {
  group: 'admin',
  name: ['init'],
  summary: 'create .mission-pipeline/ in this project: the memory, the role descriptions and PM handbook, config.json, the git exclude',
  usage: 'mp init [--pointer claude|agents|both|none] [--target-branch <branch>]   (in the project folder, or with --project <dir>)',
  flags: { pointer: 'string', 'target-branch': 'string' },
  noProject: true,
  async run(c, args) {
    const dir = resolve(c.io.cwd, flagStr(args, 'project') ?? '.');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`${dir} is not a folder`);
    const pointer = (flagStr(args, 'pointer') ?? 'none') as PointerTarget;
    if (!['claude', 'agents', 'both', 'none'].includes(pointer)) throw usage('--pointer is claude, agents, both or none');
    const r = mpInit(dir, { pointer, targetBranch: flagStr(args, 'target-branch'), ...(c.io.process?.git !== undefined ? { git: c.io.process.git } : {}) });
    const warn = r.memory.layout.warnings;
    const lines = [
      `${r.memory.created ? 'Created' : 'Already present'}: ${r.memory.root} (mp ${r.docs.version}).`,
      `Git exclude: ${r.memory.exclude === 'added' ? '.mission-pipeline/ added to .git/info/exclude' : r.memory.exclude === 'present' ? 'already excludes .mission-pipeline/' : 'no git repository here'}.`,
      `Role descriptions and PM handbook: ${r.docs.copied.length} copied${r.docs.kept.length > 0 ? `, ${r.docs.kept.length} kept (mp docs update refreshes them)` : ''}.`,
      r.config === 'written' ? `config.json written (target branch ${r.targetBranch}); review it, then mp config.` : 'config.json kept.',
      ...r.pointer.map((x) => `${x.file}: pointer line ${x.state}.`),
      ...(warn.length > 0 ? ['Warnings (it still initialized; nothing in the repository was changed):', ...warn.map((w) => `  ! ${w}`), `  ${wiText('WI-31', dir)}`] : []),
      '',
      'Next: have your harness act as the PM: it reads .mission-pipeline/pm/PM.md, runs mp pm session --filled-by "<harness>/<model>", then mp pm next.',
    ];
    return ok(lines.join('\n'), r);
  },
};

const config: Command = {
  group: 'admin',
  name: ['config'],
  summary: 'validate and show .mission-pipeline/config.json',
  usage: 'mp config',
  flags: {},
  async run(c) {
    const p = P(c);
    const file = configPath(p.dir);
    if (!existsSync(file)) return ok('No config.json: the defaults are used (target branch main, no full suite, no version commands). mp init writes one.', readConfig(p.dir));
    const cfg = parseConfig(JSON.parse(readFileSync(file, 'utf8')));
    const src = fullSuiteSource(cfg);
    const suite = fullSuiteOf(cfg);
    const lines = [
      `.mission-pipeline/config.json is valid.`,
      ...(src.both ? ['Warning: both fullSuite and the deprecated closingChecks are present; fullSuite is used and closingChecks is ignored (remove it).'] : []),
      `Target branch: ${cfg.targetBranch}`,
      ...section('Local tests: verificationCommands (the Architect may assign them to tasks)', cfg.verificationCommands.map((x) => `${x.id}: ${typeof x.command === 'string' ? x.command : x.command.join(' ')}`), 'none'),
      ...section(
        `Full suite (integration Reviewer full-run, mp pm full-run, mp pm deliver), read from ${src.key === 'fullSuite' ? 'fullSuite' : src.key === 'closingChecks' ? 'closingChecks (deprecated alias: rename it to fullSuite)' : 'neither key'}`,
        suite.map((x) => `${x.id}: ${typeof x.command === 'string' ? x.command : x.command.join(' ')}${x.cwd !== undefined ? ` (in ${x.cwd})` : ''}`),
        'none',
      ),
      ...section('Environment identity: version commands', cfg.environment.versionCommands, 'none (operating system and architecture only)'),
      ...section('Exclusive resources', cfg.exclusiveResources, 'none'),
      ...section('Filler hints', Object.entries(cfg.fillers).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`), 'none'),
      `Command timeout: ${Math.round(cfg.commandTimeoutMs / 1000)} s`,
    ];
    return ok(lines.join('\n'), { ...cfg, fullSuiteReadFrom: src.key, fullSuiteKeysBoth: src.both });
  },
};

const recomputeCmd: Command = {
  group: 'admin',
  name: ['recompute'],
  summary: 'rebuild the stored labels from the base records (WI-20: labels that look wrong); --state also rebuilds every state table from the event log',
  usage: 'mp recompute [--state]',
  flags: { state: 'boolean' },
  async run(c, args) {
    const p = P(c);
    const rb = flagBool(args, 'state') ? p.ctx.memory.rebuild() : null;
    const r = recompute(p.ctx.memory);
    return ok(`${rb !== null ? `State tables rebuilt from ${rb.events} events (${rb.tables} tables). ` : ''}Labels recomputed from ${r.events} events, as of event ${r.revision}.`, { rebuild: rb, labels: r });
  },
};

const docs: Command = {
  group: 'admin',
  name: ['docs'],
  summary: 'refresh the role descriptions and the PM handbook in .mission-pipeline/ from the installed mp',
  usage: 'mp docs update',
  flags: {},
  async run(c, args) {
    const p = P(c);
    if (positional(args, 0, 'update') !== 'update') throw usage('docs takes update');
    const r = copyDocs(p.dir, { refresh: true });
    const lines = [`Documents of mp ${r.version}: ${r.copied.length} added, ${r.updated.length} updated, ${r.kept.length} unchanged, ${r.removed.length} removed.`, ...section('Changed', [...r.copied, ...r.updated, ...r.removed.map((x) => `${x} (removed)`)])];
    return ok(lines.join('\n'), r);
  },
};

export const ADMIN_COMMANDS: readonly Command[] = [init, config, recomputeCmd, docs];
export { mpVersion };
