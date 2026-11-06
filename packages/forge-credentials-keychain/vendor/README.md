# 预编译凭据适配器（native addon）

本目录只存放三平台预编译产物与校验清单，不含源码，也不参与编译。运行时由
`src/native-keyring.mjs` 按 `platform-arch` 选择对应文件，经绝对路径加载。

## 来源与许可

| 项 | 值 |
|---|---|
| 上游 | `@napi-rs/keyring` 2.1.2（keyring-rs 的 N-API 绑定） |
| 许可 | MIT，随文件附 `LICENSE.third-party.md` |
| 固定方式 | `scripts/native-keyring.json` 记录版本与 tarball integrity，`CHECKSUMS.json` 记录落地文件的 sha256 |
| 生成工具 | `scripts/fetch-native-keyring.mjs` |
| integrity 交叉核对 | 三个 tarball 的 sha512 与 `registry.npmjs.org` 元数据一致（2026-11-06 核对） |
| 对象头校验 | 按 triple 校验 PE/AMD64、PE/ARM64、ELF/x86-64、ELF/AArch64、Mach-O/arm64，防止清单钉错架构 |
| 外部依赖 | Windows 需 `VCRUNTIME140.dll`（VC++ 2015-2022 运行库）；Linux 只需 glibc ≥ 2.15（x64）/ 2.17（arm64）；macOS 无额外依赖 |

## 交付映射

| 目录 | platform-arch | 目标环境 |
|---|---|---|
| `win32-x64-msvc/` | win32-x64 | Windows 10/11 x64 |
| `win32-arm64-msvc/` | win32-arm64 | Windows 11 on ARM |
| `linux-x64-gnu/` | linux-x64 | UOS 20 amd64 |
| `linux-arm64-gnu/` | linux-arm64 | 银河麒麟 aarch64 |
| `darwin-arm64/` | darwin-arm64 | macOS Apple Silicon |

未列出的组合不属于交付目标：`darwin-x64`（Intel Mac）没有交付机器，Rosetta 下按不可用处理。

## 为什么不用 npm 依赖

企业包构建规则拒绝 `optionalDependencies` 与任何非 `@heluo/forge-*` 的运行时依赖，
终端也不允许在安装期解析平台包。把 addon 作为发布资源随包分发，三条约束同时满足：
终端不编译、不联网、不解析外部包，制品仍然自包含。

## 重新生成与校验

```sh
node scripts/fetch-native-keyring.mjs            # 暂存三个交付目标
node scripts/fetch-native-keyring.mjs --check    # 只校验 CHECKSUMS.json 与文件一致
```

下载的每个 tarball 都会与 `scripts/native-keyring.json` 中的 integrity 比对，不一致立即
中止且不写入任何文件。升级版本时同步修改版本号、integrity 与 `CHECKSUMS.json`，并重新
跑实机取证，不得只改版本号。

## 安全边界

addon 以当前用户身份调用系统凭据库。它能保证凭据落在系统凭据库而不是明文文件；
**不能**阻止同一用户下的其他进程读取同一条目。该边界在包 README 与设计文档中同样写明。