# 历史版本更新（累积保留）

**这份文件是「所有版本改了什么」的唯一累积记录。** 新版本写最上面，旧版本不删。

`tools/build-package.py` 打包时会把本文件**全文**插进交付包的 `更新日志.md`，作为「三、历史版本更新」一节。
所以读者拿到任何一版的包，都能一路看回去。

---

## v1.6.10 — 开发中

**本节累积下一版的改动，发布前补写完整条目。**

- 当前为占位段：v1.6.9 已在两条轨道发布（公开轨 GitHub Release、交付包轨分享），
  工作版版本号前移，后续改动写在这里。

## v1.6.9 — 2026-10-26

**设置页从「内置插件」标签页改为左栏独立一页（Agent 预设正下方）。**

- `settings.plugins.tab`（内置插件页里的标签）→ `settings.section`（设置左栏独立页，
  order 21 = 紧跟 Agent 预设 order 20）。与「通用 / 模型 / Agent 预设 / 内置插件」平级。
- 读写通路、`whileServed` 守护、`setField`、错误提示与「重启 DSH 生效」的说明全部不变；
  面板组件原样作为整页内容渲染。
- 公开仓库准备：把插件里写死的个人绝对路径全部参数化（`lib/workspace-archive.js` 的工作区候选、
  8 个探针脚本的 `RIMWORLD_DIR` / `WORKSHOP_DIR` / `RIMCROW_HOME` / `CE_MOD_DIR` /
  `VISUAL_EXCEPTIONS_DLL`、`attribution-test.mjs` 的 fixture 路径）；新增
  `tools/build-public.py`（组装 GitHub 仓库：不含 node_modules、注入 README/LICENSE/.gitignore）。

## v1.6.8 — 2026-10-26

**设置页 UI 落地：设置 → 内置插件 → 「RimWorld 日志」标签页。**

- 查证结论（全部只读）：声明 `Config` 只给数据通路，**不会自动产生界面**——设置页的
  「内置插件」区块只渲染各插件客户端注册进 `settings.plugins.tab` 槽位的标签页
  （活的槽位树确认该槽位 children 为空，页面显示"本部署没有开放任何插件视图"）。
  内置插件的配置 UI 全部住在各自的 `dsh-client-ui-settings-*` companion 包里。
- `client.js` 新增设置标签页：inject `configForms` 服务 → `ctx.configForms.get('rimworld-log')`
  拿 Host 拥有的表单句柄（`{ value, status, writable, set(key, v) }`）→ `whileServed`
  守护下注册 `settings.plugins.tab`。表单直接读写行配置：**保存落 profile patch，
  Loader 对账后重新激活插件，无需重启**。7 个键各一行（文本/数字/下拉/多行文本），
  失焦即存、就地提示；空串 = 未设置（下落到 settings.json / 默认），与 config.js 语义对齐。
  遵守本客户端的既有约束：`configForms` 是注入的服务不是静态 import，不引任何
  Harness 客户端包。
- 顺带把两个"预留"键真正接线（界面上不能有无效旋钮）：`clusterLimit` 接入 analyze
  的 maxClusters 回退链；`defaultSource` 接入 analyze 缺省来源
  （优先级：调用参数 > 设置 > apply 行配置 defaultSources > realtime）。
- 实测踩坑 1：`ctx.effect(() => whileServed(...))` 的括号结构必须与内置 companion
  逐层一致（register)→inject)→whileServed)→effect)，共四层），多传一个 label 参数
  还少一个右括号，语法检查抓出来了。
- **实测踩坑 2（根因）：`Config` 的字段必须声明 volatile，否则设置页永远看不到**。
  `dsh-settings` 的 `describe()` 只把含 volatile 字段的插件放进设置文档
  （`volatileForm(schema)` 为 undefined 的条目被整个跳过），而 `whileServed` 等的是
  「命名空间出现在文档里」——所以标签页注册了也永不触发。`.volatile()` 是
  `@deepseek-ai/schemastery` fork 专有 API（公共 3.18.0 没有），但读取路径只认
  `schema.meta.volatile`，手动设等价：`const volatile = (s) => (s.meta = { ...s.meta, volatile: true }, s)`。
  兼容性已核：公共包与 fork 共用 `Symbol.for("schemastery")`，实例互相识别；
  `~standard.validate`（激活校验）与 `meta.volatile`（设置投影）两条路径都成立。
  另：`configForms` 服务在客户端运行时**确实存在**（cot-translation 的活例子在用），
  之前服务目录查不到它不代表不存在。
