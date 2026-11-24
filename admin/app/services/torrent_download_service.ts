import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import axios from 'axios'
import logger from '@adonisjs/core/services/logger'
import {
  addTransmissionMagnet,
  addTransmissionTorrent,
  findTransmissionDownload,
  pauseTransmission,
  removeTransmission,
  startTransmission,
  transmissionIsReachable,
  transmissionTellStatus,
} from '#services/transmission_client'
import type { TransmissionTorrent } from '../utils/transmission_status.js'
import { transferFromStatus } from '../utils/transmission_status.js'
import { parseTorrentCatalog, serializeTorrentCatalog } from '../utils/torrent_catalog.js'
import { formatGiB, hasRoomForDownload } from '../utils/download_integrity.js'
import { isInside, listTorrentFiles } from '../utils/field_manual_vault.js'
import {
  torrentCatalogPath,
  torrentFilesDir,
  torrentMetaPath,
  torrentStorageRoot,
} from '../utils/torrent_paths.js'
import { classifyTorrentSource, isTorrentId, torrentDisplayName } from '../utils/torrent_source.js'
import type {
  StoredTorrent,
  TorrentDownload,
  TorrentDownloadState,
  TorrentPageStatus,
} from '../../types/torrent_download.js'

const TORRENT_FILE_LIMIT = 5 * 1024 * 1024

export interface TorrentActionResult {
  success: boolean
  status: number
  message: string
}

let catalogChain: Promise<unknown> = Promise.resolve()

export class TorrentDownloadService {
  async getStatus(): Promise<TorrentPageStatus> {
    return exclusive(async () => {
      const loaded = await readCatalog()
      if (!loaded.ok) {
        return { available: await transmissionIsReachable(), catalogError: loaded.message, downloads: [] }
      }
      const available = await transmissionIsReachable()
      if (!available) {
        return {
          available,
          catalogError: null,
          downloads: loaded.records.map((record) => viewOf(record, null)),
        }
      }
      let changed = false
      const downloads: TorrentDownload[] = []
      for (const record of loaded.records) {
        const live = await locate(record)
        if (live && live.hash !== record.gid) {
          record.gid = live.hash
          changed = true
        }
        downloads.push(viewOf(record, live))
      }
      if (changed) await writeCatalog(loaded.records)
      return { available, catalogError: null, downloads }
    })
  }

  async addFromSource(source: string): Promise<TorrentActionResult> {
    const classified = classifyTorrentSource(source)
    if (!classified) {
      return {
        success: false,
        status: 400,
        message: 'Paste a magnet link or an http(s) URL of a torrent file.',
      }
    }
    if (classified.kind === 'magnet') {
      return this.addDownload({ name: classified.name, magnet: classified.uri, torrent: null })
    }
    const fetched = await fetchTorrentFile(classified.url)
    if (!fetched.ok) return { success: false, status: 400, message: fetched.message }
    const named = torrentName(fetched.bytes)
    if (!named.ok) return { success: false, status: 400, message: named.message }
    return this.addDownload({ name: named.name, magnet: null, torrent: fetched.bytes })
  }

  async addFromFile(bytes: Buffer): Promise<TorrentActionResult> {
    if (bytes.length === 0 || bytes.length > TORRENT_FILE_LIMIT) {
      return { success: false, status: 400, message: 'Choose a torrent file under 5 MB.' }
    }
    const named = torrentName(bytes)
    if (!named.ok) return { success: false, status: 400, message: named.message }
    return this.addDownload({ name: named.name, magnet: null, torrent: bytes })
  }

  async pause(id: string): Promise<TorrentActionResult> {
    if (!isTorrentId(id)) return missing()
    return exclusive(async () => {
      const loaded = await readCatalog()
      if (!loaded.ok) return { success: false, status: 409, message: loaded.message }
      const record = loaded.records.find((item) => item.id === id)
      if (!record) return missing()
      const live = await locateOrUnavailable(record)
      if (!live.reachable) return unavailable()
      if (!live.status) {
        return { success: false, status: 409, message: 'That torrent is not running.' }
      }
      switch (live.status.status) {
        case 'paused':
          return { success: true, status: 200, message: 'Download paused.' }
        case 'active':
        case 'waiting':
          await pauseTransmission(live.status.hash)
          return { success: true, status: 200, message: 'Download paused. Start it again to resume.' }
        case 'complete':
          return { success: false, status: 409, message: 'That torrent already finished.' }
        case 'error':
          return { success: false, status: 409, message: 'That torrent is not running.' }
        default: {
          const unreachable: never = live.status.status
          throw new Error(`Unexpected download status ${String(unreachable)}`)
        }
      }
    })
  }

