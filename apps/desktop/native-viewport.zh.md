---
description: "面向受信任第三方 renderer 的实验性原生视口协议，提供通用输入与版本化引擎扩展。"
---

# 原生视口协议

[English](native-viewport.md) | 中文

## 摘要

第三方插件可以在 Desktop 文档内呈现原生 GPU 输出，而不通过 IPC 发送像素缓冲。Desktop 拥有可执行文件准入、挂载生命周期与纹理租约；插件拥有渲染、相机行为与引擎操作。这是第一版通用 API，线协议版本为 2，并非官方上游 API。经过限定的传输仍为 Windows x64、Electron 44.7.0 和 D3D11 NT RGBA8 纹理。

## 目录

- [范围与所有权](#范围与所有权)
- [注册与挂载](#注册与挂载)
- [交互](#交互)
- [Worker 传输](#worker-传输)
- [帧与失败](#帧与失败)
- [Godot 适配器](#godot-适配器)
- [已知限制](#已知限制)
- [开发备注](#开发备注)

## 范围与所有权

本参考文档定义实验性 fork 协议；[Desktop 启用配置](README.zh.md#下游原生视口预览)定义构建与启动授权。[TypeScript 声明](src/native-viewport-protocol.ts)拥有准确字段与验证器。本协议不新增 Session 格式、模型工具或场景表示。

| 所有者 | 职责 |
|---|---|
| Host 插件 | 注册已安装的可执行文件、摘要、参数与扩展命名空间；卸载时撤销 |
| Desktop main | 授权文档、验证 IPC、检查可执行文件和适配器、启动 worker、导入句柄、等待清理完成 |
| 沙箱 preload | 拥有导入纹理与借出的 VideoFrame；仅在呈现完成后确认 |
| Client 插件 | 发现 producer、挂载、提供输入、等待 GPU 完成并释放挂载 |
| 原生适配器 | 将通用输入转换为引擎行为；同步导出完成并遵守帧释放要求 |

Graphics101 是 producer 示例，不是 Desktop 依赖。Desktop 不识别 Godot 包，也不解释 orbit、dolly、相机重置、旋转或场景操作。

## 注册与挂载

受信任的 Host 发送 `native-viewport-register`，其 `producer` 包含 `id`、`protocol: 2`、`packageRoot`、相对路径 `executable`、`sha256`、`args` 和 `extensions`。`args` 包含插件拥有的启动选项。Desktop 追加 `--dsh-viewport-protocol 2 --broker-pid <main PID>`；worker 必须接受这些保留参数。可执行文件必须位于安装包内且匹配摘要。注册仅存在于当前进程，不认证发布者，也不为原生代码提供沙箱。

`dshDesktop.nativeViewports.capabilities.protocol` 为 2。`list()` 仅返回 `id`、`protocol` 与 `extensions`；路径、参数与摘要保持私有。`attach(id)` 启动一个 worker，仅在五秒内收到有效 hello 且通过适配器检查后 resolve。返回值包含 `generation`、Desktop 导入路径与 worker hello 中的 `features` 能力数组（无能力协商的旧 worker 返回空数组），不保证首帧已到达。在首次提交非零 resize 前注册帧与事件接收者。Preload 在 `onEvent` 订阅时按线协议顺序回放启动事件；未领取事件超过 256 条则停止挂载。释放挂载时清空事件队列。拒绝返回前等待 worker 清理。不自动回退版本或重试。

每次挂载拥有新的 generation 和一个原生 worker。本版每个 producer 只能同时挂载一次；不同 producer ID 可在总配额内提供独立视口。撤销立即阻止新挂载并开始清理已有挂载。Host 退出清空注册。Renderer 客户端须在 Host 重启后重新发现 producer。

## 交互

`control(generation, data)` 接受判别式控制消息。Resize 使用物理像素 `width`、`height` 和 CSS 到物理像素的 `scale`；零尺寸暂停产帧，但不释放最后一个 surface。在 hello `features` 中声明了 `interaction.map.v2` 的 worker 额外接受 `cssWidth`/`cssHeight`（必须成对出现，各自为 (0, 16384] 内的有限数）：发出 resize 时视口的 CSS 尺寸，用于精确的逐轴 CSS→物理输入映射；未声明该能力的 worker 若收到客户端误发的这些字段会被 broker 拒绝。Visibility 暂停呈现工作；隐藏时原生适配器清除按住的输入。这两种控制不携带输入序号。

`input` 携带 `seq` 与 `event`。指针事件携带 `phase`、`pointerId`、`pointerType`、`x`、`y`、`buttons`、`button` 和 `modifiers`。Phase 为 down、move、up 或 cancel；指针类型为 mouse、pen 或 touch。位置使用从视口左上角起算的 CSS 像素，x 向右、y 向下；捕获后的输入可位于矩形之外。`buttons` 遵循 DOM 按钮位，`button` 遵循 DOM 按钮索引，包括移动时的 -1。指针锁定期间，move 事件可附加 `movementX`/`movementY`（CSS 像素增量；锁定时位置冻结）。指针捕获属于客户端，不属于 Desktop。

滚轮事件携带位置、`deltaX`、`deltaY` 与 modifiers，单位为 CSS 像素；客户端提交前转换 DOM 行或页单位。正 deltaY 遵循 DOM 向下方向。键盘事件携带 DOM `code`、`down`、`repeat` 与 modifiers，而不是引擎键码整数。按下键的 DOM `key` 值为单字符时，可附加 `key` 字段（仅 `input.text` 能力放行）；适配器将其转为键盘事件的 unicode 码点，文本框插入字符依赖该值。修饰键位为 Shift=1、Control=2、Alt=4 和 Meta=8。焦点事件携带 `focused`；失去焦点时引擎适配器取消按住的按键和指针拖动。

文本与 IME 复用同一 input 通道，并按 hello 能力放行：声明 `input.text` 后，`{ type: 'text', text }` 提交已确认文本；声明 `input.ime` 后，`{ type: 'ime', state, text?, cursorStart?, cursorEnd? }` 报告组合过程：start/update 携带预编辑 `text`，commit 交付最终 `text`，cancel 无文本中止。Desktop 只做长度限制与原样转发，不解释内容。声明 `input.drop` 后，`{ type: 'drop', x, y, paths }` 报告操作系统文件拖放：绝对磁盘路径（由 Desktop 桥解析）与 CSS 像素落点；适配器将其分发给引擎的 files-dropped 通知。压力感知与手柄仍不在本版范围内。

`extension` 携带 `seq`、`namespace`、`name` 与 JSON `payload`。命名空间必须注册并携带版本，例如 `graphics101.camera.v1`；reset、rotate 等操作仅由该命名空间的所有者定义。操作名以小写字母开头，允许 ASCII 字母、数字、点和连字符，包括 `imeState`、`spawnGame` 等驼峰名称。Payload 允许有限 JSON 值，嵌套最多 16 层，每条控制最多 16,384 个字符。Worker 也可发送扩展事件，包含 `type: extension`、`namespace`、`name` 与 `payload`。Desktop 验证命名空间和有界 JSON，但不解释引擎数据。

Input 与 extension 在每个 generation 内共用严格递增的正安全整数序号。Desktop 忽略过期序号。Worker `inputSeq` 表示渲染该帧时最新应用的交互，不表示呈现完成、请求结果或持久化确认。扩展是单向通知；需要应答的引擎在其版本化 payload 内定义关联和失败语义。非法控制停止挂载，不会静默转换相机命令。

## Worker 传输

Worker stdin 和 stdout 使用 UTF-8 换行分隔 JSON。Stdout 仅输出协议消息；诊断输出放入 stderr。Hello 必须是首条 stdout 消息，包含 `type: hello`、`protocol: 2`、`transport: d3d11-nt-rgba8`、`vendorId`、`deviceId` 与准确匹配注册值的 `extensions` 数组。可选的 `features` 数组声明交互能力（小写点分名称，例如 `interaction.map.v2`）；Desktop 校验其形状、从 attach() 原样返回，并据此放行上述 v2 控制字段。可选的 backend 诊断信息不决定 Desktop 行为。不支持的版本或传输、适配器不匹配、重复 hello 或 hello 前产帧导致挂载失败。

Desktop 将验证后的控制转发为 JSON，另发送包含 `epoch`、`slot`、`frameId` 的 `release`，以及无其他字段的 `stop`。Worker 输出类型为 hello、surface、frame、stats、stopped 和 extension。surface 携带已应用的 width/height 与槽数，并在 resize 携带时回显 `cssWidth`/`cssHeight`。Frame 字段为 `epoch`、`slot`、`frameId`、`width`、`height`、`inputSeq`、`timestampUs` 与十进制字符串 `handle`。句柄必须复制到 broker 进程，不能使用 worker 本地的原始句柄。时间戳为单调时钟微秒。FrameId 为正数并在 worker 内递增；epoch 为正数且仅在 surface 变化时推进。Stdin EOF 时 worker 停止。

Producer 提交帧前完成 GPU 写入，收到准确匹配的 release 前不再写该 slot。Resize 在销毁或替换原生 surface 前等待旧 epoch 的全部租约释放。RGBA8 传输携带不透明 SDR 内容；协议 2 不协商颜色转换、alpha 合成、HDR、其他纹理格式或额外同步原语。
## 协议 v2.1：多窗口与 spawn
协议 2 的全部字段保持不变；v2.1 以可选字段与能力协商增量引入窗口维度。Worker 在 hello `features` 中声明 `windows.multi.v1` 后，下列字段才合法；未声明该能力的 producer 发送或接收这些字段会被校验器拒绝（显式失败，不静默降级）。编辑器与 runtime demo producer 均声明该能力：demo 需要它以便通过 `openPopup` 钩子对多窗口路径做黑盒验证。不声明该能力的 producer 行为与 v2 完全一致。
Worker → broker 方向：`frame` 与 `surface` 消息可携带 `window`（整数 0..15，缺省 0 = 主窗口）；`surface` 收据额外携带 `slots`（该窗口帧环槽数，1..4）。子窗口以 `slots: 0`、`width: 0`、`height: 0` 和正数 epoch 退役 surface；退役释放配额，尚未完成的精确帧确认仍有效。窗口生命周期走既有的 extension 事件机制（命名空间 `godot.window.v1`：created/destroyed/rect/visibility/title/focus/raised），由 producer manifest 注册，broker 按白名单透传，不解释 payload。
Client → worker 方向：`resize`、`input`（pointer/wheel/key/text/ime/drop）与 `focus` 事件可携带 `window`（同样门控于 `windows.multi.v1` 与 0..15 范围）；`release` 携带 `window` 以按窗口归还租约。子窗口几何由引擎驱动：客户端只 resize 主窗口，子窗口尺寸/位置经 `godot.window.v1/rect` 事件下发，客户端按图层局部 CSS 像素上报输入。
配额（broker 强制）：每 session 最多 16 个窗口（id 0..15）与 24 个总帧槽（主环 4 + 子窗口每环 2）；单帧尺寸沿用 2048/轴。session 总数 2 → 4（编辑器 + 游戏 + 预留）。
`spawn({ producerId, args })`（IPC `dsh-desktop:native-viewport-spawn`）以已注册 producer 启动第二个 worker 作为新 session，复用 attach 的 packageRoot/可执行文件/sha256/适配器/GPU 校验；broker 追加自己的协议参数（`--dsh-viewport-protocol`、`--broker-pid`）于尾部，并过滤渲染端请求中的保留参数（`--dsh-*`、`--broker-pid`）。`args` 最多 64 项、每项 1..1024 字符。典型用途：编辑器 worker 请求客户端启动游戏进程（`godot.editor.v1/spawnGame`），游戏帧经第二个 session 路由。
## 帧与失败

帧身份由 generation、epoch、slot 和 frameId 组成。Desktop 保留两个导入租约和一个待处理帧，释放被替换的待处理帧。Presenter 借用 VideoFrame，必须在所有已提交 GPU 使用完成后才 resolve，不能保留或关闭该帧。Preload 关闭 VideoFrame、释放 renderer 导入，再确认给 Desktop；Desktop 释放其导入后才通知 worker。五秒租约超时停止挂载，不授权 slot 复用。

`dispose(generation)` 停止准入并等待 worker 退出，然后释放剩余 main 进程导入。撤销、导航、renderer 丢失、GPU 丢失、Host 退出、非法 worker 输出与 presenter 失败都启动相同的故障隔离。错误通过挂载 error 事件和 Electron 诊断可见。恢复方式为释放客户端 GPU 资源、修复原因并显式重新挂载；传输不承诺回滚，也不重试引擎命令。清理超时可以强制终止进程，但不能不安全地回收 slot。

## Godot 适配器

下游集成提供实现本传输的 worker 适配器，将指针、滚轮、DOM 键盘、焦点和 resize 映射到 Godot runtime API。它可以替换 Graphics101 而不修改 Desktop 相机逻辑，因为上游不存在此逻辑。引擎特定的编辑器命令属于独立版本化的命名空间，例如 `godot.editor.v1`，其客户端与服务端定义保留在下游。

未来 Godot worker 可通过 runtime 外部的辅助进程集成，而不修改其源码，前提是辅助进程拥有纹理导出与释放同步。Godot Vulkan image 不会自动成为 Electron 兼容句柄：适配器仍须验证 D3D11 共享、GPU 身份与导出完成。场景树、选择、变换、资源加载、撤销与持久化属于引擎职责，不是传输字段。

## 已知限制

本协议为实验性协议，与最初的相机命令预览不兼容。不提供 CPU 回退或非 Windows 传输。Vendor/device 比较无法区分型号相同的多块 GPU。原生包为受信任代码；摘要验证覆盖可执行文件，不覆盖全部动态加载资源。发现是快照，不是订阅。第一版通用 API 保留八个 producer、最多四个并发 session（v2.1 起）、2048 × 2048 帧限制；单窗口帧环四个 slot，多窗口总会话配额 24 个 slot。挂载错误仍为被拒绝的 IPC promise 或诊断事件，不提供稳定机器可读错误码目录。

硬件正确性需要确切的 Desktop、Electron、原生适配器与 GPU 组合。单元验证不能证明纹理导入安全、设备丢失恢复或实际无回读渲染。独立 Graphics101 验证程序不能证明完整 Desktop 组合已通过验证。

## 开发备注

非权威的后续工作：以独立标识和更新源发布 fork 产物；独立跟踪上游，不承诺合入日期。用第二个非 Graphics101 producer 验证通用载体，再在交付要求明确后提出 Cordis 注册服务和可发布的浏览器安全协议包。在面向不受信任或高吞吐 producer 开放前，需要注册与撤销确认、稳定失败码、可配置配额、有界流分帧和 stdin 背压。通过能力协商增加其他 OS 传输，不放宽经过限定的 Windows runtime 检查。
