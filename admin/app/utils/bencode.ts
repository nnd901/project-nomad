export type BencodeValue = Buffer | number | BencodeValue[] | { [key: string]: BencodeValue }

/**
 * Decode one bencoded value. Used for the Field Manual Vault .torrent files,
 * which are small dictionaries (the piece-hash blob stays a Buffer).
 */
export function decodeBencode(buffer: Buffer): BencodeValue {
  const [value, offset] = decodeAt(buffer, 0)
  if (offset !== buffer.length) {
    throw new Error('Trailing data after the bencoded value')
  }
  return value
}

function decodeAt(buffer: Buffer, index: number): [BencodeValue, number] {
  if (index >= buffer.length) {
    throw new Error('Unexpected end of bencode data')
  }

  const marker = buffer[index]
  if (marker === 0x64) return decodeDict(buffer, index + 1)
  if (marker === 0x6c) return decodeList(buffer, index + 1)
  if (marker === 0x69) return decodeInteger(buffer, index + 1)

  return decodeString(buffer, index)
}

function decodeDict(buffer: Buffer, index: number): [BencodeValue, number] {
  const dict: { [key: string]: BencodeValue } = {}
  let cursor = index
  while (buffer[cursor] !== 0x65) {
    if (cursor >= buffer.length) throw new Error('Unterminated bencode dictionary')
    const [key, afterKey] = decodeString(buffer, cursor)
    const [value, afterValue] = decodeAt(buffer, afterKey)
    dict[key.toString('utf8')] = value
    cursor = afterValue
  }
  return [dict, cursor + 1]
}

function decodeList(buffer: Buffer, index: number): [BencodeValue, number] {
  const list: BencodeValue[] = []
  let cursor = index
  while (buffer[cursor] !== 0x65) {
    if (cursor >= buffer.length) throw new Error('Unterminated bencode list')
    const [value, next] = decodeAt(buffer, cursor)
    list.push(value)
    cursor = next
  }
  return [list, cursor + 1]
}

function decodeInteger(buffer: Buffer, index: number): [BencodeValue, number] {
  const end = buffer.indexOf(0x65, index)
  if (end < 0) throw new Error('Unterminated bencode integer')
  const text = buffer.toString('utf8', index, end)
  if (!/^-?\d+$/.test(text)) throw new Error('Invalid bencode integer')
  return [Number(text), end + 1]
}

function decodeString(buffer: Buffer, index: number): [Buffer, number] {
  const colon = buffer.indexOf(0x3a, index)
  if (colon < 0) throw new Error('Invalid bencode string')
  const lengthText = buffer.toString('utf8', index, colon)
  if (!/^\d+$/.test(lengthText)) throw new Error('Invalid bencode string length')
  const length = Number(lengthText)
  const start = colon + 1
  const end = start + length
  if (end > buffer.length) throw new Error('Truncated bencode string')
  return [buffer.subarray(start, end), end]
}
