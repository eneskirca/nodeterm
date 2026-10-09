import { describe, expect, it } from 'vitest'
import { isSimulatorDeviceId, isWebDeviceId, localUrlFromOutput, normalizeRunBrowserConfig, previewKindFor } from './run-preview'

const base = { picksDevice: false, browserConfig: false }

describe('previewKindFor', () => {
  it('a phone device gets the simulator, a browser device or configuration the browser', () => {
    expect(previewKindFor({ ...base, picksDevice: true, deviceId: '0A1B2C3D-0000-4000-8000-00000000000A', deviceKind: 'simulator' })).toBe('simulator')
    expect(previewKindFor({ ...base, picksDevice: true, deviceId: 'emulator-5554', deviceKind: 'emulator' })).toBe('simulator')
    expect(previewKindFor({ ...base, picksDevice: true, deviceId: 'chrome', deviceKind: 'web' })).toBe('browser')
    expect(previewKindFor({ ...base, picksDevice: true, deviceId: 'web-server' })).toBe('browser')
    expect(previewKindFor({ ...base, browserConfig: true })).toBe('browser')
  })

  it('a dev server (no device) gets the browser', () => {
    expect(previewKindFor(base)).toBe('browser')
  })

  it("follows the device a configuration names itself — the case that showed 📱 for a Chrome run", () => {
    expect(previewKindFor({ ...base, picksDevice: false, pinnedDeviceId: 'chrome' })).toBe('browser')
    expect(previewKindFor({ ...base, pinnedDeviceId: 'web-server' })).toBe('browser')
    expect(previewKindFor({ ...base, pinnedDeviceId: 'emulator-5554' })).toBe('simulator')
    expect(previewKindFor({ ...base, pinnedDeviceId: 'macos' })).toBe('simulator')
  })

  it('a device picker with nothing picked yet offers the simulator', () => {
    expect(previewKindFor({ ...base, picksDevice: true })).toBe('simulator')
  })
})

describe('localUrlFromOutput', () => {
  it('reads the address Flutter serves a web app at, not its DevTools URL', () => {
    const out = [
      'Launching lib/main.dart on Web Server in debug mode...',
      'Waiting for connection from debug service on Web Server...          12.4s',
      'lib/main.dart is being served at http://localhost:54123',
      'The web-server device requires the Dart Debug Chrome extension for debugging. Consider using the Chrome or Edge devices for an improved development workflow.',
      'The Flutter DevTools debugger and profiler on Web Server is available at: http://127.0.0.1:9101?uri=ws://127.0.0.1:54123/abc=/ws'
    ].join('\n')
    expect(localUrlFromOutput(out)).toBe('http://localhost:54123')
  })

  it('reads Vite and Next.js banners', () => {
    expect(localUrlFromOutput('  VITE v5.4.0  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose')).toBe('http://localhost:5173/')
    expect(localUrlFromOutput('   ▲ Next.js 14.2.3\n   - Local:        http://localhost:3000\n')).toBe('http://localhost:3000')
  })

  it('opens an all-interfaces bind as localhost, and drops trailing punctuation', () => {
    expect(localUrlFromOutput(' * Running on http://0.0.0.0:8000.')).toBe('http://localhost:8000')
  })

  it('takes the newest served address, and says nothing before one is printed', () => {
    expect(localUrlFromOutput('Local: http://localhost:5173/\nport in use, retrying\nLocal: http://localhost:5174/')).toBe('http://localhost:5174/')
    expect(localUrlFromOutput('Compiling…\nwaiting')).toBeNull()
    expect(localUrlFromOutput('see https://example.com/docs')).toBeNull()
  })
})

describe('isWebDeviceId', () => {
  it('names Flutter\'s browser devices', () => {
    expect(['chrome', 'edge', 'web-server'].every(isWebDeviceId)).toBe(true)
    expect(isWebDeviceId('macos')).toBe(false)
  })
})

describe('normalizeRunBrowserConfig', () => {
  it('keeps only http(s) pages', () => {
    expect(normalizeRunBrowserConfig({ url: 'http://localhost:5173/', auto: true })).toEqual({ url: 'http://localhost:5173/', auto: true })
    expect(normalizeRunBrowserConfig({ url: 'file:///etc/passwd' })).toEqual({})
    expect(normalizeRunBrowserConfig({ url: 'javascript:alert(1)' })).toEqual({})
    expect(normalizeRunBrowserConfig(null)).toBeUndefined()
  })

  it('names the simulator device ids', () => {
    expect(isSimulatorDeviceId('emulator-5554')).toBe(true)
    expect(isSimulatorDeviceId('chrome')).toBe(false)
  })
})
