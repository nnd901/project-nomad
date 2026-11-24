import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, rm, stat, statfs, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { Entry, ZipFile } from 'yauzl'
import logger from '@adonisjs/core/services/logger'
import Service from '#models/service'
import { KiwixLibraryService } from '#services/kiwix_library_service'
import { QueueService } from '#services/queue_service'
import {
  clearStoredHash,
  pauseTransmission,
  readStoredHash,
  removeTransmission,
  transmissionIsReachable,
  transmissionTellStatus,
} from '#services/transmission_client'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import {
  FIELD_MANUAL_EDITION_IDS,
  FIELD_MANUAL_EDITIONS,
  FIELD_MANUAL_RELEASE,
  FIELD_MANUAL_SOURCE_URL,
} from '../data/field_manual_vault.js'
import {
  DownloadFieldManualJob,
  FIELD_MANUAL_CANCELLED_MESSAGE,
} from '../jobs/download_field_manual_job.js'
import { transferFromStatus, type FieldManualTransfer } from '../utils/transmission_status.js'
import { formatGiB, hasRoomForDownload } from '../utils/download_integrity.js'
import {
  contentDisposition,
  filterVaultManuals,
  isInside,
  locateZippedEntry,
  manualArchivePath,
  manualFormats,
  matchZipEntry,
  parseVaultIndex,
  resolveInside,
  vaultFacets,
  type VaultManualRecord,
} from '../utils/field_manual_vault.js'
import {
  fieldManualCompleteMarkerPath,
  fieldManualStagingDir,
  fieldManualStorageRoot,
  fieldManualTorrentPath,
  fieldManualZimPath,
} from '../utils/field_manual_paths.js'
import type {
  FieldManualEditionId,
  FieldManualEditionStatus,
  FieldManualFormat,
  FieldManualSearchResult,
  FieldManualStatus,
} from '../../types/field_manual_vault.js'

const requireModule = createRequire(import.meta.url)
const openZip = requireModule('yauzl').open as (
  path: string,
  options: { lazyEntries?: boolean; autoClose?: boolean },
  callback: (error: Error | null, zipfile?: ZipFile) => void
) => void

export interface FieldManualActionResult {
  success: boolean
  status: number
  message: string
}

export interface FieldManualOpenResult {
  stream: Readable
  size: number
  contentType: string
  disposition: string
}

const DOWNLOAD_STOP_WAIT_MS = 20_000
const DOWNLOAD_FORCE_STOP_AFTER_MS = 5_000

const CONTENT_TYPES: Record<FieldManualFormat, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  md: 'text/plain; charset=utf-8',
}

let aria2Cache: { at: number; available: boolean } | null = null
let catalogCache: { path: string; mtimeMs: number; records: VaultManualRecord[] } | null = null

export class FieldManualVaultService {
  async getStatus(): Promise<FieldManualStatus> {
    const [aria2Available, kiwix, editions] = await Promise.all([
      aria2IsAvailable(),
      Service.findBy('service_name', SERVICE_NAMES.KIWIX),
      Promise.all(FIELD_MANUAL_EDITION_IDS.map((id) => this.editionStatus(id))),
    ])

    return {
      release: FIELD_MANUAL_RELEASE,
      sourceUrl: FIELD_MANUAL_SOURCE_URL,
      aria2Available,
      kiwixInstalled: Boolean(kiwix?.installed),
      kiwixLocation: kiwix?.ui_location ?? null,
      kiwixCustomUrl: kiwix?.custom_url ?? null,
      editions,
    }
  }

  async start(editionId: FieldManualEditionId): Promise<FieldManualActionResult> {
    const edition = FIELD_MANUAL_EDITIONS[editionId]
    if (await this.isInstalled(editionId)) {
      return {
        success: false,
        status: 409,
        message: `${edition.title} is already on disk. Remove it before downloading again.`,
      }
    }
    if (!(await aria2IsAvailable())) {
      return {
        success: false,
        status: 400,
        message:
          'The download service is not running. It is a separate container; start NOMAD again so that container comes up, then retry.',
      }
    }

    const root = fieldManualStorageRoot()
    await mkdir(root, { recursive: true })
    const already = await bytesUnder(fieldManualStagingDir(editionId))
    let remaining = Math.max(0, edition.sizeBytes - already)
    for (const otherId of FIELD_MANUAL_EDITION_IDS) {
      if (otherId === editionId) continue
      const other = await this.editionStatus(otherId)
      if (other.downloading) {
        remaining += Math.max(0, other.sizeBytes - other.downloadedBytes)
      }
    }
    const free = await freeBytes(root)
    if (free !== null && !hasRoomForDownload(remaining, free)) {
      return {
        success: false,
        status: 409,
        message:
          `Not enough free disk space for the ${edition.title}. ` +
          `${formatGiB(remaining)} more is required, plus 2 GiB of headroom, and ${formatGiB(free)} is free.`,
      }
    }

    const dispatched = await DownloadFieldManualJob.dispatch(editionId)
    logger.info(`[FieldManualVault] ${dispatched.message} (${editionId})`)
    return { success: true, status: 200, message: dispatched.message }
  }

