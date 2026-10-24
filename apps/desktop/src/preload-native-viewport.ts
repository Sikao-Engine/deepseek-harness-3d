/** Keep imported texture and VideoFrame lifetimes inside the sandboxed preload. */
import { ipcRenderer, sharedTexture } from 'electron'
import { NATIVE_VIEWPORT_IPC as IPC, type NativeViewportApi, type NativeViewportDescriptor, type NativeViewportTicket } from './native-viewport-protocol.ts'

/**
 * Create document-scoped handlers only after main authorizes the preview.
 * @returns Bridge owning imported textures and borrowed VideoFrames. Presenter callbacks must
 * await WebGPU queue completion; callbacks that reject stop the worker without slot reuse.
 */
export function createNativeViewportApi(): NativeViewportApi {
  const frames = new Map<string, (frame: VideoFrame, ticket: NativeViewportTicket) => Promise<void>>()
  const events = new Map<string, (event: Record<string, unknown>) => void>()
  ipcRenderer.on(IPC.frame, (_event, ticket: NativeViewportTicket, transfer: Electron.SharedTextureTransfer) => {
    void present(ticket, transfer).catch((error: unknown) => {
      console.error('Native viewport frame cleanup failed; attachment stopped', error)
      ipcRenderer.send(IPC.error, ticket.generation)
    })
  })
  async function present(ticket: NativeViewportTicket, transfer: Electron.SharedTextureTransfer): Promise<void> {
    let imported: Electron.SharedTextureImportedSubtle | undefined
    let frame: VideoFrame | undefined
    try {
      imported = sharedTexture.subtle.finishTransferSharedTexture(transfer)
      const handler = frames.get(ticket.generation)
      frame = imported.getVideoFrame()
      if (handler !== undefined) await handler(frame, ticket)
      frame.close(); frame = undefined
      imported.release(() => { ipcRenderer.send(IPC.done, ticket) }); imported = undefined
    } catch (_error) {
      frame?.close(); imported?.release()
      ipcRenderer.send(IPC.error, ticket.generation)
    }
  }
  ipcRenderer.on(IPC.event, (_event, generation: string, data: Record<string, unknown>) => {
    try { events.get(generation)?.(data) }
    catch (_error) { ipcRenderer.send(IPC.error, generation) }
  })
  return {
    capabilities: { supported: process.platform === 'win32' && process.sandboxed && process.contextIsolated && typeof sharedTexture.subtle.finishTransferSharedTexture === 'function', protocol: 2 },
    list: () => ipcRenderer.invoke(IPC.list) as Promise<readonly NativeViewportDescriptor[]>,
    attach: id => ipcRenderer.invoke(IPC.attach, id) as Promise<{ generation: string; backend: string }>,
    control: (generation, data) => { ipcRenderer.send(IPC.control, generation, data) },
    dispose: async (generation) => {
      await ipcRenderer.invoke(IPC.dispose, generation)
      frames.delete(generation); events.delete(generation)
    },
    onFrame: (generation, callback) => {
      if (frames.has(generation)) throw new Error('Viewport presenter already registered')
      frames.set(generation, callback)
      return () => { if (frames.get(generation) === callback) frames.delete(generation) }
    },
    onEvent: (generation, callback) => {
      events.set(generation, callback)
      return () => { if (events.get(generation) === callback) events.delete(generation) }
    },
  }
}
