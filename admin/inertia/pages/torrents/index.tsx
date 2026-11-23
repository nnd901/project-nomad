import { useState } from 'react'
import { Head, Link } from '@inertiajs/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconMagnet } from '@tabler/icons-react'
import AppLayout from '~/layouts/AppLayout'
import StyledButton from '~/components/StyledButton'
import api from '~/lib/api'
import { formatBytes } from '~/lib/util'
import type { TorrentDownload, TorrentDownloadState, TorrentPageStatus } from '../../../types/torrent_download'

const CARD =
  'rounded-2xl border border-desert-stone-lighter/60 bg-desert-white p-5 ' +
  'shadow-[0_1px_2px_rgba(66,68,32,0.04),0_8px_24px_-12px_rgba(66,68,32,0.12)]'
const FIELD =
  'w-full rounded-lg border border-desert-stone-lighter bg-desert-white px-3 py-2 text-text-primary'

export default function TorrentsPage(props: { status: TorrentPageStatus }) {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['torrents-status'],
    queryFn: () => api.torrentStatus(),
    placeholderData: props.status,
    refetchInterval: (query) =>
      query.state.data?.downloads.some((item) => item.state === 'active' || item.state === 'waiting')
        ? 2000
        : false,
  })
  const status = statusQuery.data ?? props.status
  const [source, setSource] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['torrents-status'] })
  }

  async function start() {
    if (busy === 'add') return
    if (!file && source.trim().length === 0) {
      setActionError('Paste a magnet link, a URL, or choose a torrent file.')
      return
    }
    setBusy('add')
    setActionError(null)
    const result = file ? await api.torrentUpload(file) : await api.torrentAdd(source.trim())
    setBusy(null)
    if (!result.success) {
      setActionError(result.message)
      setActionNote(null)
      return
    }
    setSource('')
    setFile(null)
    setFileKey((key) => key + 1)
    setActionNote(result.message)
    await refresh()
  }

  async function run(id: string, action: 'pause' | 'resume' | 'remove') {
    setBusy(id)
    setActionError(null)
    const result =
      action === 'pause'
        ? await api.torrentPause(id)
        : action === 'resume'
          ? await api.torrentResume(id)
          : await api.torrentRemove(id)
    setBusy(null)
    setConfirmRemove(null)
    if (!result.success) {
      setActionError(result.message)
      setActionNote(null)
    } else {
      setActionNote(result.message)
    }
    await refresh()
  }

  return (
    <AppLayout compact>
      <Head title="Torrents | Project NOMAD" />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary">Torrents</h1>
          <p className="mt-2 max-w-3xl text-text-secondary">
            Add a magnet link, a URL, or a torrent file. The download runs in its own container and
            the files stay on this NOMAD until you remove them. The{' '}
            <Link href="/field-manuals" className="text-desert-green underline">
              Field Manual Vault
            </Link>{' '}
            is still its own page.
          </p>
        </div>

        {!status.available && (
          <p className="rounded-lg border border-desert-orange bg-desert-orange/10 px-4 py-3 text-text-primary">
            The download service is a separate container, and it is not running. Start NOMAD again
            so that container comes up.
          </p>
        )}
        {status.catalogError && <p className="text-desert-red">{status.catalogError}</p>}
        {actionError && <p className="text-desert-red">{actionError}</p>}
        {actionNote && <p className="text-text-secondary">{actionNote}</p>}

        <form
          className={CARD}
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <div className="mb-3 flex items-center gap-3">
            <IconMagnet className="size-8 text-desert-green" />
            <h2 className="text-xl font-semibold text-text-primary">Add a torrent</h2>
          </div>
          <label className="mb-3 block text-sm text-text-secondary">
            Magnet link or URL
            <input
              className={`${FIELD} mt-1`}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="magnet:?xt=urn:btih:… or https://…"
              disabled={busy === 'add'}
            />
          </label>
          <label className="mb-4 block text-sm text-text-secondary">
            Or choose a .torrent file
            <input
              key={fileKey}
              className="mt-1 block w-full text-text-primary"
              type="file"
              accept=".torrent,application/x-bittorrent"
              disabled={busy === 'add'}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <StyledButton
            icon="IconDownload"
            loading={busy === 'add'}
            disabled={!status.available || (!file && source.trim().length === 0)}
            onClick={() => void start()}
          >
            Start download
          </StyledButton>
        </form>

        {status.downloads.length === 0 ? (
          <p className="text-text-secondary">No torrents yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {status.downloads.map((download) => (
              <TorrentCard
                key={download.id}
                download={download}
                busy={busy === download.id}
                confirmRemove={confirmRemove === download.id}
                onPause={() => run(download.id, 'pause')}
                onResume={() => run(download.id, 'resume')}
                onAskRemove={() => setConfirmRemove(download.id)}
                onKeep={() => setConfirmRemove(null)}
                onRemove={() => run(download.id, 'remove')}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  )
}

function TorrentCard(props: {
  download: TorrentDownload
  busy: boolean
  confirmRemove: boolean
  onPause: () => void
  onResume: () => void
  onAskRemove: () => void
  onKeep: () => void
  onRemove: () => void
}) {
  const { download } = props
  const running = download.state === 'active' || download.state === 'waiting'
  const showBar = running || download.state === 'paused'

  return (
    <section className={CARD}>
      <h2 className="text-xl font-semibold text-text-primary">{download.name}</h2>
      {showBar && (
        <div className="mt-3" role="status">
          <div className="mb-1 flex justify-between text-sm text-text-secondary">
            <span>{stateLabel(download)}</span>
            <span>
              {formatBytes(download.downloadedBytes)} / {formatBytes(download.totalBytes)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-desert-sand">
            <div className="h-2 bg-desert-green" style={{ width: `${download.progress}%` }} />
          </div>
          {download.state === 'active' && (
            <p className="mt-1 text-sm text-text-secondary">
              {formatBytes(download.downloadSpeed)}/s · {download.seeders}{' '}
              {download.seeders === 1 ? 'seed' : 'seeds'}
            </p>
          )}
        </div>
      )}
      {!showBar && <p className="mt-2 text-sm text-text-secondary">{stateLabel(download)}</p>}
      {download.error && <p className="mt-2 text-sm text-desert-red">{download.error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {running && (
          <StyledButton variant="outline" loading={props.busy} onClick={props.onPause}>
            Pause
          </StyledButton>
        )}
        {(download.state === 'paused' || download.state === 'stopped' || download.state === 'error') && (
          <StyledButton icon="IconDownload" loading={props.busy} onClick={props.onResume}>
            Resume
          </StyledButton>
        )}
        {props.confirmRemove ? (
          <>
            <StyledButton variant="danger" loading={props.busy} onClick={props.onRemove}>
              Remove files
            </StyledButton>
            <StyledButton variant="outline" disabled={props.busy} onClick={props.onKeep}>
              Keep
            </StyledButton>
          </>
        ) : (
          <StyledButton variant="outline" icon="IconTrash" onClick={props.onAskRemove}>
            Remove
          </StyledButton>
        )}
      </div>
    </section>
  )
}

function stateLabel(download: TorrentDownload): string {
  const state: TorrentDownloadState = download.state
  switch (state) {
    case 'active':
      return download.seeders === 0 && download.downloadSpeed === 0
        ? 'Waiting for a seed'
        : `${download.progress}%`
    case 'waiting':
      return 'Waiting to start'
    case 'paused':
      return 'Paused'
    case 'error':
      return 'Failed'
    case 'complete':
      return 'Complete'
    case 'stopped':
      return 'Stopped'
    default: {
      const unreachable: never = state
      return unreachable
    }
  }
}
