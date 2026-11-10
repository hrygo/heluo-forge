# 完整安装包输入说明

`installer-inputs.json` 描述六类宿主目标、宿主归档的声明摘要与发行信息。装配器 `scripts/assemble-full-installer.mjs` 按此文件取件、核验字节并在仓库外生成安装包目录；它不下载宿主、不验证签名，也不包含任何密钥。本文与装配器实现冲突时，以 `scripts/lib/full-installer.mjs` 为准。

## 顶层结构

```json
{
  "schema": "heluo-installer-inputs/1",
  "host": {
    "version": "0.2.1-rc.5",
    "license": "licenses/DSH-LICENSE",
    "source": "https://downloads.example.com/dsh/0.2.1-rc.5"
  },
  "webPort": 58260,
  "platforms": {
    "windows-x64": {
      "archive": "host/windows-x64.zip",
      "sha256": "<64 位小写十六进制>",
      "license": "licenses/DSH-LICENSE",
      "signature": "signed"
    },
    "linux-x64": {
      "archive": "host/linux-x64.tar.gz",
      "sha256": "<64 位小写十六进制>",
      "license": "licenses/DSH-LICENSE",
      "signature": "unsigned",
      "web": true
    }
  }
}
```

`platforms` 是对象，键为下表的平台 id，不是数组；`schema` 固定为 `heluo-installer-inputs/1`。

## 顶层字段

| 字段 | 必填 | 含义 |
|---|---|---|
| `schema` | 是 | 固定 `heluo-installer-inputs/1` |
| `host.version` | 是 | 本次装配的宿主版本，写入 `install.json` 与安装包说明 |
| `host.license` | 是 | 宿主许可证标识或文件路径 |
| `host.source` | 是 | 宿主归档取得位置的 `https://` 地址，仅作来源记录，装配器不访问它 |
| `platforms` | 是 | 按平台 id 索引的对象，见下节 |
| `webPort` | 否 | Web 目标的回环端口，整数 1–65535，默认 `58260` |

宿主归档摘要按平台分别给出（`platforms.<id>.sha256`），顶层 `host` 不承担摘要校验。

## 平台条目

每个平台条目的字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `archive` | 是 | 宿主归档路径，相对 `installer-inputs.json` 所在目录；不得包含 `..`、反斜杠或以 `/` 开头；扩展名须为 `.zip`、`.tar.gz`、`.tgz`、`.tar.xz`、`.dmg`、`.exe` 或 `.AppImage` |
| `sha256` | 是 | `archive` 的 64 位小写十六进制摘要；装配前按字节核验，不一致即失败 |
| `license` | 是 | 随该目标分发的许可证标识或文件路径 |
| `signature` | 是 | 发布者声明的签名状态，只能是 `signed`、`unsigned`、`notarized` 或 `unknown` |
| `web` | 视形态 | 布尔值；Web 形态目标必须为 `true`，桌面形态目标省略或为 `false` |

`signature` 只是声明，装配器不验证签名，也不会把任何状态报告为已验证；`verify-full-installer` 按声明状态展示。

## 六类目标与形态

| `id` | 形态 | `web` |
|---|---|---|
| `windows-x64` | 桌面 | 省略或 `false` |
| `windows-arm64` | Web | 必须 `true` |
| `linux-x64` | Web | 必须 `true` |
| `linux-arm64` | Web | 必须 `true` |
| `macos-x64` | 桌面 | 省略或 `false` |
| `macos-arm64` | 桌面 | 省略或 `false` |

不带 `--platforms` 时，六个 id 必须全部出现；显式传入 `--platforms id1,id2` 时只装配列出的子集。Web 目标在 `install.json` 中写入 `listen: "127.0.0.1:<webPort>"`，只允许回环地址，不得绑定 `0.0.0.0` 或任何对外地址。

## 失败即关闭

- `schema` 不符、`platforms` 不是对象、出现未知 id：`INPUTS_INVALID`，不生成安装包。
- 不带 `--platforms` 时缺目标，或请求的子集未在输入中提供：`PLATFORMS_INCOMPLETE` 或 `PLATFORMS_INVALID`。
- `archive` 缺失、越出输入目录、扩展名不支持、`sha256` 格式错误、`signature` 不在枚举内、`web` 不是布尔值：`INPUTS_INVALID`。
- 归档字节与声明摘要不一致：`HOST_DIGEST_MISMATCH`，在写入前停止。
- 形态与 `web` 不一致（如桌面目标声明 `web: true`，或 Web 目标未声明 `web: true`）：`PLATFORM_FORM_INVALID`。
- 输出目录位于仓库内或非空：`OUTPUT_INSIDE_REPO` 或 `OUTPUT_EXISTS`，不覆盖既有产物。
- 任一目标失败时不保留半成品：装配在暂存目录进行，失败后清理，不留下可被误认为完整安装包的目录。

摘要与路径必须来自可信来源；装配器只核验声明，不替使用者判断归档是否值得信任。
