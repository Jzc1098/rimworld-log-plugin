# 迁移与合并指南

**给拿到这个插件、并且想把它跟别人改过的版本合并的人。**

---

## 一、为什么需要这套东西

这个插件会被多个人改。改完之后，两份副本的差别往往不是「谁多了几行」——而是：

- 一方加了一个工具，另一方加了另一个
- 同一个函数两边都动了，但动的地方不同
- 一份用换行和缩进重排过，**逐行比对会报出满屏改动，而内容其实一样**

**逐行 diff 应付不了这些。所以比对按「块」进行** —— 一个函数、一个类、一个文档章节各算一块。块按**名字**对齐，所以：

| 情况 | 逐行 diff | 按块比对 |
|---|---|---|
| 函数在文件里换了位置 | 报为一大片改动 | **认出是同一个函数** |
| 整个文件重排缩进 | 报为整文件改动 | **内容归一化后判定未变** |
| 一个函数改了 3 行 | 报为一个混合的 hunk | **报为「这一个块改了」** |
| 函数被改名 | 报为「删一个 + 加一个」 | 可用 `aliases` 认出来 |

---

## 二、四个命令

### 2.1 登记块（改完代码后跑）

```bash
node tools/stamp-blocks.mjs
```

给每个新增或改动的块记上**作者、日期、子版本号**。

| 选项 | 作用 |
|---|---|
| `--dry-run` | 只显示会改什么，不写文件 |
| `--adopt` | 给「早于登记表」的块补上你的署名 |
| `--author <名字>` | 本次用这个名字（覆盖下面第三节的自动解析） |

### 2.2 比对（回答「别人那版有什么我没有」）

```bash
node tools/compare-plugin.mjs <对方的插件目录>
```

出一份 Markdown 报告，写到 `_work/compare-<时间>/REPORT.md`。

| 选项 | 作用 |
|---|---|
| `--mine <目录>` | 指定本地那份（默认就是本插件） |
| `--json` | 额外写 `REPORT.json`，便于脚本处理 |
| `--show-weak-signals` | 连「名字相似 / 内容相近」的弱信号一起报（误报率高） |
| `--quiet` | 只打印摘要 |

**报告不判断哪一份更新。** 版本号、文件数、字节数、日期都会列出来，但都只是各方对自己的声明。

### 2.3 选择性导入

```bash
node tools/import-blocks.mjs <对方目录> --blocks <块 id>[,<块 id>...]
node tools/import-blocks.mjs <对方目录> --files <相对路径>[,<相对路径>...]
node tools/import-blocks.mjs <对方目录> --tier docs|locale|new-tools
```

| 选项 | 作用 |
|---|---|
| **（默认）** | **只生成 staging 目录，不写入插件本体** |
| `--apply-safe` | 额外写入**整文件新增**的文档与 `locale/*.json`（不碰已存在的文件） |
| `--apply --yes` | 写入全部选中项（**必须两个一起用**） |

**关于 `--tier locale`**：这是一条**通用的安全分档**（「整文件新增的 locale 文件」是干净的，因为不覆盖任何东西），**不是因为这个插件在用 locale**。

本插件自己的 `locale/zh.json` 与 `locale/en.json` **没有任何消费者** —— `index.js`、`client.js` 都不读它们，界面文案是硬编码在 `client.js` 里的。详见 `UI-SURFACE.md`。

**所以对这个插件跑 `--tier locale` 会得到空选择，那是正常的。** 保留这个分档是为了迁入**别人做的**插件时也能用同一条规则。

**块 id 从比对报告的第五节复制**，形如 `tools/foo.mjs:function:readDefs`。

---

## 三、作者名从哪来

按优先级，**每次运行都会打印用了哪一个**：

| 顺序 | 来源 |
|---|---|
| 1 | `--author <名字>` |
| 2 | 环境变量 `RIMLOG_AUTHOR` |
| 3 | `git config user.name` |
| 4 | 操作系统用户名 |
| 5 | `unknown` |

**推荐显式设一次**，免得它悄悄用你的系统用户名：

```bash
# Windows PowerShell，当前会话
$env:RIMLOG_AUTHOR = "你的名字"
# 永久（用户级）
[Environment]::SetEnvironmentVariable('RIMLOG_AUTHOR','你的名字','User')
```

日期默认当天；补记历史块用 `RIMLOG_DATE=2026-10-01`。

---

## 四、子版本号

```
1.1.0.lin.003
 ↑     ↑   ↑
 |     |   └ 该作者的流水号（存在 blocks.json，自动递增）
 |     └───── 作者 id
 └─────────── 撰写时 package.json 里声明的版本
```

**它与插件版本不冲突**：插件版本永远三段（`1.1.0`），块版本永远五段。

**第一段只表示「针对哪个声明版本写的」，不参与任何判断。**

---

## 五、`blocks.json` 的 schema

