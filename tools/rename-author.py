"""Rename an author throughout blocks.json.

The id appears in four places and each needs a different treatment:

  authors map key      the id
  authors[key].display the human name, free text
  block.author         the id
  block.modifiedBy     the id
  block.version        "<plugin>.<id>.<n>" - only the second segment

A text substitution would also rewrite an id that happens to appear inside a block id or a note, which
must not change. So this walks the parsed structure and touches only those fields.

The id and the display name are kept separate on purpose. Ids stay ASCII and stable, because they are
embedded in version strings that people read and quote; the display name carries whatever the person is
actually called.

Writes blocks.json in place, preserving non-ASCII as UTF-8. Use --dry-run first.

Usage:
  python rename-author.py --to Jzc1098 --id Jzc1098 --all
  python rename-author.py --from zhujunyang --to Jzc1098 --id Jzc1098
"""

import argparse
import json
import os
import sys

# 默认取脚本旁边的 blocks.json（不写死本机路径；--registry 可覆盖）
REGISTRY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blocks.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="source", help="existing author id (omit with --all)")
    parser.add_argument("--to", dest="display", required=True, help="new display name")
    parser.add_argument("--id", dest="new_id", required=True, help="new author id (ASCII)")
    parser.add_argument("--all", action="store_true", help="rename every author, whatever the id")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--registry", default=REGISTRY)
    args = parser.parse_args()

    with open(args.registry, encoding="utf-8") as handle:
        registry = json.load(handle)

    authors = registry.get("authors", {})
    blocks = registry.get("blocks", [])

    if args.all:
        targets = set(authors.keys())
        for block in blocks:
            for field in ("author", "modifiedBy"):
                value = block.get(field)
                if value:
                    targets.add(value)
    elif args.source:
        targets = {args.source}
    else:
        print("give --from <id> or --all", file=sys.stderr)
        return 2

    targets.discard(args.new_id)
    if not targets:
        print("nothing to rename")
        return 0

    print(f"registry : {args.registry}")
    print(f"ids      : {', '.join(sorted(targets))}  ->  {args.new_id!r}")
    print(f"display  : {args.display!r}")
    print("")

    # --- authors map -------------------------------------------------------
    counter = 0
    first_seen = None
    for old in targets:
        entry = authors.get(old)
        if not isinstance(entry, dict):
            continue
        counter += int(entry.get("counter") or 0)
        seen = entry.get("firstSeen")
        if isinstance(seen, str) and (first_seen is None or seen < first_seen):
            first_seen = seen

    for old in targets:
        authors.pop(old, None)
    authors[args.new_id] = {
        "display": args.display,
        "firstSeen": first_seen or "2026-10-12",
        "counter": counter,
    }

    # --- blocks ------------------------------------------------------------
    author_changes = 0
    modified_changes = 0
    version_changes = 0

    for block in blocks:
        if block.get("author") in targets:
            block["author"] = args.new_id
            author_changes += 1
        if block.get("modifiedBy") in targets:
            block["modifiedBy"] = args.new_id
            modified_changes += 1

        # "<plugin>.<id>.<n>" - plugin versions are always three segments, so the id is segment four from
        # the left only when the id itself has no dot. Rebuild by replacing the id segment wherever it is.
        for field in ("version", "modifiedVersion"):
            value = block.get(field)
            if not isinstance(value, str):
                continue
            parts = value.split(".")
            replaced = False
            for index in range(3, len(parts) - 1):
                if parts[index] in targets:
                    parts[index] = args.new_id
                    replaced = True
                    break
            if replaced:
                block[field] = ".".join(parts)
                version_changes += 1

    print(f"authors map entries : {len(authors)}")
    print(f"block.author        : {author_changes}")
    print(f"block.modifiedBy    : {modified_changes}")
    print(f"version strings     : {version_changes}")
    print("")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    with open(args.registry, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(registry, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"wrote {args.registry}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
