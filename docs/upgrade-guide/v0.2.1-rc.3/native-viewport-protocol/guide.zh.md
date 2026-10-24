---
kind: upgrade-guide
description: "实验性原生视口插件必须将相机命令预览替换为通用协议 2。"
---

# 实验性原生视口协议 2

[English](guide.md) | 中文

## 变更

下游 Desktop fork 将预览协议 1 替换为协议 2。仅原生视口插件受影响；普通 Desktop 和 Web 仍默认禁用。注册需要协议版本、参数与版本化扩展命名空间。Worker stdin 从相机特定文本命令改为换行分隔 JSON。不提供版本 1 回退。这项实验性变更不代表官方上游支持。

## 迁移

1. 更新 Host 注册，提供 `protocol: 2`、`args: []` 或插件拥有的启动参数，以及 `extensions: []` 或 worker 实现的命名空间。
2. 接受保留的 worker 参数 `--dsh-viewport-protocol 2 --broker-pid <PID>`。在其他消息前输出 hello，携带协议 2、传输 `d3d11-nt-rgba8`、适配器 ID 与准确匹配注册值的扩展数组。
3. 将 orbit、dolly 和数字键码命令替换为通用指针、滚轮、DOM code 键盘与焦点事件。引擎操作移入声明的命名空间，例如 `graphics101.camera.v1`。Resize 控制增加 scale。
4. Worker 使用 JSON 控制、release 与 stop 消息。保留 GPU 完成与 slot 释放所有权。遵循[协议参考](../../../../apps/desktop/native-viewport.md)。
5. 重新构建 fork 和插件，更新待发布的可执行文件与摘要，然后完全重启 Desktop。确认 capabilities 报告协议 2、list 返回 producer、attach 成功、输入改变视口且释放等待 worker 退出。仍须硬件验证；类型检查成功不足以证明正确性。
