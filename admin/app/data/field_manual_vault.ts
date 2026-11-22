import type { FieldManualEditionId } from '../../types/field_manual_vault.js'

/**
 * T.REX Arms Field Manual Vault, release 2026-11.
 *
 * Both editions are published as BitTorrent only. The byte counts are the
 * payload aria2 actually fetches: the ZIM file, and the full vault with
 * piece-padding and .par2 parity files left out.
 *
 * https://www.trex-arms.com/field-manual-vault/download
 */
export const FIELD_MANUAL_RELEASE = '2026-11'

export const FIELD_MANUAL_SOURCE_URL =
  'https://www.trex-arms.com/field-manual-vault/download'

export const FIELD_MANUAL_ZIM_FILENAME = 'field-manual-vault_eng_2026-11.zim'

export interface FieldManualEditionSpec {
  id: FieldManualEditionId
  title: string
  summary: string
  sizeLabel: string
  sizeBytes: number
  torrentUrl: string
  torrentSha256: string
  /** Distinct listen port so the ZIM and the full vault can download together. */
  listenPort: number
}

export const FIELD_MANUAL_EDITIONS: Record<FieldManualEditionId, FieldManualEditionSpec> = {
  zim: {
    id: 'zim',
    title: 'Kiwix ZIM',
    summary:
      'One searchable book for the Information Library, with WebP images. Install Kiwix to read it.',
    sizeLabel: '21.8 GB',
    sizeBytes: 21_790_280_469,
    torrentUrl:
      'https://files.trex-arms.com/vault/2026-11/field-manual-vault_eng_2026-11.zim.torrent',
    torrentSha256: 'ee57efcfdbe2bc9c6527d2ba4a5e8110a23d3cbb71825d096364dcaa7d518397',
    listenPort: 6891,
  },
  full: {
    id: 'full',
    title: 'Full vault',
    summary:
      'The original PDFs, EPUBs, and Markdown. Search the catalog and open a manual on this page.',
    sizeLabel: '103 GB',
    sizeBytes: 102_717_482_778,
    torrentUrl: 'https://files.trex-arms.com/vault/2026-11/FieldManualVault_2026-11.torrent',
    torrentSha256: 'e3bd94f1e1d2f0ba40007718fdb52a863379f8333f74a2007c7caaf381204bb9',
    listenPort: 6892,
  },
}

export const FIELD_MANUAL_EDITION_IDS = ['zim', 'full'] as const satisfies readonly FieldManualEditionId[]
