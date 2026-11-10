# 预编译凭据适配器（native addon）

本目录只存放四组合预编译产物与校验清单，不含源码，也不参与编译。运行时由
`src/native-keyring.mjs` 按 `platform-arch` 选择对应文件，经绝对路径加载。

## 来源与许可

| 项 | 值 |
|---|---|
| 上游 | `@napi-rs/keyring` 2.1.2（keyring-rs 的 N-API 绑定） |
| 许可 | MIT，随文件附 `LICENSE.third-party.md` |
| 固定方式 | `scripts/native-keyring.json` 记录版本与 tarball integrity，`CHECKSUMS.json` 记录 addon 和许可证的字节数与 sha256 |
| 生成工具 | `scripts/fetch-native-keyring.mjs` |
| integrity 交叉核对 | 四个 tarball 的 sha512 与 `registry.npmjs.org` 元数据一致（2026-11-06 核对） |
| 对象头校验 | 按 triple 校验 PE/AMD64、PE/ARM64、ELF/x86-64、ELF/AArch64，防止清单钉错架构 |
| 外部依赖 | Windows 需 `VCRUNTIME140.dll`（VC++ 2015-2022 运行库）；Linux 只需 glibc ≥ 2.15（x64）/ 2.17（arm64） |

## 交付映射

| 目录 | platform-arch | 目标环境 |
|---|---|---|
| `win32-x64-msvc/` | win32-x64 | Windows 10/11 x64 |
| `win32-arm64-msvc/` | win32-arm64 | Windows 11 on ARM |
| `linux-x64-gnu/` | linux-x64 | UOS 20 amd64 |
| `linux-arm64-gnu/` | linux-arm64 | 银河麒麟 aarch64 |

未列出的组合不属于交付目标；`linux-x64-musl` 等上游存在的其他产物不随包分发，映射不到即按不可用处理。

## 为什么不用 npm 依赖

企业包构建规则拒绝 `optionalDependencies` 与任何非 `@heluo/forge-*` 的运行时依赖，
终端也不允许在安装期解析平台包。把 addon 作为发布资源随包分发，三条约束同时满足：
终端不编译、不联网、不解析外部包，制品仍然自包含。

## 重新生成与校验

```sh
node scripts/fetch-native-keyring.mjs            # 暂存四个交付目标
node scripts/fetch-native-keyring.mjs --check    # 只校验 CHECKSUMS.json 与文件一致
```

每个 tarball 解包前都会与 `scripts/native-keyring.json` 中的 integrity 比对，不一致即中止，
已完成的其他目标可能仍保留在暂存目录。升级版本时同步修改版本号、integrity 与
`CHECKSUMS.json`，并重新跑实机取证，不得只改版本号。

记录须包含每个 addon 和许可证的字节数与摘要；缺少许可证摘要的旧记录不能通过当前校验，
应按锁文件重新暂存并重新构建制品。

## 安全边界

addon 以当前用户身份调用系统凭据库。它能保证凭据落在系统凭据库而不是明文文件；
**不能**阻止同一用户下的其他进程读取同一条目。macOS 不使用本目录的 addon，其存储边界
见包 README 的「macOS 存储边界」。
