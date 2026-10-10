// The seat's tools (design 7.1, 9.3): an in-process SDK MCP server whose tools are the
// program tools of src/exec/tools.ts (all executed in the tool sandbox), the material and web
// tools the host serves itself, and the typed hand-back. The seat has no built-in Claude Code
// tool at all (tools: []). Any card kind of the registry (src/seat/cards/registry.ts) gets the
// tools of its profile (seat/profiles.ts seatToolNames):
//
//   materials      read_material                                        (Calibrator, Secretary)
//   read           read_file, list_directory, search_content           (Architect, interpreter)
//   read-rerun     read + rerun_declared_command (the card's commands)  (Reviewer, Auditor)
//   read-evidence  read + request_evidence (6.2 async evidence)         (Crititor, author)
//   read-web       read + fetch_url (the card's allowed addresses)      (reading investigation)
//   write          read + write_file, edit_file, run_command            (Constructor, experiment)
//   every profile: submit_result (the kind's resultShape); read_material when the card lists
//   materials; request_evidence when the card allows async evidence.
//
// The hand-back is checked by the program before it is accepted: the card's must-read list
// (every page of every must-read material read through read_material), then the kind's own
// rules (handBackProblems: the result's shape, then the entry's problems). Refusals go back to
// the seat, which fixes them and calls again.
//
// One serialized entry (code review r1 finding 6; 6.2 "交回之后这一回合结束"): every tool call
// of the seat runs through one queue, one at a time, so nothing is in flight while a hand-back
// is decided. The hand-back marks the round closed BEFORE it awaits the persistence of the
// result, so exactly one hand-back can win: a second submit_result, a request_evidence after a
// submit (or the other way round), and any tool call queued behind it all find the round closed
// and are refused; whichever reached the queue first wins. If the result cannot be recorded,
// the round is reopened (nothing else ran meanwhile) and the seat is told to call again.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SerialQueue } from '../exec/holder.ts';
import type { RunValue, ToolResult } from '../exec/tools.ts';
import { ProgramTools } from '../exec/tools.ts';
import { handBackProblems, seatCardEntry } from './cards/index.ts';
import { hostCardView, pageKey, seatToolNames, unreadLine } from './profiles.ts';
import type { HandBack, ResultContext } from './results.ts';

export const SEAT_MCP_SERVER = 'program';

export interface EvidenceRequest {
  readonly steps: readonly string[];
  readonly data: string;
  readonly measure: readonly string[];
  readonly assertions: readonly string[];
}

export interface SeatToolHooks {
  /** Stores an accepted result; returns the acknowledgement shown to the seat. Throwing reopens the round. */
  onSubmit(result: HandBack): Promise<string>;
  /** 6.2: accepts (the state saved within the recovery cap) or refuses an async evidence request. */
  onEvidenceRequest?(req: EvidenceRequest): Promise<{ readonly accepted: boolean; readonly message: string }>;
  /** read_material (cards with materials): one page, or why not (seat/profiles.ts MaterialShelf). */
  readMaterial?(material: string, page: number): { readonly ok: true; readonly key: string; readonly text: string } | { readonly ok: false; readonly message: string };
  /** fetch_url ('read-web' cards): the program fetches an allowed address outside the sandbox. */
  fetchUrl?(url: string, offset: number): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** Every tool call's output, for the unit's capped tool-output log (7.1). */
  log(toolName: string, text: string): void;
  /** What evidence pointers are checked against (8.1: the candidate snapshot). */
  readonly context: ResultContext;
  /**
   * Why the unit can take no more calls at all, or null (code review r2 finding 5: a run's
   * processes outlived it): every tool call, hand-back and evidence request is then refused.
   */
  blocked?(): string | null;
}

export type CallToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function fromResult<T>(r: ToolResult<T>, render: (v: T) => string): CallToolResult {
  return r.ok ? text(render(r.value)) : text(`error ${r.error.code}: ${r.error.message}`, true);
}

