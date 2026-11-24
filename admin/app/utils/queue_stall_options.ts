/**
 * Per-queue BullMQ stall-recovery options.
 *
 * The pure, dependency-free core of `getStallOptionsForQueue` in
 * `commands/queue/work.ts` (mirrors `decideScanAction` in
 * `kb_ingest_decision.ts`).
 *
 * Two questions decide a queue's entry, and they pull in opposite directions:
 *
 * 1. **How long does one job legitimately hold the lock?** If that can exceed
 *    `lockDuration`, BullMQ calls a perfectly healthy job stalled.
 * 2. **Is re-running a job safe?** On a stall BullMQ increments the job's `stc`
 *    counter and re-queues it, failing it only once the counter passes
 *    `maxStalledCount` (`moveStalledJobsToWait`). It does **not** check whether
 *    the original is still running. For an idempotent job that recovery is what
 *    we want; for a job that writes non-idempotent data it is worse than the
 *    failure it is preventing.
 *
 * Note that `maxStalledCount: 0` is meaningful and is not the same as leaving
 * it unset: the comparison is `stalledCount > maxStalledCount` after an
 * increment, so 0 fails the job on the FIRST stall rather than re-queueing it,
 * while the BullMQ default of 1 re-queues once.
 */

export const DEFAULT_LOCK_DURATION = 300_000
export const LONG_LOCK_DURATION = 1_800_000

export interface StallOptions {
  lockDuration: number
  /** Left undefined to keep BullMQ's default of 1. */
  maxStalledCount?: number
}

export interface StallQueueNames {
  /** ZIM/document embedding — a self-continuing batch chain. */
  embedFile: string
  /** Content downloads — resumable. */
  download: string
  drugDownload: string
  drugIngest: string
  /**
   * Field-manual torrents. A second copy of the same torrent on the staging
   * directory can corrupt the partial download, so a stall fails the job. The
   * user resumes the partial by starting the download again.
   */
  fieldManual: string
}

export function stallOptionsForQueue(queueName: string, queues: StallQueueNames): StallOptions {
  // Long single streams (a ~150 MB resumable HTTP pull, then an unzip +
  // JSON-stream ingest at concurrency 1). Re-running a part is safe: the
  // download resumes and the ingest upserts by key.
  if (queueName === queues.drugDownload || queueName === queues.drugIngest) {
    return { lockDuration: LONG_LOCK_DURATION, maxStalledCount: 3 }
  }

  // NEVER auto-recover a stalled job on this queue (#1269). Embedding is a
  // self-continuing chain, so re-queueing while the original is alive produces
  // two chains walking the same file, both writing to Qdrant with freshly
  // minted point ids. A failed chain is visible and re-indexable; a forked one
  // is silent and corrupts the index.
  if (queueName === queues.embedFile) {
    return { lockDuration: LONG_LOCK_DURATION, maxStalledCount: 0 }
  }

  // The opposite call to embeddings (#1203). A download is resumable and
  // re-running one is harmless, but the default maxStalledCount of 1 fails the
  // job on a second stall and bypasses its own `attempts: 10` retry policy.
  if (queueName === queues.download) {
    return { lockDuration: LONG_LOCK_DURATION, maxStalledCount: 3 }
  }

  if (queueName === queues.fieldManual) {
    return { lockDuration: LONG_LOCK_DURATION, maxStalledCount: 0 }
  }

  return { lockDuration: DEFAULT_LOCK_DURATION }
}