- **实测踩坑 3（写入）：`useForm` 返回的是快照，不是控制器**。面板最初在快照上调用
  `form.set(...)` 直接 `TypeError`，被 catch 成"保存失败"。内置 companion 的模式是：
  快照（`{status, writable, value}`）只用来读，写入走 face 里显式提供的函数
  （`setField: (k,v) => form.set(k,v)`）。修好后保存成功。
- **实测踩坑 4（生效时机）：配置写入不触发 host 半区的热重载**。保存后
  `cordis.patch.yml` 立刻有值（实测 16:14:51 落盘 `clusterLimit: 20`），但运行中的
  插件 fiber 仍是旧配置——`action=config` 一直显示 14，**重装/重启后才读到 20**。
  结论：保存 = 写盘成功；生效 = 下次激活（重启 DSH）。面板与 `action=config` 的
  提示文案都如实写明，不假装即时。保存成功后**保留输入值**（不再回落快照，避免
  "刚保存就跳回旧值"的误导）。
- 面板错误提示改为携带真实原因（RemoteError 的 message，如 settings/conflict /
  settings/rejected），不再只显示"保存失败"。

## v1.6.7 — 2026-10-26

**设置进了 DSH 原生配置面：`action=config` 之外，界面上也能改了。**

- `cordis.patch.yml` 的插件行带上 `config:`（7 键初值，路径类留空 = 保持探测/默认）。
  这就是 DSH 设置界面（设置 → RimWorld 日志分析）编辑的那个存储。
- `index.js` 导出 `export const Config`（7 键 + 两个 apply 层旧键的 JSON Schema，
  description 中文——编辑器按它渲染提示）；`apply(ctx, config)` 开头把行配置交给
  `config.js` 的 `setRowConfig()`。配置被编辑后 DSH 重新激活插件，新值随 apply 进来，
  不需要监听变更。
- `lib/config.js` 优先级变为四级：**环境变量 > 配置界面（行配置）> settings.json > 内置默认**。
  env 最高是 v1.6.6 的契约（部署层覆盖不被 UI 意外压掉）；行配置坐在文件层之上——
  同一语义（用户持久偏好），界面是新的入口。空串/null 的行值视为「未设置」继续下落。
- `action=config` 的来源表加第四种「配置界面」；修改提示改为指向设置页。
- `selftest-config.mjs` 加行配置层用例（row 生效 / env 仍赢 / 空串跳过 / 清 row 掉到文件层）。
- 查证记录：DSH 自带 `dsh-settings` 与 `dsh-config-editor` 包；Config.listConfigs 目录
  200 个条目里 `schema` 状态即声明了配置的插件。**待用户在设置页实际编辑验证**——
  agent 在 GUI 外，只能证明数据通路，不能证明渲染。

## v1.6.6 — 2026-10-26

**配置与部署侧三连：settings.json 持久层、About.xml 校验、部署辅助脚本。**

- 新增 `lib/config.js`：三级回退的设置持久层——**环境变量 > settings.json > 内置默认**。
  文件在 `~/.dsh/rimworld-log/settings.json`（`RIMLOG_STATE_DIR` 可改址），模式照抄
  `state.js`：坏文件一律降级为「全用默认」，绝不炸插件。七个键：`patchDir`、
  `workspaceDir`、`snapshotDir`、`ignoredSignatures`、`clusterLimit`、`defaultSource`、
  `language`（预留）。现有环境变量用法零破坏——env 永远赢。
  实测踩掉一个坑：spec 里 `default: null` 是 falsy，`get()` 的三元分支会跳过它返回
  `undefined`；默认值必须写成工厂 `() => null`。
- `rimworld_plugin_guide` 新增 `action=config`：打印当前生效设置及**每个值的来源**
  （环境变量 / settings.json / 内置默认）。这就是「设置界面」的对话式形态——
  比自绘面板更符合本插件的产品形态。
- **`ignoredSignatures` 自动接线**：`analyze` 的 `compact=true` 现在会自动合并
  settings.json 里的忽略清单与调用时传的 `ignore` 参数——PA's God Hands 那条故意的
  红字从此可以在文件里配一次、永远安静。