  async resume(id: string): Promise<TorrentActionResult> {
    if (!isTorrentId(id)) return missing()
    return exclusive(async () => {
      const loaded = await readCatalog()
      if (!loaded.ok) return { success: false, status: 409, message: loaded.message }
      const record = loaded.records.find((item) => item.id === id)
      if (!record) return missing()
      const live = await locateOrUnavailable(record)
      if (!live.reachable) return unavailable()
      if (live.status?.status === 'active' || live.status?.status === 'waiting') {
        return { success: true, status: 200, message: 'That download is already running.' }
      }
      if (live.status?.status === 'complete') {
        return { success: false, status: 409, message: 'That torrent already finished.' }
      }
      if (live.status?.status === 'paused') {
        await startTransmission(live.status.hash)
        return { success: true, status: 200, message: 'Download resumed.' }
      }
      if (live.status) await removeTransmission(live.status.hash, true)
      const added = await submit(record)
      if (!added.ok) return { success: false, status: 400, message: added.message }
      record.gid = added.gid
      await writeCatalog(loaded.records)
      return { success: true, status: 200, message: 'Download resumed.' }
    })
  }

  async remove(id: string): Promise<TorrentActionResult> {
    if (!isTorrentId(id)) return missing()
    return exclusive(async () => {
      const loaded = await readCatalog()
      if (!loaded.ok) return { success: false, status: 409, message: loaded.message }
      const record = loaded.records.find((item) => item.id === id)
      if (!record) return missing()
      const live = await locateOrUnavailable(record)
      if (!live.reachable) return unavailable()
      if (live.status) await removeTransmission(live.status.hash, true)
      const dir = torrentFilesDir(record.id)
      if (!isInside(torrentStorageRoot(), dir)) {
        throw new Error('Refusing to delete a torrent path outside storage')
      }
      await rm(dir, { recursive: true, force: true })
      await unlink(torrentMetaPath(record.id)).catch(() => undefined)
      await writeCatalog(loaded.records.filter((item) => item.id !== record.id))
      return { success: true, status: 200, message: 'Removed the torrent and its files.' }
    })
  }

  private async addDownload(input: {
    name: string
    magnet: string | null
    torrent: Buffer | null
  }): Promise<TorrentActionResult> {
    return exclusive(async () => {
      if (!(await transmissionIsReachable())) return unavailable()
      const loaded = await readCatalog()
      if (!loaded.ok) return { success: false, status: 409, message: loaded.message }
      const room = await ensureRoom()
      if (!room.ok) return { success: false, status: 409, message: room.message }

      const id = randomBytes(8).toString('hex')
      const dir = torrentFilesDir(id)
      const record: StoredTorrent = {
        id,
        name: input.name,
        gid: null,
        magnet: input.magnet,
        addedAt: new Date().toISOString(),
      }
      await mkdir(dir, { recursive: true })
      if (input.torrent) {
        await mkdir(dirname(torrentMetaPath(id)), { recursive: true })
        await writeFile(torrentMetaPath(id), input.torrent)
      }
      const added = await submit(record, input.torrent)
      if (!added.ok) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        await unlink(torrentMetaPath(id)).catch(() => undefined)
        return { success: false, status: 400, message: added.message }
      }
      record.gid = added.gid
      try {
        await writeCatalog([...loaded.records, record])
      } catch (error) {
        await removeTransmission(added.gid, true).catch(() => undefined)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        await unlink(torrentMetaPath(id)).catch(() => undefined)
        throw error
      }
      return { success: true, status: 200, message: `Started ${record.name}.` }
    })
  }
}

