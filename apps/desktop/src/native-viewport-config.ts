/** Default-on opt-out for the downstream Windows shared-texture preview. */

/** Argument issued only by main to the owned, sandboxed application preload. */
export const NATIVE_VIEWPORT_PRELOAD_ARGUMENT = '--dsh-native-viewport=1'

/**
 * Resolve startup authorization; this fork enables the preview by default wherever it can run.
 * @param built - Whether the Desktop bundle includes the experimental broker.
 * @param requested - Runtime DSH_DESKTOP_NATIVE_VIEWPORT value; omitted enables it, 0 disables it.
 * @param platform - Electron application's operating system.
 * @param arch - Electron application's process architecture.
 * @param electronVersion - Exact qualified Electron version, not its bundled Node version.
 * @returns Whether main may install IPC handlers and authorize Host registration.
 * @throws If the opt-out is malformed, an explicit 1 misses build inclusion, or an explicit 1 targets an unqualified runtime.
 */
export function resolveNativeViewportEnabled(
  built: boolean,
  requested: string | undefined,
  platform: string,
  arch: string,
  electronVersion: string | undefined,
): boolean {
  if (requested === '0') return false
  if (requested !== undefined && requested !== '1') throw new Error('dsh desktop: DSH_DESKTOP_NATIVE_VIEWPORT must be 0 or 1')
  const qualified = platform === 'win32' && arch === 'x64' && electronVersion === '44.7.0'
  if (requested === '1') {
    if (!built) throw new Error('dsh desktop: native viewport is not included; rebuild without DSH_BUILD_NATIVE_VIEWPORT=0')
    if (!qualified) {
      throw new Error('dsh desktop: native viewport requires Windows x64 / Electron 44.7.0; set DSH_DESKTOP_NATIVE_VIEWPORT=0')
    }
    return true
  }
  return built && qualified
}
