// The Agent SDK options of a seat session (design 9.3 "启动席位", 7.1), in one place: the seat
// host runs every seat with them, and the startup self-check (seat/selfcheck.ts) runs its
// probe session with the very same ones, so what the self-check proves is what seats get:
//   - no built-in tool (tools: []), no settings, no CLAUDE.md (settingSources: []);
//   - strictMcpConfig with only the program's in-process server: no account connector, no
//     project or user MCP server can attach, now or later;
//   - the seat's own tools pre-approved, anything else denied without asking;
//   - Claude Code started inside its enclosure (spawnClaudeCodeProcess), reaching the model only
//     through the metering proxy (ANTHROPIC_BASE_URL), with a minimal environment.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Options, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { HeadTailCollector } from '../exec/caps.ts';
import type { ExitStatus } from '../exec/cgroup.ts';
import type { ClaudeCodeEnclosure } from '../exec/enclosure.ts';
import { SEAT_MCP_SERVER } from './mcpTools.ts';
import type { SeatModel } from './modelConfig.ts';

export interface SeatSessionSpec {
  readonly model: SeatModel;
  readonly systemPrompt: string;
  /** The program's in-process MCP server and the full names of its tools. */
  readonly server: NonNullable<Options['mcpServers']>[string];
  readonly toolNames: readonly string[];
  readonly maxTurns: number;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly claudeExecutable?: string;
  readonly abort: AbortController;
  readonly proxyUrl: string;
  /** Login variables (an API key), if any. */
  readonly credentialEnv: Readonly<Record<string, string>>;
  readonly enclosure: ClaudeCodeEnclosure;
  readonly stderr?: HeadTailCollector;
  /** Called with the Claude Code process once started, and with its end. */
  readonly onChild?: (c: ChildProcess) => void;
  readonly onExit?: (e: ExitStatus) => void;
}

export function seatSessionOptions(s: SeatSessionSpec): Options {
  return {
    model: s.model.model,
    ...(s.model.effort !== undefined ? { effort: s.model.effort } : {}),
    systemPrompt: s.systemPrompt,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [SEAT_MCP_SERVER]: s.server },
    // the seat's own tools are pre-approved; anything else is denied without asking
    allowedTools: [...s.toolNames],
    permissionMode: 'dontAsk',
    maxTurns: s.maxTurns,
    cwd: s.cwd,
    persistSession: true,
    ...(s.resumeSessionId !== undefined ? { resume: s.resumeSessionId } : {}),
    ...(s.claudeExecutable !== undefined ? { pathToClaudeCodeExecutable: s.claudeExecutable } : {}),
    abortController: s.abort,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      LANG: 'C.UTF-8',
      ANTHROPIC_BASE_URL: s.proxyUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'mission-pipeline/4.0',
      ...(s.model.maxOutputTokens !== undefined ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(s.model.maxOutputTokens) } : {}),
      ...s.credentialEnv,
    },
    spawnClaudeCodeProcess: (o: SpawnOptions): SpawnedProcess => {
      const argv = s.enclosure.argv([o.command, ...o.args]);
      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.env)) if (v !== undefined) childEnv[k] = v;
      // bubblewrap keeps the working directory: Claude Code starts where the session says (the host: /)
      const c = spawn(argv[0] as string, argv.slice(1), { cwd: o.cwd ?? s.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      c.stderr?.on('data', (d: Buffer) => s.stderr?.push(d));
      // r7: a spawn failure is reported, never an unhandled 'error' event
      c.on('error', (e) => s.stderr?.push(Buffer.from(`[spawn] ${e.message}\n`)));
      c.once('exit', (code, signal) => s.onExit?.({ code, signal }));
      // the SDK's forwarded signal fires after its graceful close (stdin EOF, ~2 s)
      o.signal.addEventListener(
        'abort',
        () => {
          if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
        },
        { once: true },
      );
      s.onChild?.(c);
      return c as unknown as SpawnedProcess;
    },
  };
}
