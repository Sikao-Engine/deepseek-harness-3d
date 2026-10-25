import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: (...args: unknown[]) => void) => { ipc.handlers.set(channel, handler) },
    send: ipc.send,
    invoke: ipc.invoke,
  },
  sharedTexture: { subtle: { finishTransferSharedTexture: vi.fn() } },
}))

import { createNativeViewportApi } from '../src/preload-native-viewport.ts'
import { NATIVE_VIEWPORT_IPC as IPC } from '../src/native-viewport-protocol.ts'

describe('native viewport event admission', () => {
  beforeEach(() => { ipc.handlers.clear(); vi.clearAllMocks() })

  it('replays startup window events in order when the presenter subscribes', () => {
    const api = createNativeViewportApi()
    const created = { type: 'extension', namespace: 'godot.window.v1', name: 'created', payload: { window: 1 } }
    const surface = { type: 'surface', window: 1, epoch: 1 }
    ipc.handlers.get(IPC.event)?.(undefined, 'session', created)
    ipc.handlers.get(IPC.event)?.(undefined, 'session', surface)
    const received = vi.fn()
    api.onEvent('session', received)
    expect(received.mock.calls).toEqual([[created], [surface]])
    const visible = { type: 'extension', name: 'visibility' }
    ipc.handlers.get(IPC.event)?.(undefined, 'session', visible)
    expect(received).toHaveBeenLastCalledWith(visible)
  })

  it('discards queued events when the instance is disposed', async () => {
    const api = createNativeViewportApi()
    ipc.handlers.get(IPC.event)?.(undefined, 'session', { type: 'surface' })
    await api.dispose('session')
    const received = vi.fn()
    api.onEvent('session', received)
    expect(received).not.toHaveBeenCalled()
  })

  it('stops instances whose unclaimed event queue exceeds the quota', () => {
    createNativeViewportApi()
    for (let i = 0; i < 257; i++) ipc.handlers.get(IPC.event)?.(undefined, 'session', { type: 'surface' })
    expect(ipc.send).toHaveBeenCalledWith(IPC.error, 'session')
  })

  it('contains presenter event failures and preserves replacement ownership', () => {
    const api = createNativeViewportApi()
    ipc.handlers.get(IPC.event)?.(undefined, 'session', { type: 'surface' })
    const unsubscribe = api.onEvent('session', () => { throw new Error('presenter failed') })
    expect(ipc.send).toHaveBeenCalledWith(IPC.error, 'session')
    const replacement = vi.fn()
    api.onEvent('session', replacement)
    unsubscribe()
    ipc.handlers.get(IPC.event)?.(undefined, 'session', { type: 'stats' })
    expect(replacement).toHaveBeenCalledWith({ type: 'stats' })
  })
})
