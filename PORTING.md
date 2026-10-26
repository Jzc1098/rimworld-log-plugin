# 移植方案：把这个插件给别的 RimCrow 用户用

目标：让**任何** RimCrow 用户装上同一个插件包，就能得到「一键分析游戏日志 + 对话可保存 + 可生成补丁」的能力。
本插件从设计上就是可移植的：**不写死任何路径、不改动 RimCrow、不依赖本机的特定配置**。

---

## 1. 你要发出去的东西

只需要**一个目录**：`rimworld-log-plugin/`。

```
rimworld-log-plugin/
├── package.json          # bundle 清单（必需）
├── cordis.patch.yml      # 插件行声明（必需）
├── index.js              # 宿主半边：工具 + /rimlog + /rimmods + 环境上下文
├── client.js             # 客户端半边：输入框下方的日志源选择条
├── lib/
│   ├── detect.js         # RimCrow / profile / 模组 / 日志路径探测
│   ├── parse.js          # 实时 JSON 日志解析 + 聚类 + mod 归属
│   ├── playerlog.js      # Player.log 纯文本解析
│   ├── modconfig.js      # ModsConfig.xml 读写（唯一会写文件的模块）
│   └── report.js         # 增量读取 + 载荷渲染 + 原始检索
├── locale/{zh,en}.json   # 插件卡片标题/描述
├── icon.svg              # 插件卡片图标
├── OPERATIONS.md         # 给用户看的操作说明
├── PORTING.md            # 本文档
└── *.mjs                 # 开发辅助脚本（可选，见第 6 节）
```

**不需要**：构建工具链、npm 依赖、安装脚本、编译步骤。`client.js` 本身就是浏览器产物格式
（`window.__ModuleLoader__.load({id, factory})`），这是 DSH 官方模板的做法。

### 对方需要的环境

| 项 | 要求 |
|---|---|
| DSH Desktop | 已安装并能打开 Web GUI；profile 名默认 `desktop` |
| Node.js | 只有跑 `selftest.mjs` 这类辅助脚本时才需要；插件运行不需要 |
| RimWorld | 1.5 / 1.6 均可（插件不解析游戏版本，只读日志） |
| RimCrow | 可选。有 RimCrow 时用它的实时日志（信息最全）；**没有也能用**，会回落到原版 `Player.log` |

---

## 2. 对方怎么装

1. 解压 `rimworld-log-plugin/` 到任意目录（**不要**放进 `$DSH_HOME`，也不要放进 profile 目录）。
2. 在 DSH 里说：「把 `<该目录绝对路径>` 装成插件」——我（或对方的 Agent）会执行
   `plugin_manager` 的 `install_bundle`，`target` = 该目录绝对路径。
3. 这一步会改动 profile（装进 profile 的 `node_modules` 并把 bundle 加进 `dsh.profile.bundles`），
   需要用户批准。**不要手写 profile 的 `package.json` 或 `cordis.patch.yml`，也不要在 profile 目录跑 pnpm。**
4. 看返回的 `application` 字段：`applied` = 已生效；`restart-required` = 需要重启 DSH。
5. 验证：输入框输入 `/`，应能看到 `rimlog`。

### 版本门禁（唯一有失败风险的点）

DSH 会校验插件 `peerDependencies` 里的 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 是否匹配运行时版本：

> Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and
> `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`.
> Every declared range must match. **Missing DSH peers impose no constraint.**

本插件**刻意不声明**任何 DSH peer，因此不会触发该门禁，可以跨 DSH 版本移植。
转发给别人时**不要**好心加上 `peerDependencies`——那会变成版本炸弹。
万一真有插件被拒，用 `dsh plugin --profile <profile> allow-version <name>@<version> --dsh-version <runtime> --accept-risk` 做精确豁免。

---

## 3. 为什么不需要改路径（可移植性的关键）

所有路径都是**推导**出来的，顺序如下：

