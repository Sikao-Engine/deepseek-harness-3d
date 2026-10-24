---
description: "Experimental native viewport protocol for trusted third-party renderers, generic input and versioned engine extensions."
---

# Native viewport protocol

English | [中文](native-viewport.zh.md)

## Summary

Third-party plugins can present native GPU output inside the Desktop document without sending pixel buffers over IPC. Desktop owns executable admission, attachment lifetime and texture leases; plugins own rendering, camera behavior and engine operations. This is the first generic API revision, wire protocol 2, not an official upstream API. The qualified transport remains Windows x64, Electron 44.7.0 and D3D11 NT RGBA8 textures.

## Table of Contents

- [Scope and ownership](#scope-and-ownership)
- [Registration and attachment](#registration-and-attachment)
- [Interaction](#interaction)
- [Worker transport](#worker-transport)
- [Frames and failure](#frames-and-failure)
- [Godot adapter](#godot-adapter)
- [Known limitations](#known-limitations)
- [Dev Note](#dev-note)

## Scope and ownership

This reference defines the experimental fork protocol; [Desktop activation](README.md#downstream-native-viewport-preview) defines its build and launch authorization. The [TypeScript declarations](src/native-viewport-protocol.ts) own exact fields and validators. No Session format, model tool or scene representation is added.

| Owner | Responsibility |
|---|---|
| Host plugin | Register installed executable, digest, arguments and extension namespaces; revoke on unload |
| Desktop main | Authorize document, validate IPC, check executable and adapter, spawn worker, import handles, drain teardown |
| Sandboxed preload | Own imported textures and borrowed VideoFrames; acknowledge only after presentation settles |
| Client plugin | Discover producer, attach, supply input, await GPU completion and dispose attachment |
| Native adapter | Convert generic input to engine behavior; synchronize export completion and obey frame release |

Graphics101 demonstrates a producer, not a Desktop dependency. Desktop neither identifies a Godot package nor interprets orbit, dolly, camera reset, rotation or scene operations.

## Registration and attachment

A trusted Host sends `native-viewport-register` with `producer`: `id`, `protocol: 2`, `packageRoot`, relative `executable`, `sha256`, `args` and `extensions`. `args` contains plugin-owned startup options. Desktop appends `--dsh-viewport-protocol 2 --broker-pid <main PID>`; workers must accept these reserved arguments. The executable stays inside its installed package and must match its digest. Registration is process-local and does not authenticate a publisher or sandbox native code.

`dshDesktop.nativeViewports.capabilities.protocol` is 2. `list()` returns only `id`, `protocol` and `extensions`; paths, arguments and digests remain private. `attach(id)` starts one worker and resolves only after a valid hello and adapter check, within five seconds. It returns `generation` and the Desktop import path; it does not promise a first frame. Register frame and event receivers before submitting the first nonzero resize. Rejection waits for worker teardown. No automatic version fallback or retry occurs.

Each attachment has a fresh generation and one native worker. One producer may have one simultaneous attachment in this revision; separate producer IDs permit separate viewports within the global quota. Revocation prevents new attachment immediately and initiates teardown of existing attachments. Host exit clears registrations. Renderer clients must rediscover after Host restart.

## Interaction

`control(generation, data)` accepts a discriminated control. Resize uses physical `width`, `height` and CSS-to-physical `scale`; zero dimensions suspend frame production without freeing the last surface. Visibility suspends presentation work; the native adapter clears held input when hidden. These controls do not carry input sequence numbers.

`input` carries `seq` and `event`. Pointer events carry `phase`, `pointerId`, `pointerType`, `x`, `y`, `buttons`, `button` and `modifiers`. Phases are down, move, up and cancel; pointer types are mouse, pen and touch. Positions use CSS pixels from the viewport's top-left, with x right and y down; captured input may be outside the rectangle. `buttons` follows DOM buttons bits and `button` follows DOM button indices, including -1 for movement. Pointer capture belongs to the client, not Desktop.

Wheel events carry position, `deltaX`, `deltaY` and modifiers in CSS pixels; clients convert DOM line/page units before submission. Positive deltaY follows the DOM downward direction. Key events carry DOM `code`, `down`, `repeat` and modifiers, not engine key integers. Modifier bits are Shift=1, Control=2, Alt=4 and Meta=8. Focus events carry `focused`; losing focus cancels held keys and pointer drags in the engine adapter. Text composition, pressure, pointer lock, gamepads and IME are outside this revision.

`extension` carries `seq`, `namespace`, `name` and JSON `payload`. Namespaces must be registered, versioned names such as `graphics101.camera.v1`; operations such as reset and rotate are defined only by that namespace's owner. Payloads allow finite JSON values, at most 16 nesting levels and 16,384 characters per control. Extensions can also arrive from the worker as events with `type: extension`, `namespace`, `name` and `payload`. Desktop validates namespace and bounded JSON but does not interpret engine data.

Input and extensions share a strictly increasing positive safe-integer sequence per generation. Desktop ignores obsolete sequences. Worker `inputSeq` means the latest applied interaction when the frame was rendered, not presentation completion, a request result or a persistence acknowledgement. Extensions are one-way notifications; engines needing replies define correlation and failure semantics inside their versioned payloads. Invalid controls stop the attachment rather than silently converting camera commands.

## Worker transport

Worker stdin and stdout use UTF-8 newline-delimited JSON. stdout contains protocol messages only; diagnostic output belongs to stderr. The hello is the first stdout message and contains `type: hello`, `protocol: 2`, `transport: d3d11-nt-rgba8`, `vendorId`, `deviceId` and the exact registered `extensions` array. Optional diagnostic backend information does not select Desktop behavior. Unsupported versions, transports, adapter mismatch, duplicate hello or pre-hello frames fail attachment.

Desktop forwards validated controls as JSON and additionally sends `release` with `epoch`, `slot`, `frameId`, and `stop` without further fields. Worker output types are hello, surface, frame, stats, stopped and extension. Frame fields are `epoch`, `slot`, `frameId`, `width`, `height`, `inputSeq`, `timestampUs` and decimal-string `handle`. Handles must be duplicated into the broker process, not raw worker-local handles. Timestamps are monotonic microseconds. FrameId is positive and increasing within a worker; epoch is positive and advances only when the surface changes. Worker stops on stdin EOF.

The producer completes GPU writes before offering a frame and does not write its slot again until the exact release. Resize waits until every old-epoch lease is released before destroying or replacing native surfaces. The RGBA8 transport carries opaque SDR content; color conversion, alpha compositing, HDR, other texture formats and additional synchronization primitives are not negotiated by protocol 2.

## Frames and failure

Frame identity is generation plus epoch plus slot plus frameId. Desktop retains two imported leases and one pending frame, releasing replaced pending frames. A presenter borrows a VideoFrame and must resolve only after all submitted GPU use completes. It must neither retain nor close that frame. Preload closes the VideoFrame, releases its renderer import and then acknowledges Desktop; Desktop releases its import before notifying the worker. A five-second lease timeout stops the attachment without authorizing slot reuse.

`dispose(generation)` stops admission and awaits worker exit before releasing remaining main-process imports. Revocation, navigation, renderer loss, GPU loss, Host exit, malformed worker output and presenter failure initiate the same containment. Errors are observable through the attachment error event and Electron diagnostics. Recovery means disposing client GPU resources, correcting the cause and explicitly attaching again; the transport never claims rollback or retries engine commands. Teardown deadlines may force process termination, not unsafe slot recycling.

## Godot adapter

The downstream integration supplies a worker adapter implementing this transport and maps pointer, wheel, DOM keys, focus and resize into Godot runtime APIs. It can replace Graphics101 without modifying Desktop camera logic because none exists. Engine-specific editor commands belong to a separately versioned namespace, for example `godot.editor.v1`, and their client/server definitions live downstream.

A future Godot worker may use a helper process around a runtime rather than change its source, provided that the helper owns texture export and release synchronization. A Godot Vulkan image is not automatically an Electron-compatible handle: the adapter still must qualify D3D11 sharing, GPU identity and export completion. Scene tree, selection, transforms, resource loading, undo and persistence remain engine responsibilities, not transport fields.

## Known limitations

The protocol is experimental and incompatible with the initial camera-command preview. It supports no CPU fallback and no non-Windows transport. Vendor/device comparison cannot distinguish identical multi-GPU adapters. Native packages are trusted code; digest verification covers the executable, not all dynamically loaded assets. Discovery is a snapshot, not a subscription. The first generic revision retains eight producers, two workers, four slots and 2048 × 2048 frames. Attachment errors remain rejected IPC promises or diagnostic events, not a stable machine-readable error-code catalog.

Hardware correctness requires the exact Desktop, Electron, native adapter and GPU combination. Unit validation cannot establish texture import safety, device-loss recovery or actual no-readback rendering. The standalone Graphics101 qualification harness is not evidence that the complete Desktop composition has passed.

## Dev Note

Non-authoritative next work: publish fork artifacts under a separate identity and update feed; track upstream independently and do not promise a merge date. Qualify the generic carrier with a second non-Graphics101 producer, then propose a Cordis registration service and a publishable browser-safe protocol package when their delivery requirements are established. Acknowledged registration/revocation, stable failure codes, configurable quotas, bounded stream framing and stdin backpressure are required before exposing the transport to untrusted or high-volume producers. Add other OS transports through capability negotiation rather than weakening the qualified Windows runtime check.
