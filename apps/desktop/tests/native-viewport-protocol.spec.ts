import { describe, expect, it } from 'vitest'
import { isNativeViewportControl, isNativeViewportHostEvent, isNativeViewportSpawnRequest, parseNativeViewportFeatures } from '../src/native-viewport-protocol.ts'

const extensions = ['graphics101.camera.v1']
const features = ['interaction.map.v2', 'input.text', 'input.ime', 'pointer.lock', 'input.drop'] as const
const windowFeatures = [...features, 'windows.multi.v1'] as const

describe('generic native viewport protocol', () => {
  it('accepts bounded camelCase engine extension names in both directions', () => {
    const namespaces = ['godot.viewport.v1', 'godot.editor.v1']
    for (const name of ['imeState', 'clipboardWrite', 'setRelativeMouseMode', 'spawnGame', 'gameLifecycle']) {
      expect(isNativeViewportControl({ kind: 'extension', seq: 1, namespace: namespaces[0], name, payload: {} }, namespaces)).toBe(true)
    }
    for (const name of ['BadStart', 'bad/name', '', 'x'.repeat(129)]) {
      expect(isNativeViewportControl({ kind: 'extension', seq: 1, namespace: namespaces[0], name, payload: {} }, namespaces)).toBe(false)
    }
  })
  it('accepts transport-neutral input and declared extensions', () => {
    for (const event of [
      { type: 'focus', focused: false },
      { type: 'key', code: 'ArrowLeft', down: true, repeat: false, modifiers: 3 },
      { type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 100, modifiers: 0 },
      { type: 'pointer', phase: 'move', pointerId: 7, pointerType: 'pen', x: -10, y: 20, button: -1, buttons: 1, modifiers: 0 },
      { type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 4, y: 3, button: -1, buttons: 0, modifiers: 0, movementX: 12, movementY: -4 },
    ]) expect(isNativeViewportControl({ kind: 'input', seq: 1, event }, extensions)).toBe(true)
    expect(isNativeViewportControl({ kind: 'resize', width: 800, height: 600, scale: 1.5 }, extensions)).toBe(true)
    expect(isNativeViewportControl({ kind: 'visible', value: false }, extensions)).toBe(true)
    expect(isNativeViewportControl({ kind: 'extension', seq: 2, namespace: extensions[0], name: 'rotate', payload: { value: true } }, extensions)).toBe(true)
  })

  it('accepts v2 resize css geometry and capability-gated text/ime only when negotiated', () => {
    const resize = { kind: 'resize', width: 320, height: 240, scale: 0.5, cssWidth: 640, cssHeight: 480 }
    expect(isNativeViewportControl(resize, extensions, features)).toBe(true)
    // Without the negotiated capability the same control is rejected.
    expect(isNativeViewportControl(resize, extensions)).toBe(false)
    expect(isNativeViewportControl(resize, extensions, ['input.text'])).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'text', text: 'hello' } }, extensions, features)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'text', text: 'hello' } }, extensions)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'ime', state: 'update', text: 'nǐ', cursorStart: 1, cursorEnd: 2 } }, extensions, features)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'ime', state: 'commit', text: '你' } }, extensions, features)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'ime', state: 'update', text: 'nǐ' } }, extensions)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'key', code: 'KeyA', down: true, repeat: false, modifiers: 0, key: 'a' } }, extensions)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'key', code: 'KeyA', down: true, repeat: false, modifiers: 0, key: 'a' } }, extensions, features)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'key', code: 'Digit7', down: true, repeat: false, modifiers: 1, key: '&' } }, extensions, features)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'drop', x: 10, y: 20, paths: ['/tmp/a.glb'] } }, extensions, features)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'drop', x: 10, y: 20, paths: ['/tmp/a.glb'] } }, extensions)).toBe(false)
  })

  it('accepts window dimensions only when windows.multi.v1 is negotiated', () => {
    // Any explicit window field requires the negotiated capability (strict gate, plan D9).
    expect(isNativeViewportControl({ kind: 'resize', width: 640, height: 480, scale: 1, window: 0 }, extensions, windowFeatures)).toBe(true)
    expect(isNativeViewportControl({ kind: 'resize', width: 640, height: 480, scale: 1, window: 0 }, extensions)).toBe(false)
    expect(isNativeViewportControl({ kind: 'resize', width: 640, height: 480, scale: 1, window: 3 }, extensions, windowFeatures)).toBe(true)
    expect(isNativeViewportControl({ kind: 'resize', width: 640, height: 480, scale: 1, window: 3 }, extensions)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'focus', focused: true, window: 2 } }, extensions, windowFeatures)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'focus', focused: true, window: 2 } }, extensions)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'pointer', phase: 'down', pointerId: 1, pointerType: 'mouse', x: 1, y: 2, buttons: 1, button: 0, modifiers: 0, window: 15 } }, extensions, windowFeatures)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'pointer', phase: 'down', pointerId: 1, pointerType: 'mouse', x: 1, y: 2, buttons: 1, button: 0, modifiers: 0, window: 16 } }, extensions, windowFeatures)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'key', code: 'KeyA', down: true, repeat: false, modifiers: 0, window: -1 } }, extensions, windowFeatures)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'text', text: 'a', window: 1.5 } }, extensions, windowFeatures)).toBe(false)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'ime', state: 'commit', text: '你', window: 4 } }, extensions, windowFeatures)).toBe(true)
    expect(isNativeViewportControl({ kind: 'input', seq: 1, event: { type: 'drop', x: 0, y: 0, paths: ['/tmp/a'], window: 2 } }, extensions, windowFeatures)).toBe(true)
  })

  it('validates spawn requests and strips broker-reserved arguments', () => {
    expect(isNativeViewportSpawnRequest({ producerId: 'dsh-godot-plugin/godot-editor', args: ['--path', 'C:/game', '--remote-debug', '127.0.0.1:6007'] })).toBe(true)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: [] })).toBe(true)
    // Broker-reserved arguments are never accepted from the renderer.
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: ['--dsh-viewport-protocol', '2'] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: ['--broker-pid', '1234'] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: ['--dsh-custom-flag'] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: Array.from({ length: 65 }, (_v, i) => `a${i}`) })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: ['x'.repeat(1025)] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: ['ok', ''] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: ['bad\0arg'] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: '', args: ['ok'] })).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x' })).toBe(false)
    expect(isNativeViewportSpawnRequest(null)).toBe(false)
    expect(isNativeViewportSpawnRequest({ producerId: 'x', args: 'nope' })).toBe(false)
  })

  it.each([
    null,
    { kind: 'input', seq: 1, command: 'orbit', x: 1, y: 2 },
    { kind: 'input', seq: 0, event: { type: 'focus', focused: false } },
    { kind: 'resize', width: 2049, height: 1, scale: 1 },
    { kind: 'resize', width: 1, height: 1, scale: 0 },
    { kind: 'resize', width: 1, height: 1, scale: 1, cssWidth: 2 }, // css axes travel together
    { kind: 'resize', width: 1, height: 1, scale: 1, cssWidth: 16385, cssHeight: 1 },
    { kind: 'resize', width: 1, height: 1, scale: 1, cssWidth: 0, cssHeight: 1 },
    { kind: 'resize', width: 1, height: 1, scale: 1, cssWidth: Number.NaN, cssHeight: 1 },
    { kind: 'input', seq: 1, event: { type: 'key', code: 'KeyW\nstop', down: true, repeat: false, modifiers: 0 } },
    { kind: 'input', seq: 1, event: { type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: Infinity, modifiers: 0 } },
    { kind: 'input', seq: 1, event: { type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 0, y: 0, button: -1, buttons: 0, modifiers: 0, movementX: Infinity } },
    { kind: 'input', seq: 1, event: { type: 'text', text: '' } },
    { kind: 'input', seq: 1, event: { type: 'text', text: 'x'.repeat(1025) } },
    { kind: 'input', seq: 1, event: { type: 'ime', state: 'explode', text: 'x' } },
    { kind: 'input', seq: 1, event: { type: 'ime', state: 'update', text: 'x', cursorStart: -1 } },
    { kind: 'input', seq: 1, event: { type: 'key', code: 'KeyA', down: true, repeat: false, modifiers: 0, key: 'abc' } },
    { kind: 'input', seq: 1, event: { type: 'key', code: 'KeyA', down: true, repeat: false, modifiers: 0, key: 7 } },
    { kind: 'input', seq: 1, event: { type: 'drop', x: 10, y: 20, paths: [] } },
    { kind: 'input', seq: 1, event: { type: 'drop', x: 10, y: 20, paths: ['x'.repeat(4097)] } },
    { kind: 'extension', seq: 1, namespace: 'godot.editor.v1', name: 'reset', payload: null },
    { kind: 'extension', seq: 1, namespace: extensions[0], name: 'rotate', payload: { value: undefined } },
    { kind: 'extension', seq: 1, namespace: extensions[0], name: 'reset', payload: 'x'.repeat(16385) },
  ])('rejects invalid or undeclared controls: %j', (value) => {
    expect(isNativeViewportControl(value, extensions, features)).toBe(false)
  })

  it('parses worker hello features and rejects malformed advertisement', () => {
    expect(parseNativeViewportFeatures(undefined)).toEqual([])
    expect(parseNativeViewportFeatures(['interaction.map.v2', 'input.text'])).toEqual(['interaction.map.v2', 'input.text'])
    expect(parseNativeViewportFeatures('interaction.map.v2')).toBeUndefined()
    expect(parseNativeViewportFeatures(['Interaction.Map.v2'])).toBeUndefined()
    expect(parseNativeViewportFeatures(['bad feature'])).toBeUndefined()
    expect(parseNativeViewportFeatures(['a'.repeat(65)])).toBeUndefined()
    expect(parseNativeViewportFeatures(['interaction.map.v2', 'interaction.map.v2'])).toBeUndefined()
    expect(parseNativeViewportFeatures(Array.from({ length: 17 }, (_v, i) => `f${i}.x`))).toBeUndefined()
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