1. 显式参数：工具参数 `rimcrowHome` / `profileId`，或插件 `config`。
2. 环境变量 `RIMCROW_HOME`（一旦给了就以它为准，不会偷偷回落到别的安装）。
3. RimCrow 自己的 `data/config.json`：
   `workshop_mods_path`、`self_mods_path`、`steamcmd_mods_path`、`current_profile_id`、`steam_path`。
4. 每个 profile 的 `profile.json`：`game_install_path`、`user_data_path`、`game_version`、`name`。
5. 约定回落：`<盘符>:\RimWorld\RimCrow`、`%USERPROFILE%\AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios`。

模组搜索根同样是推导的：`workshop_mods_path`、`self_mods_path`、`steamcmd_mods_path`、
`<game_install_path>\Mods`、`<game_install_path>\Data`（本体与官方 DLC 在这里）、
`<steam_path>\steamapps\workshop\content\294100`、`<rimcrowHome>\toolmods`。

因此对方无论把 RimCrow 装在哪个盘、用 Steam 还是自建 workshop 目录、有没有装 DLC，都能直接跑。

**选中的 profile**：默认挑「日志文件最新」的那个，而不是 RimCrow 当前 profile——因为用户常常是刚跑完游戏来查日志。
要固定，就在 `config.profileId` 里写死 profile id 或名称。

---

### 安装后如果 `application: failed`

DSH 对每个插件行**只导入一次，失败后不会自动重试**，也不给具体原因。装好之后即使代码已修，也需要一次重启才能重新导入。

**先拿到真正的错误，再谈修。** 有三种手段，按代价从低到高：

**① 用 Node 直接导入宿主半边**（无需重启、无需批准）：

```powershell
node --input-type=module -e "await import('file:///<把插件目录的 index.js 绝对路径转成 file URL>'); console.log('IMPORT OK')"
```

- 输出 `IMPORT OK` → 模块能加载，问题只在加载器的缓存状态，**重启一次即可**。
- 输出 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-xxx'` → 头号原因，见下。
- 注意：这只验证**模块能否加载**，不验证 `apply()` 里的注册是否被注册中心接受。第二类错误要另找。

**② 跑 `node mock-host.mjs`**（无需重启、无需批准）：它会在 mock 上下文里真正执行 `apply()`，
覆盖 ① 抓不到的"注册被拒"类错误。

**③ 重新走一次 `install_bundle`**：`application: failed` 时的 `error.diagnostic` 会带上**真实堆栈**，
这是唯一能看到注册中心原始报错的途径。注意：包已在位时重装是 `changed: false` 的空操作，不会重新导入——但
**先 `remove_bundle` 再 `install_bundle` 会得到一次全新导入**（本项目的两类真实错误都是这样拿到的）。

### 两个真实踩过的坑

**坑 1：静态 `import` 了 `@deepseek-ai/*`**
插件被链接进 profile 后，Node 按它的**真实路径**（工作区/你放的位置）解析模块，那里没有 Harness 安装目录下的
`node_modules`，于是解析失败、整个模块导入失败。报错形如 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。

本插件因此**刻意不 import 任何 `@deepseek-ai/*` 包**：只用 Node 内置模块、自己的 `lib/`、以及通过 `ctx`
访问的 Cordis 服务。`@deepseek-ai/dsh-tools` 的 `defineTool` 只是便利封装（普通对象即可满足 `ToolDefinition`），
`@deepseek-ai/dsh-llm` 的 `createUserMessage` 也只是构造 `{ role: 'user', content }`。

**坑 2：`output.schema.type` 写成了 `"json"`**
从随包发布的工具（`@deepseek-ai/dsh-tool-cordis`）照抄 `output: { schema: { type: "json" }, render }` 会**在注册时被拒**：

