import { describe, expect, it } from 'vitest'
import { lastError, parseDiscovery, parseIni } from './android-sdk'

// A discovery file as emulator 36.6.11 writes it (token replaced).
const DISCOVERY = `emulator.build=15507667
avd.id=Pixel_9
port.serial=5554
port.adb=5555
avd.name=Pixel 9
emulator.version=36.6.11.0
avd.dir=/Users/me/.android/avd/Pixel_9.avd
grpc.token=AbCdEf0123456789xyz
grpc.port=8554
`

describe('Android discovery', () => {
  it('reads the AVD, adb serial and gRPC endpoint', () => {
    expect(parseDiscovery(DISCOVERY, 4242)).toEqual({
      avd: 'Pixel_9',
      pid: 4242,
      serial: 'emulator-5554',
      endpoint: { port: 8554, token: 'AbCdEf0123456789xyz' }
    })
  })

  it('has no endpoint without a token, and refuses an AVD name it could not use', () => {
    expect(parseDiscovery(DISCOVERY.replace(/grpc\.token=.*\n/, ''), 1)?.endpoint).toBeUndefined()
    expect(parseDiscovery(DISCOVERY.replace('avd.id=Pixel_9', 'avd.id=../etc'), 1)).toBeNull()
  })

  it('parses ini files, skipping comments', () => {
    expect(parseIni('# c\nhw.lcd.width = 1080\n\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\n')).toMatchObject({
      'hw.lcd.width': '1080',
      'image.sysdir.1': 'system-images/android-34/google_apis/arm64-v8a/'
    })
  })

  it('picks the emulator log line that says why it stopped', () => {
    const log = 'INFO | Android emulator version 36\nERROR | Running multiple emulators with the same AVD\nINFO | bye\n'
    expect(lastError(log)).toBe('Running multiple emulators with the same AVD')
    expect(lastError('INFO | only info\n')).toBe('INFO | only info')
  })
})
