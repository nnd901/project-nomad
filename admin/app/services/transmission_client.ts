import { readFile, unlink, writeFile } from 'node:fs/promises'
import axios from 'axios'
import env from '#start/env'
import type { FieldManualEditionId } from '../../types/field_manual_vault.js'
import { isVaultSideFile } from '../utils/field_manual_vault.js'
import { fieldManualGidPath } from '../utils/field_manual_paths.js'
import { parseTransmissionTorrent, type TransmissionTorrent } from '../utils/transmission_status.js'

const DEFAULT_URL = 'http://transmission:9091/transmission/rpc'
const RPC_FIELDS = [
  'hashString',
  'status',
  'error',
  'errorString',
  'sizeWhenDone',
  'leftUntilDone',
  'rateDownload',
  'peersConnected',
  'trackerStats',
  'downloadDir',
]

export class TransmissionRpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransmissionRpcError'
  }
}

let sessionId: string | null = null

export async function transmissionIsReachable(): Promise<boolean> {
  try {
    await call('session-get')
    return true
  } catch {
    return false
  }
}

export async function readStoredHash(editionId: FieldManualEditionId): Promise<string | null> {
  try {
    const text = (await readFile(fieldManualGidPath(editionId), 'utf8')).trim()
    return /^[a-f0-9]{40}$/i.test(text) ? text.toLowerCase() : null
  } catch {
    return null
  }
}

export async function writeStoredHash(editionId: FieldManualEditionId, hash: string): Promise<void> {
  await writeFile(fieldManualGidPath(editionId), hash)
}

export async function clearStoredHash(editionId: FieldManualEditionId): Promise<void> {
  await unlink(fieldManualGidPath(editionId)).catch(() => undefined)
}

export async function transmissionTellStatus(hash: string): Promise<TransmissionTorrent | null> {
  const torrents = await listTorrents([hash])
  return torrents.find((torrent) => torrent.hash === hash.toLowerCase()) ?? null
}

export async function findTransmissionDownload(dir: string): Promise<TransmissionTorrent | null> {
  const wanted = dir.replace(/\/+$/, '')
  const torrents = await listTorrents()
  return torrents.find((torrent) => torrent.dir === wanted) ?? null
}

export async function addTransmissionTorrent(torrent: Buffer, dir: string): Promise<string> {
  return addedHash({ metainfo: torrent.toString('base64'), 'download-dir': dir, paused: false })
}

export async function addTransmissionMagnet(uri: string, dir: string): Promise<string> {
  return addedHash({ filename: uri, 'download-dir': dir, paused: false })
}

export async function skipVaultDebris(hash: string): Promise<void> {
  let names: string[] = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    names = await fileNames(hash)
    if (names.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (names.length === 0) throw new TransmissionRpcError('Torrent has no content files to download')
  const unwanted = names.flatMap((name, index) => (isVaultSideFile(name) ? [index] : []))
  if (unwanted.length === names.length) {
    throw new TransmissionRpcError('Torrent has no content files to download')
  }
  if (unwanted.length === 0) return
  await call('torrent-set', { ids: [hash], 'files-unwanted': unwanted })
}

export async function pauseTransmission(hash: string): Promise<void> {
  await call('torrent-stop', { ids: [hash] }).catch(ignoreMissing)
}

export async function startTransmission(hash: string): Promise<void> {
  await call('torrent-start', { ids: [hash] })
}

export async function removeTransmission(hash: string, deleteData: boolean): Promise<void> {
  await call('torrent-remove', { ids: [hash], 'delete-local-data': deleteData }).catch(ignoreMissing)
}

async function addedHash(args: Record<string, unknown>): Promise<string> {
  const result = await call<{
    'torrent-added'?: { hashString?: string }
    'torrent-duplicate'?: { hashString?: string }
  }>('torrent-add', args)
  const hash = result['torrent-added']?.hashString ?? result['torrent-duplicate']?.hashString
  if (!hash) throw new TransmissionRpcError('The download service did not accept the torrent')
  return hash.toLowerCase()
}

async function fileNames(hash: string): Promise<string[]> {
  const result = await call<{ torrents?: Array<{ files?: Array<{ name?: string }> }> }>('torrent-get', {
    ids: [hash],
    fields: ['files'],
  })
  const files = result.torrents?.[0]?.files ?? []
  return files.map((file) => file.name ?? '')
}

async function listTorrents(ids?: string[]): Promise<TransmissionTorrent[]> {
  const args: Record<string, unknown> = { fields: RPC_FIELDS }
  if (ids) args.ids = ids
  const result = await call<{ torrents?: unknown[] }>('torrent-get', args)
  return (result.torrents ?? []).flatMap((item) => {
    const parsed = parseTransmissionTorrent(item)
    return parsed ? [parsed] : []
  })
}

function ignoreMissing(error: unknown): void {
  if (!(error instanceof TransmissionRpcError) || !/not found/i.test(error.message)) throw error
}

async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const password = env.get('TRANSMISSION_RPC_PASSWORD')
  if (!password) throw new TransmissionRpcError('The download service is not configured')
  const url = env.get('TRANSMISSION_RPC_URL') || DEFAULT_URL
  const username = env.get('TRANSMISSION_RPC_USERNAME') || 'nomad'
  const response = await post(url, username, password, method, args)
  const body = response.data as { result?: string; arguments?: T }
  if (!body || typeof body !== 'object' || body.result !== 'success') {
    throw new TransmissionRpcError(body?.result || 'Transmission request failed')
  }
  return (body.arguments ?? {}) as T
}

async function post(
  url: string,
  username: string,
  password: string,
  method: string,
  args: Record<string, unknown>
) {
  const send = () =>
    axios.post(
      url,
      { method, arguments: args },
      {
        auth: { username, password },
        headers: sessionId ? { 'X-Transmission-Session-Id': sessionId } : {},
        timeout: 20_000,
        validateStatus: () => true,
      }
    )
  try {
    let response = await send()
    if (response.status === 409) {
      const header = response.headers['x-transmission-session-id']
      sessionId = Array.isArray(header) ? header[0] ?? null : header ?? null
      response = await send()
    }
    if (response.status >= 400) {
      throw new TransmissionRpcError(`The download service returned HTTP ${response.status}`)
    }
    return response
  } catch (error) {
    if (error instanceof TransmissionRpcError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new TransmissionRpcError(message)
  }
}
