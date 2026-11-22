import { readdir, rm, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { decodeBencode, type BencodeValue } from './bencode.js'
import type { FieldManualFormat } from '../../types/field_manual_vault.js'

export interface TorrentFile {
  path: string
  length: number
}

export interface VaultManualRecord {
  id: string
  designation: string
  title: string
  editionDate: string
  status: string
  collection: string
  branch: string
  pubType: string
  family: string
  group: string
  pdfPath: string
  epubPath: string
  mdPath: string
}

export interface Aria2Progress {
  downloadedBytes: number
  totalBytes: number
  percent: number
}

const BYTE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  TB: 1_000_000_000_000,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
}

const ARIA2_PROGRESS =
  /\[#[^\s\]]+\s+(?:SIZE:)?([\d.]+)([KMGT]i?B|B)\/([\d.]+)([KMGT]i?B|B)\((\d+)%\)/

const INDEX_COLUMNS = [
  'id',
  'designation',
  'title',
  'edition_date',
  'status',
  'collection',
  'branch',
  'pub_type',
  'family',
  'group',
  'pdf_path',
  'epub_path',
  'md_path',
] as const

/** Piece-alignment padding and parity volumes. The manuals themselves are the zip files. */
export function isVaultSideFile(filePath: string): boolean {
  return filePath.split('/').includes('.pad') || filePath.endsWith('.par2')
}

/** aria2 control files plus torrent padding and parity. These are not manuals. */
export function isVaultDownloadDebris(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name.endsWith('.aria2') || isVaultSideFile(normalized)
}

/**
 * Delete aria2 control files, parity volumes, and piece padding under `root`.
 * A leftover `.aria2` file makes the next run treat a finished download as incomplete.
 */
export async function removeVaultDownloadDebris(root: string): Promise<void> {
  await deleteDebrisUnder(root, root)
}

/** 1-based aria2 `--select-file` indexes for the files a reader actually opens. */
export function aria2ContentFileIndexes(files: Array<{ path: string }>): number[] {
  const indexes: number[] = []
  files.forEach((file, index) => {
    if (!isVaultSideFile(file.path)) indexes.push(index + 1)
  })
  return indexes
}

export function listTorrentFiles(buffer: Buffer): { name: string; files: TorrentFile[] } {
  const decoded = decodeBencode(buffer)
  const root = asDict(decoded)
  if (!root) throw new Error('Torrent is not a dictionary')
  const info = asDict(root.info)
  if (!info) throw new Error('Torrent is missing an info dictionary')

  const name = bufferText(info.name)
  if (!name) throw new Error('Torrent is missing a name')

  if (Array.isArray(info.files)) {
    const files = info.files.map((entry) => {
      const file = asDict(entry)
      if (!file || !Array.isArray(file.path) || typeof file.length !== 'number') {
        throw new Error('Torrent file entry is malformed')
      }
      const path = file.path.map((part) => {
        if (!Buffer.isBuffer(part)) throw new Error('Torrent path segment is not a string')
        return part.toString('utf8')
      })
      if (path.length === 0) throw new Error('Torrent file path is empty')
      return { path: path.join('/'), length: file.length }
    })
    return { name, files }
  }

  if (typeof info.length === 'number') {
    return { name, files: [{ path: name, length: info.length }] }
  }

  throw new Error('Torrent info has no files')
}

/** The torrent's display name is also the folder aria2 creates. Reject anything that is not one path segment. */
export function safeTorrentDirectoryName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`Refusing torrent directory name "${name}"`)
  }
  return name
}

export function parseAria2Progress(line: string): Aria2Progress | null {
  const match = ARIA2_PROGRESS.exec(line)
  if (!match) return null
  const downloadedBytes = toBytes(match[1], match[2])
  const totalBytes = toBytes(match[3], match[4])
  const percent = Number(match[5])
  if (!Number.isFinite(downloadedBytes) || !Number.isFinite(totalBytes) || !Number.isFinite(percent)) {
    return null
  }
  return { downloadedBytes, totalBytes, percent }
}

export function parseVaultIndex(text: string): VaultManualRecord[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''))
  if (rows.length === 0) return []

  const header = rows[0]
  const column = new Map(header.map((name, index) => [name, index]))
  for (const name of INDEX_COLUMNS) {
    if (!column.has(name)) throw new Error(`Vault index is missing the ${name} column`)
  }

  const cell = (row: string[], name: (typeof INDEX_COLUMNS)[number]) =>
    (row[column.get(name) ?? -1] ?? '').trim()

  const records: VaultManualRecord[] = []
  for (const row of rows.slice(1)) {
    const id = cell(row, 'id')
    if (!id) continue
    records.push({
      id,
      designation: cell(row, 'designation'),
      title: cell(row, 'title'),
      editionDate: cell(row, 'edition_date'),
      status: cell(row, 'status'),
      collection: cell(row, 'collection'),
      branch: cell(row, 'branch'),
      pubType: cell(row, 'pub_type'),
      family: cell(row, 'family'),
      group: cell(row, 'group'),
      pdfPath: cell(row, 'pdf_path'),
      epubPath: cell(row, 'epub_path'),
      mdPath: cell(row, 'md_path'),
    })
  }
  return records
}

export function manualFormats(record: VaultManualRecord): FieldManualFormat[] {
  const formats: FieldManualFormat[] = []
  if (record.pdfPath) formats.push('pdf')
  if (record.epubPath) formats.push('epub')
  if (record.mdPath) formats.push('md')
  return formats
}

