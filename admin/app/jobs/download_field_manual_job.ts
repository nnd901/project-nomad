import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Job, UnrecoverableError } from 'bullmq'
import axios from 'axios'
import logger from '@adonisjs/core/services/logger'
import { QueueService } from '#services/queue_service'
import { KiwixLibraryService } from '#services/kiwix_library_service'
import {
  addTransmissionTorrent,
  clearStoredHash,
  findTransmissionDownload,
  pauseTransmission,
  readStoredHash,
  removeTransmission,
  skipVaultDebris,
  startTransmission,
  transmissionTellStatus,
  writeStoredHash,
} from '#services/transmission_client'
import {
  FIELD_MANUAL_EDITIONS,
  FIELD_MANUAL_RELEASE,
  FIELD_MANUAL_ZIM_FILENAME,
  type FieldManualEditionSpec,
} from '../data/field_manual_vault.js'
import type { FieldManualEditionId } from '../../types/field_manual_vault.js'
import { ensureDirectoryExists } from '../utils/fs.js'
import {
  isInside,
  listTorrentFiles,
  removeVaultDownloadDebris,
  safeTorrentDirectoryName,
} from '../utils/field_manual_vault.js'
import { transferFromStatus, type TransmissionTorrent } from '../utils/transmission_status.js'
import {
  fieldManualCompleteMarkerPath,
  fieldManualStagingDir,
  fieldManualStorageRoot,
  fieldManualTorrentPath,
  fieldManualZimPath,
} from '../utils/field_manual_paths.js'

export interface DownloadFieldManualJobParams {
  edition: FieldManualEditionId
}

export const FIELD_MANUAL_CANCELLED_MESSAGE = 'Download cancelled'

export class DownloadFieldManualJob {
  static get queue() {
    return 'field-manuals'
  }

  static get key() {
    return 'download-field-manual'
  }

  static jobIdFor(edition: FieldManualEditionId): string {
    return `field-manual-${edition}`
  }

  static cancelKey(edition: FieldManualEditionId): string {
    return `nomad:field-manual:cancel:${edition}`
  }

  static async dispatch(edition: FieldManualEditionId) {
    const queueService = QueueService.getInstance()
    const queue = queueService.getQueue(this.queue)
    const jobId = this.jobIdFor(edition)
    const redis = await queue.client
    await redis.del(this.cancelKey(edition))

    const existing = await queue.getJob(jobId)
    if (existing) {
      const state = await existing.getState()
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        return { created: false, message: 'That download is already running' }
      }
      try {
        await existing.remove()
      } catch {
        // A completed record can disappear between getJob and remove.
      }
    }

    const job = await queue.add(this.key, { edition } satisfies DownloadFieldManualJobParams, {
      jobId,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 5 },
    })
    return { created: true, job, message: 'Download started' }
  }

  async handle(job: Job) {
    const editionId = (job.data as DownloadFieldManualJobParams).edition
    const edition = FIELD_MANUAL_EDITIONS[editionId]
    if (!edition) {
      throw new UnrecoverableError(`Unknown field manual edition "${String(editionId)}"`)
    }

    const queueService = QueueService.getInstance()
    const redis = await queueService.getQueue(DownloadFieldManualJob.queue).client
    if (await redis.get(DownloadFieldManualJob.cancelKey(edition.id))) {
      await redis.del(DownloadFieldManualJob.cancelKey(edition.id))
      throw new UnrecoverableError(FIELD_MANUAL_CANCELLED_MESSAGE)
    }

    const staging = fieldManualStagingDir(edition.id)
    if (!isInside(fieldManualStorageRoot(), staging)) {
      throw new UnrecoverableError('Field manual staging path escaped storage')
    }
    await mkdir(staging, { recursive: true })
    await unlink(join(fieldManualStorageRoot(), `${edition.id}.pid`)).catch(() => undefined)

    const torrentPath = await this.fetchTorrent(edition)
    const torrentBytes = await readFile(torrentPath)
    const torrent = listTorrentFiles(torrentBytes)
    const directoryName = safeTorrentDirectoryName(torrent.name)
    if (torrent.files.length === 0) throw new UnrecoverableError('Torrent has no content files to download')

    let current = await attachedDownload(edition.id, staging)
    if (!current) {
      const hash = await addTransmissionTorrent(torrentBytes, staging)
      current = await transmissionTellStatus(hash)
    }
    if (!current) throw new Error('The download service did not accept the torrent')
    await writeStoredHash(edition.id, current.hash)
    await skipVaultDebris(current.hash)

    if (current.status === 'paused') {
      await startTransmission(current.hash)
      current = (await transmissionTellStatus(current.hash)) ?? current
    }

    current = await followDownload(job, redis, edition.id, staging, current, edition.sizeBytes)
    await removeTransmission(current.hash, false)

    if (edition.id === 'zim') {
      await finalizeZim(staging, directoryName)
    } else if (edition.id === 'full') {
      await finalizeFullVault(staging, directoryName)
    } else {
      const unreachable: never = edition.id
      throw new UnrecoverableError(`Unknown edition ${String(unreachable)}`)
    }

    await clearStoredHash(edition.id)
    logger.info(`[FieldManualVault] ${edition.title} download finished`)
  }

  private async fetchTorrent(edition: FieldManualEditionSpec): Promise<string> {
    const response = await axios.get<ArrayBuffer>(edition.torrentUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024,
    })
    const bytes = Buffer.from(response.data)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== edition.torrentSha256) {
      throw new UnrecoverableError('The torrent file failed its SHA-256 check and was not started')
    }

    const torrentPath = fieldManualTorrentPath(edition.id)
    await mkdir(dirname(torrentPath), { recursive: true })
    await writeFile(torrentPath, bytes)
    return torrentPath
  }
}

