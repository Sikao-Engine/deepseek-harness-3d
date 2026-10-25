/**
 * Downstream Windows preview broker for trusted Host plugins, not a native-code sandbox.
 * Producers duplicate D3D11 NT texture handles into main; only handles and metadata cross IPC.
 * The presenter must await GPU completion before acknowledging a lease. A lease timeout stops
 * the worker instead of authorizing texture-slot reuse. Chromium may still perform GPU copies.
 */
import { app, ipcMain, sharedTexture, type BrowserWindow, type IpcMainInvokeEvent, type SharedTextureImportedSubtle } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, dirname } from 'node:path'
import { NATIVE_VIEWPORT_IPC as IPC, NATIVE_VIEWPORT_MAX_SLOTS, NATIVE_VIEWPORT_MAX_WINDOWS, NATIVE_VIEWPORT_PROTOCOL, isNativeViewportControl, isNativeViewportSpawnRequest, parseNativeViewportFeatures, type NativeViewportHostEvent, type NativeViewportProducer, type NativeViewportTicket } from './native-viewport-protocol.ts'

interface Frame extends NativeViewportTicket { readonly handle: string; readonly timestampUs: number }
interface Viewport {
  readonly generation: string
  readonly producer: string
  readonly extensions: readonly string[]
  features: string[] // Worker hello capabilities; gates protocol v2 input fields.
  ready: boolean
  frameId: number
  // Protocol v2.1: per-window epoch and ring sizes; window ids 0..15, 0 = main.
  readonly windows: Map<number, { epoch: number; slots: number }>
  readonly window: BrowserWindow
  readonly worker: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  readonly leases: Map<string, { frame: Frame; imported: SharedTextureImportedSubtle; timer: ReturnType<typeof setTimeout> }>
  queued?: Frame | undefined
  stopping?: Promise<void>
  failed: boolean
  inputSeq: number
  offered: number
  released: number
  dropped: number
  drain?: (() => void) | undefined
}

function ticketKey(frame: NativeViewportTicket): string { return `${frame.generation}:${frame.window ?? 0}:${frame.epoch}:${frame.slot}:${frame.frameId}` }
function send(v: Viewport, command: string): void { if (v.worker.stdin.writable) v.worker.stdin.write(`${command}\n`) }
function release(v: Viewport, frame: Frame): void { send(v, JSON.stringify({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId, ...(frame.window !== undefined && frame.window !== 0 ? { window: frame.window } : {}) })) }

/** Own registrations, process exit, imports, and document-bound leases for one Desktop backend. */
export class DesktopNativeViewports {
  private readonly producers = new Map<string, NativeViewportProducer>()
  private readonly sessions = new Map<string, Viewport>()

  /** @param assertSender - Main-owned authorization requiring the application window's top frame. */
  constructor(private readonly assertSender: (event: IpcMainInvokeEvent) => BrowserWindow) {
    ipcMain.handle(IPC.list, (e) => {
      this.assertSender(e)
      return [...this.producers.values()].map(({ id, protocol, extensions }) => ({ id, protocol, extensions }))
    })
    ipcMain.handle(IPC.attach, (e, id: unknown) => this.attach(e, id))
    ipcMain.handle(IPC.spawn, (e, request: unknown) => this.spawn(e, request))
    ipcMain.handle(IPC.dispose, async (e, generation: unknown) => {
      const v = this.owned(e, generation)
      if (v !== undefined) await this.stop(v)
    })
    ipcMain.on(IPC.control, (e, generation: unknown, data: unknown) => {
      try { const v = this.owned(e, generation); if (v !== undefined) this.control(v, data) }
      catch (error) { console.warn('Native viewport rejected control', error) }
    })
    ipcMain.on(IPC.done, (e, ticket: NativeViewportTicket) => {
      try {
        // Renderer IPC is untyped at runtime even though the trusted preload sends this interface.
        const v = this.owned(e, ticket.generation)
        if (v === undefined) return
        const key = ticketKey(ticket), lease = v.leases.get(key)
        if (lease === undefined) return
        v.leases.delete(key); clearTimeout(lease.timer)
        // Preload acknowledges only after its borrowed frame and texture import have been released.
        lease.imported.release(); release(v, lease.frame); v.released++
        if (v.leases.size === 0) v.drain?.()
        if (v.queued !== undefined && !v.failed && v.stopping === undefined) {
          const next = v.queued; v.queued = undefined; this.deliver(v, next)
        }
      } catch (error) { console.warn('Native viewport rejected release', error) }
    })
    ipcMain.on(IPC.error, (e, generation: unknown) => {
      try { const v = this.owned(e, generation); if (v !== undefined) this.fail(v, new Error('Native viewport presenter failed')) }
      catch (error) { console.warn('Native viewport rejected error', error) }
    })
    app.on('child-process-gone', (_e, detail) => {
      if (detail.type === 'GPU') for (const v of this.sessions.values()) this.fail(v, new Error('GPU process exited'))
    })
  }