function renderRun(v: RunValue): string {
  const exit = v.exit.signal !== null ? `killed by ${v.exit.signal}` : `exit code ${v.exit.code}`;
  const note: Record<string, string> = {
    completed: '',
    'resource-exceeded': 'The run went over its declared memory peak and was ended as a whole: resource exceeded. Its output is not evidence.\n',
    'environment-failure': 'The run was ended by a memory shortage outside it (environment failure, not your fault).\n',
    'timed-out': 'The run exceeded its time limit and was ended.\n',
  };
  return `${note[v.status] ?? ''}status: ${v.status}; ${exit}; ${v.durationMs} ms\n--- stdout\n${v.stdout.text}\n--- stderr\n${v.stderr.text}`;
}

const SUBMIT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  constructor: 'Hand back your four completion notes. Call once, when done; then end your turn.',
  reviewer: 'Hand back your judgments and one verdict. Call once, when done; then end your turn.',
};
const SUBMIT_DEFAULT = 'Hand back your result (the fields below, as your card and definition describe them). Call once, when done; then end your turn.';

/**
 * The seat's MCP server for a card of any registered kind. `tools` runs the file tools in the
 * sandbox; null for a profile without file tools ('materials').
 */
export function buildSeatServer(card: { readonly seat: string }, tools: ProgramTools | null, hooks: SeatToolHooks) {
  const entry = seatCardEntry(card.seat);
  const view = hostCardView(card);
  const wanted = seatToolNames(entry.toolProfile, view).filter((n) => n !== 'request_evidence' || hooks.onEvidenceRequest !== undefined);
  const has = (n: string): boolean => wanted.includes(n);
  const fileTools = ['read_file', 'list_directory', 'search_content', 'write_file', 'edit_file', 'run_command', 'rerun_declared_command'].filter(has);
  if (fileTools.length > 0 && tools === null) throw new Error(`the ${card.seat} card's tools (${fileTools.join(', ')}) need a tool sandbox`);
  if (has('read_material') && hooks.readMaterial === undefined) throw new Error(`the ${card.seat} card lists materials but the host serves no read_material`);
  if (has('fetch_url') && hooks.fetchUrl === undefined) throw new Error(`the ${card.seat} card's profile has fetch_url but the host serves none`);
  const sandboxTools = tools as ProgramTools;
  const materials = view.materials ?? [];
  const declared = view.declaredCommands ?? [];
  /** Pages read through read_material in this round (`${material}#${page}`). */
  const read = new Set<string>();

  let closed: string | null = null;
  const queue = new SerialQueue();
  const guard = (name: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> =>
    queue.run(async () => {
      const blocked = hooks.blocked?.() ?? null;
      if (blocked !== null) {
        const r = text(`The unit is blocked (${blocked}). Nothing more can run or be handed back; end your turn now.`, true);
        hooks.log(name, r.content[0]?.text ?? '');
        return r;
      }
      if (closed !== null) {
        const r = text(`This round is over (${closed}). End your turn now without further tool calls.`, true);
        hooks.log(name, r.content[0]?.text ?? '');
        return r;
      }
      const r = await fn();
      hooks.log(name, r.content.map((c) => c.text).join('\n'));
      return r;
    });

  // the definitions, by name; the profile picks (and orders) them
  const defs: Record<string, () => unknown> = {
    read_file: () =>
      tool(
        'read_file',
        'Read a file of the snapshot (path relative to its root). Long files are cut at the output cap; use offset (bytes) to read further.',
        { path: z.string(), offset: z.number().int().min(0).optional() },
        async (a) =>
          guard('read_file', async () =>
            fromResult(await sandboxTools.readFile({ path: a.path, ...(a.offset !== undefined ? { offset: a.offset } : {}) }), (v) =>
              `${v.path} (${v.size} bytes${v.offset > 0 ? `, from byte ${v.offset}` : ''}${v.encoding === 'base64' ? ', binary, base64' : ''})\n${v.content.text}`,
            ),
          ),
      ),
    list_directory: () =>
      tool('list_directory', 'List a directory of the snapshot (default: its root).', { path: z.string().optional() }, async (a) =>
        guard('list_directory', async () => fromResult(await sandboxTools.listDirectory({ ...(a.path !== undefined ? { path: a.path } : {}) }), (v) => `${v.path}/\n${v.text.text}`)),
      ),
    search_content: () =>
      tool(
        'search_content',
        'Search file contents under a path of the snapshot. Literal by default; regex=true for a regular expression.',
        { pattern: z.string(), path: z.string().optional(), regex: z.boolean().optional(), ignore_case: z.boolean().optional() },
        async (a) =>
          guard('search_content', async () =>
            fromResult(
              await sandboxTools.searchContent({
                pattern: a.pattern,
                ...(a.path !== undefined ? { path: a.path } : {}),
                ...(a.regex !== undefined ? { regex: a.regex } : {}),
                ...(a.ignore_case !== undefined ? { ignoreCase: a.ignore_case } : {}),
              }),
              (v) => (v.matches.length === 0 ? 'no matches' : v.text.text),
            ),
          ),
      ),
    write_file: () =>
      tool('write_file', 'Write a file under a writable path (creates parent directories). Replaces the whole file.', { path: z.string(), content: z.string() }, async (a) =>
        guard('write_file', async () => fromResult(await sandboxTools.writeFile(a), (v) => `wrote ${v.bytes} bytes to ${v.path} (${v.created ? 'created' : 'replaced'})`)),
      ),
    edit_file: () =>
      tool(
        'edit_file',
        'Replace an exact string in a file under a writable path. old_string must occur exactly once unless replace_all is true.',
        { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
        async (a) =>
          guard('edit_file', async () =>
            fromResult(
              await sandboxTools.editFile({ path: a.path, oldString: a.old_string, newString: a.new_string, ...(a.replace_all !== undefined ? { replaceAll: a.replace_all } : {}) }),
              (v) => `replaced ${v.replacements} occurrence(s) in ${v.path}`,
            ),
          ),
      ),
    run_command: () =>
      tool(
        'run_command',
        'Run a shell command in the sandbox (no network). Synchronous; nothing it starts outlives it. Output is capped.',
        { command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().int().positive().optional() },
        async (a) =>
          guard('run_command', async () =>
            fromResult(
              await sandboxTools.runCommand({ command: a.command, ...(a.cwd !== undefined ? { cwd: a.cwd } : {}), ...(a.timeout_ms !== undefined ? { timeoutMs: a.timeout_ms } : {}) }),
              renderRun,
            ),
          ),
      ),
    rerun_declared_command: () =>
      tool(
        'rerun_declared_command',
        `Have the program rerun one of the card's declared commands: ${declared.map((d) => d.id).join(', ') || '(none)'}.`,
        { id: z.string() },
        async (a) =>
          guard('rerun_declared_command', async () => {
            const d = declared.find((c) => c.id === a.id);
            if (d === undefined) return text(`error invalid-argument: "${a.id}" is not a declared command`, true);
            return fromResult(await sandboxTools.runCommand({ command: d.command, ...(d.cwd !== undefined ? { cwd: d.cwd } : {}) }), renderRun);
          }),
      ),
    read_material: () =>
      tool(
        'read_material',
        `Read one page of a material listed on the card, by its id and page number (1-based). Materials: ${materials.map((m) => `${m.id} (${m.pages} page${m.pages === 1 ? '' : 's'}${m.mustRead ? ', must read' : ''})`).join('; ') || '(none)'}.`,
        { material: z.string(), page: z.number().int().min(1) },
        async (a) =>
          guard('read_material', async () => {
            const r = (hooks.readMaterial as NonNullable<SeatToolHooks['readMaterial']>)(a.material, a.page);
            if (!r.ok) return text(`error: ${r.message}`, true);
            read.add(r.key);
            return text(r.text);
          }),
      ),
    fetch_url: () =>
      tool(
        'fetch_url',
        'Have the program fetch a web page the card allows (http or https; the program fetches outside the sandbox and records the page as evidence). Long pages are cut at the output cap; call again with offset (bytes) to read further from the recorded copy.',
        { url: z.string(), offset: z.number().int().min(0).optional() },
        async (a) =>
          guard('fetch_url', async () => {
            const r = await (hooks.fetchUrl as NonNullable<SeatToolHooks['fetchUrl']>)(a.url, a.offset ?? 0);
            return text(r.text, !r.ok);
          }),
      ),
    submit_result: () => tool('submit_result', SUBMIT_DESCRIPTIONS[card.seat] ?? SUBMIT_DEFAULT, entry.resultShape, async (a: unknown) => handOver(a)),
    request_evidence: () =>
      tool(
        'request_evidence',
        'Ask for an evidence run by a separate executor (blind steps, data, what to measure, assertions). Your session ends and resumes with the results.',
        { steps: z.array(z.string()).min(1), data: z.string(), measure: z.array(z.string()), assertions: z.array(z.string()) },
        async (a) =>
          guard('request_evidence', async () => {
            closed = 'evidence requested'; // before the state is saved: no hand-back can start meanwhile
            let r: { readonly accepted: boolean; readonly message: string };
            try {
              r = await (hooks.onEvidenceRequest as NonNullable<SeatToolHooks['onEvidenceRequest']>)(a);
            } catch (e) {
              r = { accepted: false, message: `Not accepted: ${(e as Error).message}` };
            }
            if (!r.accepted) {
              closed = null;
              return text(r.message, true);
            }
            return text(`${r.message}\nEnd your turn now; you will be resumed with the evidence results.`);
          }),
      ),
  };

  /** The program's rules on a hand-back: the must-read list first, then the kind's own (deduplicated). */
  function problems(raw: unknown): string[] {
    const out: string[] = [];
    for (const m of materials) {
      if (!m.mustRead) continue;
      for (let p = 1; p <= m.pages; p++) if (!read.has(pageKey(m.id, p))) out.push(unreadLine(pageKey(m.id, p)));
    }
    out.push(...handBackProblems(card, raw, { snapshot: hooks.context.snapshot, materialsRead: read }));
    return [...new Set(out)];
  }

  async function handOver(raw: unknown): Promise<CallToolResult> {
    return guard('submit_result', async () => {
      const found = problems(raw);
      if (found.length > 0) return text(`Not accepted; fix these and call submit_result again:\n- ${found.join('\n- ')}`, true);
      const result: HandBack = { seat: card.seat, result: entry.resultSchema.parse(raw) };
      closed = 'result submitted'; // before the result is persisted: no second hand-back can start
      try {
        const ack = await hooks.onSubmit(result);
        return text(`${ack}\nYour result is recorded. End your turn now.`);
      } catch (e) {
        closed = null; // nothing else ran meanwhile (one entry): the round goes on
        return text(`Not recorded: ${(e as Error).message}\nFix this and call submit_result again.`, true);
      }
    });
  }

  const all = wanted.map((n) => {
    const make = defs[n];
    if (make === undefined) throw new Error(`no program tool named ${n}`);
    return make();
  }) as ReturnType<typeof tool>[];
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  for (const t of all) {
    const d = t as unknown as { name: string; handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };
    handlers.set(d.name, (args) => d.handler(args, {}));
  }
  return {
    server: createSdkMcpServer({ name: SEAT_MCP_SERVER, version: '1.0.0', tools: all }),
    names: all.map((t) => `mcp__${SEAT_MCP_SERVER}__${(t as { name: string }).name}`),
    /** The same handlers the MCP server calls (by tool name), for checks without a model. */
    handlers: handlers as ReadonlyMap<string, (args: unknown) => Promise<CallToolResult>>,
    /** Why the round is closed, or null while it is open. */
    closedReason: (): string | null => closed,
    /** The pages read through read_material so far. */
    materialsRead: (): ReadonlySet<string> => read,
  };
}
