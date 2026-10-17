// `mp seat <dispatch> …`: a dispatched seat's commands (design 4.1 §5.2, §5.3; decisions 6, 7,
// 10, 11, 13, 14). The card lists exactly the ones its role gets; the process refuses the rest.
// File arguments may be relative to the seat's working directory or to the project folder.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseFiller, seatCard, seatCheckout, seatFullRun, seatHandback, seatRead, seatRequestEvidence, seatRerun, type FullRunMarker, type HandBackAnswer } from '../../process/index.ts';
import { flagBool, flagStr, positional, type ParsedArgs } from '../args.ts';
import { ok, type Command, type CommandResult, type RunContext } from '../command.ts';
import { CliError, EXIT, refused, usage } from '../errors.ts';
import type { Project } from '../project.ts';

function P(c: RunContext): Project {
  if (c.project === null) throw new CliError('NOT_INITIALIZED', 'no project', { exitCode: EXIT.NO_PROJECT });
  return c.project;
}

/** The dispatch id is the word after `seat` (main.ts puts it first). */
function dispatchOf(args: ParsedArgs): string {
  return positional(args, 0, 'dispatch id');
}

/** A file named relative to the seat's working directory when it exists there; else as given (relative to the project). */
function fileArg(c: RunContext, f: string): string {
  if (isAbsolute(f)) return f;
  const here = resolve(c.io.cwd, f);
  return existsSync(here) ? here : f;
}

function answerResult(a: HandBackAnswer, p?: Project): CommandResult {
  if (a.kind === 'refused') {
    return ok([`Hand-back of ${a.dispatch} refused (it does not count; fix these and run the same command again):`, ...a.problems.map((x) => `- ${x}`)].join('\n'), a, EXIT.REFUSED);
  }
  // a Constructor's worktree is removed after its hand-back: a shell that sat in it fails its next command (4.1.2)
  const removed = a.candidate !== null && p !== undefined && !existsSync(join(p.ctx.memory.paths.worktrees, a.dispatch));
  const gone = removed ? '; your worktree has been removed — if your shell was inside it, the next command\'s error is expected' : '';
  const lines = [
    a.repeated ? `Hand-back of ${a.dispatch} was already recorded: nothing new${gone}.` : a.outcome === 'accepted' ? `Hand-back of ${a.dispatch} recorded${gone}.` : `Hand-back of ${a.dispatch} recorded but not accepted (${a.outcome === 'after-release' ? 'the dispatch was released before it arrived' : 'a stop covers it'})${gone}.`,
    ...(a.report !== null ? [`Report: .mission-pipeline/${a.report}`] : []),
    ...(a.candidate !== null ? [`Candidate commit ${a.candidate.commit} on base ${a.candidate.base}: ${a.candidate.changedPaths.join(', ') || 'no changes'}`] : []),
    ...(a.candidate !== null && a.candidate.ignored.length > 0 ? [`Ignored files inside your write paths were not collected: ${a.candidate.ignored.join(', ')}${a.candidate.ignoredTotal > a.candidate.ignored.length ? ` (and ${a.candidate.ignoredTotal - a.candidate.ignored.length} more)` : ''}`] : []),
    ...(a.verification !== null ? a.verification.map((v) => `Verification ${v.evidence}: ${v.passed ? 'passed' : 'failed'} — ${v.summary}`) : []),
    ...a.notes,
    'You are done: end here.',
  ];
  return ok(lines.join('\n'), a);
}

const card: Command = {
  group: 'seat',
  name: ['card'],
  summary: 'your card: your role, this task, your commands and the hand-back format',
  usage: 'mp seat <dispatch> card',
  flags: {},
  async run(c, args) {
    const r = seatCard(P(c).ctx, dispatchOf(args));
    return ok(r.text, r);
  },
};

const read: Command = {
  group: 'seat',
  name: ['read'],
  summary: 'one page of a material on your card (hash-checked; a missing or edited material is reported, never served)',
  usage: 'mp seat <dispatch> read <material> [--page <n>]',
  flags: { page: 'string' },
  async run(c, args) {
    const page = flagStr(args, 'page');
    const n = page === null ? 1 : Number(page);
    if (!Number.isSafeInteger(n) || n < 1) throw usage('--page is a page number, from 1');
    const r = seatRead(P(c).ctx, dispatchOf(args), positional(args, 1, 'material'), n);
    return ok(r.text, r);
  },
};

