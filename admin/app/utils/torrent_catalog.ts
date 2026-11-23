import type { StoredTorrent } from '../../types/torrent_download.js'
import { isTorrentId, torrentDisplayName } from './torrent_source.js'

export function parseTorrentCatalog(text: string): StoredTorrent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Torrent catalog is invalid')
  }
  if (!parsed || typeof parsed !== 'object' || !('downloads' in parsed)) {
    throw new Error('Torrent catalog is invalid')
  }
  const downloads = (parsed as { downloads: unknown }).downloads
  if (!Array.isArray(downloads)) throw new Error('Torrent catalog is invalid')
  return downloads.map(parseRecord)
}

export function serializeTorrentCatalog(downloads: StoredTorrent[]): string {
  return JSON.stringify({ downloads })
}

function parseRecord(value: unknown): StoredTorrent {
  if (!value || typeof value !== 'object') throw new Error('Torrent catalog entry is invalid')
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !isTorrentId(raw.id)) {
    throw new Error('Torrent catalog entry is invalid')
  }
  if (typeof raw.name !== 'string' || typeof raw.addedAt !== 'string') {
    throw new Error('Torrent catalog entry is invalid')
  }
  if (!(raw.gid === null || typeof raw.gid === 'string')) {
    throw new Error('Torrent catalog entry is invalid')
  }
  if (!(raw.magnet === null || typeof raw.magnet === 'string')) {
    throw new Error('Torrent catalog entry is invalid')
  }
  return {
    id: raw.id,
    name: torrentDisplayName(raw.name),
    gid: raw.gid,
    magnet: raw.magnet,
    addedAt: raw.addedAt,
  }
}
