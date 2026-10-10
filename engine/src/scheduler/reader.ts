// The one read the scheduler still makes straight from the main ledger: the committed base
// records after a revision, for expanding episode batches into notices and copying alerts to
// the control plane. It is the evaluator's own read path (src/ledger/store.ts readRecords, a
// read-only connection; 6.1: readers never write). Every other question goes to the ledger
// service over its IPC (src/scheduler/ledger.ts).

import type { Revision } from '../common/ids.ts';
import type { Committed } from '../common/records.ts';
import { readRecords } from '../ledger/store.ts';

export class LedgerReader {
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Base records committed after `after` (notice expansion, alert copies). */
  readRecordsAfter(after: Revision): Committed[] {
    return readRecords(this.dbPath, after);
  }
}
