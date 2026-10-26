"""Build the delivery package for this plugin: a zip plus an auto-generated changelog.

The package is self-contained: the plugin tree, a changelog describing what changed since a baseline
snapshot, an upgrade note for someone replacing an older install, the install guide, and a checksum list so
the copy can be verified after transfer.

The change list is computed by comparing against a baseline directory rather than written by hand, so the
changelog cannot drift from reality.

## The baseline is optional, and that is deliberate

This script used to live outside the plugin and hard-code three absolute paths on the machine it was
written on (a developer workspace and two directories below it), including the baseline
at `_archive/RimCrow日志分析插件`. That is why it could not be shipped: on any other machine all three are
wrong.

Here the plugin root is derived from this file's own location, and the baseline is a `--baseline` argument.
When no baseline is found the changelog says so plainly instead of listing every file as new - "everything
is new" is a worse failure than "the change list is unavailable", because it reads like a real answer.

Writes to a chosen output directory (the Desktop by default) and nowhere else. Read-only against the
plugin itself and the game.

Usage:
  python tools/build-package.py                       # build, no baseline
  python tools/build-package.py --baseline <old-dir>  # with a changelog
  python tools/build-package.py --dry-run             # report, write nothing
"""

import hashlib
import json
import os
import shutil
import sys
import zipfile
import glob
from datetime import datetime

# Derived from this file's location: tools/build-package.py -> the plugin root. Never hard-coded, because a
# path that is correct on the author's machine is simply wrong everywhere else.
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# There is deliberately no auto-detection of a baseline.
#
# The first version of this file guessed one from a list of likely locations. In this workspace that guess
# found the archived 1.0 copy, so building a 1.6.1 package produced a changelog saying "added 60, modified
# 13, removed 6" - six releases of history presented as one release's changes, with nothing in the output
# to reveal that the comparison was meaningless. A wrong changelog is worse than no changelog because it
# looks authoritative.
#
# So the baseline must be named explicitly. Without it the changelog says the change list is unavailable and
# lists the files instead.

# Generated output rather than source: diag.mjs --brief writes it. Not shipped.
#
# `__pycache__` / `*.pyc` belong here for a different reason: they appear when a Python tool is merely
# RUN, not when it is written. Leaving them in meant one `py_compile` (39 KB × 2) silently joined the
# package and the inventory count moved 76 → 78 with nothing to explain it.
EXCLUDE = {"diag-brief.md", "node_modules", ".git", "__pycache__", "*.pyc", "*.pyo"}

# 复制源目录时排除 node_modules（那边是 pnpm 的 junction 结构），但**暂存目录**里的
# node_modules 是我们手工解引用复制进去的运行期依赖，必须计入 SHA256SUMS 和体积统计 ——
# 校验清单漏掉它们，收包方就核不到它们，等于「完整包」少了一块。
STAGE_EXCLUDE = EXCLUDE - {"node_modules"}

# Names EXCLUDE handles for directories; files also need the suffix check because `*.pyc` is a glob and
# the walkers below compare plain names.
EXCLUDE_SUFFIXES = (".pyc", ".pyo")

# 交付包里必须有的文档。复制与校验共用这一份，避免「复制列表改了、校验列表忘了改」。
REQUIRED_DOCS = ("README.md", "更新日志.md", "安装说明.md", "插件清单.md", "使用参考.md", "块功能介绍.md")

# 插件本体里删了就装不上的文件（少了任何一个，install_bundle 会失败或插件不工作）。
REQUIRED_PLUGIN_FILES = ("package.json", "index.js", "client.js", "cordis.patch.yml", "icon.svg")

