// Typed refusals of the ledger service. Every refusal is one of these codes, so
// the caller can map it to a PM work instruction (design 3.11): a refusal only
// stops the one action that caused it, never the whole flow. Each code carries
// the WI of its row in the exception table at the end of 3.11 ("例外出口对照表");
// null marks a normal branch of the flow, which the table says is not an
// exception (the caller re-reads and goes on).

export type LedgerErrorCode =
  | 'STORAGE_FAULT'
  | 'RECOVERY_PAUSED'
  | 'STOPPED'
  | 'STALE_GENERATION'
  | 'UNKNOWN_LAUNCH'
  | 'UNRECOGNIZED_LAUNCH'
  | 'OP_CONFLICT'
  | 'FACT_CONFLICT'
  | 'KIND_NOT_ALLOWED'
  | 'RECORD_INVALID'
  | 'TOO_LARGE'
  | 'DOMAIN_BUSY'
  | 'VERIFY_REQUIRED'
  | 'NOT_PENDING'
  | 'BELOW_FLOOR'
  | 'STALE_EVALUATOR'
  | 'STALE_PUBLICATION'
  | 'PROOF_REQUIRED'
  | 'PROOF_EXISTS'
  | 'PROOF_UNKNOWN_LAUNCH'
  | 'PROOF_CONFLICT'
  | 'PROOF_MALFORMED'
  | 'CONTENT_MISSING'
  | 'CLEANUP_REGRESSION'
  | 'SPEND_LIMIT'
  | 'ALREADY_SETTLED'
  /** The caller's scope tag differs from the scope persisted for the launch or the pending operation (core review r2 F1). */
  | 'SCOPE_MISMATCH'
  /** An attempt on a loop that is exhausted (6.5 "耗尽之后"); only loops recorded when an attempt starts. */
  | 'LOOP_EXHAUSTED'
  /** A second Secretary grant on one lineage (6.5: once per lineage, across all its loops). */
  | 'GRANT_LIMIT'
  /** The task is not in the queue (already dispatched, cancelled or superseded). */
  | 'NOT_QUEUED'
  /** The request changed after its content was verified (or was never verified): verify and send it again. */
  | 'STALE_REQUEST'
  /** A proof-conditioned operation while the derived state cannot be computed (6.1, WI-11): it ended; register it again after recovery. */
  | 'EVALUATOR_FAULT'
  /** An unexpected failure inside the service (a program defect). */
  | 'INTERNAL_ERROR'
  /** A continuation judgment without a passing evaluator check at the latest published revision (5.2 part 5): a full review instead. */
  | 'CONTINUATION_REFUSED'
  /** A renewal that does not meet the renewal rule (5.3): the judgment needs a new review instead. */
  | 'RENEWAL_REFUSED'
  /**
   * A landing or delivery-ref action for a delivery that is not the mission's
   * current one: superseded by a later delivery, withdrawn, or never recorded
   * (6.6 授权: "确认这次交付仍是当前的、没有被取消"; git review r1 #11).
   */
  | 'DELIVERY_NOT_CURRENT'
  | 'BAD_REQUEST';

export type WorkInstruction = `WI-${string}`;

/**
 * The work instruction for each refusal (3.11, exception table). Codes whose WI
 * depends on the action carry the most common one here; the service overrides it
 * where it knows better (an acceptance refused by a stop is WI-15: quarantined,
 * never restarted).
 */
export const REFUSAL_WI: Readonly<Record<LedgerErrorCode, WorkInstruction | null>> = {
  // 存储故障；开机后的恢复暂停
  STORAGE_FAULT: 'WI-12',
  RECOVERY_PAUSED: 'WI-12',
  // A stop in force is the safety floor (3.11 principle 4), not an exception: the stop report covers it (6.4).
  STOPPED: null,
  // 发起者不再被承认 / 旧一届调度的写入 → 隔离或重新启动
  STALE_GENERATION: 'WI-15',
  UNRECOGNIZED_LAUNCH: 'WI-15',
  // 证明对不上启动编号；同一身份的事实内容不同；请求与账本记录的不一致
  UNKNOWN_LAUNCH: 'WI-20',
  OP_CONFLICT: 'WI-20',
  FACT_CONFLICT: 'WI-20',
  NOT_PENDING: 'WI-20',
  PROOF_UNKNOWN_LAUNCH: 'WI-20',
  PROOF_CONFLICT: 'WI-20',
  PROOF_MALFORMED: 'WI-20',
  ALREADY_SETTLED: 'WI-20',
  SCOPE_MISMATCH: 'WI-20',
  BAD_REQUEST: 'WI-20',
  // 席位交回不合格式；导出超限；结果引用的内容不存在或哈希不一致（发布前复核第 3 项）
  KIND_NOT_ALLOWED: 'WI-15',
  RECORD_INVALID: 'WI-15',
  TOO_LARGE: 'WI-15',
  CONTENT_MISSING: 'WI-15',
  PROOF_REQUIRED: 'WI-15',
  // 动作超时后子进程不退出；清理持续失败；同一冲突域等待
  DOMAIN_BUSY: 'WI-14',
  VERIFY_REQUIRED: 'WI-14',
  CLEANUP_REGRESSION: 'WI-14',
  // 求值器
  STALE_EVALUATOR: 'WI-11',
  STALE_PUBLICATION: 'WI-11',
  // 预算阻塞
  SPEND_LIMIT: 'WI-09',
  // 交付已不是当前的 (WI-06, class A: nothing was written; the landing ends)
  DELIVERY_NOT_CURRENT: 'WI-06',
  // 回路次数耗尽
  LOOP_EXHAUSTED: 'WI-08',
  GRANT_LIMIT: 'WI-08',
  // Normal branches (6.1, 6.3): re-read and go on.
  BELOW_FLOOR: null,
  PROOF_EXISTS: null,
  NOT_QUEUED: null,
  STALE_REQUEST: null,
  // 派生状态无法计算 (6.1)
  EVALUATOR_FAULT: 'WI-11',
  // A program defect: the closest row is WI-20 (程序记录的一致性异常); the table needs its own row (reported).
  INTERNAL_ERROR: 'WI-20',
  // Normal branches (5.2 part 5, 5.3): a full review, or a new judgment, instead.
  CONTINUATION_REFUSED: null,
  RENEWAL_REFUSED: null,
};

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  /** The work instruction the PM follows for this refusal, or null for a normal branch. */
  readonly wi: WorkInstruction | null;
  constructor(code: LedgerErrorCode, message: string, wi?: WorkInstruction | null) {
    super(`${code}: ${message}`);
    this.name = 'LedgerError';
    this.code = code;
    this.wi = wi === undefined ? REFUSAL_WI[code] : wi;
  }
}
