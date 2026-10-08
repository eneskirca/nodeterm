import { describe, expect, it, vi } from 'vitest'
import { captureComposedViewer, COMPOSED_VIEWER_FORMAT, composedSubmissionPlan, submitComposedTmux,
  type ComposedTmuxBoundary, type ComposedViewerReceipt } from './composed-tmux'
import { COMPOSED_ENTER_DELAY_MS, COMPOSED_INPUT_MAX_BYTES, normalizeComposedPaste, parseComposedInput } from '../shared/composed-input'

const row = '11|1700000000|nt-owned|client-11|99|1700000000|%7|77'
const birth = (pid: number): string => `linux:00000000-0000-0000-0000-000000000001:${pid}`
const receipt: ComposedViewerReceipt = { socket: 'owned-test', session: 'nt-owned', viewerPid: 11,
  viewerCreated: '1700000000', viewerName: 'client-11', viewerBirth: birth(11), serverPid: 99,
  serverBirth: birth(99), sessionCreated: '1700000000', paneId: '%7', panePid: 77, paneBirth: birth(77) }
const paste = { kind: 'paste', text: 'hello Ω', enter: true } as const

function boundary(extra: Partial<ComposedTmuxBoundary> = {}) {
  const run = vi.fn(async (args: string[]) => args.includes('list-clients') ? row : 'nt-composed-delivered\n')
  const b: ComposedTmuxBoundary = { current: () => true, run, readBirth: async (pid) => birth(pid), wait: async () => {}, ...extra }
  return { b, run }
}

describe('composed input validation', () => {
  it('accepts bounded Unicode pastes and precisely one explicit Ctrl byte without Enter', () => {
    expect(parseComposedInput(paste)).toEqual(paste)
    for (let i = 0; i < 32; i++) expect(parseComposedInput({ kind: 'control', text: String.fromCharCode(i), enter: false })).not.toBeNull()
    expect(parseComposedInput({ kind: 'control', text: '\x7f', enter: false })).not.toBeNull()
    for (const input of [null, {}, { ...paste, enter: 1 }, { ...paste, text: '\x00' }, { ...paste, text: 'Ω'.repeat(COMPOSED_INPUT_MAX_BYTES) },
      { ...paste, text: 'x'.repeat(COMPOSED_INPUT_MAX_BYTES + 1) }, { kind: 'control', text: 'a', enter: false },
      { kind: 'control', text: '\x03\r', enter: false }, { kind: 'control', text: '\x03', enter: true }])
      expect(parseComposedInput(input)).toBeNull()
  })
  it('normalizes xterm paste line endings and prevents payload-supplied paste structure', () => {
    expect(normalizeComposedPaste('a\r\nb\nc\r\x1b[201~\u009b200~')).toBe('a\rb\rc\r[201~200~')
  })
})

describe('attachment-time composed viewer receipt', () => {
  it('attests the actual attached client, server and pane twice before pinning', async () => {
    const { b, run } = boundary()
    const read = vi.fn(async (pid: number) => birth(pid))
    expect(await captureComposedViewer('owned-test', 'nt-owned', 11, { ...b, readBirth: read })).toEqual(receipt)
    expect(read.mock.calls.map(([pid]) => pid)).toEqual([11, 99, 77])
    expect(run.mock.calls.map(([args]) => args)).toEqual([0, 1].map(() =>
      ['-L', 'owned-test', 'list-clients', '-t', '=nt-owned', '-F', COMPOSED_VIEWER_FORMAT]))
  })
  it('waits only for registration of its spawned viewer and never adopts a neighbour', async () => {
    const { b } = boundary()
    const run = vi.fn().mockResolvedValueOnce(row.replace(/^11\|/, '12|')).mockResolvedValue(row)
    expect(await captureComposedViewer('owned-test', 'nt-owned', 11, { ...b, run })).toEqual(receipt)
    expect(run).toHaveBeenCalledTimes(3)
  })
  it('refuses cancellation and a pane replacement during attachment attestation', async () => {
    const { b } = boundary()
    const run = vi.fn().mockResolvedValueOnce(row).mockResolvedValue(row.replace('%7|77', '%8|88'))
    expect(await captureComposedViewer('owned-test', 'nt-owned', 11, { ...b, run })).toBeNull()
    expect(await captureComposedViewer('owned-test', 'nt-owned', 11, { ...b, current: () => false })).toBeNull()
    expect(await captureComposedViewer('owned-test', 'nt-owned', 11, { ...b, run: async () => row + '\n' + row })).toBeNull()
  })
})

