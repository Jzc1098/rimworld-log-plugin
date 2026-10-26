# RimWorld 日志分析插件 — 操作说明

一个 DSH 插件：在**不修改 RimCrow 任何文件**的前提下，把「一键分析游戏日志」搬到 DSH 这边来做。
分析引擎就是当前会话的 Agent，所以对话、结论、补丁建议都由 DSH 落盘保存，随时可以接着追问。

- 插件包目录：`rimworld-log-plugin/`（本目录）
- 包名：`@local/rimworld-log`
- 对 RimCrow / RimWorld 的写入：**零**。所有读取都是只读。

---

## 1. 它能做什么

| 能力 | 入口 |
|---|---|
| 一键分析游戏日志 | 在输入框输入 `/rimlog` 回车（输入框下方有「RimWorld 日志」条，可先选来源） |
| 按需分析 / 追问细节 | Agent 工具 `rimworld_log_scan`，直接用自然语言让我调用 |
| 指定日志来源 | `/rimlog realtime`、`/rimlog player`、`/rimlog player playerPrev` |
| 忽略增量、整份重扫 | `/rimlog --full` |
| 只看向某个时间之后 | `/rimlog --since 2026-10-08` |
| 带自己的问题一起问 | `/rimlog player 帮我确认是不是这个 mod 的问题` |
| 原始检索 | 让我调用 `rimworld_log_scan` 的 `action=grep`（支持普通子串或 `/正则/flags`） |
| **启用/禁用 mod 以进一步排查** | `/rimmods enable <packageId>`、`/rimmods disable <packageId>`（默认只出草稿） |
| 真正写入 mod 列表 | ⛔ **插件不代做**：启用/禁用由你自己在 RimCrow 或游戏里勾选 |
| 生成补丁 | 分析后直接说「给我补丁」，补丁会落在 `~/.dsh/rimworld-log/patches/` |

### 补丁放在哪、怎么落地

补丁是**普通的文件**，由我（Agent）生成，插件只负责把位置固定下来，方便你找到、审查、纳入版本管理：

```
C:\Users\<你>\.dsh\rimworld-log\patches\      ← 可用 DSH_RIMWORLD_PATCH_DIR 改
```

`/rimlog` 会把「补丁写这里」和「落地前先确认」一起交给我，所以一次正常流程是：

1. `/rimlog` → 我给出根因与证据链
2. 我说要出补丁 → 文件写到上面那个目录（**不动你的 mod**）
3. 你看过、确认 → 我才考虑复制进 mod 目录或编译 DLL（**每次单独确认**）

能生成的补丁形态：

| 形态 | 适用 | 落地方式 |
|---|---|---|
| XPath / 兼容补丁 XML | 改 Def 数值、字段、互斥冲突 | 放进 `<mod>\Patches\*.xml` 或做成独立补丁 mod |
| Harmony C# 补丁 | 需要改 mod 的行为、拦方法 | 写项目 + 编译出 DLL（需你确认，且要求本机能编译） |
| `ModsConfig` 调整方案 | 加载顺序、启用组合 | 用 `/rimmods` 出清单，**由你自己勾选** |
| 排查报告 / 复现步骤 | 你自己去上游提 issue | 直接给文本 |

### 一键分析实际发生什么

1. 插件在本地读日志 → 按「级别 + 归一化消息 + 关键堆栈指纹」聚类 → 按出现次数与严重度排序。
2. 生成一份紧凑载荷（brief）：来源与性价比、错误/警告计数、问题簇、每个簇的归属 mod 与置信度、代表性堆栈帧、原始样本。
3. 把载荷作为一条用户消息交给当前会话 → 由我这边分析并回复。
4. 游标落盘，下次默认只分析**新增**日志。

载荷示例（真实输出节选）：

```
### 1. [ERROR] ×147 Texture '' has dimensions (<w>x<h>) which are not multiples of <n>. Compress will not work.
- 首次: 2026-10-08 16:35:29.413   末次: 2026-10-08 16:38:02.083
- 归属 mod: Faster Game Loading - Continued [taranchuk.fastergameloading]（推断，<RimCrow 安装目录>\mods\3652938473）
  - 依据: 线索来自堆栈方法的命名空间指向 FasterGameLoading，已与启用列表匹配
  - 注意: 堆栈还经过 GraphicSetter 的代码；若上一条路径线索指向未启用的 mod，优先查它
- ⚠ 堆栈路径提到但不在启用列表中的 mod: GraphicsSetter（常见于已卸载/已禁用但补丁仍生效…优先核查）
```

---

## 2. 日志来源与性价比（回答「选哪个划算」）

| 来源 | 文件 | Token 花费 | 信息强度 | 说明 |
|---|---|---|---|---|
| `realtime` | `RimCrow_Realtime.log` | **低** | **最强** | 结构化 JSON：每条带 level、完整堆栈、`count` 去重、关联 mod 与文件。**默认选它。** |
| `player` | `Player.log` | 高 | 兼容 | 纯文本、重复堆栈无法去重，同样信息约贵 2–5 倍。未启用辅助模组时是唯一来源，也可用于交叉验证。 |
| `playerPrev` | `Player-prev.log` | 高 | 回溯 | 与 Player.log 同格式，用于对比「这次新增了什么」。 |

**结论：默认只用 `realtime`。** 需要交叉验证或排查「上次运行」的问题时，再加 `player` / `playerPrev`。
在输入框下方的「RimWorld 日志」条里点「选择来源」即可多选，界面会实时显示将要执行的命令。

> 想让 `realtime` 信息更全：在 RimCrow 里开启辅助工具模组 `RimCrow Companion`（RimCrow 的「使用辅助工具模组」选项）。
> 插件会探测并告知你是否已安装。**启用 mod 属于文件改动，按第 4 节规则需要你单独确认。**

---

## 3. 安装

前置：DSH Desktop，且至少打开过一次页面（profile `desktop`）。

1. 把 `rimworld-log-plugin/` 整个目录放到任意位置（**不要**放进 `$DSH_HOME`，也不要在 profile 目录里跑 pnpm）。
2. 先跑一次 `node mock-host.mjs`，确认宿主半边能正常注册——这比装上去再重启快得多。
3. 让我执行安装（`plugin_manager` 的 `install_bundle`，`target` 传该目录的**绝对路径**）。这一步会改动 profile，需要你批准。
4. 读返回的 `application` / `warnings` 判断是否生效——`applied` 才算成功，`restart-required` 表示要重启 DSH。
5. 验证：在输入框输入 `/`，应能看到 `rimlog` 命令；输入框下方应出现「RimWorld 日志」条。