async function attachedDownload(
  editionId: FieldManualEditionId,
  staging: string
): Promise<TransmissionTorrent | null> {
  const stored = await readStoredHash(editionId)
  if (stored) {
    const status = await transmissionTellStatus(stored)
    if (status) return status
  }
  return findTransmissionDownload(staging)
}

async function followDownload(
  job: Job,
  redis: { get(key: string): Promise<string | null>; del(key: string): Promise<unknown> },
  editionId: FieldManualEditionId,
  staging: string,
  initial: TransmissionTorrent,
  fallbackTotal: number
): Promise<TransmissionTorrent> {
  let current = initial
  while (true) {
    if (await redis.get(DownloadFieldManualJob.cancelKey(editionId))) {
      await pauseTransmission(current.hash)
      await redis.del(DownloadFieldManualJob.cancelKey(editionId))
      throw new UnrecoverableError(FIELD_MANUAL_CANCELLED_MESSAGE)
    }

    const reported = await transmissionTellStatus(current.hash)
    const next = reported ?? (await findTransmissionDownload(staging))
    if (!next) throw new Error('The download disappeared from the download service')
    if (next.hash !== current.hash) await writeStoredHash(editionId, next.hash)
    current = next
    await job
      .updateProgress({
        ...transferFromStatus(current, fallbackTotal),
        lastProgressTime: Date.now(),
      })
      .catch(() => undefined)

    switch (current.status) {
      case 'complete':
        return current
      case 'error':
        throw new Error(current.errorMessage || 'The download failed')
      case 'paused':
        throw new UnrecoverableError(FIELD_MANUAL_CANCELLED_MESSAGE)
      case 'active':
      case 'waiting':
        await new Promise((resolve) => setTimeout(resolve, 2000))
        break
      default: {
        const unreachable: never = current.status
        throw new Error(`Unexpected download status ${String(unreachable)}`)
      }
    }
  }
}

async function finalizeZim(staging: string, directoryName: string): Promise<void> {
  const found =
    (await findNamedFile(join(staging, directoryName), FIELD_MANUAL_ZIM_FILENAME)) ??
    (await findNamedFile(staging, FIELD_MANUAL_ZIM_FILENAME))
  if (!found) throw new Error('The torrent finished without the ZIM file')

  const downloaded = await stat(found)
  const expected = FIELD_MANUAL_EDITIONS.zim.sizeBytes
  if (downloaded.size !== expected) {
    throw new Error(`Downloaded ZIM is ${downloaded.size} bytes, expected ${expected}`)
  }

  const destination = fieldManualZimPath()
  await ensureDirectoryExists(dirname(destination))
  await unlink(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await moveFile(found, destination)
  await rm(staging, { recursive: true, force: true })

  // Register the book with Kiwix only. A 21 GB manual is not sent through the
  // knowledge-base embedder; the ZIM settings page can index it later.

  try {
    await new KiwixLibraryService().addBook(FIELD_MANUAL_ZIM_FILENAME)
  } catch (error) {
    logger.error(`[FieldManualVault] ZIM is on disk but the Kiwix library did not update: ${errorMessage(error)}`)
  }
}

async function finalizeFullVault(staging: string, directoryName: string): Promise<void> {
  const root = join(staging, directoryName)
  if (!isInside(fieldManualStorageRoot(), root)) {
    throw new Error('Vault folder escaped field manual storage')
  }
  await stat(join(root, 'index.csv'))
  await removeVaultDownloadDebris(root)
  await writeFile(
    fieldManualCompleteMarkerPath(),
    JSON.stringify({
      root,
      release: FIELD_MANUAL_RELEASE,
      completedAt: new Date().toISOString(),
    })
  )
}

async function findNamedFile(dir: string, fileName: string, depth = 0): Promise<string | null> {
  if (depth > 2) return null
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) return join(dir, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findNamedFile(join(dir, entry.name), fileName, depth + 1)
    if (found) return found
  }
  return null
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    await copyFile(from, to)
    await unlink(from)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
