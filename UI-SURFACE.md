# 插件的对外表面：一条栏，一份空壳

**记录于 2026-10-12。** 写这份文件是因为两样东西容易让人判断错：**一条挂着的界面栏**（容易被误判成没挂），和**一份从未被读取的 locale 目录**（容易被误判成在用）。

**判断它们是否工作的唯一办法是查运行时状态。** 这份文件里的结论都是这么得出来的 —— 其中第一条我一开始还查错了。

---

## 一、`client.js` — 输入框上方那条「RimWorld 日志」栏

### 状态：**已挂载，工作中**

```
┌──────────────────────────────────────────────────────────┐
│ RimWorld 日志   一键分析：输入 /rimlog 回车   [选择来源]   │
└──────────────────────────────────────────────────────────┘
```

**运行时证据**（`cordis_inspect_query`，platform `client`，provider `Slots`，**`root: conversation.composer.dock`**）：

```json
"selected": {
  "name": "conversation.composer.dock",
  "kind": "list",
  "declaredBy": "an entry in \"conversation.composer.bar\" (mf)",
  "occupants": [
    { "registrant": "mf", "id": "stats",            "order": 0,  "priority": 0, "active": true },
    { "registrant": "mf", "id": "rimworld-log-bar", "order": 60, "priority": 0, "active": true }
  ]
}
```

**用户也确认它一直都在。** 两条独立证据一致，结论是明确的。

### 它做什么，不做什么

**做**：显示四个日志来源（实时 / 上一轮 / RimWorld 原生 / 上次运行）及各自的 Token 成本与适用场景，勾选后**拼出一行命令文字**，例如 `/rimlog realtime player`。

**不做**：**不执行任何操作。** 不调工具、不跑分析、点击不会自动执行 —— 用户需要自己输入那行命令。

源码注释写明了这个设计（`client.js` 第 9-11 行）：

> *The browser half deliberately performs no host calls: every operation is owned by the Host, and
> `references/user-actions.md` in the official plugin skill states that an operation must be implemented
> once, on the Host. This bar routes the user to it.*

### ⚠️ 我一开始把它的状态查错了 —— 这个教训值得留着

**我最初报告的是「没挂上」，依据是：**

1. 树的 `children` 是 `[]`
2. 在查询结果里搜 `rimworld-log-bar`，**出现 0 次**

**两点都是误读。**

| 我看到的 | 我推断的 | 实际 |
|---|---|---|
| `children: []` | 没有任何注册 | **拓扑视图不列注册项。** 注册项在 `occupants` 里，而**不带 `root` 参数的查询根本不返回 `occupants`** |
| 搜不到 `rimworld-log-bar` | 它没注册 | 我搜的是**那次查询的输出**，而那次查询**压根没包含注册数据** |

**根本错误：我把「这个视图里没有」当成了「不存在」。**

**正确做法**：查某个槽位的注册情况，必须**把它作为 `root` 查**，然后读 `occupants`。

> **一个查询没返回某个字段，不等于那个字段是空的。** 先确认「这个视图**应该**包含什么」，再据它下结论。

---

## 二、`locale/` — 从未被读取的两份文案（这一条是确凿的）

`locale/zh.json` 与 `locale/en.json`，各含一个 `meta` 键（`title` / `description`）。

### 实测状态：**没有任何消费者**

| 检查 | 结果 |
|---|---|
| `index.js` 引用 | **零** |
| `client.js` 引用 | **零** |
| `client.js` 的界面文案从哪来 | **全部硬编码在代码里**（`'RimCrow 实时日志'`、`'RimWorld 日志'` 等）|
| 本机其他 DSH 插件有 `locale/` 吗 | **没有** |
| `lib/detect.js` 里的「locale」 | 是 `a.name.localeCompare(b.name)` —— **误报，与目录无关** |

**这次的证据形式和第一条不同**：不是「某个视图里没看到」，而是**全仓库引用搜索 + 逐字读 `client.js` 确认文案是硬编码**。第一种会误判，第二种不会。

### 文档曾声称它能用

`MIGRATION.md` 与 `tools/import-blocks.mjs` 为它写了规则：`import-blocks.mjs --tier locale`，以及 `--apply-safe` 会写入 `locale/*.json`。

**这些规则本身没错** —— 「整文件新增的 locale 文件」是一条通用的安全分档，迁入**别人做的**插件时也有用。

**但 `MIGRATION.md` 已加注说明**：跑 `--tier locale` 对本插件会得到空选择，那是正常的。

**`package.json` 的 `exports` 里的 `./locale/*.json` 已移除**（它没有任何下游）。`files` 里的 `locale/*.json` 保留，因为目录还在。

---

## 三、这两样的共同点

**都是早期凭想象加的「一个插件看起来该有的东西」。**

`client.js` 是「插件应该有个界面入口」—— 这个**做出来了并且在跑**；`locale/` 是「插件应该支持多语言」—— 这个**只是个空壳**。

**而两者都用同一句话描述过：「未接线」。第一个是错的，第二个是对的。** 这正是为什么每一条都要有自己独立的运行时证据，不能靠类比。