> **如果返回 `application: failed` 且只写 `failed to import`**：DSH 对插件行只导入一次，失败后不会自动重试，
> 也不给具体原因。装好后即使代码已修，也需要**重启一次 DSH** 才能重新导入。
>
> 想知道真正的原因，用 Node 直接导入宿主半边（无需重启、无需批准）：
>
> ```powershell
> node --input-type=module -e "await import('file:///<插件目录>/index.js'); console.log('IMPORT OK')"
> ```
>
> 输出 `IMPORT OK` 说明代码没问题、只差重启；输出 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/...'`
> 说明插件里静态 `import` 了 `@deepseek-ai/*`（链接进 profile 后 Node 按真实路径解析，找不到它们）。
> 本插件刻意不 import 任何 `@deepseek-ai/*`，改动时请保持这一点，`mock-host.mjs` 会检查。
>
> 改 profile 的 `cordis.patch.yml` 增删启用行**不会**让已失败的行重新导入（已验证），请恢复该文件后重启。

**关于版本门禁**：DSH 会校验插件 `peerDependencies` 里的 `@deepseek-ai/dsh*` 是否匹配运行时版本。
本插件**刻意不声明**任何 DSH peer（官方做法：「Missing DSH peers impose no constraint」），所以不会被版本门禁拒绝。
如果以后你给它加了 DSH peer 声明，就可能触发 `incompatible-version` 并被静默跳过。

### 卸载

让我执行 `plugin_manager` 的 `remove_bundle`（`target` = `@local/rimworld-log`）。
另有少量状态文件在 `~/.dsh/rimworld-log/`（增量游标），删掉即可，不影响其它任何东西。
可用环境变量 `DSH_RIMWORLD_LOG_STATE` 改这个目录的位置。

---

## 4. 写入边界（重要）

| 操作 | 是否自动执行 |
|---|---|
| 读日志、读 mod 的 `About.xml`、读 `ModsConfig.xml`、读 mod 源码 | ✅ 只读，自动 |
| 生成分析结论、证据链、修复建议 | ✅ 只输出 |
| 起草 mod 列表改动（显示 diff 与来源目录） | ✅ 只输出，不写文件 |
| 真正写入 `ModsConfig.xml` | ⛔ **一律拒绝**（`apply: true` 也不例外）。仅当机器上设了 `RIMLOG_ALLOW_MOD_WRITES=1` 才放行，默认不设 |
| 生成补丁/修复文件到工作区给你过目 | ⚠️ 会先说明，落到工作区 |
| 拍工作区快照（`rimworld_workspace_archive` `snapshot`） | ⚠️ 写快照目录，并按天删掉第 4 天及更早的快照 |
| 导出迁移包（`export`） | ⚠️ 写一个新目录；目标已存在则拒绝，不覆盖 |
| 写进 mod 目录、编译 DLL | ⛔ 每次单独跟你确认 |

**写入 `ModsConfig.xml` 的安全设计**：写入前生成带时间戳的备份（`ModsConfig.xml.bak-<时间>`，与原文件同目录），
写入后**回读校验**条目数与顺序；若文件在草稿生成之后被改动过（RimCrow 或游戏在写），会直接拒绝而不是覆盖；
**检测到 RimWorld 正在运行时会拒绝写入**，因为游戏退出时会用内存里的列表覆盖你的改动。

插件本身不会写 RimCrow 或 RimWorld 的任何文件，除了你明确要求的 `ModsConfig.xml`。

### 4.1 工作区快照与迁移包（工具 `rimworld_workspace_archive`）

工作区里有两类东西：**手写的结论**（`OPEN_ISSUES.md`、`PATCHES.md`、日志归档这类）和**可再生成的产物**。
最初的设计想只收前者，结果**漏掉了 33 个 `fix-*` 项目目录和插件本体**——白名单每出现一个新目录就静默失效一次。
现在的规则反过来：**默认全收，只排除明确可再生成的目录名**，且排除哪些会写在报告和 manifest 里。

| action | 做什么 | 会不会删东西 |
|---|---|---|
| `list`（默认） | 列出已有快照 | 不 |
| `snapshot` | 给今天拍一份，然后按天裁剪 | **会**——删掉第 4 天及更早的快照 |
| `export` | 导出迁移包 | 不（目标目录已存在则拒绝） |
| `note` | 写一份归档记录到 `归档/`，重建 `INDEX.md`，顺手拍快照 | **会**——同一份快照裁剪规则 |

#### `note`：为什么归档要变成自动的

用户的原话是「不要我每次来说」。手工归档真正的问题不是忘了写，而是**写的人得先想起来**：一天里最值得记的那一刻（跑完一次扫描、定位到根因）往往正好是上下文最满的时候，于是记录被跳过。

所以插件里有两层：

1. **`action=note`** —— 供 agent 在每完成一件值得记的工作后调用，参数 `title` / `body` / `tags`，默认写完后顺手拍快照（`snapshot=false` 可关闭）。写入 `<工作区>/归档/<日期> <时间> - <标题>.md`，并**按磁盘实际内容重建** `归档/INDEX.md`——手工删掉的条目会从索引里消失，而不是留一行指向不存在的文件。
2. **扫描后自动速记** —— 每次 `rimworld_log_scan` 的 `analyze` 完成后，自动落一份「日志扫描速记」。三条自我约束：只对 `analyze` 生效（`grep`/`detect`/`mods` 是查询动作，每次都归档会把记录变成噪声）；十分钟内最多一次（同一轮连扫多个来源不该产生多条近似记录）；开关是 `RIMLOG_AUTO_ARCHIVE=0`。归档失败不影响扫描结果——记录的价值低于它要记录的东西。

`归档/` 目录本身也在工作区里，所以每份记录都会被后续快照一并带走。