```
JsonSchemaError: unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

`"json"` 不是 JSON Schema 类型。合法值只有 `object/array/string/number/integer/boolean/null`。
本插件用 `{ type: 'object', additionalProperties: true }`——`render` 负责把值变成模型可读的文本，
所以 schema 只描述**值的形状**，不描述序列化形式。

随包发布的包能这么写，是因为它们用 `defineTool` 等封装走自己的装配路径；**外部插件直接
`ctx.tools.register(plainObject)` 时校验更严**。`mock-host.mjs` 现在会递归校验参数树与输出 schema
里每一个 `type`，把这类错误挡在安装之前（这条断言是故意把 `"json"` 塞回去验证过的）。

**试过但都无效的办法**（省得你再花时间）。已失败或已改动过的插件行，**无法在不重启的情况下重新导入**，
原因是两侧的缓存都按**包**而不是按行：

| 尝试 | 结果 |
|---|---|
| `install_bundle` 重装 | 包已在位时是 `changed: false` 的空操作，不重新导入 |
| `set_plugin` 禁用→启用 | 行从未激活过，报 `unknown-plugin`，无从切换 |
| 改 `cordis.patch.yml` 增删 `disabled` | HMR 会重读 patch 层并重组（新增的 `Config` 条目立刻可见），但那一代失败的模块仍被缓存 |
| 先 `remove_bundle` 再 `install_bundle` | **能得到一次全新导入**，但只在包被真正移除的那一刻；若模块已进过缓存，重新安装仍复用旧的一代 |
| 插入同包的**第二个行实例**（不同 row id） | 两个行一起显示 `absent`——证明缓存键是包说明符，不是行 id |

唯一有效路径是重启进程。试过之后请把 `cordis.patch.yml` 恢复原样（本插件的作者在调试时就恢复过两次）。

---

## 4. 你（转发者）最好先做的自检

把插件目录给对方之前，在**你自己的机器**上跑一遍：

```powershell
node mock-host.mjs       # 用 mock Cordis 上下文直接跑宿主半边：注册 + 工具 + 命令 + 上下文
node selftest.mjs        # 端到端自检，退出码 0 才算通过
node modconfig-test.mjs  # ModsConfig.xml 写入模块（全程临时副本，并断言真实文件未被改动）
node tools/dev/diag.mjs            # 打印探测/聚类/归属过程；加 --brief 会写出 diag-brief.md
```

`mock-host.mjs` 是**安装前唯一能抓到导入级错误**的手段——它会断言 `apply()` 不抛异常、工具定义满足
`{ name, description, parameters, output: { schema, render }, execute }` 契约、命令 handler 即使拿不到
prompt 通道也把载荷交给用户。跑它比装上去再重启快得多。

`selftest.mjs` 会检查（全部基于真实日志，不是 mock）：

- 路径归一化、堆栈帧提取、命令行解析
- profile 枚举、`ModsConfig.xml` 与磁盘目录的 join
- 日志解析、聚类、mod 归属、载荷体积
- 增量游标与全量读取的一致性

另外两个诊断脚本：

```powershell
node tools/dev/missing.mjs             # 列出「启用了但磁盘上找不到」的 mod（用于验证搜索根是否够全）
node tools/dev/debug-attrib.mjs        # 排查某个簇为什么被归到某个 mod
node tools/dev/debug-playerlog.mjs     # 查看 Player.log 解析结果
```

---

## 5. 移植时容易踩的坑（都是实施中真实遇到的）

| 坑 | 表现 | 本插件的处理 |
|---|---|---|
| 官方 DLC 不在 `Mods` 目录 | 把 `ludeon.rimworld.*` 全报成「缺失」 | 也扫 `<install>\Data\<Dlc>`，并把 `ludeon.*` / `rimcrow.*` 归类为内置而非 mod |
| `About.xml` 里的 `<modDependencies>` | 大量无关 mod 抢同一个 `packageId`（真实数据里几十个 VFE mod 都声称自己是 `brrainz.harmony`） | 先剥掉 `<modDependencies>` / `<loadAfter>` 等嵌套块，只认根级 `<packageId>` |
| RimCrow 的 `mods\.workshop-stage\` | 暂存副本抢在真实目录前面，导致堆栈路径匹配不上 | 跳过隐藏目录，并对「链接目录 / 暂存目录 / 隐藏目录」按优先级排序去重 |
| 嵌套 `About` 目录 | 一个 mod 的源码树里也有 `About`，被当成独立 mod | 按路径深度自上而下解析，落在已接受 mod 目录内的全部丢弃 |
| mod 编译时没带 PDB | 堆栈里是**作者机器**的路径（`C:\Users\<作者>\CodeLibrary\rimworld-dev\...`），本机不存在 | 从路径里解析出 mod 名，再回落到启用列表匹配，并标注置信度与依据 |
| 堆栈里出现多个 mod | 下游帧（加载器）把上游真凶挤掉 | 证据分三级（路径 > 消息内 `from mod X` > 命名空间），只有前两级都不中才用命名空间；并把「路径提到但未启用」的 mod 单独高亮 |
| `Player.log` 没有时间戳、开头一堆 Unity 引擎噪声 | 解析出 0 条，或把 `Unloading N files` 当错误 | 从 `RimWorld <版本>` 行开始解析；引擎噪声行内跳过；错误判定用「强信号 + 良性否决」双向规则 |
| RimCrow 实时日志带 UTF-8 BOM | 首行 JSON 解析失败 | 逐行去 BOM |
| 日志轮转 / 截断 | 增量游标指向已不存在的偏移，静默漏读 | 游标只在文件大小不小于该偏移时才可信，否则自动全量重读 |

### 5b. 生成 RimWorld 补丁时的坑（如果你也要出补丁，必读）

分析日志之后很自然会想「顺手出个补丁修掉」。但 **XML 合法 + XPath 在源文件里能命中，并不代表补丁可用**。
下面五条全是实施中真实踩到的，症状一律是「静态检查全过，游戏里静默失效或只报一行错」。

| # | 坑 | 游戏里的表现 | 正确做法 |
|---|---|---|---|
| 1 | `<Operation>` 写在 `Defs\*.xml` 里 | `Type PatchOperationAdd is not a Def type or could not be found` —— **操作被静默跳过**，游戏照常进 | 定义放 `Defs/`，补丁操作放 `Patches/`，**绝不混在一个文件** |
| 2 | 用 `[@Name="某抽象模板"]` 寻址 | `Failed to find a node with the given xpath` —— 连模板元素本身都匹配不到 | `Name` 只属于**继承解析阶段**，补丁阶段已消失。只能寻址**具体 `defName`** |
| 3 | XPath 末尾多带一层子元素（如 `/recipeUsers`） | 同上，命中 0 个 | 具体 def 常**没有**那个子元素（从父模板继承）。路径**只到 def**，整个元素放进 `<value>` 新增 |
| 4 | 给某个 Def 加了它 C# 类里没有的字段 | `XML error: <...> doesn't correspond to any field in type XXX` | 先确认**目标类有没有这个字段**。有时根本不用加——先看日志里 `Context:` 后面的组装 XML |
| 5 | Harmony 前缀声明了结果参数，而原方法自己也返回/输出结果 | `HarmonyException: Cannot assign method return type ... to __result type ...` —— **整个补丁类注册失败**，同批其他类也受牵连 | 前缀只做「跳过/放行」时**不要声明结果参数**；多个补丁类**各自独立注册**并逐个 `try/catch` |
| 6 | 贴图路径解析不了，但文件本身**完全合规** | `Collection cannot init: No textures found at path ...` —— 弹药图标不显示 | 文件存在、尺寸一致、PNG 有效、命名正确、目录正常**都不够**。只能靠**单变量实机测试**定位：换图片 → 换目录 → 换 mod → 换名字，每次只改一个 |
| 7a | Harmony 前缀里调用了被 patch 的方法本身 | `System.StackOverflowException`，堆栈里能看到「自己的 Prefix → 被 patch 的方法 → 自己的 Prefix」 | 前缀**绝不能**调用被 patch 的方法。要包一层就用 **Postfix**，或 patch **它内部调用的更底层方法** |
| 7b | 对返回 `void` 的方法返回 false 想跳过 | **没有报错**——`guard applied` 打印了，功能却没生效 | 先确认目标返回类型（赋给变量让编译器报 `CS0029` 即可）。`void` 目标要改用 **Transpiler** |
| 7c | 补丁注册太晚，赶不上它想拦截的行为 | 部分生效（实测 148 → 13），`guard applied` 正常，但拦截到的调用极少 | `[StaticConstructorOnStartup]` 在 mod 内容加载**之后**才跑。要在加载期生效必须更早注册。**用计数器 + 在 `Verse.Root.Shutdown` 汇总**来暴露这类问题 |
| 8 | 替换的目标元素本身就叫 `<value>`，而写入内容只写了一层 | `XML error: <文本> doesn't correspond to any field in type XXX` —— 目标节点被替换成了**纯文本**而不是元素 | `PatchOperationReplace` 的 `<value>` 是「要写入什么」的**容器**。写入内容必须再包一层：`<value><value>新名字</value></value>` |

