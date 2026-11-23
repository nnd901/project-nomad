const ARIA2_STATUSES = ['active', 'waiting', 'paused', 'error', 'complete', 'removed'] as const

export type Aria2DownloadState = (typeof ARIA2_STATUSES)[number]

export interface Aria2DownloadStatus {
  gid: string
  status: Aria2DownloadState
  completedLength: number
  totalLength: number
  downloadSpeed: number
  numSeeders: number
  connections: number
  errorMessage: string
  dir: string
}

export interface FieldManualTransfer {
  percent: number
  downloadedBytes: number
  totalBytes: number
  downloadSpeed: number
  seeders: number
  peers: number
}

export function parseAria2Status(value: unknown): Aria2DownloadStatus | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.gid !== 'string' || typeof raw.status !== 'string') return null
  if (!ARIA2_STATUSES.includes(raw.status as Aria2DownloadState)) return null
  return {
    gid: raw.gid,
    status: raw.status as Aria2DownloadState,
    completedLength: numberField(raw.completedLength),
    totalLength: numberField(raw.totalLength),
    downloadSpeed: numberField(raw.downloadSpeed),
    numSeeders: numberField(raw.numSeeders),
    connections: numberField(raw.connections),
    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : '',
    dir: typeof raw.dir === 'string' ? raw.dir : '',
  }
}

export function transferFromStatus(
  status: Pick<Aria2DownloadStatus, 'completedLength' | 'totalLength' | 'downloadSpeed' | 'numSeeders' | 'connections'>,
  fallbackTotal: number
): FieldManualTransfer {
  const totalBytes = status.totalLength > 0 ? status.totalLength : fallbackTotal
  const downloadedBytes = status.completedLength
  const percent =
    totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : 0
  return {
    percent,
    downloadedBytes,
    totalBytes,
    downloadSpeed: status.downloadSpeed,
    seeders: status.numSeeders,
    peers: status.connections,
  }
}

function numberField(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}
