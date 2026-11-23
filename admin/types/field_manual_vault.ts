export type FieldManualEditionId = 'zim' | 'full'

export type FieldManualFormat = 'pdf' | 'epub' | 'md'

export interface FieldManualEditionStatus {
  id: FieldManualEditionId
  title: string
  summary: string
  sizeLabel: string
  sizeBytes: number
  installed: boolean
  downloading: boolean
  /** Paused by a cancel. The partial stays on disk and the next start resumes it. */
  paused: boolean
  queued: boolean
  progress: number
  downloadedBytes: number
  totalBytes: number
  downloadSpeed: number
  seeders: number
  peers: number
  /** Set when the last attempt failed. A user cancel leaves this empty. */
  error: string | null
}

export interface FieldManualStatus {
  release: string
  sourceUrl: string
  aria2Available: boolean
  kiwixInstalled: boolean
  kiwixLocation: string | null
  kiwixCustomUrl: string | null
  editions: FieldManualEditionStatus[]
}

export interface FieldManualHit {
  id: string
  designation: string
  title: string
  editionDate: string
  status: string
  family: string
  branch: string
  pubType: string
  formats: FieldManualFormat[]
}

export interface FieldManualSearchResult {
  installed: boolean
  total: number
  manuals: FieldManualHit[]
  facets: {
    families: string[]
    branches: string[]
    pubTypes: string[]
  }
}