TOOL_PURPOSES = {
    "audit-patches.mjs": "审计本工作区产出的每个补丁 mod：About.xml 子元素是否合法、packageId 有无重复、"
                         "依赖与 loadAfter 是否都存在、Patches/*.xml 的操作类与 xpath 是否有效",
    "ce-audit.mjs": "审计武器与护甲 def 的 Combat Extended 覆盖情况",
    "check-about-schema.mjs": "按 Verse.ModMetaData 的字段表校验 About.xml",
    "check-about.mjs": "报告 About.xml 的直接子元素不符合 Verse.ModMetaData 的文件"
                       "（走解析树而非正则，正则会产生大量误报）",
    "check-packagerefs.mjs": "核对补丁引用的 packageId 是否真的存在于<u>已启用</u>列表里",
    "diff-modlists.mjs": "对比两份 RimCrow mod 列表（.rml），找出增删了什么",
    "dump-clusters.mjs": "列出每个簇的级别、次数与归一化消息，便于把错误的统计条目追回来源簇",
    "explain-tally.mjs": "复现报告的「按 mod 统计错误」，并显示每个数字由哪些簇产生",
    "find-bad-about.mjs": "递归找出缺 packageId 的 About.xml（RimWorld 只报工坊数字 id，"
                          "真正的坏文件往往在磁盘另一处）",
    "find-def-across-mods.mjs": "查某个 defName / label 由哪个已启用 mod 定义",
    "find-mod-by-name.mjs": "查某个程序集或 defName 由哪个已启用 mod 提供",
    "find-scribe-references.mjs": "在反编译的 C# 里找 Scribe_References 调用及上下文",
    "find-type-provider.mjs": "在磁盘上所有程序集里搜一个 C# 类型名，定位它由哪个 mod 提供",
    "list-mod-assemblies.mjs": "列出一个 mod 目录带的程序集（兼容 1.6 / 1.5 / 根目录三种布局）",
    "probe-cluster-attribution.mjs": "复现「只是<u>提到</u>某个 mod 的簇为何被归到它头上」",
    "probe-findactive.mjs": "显示一个命名空间 token 解析到哪个已启用 mod，以及为什么",
    "probe-meta.py": "打印 .NET 元数据各数据流的真实起点，用于排查堆索引解码",
    "probe-method-il.py": "解码单个方法的 IL 方法体，并解析它遇到的每个成员引用",
    "probe-patch-file.ps1": "对目标文件的<u>副本</u>模拟 RimWorld 补丁操作，足以抓出实际会犯的错",
    "probe-pe.py": "打印 PE 文件的节表与数据目录，并用真实字节核对",
    "probe-strings.py": "提取程序集里的 UTF-16LE 字面量（C# 编译器存用户字符串的方式）",
    "probe-tables.py": "定位 .NET 元数据表流的行数数组位置",
    "tally-damage-report.mjs": "统计 Vehicle Framework 的伤害报告，用数据判断补丁的效果",
    "trace-candidates.mjs": "显示一个簇的全部归属候选，以及最终胜出的是哪个",
    "trace-cluster.mjs": "查某条日志消息最终落进哪个簇，以及那个簇报告了什么",
    "trace-component-health.mjs": "追踪某个部件在日志全部伤害报告里的血量，看它是否下降过",
}

DOC_PURPOSES = {
    "COMBAT_EXTENDED.md": "Combat Extended 兼容性参考（新增）",
    "OPERATIONS.md": "深度运维手册：补丁写法的坑、验证纪律、工具用法",
    "PORTING.md": "把这套东西搬到别的 RimCrow 环境时的注意事项",
    "安装说明.md": "使用者：怎么装、怎么用、怎么排错、怎么卸载",
    "插件清单.md": "每个文件干什么、哪些能删（由脚本生成，不会脱节）",
    "使用参考.md": "能直接复制给 DSH 的一句话清单（按场景分组）",
}


def hash_file(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def snapshot(root):
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE]
        for name in filenames:
            if name in EXCLUDE or name.lower().endswith(EXCLUDE_SUFFIXES):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            files[rel] = hash_file(full)
    return files


def find_baseline(explicit):
    """Resolve the directory to diff against, or None when there is none.

    An explicit path must exist: silently falling back to "no baseline" would produce a package whose
    changelog claims nothing is known when the caller believed they had asked for a comparison.

    Returns None when no baseline was named, whose meaning is "no comparison", not "compare against
    nothing". See the note above the EXCLUDE set for why this does not guess.
    """
    if explicit is None:
        return None
    if not os.path.isdir(explicit):
        raise SystemExit("baseline not found: " + explicit)
    return explicit


def compute_changes(baseline):
    """Diff the plugin against `baseline`.

    Returns `(has_baseline, old, new, added, removed, modified)`. `has_baseline` is False when there is
    nothing to compare against, and the caller must say so rather than reporting every file as new.
    """
    new = snapshot(PLUGIN)
    if baseline is None:
        return False, {}, new, [], [], []
    old = snapshot(baseline)
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    modified = sorted(r for r in set(old) & set(new) if old[r] != new[r])
    return True, old, new, added, removed, modified


