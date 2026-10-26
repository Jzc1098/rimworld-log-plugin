#!/usr/bin/env python3
"""Build the public GitHub repository from the plugin tree.

The deliverable package (``tools/build-package.py``) is for people who unzip and
install; this script produces the *repository* — what you push to GitHub. The
differences are deliberate:

* ``node_modules`` is NOT copied (the README tells the user to run
  ``pnpm install``; ``.gitignore`` keeps it out of git).
* ``README.md`` / ``LICENSE`` / ``.gitignore`` are injected from
  ``_tools/public-repo/`` (they live outside the plugin so the deliverable
  package's generated README is never overwritten).
* No SHA256SUMS, no package-docs hard check.

## Layout: container + fixed repo folder

The output directory is a **container** (like the delivery package folder), and
the repository itself is one fixed-named folder inside it:

    <container>/<repo-name>/                    <- repository root; git lives HERE
    <container>/<plugin>_v<ver>_<date>.zip      (optional snapshot, --zip)

A fixed inner name keeps one continuous git history across releases; versioning
belongs to ``package.json``, git tags and the *archive* track, not to the working
folder's name. ``--layout flat`` writes the repository directly into ``--out``
for callers that want the old behaviour.

## Two isolated baseline tracks

The public track has its own baseline store (``_archive-github/``) and never
reads the deliverable track's ``_archive/``. Pass ``--baseline`` a *public*
baseline directory to get a ``RELEASE-NOTES.md`` describing what changed since
the last public release; omit it for the first public version and no file is
written. The full history always stays in ``HISTORY.md``.

Usage:
    python tools/build-public.py --out <container>
    python tools/build-public.py --out <container> --baseline <public baseline dir>
    python tools/build-public.py --out <container> --zip
    python tools/build-public.py --out <container> --layout flat
    python tools/build-public.py --dry-run
"""

import hashlib
import json
import os
import shutil
import sys
import time
import zipfile

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与交付包一致：二进制/构建产物都不在这里；node_modules 由依赖安装生成，不进仓库。
EXCLUDE = shutil.ignore_patterns(
    "node_modules", ".git", "__pycache__", "*.pyc", "*.pyo", "diag-brief.md", "*.zip",
)
EXCLUDE_NAMES = {"node_modules", ".git", "__pycache__", "diag-brief.md"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".zip")

# 仓库级文件（不放进插件目录，避免覆盖交付包生成的 README.md）
PUBLIC_FILES = ("README.md", "README.zh-CN.md", "LICENSE", "NOTICE.md", ".gitignore", ".gitattributes")

# 模板来源：工作区 _tools/public-repo/（与插件同级）
TEMPLATES = os.path.join(os.path.dirname(PLUGIN), "_tools", "public-repo")

DEFAULT_CONTAINER = os.path.join(os.path.dirname(os.path.dirname(PLUGIN)), "公开包（github版）")

# 对比基线时忽略的仓库级文件：它们是每次构建注入的脚手架，不是随版本变化的产物。
SCAFFOLD = {".gitignore", ".gitattributes", "LICENSE", "RELEASE-NOTES.md"}


def plugin_meta(repo_name=None):
    """Repository name (scope stripped, or an explicit override) and version."""
    try:
        with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as handle:
            pkg = json.load(handle)
    except OSError:
        return {"name": repo_name or os.path.basename(PLUGIN), "version": "unknown"}
    name = repo_name or str(pkg.get("name") or os.path.basename(PLUGIN)).split("/")[-1]
    return {"name": name, "version": str(pkg.get("version", "unknown"))}


def walk_files(root):
    """rel -> sha1 for every regular file, skipping the same names the copy skips."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES]
        for name in filenames:
            if name in EXCLUDE_NAMES or name.lower().endswith(EXCLUDE_SUFFIXES):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            with open(full, "rb") as handle:
                out[rel] = hashlib.sha1(handle.read()).hexdigest()
    return out


def version_of(root):
    """Read the version from a baseline's own package.json (not ours)."""
    try:
        with open(os.path.join(root, "package.json"), encoding="utf-8") as handle:
            return str(json.load(handle).get("version", "unknown"))
    except OSError:
        return "unknown"


def write_release_notes(repo_root, baseline):
    """Compare the staged repo against a public baseline and write RELEASE-NOTES.md."""
    old = walk_files(baseline)
    new = walk_files(repo_root)
    added = sorted(r for r in new if r not in old and r not in SCAFFOLD)
    removed = sorted(r for r in old if r not in new and r not in SCAFFOLD)
    modified = sorted(r for r in new if r in old and old[r] != new[r] and r not in SCAFFOLD)

    meta = plugin_meta()
    baseline_version = version_of(baseline)
    today = time.strftime("%Y-%m-%d")
    lines = [
        "# RELEASE-NOTES（公开轨，自上一次公开版本起）",
        "",
        "本页由 `tools/build-public.py --baseline` 生成，只记录**公开包轨**的差异；",
        "完整的版本历史见 `HISTORY.md`。交付包轨的更新日志不在这里（两轨隔离）。",
        "",
        "| 项 | 值 |",
        "|---|---|",
        "| 本版 | v{} |".format(meta["version"]),
        "| 对比基线 | v{}（{}） |".format(baseline_version, baseline),
        "| 生成时间 | {} |".format(today),
        "",
        "## 汇总",
        "",
        "| 新增 | 修改 | 删除 |",
        "|---|---|---|",
        "| {} | {} | {} |".format(len(added), len(modified), len(removed)),
        "",
    ]
    for title, rows in (("新增文件", added), ("修改文件", modified), ("删除文件", removed)):
        if not rows:
            continue
        lines.append("## " + title)
        lines.append("")
        for rel in rows[:60]:
            lines.append("- `{}`".format(rel))
        if len(rows) > 60:
            lines.append("- …（还有 {} 个）".format(len(rows) - 60))
        lines.append("")
    with open(os.path.join(repo_root, "RELEASE-NOTES.md"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))
    print("release notes: added {} / modified {} / removed {}".format(
        len(added), len(modified), len(removed)))


