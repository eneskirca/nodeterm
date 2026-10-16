import { describe, expect, it } from 'vitest'
import {
  defaultWallpaper,
  GRADIENT_WALLPAPERS,
  normalizeWallpaper,
  recentWallpaperImage,
  wallpaperChoice,
  wallpapersToKeep
} from './wallpaper'

describe('defaultWallpaper (Liquid Glass chosen with no wallpaper)', () => {
  it('takes the first still (the scan puts Sonoma Horizon first)', () => {
    expect(defaultWallpaper([{ id: 'mac:a' }, { id: 'mac:b' }])).toEqual({ kind: 'preset', id: 'mac:a' })
  })
  it('falls back to a gradient where there are no stills', () => {
    const w = defaultWallpaper([])
    expect(w).toEqual({ kind: 'preset', id: GRADIENT_WALLPAPERS[0].id })
    expect(normalizeWallpaper(w)).toEqual(w)
  })
})

describe('recent wallpaper image (choosing a preset keeps the last import)', () => {
  const img = { kind: 'image', path: '/ud/wallpapers/' + 'a'.repeat(40) + '.png' } as const
  const sunrise = { kind: 'preset', id: GRADIENT_WALLPAPERS[0].id } as const
  it('leaving an image for a preset records it as the recent image', () => {
    expect(wallpaperChoice(img, sunrise)).toEqual({ desktopWallpaper: sunrise, recentWallpaperImage: img.path })
  })
  it('choosing an image records it; preset to preset leaves the recent image alone', () => {
    expect(wallpaperChoice(sunrise, img)).toEqual({ desktopWallpaper: img, recentWallpaperImage: img.path })
    expect(wallpaperChoice(sunrise, { kind: 'none' })).toEqual({ desktopWallpaper: { kind: 'none' } })
  })
  it('the prune keeps both the choice and the recent image; junk is ignored', () => {
    expect(wallpapersToKeep({ desktopWallpaper: sunrise, recentWallpaperImage: img.path })).toEqual([sunrise, img])
    expect(recentWallpaperImage(42)).toBeNull()
    expect(recentWallpaperImage('')).toBeNull()
  })
})

describe('normalizeWallpaper system-still prefixes', () => {
  it('round-trips mac: and win: still ids', () => {
    expect(normalizeWallpaper({ kind: 'preset', id: 'mac:Sonoma.heic' })).toEqual({ kind: 'preset', id: 'mac:Sonoma.heic' })
    expect(normalizeWallpaper({ kind: 'preset', id: 'win:Windows/img0.jpg' })).toEqual({
      kind: 'preset',
      id: 'win:Windows/img0.jpg'
    })
  })

  it('still collapses an unknown prefix to none', () => {
    expect(normalizeWallpaper({ kind: 'preset', id: 'linux:x.jpg' })).toEqual({ kind: 'none' })
    expect(normalizeWallpaper({ kind: 'preset', id: 'windows:x.jpg' })).toEqual({ kind: 'none' })
  })
})
