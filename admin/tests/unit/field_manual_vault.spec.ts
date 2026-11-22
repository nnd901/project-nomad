import * as assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import { test } from 'node:test'

import { decodeBencode } from '../../app/utils/bencode.js'
import {
  aria2ContentFileIndexes,
  filterVaultManuals,
  isInside,
  locateZippedEntry,
  parseAria2Progress,
  parseVaultIndex,
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

test('resolveInside stays under the vault root', () => {
  const root = resolve('/tmp/vault-root')
  assert.equal(resolveInside(root, 'PDF/a.zip'), `${root}${sep}PDF${sep}a.zip`)
  assert.equal(resolveInside(root, '../outside'), null)
  assert.equal(isInside(root, `${root}${sep}PDF`), true)
  assert.equal(isInside(root, `${root}-other`), false)
})
