import { join } from 'node:path'

/** User-supplied torrents. The field-manual vault keeps its own directory. */
export function torrentStorageRoot(): string {
  return join(process.cwd(), '/storage/torrents')
}

export function torrentFilesDir(id: string): string {
  return join(torrentStorageRoot(), 'files', id)
}

export function torrentMetaPath(id: string): string {
  return join(torrentStorageRoot(), 'meta', `${id}.torrent`)
}

export function torrentCatalogPath(): string {
  return join(torrentStorageRoot(), 'catalog.json')
}
