# 版本更新与 Desktop 发布流程（fork 内部版）

本文记录本仓库（`engine.sikao.dsh3d` 定制版）从修改版本号到发布 Desktop 更新包的完整流程。
权威参考仍是 `apps/desktop/packaging/README.md`（打包/版本规则）与 `apps/desktop/publishing/README.md`（上传/发布），本文是实操速查。

## 0. 名词与版本规则

- **产品版本**：写在 `package.json` 里的版本，当前为 `0.2.1-dev1`。
- **构建版本**：一次打包实际发布的版本号，不写入清单，通过 `--build-version` 传入。
  - 预发布基础（含 prerelease，如 `0.2.1-dev1`、`0.1.6-alpha.1`）：`<完整基础>.<日期>.<序号>`，例如 `0.2.1-dev1.20261025.1`。
  - 稳定基础（无 prerelease，如 `0.1.6`）：`<版本>-test.<日期>.<序号>`，例如 `0.1.6-test.20261025.1`。
  - **semver 不会把 `dev1` 拆成 `dev.1`**：`dev1` 是一个完整标识符。因此正确形式是 `0.2.1-dev1.20261025.1`，写 `0.2.1-dev.1.20261025.1` 会被拒绝（`must extend 0.2.1-dev1 as 0.2.1-dev1.<date>.<sequence>`）。
- 打包时校验 `apps/desktop/package.json` 版本必须等于根 `package.json` 版本（发布记录写入前检查）。
- 发布前先确认完整版本串； deployment 设置本身不构成版本授权（见 packaging README 的 release-versions 一节）。

## 1. 更新产品版本

```powershell
# major | minor | patch | 显式版本号（可带 prerelease）
pnpm run release:dsh -- 0.2.1-dev2
```