const checkout: Command = {
  group: 'seat',
  name: ['checkout'],
  summary: 'print the path of a read-only directory holding the commit your card names (shared with the other seats reading that commit; read there, never write)',
  usage: 'mp seat <dispatch> checkout',
  flags: {},
  async run(c, args) {
    const r = await seatCheckout(P(c).ctx, dispatchOf(args));
    const note =
      r.commit !== null
        ? `\n(commit ${r.commit}: a read-only file snapshot without git metadata, shared with the other seats reading this commit; do not write there. git commands there reach the project's repository, so use the commit: git -C ${P(c).dir} show ${r.commit}, or git -C ${P(c).dir} diff ${r.commit}^ ${r.commit} for a candidate's change)`
        : '';
    return ok(`${r.path}${note}`, r);
  },
};

const rerun: Command = {
  group: 'seat',
  name: ['rerun'],
  summary: 'mp runs a declared command of your card on a clean checkout: a new run id every time, which you may cite',
  usage: 'mp seat <dispatch> rerun <command-id>',
  flags: {},
  decides: true,
  async run(c, args) {
    const r = await seatRerun(P(c).ctx, dispatchOf(args), positional(args, 1, 'command id (on your card)'));
    return ok(`Run ${r.run}: ${r.passed ? 'passed' : 'failed'} — ${r.summary}${r.leaf !== null ? `\nSummary: .mission-pipeline/${r.leaf}` : ''}\nCite it as your card says: evidence:${r.run} (a judgment) or run:${r.run} (a blind experiment).`, r, 0);
  },
};

