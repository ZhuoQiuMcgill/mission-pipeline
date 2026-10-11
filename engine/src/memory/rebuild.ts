// Rebuild every state table from the log (design 4.1 §3.3 step 4; 4.0 10.1
// rule 3, core review r2 F17), inside one write transaction: the state tables
// (the core's and the extensions') are emptied, then every event is replayed in
// revision order through the same projection the writes applied, with the
// event's own commit time. The log, the data values and this copy's meta are
// never touched. After a move this runs in the transaction that records the
// move done, so state pages copied at another moment than the log never
// survive it.
//
// The replay verifies the hash chain as it goes (§3.3): a damaged log is never
// replayed. A break refuses the rebuild (CHAIN_BROKEN) and the transaction
// rolls back, so the state stays as it was.

import { walkChain } from './chain.ts';
import { LedgerError } from './errors.ts';
import type { LogRecord } from './events.ts';
import type { MemoryExtension, WriteTx } from './memory.ts';
import { project, type ProjectionContext } from './projection.ts';
import { STATE_TABLES } from './schema.ts';

export interface RebuildReport {
  readonly events: number;
  readonly tables: number;
}

export function rebuildState(tx: WriteTx, extensions: readonly MemoryExtension[]): RebuildReport {
  const tables = [...STATE_TABLES, ...extensions.flatMap((e) => e.stateTables ?? [])];
  for (const t of tables) tx.stmt(`DELETE FROM ${t}`).run();
  let events = 0;
  const report = walkChain(tx, (r) => {
    const rec = JSON.parse(r.record) as LogRecord;
    const ctx: ProjectionContext = { rev: Number(r.rev), at: Number(r.committed_at) };
    project(tx, rec, ctx);
    for (const ext of extensions) ext.project?.(tx, rec, ctx);
    events++;
  });
  if (!report.ok) {
    // walkChain reported it (latched before the throw): a caller that catches it still cannot commit this partial rebuild.
    throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken at event ${report.brokenAt} (${report.reason}); the last valid event is ${report.lastValid}: the state is not rebuilt from a damaged log`);
  }
  for (const ext of extensions) ext.afterRebuild?.(tx);
  return { events, tables: tables.length };
}
