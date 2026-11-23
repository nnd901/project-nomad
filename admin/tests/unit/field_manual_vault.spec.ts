import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'

import { parseAria2Status, transferFromStatus } from '../../app/utils/aria2_status.js'
import { decodeBencode } from '../../app/utils/bencode.js'
import {
  aria2ContentFileIndexes,
  filterVaultManuals,
  isInside,
  locateZippedEntry,
  matchZipEntry,
  parseAria2Progress,
  parseVaultIndex,
  removeVaultDownloadDebris,
  resolveInside,
  safeTorrentDirectoryName,
} from '../../app/utils/field_manual_vault.js'

test('decodeBencode reads a dictionary of a string and an integer', () => {
  const decoded = decodeBencode(Buffer.from('d4:name5:hello6:lengthi42ee'))
  assert.equal(typeof decoded, 'object')
  if (typeof decoded !== 'object' || Buffer.isBuffer(decoded) || Array.isArray(decoded)) return
  assert.equal((decoded.name as Buffer).toString(), 'hello')
  assert.equal(decoded.length, 42)
})

test('aria2 content indexes skip padding and parity files', () => {
  assert.deepEqual(
    aria2ContentFileIndexes([
      { path: '.pad/386988' },
      { path: 'PDF/Doctrine & Field Manuals/Aviation.zip' },
      { path: 'PDF/Doctrine & Field Manuals/Aviation.zip.par2' },
      { path: 'index.csv' },
    ]),
    [2, 4]
  )
})

test('safeTorrentDirectoryName rejects path segments', () => {
  assert.equal(safeTorrentDirectoryName('T.Rex Arms Field Manual Vault'), 'T.Rex Arms Field Manual Vault')
  assert.throws(() => safeTorrentDirectoryName('../vault'))
  assert.throws(() => safeTorrentDirectoryName('a/b'))
})

test('parseAria2Progress reads a human-readable summary line', () => {
  const progress = parseAria2Progress(
    '[#2089b0 400.0KiB/21.8GiB(2%) CN:1 SD:0 DL:44.2KiB ETA:12h]'
  )
  assert.ok(progress)
  assert.equal(progress?.percent, 2)
  assert.equal(progress?.downloadedBytes, 400 * 1024)
  assert.equal(progress?.totalBytes, Math.round(21.8 * 1024 ** 3))
})

test('parseAria2Progress ignores chatter', () => {
  assert.equal(parseAria2Progress('Downloading 1 item(s)'), null)
})

test('parseAria2Status reads string lengths from a tellStatus result', () => {
  const status = parseAria2Status({
    gid: '2089b0',
    status: 'active',
    completedLength: '0',
    totalLength: '21790280469',
    downloadSpeed: '0',
    numSeeders: '0',
    connections: '1',
    dir: '/app/storage/field-manuals/zim-staging',
    errorMessage: '',
  })
  assert.ok(status)
  if (!status) return
  assert.equal(status.status, 'active')
  assert.equal(status.totalLength, 21790280469)
  const transfer = transferFromStatus(status, 1)
  assert.equal(transfer.percent, 0)
  assert.equal(transfer.totalBytes, 21790280469)
  assert.equal(transfer.seeders, 0)
  assert.equal(transfer.peers, 1)
})

test('parseAria2Status rejects an unknown status', () => {
  assert.equal(parseAria2Status({ gid: '2089b0', status: 'seeding' }), null)
})

test('parseVaultIndex keeps commas that sit inside quotes', () => {
  const csv = [
    'id,designation,title,edition_date,status,collection,branch,pub_type,family,group,pdf_path,epub_path,md_path',
    'fm-1,FM 1,"Hello, world",2020-01,current,recent,army,FM,Doctrine & Field Manuals,Infantry,PDF/Doctrine & Field Manuals/Infantry.zip/Hello.pdf,EPUB/Doctrine & Field Manuals/Infantry.zip/Hello.epub,',
  ].join('\n')
  const records = parseVaultIndex(csv)
  assert.equal(records.length, 1)
  assert.equal(records[0].title, 'Hello, world')
  assert.equal(records[0].family, 'Doctrine & Field Manuals')
  assert.equal(records[0].mdPath, '')
  assert.equal(records[0].pdfPath, 'PDF/Doctrine & Field Manuals/Infantry.zip/Hello.pdf')
})

