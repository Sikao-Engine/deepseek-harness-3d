---
kind: upgrade-guide
description: "Experimental native viewport plugins must replace the camera-command preview with generic protocol 2."
---

# Experimental native viewport protocol 2

English | [中文](guide.zh.md)

## Change

The downstream Desktop fork replaces preview protocol 1 with protocol 2. This affects native viewport plugins only; ordinary Desktop and Web remain disabled by default. Registration requires protocol, arguments and versioned extension namespaces. Worker stdin changes from camera-specific text commands to newline-delimited JSON. There is no version-1 fallback. This experimental change does not establish official upstream support.

## Migration

1. Update Host registration with `protocol: 2`, `args: []` or plugin-owned startup arguments, and `extensions: []` or the namespaces your worker implements.
2. Accept reserved worker arguments `--dsh-viewport-protocol 2 --broker-pid <PID>`. Emit hello with protocol 2, transport `d3d11-nt-rgba8`, adapter IDs and the exact registered extension array before other messages.
3. Replace orbit, dolly and numeric key commands with generic pointer, wheel, DOM code key and focus events. Move engine operations into declared namespaces such as `graphics101.camera.v1`. Add scale to resize controls.
4. Use JSON controls, release and stop messages in the worker. Preserve GPU completion and slot-release ownership. Follow the [protocol reference](../../../../apps/desktop/native-viewport.md).
5. Rebuild both fork and plugin, stage the updated executable and digest, then fully restart Desktop. Confirm capabilities reports protocol 2, list returns the producer, attach succeeds, input changes the viewport and disposal awaits worker exit. Hardware qualification remains necessary; a successful typecheck is insufficient.