**保留策略是「任何时刻最多 3 天」，不是「攒够 4 天才删」。** 举例：在 1、6、10、15 号各归档一次，
结果就是 **6、10、15** 三份——15 号那次就已经把 1 号挤出去了。同一天重复执行**只覆盖当天那一份**，
不会累积（否则一天跑几次就把旧的那几天冲掉了）。今天的快照永远不删。

**不设单文件体积上限。** 曾经有过一个 4 MB 上限，被去掉了：实测它排除的 6 个文件（最大 10.65 MB）
全是反编译出来的 `.cs`——恰恰是最难再生成的一类，因为源 DLL 可能已经没了、当时用的反编译器和参数
也没有记录。**上限拿「静默漏掉最大的那几份成果」换磁盘空间，这笔交易不划算。**
实测工作区：801 文件 / 48.9 MB 一份，三天合计约 147 MB。

**迁移包只携带最新那一份快照。** 更早的快照留在快照目录里，不随包走——包里塞着过期副本，
是两台机器对「哪份结论是当前的」产生分歧的根源。包内结构：

```
migration-pack-YYYYMMDD-HHMMSS/
  workspace-snapshot/   最新一天的快照（内容直接在根，没有日期层）
  plugin/               插件本体
  plugin-state/         仅 install-state.json
  manifest.json         记录了带的是哪一天、省掉了哪几天
```

**目录名必须是 `migration-pack-YYYYMMDD-HHMMSS`**（例如 `migration-pack-20261019-210713`），
与 `snapshots/` 里已有的包保持一致。自定义 `outDir` 时若不合这个格式，`export` 会在结果里给一条
⚠️ 提醒但**不拒绝**——只是提醒，包照常导出。

为什么在意：写成「项目名-2026-10-19」这类**只带日期**的名字有两个实际后果——
同一天导出第二次会因为「目录已存在」被拒（或被迫改名），而且它和快照目录里的 `2026-10-19/`
这种日期目录混在一起，看不出哪个是包。

**按日志路径命名的游标文件故意不进迁移包**：它们记的是本机绝对路径，
带到新机器上会让首次扫描误以为已经读过。

快照目录默认在**工作区同级**的 `snapshots/`（例如 `<工作区上级目录>\snapshots`）。
工作区自身的解析顺序是：`RIMLOG_WORKSPACE_DIR` → `DSH_WORKSPACE_DIR` → 常见工作区路径（要求根目录有 `.md`）。
**解析不到存在的工作区时 `snapshot` 会拒绝执行**，而不是生成一份空快照报成功。

| 环境变量 | 作用 |
|---|---|
| `RIMLOG_WORKSPACE_DIR` | 指定要快照的工作区（权威值，即使不存在也照用，然后报错） |
| `RIMLOG_SNAPSHOT_DIR` | 指定快照目录，默认工作区同级的 `snapshots/` |

**整目录排除名单**（`lib/workspace-archive.js` 的 `DEFAULT_EXCLUDE`）：
`node_modules`、`.git`、`.svn`、`.hg`、`bin`、`obj`、`.vs`、`.idea`、`__pycache__`。
实测这份名单在工作区里只命中两个 `bin` 目录（4.8 MB 测试用 DLL）。

安全边界：所有递归删除前都会校验目标**确实位于快照目录内**；校验不通过就跳过并报告，不删。

---

## 5. 配置项

插件行的 `config` 都是可选的：

```yaml
- id: rimworld-log
  name: '@local/rimworld-log'
  config:
    profileId: b6e211a5c2bd4d739acd2da77b4cbb8c   # 固定分析哪个 RimCrow profile；省略=自动选日志最新的
    defaultSources: [realtime]                     # /rimlog 不带参数时用哪些来源
```

工具参数（`rimworld_log_scan`）：`action`、`sources`、`source`、`pattern`、`limit`、`full`、
`incremental`、`since`、`maxClusters`、`profileId`、`rimcrowHome`。

自动探测顺序：显式参数 → 环境变量 `RIMCROW_HOME` → `C:\RimWorld\RimCrow` 等常见路径（只按 `RimCrow.exe` / `data\config.json` 判定）。
模组搜索根由 RimCrow 的 `data\config.json` 与所选 profile 的 `profile.json` 推导，不写死。

---

## 6. 验证状态

**已实证生效（客户端半边）**

`cordis_inspect_query` 的 Slot 树显示插件已挂在输入框下方：

```
slot conversation.composer.dock (list, scope=session)
  occupants: [ { id: "stats", order: 0 }, { id: "rimworld-log-bar", order: 60, active: true } ]
```

即「RimWorld 日志」条**已注册且处于 active**。这证明客户端半边加载成功、slot 名正确、注册未被拒。
（我仍无法做视觉确认——没有浏览器控制权。字体、配色、明暗主题下的可读性需要你看一眼。）

**离线验证（全部通过）**

| 测试 | 内容 |
|---|---|
| `mock-host.mjs` | 18 项：模块导出、无外部 import、`apply()` 不抛、工具契约、schema 类型合法性、命令注册、secrets 上下文、四个 action 实跑、草稿不写入 |
| `selftest.mjs` | 11 项：探测 / 解析 / 聚类 / 归属 / 增量 / 原版回落 |
| `modconfig-test.mjs` | 17 项：XML 往返、计划、dry-run、真实写入、备份、回读校验、mtime 守卫、幂等，并断言真实文件未变 |
| `fallback-test.mjs` | 无 RimCrow 时改用 `Player.log`（146 条 → 26 错误 → 5 类） |

真实数据结果：RimCrow 装在默认位置；7 个 profile；启用 441 个 mod、磁盘 2032 个、**0 个误判缺失**；
实时日志 445 条 → 215 错误 / 126 警告 → **45 个错误簇收敛为 7 个**；13/40 个簇定位到 mod；
载荷约 15.8 KB ≈ 4900 token。

**尚未生效（宿主半边，需要重启一次 DSH）**

宿主行在首次安装时导入失败，原因已定位并修复（详见下方两条坑）。DSH 对插件行只导入一次、失败不重试，
且 Node 的 ESM 缓存按模块标识复用，所以**必须重启一次**才能加载修好的代码。重启后请确认：

1. `/` 菜单里能看到 `rimlog` 与 `rimmods`
2. `/rimlog` 能跑出分析结果
3. 上面那条 UI 在浅色/深色主题下的排版是否正常

### 两个已修复的真实错误