test('filterVaultManuals matches a title and a category', () => {
  const records = parseVaultIndex(
    [
      'id,designation,title,edition_date,status,collection,branch,pub_type,family,group,pdf_path,epub_path,md_path',
      'a,FM 1,Rifle Platoon,2020-01,current,recent,army,FM,Doctrine & Field Manuals,Infantry,PDF/a.zip/a.pdf,,',
      'b,TM 2,Radio Set,2019-01,current,recent,army,TM,Technical & Equipment Manuals,Signal,PDF/b.zip/b.pdf,,',
    ].join('\n')
  )
  const filtered = filterVaultManuals(records, { q: 'rifle', family: 'Doctrine & Field Manuals' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.records[0].id, 'a')
})

test('locateZippedEntry splits the zip from the entry and rejects traversal', () => {
  assert.deepEqual(locateZippedEntry('PDF/Cat/CIA.zip/file name.pdf'), {
    zipRelative: 'PDF/Cat/CIA.zip',
    entryName: 'file name.pdf',
  })
  assert.equal(locateZippedEntry('../etc/passwd'), null)
  assert.equal(locateZippedEntry('PDF/a.zip/../../etc/passwd'), null)
  assert.equal(locateZippedEntry('/etc/passwd'), null)
})

test('matchZipEntry prefers the full in-zip path and refuses ambiguous file names', () => {
  assert.deepEqual(matchZipEntry(['nested/A/intro.pdf', 'A/intro.pdf'], 'A/intro.pdf'), {
    kind: 'match',
    name: 'A/intro.pdf',
  })
  assert.deepEqual(matchZipEntry(['docs/Hello.pdf'], 'Hello.pdf'), {
    kind: 'match',
    name: 'docs/Hello.pdf',
  })
  assert.deepEqual(matchZipEntry(['Hello.pdf', 'docs/Hello.pdf'], 'Hello.pdf'), {
    kind: 'match',
    name: 'Hello.pdf',
  })
  assert.deepEqual(matchZipEntry(['A/intro.pdf', 'B/intro.pdf'], 'intro.pdf'), { kind: 'ambiguous' })
  assert.deepEqual(matchZipEntry(['A/notintro.pdf'], 'intro.pdf'), { kind: 'missing' })
  assert.deepEqual(matchZipEntry(['nested/A/intro.pdf'], 'A/intro.pdf'), { kind: 'missing' })
  assert.deepEqual(matchZipEntry(['A\\intro.pdf'], 'A/intro.pdf'), { kind: 'match', name: 'A/intro.pdf' })
})

test('removeVaultDownloadDebris keeps manuals and drops aria2 leftovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nomad-vault-debris-'))
  try {
    await mkdir(join(root, 'PDF', 'sub'), { recursive: true })
    await mkdir(join(root, '.pad'), { recursive: true })
    await writeFile(join(root, 'index.csv'), 'id\n')
    await writeFile(join(root, 'PDF', 'Aviation.zip'), 'zip')
    await writeFile(join(root, 'PDF', 'Aviation.zip.aria2'), 'control')
    await writeFile(join(root, 'PDF', 'Aviation.zip.par2'), 'parity')
    await writeFile(join(root, 'PDF', 'sub', 'manual.zip'), 'zip')
    await writeFile(join(root, 'PDF', 'sub', 'manual.zip.aria2'), 'control')
    await writeFile(join(root, '.pad', '386988'), 'pad')

    await removeVaultDownloadDebris(root)

    assert.equal(await readFile(join(root, 'index.csv'), 'utf8'), 'id\n')
    assert.equal(await readFile(join(root, 'PDF', 'Aviation.zip'), 'utf8'), 'zip')
    assert.equal(await readFile(join(root, 'PDF', 'sub', 'manual.zip'), 'utf8'), 'zip')
    await assert.rejects(() => stat(join(root, 'PDF', 'Aviation.zip.aria2')))
    await assert.rejects(() => stat(join(root, 'PDF', 'Aviation.zip.par2')))
    await assert.rejects(() => stat(join(root, 'PDF', 'sub', 'manual.zip.aria2')))
    await assert.rejects(() => stat(join(root, '.pad')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveInside stays under the vault root', () => {
  const root = resolve('/tmp/vault-root')
  assert.equal(resolveInside(root, 'PDF/a.zip'), `${root}${sep}PDF${sep}a.zip`)
  assert.equal(resolveInside(root, '../outside'), null)
  assert.equal(isInside(root, `${root}${sep}PDF`), true)
  assert.equal(isInside(root, `${root}-other`), false)
})
