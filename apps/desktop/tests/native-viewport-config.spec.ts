import { describe, expect, it } from 'vitest'
import { resolveNativeViewportEnabled } from '../src/native-viewport-config.ts'

describe('native viewport startup opt-in', () => {
  it.each([false, true])('defaults off regardless of build inclusion: %s', (built) => {
    expect(resolveNativeViewportEnabled(built, undefined, 'darwin', 'arm64', undefined)).toBe(false)
    expect(resolveNativeViewportEnabled(built, '0', 'win32', 'x64', '44.7.0')).toBe(false)
  })

  it('requires both build inclusion and runtime authorization', () => {
    expect(resolveNativeViewportEnabled(true, '1', 'win32', 'x64', '44.7.0')).toBe(true)
    expect(() => resolveNativeViewportEnabled(false, '1', 'win32', 'x64', '44.7.0'))
      .toThrow('rebuild with DSH_BUILD_NATIVE_VIEWPORT=1')
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
  ])('refuses unqualified runtimes: %s %s %s', (platform, arch, version) => {
    expect(() => resolveNativeViewportEnabled(true, '1', platform, arch, version))
      .toThrow('requires Windows x64 / Electron 44.7.0')
  })
})
