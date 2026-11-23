export type TorrentDownloadState =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'error'
  | 'complete'
  | 'stopped'

export interface TorrentDownload {
  id: string
  name: string
  state: TorrentDownloadState
  progress: number
  downloadedBytes: number
  totalBytes: number
  downloadSpeed: number
  seeders: number
  peers: number
  error: string | null
  addedAt: string
}

export interface TorrentPageStatus {
  available: boolean
  catalogError: string | null
  downloads: TorrentDownload[]
}

export interface StoredTorrent {
  id: string
  name: string
  gid: string | null
  magnet: string | null
  addedAt: string
}
