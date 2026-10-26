# RimWorld 日志分析插件（DSH）

**中文** · [English](README.md)

> **免责声明（RimWorld EULA 要求）**
>
> Portions of the materials used to create this content/mod are trademarks and/or
> copyrighted works of Ludeon Studios Inc. All rights reserved by Ludeon. This
> content/mod is not official and is not endorsed by Ludeon.

一个**只读**的 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 插件：读取并预聚类 RimWorld 游戏日志（推荐配合 [RimCrow](https://github.com/rimcrow/RimCrow) 使用），把结论交给当前会话，让 AI 帮你定位 mod 冲突、崩溃原因与帧数掉点。它**不改游戏、不改 mod 列表**，只读日志与文件元数据。

- 首个公开版本：**v1.6.9**
- 许可证：**PolyForm Noncommercial 1.0.0**（非商业、源码可见，见 [LICENSE](LICENSE)）；第三方声明与 RimWorld 使用规则见 [NOTICE.md](NOTICE.md)
- 免费（RimWorld EULA 的要求）：不卖、不含广告、插件内不请求捐赠

---

## 一、这是什么

| 它做什么 | 它不做什么 |
|---|---|
| 读 RimCrow 实时日志 / Player.log，聚类错误与警告 | 不修改 RimWorld、不改 `ModsConfig.xml` |
| 按堆栈归属到具体 mod，给出证据与样本 | 不替你启用/禁用 mod（清单给你，勾选你自己来） |
| 生成/审计修复补丁（XML 补丁、Harmony DLL 的工作区） | 不下载、不分发任何第三方 mod 内容 |
| 归档工作区快照、对账、导出迁移包 | 不上传任何日志或文件 |

## 二、前置条件

| 必需 / 可选 | 是什么 |
|---|---|
| **必需** | [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 桌面版，且已能正常对话 |
| **必需** | Node.js 20+ 与 pnpm（安装依赖用；DSH 自带运行时也够） |
| **可选** | [RimCrow](https://github.com/rimcrow/RimCrow)：装了它日志才是结构化 JSON（分析质量显著更好） |
| **可选** | Node 解析 `Player.log` 也能用，只是信息量少 |

## 三、快速开始（每一步都可直接复制给 DSH）

### 第 0 步：环境自检

复制这句给 DSH：

```text
检查我的环境：Node 版本、pnpm 是否可用、DSH 版本；有没有装 RimCrow、RimWorld 装在哪个目录。
缺什么就给我一条可直接执行的安装命令，别只描述。
```

### 第 1 步：装依赖（本仓库不含 node_modules）

在**本仓库根目录**执行：

```bash
pnpm install
```

没有 pnpm 时：`npm install`。

> 为什么需要：插件导出 `Config`（DSH 行配置的 Schemastery schema），运行期依赖公共包 `schemastery`。
> 少了它，插件安装会报 `ERR_MODULE_NOT_FOUND`。安装后目录里应出现 `node_modules/schemastery`。

### 第 2 步：安装插件

复制这句给 DSH（把路径换成你 clone 下来的绝对路径）：

```text
用 plugin_manager 的 install_bundle 安装这个目录：<本仓库的绝对路径>。
装好后告诉我结果（applied / failed 及原文），并提醒我重启 DSH。
```

> 不要手动改 profile 的 `package.json` 或 `cordis.patch.yml`，也不要 `plugin_manager` 之外的 `pnpm install` 落在 profile 目录里。

### 第 3 步：重启 DSH

关掉 DSH 进程再打开（模块缓存键是「包」不是「行」，热替换无效）。

### 第 4 步：验证

复制这句给 DSH：

```text
跑 rimworld_plugin_guide action=usage 看工具都在；
再跑 rimworld_log_scan action=detect 确认能读到日志；
最后分析最近一次游戏日志，只报新增的 ERROR 并说明各自归哪个 mod。
```

## 四、能做什么（工具与动作）

### `rimworld_log_scan`（分析）

| `action` | 作用 |
|---|---|
| `analyze`（默认） | 聚类错误/警告、按堆栈归属 mod、给证据与样本；`compact=true` 出紧凑签名视图（每簇一行，引擎帧折叠）；`ignore` 过滤已知噪音 |
| `detect` | 环境与日志来源清单（profile、日志文件、启用模组、来源性价比） |
| `grep` | 在原始日志里按子串或 /正则/ 检索；`context=0..3` 带相邻行 |
| `mods` | 起草启用/禁用清单（**只出草稿，不写入**） |
| `mods-changed` | 时间窗内更新/新增/移除的 mod（目录时间 + About 版本与基线比对） |
| `diff` | 本次 vs 上次会话：新增 / 消失 / 计数变化 |
| `patchaudit` | 工作区源码 ↔ 已部署 DLL 的哈希与时间对照 |
| `aboutcheck` | About.xml 六项校验（结构、裸 `&`、description、BOM/乱码） |

### `rimworld_workspace_archive`（归档）

`list` / `snapshot`（按天保留 3 份）/ `export`（迁移包，只带最新快照）/ `verify`（快照与工作区逐文件对账）/ `note`（写归档记录并拍快照）。

### `rimworld_plugin_guide`（自述）

`report` / `usage`（参数取值实时生成）/ `since` / `config`（当前生效设置与**每个值的来源**）。

### `rimworld_plugin_compare`（按块比对）

与另一份插件副本按块比对差异（不判断谁更新）。

### 命令

`/rimlog`、`/rimmods` 与上面工具同名动作等价。

## 五、设置

装好并重启后，**设置 → 左栏「RimWorld 日志」**（在「Agent 预设」下面）是一个独立设置页，7 个键可直接编辑。

生效优先级（从高到低）：

1. **环境变量**
2. **设置界面**（写进 profile patch）
3. `~/.dsh/rimworld-log/settings.json`
4. 内置默认

两个如实说明：**保存后要重启 DSH 才生效**（已加载的 host 半区不会热重载配置）；**环境变量始终优先**。

## 六、环境变量

| 变量 | 作用 |
|---|---|
| `RIMWORLD_DIR` | RimWorld 安装根（其下有 `Data/`、`Mods/`） |
| `WORKSHOP_DIR` | Steam 工坊内容目录 `…/workshop/content/294100` |
| `RIMCROW_HOME` | RimCrow 安装根（非默认位置时用） |
| `CE_MOD_DIR` | Combat Extended 的 mod 目录（CE 相关诊断脚本用） |
| `VISUAL_EXCEPTIONS_DLL` | VisualExceptions 的 DLL 路径（`tools/probe-ve.mjs` 用） |
| `DSH_RIMWORLD_PATCH_DIR` | 生成补丁的输出目录（默认 `~/.dsh/rimworld-log/patches`） |
| `RIMLOG_WORKSPACE_DIR` | 工作区目录（快照与归档的来源） |
| `RIMLOG_STATE_DIR` | 插件状态目录（默认 `~/.dsh/rimworld-log`） |
| `RIMLOG_SNAPSHOT_DIR` | 快照目录（默认工作区旁的 `snapshots`） |
| `RIMLOG_AUTO_ARCHIVE=0` | 关闭分析后的自动归档速记 |

## 七、排错

工具没加载或设置页没出现时，复制这句给 DSH：

```text
排错：先看 plugin_manager 的 list_plugins 里有没有 rimworld-log；有的话看它报错原文；
再确认插件目录里 node_modules/schemastery 是否存在（不存在就 pnpm install）；
最后确认我重启过 DSH。
```

检查清单：

1. 插件目录里有没有 `node_modules/schemastery`？没有 → 第 1 步没做。
2. `list_plugins` 里 `rimworld-log` 是 enabled 还是 failed？failed 看诊断原文。
3. 重启过 DSH 吗？（设置与工具都只在重启后生效）
4. 设置左栏没有「RimWorld 日志」→ 跑 `rimworld_plugin_guide action=config`，看它能不能报出设置（能=host 半区正常，只是界面未注册，请附 DSH 版本反馈）。
5. 日志读不到 → 跑 `rimworld_log_scan action=detect`，确认 profile 与日志路径。

## 八、卸载

复制这句给 DSH：

```text
用 plugin_manager 移除 rimworld-log 插件；告诉我文件夹和 ~/.dsh/rimworld-log 状态目录要不要删，我自己决定。
```

删 `~/.dsh/rimworld-log` 会一并清掉增量游标、mod 版本基线与可选的 `settings.json`。

## 九、文档

| 文档 | 给谁看 |
|---|---|
| [使用参考.md](使用参考.md) | 使用者：能直接复制给 DSH 的一句话清单 |
| [安装说明.md](安装说明.md) | 完整安装、确认、排错、卸载 |
| [COMBAT_EXTENDED.md](COMBAT_EXTENDED.md) | CE 兼容参考（判定、四类补法、已验证的坑、载具一节） |
| [块功能介绍.md](块功能介绍.md) | 块登记、按块比对与选择性导入（维护者/协作者） |
| [插件清单.md](插件清单.md) | 每个文件干什么、哪些能删 |
| [HISTORY.md](HISTORY.md) | 版本累积更新记录 |
| [RELEASE.md](RELEASE.md) | 如何打交付包（维护者） |

## 十、版本与许可

**v1.6.9 — 首个公开版本。** 版本历史见 [HISTORY.md](HISTORY.md)。

- 插件代码与文档：**PolyForm Noncommercial 1.0.0**（见 [LICENSE](LICENSE)）
  （允许非商业的使用、修改与再分发；不允许商业用途）
- Ludeon 声明与「本仓库不是什么」：见 [NOTICE.md](NOTICE.md)
- RimWorld 相关材料：归 Ludeon Studios Inc.，本插件**非官方、未获背书**（声明原文见本页顶部与 [NOTICE.md](NOTICE.md)）
- RimCrow：独立 MIT 项目（另作作者），本仓库不包含它
- 本仓库**不包含**任何第三方 mod 的代码、贴图或数据；文档中出现的 mod 名称仅作事实引用
