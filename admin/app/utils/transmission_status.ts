const TRANSMISSION_CODES = [0, 1, 2, 3, 4, 5, 6] as const

type TransmissionCode = (typeof TRANSMISSION_CODES)[number]

export type TransmissionState = 'active' | 'waiting' | 'paused' | 'error' | 'complete'

export interface TransmissionTorrent {
  hash: string
  status: TransmissionState
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

export function parseTransmissionTorrent(value: unknown): TransmissionTorrent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.hashString !== 'string') return null
  const code = typeof raw.status === 'number' ? raw.status : Number(raw.status)
  if (!isTransmissionCode(code)) return null
  const totalLength = countField(raw.sizeWhenDone)
  const left = countField(raw.leftUntilDone)
  const errorCode = typeof raw.error === 'number' ? raw.error : 0
  return {
    hash: raw.hashString.toLowerCase(),
    status: transmissionState(code, totalLength, left, errorCode),
    completedLength: Math.max(0, totalLength - left),
    totalLength,
    downloadSpeed: countField(raw.rateDownload),
    numSeeders: seederCount(raw.trackerStats),
    connections: countField(raw.peersConnected),
    errorMessage: typeof raw.errorString === 'string' ? raw.errorString : '',
    dir: typeof raw.downloadDir === 'string' ? raw.downloadDir.replace(/\/+$/, '') : '',
  }
}

export function transferFromStatus(
  status: Pick<TransmissionTorrent, 'completedLength' | 'totalLength' | 'downloadSpeed' | 'numSeeders' | 'connections'>,
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

function transmissionState(
  code: TransmissionCode,
  totalLength: number,
  leftUntilDone: number,
  errorCode: number
): TransmissionState {
  if (errorCode === 3) return 'error'
  switch (code) {
    case 0:
      return totalLength > 0 && leftUntilDone === 0 ? 'complete' : 'paused'
    case 1:
    case 3:
      return 'waiting'
    case 2:
    case 4:
      return 'active'
    case 5:
    case 6:
      return 'complete'
    default: {
      const unreachable: never = code
      throw new Error(`Unexpected transmission status ${String(unreachable)}`)
    }
  }
}

function isTransmissionCode(value: number): value is TransmissionCode {
  return TRANSMISSION_CODES.includes(value as TransmissionCode)
}

function seederCount(value: unknown): number {
  if (!Array.isArray(value)) return 0
  let max = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const count = countField((item as { seederCount?: unknown }).seederCount)
    if (count > max) max = count
  }
  return max
}

function countField(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}
