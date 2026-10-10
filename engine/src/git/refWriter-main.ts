// The ref writer process (refWriter.ts; design 6.1, code review r1 #2):
//   node --experimental-strip-types src/git/refWriter-main.ts mission-pipeline.intent=<token>
// The job (RefWriteJob, JSON) comes on stdin, the result (RefWriteResult, JSON)
// goes to stdout. The argument only carries the intent token, so recovery finds
// a writer whose identity never reached the ledger (6.1 v34).
// Exit status: 0 created; 1 not created (exists or locked); 2 unsafe namespace; 3 error.

import { readFileSync } from 'node:fs';
import { writeLooseRef, type RefWriteJob } from './refWriter.ts';

try {
  const job = JSON.parse(readFileSync(0, 'utf8')) as RefWriteJob;
  const r = writeLooseRef(job);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exitCode = r.kind === 'created' ? 0 : r.kind === 'unsafe-namespace' ? 2 : 1;
} catch (e) {
  process.stdout.write(`${JSON.stringify({ kind: 'error', detail: e instanceof Error ? e.message : String(e) })}\n`);
  process.exitCode = 3;
}
