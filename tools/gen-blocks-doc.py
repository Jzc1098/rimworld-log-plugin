"""生成 块功能介绍.md：数字与表格从 blocks.json 现算，避免手抄过期。

用法: python gen-blocks-doc.py [--check]
  --check  只比较，不写文件（内容一致则退出码 0）
"""
import io
import json
import os
import sys

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOCKS = os.path.join(PLUGIN, "blocks.json")
OUT = os.path.join(PLUGIN, "块功能介绍.md")

AREA_HINT = [
    ("index.js", "插件主体：工具注册、命令、扫描流程"),
    ("lib/", "探测 / 解析 / 归属 / 报告 / Player.log / mod 配置"),
    ("plugins/", "注册表、安装状态、功能报告"),
    ("tools/", "一次性调查脚本，按用途分五类"),
    ("cost/", ""),
]


def area_of(path):
    if path.startswith("lib/"):
        return "`lib/`（6 个模块）"
    if path.startswith("plugins/"):
        return "`plugins/`（3 个模块）"
    if path.startswith("tools/dev/"):
        return "`tools/dev/`（6 个开发脚本）"
    if path.startswith("tools/"):
        return "`tools/`（其余脚本）"
    if path.endswith(".md"):
        return "文档（12 份）"
    return "根目录其它文件"


