import assert from 'node:assert/strict';
import { runCli } from '../src/cli/main.ts';
import { defaultConfig, writeConfig } from '../src/cli/config.ts';
import { copyDocs } from '../src/cli/init.ts';
import { processProject, ENV_A, type ProcessProject } from './process-fixtures.ts';
import { openProcess } from '../src/process/context.ts';
import { flowCtx } from '../src/flow/context.ts';
import { raiseEscalation } from '../src/flow/secretary.ts';
import type { MissionId } from '../src/common/ids.ts';

export function project43(): ProcessProject {
  const p = processProject();
  writeConfig(p.dir, defaultConfig({targetBranch: 'main', versionCommands: []}));
  copyDocs(p.dir, {refresh: false});
  return p;
}

export async function command43(p: ProcessProject, args: string[], identity: string | null = null) {
  const r = await runCli([...args, '--json'], {cwd: p.dir, env: {MP_SECRETARY: identity ?? '', MP_ROLE: 'ignored'}, process: {observe: () => ENV_A, ident: {name: 'test', email: 'test@test'}}});
  return {code: r.exitCode, ...JSON.parse(r.stdout || r.stderr)} as {code: number; result: any; error?: any; replayed?: boolean};
}
export async function done43(p: ProcessProject, args: string[], identity: string | null = null): Promise<any> {
  const r = await command43(p, args, identity); assert.equal(r.code, 0, JSON.stringify(r)); return r.result;
}
export async function live43(p: ProcessProject) {
  const g = await done43(p, ['pm','secretary','start']);
  await done43(p, ['sec','session','--filled-by','harness/secretary'], g.generation);
  return g.generation as string;
}
export function secretary43(p: ProcessProject, identity: string) {return openProcess(p.dir, {secretary: identity, observe: () => ENV_A});}
export async function escalation43(p: ProcessProject, id = 'choice', o: Record<string, unknown> = {}) {
  await done43(p, ['pm','mission','open','m1']);
  await raiseEscalation(flowCtx(p.ctx.ports(), 'm1' as MissionId), {id, source: 'constructor-decision', lineage: 'L', subject: 'task:t', summary: 'choose an implementation detail', reasons: ['the seat needs a choice'], options: ['answer','accept','grant','ask-user'], ...o});
  return id;
}