- 该命令会把 dsh  family 的版本写入**全部 workspace 的 package.json**（根 + apps/* + packages/**）并更新 lockfile，然后自动提交。
- tag 由人创建：版本提交合并后打 `dsh-v<版本>`（npm family）；Desktop 生产发布的 `desktop-v<版本>` tag 由上传成功后自动创建（见第 5 节）。
- Desktop 打包脚本要求根与 desktop 包版本一致，`release:dsh` 保证这一点。

## 2. 一次性配置（`apps/desktop/.env.windows`，Git 忽略）

当前已配置项（`.env.windows.example` 是模板）：

| 变量 | 含义 | 当前值 |
|---|---|---|
| `DSH_DESKTOP_APP_ID` | 应用标识 | `engine.sikao.dsh3d` |
| `DSH_DESKTOP_AUTO_UPDATE_ENV` | 部署：`test` 或 `production`，缺省 `test` | `test` |
| `DOWNLOAD_TEST_ORIGIN` | 更新 feed 的公网 https origin（**不带路径**），必须与实际上传分发地址一致 | `https://sikao-engine.github.io` |
| `DOWNLOAD_TEST_RELEASE_ID` | 32 位小写十六进制，一批发布共用一个 | 见 `.env.windows` |
| `DSH_DESKTOP_NPM_REGISTRY` | 打包内嵌运行时安装用的 npm 镜像 | `https://registry.npmmirror.com` |
| `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN` | 强制更新服务 origin（test 必填） | `https://sikao-engine.github.io` |
| `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` | 登录白名单等策略 JSON（test 必填 `allowedAuthOrigins`） | 见 `.env.windows` |

生成新的 release id（每批发布换一次；同批的重试、跨版本升级测试必须沿用同一个）：

```powershell
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(16).toString('hex'))"
```

**签名发布**还需 SafeNet 签名 token 四项（仅签名机构建需要，本地未签名包不需要）：
`DSH_DESKTOP_WINDOWS_CER_FILE`（X.509 叶子证书文件）、`DSH_DESKTOP_WINDOWS_SIGNTOOL`（SafeNet 兼容 signtool.exe）、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`、`DSH_DESKTOP_WINDOWS_TOKEN_PIN`。详见 `apps/desktop/windows-signing/README.md`。

**上传**还需（只在上传机上配置，打包不需要）：
`DOWNLOAD_TEST_COS_BUCKET`、`DOWNLOAD_TEST_COS_SECRET_ID`、`DOWNLOAD_TEST_COS_SECRET_KEY`。
上传时确保 `DSH_PACKAGING_PRESET` 未设置（机器预设只用于打包，不用于上传）。

## 3. 改了代码后的必经校验

- 修改 `apps/desktop/scripts/*.mjs` 时，**必须同步维护同名的 `.d.mts` 类型镜像**（tsc 解析的是镜像声明；漏掉会报 `TS2305: has no exported member`）。
- vitest 只做 esbuild 转译、**不做类型检查**。提交/打包前至少跑：

```powershell
node ./node_modules/typescript/bin/tsc -p tsconfig.host.json
```

- 打包过程内部会跑 run-gates 聚合门（bundle、tsc、web build 等 9 道）；失败时按提示看 `.desktop-build/packaging-runs/<时间戳>/events.jsonl`。

## 4. 打包

在仓库根目录执行。目标仅支持 `win-x64`（mac 目标必须在对应 macOS 主机上打）。

```powershell
# 1) 环境+工具链预检（本地未签名流程，应输出 "local configuration and toolchain valid"）
pnpm run package:desktop:win:x64:unsigned --check

# 2) 打包；auto = 今天(YYYYMMDD) + 下一个空闲序号（先问 COS 桶，无凭据则扫本地产物）
pnpm run package:desktop:win:x64:unsigned -- --build-version auto

# 或显式指定
pnpm run package:desktop:win:x64:unsigned -- --build-version 0.2.1-dev1.20261025.1

# 3) 签名发布包（需要第 2 节的 SafeNet 配置；产物供上传更新源）
pnpm run package:desktop:win:x64 -- --build-version 0.2.1-dev1.20261025.1
```

- 未签名产物：`apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/deepseek-harness-<版本>-win-x64-unsigned.exe`（无更新配置、无发布记录，仅供本机/同事安装测试）。
- 签名产物：`apps/desktop/.desktop-build/targets/win-x64/artifacts/`，附带 `win-x64-release.json` 发布完成记录（上传时校验它）。
- 可选加速：设 `DSH_DESKTOP_PACKAGE_CACHE_DIR` 为绝对路径，跨检出复用下载/包缓存。
- 打包需要联网（npm、GitHub release 资源、nodejs.org）；本机 Node 24 + pnpm(root packageManager) + Git + PowerShell 7 + tar + Python + VC++ Build Tools + Windows SDK。

## 5. 上传发布（test 部署）

前置：第 4 节的**签名**产物已生成；`.env.windows` 已配 COS 三项；`DOWNLOAD_TEST_ORIGIN` 就是更新 feed 的真实公网地址。

```powershell
# 发布更新 feed + 安装包（从发布完成记录读取版本与校验）
pnpm run upload:win:x64

# 可选：替换固定下载对象 desktop/dsh-latest-windows-x64.exe（不发 feed、不打 tag）
pnpm run upload:latest:win:x64
```

发布后对象布局（`dsh-desk` 前缀）：

```
<origin>/dsh-desk/<release-id>/feeds/win-x64/nightly.yml     # 更新 feed
<origin>/dsh-desk/<release-id>/bin/win-x64/                  # 安装包与 .blockmap
```

- 上传校验：发布记录、部署、目标、版本、文件名、大小、SHA-512；`.exe.blockmap` 先于 YAML 上传。
- 审计记录：`.desktop-build/upload-records/test-win-x64-<时间戳>/`（`plan.json`、`events.jsonl`、`result.json`），随发布证据归档。
- **production 部署**：`DSH_DESKTOP_AUTO_UPDATE_ENV=production`，origin 固定 `https://download.deepseek.com`，上传成功后自动打并推 `desktop-v<版本>` git tag；test 上传不打 tag。生产配置用 `DOWNLOAD_PROD_COS_*`。
- 同一 channel 串行发布；超时或失败回执不代表对象未写入，重试前先核对远端状态。

## 6. 常见错误速查

| 错误 | 原因 | 处理 |
|---|---|---|
| `DOWNLOAD_TEST_ORIGIN must be set to a non-empty value` | `.env.windows` 缺 origin/release id（签名预检要求 test 更新配置完整） | 按第 2 节补齐 |
| `DOWNLOAD_TEST_COS_BUCKET must be set`（`--build-version auto` 时） | 老版本 bug：有 origin 无桶时自动编号不回退本地 | 已修复（`hasDesktopUploadBucket` 回退）；更新代码或改用显式版本 |
| `TS2305: has no exported member` | 改了 `.mjs` 没同步 `.d.mts` 镜像 | 补镜像声明后重跑 tsc（第 3 节） |
| `must extend 0.2.1-dev1 as 0.2.1-dev1.<date>...` | 构建版本写成 `0.2.1-dev.1...` | 用 `0.2.1-dev1.<date>.<seq>`（`dev1` 不可拆分） |
| `ProgramFiles(x86) is not set`（仅 Git Bash 沙箱） | 环境变量名大小写被沙箱改变 | 正常 cmd/PowerShell 无此问题 |
| `DSH_DESKTOP_WINDOWS_CER_FILE must identify...` | 签名预检缺 SafeNet 配置 | 本地测试改用 `:unsigned`；签名发布补 token 配置 |