def build():
    with io.open(BLOCKS, encoding="utf-8") as handle:
        data = json.load(handle)
    blocks = data.get("blocks") or data
    # blocks.json 可能是 {id: entry}，也可能是 [{id: ..., version: ...}]，两种都要认。
    if isinstance(blocks, dict):
        items = list(blocks.items())
    else:
        items = [(b.get("id"), b) for b in blocks]
    ids = [key for key, _ in items]

    by_file = {}
    by_type = {}
    versioned = 0
    unversioned = 0
    for key in ids:
        if not key or ":" not in key:
            continue
        parts = key.split(":")
        path, kind = parts[0], parts[1] if len(parts) > 1 else "?"
        by_file[path] = by_file.get(path, 0) + 1
        by_type[kind] = by_type.get(kind, 0) + 1
        entry = next((value for k, value in items if k == key), None)
        ver = (entry or {}).get("version") if isinstance(entry, dict) else None
        if ver:
            versioned += 1
        else:
            unversioned += 1

    total = sum(by_file.values())
    files = len(by_file)

    # 区域汇总
    area_rows = {}
    for path, count in by_file.items():
        area_rows[area_of(path)] = area_rows.get(area_of(path), 0) + count

    # 指向不存在文件的块
    stale = sorted(p for p in by_file if not os.path.exists(os.path.join(PLUGIN, p)))
    stale_blocks = sum(by_file[p] for p in stale)

    kind_order = sorted(by_type.items(), key=lambda kv: -kv[1])

    lines = []
    add = lines.append
    add("# 块功能介绍")
    add("")
    add("**这份文档讲清一件事：插件把代码和文档切成「块」来管理 —— 块是什么、能干什么、怎么用。**")
    add("")
    add("不涉及具体实现。想动手改东西，看 `OPERATIONS.md`；想按块导入别人的改动，看 `MIGRATION.md`。")
    add("")
    add("> 本文的数字与表格由 `tools/gen-blocks-doc.py` 从 `blocks.json` 现算，**不是手抄的**。")
    add("> 改了代码之后重跑一次即可，不会出现「文档说 900 块、实际 1259 块」这种脱节。")
    add("")
    add("---")
    add("")
    add("## 一、块是什么")
    add("")
    add("**一个块 = 一个函数、一个类、一个文档章节，或一段独立配置。**")
    add("")
    add("块的名字是三段式，用冒号隔开：")
    add("")
    add("```")
    add("文件路径 : 块类型 : 块名")
    add("lib/parse.js:function:attributeCluster")
    add("OPERATIONS.md:h2:四、静默失败的排查顺序")
    add("```")
    add("")
    add("**为什么不用文件做单位**：文件里改一行，整份文件的哈希就变了 —— 只能告诉你「这个文件变了」，")
    add("说不出「变了哪一处、是谁改的」。块的作用就是把粒度降到能回答这两个问题。")
    add("")
    add("---")
    add("")
    add("## 二、块能干什么")
    add("")
    add("| 用途 | 一句话 | 用什么 |")
    add("|---|---|---|")
    add("| 按块比对 | 「别人那版比我多了哪些块」 | `rimworld_plugin_compare` / `tools/compare-plugin.mjs` |")
    add("| 按块导入 | 只要别人某一个函数，不用整包替换 | `tools/import-blocks.mjs` |")
    add("| 署名追踪 | 每个块记着谁写的、什么时候、第几版 | `blocks.json` + `tools/stamp-blocks.mjs` |")
    add("")
    add("三条的共同点：**换位置、改缩进、重排顺序都不会被当成改动** —— 比对单位是块，不是行。")
    add("")
    add("---")
    add("")
    add("## 三、一眼看全貌")
    add("")
    add("| 指标 | 数值 |")
    add("|---|---|")
    add("| 块总数 | **{:,}** |".format(total))
    add("| 涉及文件 | **{:,}** 个 |".format(files))
    add("| 有版本号的块 | {:,} |".format(versioned))
    add("| 无版本号的块 | {:,}（早于登记表引入，属正常） |".format(unversioned))
    add("")
    add("按类型（前三类占了大多数）：")
    add("")
    add("| 类型 | 数量 | 是什么 |")
    add("|---|---|---|")
    kind_hint = {
        "const": "常量声明",
        "function": "函数 / 方法",
        "h1": "一级标题（文档）",
        "h2": "二级标题（文档）",
        "h3": "三级标题（文档）",
        "h4": "四级标题（文档）",
        "head": "Python 函数 / 脚本头",
        "let": "局部变量声明",
        "def": "Python 函数定义",
        "class": "类",
        "ps1": "PowerShell 函数",
        "json": "JSON 顶层键",
        "svg": "SVG 图元",
        "yml": "YAML 段",
    }
    for kind, count in kind_order[:8]:
        add("| `{}` | {:,} | {} |".format(kind, count, kind_hint.get(kind, "—")))
    add("")
    add("---")
    add("")
    add("## 四、按区域认识块群")
    add("")
    add("| 区域 | 块数 | 里面是什么 |")
    add("|---|---|---|")
    area_desc = {
        "`lib/`（6 个模块）": "定位 RimCrow / 解析日志 / 判断归属 / 渲染报告 / Player.log / mod 配置",
        "`plugins/`（3 个模块）": "工具注册表、安装状态、功能报告",
        "`tools/`（其余脚本）": "一次性调查脚本：审计、定位、归属可视化、程序集检查、数据分析",
        "`tools/dev/`（6 个开发脚本）": "开发期调试用：聚类调试、日志条目打印、环境诊断",
        "文档（12 份）": "章节级块；改一段话也会被记为一次改动",
        "根目录其它文件": "`index.js` / `client.js` / 配置与图标",
    }
    for area, count in sorted(area_rows.items(), key=lambda kv: -kv[1]):
        add("| {} | {:,} | {} |".format(area, count, area_desc.get(area, "—")))
    add("")
    add("> 完整到文件的分布见文末附录。")
    add("")
    add("---")
    add("")
    add("## 五、版本号怎么读")
    add("")
    add("```")
    add("1.6.1.Jzc1098.330")
    add(" └─┬─┘ └─┬──┘ └┬┘")
    add(" 基础版本 作者代号 递增序号")
    add("```")
    add("")
    add("- **基础版本**来自 `package.json`；升版本时全部块的基础版本一起变")
    add("- **作者代号**是 `--author` 自动生成的稳定短码，中文名也行")
    add("- **递增序号**只增不减，用来判断「这块后来有没有人动过」")
    add("")
    add("**版本号只是记录，从不参与比较。** 它不会告诉你哪份更新 —— 两份副本可以有相同版本号但内容不同。")
    add("")
    add("改过别人的函数时，登记表**同时记两个**：原作者不变，另记「最后修改者是你」。导入不会顶掉原作者。")
    add("")
    add("---")
    add("")
    add("## 六、怎么用（三个实操场景）")
    add("")
    add("### 1. 别人那版有什么我没有")
    add("")
    add("```")
    add("node tools/compare-plugin.mjs --other <别人的插件目录>")
    add("```")
    add("")
    add("报告分节：汇总 / A 有 B 没有 / 两边都有但不同 / 疑似同功能 / **按导入安全性排序的可学清单** / 依赖待查。")
    add("")
    add("### 2. 我只想要他那一个函数")
    add("")
    add("```")
    add("node tools/import-blocks.mjs <别人的目录> --blocks \"lib/parse.js:function:xxx\"")
    add("```")
    add("")
    add("默认**只生成暂存目录，不写入你的插件**；看完确认了才落盘，署名原样保留。")
    add("")
    add("### 3. 这块是谁写的")
    add("")
    add("```")
    add("node -e \"const b=require('./blocks.json');console.log((b.blocks||b)['lib/parse.js:function:attributeCluster'])\"")
    add("```")
    add("")
    add("或在 DSH 里问一句「`rimworld_plugin_guide` 报一下块清单」。")
    add("")
    add("---")
    add("")
    add("## 七、块的边界（如实说明）")
    add("")
    add("| 现象 | 真相 |")
    add("|---|---|")
    add("| 块数变多/变少 | **不等于功能变多/变少** —— 重排、加注释、改文档标题都会改块数 |")
    add("| 某个块突然消失 | 多半是**重切分改名**：函数拆成两个，旧块没了、新块出现 |")
    add("| 出现了陌生块 | 可能是别人导入的，也可能是你自己刚写但还没盖章 |")
    add("| 块指向的文件不在了 | **孤儿块**，见下一节 |")
    add("")
    add("---")
    add("")
    add("## 八、登记表的卫生")
    add("")
    add("**什么时候盖章**：改完东西、发版之前。先 `--dry-run` 看一眼它会动哪些块，再真正执行。")
    add("")
    add("```")
    add("node tools/stamp-blocks.mjs --dry-run     # 只看，不写")
    add("node tools/stamp-blocks.mjs               # 写 blocks.json")
    add("```")
    add("")
    add("### 孤儿块（已知现状）")
    add("")
    add("文件删了或移走了，它的块会**留在登记表里**。当前实测：")
    add("")
    add("| 指标 | 数值 |")
    add("|---|---|")
    add("| 来源已不存在的块 | **{:,}** |".format(stale_blocks))
    add("| 涉及的文件 | {:,} 个 |".format(len(stale)))
    add("")
    for path in stale[:10]:
        add("- `{}` —— {} 块".format(path, by_file[path]))
    if len(stale) > 10:
        add("- …还有 {} 个文件".format(len(stale) - 10))
    add("")
    add("**为什么不自动清**：清掉就找不回来了（对照旧版本时还有用）。清理是 `tools/bump-version.mjs` 的工作，")
    add("或者你确认不需要后手工删。**知道它们存在**比让它们悄悄堆着要好。")
    add("")
    add("---")
    add("")
    add("## 九、一页速查")
    add("")
    add("```")
    add("node tools/stamp-blocks.mjs --dry-run             # 我改了哪些块（不写盘）")
    add("node tools/stamp-blocks.mjs --author \"你的名字\"     # 盖章并署名")
    add("node tools/compare-plugin.mjs --other <目录>       # 按块比对另一份副本")
    add("node tools/import-blocks.mjs <目录> --blocks \"…\"    # 只导入某一块")
    add("node tools/selftest-blocks.mjs                    # 块机制自测")
    add("python tools/gen-blocks-doc.py                    # 重新生成本文")
    add("```")
    add("")
    add("---")
    add("")
    add("## 附录：每个文件的块数")
    add("")
    add("按块数从多到少。共 {:,} 个文件、{:,} 个块。".format(files, total))
    add("")
    add("| 文件 | 块数 |")
    add("|---|---:|")
    for path, count in sorted(by_file.items(), key=lambda kv: (-kv[1], kv[0])):
        add("| `{}` | {:,} |".format(path, count))
    add("")
    return "\n".join(lines) + "\n"


def main():
    text = build()
    check = "--check" in sys.argv
    current = ""
    # 工具清单：追加在 text 定稿之后、--check 比较之前。
    try:
        import lib_tools
        _tools = lib_tools.read_tools(os.path.join(os.path.dirname(os.path.abspath(OUT)), "index.js"))
        if _tools:
            _tl = ["", "## 十、工具清单（{} 个）".format(len(_tools)), ""]
            _tl.append("> 本节由 `tools/lib_tools.py` 按 `index.js` 的注册生成，用途来自 `tools/tools.json`。")
            _tl.append("")
            _tl.append("| 工具 | 一句话用途 |")
            _tl.append("|---|---|")
            for _x in _tools:
                _tl.append("| `{}` | {} |".format(_x["name"], _x["purpose"].replace("|", "\\|")))
            text = text.rstrip("\n") + "\n" + "\n".join(_tl) + "\n"
    except Exception as _exc:
        print("  [warn] 工具清单没生成: " + str(_exc))

    if os.path.exists(OUT):
        current = io.open(OUT, encoding="utf-8").read()
    if check:
        if current == text:
            print("块功能介绍.md is up to date")
            return 0
        print("块功能介绍.md NEEDS REGENERATION")
        return 1
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(text)
    print("wrote " + OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