export function manualArchivePath(record: VaultManualRecord, format: FieldManualFormat): string {
  switch (format) {
    case 'pdf':
      return record.pdfPath
    case 'epub':
      return record.epubPath
    case 'md':
      return record.mdPath
    default: {
      const unreachable: never = format
      return unreachable
    }
  }
}

export interface VaultSearchQuery {
  q?: string
  family?: string
  branch?: string
  pubType?: string
  offset?: number
  limit?: number
}

export function filterVaultManuals(
  records: VaultManualRecord[],
  query: VaultSearchQuery
): { total: number; records: VaultManualRecord[] } {
  const needle = query.q?.trim().toLowerCase() ?? ''
  const matched = records.filter((record) => {
    if (query.family && record.family !== query.family) return false
    if (query.branch && record.branch !== query.branch) return false
    if (query.pubType && record.pubType !== query.pubType) return false
    if (!needle) return true
    const haystack = `${record.designation} ${record.title} ${record.id}`.toLowerCase()
    return haystack.includes(needle)
  })

  const offset = query.offset && query.offset > 0 ? query.offset : 0
  const limit = query.limit && query.limit > 0 ? query.limit : 40
  return { total: matched.length, records: matched.slice(offset, offset + limit) }
}

export function vaultFacets(records: VaultManualRecord[]): {
  families: string[]
  branches: string[]
  pubTypes: string[]
} {
  return {
    families: uniqueSorted(records.map((record) => record.family)),
    branches: uniqueSorted(records.map((record) => record.branch)),
    pubTypes: uniqueSorted(records.map((record) => record.pubType)),
  }
}

/**
 * Index paths look like `PDF/Category/Topic.zip/file name.pdf`.
 * Returns the zip relative to the vault root and the entry name inside it.
 */
export function locateZippedEntry(
  indexPath: string
): { zipRelative: string; entryName: string } | null {
  const normalized = indexPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null

  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '..')) return null

  const marker = '.zip/'
  const at = normalized.toLowerCase().indexOf(marker)
  if (at < 0) return null

  const zipRelative = normalized.slice(0, at + '.zip'.length)
  const entryName = normalized.slice(at + marker.length)
  if (!entryName || entryName.split('/').includes('..')) return null
  return { zipRelative, entryName }
}

export type ZipEntryMatch =
  | { kind: 'match'; name: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

/**
 * Pick the zip entry for an index path.
 * A target that already contains a directory must match that full in-zip path.
 * A bare file name may match exactly one entry with that base name; two hits
 * (for example `A/intro.pdf` and `B/intro.pdf`) are ambiguous and are not opened.
 */
export function matchZipEntry(entryNames: readonly string[], target: string): ZipEntryMatch {
  const wanted = normalizeZipName(target)
  if (!wanted || wanted.endsWith('/')) return { kind: 'missing' }

  const names = entryNames
    .map(normalizeZipName)
    .filter((name) => name.length > 0 && !name.endsWith('/'))

  const exact = names.filter((name) => name === wanted)
  if (exact.length === 1) return { kind: 'match', name: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous' }
  if (wanted.includes('/')) return { kind: 'missing' }

  const sameBaseName = names.filter((name) => zipBaseName(name) === wanted)
  if (sameBaseName.length === 1) return { kind: 'match', name: sameBaseName[0] }
  if (sameBaseName.length > 1) return { kind: 'ambiguous' }
  return { kind: 'missing' }
}

export function isInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep)
}

export function resolveInside(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes('\0')) return null
  const resolved = resolve(root, relativePath)
  if (!isInside(root, resolved)) return null
  return resolved
}

export function contentDisposition(filename: string, inline: boolean): string {
  const base = filename.split(/[/\\]/).pop() || 'manual'
  const cleaned = base.replace(/[\r\n"\\]/g, '_')
  return `${inline ? 'inline' : 'attachment'}; filename="${cleaned}"`
}

async function deleteDebrisUnder(root: string, current: string): Promise<void> {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }

  for (const entry of entries) {
    const full = join(current, entry.name)
    if (!isInside(root, full)) continue
    const relativePath = relative(root, full)
    if (entry.isSymbolicLink()) {
      if (isVaultDownloadDebris(relativePath)) await unlink(full).catch(ignoreMissingFile)
      continue
    }
    if (entry.isDirectory()) {
      if (isVaultDownloadDebris(relativePath)) {
        await rm(full, { recursive: true, force: true })
      } else {
        await deleteDebrisUnder(root, full)
      }
      continue
    }
    if (entry.isFile() && isVaultDownloadDebris(relativePath)) {
      await unlink(full).catch(ignoreMissingFile)
    }
  }
}

function ignoreMissingFile(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'ENOENT') throw error
}

function normalizeZipName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '')
}

function zipBaseName(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right)
  )
}

function toBytes(value: string, unit: string): number {
  const factor = BYTE_UNITS[unit]
  if (!factor) return Number.NaN
  return Math.round(Number(value) * factor)
}

function asDict(value: BencodeValue | undefined): { [key: string]: BencodeValue } | null {
  if (!value || Buffer.isBuffer(value) || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

function bufferText(value: BencodeValue | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/** RFC 4180-ish splitter. The vault index quotes titles that contain commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      field = ''
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
      continue
    }
    if (char === '\r') continue
    field += char
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  }
  return rows
}