**① 静态 import 了 `@deepseek-ai/*`** → `ERR_MODULE_NOT_FOUND`，整个模块加载失败。
改为零外部依赖：只用 Node 内置模块、本地 `lib/`、以及通过 `ctx` 访问的 Cordis 服务。

**② `output.schema.type` 写成 `"json"`** → 注册被拒：

```
JsonSchemaError: unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

这个写法是从随包发布的 `dsh-tool-cordis` 照抄的，但外部插件直接 `ctx.tools.register(plainObject)`
时校验更严。已改为 `{ type: 'object', additionalProperties: true }`，并在 `mock-host.mjs` 里加了递归
schema 类型校验（这条断言经过"故意塞回 `json` 验证能抓到"的检验）。

**别浪费时间的四条**（都实测过，见 PORTING.md 的表格）：重装 `install_bundle`、`set_plugin` 切换、
改 `cordis.patch.yml` 增删启用行、插入同包的第二行 —— **都不会**让已失败的插件行重新导入，因为缓存键是**包**而不是行。
唯一有效路径是重启进程。试过之后请把 `cordis.patch.yml` 恢复原样。

### 生成 RimWorld XML 补丁时的八个坑

这五条都是**真实踩过**的：前四条来自为「绮罗拓展的弹药找不到工作台」写补丁，第五条来自 KiiroCE 口径守卫。
共同点是 —— **静态校验全过，游戏里照样失败**。所以规则不是「XML 合法就行」，而是下面这些额外约束。

**① 文件位置决定它被当成「定义」还是「补丁」**

`<Operation>` 放在 `<mod>\Defs\*.xml` 里，RimWorld 会把它当成一个**名为 `PatchOperationAdd` 的 Def** 来解析：

```
Type PatchOperationAdd is not a Def type or could not be found, in file GW_AmmoBench.xml
```

结果是**那条操作被静默跳过**（不报致命错，游戏能进，但补丁没生效）。
→ **定义放 `Defs/`，补丁操作放 `Patches/`，两者不要同文件。**
→ 校验时不要用「文件里有没有 `<Operation>` 这几个字」来判断——注释里提到它就会误报。要绑到 **XML 结构**上：解析后看 `Defs` 节点的子元素里有没有 `Operation`。

**② `Name` 属性只属于继承解析阶段，补丁阶段已经不存在**

抽象模板 `<ThingDef ... Name="AmmoBolter75Base" Abstract="True">` 用 `[@Name="AmmoBolter75Base"]` 寻址：

```
Verse.PatchOperationAdd(xpath="..."): Failed to find a node with the given xpath
```

`Name` 是给继承用的，不是给补丁用的。**连模板元素本身都匹配不到**，不是「匹配到了但字段不对」。
→ 补丁只能寻址**具体的 `defName`**。想在继承链上做文章，得逐个列出子 def。

**③ XPath 的最后一步必须有落点**

具体 def 常常**自己没有**那个子元素（它们从父模板继承）。例如那 5 个弹药 def 和 5 个配方 def 都**没有自己的 `<recipeUsers>`**：

```xml
<!-- 命中 0 个 -->
<v>Defs/RecipeDef[defName="MakeAmmo_Bolter75_Standard"]/recipeUsers</v>
```

→ 路径**只定位到 def**，把整个元素放进 `<value>` 里新增：

```xml
<xpath>Defs/RecipeDef[defName="MakeAmmo_Bolter75_Standard"]</xpath>
<value><recipeUsers><li>GWAmmoBench</li></recipeUsers></value>
```

**④ 目标 Def 的 C# 类可能根本没有那个字段**

给弹药 def 加 `<recipeUsers>`：

```
XML error: <recipeUsers><li>GWAmmoBench</li></recipeUsers> doesn't correspond to any field in type AmmoDef
```

`CombatExtended.AmmoDef` 这个类**没有 `recipeUsers` 字段**（`RecipeDef` 才有）。
→ 判断「该不该加这个元素」的依据是**目标类有没有这个字段**，不是「这个名字听起来对不对」。
→ 有时根本不用加：那次弹药 def **本来就有** `CE_AutoEnableCrafting_GWAmmoBench` 标签（继承来的），注入器要的正是它。
**看日志里的组装 XML**（`Context:` 后面那一长串）能直接确认这点，比读源文件更可靠。

**⑤ Harmony 前缀不要和原方法抢返回值**

给一个「本身返回 `bool`、又带 `ref string __result` 参数」的方法写前缀时，如果自己也声明 `ref string __result`：

```
HarmonyException: Patching exception in method ... ---> System.Exception:
Cannot assign method return type System.Boolean to __result type System.String
```

两个参数**争同一个返回值位置**，Harmony 判定类型冲突，**整个补丁类注册失败**（同一批次里其他类也会受牵连）。
→ 前缀只做「跳过还是放行」时，**不要声明结果参数**，`return !ShouldSkip;` 就够了。
→ 多个补丁类要**各自独立注册**（逐个 `harmony.CreateClassProcessor(type).Patch()` 并 `try/catch`），
这样一类失败不会连累其他类，日志里也能分别看到 `applied / skipped / failed`。

**⑥ 贴图路径可能解析不了，而文件本身完全合规**

一个 `Graphic_StackCount` 弹药报错：

```
Collection cannot init: No textures found at path Things/Ammo/180mm_nade/HEAT180AT97
```

但把能查的都查了，**全部合规**：三个文件存在、尺寸一致（128×128）、是有效 PNG、命名符合 `_a/_b/_c`、
目录层级正常、无异常属性、无软链问题、全库无覆盖冲突、该 mod 的**其他**贴图能正常加载。

**这类问题静态检查发现不了**——文件系统层面一切都是对的，只有实际启动才暴露。
`GetAllInFolder` 返回空，意味着**这条路径字符串在引擎的贴图索引里就是查不到**。

**排查手段只有单变量实验**，每轮只改一个：

| texPath | 图片 | 结果 |
|---|---|---|
| `ThirdParty/Warhammer/Ammo/MeltaGun` | CE | ✅ |
| `Things/Ammo/180mm_nade/HEAT180AT97` | 原件副本 | ❌ |
| `Things/Ammo/180mm_nade/HEAT180AT97` | **换 CE 的图** | ❌ ← 排除「图片内容」 |
| `ThirdParty/KiiroFix/180mm_nade/HEAT180AT97` | 原件副本，**换目录+换 mod** | ❌ ← 排除「目录/归属」 |
| `ThirdParty/KiiroFix/HEAT180` | 原件副本，**只改名字** | ✅ ← 定位到「基本名」 |

→ **改名即修**，且不需要改动原 mod 的任何文件：把图片复制到自己的补丁 mod、用一个能用的名字、改 texPath 指过去。
→ 诊断用补丁的写法：`PatchOperationReplace` 打在 `.../graphicData/texPath` 上（`Replace` 而非 `Add`，否则两个 `texPath` 会歧义）。

> **教训**：看到 `No textures found` 先别急着怀疑文件。用「换图片 / 换目录 / 换 mod / 换名字」四次单变量实验
> 就能把范围锁死。这个案例里，前三次全失败、第四次成功，一共花了 5 轮启动。

**⑦ Harmony 前缀：三个会让它「报告成功但实际无效」的陷阱**

这三条都是**实测踩到的**，而且共同点是 **`guard applied` 打印了、日志显示成功，功能却没生效**。

**7a. 前缀里绝不能调用被 patch 的方法本身**

想「在别人方法外面包一层」，于是 patch 了 `X.CustomLoad`，又在它的前缀里用反射调 `X.CustomLoad`：

```
System.StackOverflowException
  at MyPrefix.LoadWithGuardedCompression()
  at MyPrefix.Prefix(...)
  at GraphicSetter...CustomLoad(...)
  - PREFIX my.patch: Prefix(...)          ← 又回到自己
