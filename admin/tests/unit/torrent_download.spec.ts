import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import { fieldManualHomeNote } from '../../app/utils/field_manual_tile.js'
import { parseTorrentCatalog, serializeTorrentCatalog } from '../../app/utils/torrent_catalog.js'
import { classifyTorrentSource, publicTorrentUrl, torrentDisplayName } from '../../app/utils/torrent_source.js'
import { torrentHomeNote } from '../../app/utils/torrent_tile.js'
import type { TorrentDownload } from '../../types/torrent_download.js'
import type { FieldManualEditionStatus } from '../../types/field_manual_vault.js'

test('classifyTorrentSource accepts a magnet and a public URL', () => {
  const magnet = classifyTorrentSource(
    'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Field+Notes'
  )
  assert.equal(magnet?.kind, 'magnet')
  if (magnet?.kind !== 'magnet') return
  assert.equal(magnet.name, 'Field Notes')

  assert.equal(
    publicTorrentUrl('https://files.example.com/vault.torrent'),
    'https://files.example.com/vault.torrent'
  )
  assert.equal(classifyTorrentSource('https://10.1.1.1/secret.torrent'), null)
  assert.equal(classifyTorrentSource('http://127.0.0.1/a.torrent'), null)
  assert.equal(classifyTorrentSource('http://localhost/a.torrent'), null)
  assert.equal(classifyTorrentSource('not a torrent'), null)
})

test('torrentDisplayName drops control characters', () => {
  assert.equal(torrentDisplayName(' hello\u0000 world '), 'hello world')
  assert.equal(torrentDisplayName('   '), 'Torrent')
})

test('parseTorrentCatalog keeps a stored download and rejects a bad id', () => {
  const stored = {
    id: '0123456789abcdef',
    name: 'Notes',
    gid: '2089b0',
    magnet: null,
    addedAt: '2026-11-23T00:00:00.000Z',
  }
  const text = serializeTorrentCatalog([stored])
  assert.deepEqual(parseTorrentCatalog(text), [stored])
  assert.throws(() =>
    parseTorrentCatalog(JSON.stringify({ downloads: [{ ...stored, id: '../escape' }] }))
  )
})

test('fieldManualHomeNote reports an unfinished vault download and hides a finished one', () => {
  const zim = edition({ id: 'zim', title: 'Kiwix ZIM', downloading: true, progress: 0, seeders: 0 })
  const full = edition({ id: 'full', title: 'Full vault', installed: true, downloading: false })
  assert.equal(fieldManualHomeNote([zim, full]), 'Kiwix ZIM waiting for a seed')
  assert.equal(
    fieldManualHomeNote([edition({ id: 'zim', title: 'Kiwix ZIM', paused: true, progress: 12 })]),
    'Kiwix ZIM paused at 12%'
  )
  assert.equal(fieldManualHomeNote([edition({ id: 'full', installed: true })]), null)
})

test('torrentHomeNote reports an unfinished torrent and hides a finished one', () => {
  assert.equal(
    torrentHomeNote([torrent({ state: 'active', seeders: 0, downloadSpeed: 0 })]),
    'Notes waiting for a seed'
  )
  assert.equal(torrentHomeNote([torrent({ state: 'complete', progress: 100 })]), null)
})

function torrent(overrides: Partial<TorrentDownload>): TorrentDownload {
  return {
    id: '0123456789abcdef',
    name: 'Notes',
    state: overrides.state ?? 'stopped',
    progress: overrides.progress ?? 0,
    downloadedBytes: 0,
    totalBytes: 1,
    downloadSpeed: overrides.downloadSpeed ?? 0,
    seeders: overrides.seeders ?? 0,
    peers: 0,
    error: null,
    addedAt: '2026-11-23T00:00:00.000Z',
  }
}

function edition(overrides: Partial<FieldManualEditionStatus> & Pick<FieldManualEditionStatus, 'id'>): FieldManualEditionStatus {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    summary: '',
    sizeLabel: '1 GB',
    sizeBytes: 1,
    installed: overrides.installed ?? false,
    downloading: overrides.downloading ?? false,
    paused: overrides.paused ?? false,
    queued: overrides.queued ?? false,
    progress: overrides.progress ?? 0,
    downloadedBytes: 0,
    totalBytes: 1,
    downloadSpeed: overrides.downloadSpeed ?? 0,
    seeders: overrides.seeders ?? 0,
    peers: 0,
    error: overrides.error ?? null,
  }
}