  /**
   * Accept registration exclusively from the validated private Host IPC connection.
   * @param event - Trusted producer registration or revocation; revocation requests asynchronous teardown.
   * @throws When registration duplicates an id or exceeds the producer quota.
   */
  accept(event: NativeViewportHostEvent): void {
    if (event.type === 'native-viewport-register') {
      if (this.producers.has(event.producer.id)) throw new Error('Native viewport producer already registered')
      if (this.producers.size >= 8) throw new Error('Native viewport producer quota exceeded')
      this.producers.set(event.producer.id, event.producer)
    } else {
      this.producers.delete(event.id)
      for (const v of this.sessions.values()) {
        if (v.producer === event.id) void this.stop(v).catch((error: unknown) => { console.error(error) })
      }
    }
  }

  /**
   * Revoke all producers on Host exit or restart; prevent new attaches while draining workers.
   * @returns Completion after native worker exit and import release; cleanup failures reject.
   */
  async reset(): Promise<void> {
    this.producers.clear()
    await Promise.all([...this.sessions.values()].map(v => this.stop(v)))
  }

  private owned(e: IpcMainInvokeEvent, generation: unknown): Viewport | undefined {
    const window = this.assertSender(e)
    if (typeof generation !== 'string') return undefined
    const v = this.sessions.get(generation)
    return v?.window === window ? v : undefined
  }

  private async attach(e: IpcMainInvokeEvent, id: unknown): Promise<{ generation: string; backend: string; features: readonly string[] }> {
    if (typeof id !== 'string') throw new Error('Invalid producer id')
    const producer = this.producers.get(id)
    if (producer === undefined) throw new Error('Native viewport producer unavailable; enable installed plugin')
    if ([...this.sessions.values()].some(v => v.producer === id)) throw new Error('Producer already has an attached viewport')
    return this.launch(e, producer, [...producer.args])
  }

  /** Protocol v2.1: spawn a second worker of a registered producer (game session); same checks as attach. */
  private async spawn(
    e: IpcMainInvokeEvent, request: unknown,
  ): Promise<{ generation: string; backend: string; features: readonly string[] }> {
    if (!isNativeViewportSpawnRequest(request)) throw new Error('Invalid native viewport spawn request')
    const producer = this.producers.get(request.producerId)
    if (producer === undefined) throw new Error('Native viewport producer unavailable; enable installed plugin')
    return this.launch(e, producer, [...request.args])
  }

