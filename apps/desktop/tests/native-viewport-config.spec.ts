import { describe, expect, it } from 'vitest'
import { resolveNativeViewportEnabled } from '../src/native-viewport-config.ts'

describe('native viewport startup opt-out', () => {
  it('defaults on for included builds on qualified runtimes', () => {
    expect(resolveNativeViewportEnabled(true, undefined, 'win32', 'x64', '44.7.0')).toBe(true)
  })

  it('stays off when the build excludes the broker', () => {
    expect(resolveNativeViewportEnabled(false, undefined, 'win32', 'x64', '44.7.0')).toBe(false)
  })

  it.each([
    ['darwin', 'x64', '44.7.0'],
    ['win32', 'arm64', '44.7.0'],
    ['win32', 'x64', '44.8.0'],
    ['win32', 'x64', undefined],
  ])('silently disables by default on unqualified runtimes: %s %s %s', (platform, arch, version) => {
    expect(resolveNativeViewportEnabled(true, undefined, platform, arch, version)).toBe(false)
  })

  it('explicit 0 disables even included qualified builds', () => {
    expect(resolveNativeViewportEnabled(true, '0', 'win32', 'x64', '44.7.0')).toBe(false)
    expect(resolveNativeViewportEnabled(true, '0', 'darwin', 'arm64', undefined)).toBe(false)
  })

  it('explicit 1 requires build inclusion', () => {
    expect(resolveNativeViewportEnabled(true, '1', 'win32', 'x64', '44.7.0')).toBe(true)
    expect(() => resolveNativeViewportEnabled(false, '1', 'win32', 'x64', '44.7.0'))
      .toThrow('rebuild without DSH_BUILD_NATIVE_VIEWPORT=0')
  })

  it.each(['', 'true', '2'])('rejects malformed runtime authorization: %s', (value) => {
    expect(() => resolveNativeViewportEnabled(true, value, 'win32', 'x64', '44.7.0'))
      .toThrow('DSH_DESKTOP_NATIVE_VIEWPORT must be 0 or 1')
  })

  it.each([
    ['darwin', 'x64', '44.7.0'],
    ['win32', 'arm64', '44.7.0'],
    ['win32', 'x64', '44.8.0'],
    ['win32', 'x64', undefined],
  ])('refuses explicit authorization on unqualified runtimes: %s %s %s', (platform, arch, version) => {
    expect(() => resolveNativeViewportEnabled(true, '1', platform, arch, version))
      .toThrow('requires Windows x64 / Electron 44.7.0')
  })
})
