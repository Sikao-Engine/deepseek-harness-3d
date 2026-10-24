import { describe, expect, it } from 'vitest'
import { isNativeViewportControl, isNativeViewportHostEvent } from '../src/native-viewport-protocol.ts'

const extensions = ['graphics101.camera.v1']

describe('generic native viewport protocol', () => {
  it('accepts transport-neutral input and declared extensions', () => {
    for (const event of [
      { type: 'focus', focused: false },
      { type: 'key', code: 'ArrowLeft', down: true, repeat: false, modifiers: 3 },
      { type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 100, modifiers: 0 },
      { type: 'pointer', phase: 'move', pointerId: 7, pointerType: 'pen', x: -10, y: 20, button: -1, buttons: 1, modifiers: 0 },
    ]) expect(isNativeViewportControl({ kind: 'input', seq: 1, event }, extensions)).toBe(true)
    expect(isNativeViewportControl({ kind: 'resize', width: 800, height: 600, scale: 1.5 }, extensions)).toBe(true)
    expect(isNativeViewportControl({ kind: 'visible', value: false }, extensions)).toBe(true)
    expect(isNativeViewportControl({ kind: 'extension', seq: 2, namespace: extensions[0], name: 'rotate', payload: { value: true } }, extensions)).toBe(true)
  })

  it.each([
    null,
    { kind: 'input', seq: 1, command: 'orbit', x: 1, y: 2 },
    { kind: 'input', seq: 0, event: { type: 'focus', focused: false } },
    { kind: 'resize', width: 2049, height: 1, scale: 1 },
    { kind: 'resize', width: 1, height: 1, scale: 0 },
    { kind: 'input', seq: 1, event: { type: 'key', code: 'KeyW\nstop', down: true, repeat: false, modifiers: 0 } },
    { kind: 'input', seq: 1, event: { type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: Infinity, modifiers: 0 } },
    { kind: 'extension', seq: 1, namespace: 'godot.editor.v1', name: 'reset', payload: null },
    { kind: 'extension', seq: 1, namespace: extensions[0], name: 'rotate', payload: { value: undefined } },
    { kind: 'extension', seq: 1, namespace: extensions[0], name: 'reset', payload: 'x'.repeat(16385) },
  ])('rejects invalid or undeclared controls: %j', (value) => {
    expect(isNativeViewportControl(value, extensions)).toBe(false)
  })

  it('requires generic worker metadata at Host registration', () => {
    const producer = { id: 'fixture', packageRoot: '/installed', executable: 'worker.exe', sha256: 'a'.repeat(64), protocol: 2, args: [], extensions }
    expect(isNativeViewportHostEvent({ type: 'native-viewport-register', producer })).toBe(true)
    expect(isNativeViewportHostEvent({ type: 'native-viewport-register', producer: { ...producer, protocol: 1 } })).toBe(false)
    expect(isNativeViewportHostEvent({ type: 'native-viewport-register', producer: { ...producer, extensions: ['camera'] } })).toBe(false)
    expect(isNativeViewportHostEvent({ type: 'native-viewport-register', producer: { ...producer, args: ['bad\0arg'] } })).toBe(false)
    expect(isNativeViewportHostEvent({ type: 'native-viewport-revoke', id: 'fixture' })).toBe(true)
  })
})
