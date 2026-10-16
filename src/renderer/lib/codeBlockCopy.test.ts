// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { codeBlockText, preText } from './codeBlockCopy'

describe('codeBlockText', () => {
  it('drops the one trailing newline marked emits before </code>', () => {
    expect(codeBlockText('let x = 1\n')).toBe('let x = 1')
  })

  it('keeps a blank last line the author wrote, and everything inside', () => {
    expect(codeBlockText('a\n  b\n\n')).toBe('a\n  b\n')
    expect(codeBlockText('no newline')).toBe('no newline')
  })
})

describe('preText', () => {
  it('reads the <code> inside the block, decoded', () => {
    const pre = document.createElement('pre')
    pre.innerHTML = '<code class="language-js">if (a &lt; b) {}\n</code>'

    expect(preText(pre)).toBe('if (a < b) {}')
  })

  it('falls back to the <pre> itself', () => {
    const pre = document.createElement('pre')
    pre.textContent = 'raw\n'

    expect(preText(pre)).toBe('raw')
  })
})