### 5c. 比上面所有坑都重要的一条：验证方式必须与运行时一致

**违反它的后果不是「没验出来」，而是「验证给出了假的通过」。**

坑 8 就是这么漏过去的：我**离线验证过**那个补丁，脚本报「3 条 xpath 各命中 1 处，替换成功」，
然后游戏报了 6 条 XML error。原因是**脚本和游戏做的事不同**：

| | 做法 |
|---|---|
| 我的脚本 | 用 `InnerText` 做**扁平文本替换** |
| 游戏 | 用 `<value>` 的**子元素替换整个节点** |

单层写法让 `value` 元素变成了纯文本。**两种做法在脚本里都产出合法 XML**，所以脚本看不出区别。

**推广开的判断标准**——写完任何验证，先自问：

| 问一句 | 答不上来就等于没验 |
|---|---|
| 我的验证**做了运行时做的那些事**吗？ | 「看起来合理」不算 |
| 这个错误如果存在，**我的验证会以什么形式失败**？ | 答不出＝抓不到它 |
| 我验的是**假设**还是**实际行为**？ | 「应该没问题」是假设 |

**同一份纪律下的其它前科**（都是「验证与被验证对象做的事不同」）：

| 我的验证说 | 实际 |
|---|---|
| 3 个补丁「目标 defName 找不到」 | 审计只索引了游戏 `Mods` 目录，**漏了工坊**；那 3 个补丁在游戏里早已生效 |
| `Pawn HealthBar` 的 About.xml 顶层有非法 `<li>` | 标签扫描器**没跳过 XML 注释**，把 `<!--modDependencies>` 当成了开标签 |
| `RK_Fire` 警告仍然存在 | **grep 匹配到了我自己补丁的名字**（出现在 mod 更新列表里） |
| 每个 mod 的 About.xml 都有非法元素 | 正则匹配了**所有层级**的元素，不是顶层 |