describe('generation-bound composed submission', () => {
  it('writes normalized content only on stdin, with exact pane framing, separate Enter and final viewer gate', async () => {
    const { b, run } = boundary()
    const input = { ...paste, text: 'a\r\nb\x1b[201~' }
    expect(await submitComposedTmux(receipt, input, b)).toEqual({ status: 'delivered' })
    const dispatch = run.mock.calls[1] as unknown as [string[], string]
    expect(dispatch[1]).toBe('a\rb[201~')
    expect(dispatch[0].join(' ')).not.toContain(input.text)
    const yes = dispatch[0].at(-2)!
    expect(yes).toContain("if-shell -F -t %7 '#{pane_in_mode}' 'send-keys -t %7 -X cancel'")
    expect(yes).toMatch(/paste-buffer -d -p -r -b nt-paste-[a-z0-9-]+ -t %7/)
    expect(yes).not.toContain('Enter')
    expect(dispatch[0].at(-3)).toContain('#{L:')
    expect(dispatch[0].at(-3)).toContain('#{==:#{client_pid},11}')
    const enter = run.mock.calls[3] as unknown as [string[], string]
    expect(enter[1]).toBe('')
    expect(enter[0].at(-2)).toContain('send-keys -t %7 Enter')
    expect(enter[0].at(-3)).toBe(dispatch[0].at(-3))
  })
  it('waits after confirmed paste, then treats retirement before Enter as uncertain without a second write', async () => {
    let alive = true
    const wait = vi.fn(async () => { alive = false })
    const { b, run } = boundary({ current: () => alive, wait })
    expect((await submitComposedTmux(receipt, paste, b)).status).toBe('uncertain')
    expect(wait).toHaveBeenCalledWith(COMPOSED_ENTER_DELAY_MS)
    expect(run.mock.calls.filter(([args]) => args.includes('load-buffer'))).toHaveLength(1)
    expect(run.mock.calls.filter(([args]) => args.at(-2)?.includes('Enter'))).toHaveLength(0)
  })
  it('rechecks process birth before Enter and never calls a postpaste refusal unsent', async () => {
    let changed = false
    const { b, run } = boundary({ wait: async () => { changed = true }, readBirth: async (pid) => changed && pid === 77 ? birth(pid + 1) : birth(pid) })
    expect((await submitComposedTmux(receipt, paste, b)).status).toBe('uncertain')
    expect(run.mock.calls.filter(([args]) => args.at(-2)?.includes('Enter'))).toHaveLength(0)
    expect(run.mock.calls.filter(([args]) => args.includes('load-buffer'))).toHaveLength(1)
  })
  it('maps the final Enter queue refusal to uncertain, keeping the completed paste single-shot', async () => {
    const { b } = boundary()
    const run = vi.fn(async (args: string[], body?: string) => {
      if (args.includes('list-clients')) return row
      return body === '' ? 'nt-composed-refused' : 'nt-composed-delivered'
    })
    expect((await submitComposedTmux(receipt, paste, { ...b, run })).status).toBe('uncertain')
    expect(run.mock.calls.filter(([args]) => args.includes('load-buffer'))).toHaveLength(1)
    expect(run.mock.calls.filter(([args]) => args.at(-2)?.includes('Enter'))).toHaveLength(1)
  })
  it.each(['viewerPid', 'viewerCreated', 'viewerName', 'serverPid', 'sessionCreated', 'paneId', 'panePid'] as const)
    ('refuses changed %s before payload dispatch', async (field) => {
      const changed = { ...receipt, [field]: typeof receipt[field] === 'number' ? Number(receipt[field]) + 1 : String(receipt[field]) + '1' }
      const { b, run } = boundary()
      expect((await submitComposedTmux(changed, paste, b)).status).toBe('refused')
      expect(run.mock.calls.every(([args]) => !args.includes('load-buffer'))).toBe(true)
    })
  it.each([11, 99, 77])('refuses reused PID/birth %s before payload dispatch', async (pid) => {
    const { b, run } = boundary({ readBirth: async (p) => p === pid ? birth(p + 100) : birth(p) })
    expect((await submitComposedTmux(receipt, paste, b)).status).toBe('refused')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('refuses a detach while attestation is suspended', async () => {
    let alive = true
    const { b, run } = boundary({ current: () => alive, readBirth: async (pid) => { alive = false; return birth(pid) } })
    expect((await submitComposedTmux(receipt, paste, b)).status).toBe('refused')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it.each(['missing', 'throws'])('reports %s dispatch acknowledgment as uncertain without replay', async (mode) => {
    const { b } = boundary()
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('list-clients')) return row
      if (args.includes('load-buffer')) { if (mode === 'throws') throw new Error('lost response'); return '' }
      return ''
    })
    expect((await submitComposedTmux(receipt, paste, { ...b, run })).status).toBe('uncertain')
    expect(run.mock.calls.filter(([args]) => args.includes('load-buffer'))).toHaveLength(1)
    expect(run.mock.calls.filter(([args]) => args.includes('delete-buffer'))).toHaveLength(1)
  })
  it('keeps Ctrl unframed and preserves the empty body/Enter contract with unique buffers', () => {
    const ctrl = composedSubmissionPlan(receipt, { kind: 'control', text: '\x03', enter: false })
    expect(ctrl.body).toBe('')
    expect(ctrl.args.join(' ')).toContain('send-keys -t %7 -H 03')
    expect(ctrl.args.join(' ')).not.toContain('Enter')
    expect(ctrl.args).not.toContain('load-buffer')
    const empty = composedSubmissionPlan(receipt, { kind: 'paste', text: '', enter: true })
    expect(empty.args.join(' ')).toContain('send-keys -t %7 Enter')
    expect(empty.args).not.toContain('load-buffer')
    expect(() => composedSubmissionPlan(receipt, paste)).toThrow('separate guarded dispatches')
    const a = composedSubmissionPlan(receipt, { ...paste, enter: false }), b = composedSubmissionPlan(receipt, { ...paste, enter: false })
    expect(a.args[4]).not.toBe(b.args[4])
  })
})
