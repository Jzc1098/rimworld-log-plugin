"""Regenerate 插件清单.md from the plugin directory as it actually is.

The hand-written manifest went stale: it describes a 55-file package with four Chinese documents,
while the directory now holds 67 shipped files, six documents, and a COMBAT_EXTENDED.md reference
that did not exist when it was written. Generating it from the filesystem keeps it true.

The classification mirrors what OPERATIONS.md already documents, so the two stay consistent:
  - runtime      : needed for the plugin to work at all
  - documentation: prose, deletable without breaking anything
  - test         : asserts behaviour, run by hand
  - tool         : one-shot investigation scripts under tools/

This script lives in the plugin's own `tools/` directory, and it is excluded from its own tool count.
Without that, regenerating the manifest changes the manifest, so the next run counts one more tool and the
documented number oscillates between two values depending on how many times it has been run.

Read-only against the plugin; writes only 插件清单.md.

Usage:
  python tools/write-plugin-manifest.py [--check]
"""

import json
import os
import sys

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(PLUGIN, "插件清单.md")

RUNTIME = {
    "package.json", "cordis.patch.yml", "index.js", "client.js", "icon.svg",
}
RUNTIME_DIRS = ("lib", "locale", "plugins")

# This script's own filename once installed under the plugin's tools/ directory.
SELF_NAME = "write-plugin-manifest.py"

DOCS = {
    "安装说明.md": ("使用者", "怎么装、怎么用、怎么排错、怎么卸载"),
    "插件清单.md": ("使用者", "本文件：每个文件干什么、哪些能删"),
    "OPERATIONS.md": ("维护者", "深度运维手册：补丁写法的坑、验证纪律、工具用法"),
    "PORTING.md": ("移植者", "把这套东西搬到别的 RimCrow 环境时的注意事项"),
    "MIGRATION.md": ("协作者", "块登记、按块比对与选择性导入的完整流程"),
    "SOLVED-block-split.md": ("维护者", "一次块切分缺陷的复盘：三个排查方法上的错误"),
    "COMBAT_EXTENDED.md": ("参考", "Combat Extended 的兼容性参考"),
    "RELEASE.md": ("维护者", "怎么打包、基线规则、每次发版必须手写的五处、验收清单"),
    "CONTRIBUTING.md": ("协作者", "三条命令：署名、自测、打包发出去"),
    "HISTORY.md": ("使用者", "所有历史版本改了什么（累积，新版本在最上面）"),
    "使用参考.md": ("使用者", "能直接复制给 DSH 的一句话清单：每天干什么、怎么问、别怎么问"),
    "块功能介绍.md": ("协作者", "块是什么、能干什么、怎么用（数字由 gen-blocks-doc.py 现算）"),
    "UI-SURFACE.md": ("维护者", "网页侧界面的结构、槽位与交互约定"),
}

# Files that are neither code, documentation nor a tool, but do belong to the plugin.
DATA_FILES = {
    "blocks.json": "块登记表：每个块的作者、日期与子版本号",
    "diag-brief.md": "diag.mjs --brief 的产物，可随时删（下次运行会重建）",
}

# Tests and probes that live at the plugin root and are run with `node <name>`.
ROOT_SCRIPTS = {
    "selftest.mjs": "11 项：探测 / 解析 / 聚类 / 归属 / 增量 / 原版回落",
    "attribution-test.mjs": "归属逻辑的单元测试（装配名 / 文件夹名 / packageId 三套索引）",
    "fallback-test.mjs": "无 RimCrow 时改用 Player.log",
    "modconfig-test.mjs": "17 项：XML 往返、计划、dry-run、真实写入、备份、回读校验、mtime 守卫、幂等",
    "mock-host.mjs": "模拟宿主注册，装机前先验证",
    "diag.mjs": "打印探测结果、聚类与归属过程；--brief 写 diag-brief.md",
    "missing.mjs": "列出启用了但在磁盘上找不到的 mod",
    "debug-attrib.mjs": "排查某个簇为什么被归到某个 mod",
    "debug-entries.mjs": "打印匹配某模式的完整日志条目（含未截断的堆栈）",
    "debug-json.mjs": "复现「工具返回非法 JSON」那类问题",
    "debug-playerlog.mjs": "查看 Player.log 的解析结果",
}


def walk_files(root):
    result = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for name in filenames:
            full = os.path.join(dirpath, name)
            result.append((os.path.relpath(full, root).replace("\\", "/"),
                           os.path.getsize(full)))
    return sorted(result)