  private async launch(
    e: IpcMainInvokeEvent, producer: NativeViewportProducer, extraArgs: readonly string[],
  ): Promise<{ generation: string; backend: string; features: readonly string[] }> {
    const window = this.assertSender(e)
    const id = producer.id
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.electron !== '44.7.0') throw new Error('Native viewport requires Windows x64 / Electron 44.7.0')
    if (this.sessions.size >= 4) throw new Error('Native viewport session quota exceeded')
    const root = realpathSync(producer.packageRoot)
    const executable = realpathSync(resolve(root, producer.executable))
    const within = relative(root, executable)
    if (isAbsolute(producer.executable) || isAbsolute(within) || within.startsWith('..') || !executable.endsWith('.exe')) throw new Error('Native worker outside installed package')
    if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== producer.sha256) throw new Error('Native worker integrity mismatch')
    const gpu = await app.getGPUInfo('complete')
    if (this.producers.get(id) !== producer || window.isDestroyed() || this.sessions.size >= 4) throw new Error('Native viewport registration changed during attach')
    if (typeof gpu !== 'object' || gpu === null || !('gpuDevice' in gpu) || !Array.isArray(gpu.gpuDevice)) throw new Error('Chromium adapter information unavailable')
    const activeGPU: { vendorId: number; deviceId: number } | undefined = gpu.gpuDevice.find(
      (device: unknown): device is { active: true; vendorId: number; deviceId: number } =>
        typeof device === 'object' && device !== null && 'active' in device && device.active === true
      && 'vendorId' in device && typeof device.vendorId === 'number' && 'deviceId' in device && typeof device.deviceId === 'number')
    if (activeGPU === undefined) throw new Error('Chromium active adapter unavailable')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)))
    const worker = spawn(executable, [...extraArgs, '--dsh-viewport-protocol', String(NATIVE_VIEWPORT_PROTOCOL), '--broker-pid', String(process.pid)], { cwd: dirname(executable), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = new Promise<void>((done) => { worker.once('close', () => { done() }) })
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((done, reject) => { readyResolve = done; readyReject = reject })
    const handshake = setTimeout(() => { readyReject(new Error('Native viewport handshake timed out')) }, 5000)
    void exited.then(() => { readyReject(new Error('Native worker exited before attach completed')) })
    const v: Viewport = {
      generation: randomUUID(), producer: id, extensions: producer.extensions, features: [], ready: false, frameId: 0,
      windows: new Map([[0, { epoch: 0, slots: 0 }]]),
      window, worker, exited, leases: new Map(),
      failed: false, inputSeq: 0, offered: 0, released: 0, dropped: 0,
    }
    this.sessions.set(v.generation, v)
    worker.once('error', (error) => { this.fail(v, error) })
    worker.once('exit', (code) => { if (v.stopping === undefined) this.fail(v, new Error(`Native worker exited (${String(code)})`)) })
    // DEBUG (black-screen investigation): forward worker stderr content so the
    // engine-side [dsh-slot]/[dsh-debug] traces are visible in the desktop log.
    worker.stderr.on('data', (chunk: Buffer) => { for (const line of chunk.toString('utf8').split(/\r?\n/u)) if (line.trim()) this.event(v, { type: 'log', message: line.trim().slice(0, 2000) }) })
    createInterface({ input: worker.stdout }).on('line', (line) => {
      try {
        if (line.length > 16384) throw new Error('Native worker message exceeds protocol limit')
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid native worker message')
        const m = parsed as Record<string, unknown>
        if (m.type === 'hello') {
          if (v.ready || m.protocol !== NATIVE_VIEWPORT_PROTOCOL || m.transport !== 'd3d11-nt-rgba8'
            || !Array.isArray(m.extensions) || JSON.stringify(m.extensions) !== JSON.stringify(v.extensions)) throw new Error('Native worker protocol mismatch')
          if (activeGPU.vendorId !== m.vendorId || activeGPU.deviceId !== m.deviceId) throw new Error('Chromium/native adapter IDs differ')
          const features = parseNativeViewportFeatures(m.features)
          if (features === undefined) throw new Error('Native worker advertised malformed features')
          v.features = [...features]
          v.ready = true
          readyResolve()
          this.event(v, { ...m, adapterMatch: 'vendor/device only; identical multi-GPU adapters not verified' })
        } else if (!v.ready) throw new Error('Native worker message before hello')
        else if (m.type === 'extension') {
          if (!isNativeViewportControl({ kind: 'extension', seq: 1, namespace: m.namespace, name: m.name, payload: m.payload }, v.extensions)) throw new Error('Invalid native extension event')
          this.event(v, m)
        } else if (m.type === 'frame') {
          if (!['epoch', 'slot', 'frameId', 'width', 'height', 'inputSeq', 'timestampUs'].every(k => Number.isSafeInteger(m[k]) && Number(m[k]) >= 0)
            || (m.window !== undefined && !(Number.isSafeInteger(m.window)
              && Number(m.window) >= 0 && Number(m.window) < NATIVE_VIEWPORT_MAX_WINDOWS))
            || Number(m.width) < 1 || Number(m.height) < 1 || Number(m.width) > 2048 || Number(m.height) > 2048
            || typeof m.handle !== 'string' || !/^\d{1,20}$/u.test(m.handle)) throw new Error('Invalid native frame')
          const frame = { ...m, generation: v.generation } as Frame
          if (process.env.DSH_NATIVE_VIEWPORT_TRACE) console.error('[nv-trace]', JSON.stringify({ frame: { epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId, window: frame.window ?? 0, width: frame.width, height: frame.height, inputSeq: frame.inputSeq }, state: { frameId: v.frameId, inputSeq: v.inputSeq, leases: [...v.leases.values()].map(lease => ({ epoch: lease.frame.epoch, slot: lease.frame.slot, frameId: lease.frame.frameId, window: lease.frame.window ?? 0 })), queued: v.queued === undefined ? undefined : { epoch: v.queued.epoch, slot: v.queued.slot, frameId: v.queued.frameId, window: v.queued.window ?? 0 }, windows: [...v.windows.entries()].map(([id, entry]) => ({ window: id, epoch: entry.epoch, slots: entry.slots })) } }))
          const windowId = frame.window ?? 0
          const win = v.windows.get(windowId)
          if (win === undefined || frame.slot >= win.slots) throw new Error(`Native worker frame references an unannounced window or slot (frame window ${String(frame.window ?? 0)} slot ${String(frame.slot)}; announced: ${JSON.stringify([...v.windows.entries()].map(([id, entry]) => [id, entry.epoch, entry.slots]))})`)
          const sameWindow = (other: Frame | undefined): boolean => (other?.window ?? 0) === windowId
          if (frame.frameId <= v.frameId) throw new Error(`Native worker frameId not increasing (frame ${String(frame.frameId)} <= last ${String(v.frameId)}; frame ${JSON.stringify({ epoch: frame.epoch, slot: frame.slot, window: windowId })}; leases: ${JSON.stringify([...v.leases.values()].map(lease => ({ epoch: lease.frame.epoch, slot: lease.frame.slot, frameId: lease.frame.frameId, window: lease.frame.window ?? 0 })))}; queued: ${JSON.stringify(v.queued === undefined ? undefined : { epoch: v.queued.epoch, slot: v.queued.slot, frameId: v.queued.frameId, window: v.queued.window ?? 0 })})`)
          if (frame.epoch < 1 || frame.epoch < win.epoch) throw new Error(`Native worker frame epoch regressed (frame epoch ${String(frame.epoch)} < announced ${String(win.epoch)}; frame ${JSON.stringify({ slot: frame.slot, window: windowId, frameId: frame.frameId })}; windows: ${JSON.stringify([...v.windows.entries()].map(([id, entry]) => ({ window: id, epoch: entry.epoch, slots: entry.slots })))})`)
          if (frame.inputSeq > v.inputSeq) throw new Error(`Native worker frame inputSeq ahead of broker (frame ${String(frame.inputSeq)} > broker ${String(v.inputSeq)})`)
          if ([...v.leases.values()].some(lease => (lease.frame.window ?? 0) === windowId && lease.frame.slot === frame.slot)
            || (sameWindow(v.queued) && v.queued?.slot === frame.slot)) throw new Error(`Native worker reused frame identity or leased slot (frame ${JSON.stringify({ epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId, window: windowId })}; leases: ${JSON.stringify([...v.leases.values()].map(lease => ({ epoch: lease.frame.epoch, slot: lease.frame.slot, frameId: lease.frame.frameId, window: lease.frame.window ?? 0 })))}; queued: ${JSON.stringify(v.queued === undefined ? undefined : { epoch: v.queued.epoch, slot: v.queued.slot, frameId: v.queued.frameId, window: v.queued.window ?? 0 })})`)
          if (frame.epoch > win.epoch && ([...v.leases.values()].some(lease => (lease.frame.window ?? 0) === windowId) || sameWindow(v.queued))) throw new Error('Native worker resized a leased surface')
          v.frameId = frame.frameId; win.epoch = frame.epoch
          v.offered++
          if (v.stopping !== undefined || v.failed) { release(v, frame); return }
          if (v.leases.size >= 2) {
            if (v.queued !== undefined) { release(v, v.queued); v.dropped++ }
            v.queued = frame
          } else this.deliver(v, frame)
        } else if (m.type === 'surface' || m.type === 'stats' || m.type === 'stopped') {
          if (m.type === 'surface') {
            const surfaceWindow: number = typeof m.window === 'number' ? m.window : 0
            if (!(Number.isSafeInteger(surfaceWindow) && surfaceWindow >= 0 && surfaceWindow < NATIVE_VIEWPORT_MAX_WINDOWS)
              || !Number.isSafeInteger(m.slots) || Number(m.slots) < 0 || Number(m.slots) > 4
              || (Number(m.slots) === 0 && (surfaceWindow === 0 || m.width !== 0 || m.height !== 0))
              || !Number.isSafeInteger(m.epoch) || Number(m.epoch) < 1) throw new Error('Invalid native surface window geometry')
            if (m.cssWidth !== undefined
              && (!(typeof m.cssWidth === 'number' && Number.isFinite(m.cssWidth) && m.cssWidth > 0 && m.cssWidth <= 16384)
                || !(typeof m.cssHeight === 'number' && Number.isFinite(m.cssHeight) && m.cssHeight > 0 && m.cssHeight <= 16384))) {
              throw new Error('Invalid native surface css geometry')
            }
            // Protocol v2.1 quotas: at most 16 windows and 24 total frame slots per session.
            const next = new Map(v.windows)
            if (Number(m.slots) === 0) {
              next.delete(surfaceWindow)
              if (v.queued?.window === surfaceWindow) { release(v, v.queued); v.queued = undefined }
            } else next.set(surfaceWindow, { epoch: Number(m.epoch), slots: Number(m.slots) })
            if (next.size > NATIVE_VIEWPORT_MAX_WINDOWS
              || [...next.values()].reduce((total, entry) => total + entry.slots, 0) > NATIVE_VIEWPORT_MAX_SLOTS) {
              throw new Error('Native viewport window or slot quota exceeded')
            }
            v.windows.clear()
            for (const [windowId, entry] of next) v.windows.set(windowId, entry)
          }
          this.event(v, { ...m, offered: v.offered, released: v.released, dropped: v.dropped })
          if (Number(m.validationErrors) > 0) throw new Error('Native validation error')
        } else throw new Error('Unknown native worker message')
      } catch (error) { readyReject(error instanceof Error ? error : new Error(String(error))); this.fail(v, error) }
    })
    const gone = (): void => { void this.stop(v).catch((error: unknown) => { console.error(error) }) }
    const navigate = (_event: Electron.Event, _url: string, _inPlace: boolean, main: boolean): void => { if (main) gone() }
    window.webContents.once('render-process-gone', gone)
    window.webContents.once('destroyed', gone)
    window.webContents.on('did-start-navigation', navigate)
    void exited.then(() => {
      window.webContents.removeListener('render-process-gone', gone)
      window.webContents.removeListener('destroyed', gone)
      window.webContents.removeListener('did-start-navigation', navigate)
    })
    try {
      await ready
      if (v.failed || v.stopping !== undefined) throw new Error('Native viewport stopped during attach')
      return { generation: v.generation, backend: 'D3D11 NT texture → sharedTexture → VideoFrame', features: v.features }
    } catch (error) {
      await this.stop(v)
      throw error
    } finally {
      clearTimeout(handshake)
    }
  }

  private event(v: Viewport, data: object): void {
    if (!v.window.isDestroyed() && !v.window.webContents.isDestroyed()) v.window.webContents.send(IPC.event, v.generation, data)
  }

  private deliver(v: Viewport, frame: Frame): void {
    let imported: SharedTextureImportedSubtle | undefined
    try {
      const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(frame.handle))
      imported = sharedTexture.subtle.importSharedTexture({ pixelFormat: 'rgba', codedSize: { width: frame.width, height: frame.height }, timestamp: frame.timestampUs, handle: { ntHandle: handle } })
      const transfer = imported.startTransferSharedTexture()
      const ticket: NativeViewportTicket = {
        generation: v.generation, epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId,
        width: frame.width, height: frame.height, inputSeq: frame.inputSeq,
        ...(frame.window !== undefined && frame.window !== 0 ? { window: frame.window } : {}),
      }
      const timer = setTimeout(() => { this.fail(v, new Error('GPU lease timeout; no forced texture reuse')) }, 5000)
      v.leases.set(ticketKey(ticket), { frame, imported, timer })
      v.window.webContents.send(IPC.frame, ticket, transfer)
    } catch (error) { if (imported !== undefined && !v.leases.has(ticketKey(frame))) imported.release(); this.fail(v, error) }
  }

  private control(v: Viewport, data: unknown): void {
    if (v.failed || v.stopping !== undefined) return
    if (!isNativeViewportControl(data, v.extensions, v.features)) {
      this.fail(v, new Error('Invalid native viewport control'))
      return
    }
    if (data.kind === 'input' || data.kind === 'extension') {
      if (data.seq <= v.inputSeq) return
      v.inputSeq = data.seq
    }
    send(v, JSON.stringify(data))
  }

  private fail(v: Viewport, error: unknown): void {
    if (v.failed || v.stopping !== undefined) return
    v.failed = true
    console.error('Native viewport stopped', error)
    this.event(v, { type: 'error', message: error instanceof Error ? error.message : 'Native viewport failed' })
    void this.stop(v).catch((failure: unknown) => { console.error(failure) })
  }

  private stop(v: Viewport): Promise<void> {
    return v.stopping ??= (async () => {
      send(v, JSON.stringify({ kind: 'visible', value: false }))
      if (v.queued !== undefined) { release(v, v.queued); v.queued = undefined }
      this.event(v, { type: 'stopping' })
      if (v.leases.size > 0 && !v.failed && !v.window.isDestroyed() && !v.window.webContents.isDestroyed()) {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 1500)
          v.drain = () => { clearTimeout(timer); done() }
        })
        v.drain = undefined
      }
      send(v, JSON.stringify({ kind: 'stop' })); v.worker.stdin.end()
      const kill = setTimeout(() => v.worker.kill(), 3000)
      await v.exited
      clearTimeout(kill)
      for (const lease of v.leases.values()) { clearTimeout(lease.timer); lease.imported.release() }
      v.leases.clear()
      this.sessions.delete(v.generation)
      this.event(v, { type: 'disposed' })
    })()
  }
}
