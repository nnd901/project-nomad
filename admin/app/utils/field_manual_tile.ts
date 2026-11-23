import type { FieldManualEditionStatus } from '../../types/field_manual_vault.js'

/** One line for the home tile while a vault edition is still unfinished. */
export function fieldManualHomeNote(editions: FieldManualEditionStatus[]): string | null {
  const notes = editions.flatMap((edition) => {
    if (edition.installed) return []
    if (edition.downloading) {
      const detail = edition.queued
        ? 'queued'
        : edition.seeders === 0 && edition.downloadSpeed === 0
          ? 'waiting for a seed'
          : `${edition.progress}%`
      return [`${edition.title} ${detail}`]
    }
    if (edition.paused) return [`${edition.title} paused at ${edition.progress}%`]
    if (edition.error) return [`${edition.title} failed`]
    return []
  })
  if (notes.length === 0) return null
  return notes.join(' · ')
}