  async cancel(editionId: FieldManualEditionId): Promise<FieldManualActionResult> {
    const queue = QueueService.getInstance().getQueue(DownloadFieldManualJob.queue)
    const redis = await queue.client
    await redis.set(DownloadFieldManualJob.cancelKey(editionId), '1', { EX: 300 })

    const job = await queue.getJob(DownloadFieldManualJob.jobIdFor(editionId))
    if (job) {
      const state = await job.getState()
      if (state === 'waiting' || state === 'delayed') {
        await job.remove().catch(() => undefined)
        await redis.del(DownloadFieldManualJob.cancelKey(editionId))
      }
    }

    await pauseStoredDownload(editionId)
    return { success: true, status: 200, message: 'Download cancelled. Start it again to resume.' }
  }

  async remove(editionId: FieldManualEditionId): Promise<FieldManualActionResult> {
    await this.cancel(editionId)
    const stopped = await waitUntilIdle(editionId)
    if (!stopped || (await editionIsBusy(editionId))) {
      logger.warn(
        `[FieldManualVault] refused to remove ${editionId} because the download is still running`
      )
      return {
        success: false,
        status: 409,
        message:
          'The download is still shutting down, so its files were left in place. Try again once it has stopped.',
      }
    }

    const storage = fieldManualStorageRoot()
    const staging = fieldManualStagingDir(editionId)
    if (!isInside(storage, staging)) {
      throw new Error('Refusing to delete a field manual path outside storage')
    }
    const removed = await forceRemoveStoredDownload(editionId)
    if (!removed) {
      return {
        success: false,
        status: 409,
        message:
          'The download service is not responding, so its files were left in place. Try again once it is running.',
      }
    }
    await rm(staging, { recursive: true, force: true })
    await unlink(fieldManualTorrentPath(editionId)).catch(ignoreMissing)

    if (editionId === 'zim') {
      await unlink(fieldManualZimPath()).catch(ignoreMissing)
      try {
        await new KiwixLibraryService().rebuildFromDisk()
      } catch (error) {
        logger.error(
          `[FieldManualVault] Kiwix library rebuild failed after removing the ZIM: ${messageOf(error)}`
        )
        return {
          success: true,
          status: 200,
          message:
            'Removed the ZIM. The Information Library index could not be rebuilt; rescan it from Settings.',
        }
      }
      return { success: true, status: 200, message: 'Removed the Kiwix ZIM.' }
    }

    catalogCache = null
    await unlink(fieldManualCompleteMarkerPath()).catch(ignoreMissing)
    return { success: true, status: 200, message: 'Removed the full vault.' }
  }

  async search(query: {
    q?: string
    family?: string
    branch?: string
    pubType?: string
    offset?: number
    limit?: number
  }): Promise<FieldManualSearchResult> {
    const records = await loadCatalog()
    if (!records) {
      return {
        installed: false,
        total: 0,
        manuals: [],
        facets: { families: [], branches: [], pubTypes: [] },
      }
    }

    const filtered = filterVaultManuals(records, query)
    return {
      installed: true,
      total: filtered.total,
      manuals: filtered.records.map((record) => ({
        id: record.id,
        designation: record.designation,
        title: record.title,
        editionDate: record.editionDate,
        status: record.status,
        family: record.family,
        branch: record.branch,
        pubType: record.pubType,
        formats: manualFormats(record),
      })),
      facets: vaultFacets(records),
    }
  }

