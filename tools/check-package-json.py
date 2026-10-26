#!/usr/bin/env python3
"""Check that package.json is valid, internally consistent, and describes files that exist.

This exists because the manifest list drifts silently: a deleted document leaves an entry behind, and
nothing complains. `npm pack` would, but the plugin is installed by junction, so no packaging step ever
runs during normal use and the stale entry survives indefinitely.

Usage: python check-package-json.py [--plugin DIR]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys


def resolve(plugin: str, pattern: str) -> bool:
    """True if `pattern` names at least one existing file. Entries may be globs such as `locale/*.json`."""
    if glob.glob(os.path.join(plugin, pattern)):
        return True
    return os.path.exists(os.path.join(plugin, pattern))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin", default=None)
    args = parser.parse_args()

    plugin = args.plugin or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(plugin, "package.json")

    try:
        with open(path, encoding="utf-8") as handle:
            pkg = json.load(handle)
    except Exception as error:                                  # noqa: BLE001 - report anything
        print("package.json is not valid JSON: " + str(error), file=sys.stderr)
        return 1

    print("plugin  : " + plugin)
    print("name    : " + str(pkg.get("name")))
    print("version : " + str(pkg.get("version")))

    problems = 0

    files = pkg.get("files", [])
    missing = [entry for entry in files if not resolve(plugin, entry)]
    print("files   : " + str(len(files)) + " entries, " + str(len(missing)) + " missing")
    for entry in missing:
        print("  MISSING  " + entry)
        problems += 1

    exports = pkg.get("exports", {})
    print("exports : " + str(len(exports)) + " entries")
    for name, target in exports.items():
        if not isinstance(target, str):
            continue
        if not resolve(plugin, target):
            print("  MISSING  " + name + " -> " + target)
            problems += 1

    for key in ("icon",):
        value = pkg.get(key)
        if isinstance(value, str) and not resolve(plugin, value):
            print("  MISSING  " + key + " -> " + value)
            problems += 1

    # A `files` entry that exists but is never reachable is not an error, so it is only reported as a note:
    # the plugin ships its tools and documents on purpose even though nothing imports them.
    print("")
    print("OK" if problems == 0 else str(problems) + " PROBLEM(S)")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