def wipe_except(path, keep=(".git",)):
    """Clear a build target while preserving repository history."""
    os.makedirs(path, exist_ok=True)
    for name in os.listdir(path):
        if name in keep:
            continue
        full = os.path.join(path, name)
        if os.path.isdir(full):
            shutil.rmtree(full)
        else:
            os.remove(full)


def make_snapshot_zip(container, repo_root, meta):
    """A versioned snapshot of the repository, beside the working folder."""
    stamp = time.strftime("%Y-%m-%d")
    archive = os.path.join(container, "{}_v{}_{}.zip".format(meta["name"], meta["version"], stamp))
    if os.path.exists(archive):
        os.remove(archive)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(repo_root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES]
            for name in filenames:
                if name in EXCLUDE_NAMES or name.lower().endswith(EXCLUDE_SUFFIXES):
                    continue
                full = os.path.join(dirpath, name)
                zf.write(full, os.path.relpath(full, container))
    return archive


def main(argv):
    if "--help" in argv or "-h" in argv:
        print(__doc__)
        return 0
    dry_run = "--dry-run" in argv
    container = DEFAULT_CONTAINER
    if "--out" in argv:
        i = argv.index("--out")
        if i + 1 >= len(argv):
            raise SystemExit("--out needs a directory")
        container = argv[i + 1]
    repo_name = None
    if "--repo-name" in argv:
        i = argv.index("--repo-name")
        if i + 1 >= len(argv):
            raise SystemExit("--repo-name needs a value")
        repo_name = argv[i + 1]
    layout = "nested"
    if "--layout" in argv:
        i = argv.index("--layout")
        if i + 1 >= len(argv) or argv[i + 1] not in ("nested", "flat"):
            raise SystemExit("--layout needs nested or flat")
        layout = argv[i + 1]
    baseline = None
    if "--baseline" in argv:
        i = argv.index("--baseline")
        if i + 1 >= len(argv):
            raise SystemExit("--baseline needs a directory")
        baseline = argv[i + 1]
        if not os.path.isdir(baseline):
            raise SystemExit("baseline not found: " + baseline)
    want_zip = "--zip" in argv

    meta = plugin_meta(repo_name)
    repo_root = os.path.join(container, meta["name"]) if layout == "nested" else container

    print("plugin    : " + PLUGIN)
    print("templates : " + TEMPLATES)
    print("container : " + container)
    print("repo root : " + repo_root + "   (layout " + layout + ")")
    print("baseline  : " + (baseline or "(none — first public version)"))
    if not os.path.isdir(TEMPLATES):
        raise SystemExit("templates missing: " + TEMPLATES)

    if dry_run:
        print("dry run: nothing written")
        return 0

    # nested 布局下容器归构建所有：只保留内层仓库目录与 *.zip 快照，
    # 其余（例如上一次 flat 构建散在容器根的文件）一律清掉，否则它们会混进“仓库外面”。
    if layout == "nested" and os.path.isdir(container):
        keep = {os.path.basename(repo_root)}
        for name in os.listdir(container):
            if name in keep or name.lower().endswith(".zip"):
                continue
            full = os.path.join(container, name)
            if os.path.isdir(full):
                shutil.rmtree(full)
            else:
                os.remove(full)

    # 清空上一次构建的产物（保留仓库根里的 .git —— 用户可能已经在那里 git init 过）。
    # 不清的话，被删掉的文件会留在仓库里，RELEASE-NOTES 之类的旧说明也会残留。
    wipe_except(repo_root)
    shutil.copytree(PLUGIN, repo_root, dirs_exist_ok=True, ignore=EXCLUDE)
    for name in PUBLIC_FILES:
        src = os.path.join(TEMPLATES, name)
        if not os.path.isfile(src):
            raise SystemExit("template missing: " + src)
        shutil.copy2(src, os.path.join(repo_root, name))
    if baseline:
        write_release_notes(repo_root, baseline)

    if want_zip:
        archive = make_snapshot_zip(container, repo_root, meta)
        print("snapshot  : " + archive)

    files = 0
    size = 0
    for dirpath, _dirnames, filenames in os.walk(repo_root):
        for name in filenames:
            files += 1
            size += os.path.getsize(os.path.join(dirpath, name))
    print("")
    print("staged  : " + repo_root)
    print("          {} files, {:,} B".format(files, size))
    print("contents:")
    for name in sorted(os.listdir(repo_root)):
        full = os.path.join(repo_root, name)
        if os.path.isdir(full):
            inner = sum(len(f) for _, _, f in os.walk(full))
            print("  {}/  ({} files)".format(name, inner))
        else:
            print("  {}  ({:,} B)".format(name, os.path.getsize(full)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
