import { isIP } from 'node:net'

const MAGNET_LIMIT = 8_192
const URL_LIMIT = 2_048

export type TorrentSource =
  | { kind: 'magnet'; uri: string; name: string }
  | { kind: 'url'; url: string }

export function torrentDisplayName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return cleaned || 'Torrent'
}

export function isTorrentId(value: string): boolean {
  return /^[a-f0-9]{16}$/.test(value)
}

/** A magnet link, or an http(s) URL that is not aimed at this machine. */
export function classifyTorrentSource(value: string): TorrentSource | null {
  const magnet = parseMagnet(value)
  if (magnet) return magnet
  const url = publicTorrentUrl(value)
  if (!url) return null
  return { kind: 'url', url }
}

export function parseMagnet(value: string): { kind: 'magnet'; uri: string; name: string } | null {
  const uri = value.trim()
  if (uri.length === 0 || uri.length > MAGNET_LIMIT) return null
  if (!uri.toLowerCase().startsWith('magnet:?')) return null
  if (/[\u0000-\u001f\s]/.test(uri)) return null
  if (!/[?&]xt=urn:bt(?:ih|mh):[a-z0-9]{32,}/i.test(uri)) return null
  return { kind: 'magnet', uri, name: torrentDisplayName(magnetDisplayName(uri) ?? 'Torrent') }
}

export function publicTorrentUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > URL_LIMIT) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!publicHost(url.hostname)) return null
  return url.toString()
}

function magnetDisplayName(uri: string): string | null {
  const query = uri.slice(uri.indexOf('?') + 1)
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq) !== 'dn') continue
    try {
      return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '))
    } catch {
      return null
    }
  }
  return null
}

function publicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  if (/^\d+$/.test(host)) return false
  const version = isIP(host)
  if (version === 4) return !isPrivateV4(host)
  if (version === 6) return !isPrivateV6(host)
  return true
}

function isPrivateV4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }
  const a = parts[0] ?? -1
  const b = parts[1] ?? -1
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateV6(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (/^fe[89ab]/.test(normalized)) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length)
    return isIP(v4) !== 4 || isPrivateV4(v4)
  }
  return false
}