  async open(
    id: string,
    format: FieldManualFormat
  ): Promise<FieldManualOpenResult | FieldManualActionResult> {
    const records = await loadCatalog()
    if (!records) {
      return { success: false, status: 409, message: 'Download the full vault to open a manual.' }
    }

    const record = records.find((candidate) => candidate.id === id)
    if (!record) {
      return { success: false, status: 404, message: 'That manual is not in the vault index.' }
    }

    const archivePath = manualArchivePath(record, format)
    if (!archivePath) {
      return {
        success: false,
        status: 404,
        message: `This manual has no ${formatLabel(format)} in the vault.`,
      }
    }

    const located = locateZippedEntry(archivePath)
    const root = await readVaultRoot()
    const zipPath = located && root ? resolveInside(root, located.zipRelative) : null
    if (!located || !zipPath) {
      return { success: false, status: 404, message: 'The vault index path for this manual is not usable.' }
    }

    try {
      await stat(zipPath)
    } catch {
      return { success: false, status: 404, message: 'That file is not on disk yet.' }
    }

    const opened = await openZipEntry(zipPath, located.entryName)
    if (!opened) {
      return { success: false, status: 404, message: 'That file is not inside the downloaded archive.' }
    }
    if ('ambiguous' in opened) {
      return {
        success: false,
        status: 409,
        message: 'More than one file in the archive has that name, so it was not opened.',
      }
    }

    return {
      stream: opened.stream,
      size: opened.size,
      contentType: CONTENT_TYPES[format],
      disposition: contentDisposition(basenameOf(located.entryName), format !== 'epub'),
    }
  }

  private async editionStatus(editionId: FieldManualEditionId): Promise<FieldManualEditionStatus> {
    const edition = FIELD_MANUAL_EDITIONS[editionId]
    const queue = QueueService.getInstance().getQueue(DownloadFieldManualJob.queue)
    const job = await queue.getJob(DownloadFieldManualJob.jobIdFor(editionId))
    const state = job ? await job.getState() : null
    const jobBusy = state === 'active' || state === 'waiting' || state === 'delayed'
    const failedReason = state === 'failed' ? job?.failedReason || null : null
    const live = await liveDownload(editionId)
    const ariaBusy =
      live.reachable &&
      (live.status?.status === 'active' || live.status?.status === 'waiting')
    const downloading = jobBusy || ariaBusy
    const installed = await this.isInstalled(editionId)
    const paused = Boolean(!installed && live.reachable && live.status?.status === 'paused')
    const progress =
      live.reachable && live.status
        ? transferFromStatus(live.status, edition.sizeBytes)
        : readJobProgress(job?.progress, edition.sizeBytes)
    const showProgress = downloading || paused

    return {
      id: edition.id,
      title: edition.title,
      summary: edition.summary,
      sizeLabel: edition.sizeLabel,
      sizeBytes: edition.sizeBytes,
      installed,
      downloading,
      paused,
      queued: state === 'waiting' || state === 'delayed',
      progress: showProgress ? progress.percent : 0,
      downloadedBytes: showProgress ? progress.downloadedBytes : 0,
      totalBytes: showProgress ? progress.totalBytes : edition.sizeBytes,
      downloadSpeed: downloading ? progress.downloadSpeed : 0,
      seeders: downloading ? progress.seeders : 0,
      peers: downloading ? progress.peers : 0,
      error: failedReason && !failedReason.includes(FIELD_MANUAL_CANCELLED_MESSAGE) ? failedReason : null,
    }
  }

  private async isInstalled(editionId: FieldManualEditionId): Promise<boolean> {
    if (editionId === 'zim') {
      try {
        const info = await stat(fieldManualZimPath())
        return info.isFile() && info.size === FIELD_MANUAL_EDITIONS.zim.sizeBytes
      } catch {
        return false
      }
    }

    const root = await readVaultRoot()
    if (!root) return false
    try {
      const info = await stat(vaultIndexPath(root))
      return info.isFile()
    } catch {
      return false
    }
  }
}

function vaultIndexPath(root: string): string {
  const index = resolveInside(root, 'index.csv')
  if (!index) throw new Error('Vault index escaped storage')
  return index
}

async function readVaultRoot(): Promise<string | null> {
  try {
    const raw = await readFile(fieldManualCompleteMarkerPath(), 'utf8')
    const parsed = JSON.parse(raw) as { root?: unknown }
    if (typeof parsed.root !== 'string') return null
    if (!isInside(fieldManualStorageRoot(), parsed.root)) return null
    return parsed.root
  } catch {
    return null
  }
}

