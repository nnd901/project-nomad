import type { TorrentDownload, TorrentDownloadState } from '../../types/torrent_download.js'

/** One line for the home tile while a user torrent is still unfinished. */
export function torrentHomeNote(downloads: TorrentDownload[]): string | null {
  const unfinished = downloads.filter((download) => download.state !== 'complete')
  const first = unfinished[0]
  if (!first) return null
  const extra = unfinished.length > 1 ? ` · ${unfinished.length - 1} more` : ''
  return `${shortName(first.name)} ${detail(first)}${extra}`
}

function detail(download: TorrentDownload): string {
  const state: TorrentDownloadState = download.state
  switch (state) {
    case 'active':
      return download.seeders === 0 && download.downloadSpeed === 0
        ? 'waiting for a seed'
        : `${download.progress}%`
    case 'waiting':
      return 'queued'
    case 'paused':
      return `paused at ${download.progress}%`
    case 'error':
      return 'failed'
    case 'stopped':
      return 'stopped'
    case 'complete':
      return 'complete'
    default: {
      const unreachable: never = state
      return unreachable
    }
  }
}

function shortName(name: string): string {
  return name.length > 40 ? `${name.slice(0, 39)}…` : name
}
