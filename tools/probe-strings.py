"""Dump an assembly's string literals, optionally filtered, plus type and method names.

Written after PowerShell here-strings repeatedly mangled inline Python quoting: the shipped
interpreter receives the script through a layer that strips inner double quotes, so anything
containing them must live in a file rather than on the command line.

Usage:
  python probe-strings.py <root> [filter-regex]
"""

import os
import re
import sys

root = sys.argv[1]
pattern = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None

dlls = []
for dp, dn, fn in os.walk(root):
    for f in fn:
        if f.lower().endswith(".dll"):
            dlls.append(os.path.join(dp, f))

print("=== assemblies under " + root + " ===")
for h in dlls:
    print("  " + h.replace(root, "") + "  (" + format(os.path.getsize(h), ",") + " B)")
print()

for h in dlls:
    b = open(h, "rb").read()

    # UTF-16LE literals, which is how the C# compiler stores user strings.
    utf16 = set()
    for m in re.finditer(rb"(?:[\x20-\x7e]\x00){5,}", b):
        utf16.add(m.group(0).decode("utf-16-le", "ignore"))

    # UTF-8 metadata names: type names, method names, namespaces.
    names = set()
    for m in re.finditer(rb"[A-Za-z_][A-Za-z0-9_.<>`]{5,}", b):
        names.add(m.group(0).decode("ascii", "ignore"))

    rel = h.replace(root, "")

    interesting = [s for s in utf16 if pattern.search(s)] if pattern else []
    if interesting:
        print("--- " + rel + "  string literals matching " + sys.argv[2] + ":")
        for s in sorted(interesting)[:40]:
            print("    " + repr(s[:120]))
        print()

    if pattern:
        named = [s for s in names if pattern.search(s)]
        if named:
            print("--- " + rel + "  metadata names matching " + sys.argv[2] + ":")
            for s in sorted(named)[:40]:
                print("    " + s)
            print()
