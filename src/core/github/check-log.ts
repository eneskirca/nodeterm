// The Checks tab's inline log excerpt (F-05): the tail of the failing step of one Actions job log.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/

/** The last `max` lines of the failing step: up to the job's last `##[error]` line, from that step's
 *  `##[group]Run` line. No error line = the log's last lines. Timestamps and ANSI codes removed. */
export function failingStepTail(log: string, max: number): string[] {
  const lines = log.split(/\r?\n/).map((line) => line.replace(STAMP, '').replace(ANSI, ''))
  while (lines.length && lines.at(-1) === '') lines.pop()
  // ponytail: the raw log has no step ids; the last error line ends the failing step and the Run group before it starts it.
  const last = (list: string[], prefix: string) => list.map((line) => line.startsWith(prefix)).lastIndexOf(true)
  const error = last(lines, '##[error]')
  const end = error < 0 ? lines.length : error + 1
  const start = error < 0 ? 0 : Math.max(0, last(lines.slice(0, end), '##[group]Run '))
  return lines.slice(Math.max(start, end - max), end)
}