def main():
    check_only = "--check" in sys.argv
    files = walk_files(PLUGIN)

    runtime, docs, tests, tools, other = [], [], [], [], []
    for rel, size in files:
        top = rel.split("/")[0]
        # A README at the plugin root is documentation, not a stray file. Listing every document by name
        # meant each new one landed in "other" until someone remembered to add it there.
        is_root_doc = "/" not in rel and rel.lower().endswith(".md") and not rel.startswith("_")
        # This script excludes itself, so the tool count it writes does not depend on how many times it has
        # been run. See the note at the top of the file.
        if os.path.split(rel)[-1] in (SELF_NAME, os.path.basename(os.path.abspath(__file__)), "lib_tools.py", "tools.json") or "__pycache__" in rel or rel.endswith(".pyc"):
            continue
        if rel in RUNTIME or top in RUNTIME_DIRS:
            runtime.append((rel, size))
        elif rel in DOCS or (is_root_doc and rel not in ROOT_SCRIPTS):
            docs.append((rel, size))
        elif "/" not in rel and rel in ROOT_SCRIPTS:
            tests.append((rel, size))
        elif top == "tools":
            tools.append((rel, size))
        elif rel in DATA_FILES:
            other.append((rel, size))
        elif "/" not in rel and not rel.startswith("_"):
            other.append((rel, size))

    def total(rows):
        return sum(size for _, size in rows)

    lines = []
    lines.append("# RimCrow 日志分析插件 — 文件清单")
    lines.append("")
    lines.append("本文件由脚本从实际目录结构生成（`tools/write-plugin-manifest.py`），"
                 "所以它不会与目录内容脱节。")
    lines.append("")
    lines.append("它说明包里**每个文件是干什么的**，以及**哪些可以删**。")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 一、总览")
    lines.append("")
    lines.append("| 分类 | 文件数 | 大小 | 能不能删 |")
    lines.append("|---|---|---|---|")
    lines.append("| **运行必需** | {} | 约 {:.0f} KB | ❌ **不能删**，删了插件不工作 |"
                 .format(len(runtime), total(runtime) / 1024))
    lines.append("| **文档** | {} | 约 {:.0f} KB | ⭐ 建议留着 |"
                 .format(len(docs), total(docs) / 1024))
    lines.append("| **测试脚本**（根目录） | {} | 约 {:.0f} KB | ✅ 可删，不影响运行 |"
                 .format(len(tests), total(tests) / 1024))
    lines.append("| **调查工具 `tools/`** | {} | 约 {:.0f} KB | ✅ 可删，不影响运行 |"
                 .format(len(tools), total(tools) / 1024))
    if other:
        lines.append("| **其它** | {} | 约 {:.0f} KB | ⚠️ 见下 |"
                     .format(len(other), total(other) / 1024))
    lines.append("| **合计** | **{}** | 约 {:.0f} KB | — |"
                 .format(len(files), total(files) / 1024))
    lines.append("")
    lines.append("> **注意**：能删的是「不影响插件运行」。")
    lines.append("> `install_bundle` 是**整目录接入**（在 `node_modules/@local/` 下建 Junction 指回本目录），")
    lines.append("> 所以这里列出的文件**都会**随包走，删掉才是真的没有。")
    lines.append("")
    lines.append("### 关于 package.json 的 files 字段")
    lines.append("")
    lines.append("`files` 是 npm 的打包白名单，**只影响 `npm pack` / `npm publish`**，"
                 "**不影响 `install_bundle`**。")
    lines.append("")
    lines.append("本条目的实际安装方式是 Junction 接入，所以：")
    lines.append("")
    lines.append("- `cordis.patch.yml` **不在**白名单里，但它**必须在**，"
                 "因为 `dsh.bundle.patch` 指向它 —— 挂载就靠它")
    lines.append("- 根目录那 5 个测试脚本（`selftest.mjs` / `mock-host.mjs` / `modconfig-test.mjs` / "
                 "`attribution-test.mjs` / `fallback-test.mjs`）也**不在**白名单里，但它们在目录里，所以一样随包走")
    lines.append("- 开发用的 `debug-*.mjs` / `diag.mjs` / `missing.mjs` 已经移到 `tools/dev/`，"
                 "跟调查工具一起归类 —— 它们曾经散在根目录，看起来像运行必需，容易误删或误留")
    lines.append("")
    lines.append("**也就是说：想真正让某个文件不随包分发，只有删掉它一条路。**")
    lines.append("")

    try:
        with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        declared = manifest.get("files", [])
        lines.append("当前 `files` 声明（仅对 `npm pack` 有意义）：")
        lines.append("")
        for entry in declared:
            lines.append("- `{}`".format(entry))
        lines.append("")
    except (OSError, ValueError) as error:
        lines.append("> 读取 package.json 失败：{}".format(error))
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## 二、运行必需（{} 个）".format(len(runtime)))
    lines.append("")
    lines.append("| 文件 | 大小 | 作用 |")
    lines.append("|---|---|---|")
    purposes = {
        "index.js": "插件主体：注册 4 个工具与 /rimlog、/rimmods 命令",
        "client.js": "网页侧：输入框下方的日志来源选择器",
        "package.json": "包清单与 DSH 挂载声明",
        "cordis.patch.yml": "把本插件挂进 DSH 的组合补丁",
        "icon.svg": "插件图标",
        "lib/detect.js": "定位 RimCrow / RimWorld / 工作区，解析启用模组列表",
        "lib/parse.js": "把日志行解析成条目，聚成问题簇，判断归属",
        "lib/report.js": "把簇渲染成给人看的报告（含统计口径）",
        "lib/playerlog.js": "解析纯文本 Player.log（与 RimCrow 的 JSON 日志并行的第二条来源）",
        "lib/modconfig.js": "读 ModsConfig.xml；写入一律先出草稿并备份，游戏运行时拒写",
        "lib/workspace-archive.js": "按天快照工作区、导出迁移包、写归档记录与 INDEX",
        "locale/en.json": "本地化文案（英文）",
        "locale/zh.json": "本地化文案（中文）",
        "plugins/registry.js": "工具与命令的注册表：插件自述、版本、块统计都从这里取",
        "plugins/state.js": "install-state.json 的读写（游标、自动归档时间戳）",
        "plugins/feature-report.js": "把注册表渲染成功能报告与用法说明（rimworld_plugin_guide 的正文）",
    }
    for rel, size in runtime:
        purpose = purposes.get(rel, "模块" if rel.startswith("lib/") else rel)
        lines.append("| `{}` | {:,} B | {} |".format(rel, size, purpose))
    lines.append("")

    lines.append("## 三、文档（{} 个）".format(len(docs)))
    lines.append("")
    lines.append("| 文件 | 给谁看 | 内容 |")
    lines.append("|---|---|---|")
    for rel, size in docs:
        who, what = DOCS.get(rel, ("—", "—"))
        lines.append("| `{}` | {} | {} |".format(rel, who, what))
    lines.append("")

    lines.append("## 四、测试脚本（{} 个，根目录，`node <名字>` 直接跑）".format(len(tests)))
    lines.append("")
    lines.append("| 文件 | 作用 |")
    lines.append("|---|---|")
    for rel, size in tests:
        lines.append("| `{}` | {} |".format(rel, ROOT_SCRIPTS.get(rel, "—")))
    lines.append("")

    lines.append("## 五、调查工具（`tools/`，{} 个，按需跑）".format(len(tools)))
    lines.append("")
    lines.append("这些都是**一次性调查脚本**：当时为了查某个具体问题写的，"
                 "留在这里是因为同类问题会再出现。用途见 `OPERATIONS.md` 第 7 节。")
    lines.append("")
    lines.append("<details>")
    lines.append("<summary>展开文件列表</summary>")
    lines.append("")
    for rel, size in tools:
        lines.append("- `{}`  ({:,} B)".format(rel, size))
    lines.append("")
    lines.append("</details>")
    lines.append("")

    if other:
        lines.append("## 六、其它（{} 个）".format(len(other)))
        lines.append("")
        for rel, size in other:
            # blocks.json 的字节数每次盖章都会变，把它写进清单会造成循环：
            #   盖章 → blocks.json 变大 → 清单过期 → 重生成清单 → 盖章又发现清单变了 → …
            # 这个数字对读者没有意义（谁也不会手抄它），所以不记。
            if rel == "blocks.json":
                lines.append("- `{}`  （块登记表：大小随每次盖章变化，故不记字节数）".format(rel))
            else:
                lines.append("- `{}`  ({:,} B)".format(rel, size))
        lines.append("")

    text = "\n".join(lines) + "\n"

    # 工具清单：工具名来自 index.js 的 toolsRegistered，用途来自 tools/tools.json。
    try:
        import lib_tools
        _tools = lib_tools.read_tools(os.path.join(PLUGIN, "index.js"))
        if _tools:
            _tl = ["", "## 七、工具（{} 个）".format(len(_tools)), ""]
            _tl.append("> 本节由 `tools/lib_tools.py` 按 `index.js` 的注册生成，用途来自 `tools/tools.json`。")
            _tl.append("")
            _tl.append("| 工具 | 一句话用途 |")
            _tl.append("|---|---|")
            for _x in _tools:
                _tl.append("| `{}` | {} |".format(_x["name"], _x["purpose"].replace("|", "\\|")))
            text = text.rstrip("\n") + "\n" + "\n".join(_tl) + "\n"
    except Exception as _exc:
        print("  [warn] 工具清单没生成: " + str(_exc))

    if check_only:
        try:
            current = open(OUTPUT, encoding="utf-8").read()
        except OSError:
            current = ""
        print("manifest " + ("is up to date" if current == text else "NEEDS REGENERATION"))
        return 0

    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    print("wrote " + OUTPUT)
    print("  runtime      : " + str(len(runtime)))
    print("  documentation: " + str(len(docs)))
    print("  tests        : " + str(len(tests)))
    print("  tools        : " + str(len(tools)))
    if other:
        print("  other        : " + str(len(other)) + "  " + ", ".join(r for r, _ in other))
    print("  total        : " + str(len(files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
