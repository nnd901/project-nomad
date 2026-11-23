import { join } from 'node:path'
import type { FieldManualEditionId } from '../../types/field_manual_vault.js'
import { FIELD_MANUAL_ZIM_FILENAME } from '../data/field_manual_vault.js'
import { ZIM_STORAGE_PATH } from './fs.js'

/** Bind-mounted storage root. Same join pattern as the ZIM library (`/app/storage/...`). */
export function fieldManualStorageRoot(): string {
  return join(process.cwd(), '/storage/field-manuals')
}

export function fieldManualZimPath(): string {
  return join(process.cwd(), ZIM_STORAGE_PATH, FIELD_MANUAL_ZIM_FILENAME)
}

export function fieldManualStagingDir(edition: FieldManualEditionId): string {
  return join(fieldManualStorageRoot(), edition === 'zim' ? 'zim-staging' : 'vault')
}

export function fieldManualTorrentPath(edition: FieldManualEditionId): string {
  const name = edition === 'zim' ? 'field-manual-vault.zim.torrent' : 'field-manual-vault.full.torrent'
  return join(fieldManualStorageRoot(), 'torrents', name)
}

export function fieldManualGidPath(edition: FieldManualEditionId): string {
  return join(fieldManualStorageRoot(), `${edition}.gid`)
}

export function fieldManualCompleteMarkerPath(): string {
  return join(fieldManualStorageRoot(), 'full.complete.json')
}