async function loadCatalog(): Promise<VaultManualRecord[] | null> {
  const root = await readVaultRoot()
  if (!root) return null
  const indexPath = vaultIndexPath(root)
  let info
  try {
    info = await stat(indexPath)
  } catch {
    return null
  }
  if (catalogCache && catalogCache.path === indexPath && catalogCache.mtimeMs === info.mtimeMs) {
    return catalogCache.records
  }
  const records = parseVaultIndex(await readFile(indexPath, 'utf8'))
  catalogCache = { path: indexPath, mtimeMs: info.mtimeMs, records }
  return records
}

function readJobProgress(progress: unknown, fallbackTotal: number): FieldManualTransfer {
  if (progress && typeof progress === 'object' && 'percent' in progress) {
    const value = progress as Partial<FieldManualTransfer>
    return {
      percent: value.percent ?? 0,
      downloadedBytes: value.downloadedBytes ?? 0,
      totalBytes: value.totalBytes || fallbackTotal,
      downloadSpeed: value.downloadSpeed ?? 0,
      seeders: value.seeders ?? 0,
      peers: value.peers ?? 0,
    }
  }
  return {
    percent: 0,
    downloadedBytes: 0,
    totalBytes: fallbackTotal,
    downloadSpeed: 0,
    seeders: 0,
    peers: 0,
  }
}

async function aria2IsAvailable(): Promise<boolean> {
  if (aria2Cache?.available && Date.now() - aria2Cache.at < 60_000) return true
  const available = await transmissionIsReachable()
  aria2Cache = { at: Date.now(), available }
  return available
}

type LiveDownload =
  | { reachable: true; status: Awaited<ReturnType<typeof transmissionTellStatus>> }
  | { reachable: false }

async function liveDownload(editionId: FieldManualEditionId): Promise<LiveDownload> {
  try {
    const hash = await readStoredHash(editionId)
    if (!hash) return { reachable: true, status: null }
    return { reachable: true, status: await transmissionTellStatus(hash) }
  } catch {
    return { reachable: false }
  }
}

async function pauseStoredDownload(editionId: FieldManualEditionId): Promise<void> {
  const hash = await readStoredHash(editionId)
  if (!hash) return
  try {
    await pauseTransmission(hash)
  } catch (error) {
    logger.warn(`[FieldManualVault] could not pause ${editionId}: ${messageOf(error)}`)
  }
}

async function forceRemoveStoredDownload(editionId: FieldManualEditionId): Promise<boolean> {
  const hash = await readStoredHash(editionId)
  if (!hash) return true
  try {
    await removeTransmission(hash, true)
    await clearStoredHash(editionId)
    return true
  } catch (error) {
    logger.warn(`[FieldManualVault] could not remove ${editionId} from the download service: ${messageOf(error)}`)
    return false
  }
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

async function bytesUnder(dir: string): Promise<number> {
  async function walk(current: string): Promise<number> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return 0
    }
    let total = 0
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (!isInside(dir, full) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        total += await walk(full)
      } else if (entry.isFile()) {
        try {
          const info = await lstat(full)
          if (info.isFile()) total += info.size
        } catch {
          // aria2 can remove a control file between readdir and lstat.
        }
      }
    }
    return total
  }
  return walk(dir)
}

function jobStateIsBusy(state: string): boolean {
  return state === 'active' || state === 'waiting' || state === 'delayed'
}

async function editionIsBusy(editionId: FieldManualEditionId): Promise<boolean> {
  const live = await liveDownload(editionId)
  if (!live.reachable) return true
  if (live.status?.status === 'active' || live.status?.status === 'waiting') return true
  const queue = QueueService.getInstance().getQueue(DownloadFieldManualJob.queue)
  const job = await queue.getJob(DownloadFieldManualJob.jobIdFor(editionId))
  if (!job) return false
  return jobStateIsBusy(await job.getState())
}

async function discardSettledJob(editionId: FieldManualEditionId): Promise<void> {
  const queue = QueueService.getInstance().getQueue(DownloadFieldManualJob.queue)
  const job = await queue.getJob(DownloadFieldManualJob.jobIdFor(editionId))
  if (!job) return
  if (jobStateIsBusy(await job.getState())) return
  await job.remove().catch(() => undefined)
}