```

前缀一调原方法就再次触发自己 → 无限递归 → 栈溢出。
→ 需要「原方法 + 前后加工」时：用 **Postfix**，或 patch **更底层的调用点**（如它内部调用的 Unity 方法），**不要 patch 自己又要调的入口**。

**7b. 目标返回 `void` 时，`return false` 可能跳不过去**

```csharp
[HarmonyPatch(typeof(Texture2D), "Compress")]
static bool Prefix(Texture2D __instance) { ... return false; }   // 想跳过
```

`Texture2D.Compress` 返回 **`void`**（一条编译命令就能确认：把返回值赋给变量，编译器会报 `CS0029: 无法将类型"void"转换为"bool"`）。
Harmony 只能替换**有返回值**的方法的结果，`void` 目标上返回 false **未必**能跳过。
→ **动 void 方法前先确认它的返回类型**；跳过不了就改用 **Transpiler** 直接改 IL（把 `call` 换成条件跳过）。

**7c. `[StaticConstructorOnStartup]` 太晚，赶不上贴图加载**

补丁在静态构造函数里注册，日志显示 `guard applied` 正常，但错误只减少了 91%：

```
23:07:58  开始加载贴图 ← 错误从这里开始
23:10:33  guard applied ← 补丁这时才生效（晚了约 2.5 分钟）
23:10:59  1 条错误（第二轮加载）
totals: allowed=1 declined=0
```

`[StaticConstructorOnStartup]` 在「所有 mod 的静态构造函数」阶段运行，而 **mod 内容（含贴图）加载在它之前**。
→ 想拦截**加载期**的行为，必须比 `[StaticConstructorOnStartup]` 更早注册（例如在程序集被加载时，或挂在更早的启动方法上）。
→ **诊断方法**：在前缀里放计数器，在 `Verse.Root.Shutdown` 上挂前缀汇总打印。`allowed=1 declined=0` 这种数字能一眼看出「补丁生效但拦得太少」，比反复猜快得多。

**⑧ 要替换的元素本身就叫 `<value>` 时，写入内容必须包两层**

真实事故。想改一个 `<value>` 元素里的音频名：

```xml
<!-- 错：PatchOperationReplace 的 <value> 是「要写入什么」的容器，
     写成单层时，目标 <value> 元素被替换成了纯文本 -->
<Operation Class="PatchOperationReplace">
  <xpath>//soundOneShotsOnEvent/li/value[text()="RT_WheeledVehicleStart"]</xpath>
  <value>VVE_VehicleStart</value>
</Operation>
```

游戏报 6 条：

```
XML error: VVE_VehicleStart doesn't correspond to any field in type VehicleSoundEventEntry`1
```

正确写法是**再包一层**，让写入内容是一个 `<value>` **元素**而不是字符串：

```xml
<value><value>VVE_VehicleStart</value></value>
```

**一般规律**：`<value>` 的内容必须是**目标节点该有的结构**。目标是元素就写元素，目标是文本才写文本。
被替换的元素叫 `<value>` 只是最容易踩的一种形态。

**为什么这条单列**：它**通过了我的离线验证**。验证脚本用 `InnerText` 做扁平文本替换，
而游戏用 `<value>` 的**子元素**替换整个节点——两种做法在脚本里都产出合法 XML，所以脚本看不出区别。
详见下方的验证纪律。

### 一条通用的验证纪律

上面八条说明：**「XML 合法 + XPath 在源文件里能命中」远不足以判定补丁可用。**
判定补丁能否生效，至少要同时满足：

1. 文件在**正确的目录**（`Patches/`，不是 `Defs/`）
2. XPath 只寻址**补丁阶段仍存在的节点**（具体 `defName`，不是 `Name`）
3. 路径最后一步**在目标上有落点**（或把元素整个放进 `<value>`），且 **`<value>` 的结构与目标节点一致**（第 ⑧ 条）
4. `<value>` 里的字段**在目标 C# 类里存在**
5. Harmony 补丁的参数签名**不与原方法冲突**，且**前缀不调用被 patch 的方法**
6. 涉及的**贴图路径**在引擎里真的能解析（第 ⑥ 条，只能实测）
7. **注册时机**早于它想拦截的行为（第 ⑦c 条）

这八条里任何一条不满足，症状都是「静态检查通过、日志说成功、游戏里却没生效」。

> 更稳的做法：**先做实验再写补丁**。用 .NET 的 `System.Xml` 把相关文件合并成一个文档，跑一遍候选 XPath，
> 看命中几个、加完元素长什么样。坑②③④⑧就是这么定位的——比反复重启游戏快得多。
> 而坑⑥**没法这样查**，坑⑦**要靠计数器在实机里暴露**，所以这两条更要每次只改一个变量。

#### 验证方式必须与运行时一致（这一条压倒上面全部）

**违反它的后果不是「没验出来」，而是「验证给出了假的通过」——比不验更危险。**

第 ⑧ 条就是这么漏过去的：我**离线验证过**那个补丁，脚本报「3 条 xpath 各命中 1 处，替换成功」，
然后游戏报了 6 条 XML error。原因是**脚本和游戏做的事不同**：

| | 做法 |
|---|---|
| 我的脚本 | 用 `InnerText` 做**扁平文本替换** |
| 游戏 | 用 `<value>` 的**子元素替换整个节点** |

单层写法让 `value` 元素变成了纯文本。**两种做法在脚本里都产出合法 XML**，所以脚本看不出区别。

```
<value><value>VVE_VehicleStart</value></value>   正确：节点被替换成 <value> 元素
<value>VVE_VehicleStart</value>                  错误：节点被替换成文本 "VVE_VehicleStart"
```

**修法（两处一起）**

1. 验证脚本改成**按游戏的方式做事**：用 `<value>` 的**子元素**替换目标节点（`tools/probe-patch-file.ps1`）
2. 脚本**专门检测「裸文本 value」**并明确报出游戏会怎么拒绝它：

```
value is BARE TEXT: 'VVE_VehicleStart'
-> if the target node is an element, the game will report
   'XML error: <text> doesn't correspond to any field in type ...'