```jsonc
{
  "schema": "rimworld-log.blocks",
  "schemaVersion": 1,
  "pluginVersion": "1.1.0",          // 仅记录
  "authors": {
    "lin": { "display": "lin", "firstSeen": "2026-10-12", "counter": 7 }
  },
  "blocks": [
    {
      "id": "tools/foo.mjs:function:readDefs",   // 路径:类型:名字
      "file": "tools/foo.mjs",
      "kind": "function",
      "name": "readDefs",
      "hash": "sha256:9f2c…",        // 归一化内容的哈希
      "author": "lin",               // 首次署名；null 表示早于登记表
      "version": "1.1.0.lin.003",
      "date": "2026-10-12",
      "modifiedBy": "wang",          // 之后被谁改过（可缺）
      "modifiedVersion": "1.2.0.wang.001",
      "modifiedDate": "2026-10-20",
      "modifiedCount": 2,
      "baseline": true,              // 早于登记表，作者未知
      "aliases": [],                 // 可选：历史名字，改名后仍能对齐
      "supersedes": [],              // 可选：本块取代了哪些块
      "variantOf": null,             // 可选：本块是某个块的变体（允许共存）
      "conflictsWith": []            // 可选：明确不能与哪些块共存
    }
  ]
}
```

### 四个关系字段（可选，但有用）

| 字段 | 工具怎么用 |
|---|---|
| `aliases` | 块改名后仍能对齐，不报为「新增 + 删除」 |
| `supersedes` | 本块出现时，被取代的块列入「建议移除」 |
| `variantOf` | 允许共存，报为「互补」而不是「重复」 |
| `conflictsWith` | 导入时报硬错误，不让你踩 |

**不写这些字段 → 工具退回启发式，并标注「未声明关系，以下为猜测」。**

---

## 六、合并的正确流程

```
1. node tools/compare-plugin.mjs <对方目录>
2. 读报告的「一、汇总」和「七、疑似同功能」
3. 读「八、可学清单」—— 它按导入安全性排好了四档
4. node tools/import-blocks.mjs <对方目录> --blocks <挑出来的 id>
5. 看 staging 目录里的文件，确认改动符合预期
6. 确认后落盘（--apply-safe 或 --apply --yes，或手动复制）
7. node tools/stamp-blocks.mjs        ← 让登记表记下这次导入
8. 重启 DSH                            ← 模块缓存键是「包」，热替换无效
```

**第 7、8 步不能跳。** 不跑 `stamp-blocks` 的话，导入的块会在下次比对里被当成「你新写的」；不重启 DSH 的话，改动一行都不会生效。

---

## 七、不要做什么

| 不要 | 为什么 |
|---|---|
| **手改 `blocks.json` 里的 `hash`** | 哈希是内容的事实记录。改了它，工具就无法再判断块是否变过 |
| **一次合并超过 5 个块** | 出错时无法定位。小块合并、逐次验证 |
| **跳过依赖待查那一节** | 该节是启发式检查，会误报，但**漏看的代价是运行时报错** |
| **用版本号判断该合并哪一边** | 版本号是声明，不是事实。看内容 |
| **两个「疑似同功能」的块都要** | 多数情况会留下永不执行的死代码。除非你确认它们做的是不同的事 |
| **在游戏或 DSH 运行时硬替换插件文件** | 模块已缓存，改动不生效，还可能读到半写状态的文件 |
| **把 `diag-brief.md` 之类的生成物提交进登记表** | 它是 `tools/dev/diag.mjs --brief` 的产物，每次跑都不一样 |

---

## 八、遇到冲突怎么办

**冲突 = 同一个块两边都改了。** 比对报告会把它列在「四、两边都有但内容不同的块」。

```
1. 在报告里展开那个块的逐块内容（<details> 里）
2. 判断哪一边更完整 —— 不是哪一边更「新」
3. 三种处置：
   a. 保留本地（不导入）
   b. 用对方替换（--blocks <该块 id>）
   c. 手工合成 —— 把两边的改动都并进一个块
4. 合成时优先选 c：两份改动往往是互补的
5. 合成后跑 node tools/stamp-blocks.mjs，并在 note 里写清来源
```

**第 3c 步没有工具支持，是刻意的** —— 自动合并两个都改过的块会产出「能跑但语义错」的代码，比合并失败更难发现。

---

## 九、这个框架怎么搬给别人用

1. 把 `tools/lib-blocks.mjs`、`stamp-blocks.mjs`、`compare-plugin.mjs`、`import-blocks.mjs`、`selftest-blocks.mjs` 复制过去。
2. 跑一次 `node tools/stamp-blocks.mjs` 生成 `blocks.json` —— **首次会把现有块全部记为「作者未知」，这是对的，不要伪造**。
3. 之后每次改完代码跑一次 `stamp-blocks`。
4. 把本文件的第三节（作者名怎么设）告诉协作者。

**这些脚本不依赖 DSH，只依赖 Node 18+。**

---

## 十、自检

```bash
node tools/selftest-blocks.mjs    # 块切分器的回归测试
node tools/selftest-plugin.mjs    # 插件能否加载、注册的契约是否正确
node tools/selftest-workspace-archive.mjs   # 快照保留与迁移包语义（按天 3 份、只带最新）
node tools/stamp-blocks.mjs --dry-run   # 登记表是否与磁盘一致
```

**四个都通过再算改完。**
