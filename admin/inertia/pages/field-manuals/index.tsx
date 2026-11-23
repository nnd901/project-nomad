import { useEffect, useState } from 'react'
import { Head } from '@inertiajs/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { IconBook, IconBooks, IconSearch } from '@tabler/icons-react'
import AppLayout from '~/layouts/AppLayout'
import StyledButton from '~/components/StyledButton'
import api from '~/lib/api'
import { formatBytes } from '~/lib/util'
import { getServiceLink } from '~/lib/navigation'
import type {
  FieldManualEditionId,
  FieldManualEditionStatus,
  FieldManualFormat,
  FieldManualHit,
  FieldManualStatus,
} from '../../../types/field_manual_vault'

const PAGE_SIZE = 40
const CARD =
  'rounded-2xl border border-desert-stone-lighter/60 bg-desert-white p-5 ' +
  'shadow-[0_1px_2px_rgba(66,68,32,0.04),0_8px_24px_-12px_rgba(66,68,32,0.12)]'
const FIELD =
  'w-full rounded-lg border border-desert-stone-lighter bg-desert-white px-3 py-2 text-text-primary'

const FORMAT_LABEL: Record<FieldManualFormat, string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  md: 'Markdown',
}

export default function FieldManualsPage(props: { status: FieldManualStatus }) {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['field-manuals-status'],
    queryFn: () => api.fieldManualStatus(),
    placeholderData: props.status,
    refetchInterval: (query) =>
      query.state.data?.editions.some((edition) => edition.downloading) ? 2000 : false,
  })
  const status = statusQuery.data ?? props.status
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<FieldManualEditionId | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<FieldManualEditionId | null>(null)

  const full = status.editions.find((edition) => edition.id === 'full')
  const libraryHref =
    status.kiwixInstalled && status.kiwixLocation
      ? getServiceLink(status.kiwixLocation, status.kiwixCustomUrl)
      : null

  async function run(edition: FieldManualEditionId, action: 'download' | 'cancel' | 'remove') {
    setBusy(edition)
    setActionError(null)
    const result =
      action === 'download'
        ? await api.fieldManualDownload(edition)
        : action === 'cancel'
          ? await api.fieldManualCancel(edition)
          : await api.fieldManualRemove(edition)
    setBusy(null)
    setConfirmRemove(null)
    if (!result.success) {
      setActionError(result.message)
      setActionNote(null)
    } else {
      setActionError(null)
      setActionNote(result.message)
    }
    await queryClient.invalidateQueries({ queryKey: ['field-manuals-status'] })
    if (action === 'remove') {
      await queryClient.invalidateQueries({ queryKey: ['field-manuals-search'] })
    }
  }

  return (
    <AppLayout compact>
      <Head title="Field Manuals | Project NOMAD" />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary">Field Manual Vault</h1>
          <p className="mt-2 max-w-3xl text-text-secondary">
            Download the T.REX Arms military manuals and read them offline. Choose the Kiwix ZIM,
            the full archive, or both. Release {status.release}.{' '}
            <a
              href={status.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-desert-green underline"
            >
              Source
            </a>
          </p>
        </div>

        {!status.aria2Available && (
          <p className="rounded-lg border border-desert-orange bg-desert-orange/10 px-4 py-3 text-text-primary">
            The download service is a separate container, and it is not running. Start NOMAD again
            so that container comes up.
          </p>
        )}

        {actionError && <p className="text-desert-red">{actionError}</p>}
        {actionNote && <p className="text-text-secondary">{actionNote}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          {status.editions.map((edition) => (
            <EditionCard
              key={edition.id}
              edition={edition}
              busy={busy === edition.id}
              confirmRemove={confirmRemove === edition.id}
              aria2Available={status.aria2Available}
              libraryHref={edition.id === 'zim' ? libraryHref : null}
              kiwixInstalled={status.kiwixInstalled}
              onDownload={() => run(edition.id, 'download')}
              onCancel={() => run(edition.id, 'cancel')}
              onAskRemove={() => setConfirmRemove(edition.id)}
              onKeep={() => setConfirmRemove(null)}
              onRemove={() => run(edition.id, 'remove')}
            />
          ))}
        </div>

        {full?.installed && <VaultBrowser />}
      </div>
    </AppLayout>
  )
}

function EditionCard(props: {
  edition: FieldManualEditionStatus
  busy: boolean
  confirmRemove: boolean
  aria2Available: boolean
  libraryHref: string | null
  kiwixInstalled: boolean
  onDownload: () => void
  onCancel: () => void
  onAskRemove: () => void
  onKeep: () => void
  onRemove: () => void
}) {
  const { edition } = props
  const Icon = edition.id === 'zim' ? IconBooks : IconBook
  const total = edition.totalBytes || edition.sizeBytes

  return (
    <section className={CARD}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{edition.title}</h2>
          <p className="text-sm font-medium text-desert-green">{edition.sizeLabel}</p>
        </div>
        <Icon className="size-8 shrink-0 text-desert-green" />
      </div>
      <p className="mb-4 text-text-secondary">{edition.summary}</p>

      {edition.installed && <p className="mb-3 text-sm font-semibold text-desert-green">On disk</p>}

      {(edition.downloading || edition.paused) && (
        <div className="mb-4" role="status">
          <div className="mb-1 flex justify-between text-sm text-text-secondary">
            <span>
              {edition.paused
                ? 'Paused'
                : edition.queued
                  ? 'Waiting to start'
                  : edition.seeders === 0 && edition.downloadSpeed === 0
                    ? 'Waiting for a seed'
                    : `${edition.progress}%`}
            </span>
            {!edition.queued && (
              <span>
                {formatBytes(edition.downloadedBytes)} / {formatBytes(total)}
              </span>
            )}
          </div>
          <div className="h-2 overflow-hidden rounded bg-desert-sand">
            <div className="h-2 bg-desert-green" style={{ width: `${edition.progress}%` }} />
          </div>
          {edition.downloading && !edition.queued && (
            <p className="mt-1 text-sm text-text-secondary">
              {formatBytes(edition.downloadSpeed)}/s · {edition.seeders}{' '}
              {edition.seeders === 1 ? 'seed' : 'seeds'}
            </p>
          )}
        </div>
      )}

      {edition.error && <p className="mb-3 text-sm text-desert-red">{edition.error}</p>}

      <div className="flex flex-wrap gap-2">
        {edition.downloading ? (
          <StyledButton variant="outline" loading={props.busy} onClick={props.onCancel}>
            Cancel
          </StyledButton>
        ) : edition.installed ? (
          props.confirmRemove ? (
            <>
              <StyledButton variant="danger" loading={props.busy} onClick={props.onRemove}>
                Remove
              </StyledButton>
              <StyledButton variant="outline" disabled={props.busy} onClick={props.onKeep}>
                Keep
              </StyledButton>
            </>
          ) : (
            <>
              {edition.id === 'zim' && props.libraryHref && (
                <StyledButton
                  icon="IconExternalLink"
                  onClick={() => window.open(props.libraryHref!, '_blank', 'noopener')}
                >
                  Open Information Library
                </StyledButton>
              )}
              {edition.id === 'zim' && !props.kiwixInstalled && (
                <StyledButton icon="IconBox" onClick={() => window.location.assign('/supply-depot')}>
                  Install Information Library
                </StyledButton>
              )}
              <StyledButton variant="outline" icon="IconTrash" onClick={props.onAskRemove}>
                Remove
              </StyledButton>
            </>
          )
        ) : (
          <StyledButton
            icon="IconDownload"
            loading={props.busy}
            disabled={!props.aria2Available}
            onClick={props.onDownload}
          >
            {edition.error || edition.paused ? 'Resume download' : `Download ${edition.title}`}
          </StyledButton>
        )}
      </div>
    </section>
  )
}

function VaultBrowser() {
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [family, setFamily] = useState('')
  const [branch, setBranch] = useState('')
  const [pubType, setPubType] = useState('')
  const [offset, setOffset] = useState(0)
  const [reading, setReading] = useState<{ title: string; body: string } | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qInput)
      setOffset(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [qInput])

  const search = useQuery({
    queryKey: ['field-manuals-search', q, family, branch, pubType, offset],
    queryFn: () =>
      api.fieldManualSearch({
        q,
        family: family || undefined,
        branch: branch || undefined,
        pubType: pubType || undefined,
        offset,
        limit: PAGE_SIZE,
      }),
  })

  const result = search.data
  const from = result && result.total > 0 ? offset + 1 : 0
  const to = result ? Math.min(offset + PAGE_SIZE, result.total) : 0

  async function openManual(manual: FieldManualHit, format: FieldManualFormat) {
    const url = `/field-manuals/open/${encodeURIComponent(manual.id)}?format=${format}`
    if (format !== 'md') {
      window.open(url, '_blank', 'noopener')
      return
    }
    setReadError(null)
    const response = await fetch(url)
    if (!response.ok) {
      setReadError('Could not open that Markdown file.')
      return
    }
    setReading({ title: manual.title || manual.designation, body: await response.text() })
  }

  return (
    <section className={CARD}>
      <h2 className="mb-4 text-xl font-semibold text-text-primary">Browse the full vault</h2>
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <label className="md:col-span-1">
          <span className="mb-1 block text-sm text-text-secondary">Search</span>
          <span className="relative block">
            <IconSearch className="pointer-events-none absolute left-2 top-2.5 size-4 text-text-secondary" />
            <input
              className={`${FIELD} pl-8`}
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="Title or designation"
            />
          </span>
        </label>
        <Filter
          label="Category"
          value={family}
          options={result?.facets.families ?? []}
          onChange={(value) => {
            setFamily(value)
            setOffset(0)
          }}
        />
        <Filter
          label="Branch"
          value={branch}
          options={result?.facets.branches ?? []}
          onChange={(value) => {
            setBranch(value)
            setOffset(0)
          }}
        />
        <Filter
          label="Type"
          value={pubType}
          options={result?.facets.pubTypes ?? []}
          onChange={(value) => {
            setPubType(value)
            setOffset(0)
          }}
        />
      </div>

      {search.isLoading && <p className="text-text-secondary">Loading the catalog…</p>}
      {search.isError && <p className="text-desert-red">Could not load the catalog.</p>}
      {readError && <p className="mb-3 text-desert-red">{readError}</p>}

      {result && result.total === 0 && <p className="text-text-secondary">No manuals match.</p>}

      <ul className="divide-y divide-desert-stone-lighter/70">
        {result?.manuals.map((manual) => (
          <li key={manual.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-sm text-text-secondary">
                {[manual.designation, manual.branch, manual.editionDate].filter(Boolean).join(' · ')}
              </p>
              <p className="font-medium text-text-primary">{manual.title || manual.designation}</p>
              <p className="text-sm text-text-secondary">
                {[manual.family, manual.status].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {manual.formats.map((format) => (
                <StyledButton key={format} size="sm" variant="outline" onClick={() => openManual(manual, format)}>
                  {FORMAT_LABEL[format]}
                </StyledButton>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {result && result.total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
          <span>
            {from}–{to} of {result.total}
          </span>
          <div className="flex gap-2">
            <StyledButton
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </StyledButton>
            <StyledButton
              size="sm"
              variant="outline"
              disabled={offset + PAGE_SIZE >= result.total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </StyledButton>
          </div>
        </div>
      )}

      {reading && (
        <article className="mt-6 max-h-[70vh] overflow-y-auto rounded-xl border border-desert-stone-lighter p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-text-primary">{reading.title}</h3>
            <StyledButton size="sm" variant="ghost" onClick={() => setReading(null)}>
              Close
            </StyledButton>
          </div>
          <div className="max-w-none text-text-primary [&_a]:text-desert-green [&_a]:underline [&_h1]:mb-2 [&_h1]:text-2xl [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_li]:ml-5 [&_li]:list-disc [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-desert-sand [&_pre]:p-3">
            <ReactMarkdown>{reading.body}</ReactMarkdown>
          </div>
        </article>
      )}
    </section>
  )
}

function Filter(props: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  return (
    <label>
      <span className="mb-1 block text-sm text-text-secondary">{props.label}</span>
      <select className={FIELD} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">Any</option>
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}