**五次的共同点：都差点让我去改一个本来没坏的东西。**

**坑 6 为什么单列**：前七条都能靠静态分析或读源码定位，**只有它不能**。
文件系统层面一切正常，`GetAllInFolder` 就是返回空。实测案例：一个 128×128 的三变体贴图集，
换 CE 的图仍失败、换目录换 mod 归属仍失败、**只把基本名从 `HEAT180AT97` 改成 `HEAT180` 就成功**。
修复不需要动原 mod：把图片复制进自己的补丁 mod、换名、用 `PatchOperationReplace` 改 `texPath`。

**坑 7 为什么单列**：它的症状是「**日志说成功，实际没生效**」，比其它几条都更容易误判。
三个子坑各自独立，且都是**实测**才发现——尤其 7b，写的时候完全看不出问题。

### 5d. 一条更省时的纪律：先做实验，再写补丁

用 .NET 的 `System.Xml`（PowerShell 里 `Add-Type -AssemblyName System.Xml` 即可）把目标文件复制一份，
跑一遍候选 XPath 看命中几个、再把 `<value>` 按运行时的方式写进去看结果长什么样。
坑 2、3、4、8 都是这样在几分钟内定位的，比反复「改文件 → 重启游戏 → 读日志」快一个数量级。

**坑 6 和 7 不适用**——它们只能实机测，所以更要严格单变量，并且**在前缀里放计数器**让日志自己说话。

