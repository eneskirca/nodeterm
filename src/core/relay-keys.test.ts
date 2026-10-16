import { describe, it, expect } from 'vitest'
import { parseRelayKeys, rawKeyBytes, tmuxKeyArgs } from './relay-keys'
import { remoteSendKeyArgs } from './remote-ssh/control-master'

describe('parseRelayKeys — a closed set, nothing else crosses', () => {
  it('one key', () => {
    expect(parseRelayKeys({ key: '1' })).toEqual([{ digit: '1' }])
    expect(parseRelayKeys({ key: '9' })).toEqual([{ digit: '9' }])
    expect(parseRelayKeys({ key: 'escape' })).toEqual([{ name: 'Escape' }])
    expect(parseRelayKeys({ key: 'enter' })).toEqual([{ name: 'Enter' }])
  })
  it.each([['0'], ['10'], ['a'], ['Escape'], ['1;rm'], [''], [1], [null]])('refuses key %j', (key) => {
    expect(parseRelayKeys({ key })).toBeNull()
  })
  it('a multi-select batch: distinct digits ascending, then Right, then Enter (the phone’s SSH sequence)', () => {
    expect(parseRelayKeys({ digits: [3, 1, 3] })).toEqual([
      { digit: '1' },
      { digit: '3' },
      { name: 'Right' },
      { name: 'Enter' }
    ])
  })
  it.each([[[]], [[0]], [[10]], [[1.5]], [['1']], [[1, 2, 3, 4, 5, 6, 7, 8, 9, 1]], ['12']])(
    'refuses digits %j',
    (digits) => {
      expect(parseRelayKeys({ digits })).toBeNull()
    }
  )
  it('refuses key and digits together', () => {
    expect(parseRelayKeys({ key: '1', digits: [1] })).toBeNull()
  })
})

describe('key encodings', () => {
  it('tmux: a literal digit, or the key NAME', () => {
    expect(tmuxKeyArgs({ digit: '2' })).toEqual(['-l', '2'])
    expect(tmuxKeyArgs({ name: 'Escape' })).toEqual(['Escape'])
    expect(tmuxKeyArgs({ name: 'Right' })).toEqual(['Right'])
  })
  it('raw (session host): the bytes the key sends', () => {
    expect(rawKeyBytes({ digit: '1' })).toBe('1')
    expect(rawKeyBytes({ name: 'Escape' })).toBe('\x1b')
    expect(rawKeyBytes({ name: 'Enter' })).toBe('\r')
    expect(rawKeyBytes({ name: 'Right' })).toBe('\x1b[C')
  })
  it('re-validates at the interpolation site', () => {
    expect(() => tmuxKeyArgs({ digit: '1; rm -rf ~' })).toThrow()
    expect(() => rawKeyBytes({ name: 'Space' as never })).toThrow()
  })
  it('the remote send-keys line names only the closed set', () => {
    const conn = { host: 'box.test', user: 'u' }
    const args = remoteSendKeyArgs(conn, '/tmp/cm', 'nt-n1', ['-l', '1'])
    expect(args[args.length - 1]).toContain('tmux -L nodeterm-rmt send-keys -t nt-n1 -l 1')
    expect(() => remoteSendKeyArgs(conn, '/tmp/cm', 'nt-n1', ['-l', '1;id'])).toThrow()
    expect(() => remoteSendKeyArgs(conn, '/tmp/cm', 'nt n1', ['Enter'])).toThrow()
  })
})