```

**写完任何验证，先自问这三句**：

| 问一句 | 如果答不上来 |
|---|---|
| 我的验证**做了运行时做的那些事**吗？ | 只是「看起来合理」不算 |
| 这个错误如果存在，**我的验证会以什么形式失败**？ | 答不出＝这个验证抓不到它 |
| 我验的是**假设**，还是**实际行为**？ | 「应该没问题」是假设 |

**同类前科**（同一份纪律的其它失败形式，全部真实发生）：

| 事件 | 我的验证说 | 实际 |
|---|---|---|
| `<value>` 单层 vs 双层 | 替换成功 | 6 条 XML error |
| 审计工具报 3 个补丁「目标 defName 找不到」 | 补丁有问题 | **审计只索引了游戏 `Mods` 目录，漏了工坊**；那 3 个补丁在游戏里早已生效 |
| 报 `Pawn HealthBar` 的 About.xml 有问题 | 顶层出现非法 `<li>` | **我的标签扫描器没跳过 XML 注释**，把 `<!--modDependencies>` 当成了开标签 |
| 报 `RK_Fire` 仍然存在 | 补丁无效 | **grep 匹配到了我自己补丁的名字**（mod 更新列表里） |
| 报每个 mod 的 About.xml 都有非法元素 | 结构错误 | 正则匹配了**所有层级**的元素，不是顶层 |

**共同点：五次的「验证」都与被验证的对象做的事不同。** 每一次都差点让我去改一个本来没坏的东西。

#### 可复用的两个验证器

| 工具 | 做什么 |
|---|---|
| `tools/audit-patches.mjs` | 扫所有补丁：About.xml 字段、packageId 唯一性、依赖是否存在、补丁类是否合法、xpath 目标的 defName 是否真实存在（**索引必须覆盖工坊目录**，否则会像上表第二行那样误报） |
| `tools/probe-patch-file.ps1` | 把某个补丁对一个**副本**跑一遍，按游戏的方式替换节点，并报出裸文本 `<value>` 之类会被游戏拒绝的写法 |

---

## 7. 开发辅助脚本（可删）

### 7.1 三条来自实机复盘的教训

这三条不是补丁写法的坑，而是**工具设计**的坑——都是回看一次真实对话记录才发现的。

**① 增量分析会把「没有新增」报成「没有问题」**

一次真实事故：用户点了 `/rimlog`，得到

```
已扫描 RimCrow 实时日志(0条/错误0)；问题簇 错误 0 / 警告 0
```

但**同一份日志里躺着 9 条错误**。原因：增量游标已在文件末尾，本次解析 0 条，于是所有计数都是 0。而「0 错误」被顺理成章地读成了「日志是干净的」。

**代价**：那次对话因此退化成手工取证——**45 次 `pwsh`**、把整份日志导出成 43 KB 的转储再用 `Select-String` 搜、还手工重建了一张 187 KB 的 mod 映射表。这些插件本可以一次给出。

**修法（三处一起）**：
- `/rimlog` **每个会话首次自动全量**（人类按一次的按钮，默认必须是完整的；之后重按仍走增量，保持便宜）
- 载荷里**显式声明范围**：`全量` 还是 `增量`、从哪个字节起、本次解析多少条
- 增量读到 0 条时**不能说「未发现问题」**，要说「本次增量无新增，这只代表自上一轮以来没有新内容，不代表日志干净」，并**附上上一轮发现的问题**

**为什么要记住上一轮**：游标只记录「读到哪」，不记录「看到了什么」。所以另存一份 findings 侧车文件（`<cursor>.last.json`），空增量时才有东西可引用。

**通用原则**：**任何「限定范围的统计」都必须把范围写在数字旁边。** 一个不带范围的 `0` 比没有数字更危险。

**② 空结果必须有解释**

工具返回空内容时，调用方无法区分「没事」和「坏了」。任何返回空的地方都要说明**为什么空**、**怎么拿到非空**。

**③ 消费者需要的定位信息要一并给出**

插件能指出「是某个 mod 的问题」，但**不说它装在哪**，于是调用方得自己去几万个目录里搜。
`detect` 现在直接给出 `<packageId> → <目录>` 的映射（只含已启用的 mod，455 条约 35 KB）。

### 7.2 会话记录查阅（`tools/read-session.mjs`）

用来**回看任意一次 DSH 对话**——复盘「插件在那次对话里到底起没起作用」「AI 为什么绕了远路」这类问题。上面 §7.0 的三条教训就是这么发现的。

```bash
# 列出所有会话，按时间倒序，附首条人类发言
node tools/read-session.mjs --survey

# 单个会话：概览（记录类型、工具调用统计、插件使用次数）
node tools/read-session.mjs <session.v4.jsonl.zstd>