/**
 * Wait until the download service and the queue job have both stopped.
 * Returns false when they are still running so the caller does not delete
 * files out from under them.
 */
async function waitUntilIdle(editionId: FieldManualEditionId): Promise<boolean> {
  const deadline = Date.now() + DOWNLOAD_STOP_WAIT_MS
  const forceStopAt = Date.now() + DOWNLOAD_FORCE_STOP_AFTER_MS
  let forcedStop = false
  while (Date.now() <= deadline) {
    if (!(await editionIsBusy(editionId))) {
      await discardSettledJob(editionId)
      return true
    }
    // cancel() already paused the transfer. A download that is still active
    // has to be dropped before this wait gives up, otherwise remove() would
    // delete files the download service is still writing.
    if (!forcedStop && Date.now() >= forceStopAt) {
      const live = await liveDownload(editionId)
      const active = live.reachable ? live.status : null
      if (active && (active.status === 'active' || active.status === 'waiting')) {
        forcedStop = true
        await removeTransmission(active.hash, true).catch(() => undefined)
      }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)))
  }
  if (await editionIsBusy(editionId)) return false
  await discardSettledJob(editionId)
  return true
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function basenameOf(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || 'manual'
}

function formatLabel(format: FieldManualFormat): string {
  switch (format) {
    case 'pdf':
      return 'PDF'
    case 'epub':
      return 'EPUB'
    case 'md':
      return 'Markdown'
    default: {
      const unreachable: never = format
      return unreachable
    }
  }
}

type OpenedZipEntry = { stream: Readable; size: number } | { ambiguous: true } | null

function openZipEntry(zipPath: string, entryName: string): Promise<OpenedZipEntry> {
  return new Promise((resolve, reject) => {
    openZip(zipPath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Could not open the archive'))
        return
      }
      listZipEntryNames(zip).then(
        (names) => {
          zip.close()
          const match = matchZipEntry(names, entryName)
          switch (match.kind) {
            case 'match':
              openExactZipEntry(zipPath, match.name).then(resolve, reject)
              return
            case 'missing':
              resolve(null)
              return
            case 'ambiguous':
              resolve({ ambiguous: true })
              return
            default: {
              const unreachable: never = match
              reject(new Error(`Unhandled zip match ${JSON.stringify(unreachable)}`))
            }
          }
        },
        (listError: unknown) => {
          zip.close()
          reject(listError instanceof Error ? listError : new Error(String(listError)))
        }
      )
    })
  })
}

function listZipEntryNames(zip: ZipFile): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = []
    let settled = false
    zip.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    zip.on('entry', (entry: Entry) => {
      names.push(entry.fileName)
      zip.readEntry()
    })
    zip.on('end', () => {
      if (settled) return
      settled = true
      resolve(names)
    })
    zip.readEntry()
  })
}

function openExactZipEntry(
  zipPath: string,
  entryName: string
): Promise<{ stream: Readable; size: number } | null> {
  return new Promise((resolve, reject) => {
    openZip(zipPath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Could not open the archive'))
        return
      }
      readExactZipEntry(zip, entryName).then(
        (opened) => {
          if (!opened) zip.close()
          resolve(opened)
        },
        (entryError: unknown) => {
          zip.close()
          reject(entryError instanceof Error ? entryError : new Error(String(entryError)))
        }
      )
    })
  })
}

function readExactZipEntry(
  zip: ZipFile,
  entryName: string
): Promise<{ stream: Readable; size: number } | null> {
  const target = entryName.replace(/\\/g, '/')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { stream: Readable; size: number } | null) => {
      if (settled) return
      settled = true
      zip.removeAllListeners('entry')
      zip.removeAllListeners('end')
      zip.removeAllListeners('error')
      resolve(result)
    }

    zip.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    zip.on('entry', (entry: Entry) => {
      const name = entry.fileName.replace(/\\/g, '/')
      if (name !== target) {
        zip.readEntry()
        return
      }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) {
          if (!settled) {
            settled = true
            reject(streamError ?? new Error('Could not read the manual from the archive'))
          }
          return
        }
        stream.on('end', () => zip.close())
        stream.on('error', () => zip.close())
        finish({ stream, size: entry.uncompressedSize })
      })
    })
    zip.on('end', () => finish(null))
    zip.readEntry()
  })
}