/** A full-run marker as lines for people (the seat's full-run answer, `mp read full-runs`). */
export function fullRunLines(m: FullRunMarker): string[] {
  const head = `Full run ${m.id}: ${m.passed ? 'passed' : 'FAILED'} on commit ${m.commit} (tree ${m.tree.slice(0, 12)}), environment ${m.environment.slice(0, 12)}, by ${m.by === 'pm' ? 'the PM' : `the Reviewer ${m.cites.dispatch ?? ''}`.trim()}${m.reusedFrom !== null ? `; reuses the passing full run ${m.reusedFrom} on the same tree (nothing ran)` : ''}`;
  return [
    head,
    ...m.commands.map((c) => `  [${c.id}] ${c.command}${c.cwd !== '.' ? ` (in ${c.cwd})` : ''}: ${c.passed ? 'passed' : 'failed'} (exit ${c.exit}) — evidence:${c.evidence}${c.executed ? '' : ' (reused)'}${c.setupFailure !== undefined ? ` — ${c.setupFailure}` : ''}`),
    ...(m.cites.words !== null || m.cites.authority !== null ? [`  decided by: ${m.cites.words !== null ? `the user's words ${m.cites.words}` : `authorization ${m.cites.authority}`}${m.cites.reason !== null ? `; reason: ${m.cites.reason}` : ''}`] : []),
    ...(m.leaf !== null ? [`  summary: .mission-pipeline/${m.leaf}`] : []),
  ];
}

const fullRun: Command = {
  group: 'seat',
  name: ['full-run'],
  summary: "an integration task's Reviewer: mp runs the project's full suite on a clean checkout of your candidate (last, once nothing visible is wrong); a passing run on the same tree is reused",
  usage: 'mp seat <dispatch> full-run',
  flags: {},
  decides: true,
  async run(c, args) {
    const d = dispatchOf(args);
    const r = await seatFullRun(P(c).ctx, d);
    const m = r.marker;
    const lines = [
      ...fullRunLines(m),
      ...m.failing.flatMap((f) => [`--- last lines of ${f.id}:`, f.tail]),
      m.passed
        ? `Cite its runs in your judgments as evidence:<id> (${m.commands.map((x) => `evidence:${x.evidence}`).join(', ')}).`
        : 'It failed: trace the failure to the task whose change caused it (the last lines above; the run summary), name that task in your findings and hand back "needs-decision": the fix belongs to that task, not to this integration task.',
    ];
    return ok(lines.join('\n'), r, 0);
  },
};

/**
 * The no-file form (a harness whose sub-agents may not write files): one document on stdin, the
 * Markdown report with the structured fields as its LAST fenced ```json block (or given with
 * `--result-json`). `mp` writes the two files into `.mission-pipeline/tmp/<dispatch>/` and goes on
 * exactly as the file form does.
 */
export function splitStdinDocument(doc: string, json: string | null): { readonly report: string; readonly json: string } | null {
  if (json !== null) return { report: doc, json };
  const blocks = [...doc.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  const last = blocks.at(-1);
  if (last === undefined) return null;
  const at = last.index ?? 0;
  const report = `${doc.slice(0, at)}${doc.slice(at + last[0].length)}`.trim();
  return { report: report === '' ? doc : `${report}\n`, json: last[1]! };
}

function stdinFiles(c: RunContext, dispatch: string, args: ParsedArgs, names: { readonly doc: string; readonly json: string; readonly jsonFlag: string }): { readonly doc: string; readonly json: string } {
  if (c.io.stdin === undefined) throw usage('--stdin: no standard input');
  const text = c.io.stdin();
  if (text.trim() === '') throw usage('--stdin: the standard input is empty (your report, with the fields as its last ```json block)');
  const split = splitStdinDocument(text, flagStr(args, names.jsonFlag));
  if (split === null) throw refused('NO_JSON_BLOCK', `the document on stdin has no fenced \`\`\`json block: end it with the structured fields in one (the schema is on your card), or give them with --${names.jsonFlag} '<json>'`);
  const dir = join(P(c).ctx.memory.paths.tmp, dispatch);
  mkdirSync(dir, { recursive: true });
  const doc = join(dir, names.doc);
  const json = join(dir, names.json);
  writeFileSync(doc, split.report);
  writeFileSync(json, split.json);
  return { doc, json };
}

const handback: Command = {
  group: 'seat',
  name: ['handback'],
  summary: 'hand back once: your report (Markdown) with your structured fields (JSON) on stdin, or as two files in .mission-pipeline/tmp/<dispatch>/',
  usage: "mp seat <dispatch> handback --stdin [--result-json '<json>']   (the report on stdin; the fields as its LAST ```json block, or --result-json)\n       mp seat <dispatch> handback --report <report.md> --result <result.json>   [--filled-by \"<harness>/<model>\"]",
  flags: { report: 'string', result: 'string', stdin: 'boolean', 'result-json': 'string', 'filled-by': 'string' },
  decides: true,
  async run(c, args) {
    const d = dispatchOf(args);
    const f = flagStr(args, 'filled-by');
    let report = flagStr(args, 'report');
    let result = flagStr(args, 'result');
    if (flagBool(args, 'stdin')) {
      if (report !== null || result !== null) throw usage('--stdin or --report/--result, not both');
      const files = stdinFiles(c, d, args, { doc: 'report.md', json: 'result.json', jsonFlag: 'result-json' });
      report = files.doc;
      result = files.json;
    } else if (flagStr(args, 'result-json') !== null) throw usage('--result-json goes with --stdin');
    if (report === null || result === null) throw usage("--stdin (your report on stdin, the fields as its last ```json block), or --report <file.md> --result <file.json>");
    const a = await seatHandback(P(c).ctx, d, { report: fileArg(c, report), result: fileArg(c, result), ...(f !== null ? { filler: parseFiller(f) } : {}) });
    return answerResult(a, P(c));
  },
};

const requestEvidence: Command = {
  group: 'seat',
  name: ['request-evidence'],
  summary: 'ask for an evidence execution; it ends this dispatch with your notes (a new card brings them back with the results)',
  usage: "mp seat <dispatch> request-evidence --stdin [--request-json '<json>']   (your notes on stdin; the request as their LAST ```json block, or --request-json)\n       mp seat <dispatch> request-evidence --request <request.json> --notes <notes.md>   [--filled-by \"<harness>/<model>\"]",
  flags: { request: 'string', notes: 'string', stdin: 'boolean', 'request-json': 'string', 'filled-by': 'string' },
  async run(c, args) {
    const d = dispatchOf(args);
    const f = flagStr(args, 'filled-by');
    let request = flagStr(args, 'request');
    let notes = flagStr(args, 'notes');
    if (flagBool(args, 'stdin')) {
      if (request !== null || notes !== null) throw usage('--stdin or --request/--notes, not both');
      const files = stdinFiles(c, d, args, { doc: 'notes.md', json: 'request.json', jsonFlag: 'request-json' });
      notes = files.doc;
      request = files.json;
    } else if (flagStr(args, 'request-json') !== null) throw usage('--request-json goes with --stdin');
    if (request === null || notes === null) throw usage("--stdin (your notes on stdin, the request as their last ```json block), or --request <file.json> --notes <file.md>");
    const a = await seatRequestEvidence(P(c).ctx, d, { request: fileArg(c, request), notes: fileArg(c, notes), ...(f !== null ? { filler: parseFiller(f) } : {}) });
    return answerResult(a);
  },
};

export const SEAT_COMMANDS: readonly Command[] = [card, read, checkout, rerun, fullRun, handback, requestEvidence];