# 其他视角
node tools/read-session.mjs <file> --turns      # 人类发言 + 助手回复
node tools/read-session.mjs <file> --tools      # 每个工具调用及其参数
node tools/read-session.mjs <file> --commands   # 所有 shell 命令 + 说明
node tools/read-session.mjs <file> --errors     # 含错误标记的记录
node tools/read-session.mjs <file> --grep 文本   # 按子串找
node tools/read-session.mjs <file> --raw 30,31  # 原始记录（排查解析问题用）
```

会话文件在 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`。

**这个格式有两个必须知道的坑**（都踩过）：

| 坑 | 症状 | 原因 |
|---|---|---|
| **文件是多帧 zstd** | 3.2 MB 的文件只解出 216 字节 | `zstdDecompressSync` 遇到第一帧结束就返回，要按帧魔数切分逐帧解 |
| **记录的载荷在 `data` 下，且形状随类型变** | 代码「读不到工具调用」 | 按固定字段路径取会静默读到空；要结构化搜索 |

还有一条：`modNameFromFramePath` 这类辅助函数**返回的是对象不是字符串**，直接 `String()` 会得到 `[object Object]`，表现为「明明该匹配却匹配不上」。

### 7.3 测试与诊断（根目录，`node <name>` 直接跑）

| 文件 | 用途 |
|---|---|
| `mock-host.mjs` | **安装前必跑**：用 mock Cordis 上下文跑宿主半边，验证注册、工具、命令、系统上下文 |
| `selftest.mjs` | 端到端自检（探测 / 解析 / 聚类 / 归属 / 增量），退出码非 0 表示有问题 |
| `modconfig-test.mjs` | `ModsConfig.xml` 写入模块的测试，**全程在临时副本上跑**，并断言真实配置未被改动 |
| `attribution-test.mjs` | 归属逻辑的单元测试（装配名 / 文件夹名 / packageId 三套索引） |
| `tools/dev/diag.mjs` | 打印探测结果、聚类与归属过程；`--brief` 会把载荷写到 `diag-brief.md` |
| `fallback-test.mjs` | 验证「没有 RimCrow、只有原版 `Player.log`」的降级路径 |
| `tools/dev/missing.mjs` | 列出启用了但在磁盘上找不到的 mod |
| `tools/dev/debug-attrib.mjs` | 排查某个簇为什么被归到某个 mod |
| `tools/dev/debug-playerlog.mjs` | 查看 `Player.log` 的解析结果 |
| `tools/dev/debug-entries.mjs` | 打印匹配某模式的**完整日志条目**（含未截断的堆栈），排查时最常用 |
| `tools/dev/debug-json.mjs` | 复现「工具返回非法 JSON」那类问题 |

运行方式：`node mock-host.mjs` / `node selftest.mjs` / `node modconfig-test.mjs`（需要 Node 18+）。

```powershell
# 模拟“没装 RimCrow”的环境，验证原版日志回落
$env:RIMCROW_HOME='C:\__no_such_rimcrow__'; node fallback-test.mjs; Remove-Item Env:\RIMCROW_HOME
```

### 7.4 一次性调查工具（`tools/`，按需跑）

这些是为具体排查任务写的一次性脚本，**保留是因为同类问题会再出现**。全部只用 Node 内置模块，从 `../lib/` 复用解析器。

| 文件 | 解决什么问题 |
|---|---|
| `probe-structure.mjs` | 横向对比：某种结构（如 `Graphic_StackCount` + 贴图文件夹）在全库有多少、谁在用 |
| `probe-diff.mjs` | 两个案例**逐字段对比**（PNG 块、IHDR、def 写法），用于「一个正常一个报错」的场景 |
| `probe-180mm.mjs` | 定位某个 `graphicClass` 是谁设的 |
| `probe-variants.mjs` | 普查 `_a/_b/_c` 变体贴图集，判断某命名约定是否主流 |
| `probe-nameshape.mjs` | 普查基本名的形态（含数字 / 与文件夹名是否一致） |
| `find-textures-by-size.mjs` | **按尺寸反查贴图**——日志里贴图名为空时的唯一办法 |
| `probe-missing-recipes.mjs` | 缺配方普查：某配方名是否真的不存在、同类配方是否都有 |
| `probe-ve.mjs` | 程序集成员普查（轻量：只读字符串堆，不做全表遍历） |
| `ammo-consumers.mjs` | 反查「谁在用这批弹药」——判断某个报错该归谁 |
| `attribute-recipes.mjs` | 缺配方的**归属**：扫描启用的 mod 找谁引用了它 |
| `compact-report-prototype.mjs` | 浓缩报告原型：`node tools/compact-report-prototype.mjs [日志路径]`，输出体积/token 对比 |
| `decode-sigs.py` | 从 .NET 程序集解出**指定方法的签名**（返回类型 / 参数 / 是否静态）。游戏程序集在 Unity 外无法反射，只能读元数据 |
| `dump-assembly.py` | 程序集的**全貌**：所有类型、方法签名与字符串字面量。回答「这个 mod 到底干了什么」而不需要反编译器 |
| `find-def-refs.mjs` | **谁引用/谁定义了某个 def**——只在**已启用的 mod** 里搜（受 ModsConfig 约束，不会全库扫）。回答「这个缺失的 SoundDef 该由谁提供」 |
| `find-vanilla-def.mjs` | 某名字是不是**原版（含 DLC）**定义的，给出定义文件。用来区分「mod 忘带文件」和「原版就没有」 |
| `new-warnings.mjs` | 两次日志的**警告簇差集**——回答「新加的 mod 引入了什么新问题」 |
| `compare-sessions.mjs` | 两次日志的 mod id 差集 + 错误簇对比 |
| `session-timeline.mjs` | 会话时间线：补丁何时生效、错误何时发生。**判定「错误是否在补丁生效之后」**——决定一个残留错误是时序限制还是逻辑缺陷 |
| `read-session.mjs` | **回看 DSH 对话记录**（见 §7.2） |
| `audit-patches.mjs` | **一次审完所有自制补丁**：About.xml 字段是否合法、packageId 是否唯一、依赖是否存在、补丁类是否认识、xpath 目标的 defName 是否真实存在。索引**必须覆盖工坊目录**，否则会把工坊里的 defName 报成「找不到」（真实误报过 3 次） |
| `check-about.mjs` | 全库扫 `About.xml`：把每个文件的**直接子元素**与 `Verse.ModMetaData` 的合法字段对比，并查 packageId / supportedVersions / 依赖块的结构。**必须跳过 XML 注释**，否则 `<!--modDependencies>` 会被当成开标签 |
| `weapon-cost.mjs` | 武器的**研究前置 + 制作材料**折算成本，用于判断数值改动是否有依据 |
| `compare-weapons.mjs` | 两把武器逐字段对比（含 CE 的 ToolCE），用于「参考同作者的同类武器」 |
| `find-melee-weapons.mjs` | 全库找近战武器定义，用于找同类参考 |
| `dump-melee-tools.mjs` | 导出某武器最终生效的 `tools` 列表（含继承解析后的结果） |
| `def-chain.mjs` | 追一条 Def 的**继承链**（ParentName → 父 → 祖父），确认某字段到底来自谁 |
| `ce-melee-anchor.mjs` | 为 CE 近战武器找**同类锚点**：同作者 / 同材料 / 同定位的武器，其 `power` 与穿甲值是多少 |
| `verify-recipe-fixes.ps1` | 补丁验证器：配方重命名 / 新增类 |
| `verify-155mm-recipe-fix.ps1` | 补丁验证器：155 毫米炮弹配方 |
| `check-compress-fix.ps1` | 补丁验证器：程序集类的类型 / 属性 / 目标方法 / 依赖 API |
| `probe-patch-file.ps1` | **模拟补丁执行**：对一个副本按游戏的方式替换节点，并报出裸文本 `<value>` 这类会被游戏拒绝的写法。见 §6「验证方式必须与运行时一致」 |

