// Resident Secretary identity and generations. These are additive log facts; old logs need
// no migration and every view is reproduced by replaying the log.
import type { Db } from './db.ts';
import type { Memory, WriteTx } from './memory.ts';
import type { Filler } from './events.ts';

export interface SecretaryGeneration {
  readonly generation: string;
  readonly state: 'pending' | 'live' | 'retired';
  readonly name: string;
  readonly handle: string | null;
  readonly session: string | null;
  readonly filler: Filler | null;
  readonly createdAt: number;
  readonly claimedAt: number | null;
  readonly lastCommandAt: number | null;
}

export function notAllowed(reason: string): never {
  throw Object.assign(new Error(reason), { name: 'ProcessError', code: 'NOT_ALLOWED' });
}

export function generations(db: Db): SecretaryGeneration[] {
  return (db.stmt("SELECT value FROM state WHERE key LIKE 'resident:generation:%' ORDER BY CAST(substr(key, length('resident:generation:S-') + 1) AS INTEGER)").all() as {value: string}[]).map((r) => JSON.parse(r.value) as SecretaryGeneration);
}

export function liveSecretary(db: Db): SecretaryGeneration | null {
  return generations(db).find((g) => g.state === 'live') ?? null;
}

export function requireSecretary(db: Db, identity: string | null, pending = false): SecretaryGeneration {
  const g = generations(db).find((g) => g.generation === identity);
  if (identity === null || g === undefined || (g.state !== 'live' && !(pending && g.state === 'pending'))) {
    notAllowed(`MP_SECRETARY must name the ${pending ? 'pending or live' : 'live'} Secretary generation; ${identity ?? 'unset'} cannot operate this project`);
  }
  return g;
}

export function requirePm(identity: string | null): void {
  if (identity !== null) notAllowed(`${identity} acts as the Secretary; PM instructions and the user's words go through the PM`);
}

export function requireDriver(db: Db, identity: string | null): void {
  if (identity !== null) { requireSecretary(db, identity); return; }
  const g = liveSecretary(db);
  if (g !== null) notAllowed(`${g.name} (${g.generation}) owns the loop; use mp sec commands in its session`);
}

export function writeGeneration(tx: WriteTx, g: SecretaryGeneration): void {
  tx.append({ kind: 'secretary.generation', ...g });
}

export function startSecretary(memory: Memory, o: {name: string; replace?: boolean; handle?: string | null; op: string}): SecretaryGeneration {
  return memory.write({ op: `secretary:start:${o.op}`, payload: o, command: 'secretary start' }, (tx) => {
    const all = generations(tx);
    const live = all.find((g) => g.state === 'live');
    if (live !== undefined && o.replace !== true) notAllowed(`${live.name} (${live.generation}) is live; --replace explicitly retires it`);
    for (const g of all) if (g.state !== 'retired') writeGeneration(tx, {...g, state: 'retired'});
    const g: SecretaryGeneration = {generation: `S-${all.length + 1}`, state: 'pending', name: o.name, handle: o.handle ?? null, session: null, filler: null, createdAt: tx.at, claimedAt: null, lastCommandAt: null};
    writeGeneration(tx, g);
    return g;
  });
}

export function claimSecretary(memory: Memory, identity: string | null, o: {op: string; filler: Filler | null}): SecretaryGeneration {
  return memory.write({ op: `secretary:session:${o.op}`, payload: {identity, ...o}, command: 'sec session', filler: o.filler }, (tx) => {
    const g = requireSecretary(tx, identity, true);
    // A repeated session preserves this generation's session and filler.
    if (g.state === 'live') return g;
    const next: SecretaryGeneration = {...g, state: 'live', session: o.op, filler: o.filler, claimedAt: tx.at, lastCommandAt: tx.at};
    writeGeneration(tx, next);
    return next;
  });
}

export function touchSecretary(memory: Memory, identity: string | null): void {
  memory.write({}, (tx) => { const g = requireSecretary(tx, identity); writeGeneration(tx, {...g, lastCommandAt: tx.at}); });
}