def main():
    argv = sys.argv[1:]

    if "--help" in argv or "-h" in argv:
        print(__doc__)
        return 0

    dry_run = "--dry-run" in argv

    baseline_arg = None
    if "--baseline" in argv:
        index = argv.index("--baseline")
        if index + 1 >= len(argv):
            raise SystemExit("--baseline needs a directory")
        baseline_arg = argv[index + 1]

    out_dir = os.path.join(os.path.expanduser("~"), "Desktop")
    if "--out-dir" in argv:
        index = argv.index("--out-dir")
        if index + 1 >= len(argv):
            raise SystemExit("--out-dir needs a directory")
        out_dir = argv[index + 1]

    baseline = find_baseline(baseline_arg)
    has_baseline, old, new, added, removed, modified = compute_changes(baseline)

    # 基线自己的版本号，用于说明「这是累计差异」。读不到就是 None，不影响打包。
    baseline_version = None
    if baseline:
        try:
            with open(os.path.join(baseline, "package.json"), encoding="utf-8") as handle:
                baseline_version = json.load(handle).get("version")
        except (OSError, ValueError):
            baseline_version = None

    # Read the declared version first: the name of the staged folder and the archive both carry it, so it
    # has to be known before either is created.
    try:
        with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as handle:
            version = json.load(handle).get("version", "?")
    except (OSError, ValueError):
        version = "?"

    stamp = datetime.now().strftime("%Y-%m-%d")
    # The version is part of the name so a recipient can tell two packages apart without opening them,
    # and so a package sitting on a Desktop next to an older one is unambiguous. The date alone does not
    # distinguish a rebuild of the same version from a new version, and those are very different things
    # to hand someone.
    stage = os.path.join(out_dir, "RimCrow日志分析插件_v" + str(version) + "_" + stamp)
    archive = stage + ".zip"

    print("plugin   : " + PLUGIN)
    print("version  : v" + str(version))
    print("files    : " + str(len(new)))
    if has_baseline:
        print("baseline : " + baseline)
        print("changes  : added " + str(len(added)) + ", modified " + str(len(modified))
              + ", removed " + str(len(removed)))
    else:
        print("baseline : NONE - the changelog will say the change list is unavailable")
    print("stage    : " + stage)
    print("archive  : " + archive)

    if dry_run:
        print("")
        print("dry run: nothing written")
        return 0

    # ---------------------------------------------------------------- stage the plugin

    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    shutil.copytree(PLUGIN, os.path.join(stage, "rimworld-log-plugin"),
                    ignore=shutil.ignore_patterns(*EXCLUDE))

    # ---------------------------------------------------------------- 运行期依赖
    # 插件导出的 Config 必须是真 Schemastery 实例（host 走 Standard Schema 校验），
    # 所以 index.js 依赖公共包 `schemastery`。EXCLUDE 排掉了 node_modules（避免 pnpm 的
    # junction 结构让 os.walk 打转/重复计数），这里单独把这几个包**解引用后**复制进包：
    # 收包方解压即可用，不必在插件目录跑 npm install。
    #
    # pnpm 的布局不是平铺的：顶层 node_modules/<pkg> 只是指向 .pnpm 的 junction，
    # 而传递依赖（@standard-schema/spec、cosmokit）只存在于 .pnpm/<root>@<ver>/node_modules/。
    # 所以按「平铺 → .pnpm 布局」两路找，找到就解引用复制到**平铺的** node_modules/ 下 ——
    # schemastery 里的裸导入按「向上找 node_modules」就能解析到它们。
    RUNTIME_DEPS = ["schemastery", "@standard-schema/spec", "cosmokit"]

    def resolve_runtime_dep(dep):
        """Return the real directory for one runtime dependency, or None."""
        flat = os.path.join(PLUGIN, "node_modules", dep.replace("/", os.sep))
        if os.path.isdir(flat):
            return flat
        # .pnpm/<root>@<ver>/node_modules/<dep> —— 版本目录名不定，用 glob 扫
        pattern = os.path.join(PLUGIN, "node_modules", ".pnpm", "*", "node_modules", dep.replace("/", os.sep))
        for candidate in sorted(glob.glob(pattern)):
            if os.path.isdir(candidate):
                return candidate
        return None

    for dep in RUNTIME_DEPS:
        src = resolve_runtime_dep(dep)
        dst = os.path.join(stage, "rimworld-log-plugin", "node_modules", dep.replace("/", os.sep))
        if src is None:
            print("警告：找不到运行期依赖 {}".format(dep))
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)  # 源是 pnpm junction，copytree 会解引用复制真实内容


    # ---------------------------------------------------------------- changelog

    lines = []
    lines.append("# 更新日志")
    lines.append("")
    lines.append("本包版本：**v{}**".format(version))
    lines.append("")
    if has_baseline:
        lines.append("对比基准：`{}`（{} 个文件）".format(baseline, len(old)))
        lines.append("")
        lines.append("本包文件数：**{}**（基准 {}）".format(len(new), len(old)))
        # 基准版本号是从基线自己的 package.json 读的，不是猜的。跨版本对比必须说出来，
        # 否则「第三节的差异」会被读者当成单一版本的改动 —— 这也正是 RELEASE.md 第四节
        # 记录的那个事故（拿 1.0 当归档当基线，六个版本被写成一次更新）。
        if baseline_version and baseline_version != version:
            lines.append("")
            lines.append("⚠️ **基准是 v{}，本版是 v{}** —— 第三节列出的是**自 v{} 起的累计差异**，"
                         "不等于单一版本的改动；第一节只讲本版（v{}）本身。".format(
                             baseline_version, version, baseline_version, version))
    else:
        lines.append("对比基准：**未提供** —— 因此本页没有「新增 / 修改 / 删除」清单，见第七节。")
        lines.append("")
        lines.append("本包文件数：**{}**".format(len(new)))
    lines.append("")

    lines.append("## 一、这一版的三件事")
    lines.append("")
    lines.append("这一版把插件从「读日志给结论」扩成「**读日志 + 审计部署 + 管自己的设置**」三件事都做得动，"
                 "并让交付包自带运行期依赖，拿到就能装。")
    lines.append("")

    lines.append("### 1. 分析侧新增六个只读动作")
    lines.append("")
    lines.append("| 动作 | 干什么 | 解决什么 |")
    lines.append("|---|---|---|")
    lines.append("| `analyze` + `compact=true` | 一簇一行（计数+签名+归属），不带堆栈与样本 | 78 个错误 → 5 行；引擎帧折叠成「引擎/未归属」桶 |")
    lines.append("| `mods-changed` | 时间窗内更新/新增/移除的 mod（目录 mtime + About `modVersion` 与基线比对） | 「mod 更新后哪些补丁要重查」不再靠手扫目录 |")
    lines.append("| `diff` | 本次 vs 上次会话的错误对比（新增/消失/计数变化） | 重开会话后「什么新出来了」一眼可见 |")
    lines.append("| `grep` + `context` | 命中行前后各带 0–3 行相邻日志 | 不用再手工翻上下文 |")
    lines.append("| `patchaudit` | 按 packageId 对照工作区源码与已部署 DLL（哈希 + mtime） | 部署漂移一条命令查清 |")
    lines.append("| `aboutcheck` | About.xml 六项校验（结构/裸 &/description/编码） | 手工检查清单固化成动作 |")
    lines.append("")
    lines.append("另：`rimworld_workspace_archive` 新增 `action=verify`（快照与工作区逐文件对账：清单差异 + 全量哈希）。")
    lines.append("")

    lines.append("### 2. 设置进了 DSH 原生配置面")
    lines.append("")
    lines.append("设置从「只有环境变量」变成**四级回退**：环境变量 > 配置界面 > `settings.json` > 内置默认。")
    lines.append("")
    lines.append("| 入口 | 用法 |")
    lines.append("|---|---|")
    lines.append("| **设置左栏「RimWorld 日志」** | 独立一页（Agent 预设正下方），7 个键可直接编辑；保存写 profile patch |")
    lines.append("| `rimworld_plugin_guide` `action=config` | 对话式打印当前生效值与**每个值的来源**（环境变量/配置界面/settings.json/默认） |")
    lines.append("| `~/.dsh/rimworld-log/settings.json` | 旧的文件层，仍被读取；适合脚本化批量改 |")
    lines.append("")
    lines.append("两个如实说明：**保存后要重启 DSH 才生效**（已加载的 host 半区不热重载配置）；"
                 "**环境变量始终优先**于界面与文件。")
    lines.append("")

    lines.append("### 3. CE 手册补上载具一节，工具链顺带修好")
    lines.append("")
    lines.append("`COMBAT_EXTENDED.md` 新增 §9「载具（Vehicle Framework / VRF / CE 桥接）」，五条都按「症状 → 机制 → 查法」写："
                 "tick 顺序、空投舱放人、CE 给 NPC 装弹药、载具耐久 NaN、Harmony 抽象方法。")
    lines.append("")
    lines.append("工具链同时修了三处：`check-all` 加第六项（9 个自测全进闸门）、清理登记表里 71 个失效块、"
                 "新增 `_tools/deploy-fix.ps1`（进程检测 → 备份 → 拷贝 → 哈希校验，含 PowerShell 5.1 的 BOM 坑）。")
    lines.append("")

    lines.append("## 二、工具与清理")
    lines.append("")
    lines.append("### 2.1 本包自带运行期依赖")
    lines.append("")
    lines.append("插件现在导出 `Config`（DSH 行配置的 Schemastery schema），因此依赖公共 npm 包 `schemastery`。"
                 "**本包已带上 `node_modules/`（schemastery + @standard-schema/spec + cosmokit，共 223 KB）**，"
                 "解压即可用，不需要在插件目录跑 `npm install`。")
    lines.append("")
    lines.append("为什么不用 harness 内置的 `@deepseek-ai/schemastery`：那是 vendored fork，"
                 "从工作区真实路径解析不到 `@deepseek-ai/*`；公共 3.18.0 与之共用 "
                 "`Symbol.for(\"schemastery\")`，实例互相识别，实测兼容。")
    lines.append("")
    lines.append("### 2.2 CE 手册 §9 载具：五条实测结论")
    lines.append("")
    lines.append("| 症状 | 机制 |")
    lines.append("|---|---|")
    lines.append("| 载具反复爆炸、车不死 | `TickHandlers` 异常会跳过 `TickExplosives` / `TickAllComps` / `AITick` |")
    lines.append("| 空投舱落地乘客不下车 | 乘客在 `AllInventoryPawns` 里；判舱用 `IsSiegeDropVehicle`，判落地用 `spawnedTick`；车里 pawn `Spawned == false` |")
    lines.append("| NPC 袭击单位没有弹药 | CE `LoadWeaponWithRandAmmo` 权重全 0 会抛 `totalWeight=0` |")
    lines.append("| 载具耐久出现 -2147483648% | CE 用 `health / 50f` 当护甲；NaN 会自传播 |")
    lines.append("| 抽象方法打补丁报错 | Harmony 不能补抽象方法，要沿 `BaseType` 找 `DeclaredOnly` 的非抽象实现 |")
    lines.append("")

    # ------------------------------------------------------------------ 历史版本
    # HISTORY.md 是累积记录（新版本在最上面，旧版本不删）。打包时整段搬进来，
    # 这样读者拿到任何一版的包都能看回去。文件缺失时明说，而不是静默跳过。
    lines.append("## 三、历史版本更新")
    lines.append("")
    _history_path = os.path.join(PLUGIN, "HISTORY.md")
    if os.path.isfile(_history_path):
        with open(_history_path, encoding="utf-8") as _handle:
            _history = _handle.read().strip()
        # 去掉 HISTORY.md 自己的标题与前言行，只保留版本段落，避免标题重复
        _cut = _history.find("## v")
        if _cut > 0:
            _history = _history[_cut:]
        for _line in _history.split("\n"):
            # 降一级：HISTORY.md 里的 "## v1.6.1" 在更新日志里应是 "### v1.6.1"，
            # 否则它会和「三、历史版本更新」同级，把目录结构打平。
            lines.append(("### " + _line[3:]) if _line.startswith("## ") else _line)
    else:
        lines.append("**本包没有携带 `HISTORY.md`** —— 历史版本的更新记录缺失。")
    lines.append("")

    if baseline_version and baseline_version != version:
        lines.append("## 四、修改的文件（自 v{} 起，{} 个）".format(baseline_version, len(modified)))
    else:
        lines.append("## 四、修改的文件（{} 个）".format(len(modified)))
    lines.append("")
    if not has_baseline:
        lines.append("**本节不可用：打包时没有提供对比基线。** 没有旧版本可对照，就无法说哪个文件「改了」——"
                     "把全部文件都写成「修改」会让读者以为插件被重写了一遍。")
        lines.append("")
        lines.append("要这份清单，打包时传 `--baseline <上一版目录>`，见第七节。")
        lines.append("")
    lines.append("| 文件 | 变化 | 说明 |")
    lines.append("|---|---|---|")
    manual = {
        "index.js": "**新增 `note` 动作与自动归档**；导出结果透出命名提醒",
        "lib/workspace-archive.js": "新增 `archiveNoteDir` / `writeArchiveNote` / INDEX 重建；"
                                    "`exportMigrationPack` 增加 `namingHint`",
        "package.json": "版本号；`files` 白名单顺序随目录整理调整",
        "OPERATIONS.md": "补 `note` 动作、自动归档节流、迁移包命名约定",
        "RELEASE.md": "**新增**：打包命令、基线规则、每次发版必须手写的五处、验收清单",
        "tools/build-package.py": "**新增**：打包脚本（基线显式、叙事正文手写）",
        "tools/sync-manifest.mjs": "**修 bug**：`tools/` 改为递归扫描",
        "插件清单.md": "由 `tools/sync-manifest.mjs` 从磁盘重新生成（写数字会立刻过期，所以只说明来源）",
        "tools/stamp-blocks.mjs": "随 `tools/dev` 迁移同步",
    }
    for rel in modified:
        lines.append("| `{}` | {} | {} |".format(
            rel, "内容变化", manual.get(rel, "见文件自身")))
    lines.append("")
    if added:
        lines.append("**新增的文件**：" + ", ".join("`{}`".format(r) for r in added[:40]))
        if len(added) > 40:
            lines.append("")
            lines.append("（共 {} 个，前 40 个如上；完整列表见第七节。）".format(len(added)))
        lines.append("")
    if removed:
        lines.append("**删除（移动）的文件**：" + ", ".join("`{}`".format(r) for r in removed[:40]))
        lines.append("")
    if not added and not removed:
        lines.append("**新增与删除的文件**：无。")
        lines.append("")

    lines.append("## 五、<u>没有</u>变化的（重要）")
    lines.append("")
    notes = {
        "lib/modconfig.js": "mod 列表读写的安全设计（默认出草稿、写入前备份、游戏运行时拒写）一字未动",
        "lib/playerlog.js": "Player.log 解析未动",
        "plugins/state.js": "安装状态记忆未动",
        "plugins/registry.js": "工具注册表未动",
        "locale/zh.json": "只改了描述文字，键结构未动",
    }
    unchanged = sorted(r for r in set(old) & set(new) if old[r] == new[r]) if has_baseline else []
    if has_baseline:
        lines.append("本版**逐字节未变**的文件共 **{}** 个。其中要紧的是：".format(len(unchanged)))
    else:
        lines.append("（没有基线，无法断言哪些文件未变；下列为设计上本版未触碰的部分。）")
    lines.append("")
    lines.append("| 文件 | 说明 |")
    lines.append("|---|---|")
    for rel in ["lib/modconfig.js", "lib/playerlog.js", "plugins/state.js", "plugins/registry.js", "locale/zh.json"]:
        if rel in unchanged:
            lines.append("| `{}` | **未变**（hash 相同）—— {} |".format(rel, notes.get(rel, "未变")))
        elif not has_baseline:
            lines.append("| `{}` | 本版未触碰 —— {} |".format(rel, notes.get(rel, "未变")))
    lines.append("")
    lines.append("**命令（`rimlog` / `rimmods`）的名字、参数与行为契约都没动。**")
    lines.append("")
    lines.append("**也就是说**：这一版改的是**分析工具能查到的东西**（六个新动作 + 设置页 + 部署审计），"
                 "但**既有输出的语义没有变** —— `analyze` 默认仍返回逐簇详细报告，`grep` 默认仍不带上下文，"
                 "新行为都要显式传参才会出现。")
    lines.append("")

    lines.append("## 六、升级步骤")
    lines.append("")
    lines.append("1. **用 DSH 的插件管理移除旧版**（或用 `plugin_manager` 的 `remove_bundle`）。")
    lines.append("2. 删掉旧版插件文件夹。")
    lines.append("3. 把本包的 `rimworld-log-plugin/` 放到任意位置（别放进 DSH 或 RimWorld 安装目录）。")
    lines.append("   **本包已自带 `node_modules/`（schemastery 等运行期依赖），不需要再装任何东西。**")
    lines.append("4. **用 `plugin_manager` 的 `install_bundle` 安装**，`target` 传那个文件夹的绝对路径。")
    lines.append("5. **重启 DSH 进程** —— 模块缓存键是「包」不是「行」，热替换无效。")
    lines.append("6. 打开 **设置 → 左栏「RimWorld 日志」**（Agent 预设下面）确认设置页出现；")
    lines.append("   或让 agent 跑 `rimworld_plugin_guide action=config` 看生效值与来源。")
    lines.append("")
    lines.append("**三条会失败的错误做法，别试**：")
    lines.append("")
    lines.append("1. ❌ 手写 profile 的 `package.json` 加一行依赖")
    lines.append("2. ❌ 手写 `cordis.patch.yml` 增删启用行")
    lines.append("3. ❌ 在 profile 目录里跑 `pnpm install`")
    lines.append("")
    lines.append("**会留下什么**：`~/.dsh/rimworld-log/` 里的 `install-state.json`（上次分析到哪 + 自动归档时间戳）、"
                 "`mod-versions.json`（mod 版本基线，mods-changed 用）与可选的 `settings.json`（文件层设置）。"
                 "删掉 `install-state.json` 等于让增量游标重置；删掉 `mod-versions.json` 等于 mods-changed 重新建基线。")
    lines.append("")
    lines.append("## 七、完整文件差异")
    lines.append("")
    if not has_baseline:
        # Saying this plainly is the point. The alternative - listing every file as new - looks like a
        # real answer and is wrong, so a reader would believe the plugin had been rewritten from scratch.
        lines.append("**本节不可用：打包时没有提供对比基线。**")
        lines.append("")
        lines.append("本包共 {} 个文件，但没有可对照的旧版本，因此无法列出「新增 / 修改 / 删除」。".format(len(new)))
        lines.append("")
        lines.append("要有变更清单，打包时传 `--baseline <旧版本目录>`：")
        lines.append("")
        lines.append("```")
        lines.append("python tools/build-package.py --baseline /path/to/old/rimworld-log-plugin")
        lines.append("```")
        lines.append("")
        lines.append("<details>")
        lines.append("<summary>展开：本包全部 {} 个文件</summary>".format(len(new)))
        lines.append("")
        for rel in sorted(new):
            lines.append("- `{}`  ({:,} B)".format(rel, os.path.getsize(os.path.join(PLUGIN, rel))))
        lines.append("")
        lines.append("</details>")
        lines.append("")
        with open(os.path.join(stage, "更新日志.md"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines))
    else:
        lines.append("<details>")
        lines.append("<summary>展开（新增 {} / 修改 {} / 删除 {}）</summary>".format(
            len(added), len(modified), len(removed)))
        lines.append("")
        lines.append("**新增（{}）**".format(len(added)))
        lines.append("")
        for rel in added:
            size = os.path.getsize(os.path.join(PLUGIN, rel))
            lines.append("- `{}`  ({:,} B)".format(rel, size))
        lines.append("")
        lines.append("**修改（{}）**".format(len(modified)))
        lines.append("")
        for rel in modified:
            old_size = os.path.getsize(os.path.join(baseline, rel))
            new_size = os.path.getsize(os.path.join(PLUGIN, rel))
            lines.append("- `{}`  {:,} B → {:,} B  ({:+,})".format(
                rel, old_size, new_size, new_size - old_size))
        lines.append("")
        lines.append("**删除（{}）**：{}".format(
            len(removed), "无" if not removed else ", ".join("`{}`".format(r) for r in removed)))
        lines.append("")
        lines.append("</details>")
        lines.append("")

        with open(os.path.join(stage, "更新日志.md"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines))

    # ---------------------------------------------------------------- readme

    readme = []
    readme.append("# RimCrow 日志分析插件 — 交付包")
    readme.append("")
    readme.append("打包时间：" + datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    readme.append("")
    readme.append("这是一个 **DSH（DeepSeek Harness）插件**，用来读取和分析 **RimWorld** 游戏日志"
                  "（配合 **RimCrow** 使用）。**只读**。")
    readme.append("")
    readme.append("## 本包内容")
    readme.append("")
    readme.append("| 文件 / 目录 | 说明 |")
    readme.append("|---|---|")
    readme.append("| `rimworld-log-plugin/` | **插件本体** —— 就装这个 |")
    readme.append("| `更新日志.md` | **对比上一版的功能更新**（含升级步骤）|")
    readme.append("| `安装说明.md` | 从零安装的完整说明（含卸载与已知限制）|")
    readme.append("| `插件清单.md` | 包内每个文件干什么、哪些能删 |")
    readme.append("| `使用参考.md` | **能直接复制给 DSH 的一句话清单**：每天干什么、怎么问、别怎么问 |")
    readme.append("| `块功能介绍.md` | 块是什么、能干什么、怎么用（按块比对与导入）|")
    readme.append("| `SHA256SUMS.txt` | 校验清单，传输后可比对 |")
    readme.append("")
    readme.append("## 快速升级（已经装过旧版）")
    readme.append("")
    readme.append("1. 用 DSH 的插件管理**移除旧版**，并删掉它的文件夹。")
    readme.append("2. 把 `rimworld-log-plugin/` 放到任意位置"
                  "（**别放进 DSH 或 RimWorld 的安装目录**）。")
    readme.append("3. 用 `plugin_manager` 的 `install_bundle` 安装，`target` 传该文件夹的绝对路径。")
    readme.append("4. **重启 DSH 进程** —— 模块缓存键是「包」不是「行」，热替换无效。")
    readme.append("")
    readme.append("**怎么开口让它干活，见 `使用参考.md`（全是能直接复制的句子）。**")
    readme.append("")
    readme.append("**详细内容与三条会失败的错误做法见 `更新日志.md` 第六节；历史版本见第三节。**")
    readme.append("")
    # ====================================================================================================
    # STALE-PRONE REGION: everything from here to the end of the README is written by hand. It is NOT
    # generated from the diff, so it cannot notice that the plugin has moved on.
    #
    # It currently describes v1.6.9: six new read-only actions (compact / mods-changed / diff /
    # grep context / patchaudit / aboutcheck + archive verify), settings moving into the DSH native
    # config surface with a settings page, and the CE 「载具」section. package.json's version is read
    # live, so the heading cannot go stale -- but every claim below can.
    #
    # Whoever builds the next package must rewrite this region for that release, and re-read the sentence
    # 判断标准 in RELEASE.md 第五节: any sentence containing 新增 / 本版 / 这次 -- is it about THIS version?
    # ====================================================================================================
    readme.append("## 本版更新了什么（一句话）")
    readme.append("")
    readme.append("**分析侧新增六个只读动作**（紧凑视图、mod 变动、会话对比、部署审计、About 校验、快照对账）、"
                  "**设置进了 DSH 设置页**（左栏独立一页，环境变量 > 界面 > 文件 > 默认）、"
                  "**CE 手册补上载具一节**；本包**自带运行期依赖**，解压即可安装。")
    readme.append("")
    # The version is read from package.json rather than written here, so this heading cannot go stale
    # while the rest of the document moves on.
    readme.append("### 新增与变化的动作（v{}，需重启 DSH 才会生效）".format(version))
    readme.append("")
    readme.append("| 工具 / 动作 | 作用 |")
    readme.append("|---|---|")
    readme.append("| `rimworld_log_scan` `action=analyze` + `compact` | **新增参数**。紧凑视图：每簇一行（计数+签名+归属），"
                  "引擎帧折叠成「引擎/未归属」；`ignore` 可过滤已知噪音（PA's God Hands 那条红字）。 |")
    readme.append("| `rimworld_log_scan` `action=mods-changed` | **新增**。时间窗内更新/新增/移除的 mod（目录 mtime + "
                  "About `modVersion` 与基线比对，基线存 `~/.dsh/rimworld-log/mod-versions.json`）。 |")
    readme.append("| `rimworld_log_scan` `action=diff` | **新增**。本次 vs 上次会话：新增 / 消失 / 计数变化。 |")
    readme.append("| `rimworld_log_scan` `action=grep` + `context` | **新增参数**。命中行前后各带 0–3 行相邻日志。 |")
    readme.append("| `rimworld_log_scan` `action=patchaudit` | **新增**。按 packageId 对照工作区源码与已部署 DLL"
                  "（哈希 + mtime），列出源码新/哈希不一致/未启用。 |")
    readme.append("| `rimworld_log_scan` `action=aboutcheck` | **新增**。About.xml 六项校验（结构 / 裸 & / "
                  "description 类型 / BOM / 乱码）。 |")
    readme.append("| `rimworld_workspace_archive` `action=verify` | **新增**。快照与工作区逐文件对账：清单差异 + 全量哈希。 |")
    readme.append("| `rimworld_plugin_guide` `action=config` | **新增**。打印生效设置与**每个值的来源**。 |")
    readme.append("| 设置页 | **新增**。设置左栏「RimWorld 日志」独立一页（Agent 预设正下方），7 个键可直接编辑；"
                  "保存写 profile patch，**重启 DSH 后生效**。 |")
    readme.append("")
    readme.append("模块缓存键是「包」不是「行」，**热替换无效，必须重启 DSH 进程**。")
    readme.append("")
    readme.append("### 本包自带运行期依赖")
    readme.append("")
    readme.append("插件的 `Config` 必须是真 Schemastery 实例（host 走 Standard Schema 校验），所以依赖公共包 "
                  "`schemastery`。**本包已带 `node_modules/`（schemastery + @standard-schema/spec + cosmokit，"
                  "223 KB）**，解压即可用，**不需要**在插件目录跑 `npm install`。")
    readme.append("")
    readme.append("### 打包这件事本身也进包了")
    readme.append("")
    readme.append("`tools/build-package.py` + `RELEASE.md`：拿到包的人**能复现它**，而不只是能用它。")
    readme.append("")
    readme.append("**基线必须显式给**（`--baseline <上一版目录>`）。不给的话，更新日志会明写「本节不可用」。"
                  "本包的基线是**上一次公开的版本**（v1.6.1），不是任何未公开的本地构建。")
    readme.append("")
    readme.append("**命令（`rimlog` / `rimmods`）的名字、参数与行为契约都没动**；`client.js` 只新增了设置页，"
                  "输入框下的日志来源条保持不变。")
    readme.append("")
    with open(os.path.join(stage, "README.md"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(readme))

    # ---------------------------------------------------------------- copy the loose docs

    # 包内固定 6 份文档（README / 更新日志 / 安装说明 / 插件清单 / 使用参考 / 块功能介绍）。
    # 复制清单漏写一个时，包看起来仍然是完整的 —— 只有打开才发现少一份。所以打完立刻硬核，
    # 缺任何一份都不生成 zip。REQUIRED_DOCS 是唯一事实来源，下面负责复制，这里负责验证。
    for name in REQUIRED_DOCS:
        source = os.path.join(PLUGIN, name)
        if os.path.isfile(source):
            shutil.copy2(source, os.path.join(stage, name))

    # ---------------------------------------------------------------- compliance files
    # 分享出去的包同样受 RimWorld EULA 约束：LICENSE（MIT）与 NOTICE.md（Ludeon 声明）必须
    # 跟着包走。它们不在插件目录里（公开包才注入），所以从公开包装配的模板目录取；取不到就
    # 明确报出来，不静默少文件。
    template_dir = os.path.join(os.path.dirname(PLUGIN), "_tools", "public-repo")
    for name in ("LICENSE", "NOTICE.md"):
        source = os.path.join(template_dir, name)
        if os.path.isfile(source):
            shutil.copy2(source, os.path.join(stage, name))
        else:
            print("警告：合规文件缺失，包内不会包含 " + name + "（应位于 " + source + "）")

    # ---------------------------------------------------------------- hard check
    # 「缺一份文档就报错退出」而不是警告：一个少文件的交付包比一个打不出来的包更糟 ——
    # 后者你会立刻发现，前者要等收包的人来问。
    missing = []
    for name in REQUIRED_DOCS:
        if not os.path.isfile(os.path.join(stage, name)):
            missing.append(name)
    plugin_dir = os.path.join(stage, "rimworld-log-plugin")
    for rel in REQUIRED_PLUGIN_FILES:
        if not os.path.isfile(os.path.join(plugin_dir, rel)):
            missing.append("rimworld-log-plugin/" + rel)
    # 运行期依赖也进硬检查：少了它包能装但插件起不来（ERR_MODULE_NOT_FOUND），
    # 这比「打不出来」更糟 —— 收包方只会看到一个装不上的插件。
    for rel in ["node_modules/schemastery/lib/index.mjs",
                "node_modules/schemastery/package.json",
                "node_modules/@standard-schema/spec/package.json",
                "node_modules/cosmokit/package.json"]:
        if not os.path.isfile(os.path.join(plugin_dir, rel)):
            missing.append("rimworld-log-plugin/" + rel)
    if missing:
        print("")
        print("打包中止：包内缺少下列必需文件，未生成 zip。")
        for name in missing:
            print("  缺  " + name)
        print("")
        print("先修 REQUIRED_DOCS / REQUIRED_PLUGIN_FILES / RUNTIME_DEPS，或把文件补回插件目录，再重新打包。")
        return 2
    print("")
    print("required files : {} docs + {} plugin files, all present".format(
        len(REQUIRED_DOCS), len(REQUIRED_PLUGIN_FILES)))

    # ---------------------------------------------------------------- checksums

    # 覆盖整个包（插件子树 + 散装文档 + LICENSE/NOTICE），而不只是插件目录：
    # 收包的人要能用一份清单验证他拿到的所有文件。清单自身与 zip 不列入。
    sums = []
    for dirpath, dirnames, filenames in os.walk(stage):
        dirnames[:] = [d for d in dirnames if d not in STAGE_EXCLUDE]
        for name in sorted(filenames):
            if name in STAGE_EXCLUDE or name.lower().endswith(EXCLUDE_SUFFIXES):
                continue
            if name == "SHA256SUMS.txt":
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, stage).replace("\\", "/")
            sums.append("{}  {}".format(hash_file(full), rel))
    with open(os.path.join(stage, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(sorted(sums)) + "\n")

    # ---------------------------------------------------------------- zip

    if os.path.exists(archive):
        os.remove(archive)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(stage):
            for name in filenames:
                full = os.path.join(dirpath, name)
                zf.write(full, os.path.relpath(full, out_dir))

    # ---------------------------------------------------------------- report

    count = 0
    size = 0
    for dirpath, dirnames, filenames in os.walk(stage):
        for name in filenames:
            count += 1
            size += os.path.getsize(os.path.join(dirpath, name))

    print("version        : v" + str(version))
    print("previous       : {} files".format(len(old)))
    print("current        : {} files".format(len(new)))
    print("  added        : {}".format(len(added)))
    print("  modified     : {}".format(len(modified)))
    print("  removed      : {}".format(len(removed)))
    print("")
    print("staged  : " + stage)
    print("          {} files, {:,} B".format(count, size))
    print("archive : " + archive)
    print("          {:,} B".format(os.path.getsize(archive)))
    print("")
    print("package contents:")
    for name in sorted(os.listdir(stage)):
        full = os.path.join(stage, name)
        if os.path.isdir(full):
            inner = sum(len(f) for _, _, f in os.walk(full))
            print("  {}/  ({} files)".format(name, inner))
        else:
            print("  {}  ({:,} B)".format(name, os.path.getsize(full)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
