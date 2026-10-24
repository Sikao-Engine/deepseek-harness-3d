/**
 * Downstream preview protocol, not an official plugin API or a persisted Session format.
 * Only the private Host may register trusted native executables; only the owned application
 * top frame may attach. IPC carries handles and metadata, never pixel buffers.
 */
export const NATIVE_VIEWPORT_IPC = {
  list: 'dsh-desktop:native-viewport-list',
  attach: 'dsh-desktop:native-viewport-attach',
  control: 'dsh-desktop:native-viewport-control',
  dispose: 'dsh-desktop:native-viewport-dispose',
  frame: 'dsh-desktop:native-viewport-frame',
  event: 'dsh-desktop:native-viewport-event',
  done: 'dsh-desktop:native-viewport-done',
  error: 'dsh-desktop:native-viewport-error',
} as const

/** First generic revision; incompatible with the camera-command preview revision. */
export const NATIVE_VIEWPORT_PROTOCOL = 2

/** JSON-only engine extension data; no native handles or executable paths. */
export type NativeViewportJson = null | boolean | number | string
  | readonly NativeViewportJson[] | { readonly [key: string]: NativeViewportJson }

/** Input positions and deltas use top-left-origin CSS pixels; wheel deltas use CSS pixels. */
export type NativeViewportInput = {
  readonly type: 'pointer'
  readonly phase: 'down' | 'move' | 'up' | 'cancel'
  readonly pointerId: number
  readonly pointerType: 'mouse' | 'pen' | 'touch'
  readonly x: number
  readonly y: number
  readonly buttons: number
  readonly button: number
  readonly modifiers: number
} | {
  readonly type: 'wheel'
  readonly x: number
  readonly y: number
  readonly deltaX: number
  readonly deltaY: number
  readonly modifiers: number
} | {
  readonly type: 'key'
  readonly code: string
  readonly down: boolean
  readonly repeat: boolean
  readonly modifiers: number
} | {
  readonly type: 'focus'
  readonly focused: boolean
}

/** Resize dimensions use physical pixels; sequence numbers order input and extension admission, not GPU completion. */
export type NativeViewportControl = {
  readonly kind: 'resize'
  readonly width: number
  readonly height: number
  readonly scale: number
} | {
  readonly kind: 'visible'
  readonly value: boolean
} | {
  readonly kind: 'input'
  readonly seq: number
  readonly event: NativeViewportInput
} | {
  readonly kind: 'extension'
  readonly seq: number
  readonly namespace: string
  readonly name: string
  readonly payload: NativeViewportJson
}

/** Renderer-safe discovery; extension namespaces include their own version, for example graphics101.camera.v1. */
export interface NativeViewportDescriptor {
  readonly id: string
  readonly protocol: 2
  readonly extensions: readonly string[]
}

/** Trusted Host declaration; executable resolves inside packageRoot and its bytes must match sha256. */
export interface NativeViewportProducer extends NativeViewportDescriptor {
  readonly packageRoot: string
  readonly executable: string
  readonly sha256: string
  readonly args: readonly string[]
}

/** Process-local registration; revocation stops attached workers before their resources can be reused. */
export type NativeViewportHostEvent = {
  readonly type: 'native-viewport-register'
  readonly producer: NativeViewportProducer
} | {
  readonly type: 'native-viewport-revoke'
  readonly id: string
}

/** Frame identity; generation isolates attachments and epoch isolates resized native surfaces. */
export interface NativeViewportTicket {
  readonly generation: string
  readonly epoch: number
  readonly slot: number
  readonly frameId: number
  readonly width: number
  readonly height: number
  readonly inputSeq: number
}

/** Document-local preview bridge; absence means the feature is not enabled, not a CPU rendering fallback. */
export interface NativeViewportApi {
  /** Platform/API availability only; attach additionally checks producer integrity and adapter information. */
  readonly capabilities: { readonly supported: boolean; readonly protocol: 2 }
  /** @returns Currently registered producers without executable paths or integrity metadata. */
  list(): Promise<readonly NativeViewportDescriptor[]>
  /**
   * Start one worker and await protocol/adapter handshake; rejection awaits worker teardown.
   * Unsupported runtimes, quota, integrity failures and handshake timeout reject attachment.
   * @param producerId - Private Host registration id, never a renderer-supplied executable path.
   * @returns Attachment generation and diagnostic rendering path; does not confirm first-frame readiness.
   */
  attach(producerId: string): Promise<{ generation: string; backend: string }>
  /**
   * Submit generic input or a declared engine extension; invalid messages stop the attachment.
   * @param generation - Attachment owned by this document.
   * @param data - Resize, visibility, input or extension; obsolete sequences are ignored.
   */
  control(generation: string, data: NativeViewportControl): void
  /**
   * Stop admission and await worker exit before releasing the main-process imports.
   * @param generation - Attachment owned by this document; missing attachments are already disposed.
   * @returns Completion of teardown; rejects if resource cleanup fails.
   */
  dispose(generation: string): Promise<void>
  /**
   * Borrow frames; callbacks must await GPU completion and must not retain or close the VideoFrame.
   * Preload closes the frame and releases its import after settlement. Rejection stops the attachment.
   * @param generation - Attachment generation; only one presenter may be registered.
   * @param callback - Presenter resolving only after all submitted GPU use of this frame has completed.
   * @returns Unsubscribe; does not cancel an already running callback or dispose the worker.
   */
  onFrame(generation: string, callback: (frame: VideoFrame, ticket: NativeViewportTicket) => Promise<void>): () => void
  /**
   * Subscribe to diagnostic and lifecycle events; callback exceptions stop the attachment.
   * @param generation - Attachment generation.
   * @param callback - Document-local event receiver; registering replaces the previous receiver.
   * @returns Unsubscribe for this receiver only.
   */
  onEvent(generation: string, callback: (event: Record<string, unknown>) => void): () => void
}

