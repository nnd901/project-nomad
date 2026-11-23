import { readFile, unlink, writeFile } from 'node:fs/promises'
import axios from 'axios'
import env from '#start/env'
import type { FieldManualEditionId } from '../../types/field_manual_vault.js'
import { parseAria2Status, type Aria2DownloadStatus } from '../utils/aria2_status.js'
import { fieldManualGidPath } from '../utils/field_manual_paths.js'

const DEFAULT_URL = 'http://aria2:6800/jsonrpc'

export class Aria2RpcError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null) {
    super(message)
    this.name = 'Aria2RpcError'
    this.code = code
  }
}

export function aria2GidMissing(error: unknown): boolean {
  return error instanceof Aria2RpcError && /not found/i.test(error.message)
}

export async function aria2IsReachable(): Promise<boolean> {
  try {
    await call('aria2.getVersion')
    return true
  } catch {
    return false
  }
}

export async function readStoredGid(editionId: FieldManualEditionId): Promise<string | null> {
  try {
    const text = (await readFile(fieldManualGidPath(editionId), 'utf8')).trim()
    return text || null
  } catch {
    return null
  }
}

export async function writeStoredGid(editionId: FieldManualEditionId, gid: string): Promise<void> {
  await writeFile(fieldManualGidPath(editionId), gid)
}

export async function clearStoredGid(editionId: FieldManualEditionId): Promise<void> {
  await unlink(fieldManualGidPath(editionId)).catch(() => undefined)
}

export async function aria2TellStatus(gid: string): Promise<Aria2DownloadStatus | null> {
  try {
    return parseAria2Status(await call('aria2.tellStatus', [gid]))
  } catch (error) {
    if (aria2GidMissing(error)) return null
    throw error
  }
}

export async function listAria2Downloads(): Promise<Aria2DownloadStatus[]> {
  const lists = await Promise.all([
    call<unknown[]>('aria2.tellActive'),
    call<unknown[]>('aria2.tellWaiting', [0, 100]),
    call<unknown[]>('aria2.tellStopped', [0, 200]),
  ])
  const seen = new Set<string>()
  const downloads: Aria2DownloadStatus[] = []
  for (const item of lists.flat()) {
    const status = parseAria2Status(item)
    if (!status || seen.has(status.gid)) continue
    seen.add(status.gid)
    downloads.push(status)
  }
  return downloads
}

export async function findAria2Download(dir: string): Promise<Aria2DownloadStatus | null> {
  const downloads = await listAria2Downloads()
  return downloads.find((status) => status.dir === dir) ?? null
}

export async function addAria2Torrent(
  torrent: Buffer,
  dir: string,
  selectFile?: string
): Promise<string> {
  const options: Record<string, string> = {
    dir,
    'seed-time': '0',
    pause: 'false',
    'force-save': 'true',
  }
  if (selectFile) options['select-file'] = selectFile
  return call<string>('aria2.addTorrent', [torrent.toString('base64'), [], options])
}

export async function addAria2Uri(uri: string, dir: string): Promise<string> {
  return call<string>('aria2.addUri', [
    [uri],
    {
      dir,
      'seed-time': '0',
      pause: 'false',
      'force-save': 'true',
    },
  ])
}

export async function pauseAria2(gid: string): Promise<void> {
  await call('aria2.pause', [gid]).catch((error: unknown) => {
    if (!aria2GidMissing(error)) throw error
  })
}

export async function unpauseAria2(gid: string): Promise<void> {
  await call('aria2.unpause', [gid])
}

export async function forceRemoveAria2(gid: string): Promise<void> {
  await call('aria2.forceRemove', [gid]).catch((error: unknown) => {
    if (!aria2GidMissing(error)) throw error
  })
}

export async function removeAria2Result(gid: string): Promise<void> {
  await call('aria2.removeDownloadResult', [gid]).catch((error: unknown) => {
    if (!aria2GidMissing(error)) throw error
  })
}

async function call<T>(method: string, params: unknown[] = []): Promise<T> {
  const secret = env.get('ARIA2_RPC_SECRET')
  if (!secret) {
    throw new Aria2RpcError('The download service is not configured', null)
  }
  const url = env.get('ARIA2_RPC_URL') || DEFAULT_URL
  let body: { result?: T; error?: { code?: number; message?: string } }
  try {
    const response = await axios.post(
      url,
      {
        jsonrpc: '2.0',
        id: method,
        method,
        params: [`token:${secret}`, ...params],
      },
      { timeout: 15_000, validateStatus: () => true }
    )
    body = response.data as { result?: T; error?: { code?: number; message?: string } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Aria2RpcError(message, null)
  }
  if (!body || typeof body !== 'object') {
    throw new Aria2RpcError('The download service returned an empty response', null)
  }
  if (body.error) {
    throw new Aria2RpcError(body.error.message || 'aria2 request failed', body.error.code ?? null)
  }
  return body.result as T
}