async function submit(
  record: StoredTorrent,
  torrent?: Buffer | null
): Promise<{ ok: true; gid: string } | { ok: false; message: string }> {
  const dir = torrentFilesDir(record.id)
  try {
    if (record.magnet) {
      return { ok: true, gid: await addTransmissionMagnet(record.magnet, dir) }
    }
    const bytes = torrent ?? (await readFile(torrentMetaPath(record.id)))
    return { ok: true, gid: await addTransmissionTorrent(bytes, dir) }
  } catch (error) {
    if (isMissingFile(error)) {
      return { ok: false, message: 'The original torrent is gone, so this download cannot be resumed.' }
    }
    logger.error(`[Torrents] add failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, message: 'The download service rejected that torrent.' }
  }
}

async function locate(record: StoredTorrent): Promise<TransmissionTorrent | null> {
  if (record.gid && /^[a-f0-9]{40}$/i.test(record.gid)) {
    const status = await transmissionTellStatus(record.gid)
    if (status) return status
  }
  return findTransmissionDownload(torrentFilesDir(record.id))
}

async function locateOrUnavailable(
  record: StoredTorrent
): Promise<{ reachable: true; status: TransmissionTorrent | null } | { reachable: false }> {
  try {
    return { reachable: true, status: await locate(record) }
  } catch {
    return { reachable: false }
  }
}

function viewOf(record: StoredTorrent, live: TransmissionTorrent | null): TorrentDownload {
  const state = downloadState(live)
  const transfer = live
    ? transferFromStatus(live, live.totalLength)
    : {
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        downloadSpeed: 0,
        seeders: 0,
        peers: 0,
      }
  return {
    id: record.id,
    name: record.name,
    state,
    progress: state === 'complete' ? 100 : transfer.percent,
    downloadedBytes: transfer.downloadedBytes,
    totalBytes: transfer.totalBytes,
    downloadSpeed: state === 'active' ? transfer.downloadSpeed : 0,
    seeders: state === 'active' ? transfer.seeders : 0,
    peers: state === 'active' ? transfer.peers : 0,
    error: state === 'error' ? live?.errorMessage || 'The download failed' : null,
    addedAt: record.addedAt,
  }
}

function downloadState(live: TransmissionTorrent | null): TorrentDownloadState {
  if (!live) return 'stopped'
  switch (live.status) {
    case 'active':
    case 'waiting':
    case 'paused':
    case 'error':
    case 'complete':
      return live.status
    default: {
      const unreachable: never = live.status
      throw new Error(`Unexpected download status ${String(unreachable)}`)
    }
  }
}

async function readCatalog(): Promise<
  { ok: true; records: StoredTorrent[] } | { ok: false; message: string }
> {
  try {
    const text = await readFile(torrentCatalogPath(), 'utf8')
    return { ok: true, records: parseTorrentCatalog(text) }
  } catch (error) {
    if (isMissingFile(error)) return { ok: true, records: [] }
    return { ok: false, message: 'The torrent list on disk could not be read.' }
  }
}

async function writeCatalog(records: StoredTorrent[]): Promise<void> {
  const path = torrentCatalogPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, serializeTorrentCatalog(records))
  await rename(tmp, path)
}

async function ensureRoom(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await mkdir(torrentStorageRoot(), { recursive: true })
    const stats = await statfs(torrentStorageRoot())
    const free = Number(stats.bavail) * Number(stats.bsize)
    if (!hasRoomForDownload(0, free)) {
      return {
        ok: false,
        message: `Not enough free disk space to start a torrent. ${formatGiB(free)} is free, and 2 GiB of headroom is required.`,
      }
    }
    return { ok: true }
  } catch {
    return { ok: true }
  }
}

async function fetchTorrentFile(
  url: string
): Promise<{ ok: true; bytes: Buffer } | { ok: false; message: string }> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: TORRENT_FILE_LIMIT,
      maxBodyLength: TORRENT_FILE_LIMIT,
      maxRedirects: 0,
      validateStatus: (status) => status === 200,
    })
    return { ok: true, bytes: Buffer.from(response.data) }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response && error.response.status >= 300 && error.response.status < 400) {
      return { ok: false, message: 'That URL redirects. Upload the torrent file instead.' }
    }
    return { ok: false, message: 'Could not download that torrent file.' }
  }
}

function torrentName(bytes: Buffer): { ok: true; name: string } | { ok: false; message: string } {
  try {
    return { ok: true, name: torrentDisplayName(listTorrentFiles(bytes).name) }
  } catch {
    return { ok: false, message: 'That file is not a torrent.' }
  }
}

function missing(): TorrentActionResult {
  return { success: false, status: 404, message: 'That torrent is not on this NOMAD.' }
}

function unavailable(): TorrentActionResult {
  return {
    success: false,
    status: 400,
    message:
      'The download service is not running. It is a separate container; start NOMAD again so that container comes up, then retry.',
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = catalogChain.then(fn, fn)
  catalogChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
