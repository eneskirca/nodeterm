import { posixQuote } from '../../shared/ssh'

const BLOCK = 65536
const STATUS = '\nNODETERM_READ_STATUS:0\n'

/** One size snapshot and at most cap + two blocks of file bytes. POSIX sh + BSD/GNU dd.
 * The dd status travels INSIDE base64: pipeline success alone hides a failed file read. */
export function transcriptWindowCommand(path: string, offset: number | null, cap: number): string {
  if ((offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) ||
      !Number.isSafeInteger(cap) || cap < 1 || cap > 1024 * 1024) throw new Error('Invalid transcript read bounds')
  return `exec 3< ${posixQuote(path)} || exit 1
size=$(wc -c < ${posixQuote(path)}) || exit 1
size=$((size + 0))
start=${offset ?? -1}
initial=0
if [ "$start" -lt 0 ] || [ "$size" -lt "$start" ]; then
  initial=1
  start=$((size > ${cap} ? size - ${cap} : 0))
fi
count=$((size - start))
if [ "$count" -gt ${cap} ]; then count=${cap}; fi
printf '%s %s %s %s\n' "$start" "$count" "$size" "$initial"
if [ "$count" -gt 0 ]; then
  skip=$((start / ${BLOCK}))
  blocks=$(((start % ${BLOCK} + count + ${BLOCK - 1}) / ${BLOCK}))
  { dd bs=${BLOCK} skip="$skip" count="$blocks" <&3 2>/dev/null; result=$?; printf '\nNODETERM_READ_STATUS:%s\n' "$result"; } | base64
fi`
}

export interface TranscriptWindow {
  data: Buffer
  start: number
  newOffset: number
  initial: boolean
}

export function parseTranscriptWindow(stdout: string, cap: number): TranscriptWindow {
  const end = stdout.indexOf('\n')
  const match = /^(\d+) (\d+) (\d+) ([01])$/.exec(stdout.slice(0, end))
  if (!match) throw new Error('Invalid transcript read header')
  const [start, count, size, initial] = match.slice(1).map(Number)
  if (![start, count, size].every(Number.isSafeInteger) || count > cap || start + count > size) {
    throw new Error('Invalid transcript read range')
  }
  const encoded = stdout.slice(end + 1).replace(/\s/g, '')
  if (!count) {
    if (encoded) throw new Error('Unexpected transcript read payload')
    return { data: Buffer.alloc(0), start, newOffset: start, initial: !!initial }
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded || !decoded.subarray(-STATUS.length).equals(Buffer.from(STATUS))) {
    throw new Error('Failed transcript read')
  }
  const bytes = decoded.subarray(0, -STATUS.length)
  const leading = start % BLOCK
  if (bytes.length < leading + count || bytes.length > cap + 2 * BLOCK) throw new Error('Short or oversized transcript read')
  return { data: bytes.subarray(leading, leading + count), start, newOffset: start + count, initial: !!initial }
}