**判断补丁能否生效，至少同时满足**：文件在 `Patches/` · XPath 只寻址补丁阶段存在的节点 ·
路径末步有落点（或元素整个放进 `<value>`）· **写入内容的结构与目标节点的结构一致** ·
字段在目标类里存在 · Harmony 签名不冲突 · 前缀不调用被 patch 的方法 · 贴图路径真的能解析 ·
注册时机早于目标行为。

**可复用的两个验证器**：

| 工具 | 做什么 |
|---|---|
| `tools/audit-patches.mjs` | 扫所有补丁：About.xml 字段、packageId 唯一性、依赖是否存在、补丁类是否合法、xpath 目标的 defName 是否真实存在 |
| `tools/probe-patch-file.ps1` | 把某个补丁对一个**副本**跑一遍，按游戏的方式替换节点，并报出裸文本 `<value>` 之类会被游戏拒绝的写法 |

`OPERATIONS.md` 第 6、7 节有这些坑的完整报错原文与最小示例。

---

## 6. 发出去之前建议做的裁剪

`*.mjs` 辅助脚本、`OPERATIONS.md`、`PORTING.md` 都不是运行时必需的。
若想给一个干净的最小包，只保留：

```
package.json  cordis.patch.yml  index.js  client.js  lib/  locale/  icon.svg  OPERATIONS.md
```

`package.json` 的 `files` 字段已经列了运行时需要的文件，可作为参考。

### 对方机器上的两处状态目录

| 路径 | 内容 | 改位置的环境变量 |
|---|---|---|
| `~/.dsh/rimworld-log/` | 增量分析游标（`<base64url 路径>.json`） | `DSH_RIMWORLD_LOG_STATE` |
| `~/.dsh/rimworld-log/patches/` | Agent 生成的补丁文件 | `DSH_RIMWORLD_PATCH_DIR` |

两处都只在 `~/.dsh` 下，不碰 RimCrow 也不碰 RimWorld。遇到「怎么只分析了新日志」用 `/rimlog --full`，
或直接删掉游标目录。

---

## 7. 已知限制（如实告知对方）

- **客户端 UI 未做视觉验证**：没有浏览器控制权，只做了语法与 manifest 校验。
  `/rimlog` 与工具链路不受影响；输入框下方那条的样式可能需要按主题微调。
- **不是所有问题簇都能归属到 mod**：堆栈只含引擎帧且编译期路径无线索时，会明确写「归属 mod: 未能确定」，
  不会编造。真实数据上约 13/40 个簇能定位。
- **`relatedModIds` 命中率有限**：RimCrow 只在部分记录上填写该字段。
- **`Player.log` 的 Token 效率天生更差**：纯文本无法去重，同样信息约贵 2–5 倍；有 RimCrow 时应优先用实时日志。
- **插件不写任何 RimCrow / RimWorld 文件**。启用 mod、改加载顺序、写入 mod 目录、编译 DLL 这些动作，
  即使在插件的能力范围内，也设计成每次单独向用户确认。