/**
 * Validate private Host IPC before creating native resources; hashing is not a plugin sandbox or signature.
 * @param value - Message received from the Desktop Host child.
 * @returns Whether the message declares a registration or revocation with valid transport fields.
 */
export function isNativeViewportHostEvent(value: unknown): value is NativeViewportHostEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  if (value.type === 'native-viewport-revoke') return 'id' in value && typeof value.id === 'string'
  if (value.type !== 'native-viewport-register' || !('producer' in value)) return false
  const p = value.producer
  return typeof p === 'object' && p !== null && 'id' in p && typeof p.id === 'string' && p.id.length <= 128
    && 'packageRoot' in p && typeof p.packageRoot === 'string'
    && 'executable' in p && typeof p.executable === 'string'
    && 'sha256' in p && typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(p.sha256)
    && 'protocol' in p && p.protocol === NATIVE_VIEWPORT_PROTOCOL
    && 'args' in p && Array.isArray(p.args) && p.args.length <= 32
    && p.args.every((arg: unknown) => typeof arg === 'string' && arg.length <= 1024 && !arg.includes('\0'))
    && 'extensions' in p && Array.isArray(p.extensions) && p.extensions.length <= 32
    && p.extensions.every((name: unknown) => typeof name === 'string' && /^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u.test(name))
}

/**
 * Validate renderer controls before forwarding JSON to a native worker.
 * @param value - Untrusted renderer message.
 * @param extensions - Namespaces declared by the registered producer.
 * @returns Whether the bounded control is valid for this producer.
 */
export function isNativeViewportControl(value: unknown, extensions: readonly string[]): value is NativeViewportControl {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Record<string, unknown>
  try {
    if (JSON.stringify(d).length > 16384) return false
  } catch (_error) {
    return false
  }
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000
  const integer = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max
  if (d.kind === 'resize') return integer(d.width, 0, 2048) && integer(d.height, 0, 2048) && finite(d.scale) && d.scale > 0 && d.scale <= 16
  if (d.kind === 'visible') return typeof d.value === 'boolean'
  if (!integer(d.seq, 1, Number.MAX_SAFE_INTEGER)) return false
  if (d.kind === 'extension') {
    if (typeof d.namespace !== 'string' || !extensions.includes(d.namespace)
      || typeof d.name !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/u.test(d.name)) return false
    const json = (v: unknown, depth: number): boolean => depth <= 16 && (v === null || typeof v === 'boolean'
      || (typeof v === 'string' && v.length <= 16384) || (typeof v === 'number' && Number.isFinite(v))
      || (Array.isArray(v) && v.length <= 256 && v.every(item => json(item, depth + 1)))
      || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 256
        && Object.values(v).every(item => json(item, depth + 1))))
    return json(d.payload, 0) && JSON.stringify(d).length <= 16384
  }
  if (d.kind !== 'input' || typeof d.event !== 'object' || d.event === null) return false
  const e = d.event as Record<string, unknown>
  if (e.type === 'focus') return typeof e.focused === 'boolean'
  if (!integer(e.modifiers, 0, 15)) return false
  if (e.type === 'key') return typeof e.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(e.code)
    && typeof e.down === 'boolean' && typeof e.repeat === 'boolean'
  if (!finite(e.x) || !finite(e.y)) return false
  if (e.type === 'wheel') return finite(e.deltaX) && finite(e.deltaY)
  return e.type === 'pointer' && ['down', 'move', 'up', 'cancel'].includes(String(e.phase))
    && ['mouse', 'pen', 'touch'].includes(String(e.pointerType)) && integer(e.pointerId, 0, Number.MAX_SAFE_INTEGER)
    && integer(e.buttons, 0, 31) && integer(e.button, -1, 4)
}
