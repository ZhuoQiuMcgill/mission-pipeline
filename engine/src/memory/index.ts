// The project memory's public API (design 4.1 §3, §4.1): what the labels,
// process, git, delivery and CLI packages use.
//
//   const m = openMemory(projectDir);              // recovers a moved folder first
//   const out = m.write({ op, payload }, (tx) => {   // one transaction, idempotent by op
//     appendRecords(tx, records);
//     return claimDispatch(tx, { dispatch, task, seat, card });
//   });
//   m.read((db) => taskQueue(db));                  // one consistent snapshot
//   m.close();

export { initMemory, openMemory, registerMemoryExtension, Memory, WriteTx, STOP_LOCK, WORK_BUDGET_MS, type InitReport, type MemoryExtension, type MemoryStatus, type OpenOptions, type WriteRequest } from './memory.ts';
export { BUSY_TIMEOUT_MS, type Db } from './db.ts';
export { LedgerError, REFUSAL_WI, type LedgerErrorCode, type WorkInstruction } from './errors.ts';
export { checkFiller, type DispatchHandbackOutcome, type Filler, type GitStepOutcome, type LogRecord, type MemoryEvent, type MoveFindings, type Place } from './events.ts';
export { DataStore, MAX_DATA_BYTES, MAX_LIST_BYTES, MAX_LIST_ITEMS, blobRefs, listRefs, requireContent } from './data.ts';
export { readLeaf, checkAllLeaves, entryText, type LeafKind, type LeafRead, type LeafRef, type LeafStatus } from './leaves.ts';
export { lock, tryLock, ProcessLock } from './locks.ts';
export { GENESIS, intactRecord, LOG_COLUMNS, structureProblem, verifyChain, walkChain, type ChainReport, type LogRow } from './chain.ts';
export { addGitExclude, plainGit, repositoryLayout, unreachableCommits, type GitResult, type GitRunner, type RepositoryLayout } from './git.ts';
export { machineIdentity, namedCommits, type MoveHooks } from './move.ts';
export { rebuildState, type RebuildReport } from './rebuild.ts';
export { identityOf, missionOf, setState, type ProjectionContext } from './projection.ts';
export { checkLeafPath, LAYOUT_DIRS, MEMORY_DB, MEMORY_DIRNAME, memoryPaths, osPath, PATH_ID, relPathProblem, type MemoryPaths } from './paths.ts';
export { BASE_TABLES, MEMORY_FORMAT, STATE_TABLES } from './schema.ts';
export { checkStopRequest, parseStopRequest, sameTag, scopeWithin, stopCovers, type ScopeTag, type StopRequest, type StopScope } from './stopTypes.ts';
export * from './queries.ts';
export { APPEND_KINDS, MAX_RECORD_BYTES, MAX_RECORDS_PER_REQUEST, MAX_REQUEST_BYTES, appendFact, appendRecords, checkShape, commitProofOp, freeze, loopState, raiseAlert, recordContinuationCheck } from './domain/facts.ts';
export { activeStopScopes, assertNotStopped, commitStop, narrowStop, releaseStop, stoppedFor } from './domain/stops.ts';
export { acquireLease, assertDispatchCurrent, assertGitWrites, assertNoMissionAlias, claimDispatch, closeMission, dequeueTask, dispatchLeaf, queueTask, recordHandback, releaseDispatch, setMission } from './domain/work.ts';
export { DELIVERY_BOUND_KINDS, authorizeIntent, finishIntent, recheckIntent, recordDelivery, recordLandingPhase, withdrawDelivery } from './domain/delivery.ts';
export { checkQuote, markNotice, recordPmAction, recordWords, setCursor, wordsFile } from './domain/pm.ts';
