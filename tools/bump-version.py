#!/usr/bin/env python3
"""Bump the plugin's declared version and bring the block registry in line with it.

Node 版 `tools/bump-version.mjs` 是维护主版本；本文件保留给习惯 Python 的人，两者行为应保持一致，
如果哪天不一致，改这里之前先看 `.mjs` 那边是怎么做的。

Three things have to move together, which is why this is a script rather than three edits:

  1. `package.json` `version` - the declared version.
  2. Every `version` and `modifiedVersion` in `blocks.json` - sub-versions are `<base>.<author>.<NNN>`, so a
     new base leaves half the registry claiming the old one and the next `stamp-blocks` run producing a
     registry with two different bases in it.
  3. Registry entries whose file no longer exists - a deleted document otherwise keeps 17 blocks alive in
     the registry forever, and `compare-plugin` reports them as "only in A" against every other copy.

Usage:
  python bump-version.py 1.2.0 [--dry-run] [--plugin DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter

# Backup files, editor leftovers and the registry's own previous snapshots. A `.bak` of the registry is
# itself valid JSON, so an earlier run registered it as a source file with blocks - which is why this list
# is explicit rather than a pattern alone.
SKIP_NAME = re.compile(r"\.(bak|tmp|orig|old|swp)$|~$|\.pre-[a-z]+\.bak$", re.I)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump the plugin version and fix the registry's versions.")
    parser.add_argument("version", help="new base version, for example 1.2.0")
    parser.add_argument("--plugin", default=None, help="plugin directory (default: the parent of this script)")
    parser.add_argument("--dry-run", action="store_true", help="report what would change, write nothing")
    args = parser.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        print("version must look like 1.2.0", file=sys.stderr)
        return 2

    plugin = args.plugin or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pkg_path = os.path.join(plugin, "package.json")
    reg_path = os.path.join(plugin, "blocks.json")

    with open(pkg_path, encoding="utf-8") as handle:
        pkg = json.load(handle)
    old_version = str(pkg.get("version", ""))
    if old_version == args.version:
        print("package.json is already at " + args.version)

    with open(reg_path, encoding="utf-8") as handle:
        registry = json.load(handle)

    blocks = registry.get("blocks", [])

    # ---- 1. versions -----------------------------------------------------
    version_re = re.compile(r"^" + re.escape(old_version) + r"(\..*)?$")
    version_hits = 0
    for block in blocks:
        for field in ("version", "modifiedVersion"):
            value = block.get(field)
            if isinstance(value, str) and version_re.match(value):
                block[field] = args.version + (version_re.match(value).group(1) or "")
                version_hits += 1

    # ---- 2. entries whose file is gone -----------------------------------
    survivors = []
    dropped = Counter()
    for block in blocks:
        rel = block.get("path") or block.get("file") or (block.get("id") or "").split(":")[0]
        base = os.path.basename(rel)
        missing = not os.path.exists(os.path.join(plugin, rel))
        if missing or SKIP_NAME.search(base):
            dropped[rel] += 1
            continue
        survivors.append(block)

    print("plugin        : " + plugin)
    print("version       : " + old_version + " -> " + args.version)
    print("version fields: " + str(version_hits))
    print("blocks        : " + str(len(blocks)) + " -> " + str(len(survivors)))
    print("")
    if dropped:
        print("registry entries removed (file gone, or a backup that should never have been registered):")
        for rel, count in dropped.most_common():
            print("  " + rel + "  ->  " + str(count) + " block(s)")
    else:
        print("registry entries removed: none")

    if args.dry_run:
        print("")
        print("dry run: nothing written")
        return 0

    pkg["version"] = args.version
    with open(pkg_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(pkg, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    registry["blocks"] = survivors
    registry["pluginVersion"] = args.version
    with open(reg_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(registry, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print("")
    print("written: package.json, blocks.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
