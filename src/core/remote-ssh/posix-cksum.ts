/**
 * The POSIX `cksum` algorithm, computed locally so we can predict what a host's own `cksum` prints
 * for the bytes we would write there.
 *
 * Why this and not a real hash: `cksum` is the one checksum utility POSIX REQUIRES, so it is on
 * every host we already support (GNU coreutils, macOS, BusyBox) with one output format, while
 * `sha256sum` / `shasum -a 256` / `sha256` / `openssl dgst` each exist on only some of them. It is
 * a CRC-32, not collision resistant — acceptable because it is never a security check here (anyone
 * who can write these files already owns the account). It detects accidental drift between two
 * versions of a generated file, and together with the exact byte length a miss needs a change that
 * keeps both, about one in 2^32.
 *
 * Algorithm (POSIX.1-2017, `cksum`): CRC-32 with polynomial 0x04C11DB7, most significant bit first,
 * initial value 0, run over the data and then over the data LENGTH (least significant byte first,
 * only as many bytes as the value needs), then complemented.
 */

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    t[i] = c >>> 0
  }
  return t
})()

export interface Cksum {
  crc: number
  size: number
}

function step(crc: number, byte: number): number {
  return ((crc << 8) ^ TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
}

export function posixCksum(bytes: Uint8Array): Cksum {
  let crc = 0
  for (let i = 0; i < bytes.length; i++) crc = step(crc, bytes[i])
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) crc = step(crc, n % 256)
  return { crc: ~crc >>> 0, size: bytes.length }
}

/** `cksum`'s own output for stdin: `<crc> <size>`. */
export function formatCksum(c: Cksum): string {
  return `${c.crc} ${c.size}`
}

/**
 * The first two fields of a `cksum` line, or null when they are not two unsigned decimals.
 * Anything after them (a file name some implementations print) is ignored.
 */
export function parseCksumLine(line: string): Cksum | null {
  const m = /^(\d+) (\d+)(?: .*)?$/.exec(line.trim())
  if (!m) return null
  const crc = Number(m[1])
  const size = Number(m[2])
  if (!Number.isSafeInteger(crc) || crc > 0xffffffff || !Number.isSafeInteger(size)) return null
  return { crc, size }
}