**已废弃、不要再用**（留着只为说明为什么换了）：

| 文件 | 为什么弃用 |
|---|---|
| `find-bad-about.mjs` | 有深度上限，且只扫顶层，**会把内层 `1.x\About\About.xml` 整个漏掉**。改用 `check-about.mjs` |
| `check-about-schema.mjs` | 用正则扫 `ModMetaData` 的**全部层级**元素，把每个 mod 的 `modDependencies/li` 都当成非法顶层标签，**对 1000 多个文件全部误报**。改用 `check-about.mjs` |

**共同套路**：先普查（范围有多大、谁在用）→ 再单变量对比（一个正常 vs 一个报错）→ 最后定位。

> 写这类脚本时的三条经验：
> **① 别递归扫全库**（36,000+ 个 XML 会卡死，先用 mod 列表缩小范围）；
> **② PNG 尺寸用 `fs.openSync` 只读 24 字节**就够了，别整份读进内存；
> **③ 验证器必须做运行时做的那些事**——否则它的「通过」是假的（见 §6 的验证纪律）。

### 7.5 发版与元数据（改版本、改作者、打包）

这四个工具维护的是**插件自身的元数据**，不参与日志分析。改动它们等于改动「这个插件是什么」，所以都提供 `--dry-run` 或 `--help`。

| 工具 | 管什么 | 会不会写 |
|---|---|---|
| `tools/build-package.py` | **把插件打成交付包**（zip + 自生成更新日志 + SHA256） | ⚠️ 写输出目录，**不碰插件本体** |
| `tools/bump-version.mjs` | 升版本：`package.json` 的 `version` + 登记表里全部子版本号 + 清理孤儿条目 | ⚠️ 写两个文件 |
| └ `tools/bump-version.py` | 同功能的早期 Python 实现，**保留但不再维护**；行为一致时以 `.mjs` 为准 | ⚠️ 写两个文件 |
| `tools/check-package-json.py` | 查 `package.json` 有没有指向不存在的文件 | ✅ 只读 |
| `tools/sync-manifest.mjs` | 从实际目录重生成 `插件清单.md` 里的文件列表与计数 | ⚠️ 写 `插件清单.md` |

**发版完整流程见 `RELEASE.md`**，这里只记两条纪律：

**① 打包必须显式给基线**

```powershell
python tools/build-package.py --baseline <上一版目录>
```

不给基线的版本会**明确写「变更清单不可用」**，而不是把全部文件报成「新增」。原因见 `RELEASE.md` 第四节：脚本曾经自动猜基线，猜中了 1.0 的归档，于是 1.6.1 的更新日志把六个版本写成一个版本的改动 —— **而输出里没有任何迹象表明对比是错的**。

**② 这三个工具有一个共同的失效模式：静默改错**

`bump-version` 改的是别的工具要读的文件（`package.json`、`blocks.json`），`sync-manifest` 改的是清单本身。**它们出错时不会报错，只会产出一份自洽但错误的结果。**

所以每次改完都要核一次：

```powershell
python tools/check-package-json.py                  # 应输出 OK
node tools/sync-manifest.mjs --dry-run              # 应显示「文件无变化」
node tools/stamp-blocks.mjs --dry-run               # created/modified/missing 应全为 0
```

**三条都干净，才说明元数据一致。**

> `sync-manifest.mjs` 本身踩过一次这个坑：它原本用 `readdirSync` 只看 `tools/` 顶层，把 `tools/dev/` 下 6 个文件**静默从清单里删掉**，标题计数从 76 变成 70 而没有任何提示。**一个会悄悄漏掉文件的清单，比没有清单更糟** —— 它正是这个脚本存在的目的。现已改为递归，并验证过幂等。

---

## 8. 常见问题

**`/rimlog` 没反应或提示未找到 RimCrow**
设置环境变量 `RIMCROW_HOME` 指向 RimCrow 目录，或在 `config.rimcrowHome` 里指定（工具参数同样支持）。

**提示「文件不存在（该来源在当前 profile 下没有生成）」**
该 profile 下确实没有这个日志。`Player.log` 在 RimCrow profile 里通常不存在，只在 RimWorld 的用户数据目录（`%USERPROFILE%\AppData\LocalLow\Ludeon Studios\...`）里，插件会自动回落到那里；若游戏没跑过就不会有。

**分析结果比 RimCrow 内置 AI 少**
默认是增量分析（只看新增）。用 `/rimlog --full` 整份重扫。

**某个簇写着「归属 mod: 未能确定」**
堆栈里只有引擎帧、且编译期路径没有 mod 线索。可以直接让我读载荷里列出的原始日志行或 mod 源码继续定位。

**卸载后残留**
只剩 `~/.dsh/rimworld-log/` 里的游标文件。