- `patchRoot()` 改走 config 层（`DSH_RIMWORLD_PATCH_DIR` 环境变量的语义不变）。
- 新增 `lib/aboutcheck.js` + `action=aboutcheck`：校验一个 About.xml——XML 结构
  （标签配对）、裸 `&` 扫描（加载时才报错的那类）、description 含子元素
  （XmlElement 会静默丢文字）、BOM / U+FFFD 乱码嗅探、基本字段提取。
  这套检查在 PATCHES.md 手工做过 5+ 次，现在一条命令。
- 新增 `_tools\deploy-fix.ps1`（工作区研究脚本，**不属于插件**——它写 mod 目录）：
  RimWorld 进程检测（在跑就拒绝，6 次「文件被占用」的教训）→ 备份旧 DLL 到
  `Assemblies\backup-<时间戳>\` → 拷贝 DLL/PDB/CS → 逐文件 SHA256 校验。
  支持 `-WhatIf` 与 `-Force`。红线不破：只对显式给出的两个目录做拷贝，不碰 ModsConfig。
- 新增 `tools/selftest-config.mjs`（三级回退 + 坏文件防御 + describeAll）与
  `tools/selftest-aboutcheck.mjs`（合法 / 裸 & / 子元素 / BOM / 乱码 / 缺文件六种）。
- `check-all` 自测步骤从 7 个变成 9 个。

## v1.6.5 — 2026-10-26

**审计侧两连：补丁部署审计 + 快照对账。**

- 新增 `action=patchaudit`：启用中的 `rimcrow.*` 修复 mod，工作区源码 ↔ 部署目录是否一致。
  按 **packageId** 建两边索引（目录名完全对不上，唯一可靠键）；同名 DLL 逐一哈希比对；
  源码 mtime vs 部署 DLL mtime 判「源码新」；输出七种状态（synced / sourceNewer / hashMismatch /
  noWorkspace / noDll / notEnabled / counts）。纯只读。
  实测：48 个启用补丁，39 同步、2 源码新、1 哈希不一致、6 无工作区副本——本会话里
  这套对比我手工做了 8+ 次，现在一条命令。
- `rimworld_workspace_archive` 新增 `action=verify`：快照与工作区逐文件对账。
  文件清单差异 + **全量**哈希核对（~1375 个文件约 1–2 秒）+ 策略性跳过目录的体积记账
  （bin / __pycache__ / node_modules 为什么不在快照里、合占多少）。
  参数 `date` 可核对指定日期的快照；缺省取最新。
  输出五节：概览 / 哈希核对 / 清单差异 / 跳过目录 / 一句结论。
- 新增 `lib/patchaudit.js`（补丁审计核心，~180 行）。
- `lib/workspace-archive.js` 新增 `verifySnapshot`（~130 行），复用 `snapshotSources`
  与 `walk`——两边的文件清单用**同一个过滤器**生成，对比才有意义。
- 新增 `tools/selftest-patchaudit.mjs`（6 种状态全覆盖 + 错误路径）。
  `tools/selftest-workspace-archive.mjs` 扩 5 个 verify 用例（一致/修改/新增/跳过目录/错误日期）。
- `check-all` 自测步骤从 6 个变成 7 个。

## v1.6.4 — 2026-10-26

**分析侧三连：紧凑视图、mod 变动探测、会话对比；自测进 check-all。**

- `analyze` 新增 `compact: true`：同一份分析结果换一种负载形状——每个问题簇一行
  （计数 + 签名 + 归属），没有堆栈、样本、inferredTypes。「引擎/未归属」桶把三种实测噪声
  （无归属、`confidence=low` 仅路径线索、`enabled=false` 不在启用列表）折叠成一个计数，
  `InvokeMessageMethod_Verse ×78` 这类引擎帧不再逐条刷屏。配 `ignore` 参数（子串匹配）
  可过滤已知噪音——PA's God Hands 那条故意的红字就是第一个用户。
- 新增 `action=mods-changed`：时间窗内哪些 mod 更新/新增/移除。目录 mtime 粗筛 +
  `About.xml` 的 `modVersion` 与基线比对（基线存 `~/.dsh/rimworld-log/mod-versions.json`，
  只在运行本动作时读写，detect 不背这个成本）。首次运行只建基线并说明，之后先比对后写回。
  `detect.js` 的 `readAbout` 顺带多读一个 `<modVersion>` 字段（加法，不影响现有调用方）。
- 新增 `action=diff`：本次 vs 上次会话的错误对比。两份日志各自**全量**聚类
  （`full: true` + `persist: false`，不推进增量游标），再按归一化签名做集合差——
  新增 / 消失 / 计数变化（默认 ±2 以上）。回答的是「重开后什么新出来了」，
  与字节级增量游标互补：游标对不上重开的文件，签名集合差不受影响。
- `grep` 新增 `context` 参数（0–3）：命中行前后带几条相邻日志行，渲染成同样的紧凑形式。
  相邻行只看位置不做 mod 过滤（命中已过滤过，上下文的职责是还原现场）；全局预算 300 行，
  不会把整份日志带出去。
- 新增 `lib/sig.js`：签名与归属的「消费侧」共享层。紧凑视图与 diff 都建在
  `analyze()` 已归一化的簇上，与详细报告**不可能**给出不同的签名或归属。
- `check-all` 新增第六项「自测」：跑全部 `selftest-*.mjs`（现有 6 个）。
  自测此前从不进检查链——`run-selftests.mjs` 是缺失的发布闸门。
- 开发中实测修掉两处：`Date.parse('6')` 会把纯数字当 2001 年解析（`parseSince`
  先做形态检查）；重写 `About/About.xml` 不会更新 mod 根目录的 mtime——
  这正是版本比对必须存在的原因（Steam 就地重写文件常常不动目录时间）。

## v1.6.3 — 2026-10-26

**CE 手册补上「载具」一节；顺带清掉登记表里 71 个失效块。**

- `COMBAT_EXTENDED.md` 新增 §9「载具（Vehicle Framework / VRF / CE 桥接）」，五条都按「症状 → 机制 → 查法」写：
  1. 载具 tick 顺序 —— `TickHandlers` 在 `TickExplosives` 前、`BaseTickOptimized` 在 `TickAllComps`/`AITick` 前，
     任何 tick 内异常都会跳过后面全部（"爆炸不结算 / 车不死"的第一嫌疑）
  2. 空投舱放人 —— 乘客在 `AllInventoryPawns` 里（`DisembarkAllFromInventory`）、驾驶/炮手被永久过滤、
     判舱用 `IsSiegeDropVehicle`、判落地用 `spawnedTick`；并点明"车里 pawn `Spawned == false`"这个坑
  3. CE 给 NPC 装弹药 —— `LoadWeaponWithRandAmmo` 里 ammoSet 权重全 0 会抛 `totalWeight=0`，该枪就没有备弹
  4. 载具耐久 NaN —— `-2147483648%` = `int.MinValue` = NaN；CE 用 `health / 50f` 当护甲导致自传播
  5. Harmony 陷阱 —— 抽象方法不能打补丁，要沿 `BaseType` 找 `DeclaredOnly` 且非抽象的实现
- 原 §9「相关手册」/ §10「维护约定」顺延为 §10 / §11（已确认全文无 §9/§10 交叉引用）
- 登记表清理：`bump-version` 扫出 71 个块仍指向 v1.6.1 之后已移入 `tools/dev/` 的旧路径，全部移除
- `块功能介绍.md`、`插件清单.md` 重新生成；`check-all` 五项全绿
## v1.6.2 — 2026-10-19

**两份面向读者的文档 + 打包硬检查。**

- 新增 `使用参考.md`：**能直接复制给 DSH 的一句话清单**（每天干什么、怎么问、别怎么问），
  按「一次动作一段话」组织；CE 一节覆盖判定 / 四类补法 / 重复检查
- 新增 `块功能介绍.md`：块是什么、能干什么、怎么用；**块数与文件分布由 `tools/gen-blocks-doc.py` 现算**，不会与登记表脱节
- `tools/check-all.mjs`：一条命令按依赖顺序跑完五项检查（块文档 → 清单 → 清单条目 → 块登记 → package.json）
- 打包硬检查：交付包固定 **6 份文档 + 5 个关键文件**，缺任何一份**不生成 zip**（退出码 2）
- `tools/write-plugin-manifest.py` 进入插件：`插件清单.md` 从此外可自证（`--check`）
- `COMBAT_EXTENDED.md` §7 新增「第 0 步：先确认要做的是哪几类」，把远程 / 近战 / 护甲 / 配方 / 幂等 / 改名失效六类摊开

## v1.6.1 — 2026-10-19

**工作区归档与交付流程都进了插件。**

- 新增 `rimworld_workspace_archive` 的 `action=note`：写一条归档记录到 `<工作区>/归档/`，重建 `INDEX.md`，并顺手拍当天快照
- 自动归档：分析日志后顺手记一条，**30 分钟一次**，时间戳落在 `install-state.json`（重载插件不重置）；`RIMLOG_AUTO_ARCHIVE=0` 关闭
- `action=export` 会校验输出目录名是否为 `migration-pack-YYYYMMDD-HHMMSS`，不合给 ⚠️ 提醒（不拒绝）
- `tools/build-package.py` + `RELEASE.md` 进入插件：**基线必须显式给**，跨版本时更新日志会标明「这是累计差异」
- `tools/write-plugin-manifest.py` 进入插件：`插件清单.md` 从此可自证（`--check` 校验是否过期）
- 开发脚本归位：根目录 6 个 `debug-*` / `diag` / `missing` 移入 `tools/dev/`
- 修掉三个静默失效：`sync-manifest` 只看 `tools/` 顶层（漏 6 文件）、清单「运行必需」漏 `plugins/` 三模块、
  打包 zip 步骤引用未定义变量 `home`（**此前从未成功产出过 zip**）
- 打包排除 `__pycache__` / `*.pyc`（跑过一次 Python 工具就会污染交付包）

## v1.6.0 — 2026-10-18

**归档成为插件的动作。**

- `rimworld_workspace_archive` 新增 `note`：把「为什么这么做」写成文件，而快照只能记录字节
- `INDEX.md` 从磁盘现有文件重扫生成，不在旧内容后追加
- 自动归档的节流时间戳改为落盘（第一版放模块级变量，插件重载即归零，三分钟连记三条）

## v1.3 – v1.5 — 无记录

**这三个版本没有留下更新记录。** 原因不是遗漏，而是机制：

`tools/bump-version.mjs` / `stamp-blocks.mjs` 是**就地重写**子版本号（`<base>.<author>.<NNN>`），
升级基准版本时旧值被覆盖，`blocks.json` 里只留下**当前**的归属与子版本号。
所以「1.2.0 到 1.6.0 之间改了什么」无法从登记表反推 —— 这也是 `RELEASE.md` 第五节专门写一段的原因。

**这一条本身也是记录**：从 v1.6.0 起，每版的改动都会先写进 `归档/`，再摘进本文件，不再依赖内存。

## v1.2.0 — 2026-10-12

**两处会改变分析结果的行为修正 + 两个新工具 + 44 个排查脚本。**

- **mod 归属不再给出「自信的错误答案」**：旧版把命名空间 token 撞上补丁 mod 的名字，于是补丁 mod 被报成
  无关警告的来源，真正的 mod 从未显示。新版改成三级匹配：精确 → 词边界 → 最短包含名。
- **「错误集中出现的 mod」不再把更新提示当错误**：旧版一条 `[ShowModUpdates]` INFO 记录就能把十几个无辜 mod
  列为错误来源。新版只统计 ERROR / WARNING 簇，且两个桶分开显示。
- 新增工具 `rimworld_plugin_guide`（插件自述，`action=usage` 从注册表实时生成）与
  `rimworld_plugin_compare`（按块比对另一份副本）
- 新增文档 `COMBAT_EXTENDED.md`（CE 兼容性参考，41 KB）
- `tools/` 从 28 个脚本增加到 72 个；交付包从 55 文件增至 101 文件

> 本段摘自 v1.2.0 交付包自带的 `更新日志.md`（原文 12.5 KB，含逐工具说明）；
> 需要细节可看那份包，这里是摘要。

## v1.0.0 — 2026-10-09

**首个交付版本。**

- 55 个文件：`rimworld_log_scan` 工具、`/rimlog` 与 `/rimmods` 命令、输入框下方的日志来源选择条
- 还没有 `更新日志.md`、没有 `COMBAT_EXTENDED.md`、没有块登记（`blocks.json`）

> 当时的包放在 `_archive/RimCrow日志分析插件/`，只有 `OPERATIONS.md` / `PORTING.md` / `安装说明.md` / `插件清单.md`
> 四份文档，没有更新日志。所以这条是**补记**，不是当时的原文。
