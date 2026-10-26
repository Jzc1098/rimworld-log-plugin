# NOTICE

本文件记录第三方声明、使用规则与授权通知。许可证正文见 [LICENSE](LICENSE)。

```
Required Notice: Copyright (c) 2026 Jzc1098 (https://github.com/Jzc1098/rimworld-log-plugin)
```

## 许可证

本仓库代码与文档采用 **PolyForm Noncommercial License 1.0.0**（非商业许可，全文见
[LICENSE](LICENSE)）。要点：

- 允许**任何非商业目的**的使用、修改与再分发（含个人研究、学习、兴趣项目、教学、公益组织等）
- **不允许商业用途**（出售、付费分发、作为付费服务的一部分、企业内部为营利而使用等）
- 再分发时必须附带本许可与上面的 `Required Notice` 行
- 无担保、无连带责任

这不是 OSI 定义的开源许可，而是 **source-available（源码可见）** 许可——你可以读、改、非商业地用，
但不能拿去卖。

## 使用规则（依 RimWorld EULA，适用每个使用者）

RimWorld 的 EULA 对「Mods（含工具、插件）」有硬性要求，使用本项目即同时受其约束：

| 规则 | 具体含义 |
|---|---|
| **必须免费** | 不得出售，不得任何形式的商业利用，不得因交付或使用而收费（除 Ludeon 事先书面同意） |
| **捐赠须无感** | 可以就"mod 制作这件事本身"接受捐赠，但不得与具体产品/服务交付挂钩，不得施压，**不得在工具内部出现捐赠请求** |
| **无广告** | 工具内不得含任何广告或行动号召（包括慈善、政治、非营利组织的推广） |
| **需正版游戏** | 只能在合法的 RimWorld 副本上配合使用，不得与游戏本体或官方资料片一起分发，不得作为"整合版" |
| **不得冒充官方** | 必须明确标注为社区作品，不得暗示由 Ludeon 制作或获其背书 |

原文（节选）：

> Your Mods must be distributed for free, period. Neither you, nor any other person or party, may
> sell them to anyone, commercially exploit them in any way, or charge anyone for receiving or using
> them without getting prior written consent from Ludeon.

## RimWorld / Ludeon Studios 声明（RimWorld EULA 要求）

> Portions of the materials used to create this content/mod are trademarks and/or
> copyrighted works of Ludeon Studios Inc. All rights reserved by Ludeon. This
> content/mod is not official and is not endorsed by Ludeon.

原文见 RimWorld EULA：https://rimworldgame.com/eula/

## 本仓库是什么，不是什么

- 一个**原创的免费** DSH（DeepSeek Harness）插件：代码与文档均为本项目编写。
  不售卖、插件内不含任何广告、不请求捐赠。
- **不包含** RimWorld 本体、任何资料片、任何游戏素材，也不包含任何第三方 mod 的
  代码或内容。文档里出现的 mod 名称仅作事实引用，未复制其内容。
- 需要**合法获得的 RimWorld 副本**才有意义；它不是"整合包"，也不随游戏一起分发。
- [RimCrow](https://github.com/rimcrow/RimCrow)（MIT）是另一位作者的独立项目：
  本插件只在机器上已存在 RimCrow 时读取它的日志，**不打包、不修改**它。

## 第三方依赖

| 依赖 | 许可证 | 用途 |
|---|---|---|
| `schemastery` | MIT | 插件 `Config` 的 schema（由用户 `pnpm install` 安装，不随仓库分发） |
| `@standard-schema/spec`、`cosmokit` | MIT | `schemastery` 的运行时依赖 |

## 图标与模板

`icon.svg` 与 `templates/` 下的示例文件均为本项目自绘/自写，不含第三方素材。

## 贡献

提交 Pull Request 或补丁，即表示你同意该贡献按本项目的 PolyForm Noncommercial 1.0.0 许可分发。
